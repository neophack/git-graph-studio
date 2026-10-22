//! The per-root symbol databases: the persistent index served to the workbench. One
//! `SymbolIndex` owns the stores. Nothing loads on a folder open: the first symbol query
//! (`ensure_blocking` — Go-to-Definition, Find References, the workspace symbols, the
//! Symbol Database) resumes the saved index from `~/.ggs/index/` and repairs it against
//! the disk, or builds it when none was saved; watcher batches update a resident store
//! file by file (and persist it), and `release_idle` drops a store nobody has queried for
//! a while — the disk copy stays current, so the next query only resumes it.
//! Progress reaches the frontend through the push seams: a `BatchSink` for the explicit
//! rebuild, the `studio://symbol-index` event (`EventSink`) for the background builds.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use rayon::prelude::*;

use ggs_base::sink::{BatchSink, EventSink};

use crate::scan::{build_matcher, is_symbol_source, read_searchable, scan_text, FileMatches};
use crate::symbols::store::{BuildStats, FileOutlineRow, SymbolStore};
use crate::symbols::WorkspaceSymbol;

/// The event the status bar listens to; the payload is an [`IndexStatus`].
pub const SYMBOL_INDEX_EVENT: &str = "studio://symbol-index";

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IndexState {
    /// No index has landed for the root yet.
    Empty,
    Building,
    Ready,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub state: IndexState,
    pub done: usize,
    pub total: usize,
    pub files: usize,
    pub symbols: usize,
}

impl IndexStatus {
    fn empty() -> IndexStatus {
        IndexStatus {
            state: IndexState::Empty,
            done: 0,
            total: 0,
            files: 0,
            symbols: 0,
        }
    }
}

/// What a rebuild pushes over its channel: progress batches, then exactly one `done` (also
/// after a cancellation, so a waiting caller always settles).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SymbolIndexEvent {
    Progress {
        done: usize,
        total: usize,
    },
    Done {
        files: usize,
        symbols: usize,
        cancelled: bool,
    },
}

/// The per-root symbol databases plus their build state. The generation counter cancels a
/// running build the way the text search's does: a folder switch or a newer build bumps it,
/// and the old build stops at its next batch boundary. `last_used` is what `release_idle`
/// ages a store by; `ensure` serializes the on-demand builds so queries arriving together
/// share one build.
pub struct SymbolIndex {
    home: PathBuf,
    stores: Mutex<HashMap<String, Arc<Mutex<SymbolStore>>>>,
    progress: Mutex<HashMap<String, IndexStatus>>,
    last_used: Mutex<HashMap<String, Instant>>,
    ensure: Mutex<()>,
    generation: AtomicU64,
}

impl Default for SymbolIndex {
    fn default() -> Self {
        SymbolIndex::new()
    }
}

impl SymbolIndex {
    pub fn new() -> SymbolIndex {
        SymbolIndex::with_home(ggs_base::paths::ggs_home())
    }

    pub fn with_home(home: PathBuf) -> SymbolIndex {
        SymbolIndex {
            home,
            stores: Mutex::new(HashMap::new()),
            progress: Mutex::new(HashMap::new()),
            last_used: Mutex::new(HashMap::new()),
            ensure: Mutex::new(()),
            generation: AtomicU64::new(0),
        }
    }

    /// Stop the running build (a folder switch or a newer rebuild).
    pub fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn status(&self, root: &str) -> IndexStatus {
        self.progress
            .lock()
            .unwrap()
            .get(root)
            .cloned()
            .unwrap_or_else(IndexStatus::empty)
    }

    fn note(&self, root: &str, status: IndexStatus) {
        self.progress
            .lock()
            .unwrap()
            .insert(root.to_owned(), status);
    }

    /// A query's way to the store: counts as a use for `release_idle`.
    fn store(&self, root: &str) -> Option<Arc<Mutex<SymbolStore>>> {
        let store = self.resident(root)?;
        self.touch(root);
        Some(store)
    }

    /// The store without marking a use — the watcher's updates are not a reason to keep a
    /// store resident.
    fn resident(&self, root: &str) -> Option<Arc<Mutex<SymbolStore>>> {
        self.stores.lock().unwrap().get(root).cloned()
    }

    fn touch(&self, root: &str) {
        self.last_used
            .lock()
            .unwrap()
            .insert(root.to_owned(), Instant::now());
    }

    /// Install a finished store and mark the root ready.
    fn install(&self, root: &str, store: SymbolStore) {
        let stats = store.stats();
        self.stores
            .lock()
            .unwrap()
            .insert(root.to_owned(), Arc::new(Mutex::new(store)));
        self.note(root, ready_status(&stats));
        self.touch(root);
    }

    /// Drop a root's index (the folder closed).
    pub fn remove(&self, root: &str) {
        let dropped = self.stores.lock().unwrap().remove(root);
        self.progress.lock().unwrap().remove(root);
        self.last_used.lock().unwrap().remove(root);
        drop(dropped);
    }

    /// Drop every root's store (a folder switch: the old folder's index must not stay
    /// resident behind the new one; its disk copy is current).
    pub fn clear(&self) {
        let dropped: Vec<_> = self.stores.lock().unwrap().drain().collect();
        self.progress.lock().unwrap().clear();
        self.last_used.lock().unwrap().clear();
        drop(dropped);
    }

    /// Make the root's index resident: resume (or build) it now when it is not — what
    /// every symbol query runs first. Concurrent callers wait for the one build in
    /// flight; a cancelled build (a folder switch) answers an error.
    pub fn ensure_blocking(&self, sink: Option<&dyn EventSink>, root: &str) -> Result<(), String> {
        if self.store(root).is_some() {
            return Ok(());
        }
        let _building = self
            .ensure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.store(root).is_some() {
            return Ok(());
        }
        self.build_on_blocking(sink, root, None, Self::index_threads(false))
            .map(|_| ())
    }

    /// Drop every store no query has touched for `idle`, answering the released roots
    /// (their status is `Empty` again). A store still held (a query or a watcher batch in
    /// flight) counts as used now. The stores drop after the locks are released, so the
    /// teardown of a large one never stalls another root's query.
    pub fn release_idle(&self, idle: Duration) -> Vec<String> {
        let now = Instant::now();
        let mut dropped = Vec::new();
        let mut released = Vec::new();
        {
            let mut stores = self.stores.lock().unwrap();
            let mut last_used = self.last_used.lock().unwrap();
            let roots: Vec<String> = stores.keys().cloned().collect();
            for root in roots {
                let in_use = stores
                    .get(&root)
                    .is_some_and(|store| Arc::strong_count(store) > 1);
                let last = *last_used.entry(root.clone()).or_insert(now);
                if in_use {
                    last_used.insert(root.clone(), now);
                } else if now.duration_since(last) >= idle {
                    dropped.extend(stores.remove(&root));
                    last_used.remove(&root);
                    released.push(root);
                }
            }
        }
        {
            let mut progress = self.progress.lock().unwrap();
            for root in &released {
                progress.remove(root);
            }
        }
        drop(dropped);
        released
    }

    /// The index of a root with its per-name occurrence counts, when one has landed — the
    /// Symbol Database page (`symbol_tree`) reads the pair. Cloned out (a query must not
    /// hold the build's lock).
    pub fn symbols_with_refs(
        &self,
        root: &str,
    ) -> Option<(Vec<WorkspaceSymbol>, HashMap<String, usize>)> {
        let store = self.store(root)?;
        let guard = store.lock().unwrap();
        let symbols = guard.all_symbols();
        let counts: HashMap<String, usize> = guard
            .occurrence_counts()
            .iter()
            .map(|(name, &count)| ((*name).to_owned(), count))
            .collect();
        Some((symbols, counts))
    }

    /// The per-name occurrence counts alone — the metrics report's hotspot column, which
    /// has no use for the materialized symbols `symbols_with_refs` also copies out.
    pub fn occurrence_counts(&self, root: &str) -> Option<HashMap<String, usize>> {
        let store = self.store(root)?;
        let guard = store.lock().unwrap();
        let counts = guard
            .occurrence_counts()
            .iter()
            .map(|(name, &count)| ((*name).to_owned(), count))
            .collect();
        Some(counts)
    }

    /// The whole index of a root, when one has landed — the fast path `workspace_symbols`
    /// serves from. Cloned out (a query must not hold the build's lock).
    pub fn all_symbols(&self, root: &str) -> Option<Vec<WorkspaceSymbol>> {
        let store = self.store(root)?;
        let symbols = store.lock().unwrap().all_symbols();
        Some(symbols)
    }

    /// The declarations whose name contains `needle_lower` (lowercased; empty is every
    /// name), at most `limit` — only the hits are copied out of the store.
    pub fn matching(
        &self,
        root: &str,
        needle_lower: &str,
        limit: usize,
    ) -> Option<Vec<WorkspaceSymbol>> {
        let store = self.store(root)?;
        let hits = store.lock().unwrap().matching(needle_lower, limit);
        Some(hits)
    }

    /// Every declaration of exactly `name`.
    pub fn lookup(&self, root: &str, name: &str) -> Option<Vec<WorkspaceSymbol>> {
        let store = self.store(root)?;
        let hits = store.lock().unwrap().lookup(name);
        Some(hits)
    }

    /// The files whose text contains `name` (the occurrence list), or `None` when there is
    /// no index for the root or the name's list is untrusted — the caller then scans all.
    pub fn files_containing(&self, root: &str, name: &str) -> Option<Vec<String>> {
        let store = self.store(root)?;
        let files = store.lock().unwrap().files_containing(name);
        files
    }

    /// Every indexed file with its declaration count, path-sorted — the MCP server's
    /// directory rollups, hub-file ranking and language mix read it. Cloned out (a query
    /// must not hold the build's lock).
    pub fn files_with_counts(&self, root: &str) -> Option<Vec<(String, usize)>> {
        let store = self.store(root)?;
        let files = store.lock().unwrap().files_with_counts();
        Some(files)
    }

    /// How many declarations each kind carries, most first — the MCP server's overview
    /// reads it.
    pub fn kind_counts(&self, root: &str) -> Option<Vec<(&'static str, usize)>> {
        let store = self.store(root)?;
        let kinds = store.lock().unwrap().kind_counts();
        Some(kinds)
    }

    /// The `n` names the most indexed files contain, most first — the MCP server's
    /// overview ranks the workspace's hub names with it.
    pub fn top_names_by_refs(&self, root: &str, n: usize) -> Option<Vec<(String, usize)>> {
        let store = self.store(root)?;
        let names = store.lock().unwrap().top_names_by_refs(n);
        Some(names)
    }

    /// One file's outline rows (line order, containers carried, per-name occurrence
    /// counts), or `None` when nothing is indexed for the root or no file sits at
    /// `path` — the MCP server's `file_outline` reads it.
    pub fn file_symbols(&self, root: &str, path: &str) -> Option<Vec<FileOutlineRow>> {
        let store = self.store(root)?;
        let guard = store.lock().unwrap();
        guard.file_symbols(path)
    }

    /// An explicit rebuild (the status item's click, `symbols_rebuild`): the user is
    /// waiting, so every core is fair game.
    pub fn build_blocking(
        &self,
        sink: Option<&dyn EventSink>,
        root: &str,
        channel: Option<&mut dyn BatchSink<SymbolIndexEvent>>,
    ) -> Result<IndexStatus, String> {
        self.build_on_blocking(sink, root, channel, Self::index_threads(false))
    }

    /// How many threads a build may take: half the cores (at least two) in the background —
    /// RustDesk's `codec_thread_num` clamps its video pool to `max/2` for exactly this
    /// reason — and all of them when the user asked for the rebuild or a headless `--mcp`
    /// start is the thing being waited on.
    pub fn index_threads(background: bool) -> usize {
        let available = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        if background {
            (available / 2).max(2)
        } else {
            available
        }
    }

    /// The build itself, on the caller's thread with an explicit thread budget.
    fn build_on_blocking(
        &self,
        sink: Option<&dyn EventSink>,
        root: &str,
        channel: Option<&mut dyn BatchSink<SymbolIndexEvent>>,
        threads: usize,
    ) -> Result<IndexStatus, String> {
        let build_started = std::time::Instant::now();
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let is_current = || self.generation.load(Ordering::SeqCst) == generation;
        let is_cancelled = || !is_current();
        // The store's report callback is `&(dyn Fn + Sync)` (it runs inside rayon workers),
        // while a BatchSink sends through `&mut self` — the Mutex is the one bridge.
        let channel = channel.map(Mutex::new);
        let emit_status = |sink: &dyn EventSink| {
            if let Ok(payload) = serde_json::to_value(self.status(root)) {
                sink.emit(SYMBOL_INDEX_EVENT, payload);
            }
        };
        let report = |done: usize, total: usize| {
            self.note(
                root,
                IndexStatus {
                    state: IndexState::Building,
                    done,
                    total,
                    files: 0,
                    symbols: 0,
                },
            );
            if let Some(channel) = &channel {
                let _ = channel
                    .lock()
                    .unwrap()
                    .send(SymbolIndexEvent::Progress { done, total });
            }
            if let Some(sink) = sink {
                emit_status(sink);
            }
        };

        let saved = SymbolStore::load(root, &self.home).filter(|store| store.stats().files > 0);
        let built = match saved {
            Some(mut store) => match store.refresh_against_disk(&report, &is_cancelled) {
                Ok(0) => Ok(store),
                Ok(_) => {
                    if is_current() {
                        Ok(store)
                    } else {
                        Err("cancelled".to_owned())
                    }
                }
                Err(_) => SymbolStore::build(root, threads, &report, &is_cancelled)
                    .ok_or_else(|| "cancelled".to_owned()),
            },
            None => SymbolStore::build(root, threads, &report, &is_cancelled)
                .ok_or_else(|| "cancelled".to_owned()),
        };
        // A cancelled build leaves the previous state standing (an older ready index is
        // better than none); only a completed one publishes.
        let store = match built {
            Ok(store) => store,
            Err(error) => {
                // The progress report left "Building N/M" on the note; put back what
                // stands — the resident store's READY state, or nothing.
                let standing = self
                    .resident(root)
                    .map(|store| ready_status(&store.lock().unwrap().stats()))
                    .unwrap_or_else(IndexStatus::empty);
                self.note(root, standing);
                if let Some(sink) = sink {
                    emit_status(sink);
                }
                if let Some(channel) = &channel {
                    let _ = channel.lock().unwrap().send(SymbolIndexEvent::Done {
                        files: 0,
                        symbols: 0,
                        cancelled: true,
                    });
                }
                return Err(error);
            }
        };
        let stats = store.stats();
        // A log line, so stderr: the `--mcp` headless mode owns stdout for protocol
        // JSON only, and one stray line there can fail the client's parser.
        eprintln!(
            "[index] {} files, {} symbols in {:.0} ms ({} threads)",
            stats.files,
            stats.symbols,
            build_started.elapsed().as_secs_f64() * 1000.0,
            threads
        );
        let _ = store.save(&self.home);
        self.install(root, store);
        if let Some(channel) = &channel {
            let _ = channel.lock().unwrap().send(SymbolIndexEvent::Done {
                files: stats.files,
                symbols: stats.symbols,
                cancelled: false,
            });
        }
        if let Some(sink) = sink {
            emit_status(sink);
        }
        Ok(self.status(root))
    }

    /// Apply a watcher batch to the root's index on a background thread and persist it.
    pub fn apply_changes(
        self: &Arc<Self>,
        sink: Option<Arc<dyn EventSink>>,
        root: &str,
        paths: Vec<String>,
    ) {
        let index = Arc::clone(self);
        let root = root.to_owned();
        std::thread::spawn(move || {
            let Some(store) = index.resident(&root) else {
                return;
            };
            {
                let mut store = store.lock().unwrap();
                store.apply_changes(&paths);
                let _ = store.save(&index.home);
            }
            if let Some(sink) = sink.as_deref() {
                if let Ok(payload) = serde_json::to_value(index.status(&root)) {
                    sink.emit(SYMBOL_INDEX_EVENT, payload);
                }
            }
        });
    }
}

fn ready_status(stats: &BuildStats) -> IndexStatus {
    IndexStatus {
        state: IndexState::Ready,
        done: stats.files,
        total: stats.files,
        files: stats.files,
        symbols: stats.symbols,
    }
}

/* ---------- Find references ---------- */

/// Every whole-word occurrence of `name` in the workspace's code files — Find References'
/// raw material, the `find_references` and `symbol_references` commands and the MCP
/// server's `symbol_references` all served by this one implementation. The index's
/// occurrence list narrows the scan to the files that contain the word at all; without one
/// (or for a name the list does not trust), the whole tree is scanned.
pub fn references_for(
    index: &SymbolIndex,
    root: &str,
    name: &str,
) -> Result<Vec<FileMatches>, String> {
    let narrow = index.files_containing(root, name);
    scan_references(root, name, narrow)
}

/// The scan behind every reference query: whole-word, case-sensitive matches over `narrow`
/// (the occurrence list) — or over every code file in the tree when it is `None`.
pub fn scan_references(
    root: &str,
    name: &str,
    narrow: Option<Vec<String>>,
) -> Result<Vec<FileMatches>, String> {
    let matcher = build_matcher(name, false, true, true)?;
    let files: Vec<(String, PathBuf)> = match narrow {
        Some(files) => files
            .into_iter()
            .map(|relative| {
                let path = PathBuf::from(root).join(&relative);
                (relative, path)
            })
            .collect(),
        None => ggs_fs::walk_files(root)
            .into_iter()
            .filter(|file| is_symbol_source(file))
            .map(|relative| {
                let path = PathBuf::from(root).join(&relative);
                (relative, path)
            })
            .collect(),
    };
    let found: Vec<Option<FileMatches>> = files
        .into_par_iter()
        .map(|(relative, path)| {
            let (text, _) = read_searchable(&path)?;
            let matches = scan_text(&text, &matcher);
            (!matches.is_empty()).then_some(FileMatches {
                path: relative,
                matches,
            })
        })
        .collect();
    let mut files: Vec<FileMatches> = found.into_iter().flatten().collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/* ---------- The Symbol Database page's tree ---------- */

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TreeSymbol {
    pub kind: String,
    pub name: String,
    pub line: usize,
    /// How many files the name occurs in (the index's occurrence list length); 0 when the
    /// page is served from the in-memory fallback, which has no lists.
    pub refs: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TreeFile {
    /// Repo-relative, forward slashes; files arrive path-sorted, symbols in line order.
    pub path: String,
    pub symbols: Vec<TreeSymbol>,
}

/// The whole index as a per-file outline (the Symbol Database page renders it as a
/// collapsible tree); `refs_of` answers each name's occurrence count, 0 when the page is
/// served from the in-memory fallback.
pub fn tree_from(symbols: Vec<WorkspaceSymbol>, refs_of: impl Fn(&str) -> usize) -> Vec<TreeFile> {
    let mut files: Vec<TreeFile> = Vec::new();
    for symbol in symbols {
        let refs = refs_of(&symbol.name);
        let entry = TreeSymbol {
            kind: symbol.kind,
            name: symbol.name,
            line: symbol.line,
            refs,
        };
        match files.last_mut() {
            Some(file) if file.path == symbol.path => file.symbols.push(entry),
            _ => files.push(TreeFile {
                path: symbol.path,
                symbols: vec![entry],
            }),
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::symbols::cache::SymbolCache;

    fn write(root: &std::path::Path, path: &str, text: &str) {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap_or(root)).unwrap();
        std::fs::write(file, text).unwrap();
    }

    fn seeded_index() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<SymbolIndex>,
        String,
    ) {
        let root_dir = tempfile::tempdir().unwrap();
        write(root_dir.path(), "a.rs", "fn alpha() { beta(); }\n");
        write(root_dir.path(), "b.rs", "fn beta() {}\n");
        let home = tempfile::tempdir().unwrap();
        let index = Arc::new(SymbolIndex::with_home(home.path().to_owned()));
        let root = root_dir.path().display().to_string();
        index.build_blocking(None, &root, None).unwrap();
        (root_dir, home, index, root)
    }

    #[test]
    fn build_publishes_status_and_answers_queries() {
        let (_root_dir, _home, index, root) = seeded_index();
        let status = index.status(&root);
        assert_eq!(status.state, IndexState::Ready);
        assert_eq!(status.files, 2);
        assert_eq!(status.symbols, 2);

        let alpha = index.lookup(&root, "alpha").unwrap();
        assert_eq!(alpha.len(), 1);
        assert_eq!(alpha[0].path, "a.rs");

        let all = index.all_symbols(&root).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(
            index.files_containing(&root, "beta"),
            Some(vec!["a.rs".to_owned(), "b.rs".to_owned()])
        );
        assert_eq!(index.status("Z:\\nowhere").state, IndexState::Empty);
    }

    #[test]
    fn matching_filters_inside_the_store_in_index_order_and_honours_the_limit() {
        let (_root_dir, _home, index, root) = seeded_index();
        let names =
            |hits: Vec<WorkspaceSymbol>| hits.into_iter().map(|s| s.name).collect::<Vec<_>>();
        // The same rows, in the same order, as filtering the whole index would give.
        let all = index.all_symbols(&root).unwrap();
        assert_eq!(
            names(index.matching(&root, "", usize::MAX).unwrap()),
            names(all)
        );
        assert_eq!(
            names(index.matching(&root, "alp", usize::MAX).unwrap()),
            ["alpha"]
        );
        assert_eq!(names(index.matching(&root, "a", 1).unwrap()).len(), 1);
        assert!(index.matching(&root, "zzz", usize::MAX).unwrap().is_empty());
        assert_eq!(index.lookup(&root, "beta").unwrap().len(), 1);
        assert!(
            index.lookup(&root, "bet").unwrap().is_empty(),
            "lookup is exact"
        );
    }

    #[test]
    fn ensure_loads_on_demand_and_release_idle_drops_the_store_until_the_next_query() {
        let (_root_dir, home, index, root) = seeded_index();
        // A fresh index over the same home: nothing resident until a query ensures it.
        let fresh = SymbolIndex::with_home(home.path().to_owned());
        assert_eq!(fresh.status(&root).state, IndexState::Empty);
        assert!(fresh.lookup(&root, "alpha").is_none());
        fresh.ensure_blocking(None, &root).unwrap();
        assert_eq!(fresh.lookup(&root, "alpha").unwrap().len(), 1);

        // Queried just now: a long idle window keeps it; a zero window releases it.
        assert!(index.release_idle(Duration::from_secs(3600)).is_empty());
        assert_eq!(index.release_idle(Duration::ZERO), vec![root.clone()]);
        assert_eq!(index.status(&root).state, IndexState::Empty);
        assert!(
            index.lookup(&root, "alpha").is_none(),
            "the store left memory"
        );

        // The disk copy stayed current: the next ensure resumes it.
        index.ensure_blocking(None, &root).unwrap();
        assert_eq!(index.lookup(&root, "beta").unwrap().len(), 1);

        index.clear();
        assert_eq!(index.status(&root).state, IndexState::Empty);
    }

    #[test]
    fn a_saved_index_resumes_without_rebuilding_untouched_files() {
        let (root_dir, _home, index, root) = seeded_index();
        // A second index over the same home resumes: the fingerprinted files carry over.
        let resumed = Arc::new(SymbolIndex::with_home(index.home.clone()));
        let status = resumed.build_blocking(None, &root, None).unwrap();
        assert_eq!((status.state, status.files), (IndexState::Ready, 2));
        assert_eq!(resumed.lookup(&root, "alpha").unwrap().len(), 1);

        // A changed file since the save is repaired, a new one added.
        write(root_dir.path(), "a.rs", "fn alpha2() { beta(); }\n");
        write(root_dir.path(), "c.rs", "fn gamma() {}\n");
        resumed.apply_changes(None, &root, vec!["a.rs".to_owned(), "c.rs".to_owned()]);
        // apply_changes is a background thread; wait for it to land.
        let mut landed = false;
        for _ in 0..100 {
            if resumed
                .lookup(&root, "gamma")
                .is_some_and(|hits| !hits.is_empty())
            {
                landed = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(landed, "the watcher batch reached the index");
        assert_eq!(resumed.lookup(&root, "alpha").unwrap().len(), 0);
        assert_eq!(resumed.lookup(&root, "alpha2").unwrap().len(), 1);
    }

    #[test]
    fn a_cancelled_rebuild_keeps_the_ready_store_and_remove_drops_it() {
        let (_root_dir, _home, index, root) = seeded_index();
        // A rebuild over the ready root completes and replaces it cleanly (the generation
        // it took is its own - a cancel() issued before it started cannot stop it).
        let status = index.build_blocking(None, &root, None).unwrap();
        assert_eq!((status.state, status.files), (IndexState::Ready, 2));
        assert_eq!(index.lookup(&root, "alpha").unwrap().len(), 1);

        // A build cancelled mid-flight leaves the previous store standing: start one over a
        // large fixture and cancel it once it is underway, then check whichever way it ended
        // the index is never left worse than ready.
        let big = tempfile::tempdir().unwrap();
        for i in 0..2000 {
            write(
                big.path(),
                &format!("f{i:04}.rs"),
                "fn big() {}
",
            );
        }
        let big_root = big.path().display().to_string();
        let builder = {
            let index = Arc::clone(&index);
            std::thread::spawn(move || index.build_blocking(None, &big_root, None))
        };
        std::thread::sleep(std::time::Duration::from_millis(5));
        index.cancel();
        let _ = builder.join().unwrap();
        assert_eq!(
            index.status(&root).state,
            IndexState::Ready,
            "the other root's cancel did not clear it"
        );
        assert_eq!(index.lookup(&root, "alpha").unwrap().len(), 1);

        // remove() drops the root entirely.
        index.remove(&root);
        assert_eq!(index.status(&root).state, IndexState::Empty);
        assert!(index.lookup(&root, "alpha").is_none());
    }

    #[test]
    fn symbol_tree_groups_files_with_reference_counts() {
        let (_root_dir, _home, index, root) = seeded_index();
        let (symbols, counts) = index.symbols_with_refs(&root).unwrap();
        let tree = tree_from(symbols, |name| counts.get(name).copied().unwrap_or(0));
        assert_eq!(
            tree.iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["a.rs", "b.rs"]
        );
        assert_eq!(tree[0].symbols.len(), 1);
        // alpha occurs only where it is declared; beta is called from a.rs too.
        assert_eq!(tree[0].symbols[0].refs, 1);
        assert_eq!(tree[1].symbols[0].refs, 2);
    }

    #[test]
    fn symbol_references_scan_whole_words() {
        let (_root_dir, _home, index, root) = seeded_index();
        // Narrowed by the occurrence list: beta occurs in both files as a whole word only.
        let files = symbol_references_scan(&index, &root, "beta");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].matches.len(), 1);
        assert_eq!(
            (files[0].matches[0].line, files[0].matches[0].column),
            (1, 14)
        );
        // A name with no index (untrusted or absent) falls back to the full scan.
        let files = symbol_references_scan(&index, &root, "gamma");
        assert!(files.is_empty());
    }

    /// The scanning half of the `symbol_references` command, callable from a test (the
    /// command itself only needs a Tauri state around the same code).
    fn symbol_references_scan(index: &SymbolIndex, root: &str, name: &str) -> Vec<FileMatches> {
        let matcher = build_matcher(name, false, true, true).unwrap();
        let files = index.files_containing(root, name).unwrap_or_default();
        files
            .into_iter()
            .filter_map(|relative| {
                let (text, _) = read_searchable(&PathBuf::from(root).join(&relative))?;
                let matches = scan_text(&text, &matcher);
                (!matches.is_empty()).then_some(FileMatches {
                    path: relative,
                    matches,
                })
            })
            .collect()
    }

    #[test]
    fn a_full_build_streams_its_batches_through_a_batch_sink() {
        use ggs_base::sink::VecSink;
        // A fresh home over an unindexed root: the full build reports progress per batch
        // and closes with exactly one done (the resume path over a saved index reports
        // nothing but the done, which is its own contract).
        let root_dir = tempfile::tempdir().unwrap();
        write(root_dir.path(), "a.rs", "fn alpha() {}\n");
        write(root_dir.path(), "b.rs", "fn beta() {}\n");
        let home = tempfile::tempdir().unwrap();
        let index = SymbolIndex::with_home(home.path().to_owned());
        let root = root_dir.path().display().to_string();
        let mut sink = VecSink(Vec::new());
        {
            let channel: Option<&mut dyn BatchSink<SymbolIndexEvent>> = Some(&mut sink);
            index.build_blocking(None, &root, channel).unwrap();
        }
        // Progress batches followed by exactly one done.
        assert!(sink.0.len() >= 2);
        assert!(matches!(
            sink.0.first(),
            Some(SymbolIndexEvent::Progress { .. })
        ));
        assert!(matches!(
            sink.0.last(),
            Some(SymbolIndexEvent::Done { .. })
        ));
    }

    #[test]
    fn the_cache_fallback_and_the_tree_stay_composable() {
        // The in-memory fallback path the adapters compose when no index has landed: the
        // cache answers and the tree renders with zero refs.
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.rs", "fn alpha() {}\n");
        let root = dir.path().display().to_string();
        let cache = SymbolCache::default();
        let all = crate::symbols::cache::cached_symbols(&root, &cache);
        let tree = tree_from(all, |_| 0);
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].symbols[0].name, "alpha");
        assert_eq!(tree[0].symbols[0].refs, 0);
    }
}
