//! The symbol index commands (plan M4): the persistent per-root database served to the
//! workbench. One `SymbolIndex` in the app state owns the stores; a folder open resumes the
//! saved index from `~/.ggs/index/` and repairs it against the disk, watcher batches update
//! single files, and the queries (`symbol_lookup`, `symbol_references`) answer from the
//! database — with the pre-M4 in-memory path still there as the fallback when no index has
//! landed yet. Progress reaches the frontend two ways: a `Channel` for the explicit rebuild
//! command, and the `studio://symbol-index` event for the background builds.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::cmd_search::{build_matcher, read_searchable, scan_text, FileMatches, WorkspaceSymbol};
use crate::symbols::store::{BuildStats, SymbolStore};
use crate::AppState;
use rayon::prelude::*;

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
/// and the old build stops at its next batch boundary.
pub struct SymbolIndex {
    home: PathBuf,
    stores: Mutex<HashMap<String, Arc<Mutex<SymbolStore>>>>,
    progress: Mutex<HashMap<String, IndexStatus>>,
    generation: AtomicU64,
}

/// The user-level GGS home (`~/.ggs`), resolved the way settings / extensions do.
pub(crate) fn ggs_home() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home).join(".ggs")
}

impl Default for SymbolIndex {
    fn default() -> Self {
        SymbolIndex::new()
    }
}

impl SymbolIndex {
    pub fn new() -> SymbolIndex {
        SymbolIndex::with_home(ggs_home())
    }

    pub fn with_home(home: PathBuf) -> SymbolIndex {
        SymbolIndex {
            home,
            stores: Mutex::new(HashMap::new()),
            progress: Mutex::new(HashMap::new()),
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

    fn store(&self, root: &str) -> Option<Arc<Mutex<SymbolStore>>> {
        self.stores.lock().unwrap().get(root).cloned()
    }

    /// Install a finished store and mark the root ready.
    fn install(&self, root: &str, store: SymbolStore) {
        let stats = store.stats();
        self.stores
            .lock()
            .unwrap()
            .insert(root.to_owned(), Arc::new(Mutex::new(store)));
        self.note(root, ready_status(&stats));
    }

    /// Drop a root's index (the folder closed).
    pub fn remove(&self, root: &str) {
        self.stores.lock().unwrap().remove(root);
        self.progress.lock().unwrap().remove(root);
    }

    /// The index of a root with its per-name occurrence counts, when one has landed — the
    /// Symbol Database page (`symbol_tree`) and the MCP server read the pair. Cloned out
    /// (a query must not hold the build's lock).
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

    /// The whole index of a root, when one has landed — the fast path `workspace_symbols`
    /// serves from. Cloned out (a query must not hold the build's lock).
    pub fn all_symbols(&self, root: &str) -> Option<Vec<WorkspaceSymbol>> {
        let store = self.store(root)?;
        let symbols = store.lock().unwrap().all_symbols();
        Some(symbols)
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

    /// Kick off the background build of a root (a folder open): resume from the saved index
    /// when there is one, full build otherwise. Fire and forget — progress reaches the
    /// frontend through the [`SYMBOL_INDEX_EVENT`] event.
    pub fn start_build(self: &Arc<Self>, app: Option<tauri::AppHandle>, root: &str) {
        let index = Arc::clone(self);
        let root = root.to_owned();
        std::thread::spawn(move || {
            let _ = index.build_on_blocking(app.as_ref(), &root, None, Self::index_threads(true));
        });
    }

    /// An explicit rebuild (the status item's click, `symbols_rebuild`): the user is
    /// waiting, so every core is fair game.
    pub(crate) fn build_blocking(
        &self,
        app: Option<&tauri::AppHandle>,
        root: &str,
        channel: Option<&Channel<SymbolIndexEvent>>,
    ) -> Result<IndexStatus, String> {
        self.build_on_blocking(app, root, channel, Self::index_threads(false))
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
        app: Option<&tauri::AppHandle>,
        root: &str,
        channel: Option<&Channel<SymbolIndexEvent>>,
        threads: usize,
    ) -> Result<IndexStatus, String> {
        let build_started = std::time::Instant::now();
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let is_current = || self.generation.load(Ordering::SeqCst) == generation;
        let is_cancelled = || !is_current();
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
            if let Some(channel) = channel {
                let _ = channel.send(SymbolIndexEvent::Progress { done, total });
            }
            if let Some(app) = app {
                use tauri::Emitter;
                let _ = app.emit(SYMBOL_INDEX_EVENT, self.status(root));
            }
        };

        let saved = SymbolStore::load(root, &self.home).filter(|store| store.stats().files > 0);
        let built = match saved {
            Some(mut store) => match store.refresh_against_disk(&report, &is_cancelled) {
                Ok(0) => Ok(store),
                Ok(_) => {
                    if !is_current() {
                        return Err("cancelled".to_owned());
                    }
                    Ok(store)
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
                if let Some(channel) = channel {
                    let _ = channel.send(SymbolIndexEvent::Done {
                        files: 0,
                        symbols: 0,
                        cancelled: true,
                    });
                }
                return Err(error);
            }
        };
        let stats = store.stats();
        println!(
            "[index] {} files, {} symbols in {:.0} ms ({} threads)",
            stats.files,
            stats.symbols,
            build_started.elapsed().as_secs_f64() * 1000.0,
            threads
        );
        let _ = store.save(&self.home);
        self.install(root, store);
        if let Some(channel) = channel {
            let _ = channel.send(SymbolIndexEvent::Done {
                files: stats.files,
                symbols: stats.symbols,
                cancelled: false,
            });
        }
        if let Some(app) = app {
            use tauri::Emitter;
            let _ = app.emit(SYMBOL_INDEX_EVENT, self.status(root));
        }
        Ok(self.status(root))
    }

    /// Apply a watcher batch to the root's index on a background thread and persist it.
    pub fn apply_changes(
        self: &Arc<Self>,
        app: Option<tauri::AppHandle>,
        root: &str,
        paths: Vec<String>,
    ) {
        let index = Arc::clone(self);
        let root = root.to_owned();
        std::thread::spawn(move || {
            let Some(store) = index.store(&root) else {
                return;
            };
            {
                let mut store = store.lock().unwrap();
                store.apply_changes(&paths);
                let _ = store.save(&index.home);
            }
            if let Some(app) = app {
                use tauri::Emitter;
                let _ = app.emit(SYMBOL_INDEX_EVENT, index.status(&root));
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

/* ---------- The commands ---------- */

fn resolve_root(state: &AppState, repo: Option<String>) -> Result<String, String> {
    repo.or_else(|| state.first_repo())
        .ok_or_else(|| "No folder is open".to_owned())
}

/// The index state of the open folder: what the status bar shows.
#[tauri::command]
pub async fn symbols_status(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<IndexStatus, String> {
    let root = resolve_root(&state, repo)?;
    Ok(state.symbol_index.status(&root))
}

/// Rebuild the symbol index from scratch (also what a first open does in the background).
/// Streams `progress` batches over the channel, then one `done`.
#[tauri::command]
pub async fn symbols_rebuild(
    state: State<'_, AppState>,
    repo: Option<String>,
    on_event: Channel<SymbolIndexEvent>,
) -> Result<IndexStatus, String> {
    let root = resolve_root(&state, repo)?;
    let index = Arc::clone(&state.symbol_index);
    tauri::async_runtime::spawn_blocking(move || index.build_blocking(None, &root, Some(&on_event)))
        .await
        .map_err(|e| e.to_string())?
}

/// Every declaration of exactly `name` — Go-to-Definition's index answer. An empty list is
/// a real answer (nothing declares it); the frontend falls back to its other heuristics.
#[tauri::command]
pub async fn symbol_lookup(
    state: State<'_, AppState>,
    name: String,
    repo: Option<String>,
) -> Result<Vec<WorkspaceSymbol>, String> {
    let root = resolve_root(&state, repo)?;
    Ok(state.symbol_index.lookup(&root, &name).unwrap_or_default())
}

/// Every whole-word occurrence of `name` in the workspace's code files — Find References'
/// raw material. The index's occurrence list narrows the scan to the files that contain the
/// word at all; without one (or for a name the list does not trust), the whole tree is
/// scanned, exactly like the pre-index command did. `find_references` (cmd_search) and the
/// `symbol_references` command are both this one implementation.
pub(crate) async fn references_for(
    state: &AppState,
    name: &str,
    repo: Option<String>,
) -> Result<Vec<FileMatches>, String> {
    let root = resolve_root(state, repo)?;
    let narrow = state.symbol_index.files_containing(&root, name);
    scan_references(&root, name, narrow)
}

/// The scan behind every reference query (the commands above and the MCP server's
/// `symbol_references`): whole-word, case-sensitive matches over `narrow` (the occurrence
/// list) — or over every code file in the tree when it is `None`.
pub(crate) fn scan_references(
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
        None => crate::cmd_fs::walk_files(root)
            .into_iter()
            .filter(|file| crate::cmd_search::is_symbol_source(file))
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

fn tree_from(symbols: Vec<WorkspaceSymbol>, refs_of: impl Fn(&str) -> usize) -> Vec<TreeFile> {
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

/// The whole index as a per-file outline — the Symbol Database page renders it as a
/// collapsible tree and the MCP server's `symbol_tree` tool serves the same shape.
#[tauri::command]
pub async fn symbol_tree(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<Vec<TreeFile>, String> {
    let root = resolve_root(&state, repo)?;
    if let Some((symbols, counts)) = state.symbol_index.symbols_with_refs(&root) {
        return Ok(tree_from(symbols, |name| {
            counts.get(name).copied().unwrap_or(0)
        }));
    }
    // No index yet: the in-memory rebuild serves the outline without occurrence counts.
    let all = crate::cmd_search::cached_symbols(&root, &state.symbol_cache);
    Ok(tree_from(all, |_| 0))
}

#[tauri::command]
pub async fn symbol_references(
    state: State<'_, AppState>,
    name: String,
    repo: Option<String>,
) -> Result<Vec<FileMatches>, String> {
    references_for(&state, &name, repo).await
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
