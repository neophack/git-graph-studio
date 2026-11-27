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
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use rayon::prelude::*;

use ggs_base::sink::{BatchSink, EventSink};

use crate::scan::{build_matcher, is_symbol_source, read_searchable, scan_text, FileMatches};
use crate::symbols::store::{BuildStats, FileOutlineRow, SymbolStore};
use crate::symbols::vol_reader::{
    inspect_volume_stats, read_single_sym_slot_metrics, read_sym_slot_metrics,
    read_sym_slots_by_indices, PagedIndexReader, SymSlotMetrics, VolumeSigReader, VolumeStats,
};
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

/// One root's volume-save gate: the drainer claim (`running`), the "another batch
/// moved the store while a save was in flight" flag (`pending`), and when the last
/// write landed. A batch that lands during a save only raises `pending` — the
/// in-flight drainer folds it into its next pass instead of queueing one full
/// volume write per batch — and the drainer spaces its passes by
/// [`MIN_SAVE_INTERVAL`], so a typing session pays one write per interval, not one
/// per autosave.
#[derive(Default)]
struct SaveGate {
    running: bool,
    pending: bool,
    last_write: Option<Instant>,
}

/// The minimum spacing between two volume writes of one root. The first batch
/// after a quiet spell lands at once; only a burst folding into consecutive
/// drainer passes waits out the remainder.
const MIN_SAVE_INTERVAL: Duration = Duration::from_millis(1500);

/// The per-root symbol databases plus their build state. The generation counter cancels a
/// running build the way the text search's does: a folder switch or a newer build bumps it,
/// and the old build stops at its next batch boundary. `last_used` is what `release_idle`
/// ages a store by; `ensure` serializes the on-demand builds so queries arriving together
/// share one build.
pub struct SymbolIndex {
    home: PathBuf,
    stores: Mutex<HashMap<String, Arc<RwLock<SymbolStore>>>>,
    progress: Mutex<HashMap<String, IndexStatus>>,
    last_used: Mutex<HashMap<String, Instant>>,
    save_gates: Mutex<HashMap<String, Arc<Mutex<SaveGate>>>>,
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
            save_gates: Mutex::new(HashMap::new()),
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
    fn store(&self, root: &str) -> Option<Arc<RwLock<SymbolStore>>> {
        let store = self.resident(root)?;
        self.touch(root);
        Some(store)
    }

    /// The store without marking a use — the watcher's updates are not a reason to keep a
    /// store resident.
    fn resident(&self, root: &str) -> Option<Arc<RwLock<SymbolStore>>> {
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
            .insert(root.to_owned(), Arc::new(RwLock::new(store)));
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

    /// Delete the root's saved store from the analysis folder (and the GGS home a copy
    /// may still sit in) — the rebuild's delete-and-regenerate surface: nothing
    /// user-authored ever lives there, and the next build writes the same files whole.
    /// A store already resident stays serving until the fresh one lands.
    pub fn wipe_disk(&self, root: &str) {
        SymbolStore::remove_store_dirs(root, &self.home);
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
        let guard = store.read().unwrap();
        let symbols = guard.all_symbols();
        let counts: HashMap<String, usize> = guard
            .occurrence_counts()
            .iter()
            .map(|(name, &count)| ((*name).to_owned(), count))
            .collect();
        Some((symbols, counts))
    }

    /// One name's file count straight from the trusted occurrence list — the metrics
    /// report's hotspot query, asked per name as rows stream. The whole-table
    /// `occurrence_counts` would hold every name and count of a large workspace in a
    /// map for the report's whole run; this answers one name in one binary search.
    /// `None` when nothing is indexed for the root, the name is unknown, or its list
    /// is untrusted — the caller reads 0, exactly what an empty map answered.
    pub fn ref_count(&self, root: &str, name: &str) -> Option<usize> {
        let store = self.store(root)?;
        let count = store.read().unwrap().ref_count(name);
        count
    }

    /// The per-name occurrence counts alone — the metrics report's hotspot column, which
    /// has no use for the materialized symbols `symbols_with_refs` also copies out.
    pub fn occurrence_counts(&self, root: &str) -> Option<HashMap<String, usize>> {
        let store = self.store(root)?;
        let guard = store.read().unwrap();
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
        let symbols = store.read().unwrap().all_symbols();
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
        let hits = store.read().unwrap().matching(needle_lower, limit);
        Some(hits)
    }

    /// Every declaration of exactly `name`.
    pub fn lookup(&self, root: &str, name: &str) -> Option<Vec<WorkspaceSymbol>> {
        let store = self.store(root)?;
        let hits = store.read().unwrap().lookup(name);
        Some(hits)
    }

    /// The files whose text contains `name` (the occurrence list), or `None` when there is
    /// no index for the root or the name's list is untrusted — the caller then scans all.
    pub fn files_containing(&self, root: &str, name: &str) -> Option<Vec<String>> {
        let store = self.store(root)?;
        let files = store.read().unwrap().files_containing(name);
        files
    }

    /// True while a background volume save is running or queued for `root`, meaning the
    /// on-disk `.ggs_xc` / `.ggs_xf` signature volumes may lag behind the in-memory store.
    fn has_pending_save(&self, root: &str) -> bool {
        let gate = self.save_gates.lock().unwrap().get(root).cloned();
        gate.is_some_and(|g| {
            let g = g.lock().unwrap();
            g.running || g.pending
        })
    }

    /// Code-only candidate files for `name`, using the on-disk `.ggs_xc` Bloom signature
    /// volume (comment/string/conditional stripped) to prune prose-only files before disk
    /// reads. Intersects with the store's trusted occurrence list when both exist.
    pub fn files_containing_code(&self, root: &str, name: &str) -> Option<Vec<String>> {
        let store = self.store(root)?;
        let (trusted, all_files, dirty) = {
            let guard = store.read().unwrap();
            (
                guard.files_containing(name),
                guard
                    .files_with_counts()
                    .into_iter()
                    .map(|(p, _)| p)
                    .collect::<Vec<_>>(),
                guard.has_dirty(),
            )
        };
        if dirty || self.has_pending_save(root) {
            return trusted;
        }
        let dir = SymbolStore::index_dir(root, &self.home);
        let xc = VolumeSigReader::new(dir).filter_files_xc(name, &all_files);
        match (trusted, xc) {
            (Some(t), Some(x)) => {
                let set: std::collections::HashSet<&str> = x.iter().map(String::as_str).collect();
                Some(t.into_iter().filter(|p| set.contains(p.as_str())).collect())
            }
            (Some(t), None) => Some(t),
            (None, Some(x)) => Some(x),
            (None, None) => None,
        }
    }

    /// Full-text candidate files via `.ggs_xr` Bloom signatures (includes comments and
    /// string literals — safe prefilter for whole-word literal workspace search).
    pub fn filter_files_xr_for(&self, root: &str, word: &str) -> Option<Vec<String>> {
        let dir = self.volume_dir_if_fresh(root)?;
        let store = self.store(root)?;
        let all_files: Vec<String> = store
            .read()
            .unwrap()
            .files_with_counts()
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        VolumeSigReader::new(dir).filter_files_xr(word, &all_files)
    }

    /// Files that mention `name` ONLY in comments, strings, or inactive preprocessor blocks:
    /// computed directly from the 9-volume Bloom difference `.ggs_xr` \ `.ggs_xc` without
    /// reading any source files from disk.
    pub fn comment_only_files_for(&self, root: &str, name: &str) -> Option<Vec<String>> {
        let dir = self.volume_dir_if_fresh(root)?;
        let store = self.store(root)?;
        let all_files: Vec<String> = store
            .read()
            .unwrap()
            .files_with_counts()
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        let reader = VolumeSigReader::new(dir);
        let xr = reader.filter_files_xr(name, &all_files)?;
        let xc = reader.filter_files_xc(name, &all_files)?;
        let xc_set: std::collections::HashSet<&str> = xc.iter().map(String::as_str).collect();
        Some(
            xr.into_iter()
                .filter(|p| !xc_set.contains(p.as_str()))
                .collect(),
        )
    }

    /// Look up one symbol's native `SymSlotMetrics` from `project.ggs_sym`.
    pub fn single_sym_slot_metrics(
        &self,
        root: &str,
        path: &str,
        line0: usize,
        name: &str,
    ) -> Option<SymSlotMetrics> {
        let dir = self.volume_dir_if_fresh(root)?;
        let fid = self.with_store(root, |s| s.file_id_of(path)).flatten()?;
        read_single_sym_slot_metrics(&dir, fid, line0 as u32, name)
    }

    /// Volume-accelerated workspace symbol search: uses `.ggs_xsb`/`.ggs_xsd` (symbol-name
    /// B-tree), `.ggs_xab`/`.ggs_xad` (camel/snake word-part B-tree), and `.ggs_xf`
    /// (word-part Bloom prefilter) to surface prefix and camel-part matches first, then
    /// merges with `store.matching` so substring completeness is 100% preserved.
    pub fn matching_with_vols(
        &self,
        root: &str,
        needle_lower: &str,
        limit: usize,
    ) -> Option<Vec<WorkspaceSymbol>> {
        if needle_lower.len() < 2
            || !needle_lower
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return self.matching(root, needle_lower, limit);
        }
        let Some(dir) = self.volume_dir_if_fresh(root) else {
            return self.matching(root, needle_lower, limit);
        };
        let mut boosted: Vec<WorkspaceSymbol> = Vec::new();
        let mut seen: std::collections::HashSet<(String, String, usize)> =
            std::collections::HashSet::new();
        let paged_cap = limit.min(256);
        let reader = PagedIndexReader::new(dir.clone());
        let mut slot_ids = reader
            .search_xsb_prefix(needle_lower, paged_cap)
            .unwrap_or_default();
        if slot_ids.len() < paged_cap {
            if let Some(xab) = reader.search_xab_prefix(needle_lower, paged_cap - slot_ids.len()) {
                for s in xab {
                    if !slot_ids.contains(&s) {
                        slot_ids.push(s);
                    }
                }
            }
        }
        if !slot_ids.is_empty() {
            if let Some(resolved) = read_sym_slots_by_indices(&dir, &slot_ids) {
                let xf_files: Option<std::collections::HashSet<String>> = if needle_lower.len() >= 3
                {
                    self.search_word_parts_xf(root, needle_lower)
                        .map(|v| v.into_iter().collect())
                } else {
                    None
                };
                if let Some(store) = self.store(root) {
                    let guard = store.read().unwrap();
                    for (fid, line0, sym_name) in resolved {
                        let lower = sym_name.to_ascii_lowercase();
                        if !lower.contains(needle_lower) {
                            continue;
                        }
                        let Some(path) = guard.file_path(fid as usize) else {
                            continue;
                        };
                        if let Some(ref xf) = xf_files {
                            if !xf.contains(path) && !lower.starts_with(needle_lower) {
                                continue;
                            }
                        }
                        let key = (path.to_owned(), sym_name.clone(), line0 as usize);
                        if seen.contains(&key) {
                            continue;
                        }
                        // The key only counts as seen once a row actually answered: the
                        // slot's line comes from the sym-gen scanner and the store's row
                        // from the parser — a disagreement must leave the name to the
                        // `matching` fallback below, never swallow it behind a poisoned
                        // dedup key.
                        if let Some(row) = guard.file_symbols(path).and_then(|rows| {
                            rows.into_iter()
                                .find(|r| r.line == line0 as usize && r.name == sym_name)
                        }) {
                            seen.insert(key);
                            boosted.push(WorkspaceSymbol {
                                path: path.to_owned(),
                                kind: row.kind.to_owned(),
                                name: row.name,
                                container: row.container,
                                line: row.line,
                                column: 0,
                                end_line: row.end_line,
                            });
                            if boosted.len() >= limit {
                                return Some(boosted);
                            }
                        }
                    }
                }
            }
        }
        let fallback = self.matching(root, needle_lower, limit)?;
        for sym in fallback {
            let key = (sym.path.clone(), sym.name.clone(), sym.line);
            if seen.insert(key) {
                boosted.push(sym);
                if boosted.len() >= limit {
                    break;
                }
            }
        }
        Some(boosted)
    }

    /// Fuzzy camel/snake word-part candidate files via `.ggs_xf` Bloom signatures.
    pub fn search_word_parts_xf(&self, root: &str, part: &str) -> Option<Vec<String>> {
        if self.has_pending_save(root) {
            return None;
        }
        let store = self.store(root)?;
        let all_files: Vec<String> = store
            .read()
            .unwrap()
            .files_with_counts()
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        let dir = SymbolStore::index_dir(root, &self.home);
        VolumeSigReader::new(dir).filter_files_xf(part, &all_files)
    }

    /// Paged 4 KiB B-tree prefix lookup over `.ggs_xab`/`.ggs_xad` (word parts) and
    /// `.ggs_xsb`/`.ggs_xsd` (symbol names), returning matching `project.ggs_sym` slot ids.
    pub fn search_paged_prefix(&self, root: &str, prefix: &str, limit: usize) -> Option<Vec<u16>> {
        let dir = SymbolStore::index_dir(root, &self.home);
        let reader = PagedIndexReader::new(dir);
        let mut hits = reader.search_xab_prefix(prefix, limit)?;
        if hits.len() < limit {
            if let Some(xsb) = reader.search_xsb_prefix(prefix, limit - hits.len()) {
                for slot in xsb {
                    if !hits.contains(&slot) {
                        hits.push(slot);
                    }
                }
            }
        }
        Some(hits)
    }

    /// Read native `SymSlot` metrics (`raw108` + `name_tag`) from `project.ggs_sym`.
    pub fn sym_slot_metrics(&self, root: &str) -> Option<HashMap<(u32, u32, String), SymSlotMetrics>> {
        let dir = SymbolStore::index_dir(root, &self.home);
        read_sym_slot_metrics(&dir)
    }

    /// Inspect on-disk 9-volume stats for `root`.
    pub fn volume_stats(&self, root: &str) -> VolumeStats {
        let dir = SymbolStore::index_dir(root, &self.home);
        inspect_volume_stats(&dir)
    }

    /// Return the root's 9-volume directory when the on-disk volumes are in sync with the
    /// resident store (no dirty paths and no background save in flight).
    pub fn volume_dir_if_fresh(&self, root: &str) -> Option<PathBuf> {
        if self.has_pending_save(root) {
            return None;
        }
        let store = self.store(root)?;
        if store.read().unwrap().has_dirty() {
            return None;
        }
        Some(SymbolStore::index_dir(root, &self.home))
    }

    /// Look up `name` in `root`, falling back to any configured read-only Base / SDK
    /// projects (persisted in `<root>/.ggs/base-projects.json`). Base-project hits carry
    /// absolute paths so the editor can open them directly as read-only SDK references.
    pub fn lookup_with_base_projects(&self, root: &str, name: &str) -> Vec<WorkspaceSymbol> {
        let primary = self.lookup(root, name).unwrap_or_default();
        if !primary.is_empty() {
            return primary;
        }
        let mut out = Vec::new();
        for base_root in crate::symbols::preprocessor::load_base_projects(root) {
            if base_root == root || !std::path::Path::new(&base_root).is_dir() {
                continue;
            }
            if self.ensure_blocking(None, &base_root).is_err() {
                continue;
            }
            if let Some(hits) = self.lookup(&base_root, name) {
                for mut sym in hits {
                    let abs = std::path::Path::new(&base_root)
                        .join(&sym.path)
                        .to_string_lossy()
                        .replace('\\', "/");
                    sym.path = abs;
                    out.push(sym);
                }
            }
        }
        out
    }

    /// Every indexed file with its declaration count, path-sorted — the MCP server's
    /// directory rollups, hub-file ranking and language mix read it. Cloned out (a query
    /// must not hold the build's lock).
    pub fn files_with_counts(&self, root: &str) -> Option<Vec<(String, usize)>> {
        let store = self.store(root)?;
        let files = store.read().unwrap().files_with_counts();
        Some(files)
    }

    /// How many declarations each kind carries, most first — the MCP server's overview
    /// reads it.
    pub fn kind_counts(&self, root: &str) -> Option<Vec<(&'static str, usize)>> {
        let store = self.store(root)?;
        let kinds = store.read().unwrap().kind_counts();
        Some(kinds)
    }

    /// The `n` names the most indexed files contain, most first — the MCP server's
    /// overview ranks the workspace's hub names with it.
    pub fn top_names_by_refs(&self, root: &str, n: usize) -> Option<Vec<(String, usize)>> {
        let store = self.store(root)?;
        let names = store.read().unwrap().top_names_by_refs(n);
        Some(names)
    }

    /// Run one read-only query against the root's store under its shared read lock: the
    /// answer is computed inside and only the result leaves, without blocking concurrent
    /// readers. `None` when nothing is indexed for the root.
    pub fn with_store<R>(&self, root: &str, query: impl FnOnce(&SymbolStore) -> R) -> Option<R> {
        let store = self.store(root)?;
        let guard = store.read().unwrap();
        Some(query(&guard))
    }

    /// One file's outline rows (line order, containers carried, per-name occurrence
    /// counts), or `None` when nothing is indexed for the root or no file sits at
    /// `path` — the MCP server's `file_outline` reads it.
    pub fn file_symbols(&self, root: &str, path: &str) -> Option<Vec<FileOutlineRow>> {
        let store = self.store(root)?;
        let guard = store.read().unwrap();
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
                    .map(|store| ready_status(&store.read().unwrap().stats()))
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

    /// Apply a watcher batch to the root's index on a background thread, persisting only
    /// when the batch actually moved the store — and with the store's lock released while
    /// the volumes write: the batch's own incremental update is the only store-locked
    /// work, the save snapshots under the lock and writes from the snapshot.
    pub fn apply_changes(
        self: &Arc<Self>,
        sink: Option<Arc<dyn EventSink>>,
        root: &str,
        paths: Vec<String>,
    ) {
        let index = Arc::clone(self);
        let root = root.to_owned();
        std::thread::spawn(move || {
            let _changed = index.refresh_paths_blocking(&root, &paths);
            if let Some(sink) = sink.as_deref() {
                if let Ok(payload) = serde_json::to_value(index.status(&root)) {
                    sink.emit(SYMBOL_INDEX_EVENT, payload);
                }
            }
        });
    }

    /// Synchronously apply changed/drifted files to the resident store (without spawning
    /// a background thread) and refresh the status counters. Used by `ggs-mcp` after
    /// edits/renames so the very next query observes fresh symbols immediately.
    pub fn refresh_paths_blocking(&self, root: &str, paths: &[String]) -> bool {
        let Some(store) = self.resident(root) else {
            return false;
        };
        let changed = {
            let guard = store.read().unwrap();
            let fingerprints = guard.fingerprints();
            drop(guard);
            let drifted = SymbolStore::drift_of(root, &fingerprints, paths);
            let mut store = store.write().unwrap();
            let moved = store.apply_drifted(paths, &drifted);
            if moved {
                let stats = store.stats();
                self.note(root, ready_status(&stats));
            }
            moved
        };
        if changed {
            self.drain_volume_saves(root);
        }
        changed
    }

    /// Persist the root's volumes with the store lock released. Each pass snapshots
    /// whatever store stands for the root under the locks (milliseconds of pure CPU) and
    /// writes the nine volumes from the snapshot with no lock held, so a save never
    /// blocks the symbol queries — and a store swapped by a rebuild (or dropped by a
    /// folder switch) mid-save is never written back stale. The per-root gate folds a
    /// burst of batches into one drainer: a batch landing while a save is in flight only
    /// raises `pending`, and this thread loops until the flag stays quiet. The caller's
    /// thread runs the drain — a batch that finds the gate claimed returns at once,
    /// trusting the drainer to cover its flag.
    fn drain_volume_saves(&self, root: &str) {
        let gate = Arc::clone(
            self.save_gates
                .lock()
                .unwrap()
                .entry(root.to_owned())
                .or_default(),
        );
        {
            let mut gate = gate.lock().unwrap();
            gate.pending = true;
            if gate.running {
                return;
            }
            gate.running = true;
        }
        loop {
            // The pending consume, the quiet exit and the store lookup share one critical
            // section, so a batch is either covered by this drainer (its flag lands before
            // the consume) or sees `running == false` and drains itself — no flag can
            // fall between the two.
            let next = {
                let mut gate = gate.lock().unwrap();
                if gate.pending {
                    gate.pending = false;
                    Some(self.resident(root))
                } else {
                    gate.running = false;
                    None
                }
            };
            let Some(store) = next else {
                return;
            };
            let Some(store) = store else {
                // The store was dropped under this drain (a folder switch): nothing left
                // to snapshot — stand the gate down so a later batch claims cleanly.
                gate.lock().unwrap().running = false;
                return;
            };
            // Space consecutive writes apart: the first batch after a quiet spell lands
            // at once, a burst folds into one write per interval. The queries answer
            // from the store's memory either way — the spacing is disk courtesy.
            let wait = gate
                .lock()
                .unwrap()
                .last_write
                .map(|last| MIN_SAVE_INTERVAL.saturating_sub(last.elapsed()))
                .unwrap_or(Duration::ZERO);
            if !wait.is_zero() {
                std::thread::sleep(wait);
            }
            let (snapshot, dirty_paths) = {
                let store = store.read().unwrap();
                let snapshot = store.save_snapshot();
                let dirty_paths = snapshot.dirty_paths.clone();
                (snapshot, dirty_paths)
            };
            let landed = SymbolStore::write_volumes(&snapshot, &self.home).is_ok();
            gate.lock().unwrap().last_write = Some(Instant::now());
            if landed {
                // The write holds exactly these paths' facts on disk; only they leave
                // the dirty set. A batch that applied meanwhile re-marked its own
                // paths, and the next drain covers them.
                store.write().unwrap().clear_dirty(&dirty_paths);
            }
        }
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
/// server's `symbol_references` all served by this one implementation. Uses `.ggs_xc`
/// Bloom signatures alongside the store's occurrence list to prune comment-only files.
pub fn references_for(
    index: &SymbolIndex,
    root: &str,
    name: &str,
) -> Result<Vec<FileMatches>, String> {
    let narrow = index.files_containing_code(root, name);
    scan_references(root, name, narrow)
}

/// One reference match enriched with Source-Insight-style access semantics:
/// `decl` (declaration line), `call` (function/method invocation), `write` (assignment,
/// compound assignment, increment/decrement, or `&mut`), or `read`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClassifiedRefMatch {
    pub line: usize,
    pub column: usize,
    pub length: usize,
    pub text: String,
    pub access: &'static str,
}

/// One file's classified reference matches (`symbol_references` wire shape).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClassifiedRefFile {
    pub path: String,
    pub matches: Vec<ClassifiedRefMatch>,
}

/// Classify a reference hit at 1-based `column` of `line_text` into `decl` / `call` /
/// `write` / `read`. Handles C/C++/Rust/TS/JS/Go/Python/Java/C# assignment & mutation
/// operators while excluding comparisons (`==`, `!=`, `<=`, `>=`, `=>`).
pub fn classify_reference_access(
    line_text: &str,
    column_1based: usize,
    length: usize,
    is_decl_line: bool,
) -> &'static str {
    if is_decl_line {
        return "decl";
    }
    let chars: Vec<char> = line_text.chars().collect();
    let start = column_1based.saturating_sub(1).min(chars.len());
    let end = (start + length).min(chars.len());

    let mut after = end;
    while after < chars.len() && chars[after].is_whitespace() {
        after += 1;
    }
    if after < chars.len() && chars[after] == '(' {
        return "call";
    }
    let mut lval_after = after;
    while lval_after < chars.len() && chars[lval_after] == '[' {
        let mut depth = 1usize;
        lval_after += 1;
        while lval_after < chars.len() && depth > 0 {
            if chars[lval_after] == '[' {
                depth += 1;
            } else if chars[lval_after] == ']' {
                depth -= 1;
            }
            lval_after += 1;
        }
        while lval_after < chars.len() && chars[lval_after].is_whitespace() {
            lval_after += 1;
        }
    }
    let tail: String = chars[lval_after..].iter().take(3).collect();
    if tail.starts_with("++") || tail.starts_with("--") {
        return "write";
    }
    if tail.starts_with(":=")
        || tail.starts_with("+=")
        || tail.starts_with("-=")
        || tail.starts_with("*=")
        || tail.starts_with("/=")
        || tail.starts_with("%=")
        || tail.starts_with("&=")
        || tail.starts_with("|=")
        || tail.starts_with("^=")
        || tail.starts_with("<<=")
        || tail.starts_with(">>=")
    {
        return "write";
    }
    if tail.starts_with('=') && !tail.starts_with("==") && !tail.starts_with("=>") {
        return "write";
    }

    let mut before = start;
    while before > 0 && chars[before - 1].is_whitespace() {
        before -= 1;
    }
    if before >= 2 {
        let prev2: String = chars[before - 2..before].iter().collect();
        if prev2 == "++" || prev2 == "--" {
            return "write";
        }
    }
    if before >= 4 {
        let prev_prefix: String = chars[..before].iter().collect();
        if prev_prefix.ends_with("&mut") {
            return "write";
        }
    }
    "read"
}

/// Find References with `.ggs_xc` prefiltering + Read/Write/Call/Decl classification.
pub fn classified_references_for(
    index: &SymbolIndex,
    root: &str,
    name: &str,
) -> Result<Vec<ClassifiedRefFile>, String> {
    let raw = references_for(index, root, name)?;
    let mut out = Vec::with_capacity(raw.len());
    for file in raw {
        let decl_lines: std::collections::HashSet<usize> = index
            .file_symbols(root, &file.path)
            .unwrap_or_default()
            .into_iter()
            .filter(|s| s.name == name)
            .map(|s| s.line + 1)
            .collect();
        let matches = file
            .matches
            .into_iter()
            .map(|m| {
                let access = classify_reference_access(
                    &m.text,
                    m.column,
                    m.length,
                    decl_lines.contains(&m.line),
                );
                ClassifiedRefMatch {
                    line: m.line,
                    column: m.column,
                    length: m.length,
                    text: m.text,
                    access,
                }
            })
            .collect();
        out.push(ClassifiedRefFile {
            path: file.path,
            matches,
        });
    }
    Ok(out)
}

/// The scan behind every reference query: whole-word, case-sensitive matches over `narrow`
/// (the occurrence list) — or over every code file in the tree when it is `None`.
pub fn scan_references(
    root: &str,
    name: &str,
    narrow: Option<Vec<String>>,
) -> Result<Vec<FileMatches>, String> {
    let (files, _) = scan_references_bounded(root, name, narrow, usize::MAX, "")?;
    Ok(files)
}

/// The bounded scan behind the MCP server's `symbol_references`: the same
/// whole-word matches in the same path order, but only the first `keep` hits are
/// stored — the rest are counted as they stream past (the scan runs file batches in
/// parallel and folds each batch sequentially), so a common name on a huge tree pays
/// the window, never the whole match set. `path_prefix` narrows every phase — the
/// non-matching files never scan, the total counts the prefix's matches only — so a
/// prefixed answer is exact and single-pass, like the unprefixed one. The total stays
/// exact either way.
pub fn scan_references_bounded(
    root: &str,
    name: &str,
    narrow: Option<Vec<String>>,
    keep: usize,
    path_prefix: &str,
) -> Result<(Vec<FileMatches>, usize), String> {
    let matcher = build_matcher(name, false, true, true)?;
    let files: Vec<(String, PathBuf)> = match narrow {
        Some(files) => files
            .into_iter()
            .filter(|relative| relative.starts_with(path_prefix))
            .map(|relative| {
                let path = PathBuf::from(root).join(&relative);
                (relative, path)
            })
            .collect(),
        None => ggs_fs::walk_files(root)
            .into_iter()
            .filter(|file| is_symbol_source(file) && file.starts_with(path_prefix))
            .map(|relative| {
                let path = PathBuf::from(root).join(&relative);
                (relative, path)
            })
            .collect(),
    };
    let mut kept: Vec<FileMatches> = Vec::new();
    let mut stored = 0usize;
    let mut total = 0usize;
    for batch in files.chunks(256) {
        let found: Vec<Option<FileMatches>> = batch
            .par_iter()
            .map(|(relative, path)| {
                let (text, _) = read_searchable(path)?;
                let matches = scan_text(&text, &matcher);
                (!matches.is_empty()).then_some(FileMatches {
                    path: relative.clone(),
                    matches,
                })
            })
            .collect();
        for mut file in found.into_iter().flatten() {
            total += file.matches.len();
            if stored < keep {
                let room = keep - stored;
                if file.matches.len() > room {
                    file.matches.truncate(room);
                }
                stored += file.matches.len();
                kept.push(file);
            }
        }
    }
    debug_assert!(
        kept.iter().map(|f| f.matches.len()).sum::<usize>() == stored,
        "the kept window matches the stored count"
    );
    Ok((kept, total))
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
    fn ref_count_answers_one_name_without_the_table() {
        let (_root_dir, _home, index, root) = seeded_index();
        // One file mentions alpha; the count reads the occurrence list in place.
        assert_eq!(index.ref_count(&root, "alpha"), Some(1));
        assert_eq!(index.ref_count(&root, "beta"), Some(2));
        assert_eq!(index.ref_count(&root, "missing"), None);
    }

    #[test]
    fn the_bounded_reference_scan_keeps_the_window_and_the_exact_total() {
        let dir = tempfile::tempdir().unwrap();
        // hot.rs: 400 whole-word hits of the name; quiet.rs: one, alphabetically after.
        let mut hot = String::new();
        for line in 1..=400 {
            hot.push_str(&format!(
                "fn line{line}() {{ alpha + {line}; }}
"
            ));
        }
        write(dir.path(), "hot.rs", &hot);
        write(
            dir.path(),
            "quiet.rs",
            "fn alpha() {}
",
        );
        let root = dir.path().display().to_string();

        // The window stores the prefix of the stream; the total counts every hit.
        let (files, total) = scan_references_bounded(&root, "alpha", None, 100, "").unwrap();
        assert_eq!(total, 401);
        let stored: usize = files.iter().map(|f| f.matches.len()).sum();
        assert_eq!(stored, 100);
        assert_eq!(files[0].path, "hot.rs", "path order survives the window");
        // SearchMatch lines are 1-based; the stream's head is hot.rs's first line.
        assert_eq!(
            files[0].matches[0].line, 1,
            "the window is the stream's head"
        );

        // The prefix narrows every phase: only the prefixed files scan and count.
        let (files, total) =
            scan_references_bounded(&root, "alpha", None, usize::MAX, "quiet").unwrap();
        assert_eq!(total, 1);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "quiet.rs");

        // The unbounded wrapper is the whole set, path-ordered.
        let files = scan_references(&root, "alpha", None).unwrap();
        let all: usize = files.iter().map(|f| f.matches.len()).sum();
        assert_eq!(all, 401);
        assert!(files.windows(2).all(|pair| pair[0].path <= pair[1].path));
    }

    /// A batch naming nothing the store holds must not rewrite the store: the save's bytes
    /// land inside the watched tree, and a write the watch reports as a change is exactly
    /// the loop that made the symbol window flicker without end (2026-11-21). A real edit
    /// still persists.
    #[test]
    fn a_no_op_batch_never_rewrites_the_store() {
        let (root_dir, home, index, root) = seeded_index();
        let store_path = SymbolStore::index_dir(&root, home.path()).join(crate::symbols::store::SYM_VOL_FILE);
        let before = std::fs::metadata(&store_path).unwrap();

        index.apply_changes(None, &root, vec!["notes.txt".to_owned()]);
        // The apply runs on a background thread; give it its moment before reading.
        std::thread::sleep(std::time::Duration::from_millis(300));
        let after = std::fs::metadata(&store_path).unwrap();
        assert_eq!(
            (after.modified().unwrap(), after.len()),
            (before.modified().unwrap(), before.len()),
            "a no-op batch left project.ggs_sym untouched"
        );

        // The positive control: a real edit reaches the store on disk.
        std::fs::write(root_dir.path().join("a.rs"), "fn alpha() { beta(); gamma(); }\n").unwrap();
        index.apply_changes(None, &root, vec!["a.rs".to_owned()]);
        let mut landed = false;
        for _ in 0..100 {
            let written = std::fs::metadata(&store_path).unwrap();
            if written.modified().unwrap() != before.modified().unwrap() {
                landed = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(landed, "a real edit re-persisted the store");
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
        assert!(matches!(sink.0.last(), Some(SymbolIndexEvent::Done { .. })));
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
