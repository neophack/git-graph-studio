//! Module Architecture Analysis (module 17): fast, progressive-disclosure module
//! dependency graphs built directly over the nine `project.ggs_*` volumes
//! ([`SymbolStore`] + [`ggs_index::symbols::sites`]), with zero dependency on
//! the legacy `AnalysisData` engine.
//!
//! Two-tier execution model:
//! 1. **L0 / L1 (`module_overview_from_store` / `module_overview`) — pure in-memory, zero disk I/O
//!    (except optional `imports` edge type which scans files in parallel outside the store lock)**:
//!    Reads directly from `&SymbolStore` without cloning `names`/`refs`/`files`, aggregates
//!    selected edge types (`calls`, `typeRefs`, `baseRefs`, `imports`) using integer node IDs
//!    and bounded accumulators, runs iterative Tarjan SCC to highlight dependency cycles,
//!    computes Robert C. Martin coupling metrics ($C_a$, $C_e$, Instability $I$), and
//!    assigns condensed-DAG topological layers.
//! 2. **L2 (`prepare_edge_detail_from_store` + `scan_edge_detail`) — on-demand local file scan**:
//!    Only when inspecting a specific dependency edge `from → to`, extracts a minimal plan
//!    under the store read lock and reads only the relevant `from`-side files outside the lock.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use ggs_index::symbols::sites;
use ggs_index::symbols::store::{StoreDependencyFacts, SymbolStore};

use crate::imports::resolve_import;

/// A symbol declared in at most this many files is considered high-specificity for
/// automatic module-level dependency inference (filters out ubiquitous method names
/// like `new`, `init`, `render`, `fmt`, `from` that would otherwise cause quadratic
/// false-edge fan-out).
const MAX_DECL_FILES_FOR_SIGNAL: usize = 3;
/// Base-type inheritance links tolerate slightly higher fan-out (e.g. a shared trait
/// or interface name).
const MAX_DECL_FILES_FOR_BASE: usize = 4;
/// Maximum external context nodes shown on each side when drilled into a subfolder scope.
const MAX_EXTERNAL_NODES: usize = 12;
/// Maximum internal nodes returned in a single overview response (protects large repos).
const MAX_OVERVIEW_NODES: usize = 300;
/// Maximum edges returned in a single overview response (protects large repos).
const MAX_OVERVIEW_EDGES: usize = 800;
/// Maximum nodes/edges rendered into the Mermaid string.
const MAX_MERMAID_NODES: usize = 120;
const MAX_MERMAID_EDGES: usize = 250;
/// Maximum top files embedded on each module node for instant Inspector display.
const TOP_FILES_PER_NODE: usize = 8;
/// Maximum top symbol names embedded on each module edge.
const TOP_SYMBOLS_PER_EDGE: usize = 6;
/// Maximum tracked distinct file pairs per edge to bound memory on huge repositories.
const MAX_TRACKED_FILE_PAIRS: usize = 4096;
/// Prune per-edge symbol frequency maps when they exceed this many distinct names.
const SYM_COUNTS_PRUNE_THRESHOLD: usize = 256;
const SYM_COUNTS_PRUNE_KEEP: usize = 64;
/// Maximum internal files scanned from disk when `edge_types.imports` is enabled.
const MAX_IMPORT_SCAN_FILES: usize = 4000;
/// Maximum `from`-side files read from disk when inspecting a single edge's detail.
const MAX_DETAIL_SCAN_FILES: usize = 120;
/// Maximum call sites returned per file pair in edge detail.
const MAX_SITES_PER_PAIR: usize = 30;
/// Auto-depth switches from depth 1 to depth 2 when depth 1 yields at most this many
/// modules and depth 2 stays within `AUTO_DEPTH2_MAX`.
const AUTO_DEPTH1_MIN: usize = 3;
const AUTO_DEPTH2_MAX: usize = 28;

/// Which dependency edge categories to include in the module overview graph.
/// Defaults to function/method calls only (`calls: true`, all others `false`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ModuleEdgeTypes {
    /// References to callable declarations (`function`, `method`).
    pub calls: bool,
    /// References to non-callable declarations (`class`, `struct`, `interface`, `enum`, `type`, etc.).
    pub type_refs: bool,
    /// Inheritance / interface implementation (`baseRefs`).
    pub base_refs: bool,
    /// Explicit file-level import statements (`import`, `use`, `#include`, etc.).
    pub imports: bool,
}

impl Default for ModuleEdgeTypes {
    fn default() -> Self {
        Self {
            calls: true,
            type_refs: false,
            base_refs: false,
            imports: false,
        }
    }
}

impl ModuleEdgeTypes {
    pub fn any_enabled(&self) -> bool {
        self.calls || self.type_refs || self.base_refs || self.imports
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleFileSummary {
    pub path: String,
    pub symbols: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleNode {
    /// Repo-relative directory path, file path (at file depth), or `""` for workspace root.
    pub id: String,
    /// Display label relative to the active scope.
    pub label: String,
    /// `"module"`, `"file"`, or `"external"`.
    pub kind: String,
    /// True when drilling into this node reveals child directories or files.
    pub expandable: bool,
    pub files: usize,
    pub symbols: usize,
    /// Afferent coupling (incoming edges).
    pub fan_in: usize,
    /// Efferent coupling (outgoing edges).
    pub fan_out: usize,
    /// Instability metric `Ce / (Ca + Ce)` in `[0.0, 1.0]`.
    pub instability: f32,
    /// True when this node participates in a dependency cycle (Tarjan SCC size >= 2).
    pub in_cycle: bool,
    /// Topological architectural layer (0 = top entry/caller, higher = foundation/core).
    pub layer: u32,
    /// Busiest files inside this module (by declaration count), for instant Inspector view.
    pub top_files: Vec<ModuleFileSummary>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    /// Combined dependency strength (`call_refs + type_refs + base_refs * 2 + import_refs`).
    pub weight: usize,
    /// Combined symbol references (`call_refs + type_refs`).
    pub symbol_refs: usize,
    /// References targeting callable declarations (`function`, `method`).
    pub call_refs: usize,
    /// References targeting non-callable declarations (types, classes, constants, etc.).
    pub type_refs: usize,
    /// Inheritance / implementation links.
    pub base_refs: usize,
    /// Resolved file-level import statements.
    pub import_refs: usize,
    pub file_pairs: usize,
    /// Most-referenced symbols flowing across this edge.
    pub top_symbols: Vec<String>,
    /// True when both endpoints belong to the same strongly-connected cycle.
    pub is_cycle: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleOverview {
    /// Active drill-down directory prefix (`""` = workspace root).
    pub scope: String,
    /// Effective depth applied (`1`, `2`, or `3` for file-level).
    pub depth: u8,
    /// Breadcrumb directory segments from root to `scope`.
    pub breadcrumbs: Vec<String>,
    pub nodes: Vec<ModuleNode>,
    pub edges: Vec<ModuleEdge>,
    /// Strongly-connected dependency cycles among internal nodes.
    pub cycles: Vec<Vec<String>>,
    pub total_files: usize,
    pub total_symbols: usize,
    pub total_edges: usize,
    /// Ready-to-copy Mermaid `flowchart TD` source for the current view.
    pub mermaid: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EdgeImport {
    pub from_file: String,
    pub to_file: String,
    pub specifier: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EdgeCallSite {
    pub symbol: String,
    pub receiver: Option<String>,
    /// 0-based line number in `from_file`.
    pub line: usize,
    /// 0-based column in `from_file`.
    pub column: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EdgeFilePair {
    pub from_file: String,
    pub to_file: String,
    pub symbols: Vec<String>,
    pub sites: Vec<EdgeCallSite>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleEdgeDetail {
    pub from: String,
    pub to: String,
    pub imports: Vec<EdgeImport>,
    pub file_pairs: Vec<EdgeFilePair>,
    pub scanned_files: usize,
}

/// Minimal plan extracted under the store read lock so disk scanning for L2 edge detail
/// runs completely lock-free without cloning the whole `SymbolStore`.
pub struct EdgeDetailPlan {
    pub from: String,
    pub to: String,
    scan_files: Vec<String>,
    all_paths: HashSet<String>,
    to_paths: HashSet<String>,
    to_sym_decls: HashMap<String, Vec<String>>,
}

/// Minimal plan extracted under the store read lock for parallel import-edge scanning
/// when `edge_types.imports` is enabled.
pub struct ImportScanPlan {
    pub all_paths: Vec<String>,
    pub scan_fids: Vec<u32>,
}

/// Normalize folder prefixes from the frontend/Explorer pick: forward slashes, no
/// leading/trailing slashes, deduplicated, dropping redundant child prefixes.
pub fn normalize_scope(folders: &[String]) -> Vec<String> {
    let mut cleaned: Vec<String> = folders
        .iter()
        .map(|f| f.replace('\\', "/").trim_matches('/').to_owned())
        .filter(|f| !f.is_empty())
        .collect();
    cleaned.sort();
    cleaned.dedup();
    let mut keep: Vec<String> = Vec::with_capacity(cleaned.len());
    for folder in cleaned {
        if keep
            .last()
            .is_some_and(|parent| folder.starts_with(&format!("{parent}/")))
        {
            continue;
        }
        keep.push(folder);
    }
    keep
}

pub fn normalize_single_scope(scope: Option<&str>) -> String {
    scope
        .unwrap_or("")
        .replace('\\', "/")
        .trim_matches('/')
        .to_owned()
}

fn in_folders(path: &str, folders: &[String]) -> bool {
    if folders.is_empty() {
        return true;
    }
    folders
        .iter()
        .any(|folder| path == folder || path.starts_with(&format!("{folder}/")))
}

fn in_scope(path: &str, scope: &str) -> bool {
    if scope.is_empty() {
        true
    } else {
        path.starts_with(&format!("{scope}/"))
    }
}

/// Strip `scope/` prefix from an internal file path.
fn relative_to_scope<'a>(path: &'a str, scope: &str) -> &'a str {
    if scope.is_empty() {
        path
    } else {
        path.strip_prefix(scope)
            .and_then(|rest| rest.strip_prefix('/'))
            .unwrap_or(path)
    }
}

/// Group an internal file into a module or file node at `depth` (`1`, `2`, or `>=3` for file).
/// Returns `(node_id, label, is_file)`.
fn internal_group(path: &str, scope: &str, depth: u8, folders: &[String]) -> (String, String, bool) {
    let rel = relative_to_scope(path, scope);
    if depth >= 3 {
        return (path.to_owned(), rel.to_owned(), true);
    }
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.len() == 1 {
        return (path.to_owned(), rel.to_owned(), true);
    }
    let dir_segments = parts.len() - 1;
    let min_folder_depth = if scope.is_empty() {
        folders
            .iter()
            .filter(|f| path == f.as_str() || path.starts_with(&format!("{f}/")))
            .map(|f| f.split('/').count())
            .max()
            .unwrap_or(1)
    } else {
        1
    };
    let take = (depth as usize).max(min_folder_depth).min(dir_segments);
    let rel_dir = parts[..take].join("/");
    let id = if scope.is_empty() {
        rel_dir.clone()
    } else {
        format!("{scope}/{rel_dir}")
    };
    (id, rel_dir, false)
}

/// Group an external file (outside `scope` or `folders`) into a concise external context bucket.
fn external_group(path: &str, scope: &str, folders: &[String]) -> (String, String) {
    let scope_top = scope.split('/').next().unwrap_or("");
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() == 1 {
        return ("".to_owned(), "(root)".to_owned());
    }
    let shares_top = (!scope_top.is_empty() && parts[0] == scope_top)
        || folders
            .iter()
            .any(|f| f.contains('/') && f.split('/').next() == Some(parts[0]));
    let want = if shares_top && parts.len() >= 3 { 2 } else { 1 };
    let take = want.min(parts.len() - 1);
    let id = parts[..take].join("/");
    (id.clone(), id)
}

/// Choose the cleanest architectural depth when `requested == 0` (Auto).
fn pick_effective_depth_iter<'a>(
    paths: impl Iterator<Item = &'a str>,
    scope: &str,
    folders: &[String],
    requested: u8,
) -> u8 {
    if requested > 0 {
        return requested.clamp(1, 3);
    }
    let mut d1: HashSet<String> = HashSet::new();
    let mut d2: HashSet<String> = HashSet::new();
    let mut has_subdirs = false;
    for path in paths {
        if !in_folders(path, folders) || !in_scope(path, scope) {
            continue;
        }
        let rel = relative_to_scope(path, scope);
        if rel.contains('/') {
            has_subdirs = true;
        }
        d1.insert(internal_group(path, scope, 1, folders).0);
        d2.insert(internal_group(path, scope, 2, folders).0);
    }
    if !has_subdirs {
        return 3;
    }
    if d1.len() <= AUTO_DEPTH1_MIN && d2.len() > d1.len() && d2.len() <= AUTO_DEPTH2_MAX {
        2
    } else {
        1
    }
}

/// Fixed-size inline declaration record per interned name: avoids allocating a separate
/// heap `Vec<u32>` per name (saves hundreds of thousands of small allocations on large repos).
#[derive(Clone, Copy)]
struct SmallDecls {
    fids: [u32; MAX_DECL_FILES_FOR_BASE],
    /// Number of distinct declaring files, saturating at `MAX_DECL_FILES_FOR_BASE + 1`.
    len: u8,
    /// Bitmask (bits 0..4): `fids[i]` declared this name as callable (`function` or `method`).
    callable_mask: u8,
    /// Bitmask (bits 0..4): `fids[i]` declared this name as non-callable (type/class/etc.).
    type_mask: u8,
}

impl SmallDecls {
    const EMPTY: Self = Self {
        fids: [0; MAX_DECL_FILES_FOR_BASE],
        len: 0,
        callable_mask: 0,
        type_mask: 0,
    };

    #[inline]
    fn record(&mut self, fid: u32, is_callable: bool) {
        let len = self.len as usize;
        if len > MAX_DECL_FILES_FOR_BASE {
            return;
        }
        // Declarations are visited in ascending `fid` order, so checking the last slot
        // deduplicates multiple declarations of the same name within one file in O(1).
        if len > 0 && self.fids[len - 1] == fid {
            let bit = 1u8 << (len - 1);
            if is_callable {
                self.callable_mask |= bit;
            } else {
                self.type_mask |= bit;
            }
            return;
        }
        if len < MAX_DECL_FILES_FOR_BASE {
            self.fids[len] = fid;
            let bit = 1u8 << len;
            if is_callable {
                self.callable_mask |= bit;
            } else {
                self.type_mask |= bit;
            }
            self.len = (len + 1) as u8;
        } else {
            self.len = (MAX_DECL_FILES_FOR_BASE + 1) as u8;
        }
    }
}

struct NodeAcc {
    id: String,
    label: String,
    kind: &'static str,
    file_count: usize,
    /// Top `TOP_FILES_PER_NODE` files as `(fid, symbol_count)` — paths materialized only at end.
    top_files: Vec<(u32, u32)>,
    symbols: usize,
    has_child_dirs: bool,
}

impl NodeAcc {
    #[inline]
    fn record_file(&mut self, fid: u32, sym_count: u32) {
        self.file_count += 1;
        self.symbols += sym_count as usize;
        if self.top_files.len() < TOP_FILES_PER_NODE {
            self.top_files.push((fid, sym_count));
        } else if let Some((min_idx, &(_, min_syms))) = self
            .top_files
            .iter()
            .enumerate()
            .min_by_key(|(_, &(f, s))| (s, std::cmp::Reverse(f)))
        {
            if sym_count > min_syms {
                self.top_files[min_idx] = (fid, sym_count);
            }
        }
    }
}

#[derive(Default)]
struct EdgeAcc {
    call_refs: usize,
    type_refs: usize,
    base_refs: usize,
    import_refs: usize,
    file_pairs: HashSet<u64>,
    sym_counts: HashMap<u32, u32>,
}

impl EdgeAcc {
    #[inline]
    fn record_pair(&mut self, from_fid: u32, to_fid: u32) {
        if self.file_pairs.len() < MAX_TRACKED_FILE_PAIRS {
            let key = ((from_fid as u64) << 32) | (to_fid as u64);
            self.file_pairs.insert(key);
        }
    }

    #[inline]
    fn record_symbol(&mut self, name_id: u32, delta: u32) {
        let entry = self.sym_counts.entry(name_id).or_default();
        *entry = entry.saturating_add(delta);
        if self.sym_counts.len() > SYM_COUNTS_PRUNE_THRESHOLD {
            let mut items: Vec<(u32, u32)> = self.sym_counts.drain().collect();
            items.sort_unstable_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            items.truncate(SYM_COUNTS_PRUNE_KEEP);
            self.sym_counts.extend(items);
        }
    }

    #[inline]
    fn weight(&self) -> usize {
        self.call_refs + self.type_refs + self.base_refs * 2 + self.import_refs
    }
}

#[inline]
fn edge_key(from_idx: u32, to_idx: u32) -> u64 {
    ((from_idx as u64) << 32) | (to_idx as u64)
}

/// Extract the minimal file list needed to scan file-level imports outside the store lock.
pub fn prepare_import_scan_plan(
    store: &SymbolStore,
    scope: Option<&str>,
    folders: &[String],
) -> ImportScanPlan {
    let folders = normalize_scope(folders);
    let scope = normalize_single_scope(scope);
    let file_count = store.file_count();
    let mut all_paths = Vec::with_capacity(file_count);
    let mut scan_fids = Vec::new();
    for fid in 0..file_count {
        if let Some(path) = store.file_path(fid) {
            all_paths.push(path.to_owned());
            if in_folders(path, &folders) && in_scope(path, &scope) {
                scan_fids.push(fid as u32);
            }
        }
    }
    if scan_fids.len() > MAX_IMPORT_SCAN_FILES {
        scan_fids.truncate(MAX_IMPORT_SCAN_FILES);
    }
    ImportScanPlan {
        all_paths,
        scan_fids,
    }
}

/// Scan explicit file-level import edges `(from_fid, to_fid)` in parallel outside the store lock.
pub fn scan_import_edges(root: &str, plan: &ImportScanPlan) -> Vec<(u32, u32)> {
    if plan.scan_fids.is_empty() || plan.all_paths.is_empty() {
        return Vec::new();
    }
    let path_to_fid: HashMap<&str, u32> = plan
        .all_paths
        .iter()
        .enumerate()
        .map(|(i, p)| (p.as_str(), i as u32))
        .collect();
    let path_set: HashSet<&str> = plan.all_paths.iter().map(String::as_str).collect();
    let root_path = Path::new(root);

    plan.scan_fids
        .par_iter()
        .flat_map_iter(|&fid| {
            let from_path = &plan.all_paths[fid as usize];
            let Ok(bytes) = std::fs::read(root_path.join(from_path)) else {
                return Vec::new();
            };
            let text = String::from_utf8_lossy(&bytes);
            let ext = from_path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
            let mut local = Vec::new();
            for spec in sites::import_spellings(ext, &text) {
                if let Some(target) = resolve_import(from_path, ext, &spec, &path_set) {
                    if let Some(&to_fid) = path_to_fid.get(target.as_str()) {
                        if to_fid != fid {
                            local.push((fid, to_fid));
                        }
                    }
                }
            }
            local.sort_unstable();
            local.dedup();
            local
        })
        .collect()
}

/// Build the scoped, layered module architecture overview directly from `&SymbolStore`
/// with zero cloning of the store's `names`/`refs`/`files` tables.
/// If `edge_types.imports` is `true`, pass pre-scanned `import_edges` from [`scan_import_edges`].
pub fn module_overview_from_store(
    store: &SymbolStore,
    scope: Option<&str>,
    depth: u8,
    folders: &[String],
    edge_types: ModuleEdgeTypes,
    import_edges: Option<&[(u32, u32)]>,
) -> ModuleOverview {
    let folders = normalize_scope(folders);
    let scope = normalize_single_scope(scope);
    let file_count = store.file_count();
    let effective_depth = pick_effective_depth_iter(
        (0..file_count).filter_map(|fid| store.file_path(fid)),
        &scope,
        &folders,
        depth,
    );
    let breadcrumbs: Vec<String> = if scope.is_empty() {
        Vec::new()
    } else {
        scope.split('/').map(str::to_owned).collect()
    };

    // Map every file_id -> (node_idx, is_internal) using integer indices (zero per-file String clones).
    let mut file_node: Vec<(u32, bool)> = Vec::with_capacity(file_count);
    let mut node_id_to_idx: HashMap<String, u32> = HashMap::new();
    let mut nodes_acc: Vec<NodeAcc> = Vec::new();
    let mut total_files = 0usize;
    let mut total_symbols = 0usize;

    for fid in 0..file_count {
        let Some(path) = store.file_path(fid) else {
            file_node.push((u32::MAX, false));
            continue;
        };
        let sym_count = store.file_symbol_count(fid) as u32;
        let internal = in_folders(path, &folders) && in_scope(path, &scope);
        if internal {
            total_files += 1;
            total_symbols += sym_count as usize;
            let (id, label, is_file) = internal_group(path, &scope, effective_depth, &folders);
            let idx = if let Some(&existing) = node_id_to_idx.get(&id) {
                existing
            } else {
                let idx = nodes_acc.len() as u32;
                node_id_to_idx.insert(id.clone(), idx);
                nodes_acc.push(NodeAcc {
                    id: id.clone(),
                    label,
                    kind: if is_file { "file" } else { "module" },
                    file_count: 0,
                    top_files: Vec::new(),
                    symbols: 0,
                    has_child_dirs: false,
                });
                idx
            };
            let entry = &mut nodes_acc[idx as usize];
            entry.record_file(fid as u32, sym_count);
            if !is_file && !entry.has_child_dirs {
                if let Some(rest) = path.strip_prefix(&entry.id).and_then(|r| r.strip_prefix('/')) {
                    if rest.contains('/') {
                        entry.has_child_dirs = true;
                    }
                }
            }
            file_node.push((idx, true));
        } else {
            let (id, label) = external_group(path, &scope, &folders);
            let idx = if let Some(&existing) = node_id_to_idx.get(&id) {
                existing
            } else {
                let idx = nodes_acc.len() as u32;
                node_id_to_idx.insert(id.clone(), idx);
                nodes_acc.push(NodeAcc {
                    id,
                    label,
                    kind: "external",
                    file_count: 0,
                    top_files: Vec::new(),
                    symbols: 0,
                    has_child_dirs: false,
                });
                idx
            };
            nodes_acc[idx as usize].record_file(fid as u32, sym_count);
            file_node.push((idx, false));
        }
    }

    // Aggregate cross-module dependencies using compact integer keys and bounded maps.
    let mut edge_acc: HashMap<u64, EdgeAcc> = HashMap::new();
    let name_count = store.name_count();

    if edge_types.calls || edge_types.type_refs || edge_types.base_refs {
        let mut decls = vec![SmallDecls::EMPTY; name_count];
        store.for_each_file_decl_vis(|fid, name_id, is_callable, is_private| {
            if is_private {
                // File-private C/C++ `static` declarations cannot be called or referenced from other files.
                return;
            }
            if let Some(slot) = decls.get_mut(name_id as usize) {
                slot.record(fid, is_callable);
            }
        });

        // 1a. Function/method calls — backed by AST `call_files_of` (actual call sites only,
        // never comments, strings, docstrings, or non-call identifiers) + language-family check.
        if edge_types.calls {
            for (name_id, slot) in decls.iter().enumerate() {
                let dlen = slot.len as usize;
                if dlen == 0 || dlen > MAX_DECL_FILES_FOR_SIGNAL || slot.callable_mask == 0 {
                    continue;
                }
                let Some(name) = store.name_str(name_id) else {
                    continue;
                };
                if name.len() < 2 {
                    continue;
                }
                let Some(callers) = store.call_files_of(name_id) else {
                    continue;
                };
                if file_count >= 20 && callers.len() * 10 > file_count * 6 {
                    continue;
                }
                for &caller_fid in callers {
                    let Some(&(from_idx, from_internal)) = file_node.get(caller_fid as usize) else {
                        continue;
                    };
                    if from_idx == u32::MAX {
                        continue;
                    }
                    let Some(caller_path) = store.file_path(caller_fid as usize) else {
                        continue;
                    };
                    for i in 0..dlen {
                        let bit = 1u8 << i;
                        if (slot.callable_mask & bit) == 0 {
                            continue;
                        }
                        let callee_fid = slot.fids[i];
                        if caller_fid == callee_fid {
                            continue;
                        }
                        let Some(callee_path) = store.file_path(callee_fid as usize) else {
                            continue;
                        };
                        if !sites::same_lang_family(caller_path, callee_path) {
                            continue;
                        }
                        let Some(&(to_idx, to_internal)) = file_node.get(callee_fid as usize) else {
                            continue;
                        };
                        if to_idx == u32::MAX || from_idx == to_idx || (!from_internal && !to_internal) {
                            continue;
                        }
                        let entry = edge_acc.entry(edge_key(from_idx, to_idx)).or_default();
                        entry.record_pair(caller_fid, callee_fid);
                        entry.call_refs += 1;
                        entry.record_symbol(name_id as u32, 1);
                    }
                }
            }
        }

        // 1b. Non-callable type/class/struct/constant symbol references (same language family).
        if edge_types.type_refs {
            for (name_id, slot) in decls.iter().enumerate() {
                let dlen = slot.len as usize;
                if dlen == 0 || dlen > MAX_DECL_FILES_FOR_SIGNAL || slot.type_mask == 0 {
                    continue;
                }
                let Some(name) = store.name_str(name_id) else {
                    continue;
                };
                if name.len() < 2 {
                    continue;
                }
                let Some(refs) = store.ref_files_of(name_id) else {
                    continue;
                };
                if file_count >= 20 && refs.len() * 10 > file_count * 6 {
                    continue;
                }
                for &caller_fid in refs {
                    let Some(&(from_idx, from_internal)) = file_node.get(caller_fid as usize) else {
                        continue;
                    };
                    if from_idx == u32::MAX {
                        continue;
                    }
                    let Some(caller_path) = store.file_path(caller_fid as usize) else {
                        continue;
                    };
                    for i in 0..dlen {
                        let bit = 1u8 << i;
                        if (slot.type_mask & bit) == 0 {
                            continue;
                        }
                        let callee_fid = slot.fids[i];
                        if caller_fid == callee_fid {
                            continue;
                        }
                        let Some(callee_path) = store.file_path(callee_fid as usize) else {
                            continue;
                        };
                        if !sites::same_lang_family(caller_path, callee_path) {
                            continue;
                        }
                        let Some(&(to_idx, to_internal)) = file_node.get(callee_fid as usize) else {
                            continue;
                        };
                        if to_idx == u32::MAX || from_idx == to_idx || (!from_internal && !to_internal) {
                            continue;
                        }
                        let entry = edge_acc.entry(edge_key(from_idx, to_idx)).or_default();
                        entry.record_pair(caller_fid, callee_fid);
                        entry.type_refs += 1;
                        entry.record_symbol(name_id as u32, 1);
                    }
                }
            }
        }

        // 2. Inheritance / implementation base edges.
        if edge_types.base_refs {
            let mut seen_base_edges: HashSet<u64> = HashSet::new();
            store.for_each_base_edge(|derived_fid, base_name_id| {
                let dedup_key = ((derived_fid as u64) << 32) | (base_name_id as u64);
                if !seen_base_edges.insert(dedup_key) {
                    return;
                }
                let Some(slot) = decls.get(base_name_id as usize) else {
                    return;
                };
                let dlen = slot.len as usize;
                if dlen == 0 || dlen > MAX_DECL_FILES_FOR_BASE {
                    return;
                }
                let Some(&(from_idx, from_internal)) = file_node.get(derived_fid as usize) else {
                    return;
                };
                if from_idx == u32::MAX {
                    return;
                }
                let Some(derived_path) = store.file_path(derived_fid as usize) else {
                    return;
                };
                for i in 0..dlen {
                    let base_fid = slot.fids[i];
                    if derived_fid == base_fid {
                        continue;
                    }
                    let Some(base_path) = store.file_path(base_fid as usize) else {
                        continue;
                    };
                    if !sites::same_lang_family(derived_path, base_path) {
                        continue;
                    }
                    let Some(&(to_idx, to_internal)) = file_node.get(base_fid as usize) else {
                        continue;
                    };
                    if to_idx == u32::MAX || from_idx == to_idx || (!from_internal && !to_internal) {
                        continue;
                    }
                    let entry = edge_acc.entry(edge_key(from_idx, to_idx)).or_default();
                    entry.record_pair(derived_fid, base_fid);
                    entry.base_refs += 1;
                    entry.record_symbol(base_name_id, 2);
                }
            });
        }
    }

    // 3. Explicit file-level imports (optional, pre-scanned in parallel outside the store lock).
    if edge_types.imports {
        if let Some(imports) = import_edges {
            for &(from_fid, to_fid) in imports {
                let Some(&(from_idx, from_internal)) = file_node.get(from_fid as usize) else {
                    continue;
                };
                let Some(&(to_idx, to_internal)) = file_node.get(to_fid as usize) else {
                    continue;
                };
                if from_idx == u32::MAX
                    || to_idx == u32::MAX
                    || from_idx == to_idx
                    || (!from_internal && !to_internal)
                {
                    continue;
                }
                let entry = edge_acc.entry(edge_key(from_idx, to_idx)).or_default();
                entry.record_pair(from_fid, to_fid);
                entry.import_refs += 1;
            }
        }
    }

    finalize_overview(
        scope,
        effective_depth,
        breadcrumbs,
        nodes_acc,
        edge_acc,
        total_files,
        total_symbols,
        |fid| store.file_path(fid as usize).unwrap_or("").to_owned(),
        |nid| store.name_str(nid as usize).unwrap_or("").to_owned(),
    )
}

/// Convenience helper that runs `prepare_import_scan_plan` + `scan_import_edges` automatically
/// when `edge_types.imports` is enabled and `root` is provided.
pub fn module_overview_with_store(
    store: &SymbolStore,
    root: Option<&str>,
    scope: Option<&str>,
    depth: u8,
    folders: &[String],
    edge_types: ModuleEdgeTypes,
) -> ModuleOverview {
    let scanned = if edge_types.imports {
        root.map(|r| {
            let plan = prepare_import_scan_plan(store, scope, folders);
            scan_import_edges(r, &plan)
        })
    } else {
        None
    };
    module_overview_from_store(store, scope, depth, folders, edge_types, scanned.as_deref())
}

/// Build the scoped, layered module architecture overview from a `StoreDependencyFacts`
/// snapshot (uses default `ModuleEdgeTypes`: function/method calls only).
pub fn module_overview(
    facts: &StoreDependencyFacts,
    scope: Option<&str>,
    depth: u8,
    folders: &[String],
) -> ModuleOverview {
    module_overview_with_types(facts, scope, depth, folders, ModuleEdgeTypes::default())
}

/// Build the scoped, layered module architecture overview from a `StoreDependencyFacts`
/// snapshot with explicit `ModuleEdgeTypes`.
pub fn module_overview_with_types(
    facts: &StoreDependencyFacts,
    scope: Option<&str>,
    depth: u8,
    folders: &[String],
    edge_types: ModuleEdgeTypes,
) -> ModuleOverview {
    let folders = normalize_scope(folders);
    let scope = normalize_single_scope(scope);
    let file_count = facts.files.len();
    let effective_depth = pick_effective_depth_iter(
        facts.files.iter().map(String::as_str),
        &scope,
        &folders,
        depth,
    );
    let breadcrumbs: Vec<String> = if scope.is_empty() {
        Vec::new()
    } else {
        scope.split('/').map(str::to_owned).collect()
    };

    let mut file_node: Vec<(u32, bool)> = Vec::with_capacity(file_count);
    let mut node_id_to_idx: HashMap<String, u32> = HashMap::new();
    let mut nodes_acc: Vec<NodeAcc> = Vec::new();
    let mut total_files = 0usize;
    let mut total_symbols = 0usize;

    for (fid, path) in facts.files.iter().enumerate() {
        let sym_count = facts.symbol_counts.get(fid).copied().unwrap_or(0);
        let internal = in_folders(path, &folders) && in_scope(path, &scope);
        if internal {
            total_files += 1;
            total_symbols += sym_count as usize;
            let (id, label, is_file) = internal_group(path, &scope, effective_depth, &folders);
            let idx = if let Some(&existing) = node_id_to_idx.get(&id) {
                existing
            } else {
                let idx = nodes_acc.len() as u32;
                node_id_to_idx.insert(id.clone(), idx);
                nodes_acc.push(NodeAcc {
                    id: id.clone(),
                    label,
                    kind: if is_file { "file" } else { "module" },
                    file_count: 0,
                    top_files: Vec::new(),
                    symbols: 0,
                    has_child_dirs: false,
                });
                idx
            };
            let entry = &mut nodes_acc[idx as usize];
            entry.record_file(fid as u32, sym_count);
            if !is_file && !entry.has_child_dirs {
                if let Some(rest) = path.strip_prefix(&entry.id).and_then(|r| r.strip_prefix('/')) {
                    if rest.contains('/') {
                        entry.has_child_dirs = true;
                    }
                }
            }
            file_node.push((idx, true));
        } else {
            let (id, label) = external_group(path, &scope, &folders);
            let idx = if let Some(&existing) = node_id_to_idx.get(&id) {
                existing
            } else {
                let idx = nodes_acc.len() as u32;
                node_id_to_idx.insert(id.clone(), idx);
                nodes_acc.push(NodeAcc {
                    id,
                    label,
                    kind: "external",
                    file_count: 0,
                    top_files: Vec::new(),
                    symbols: 0,
                    has_child_dirs: false,
                });
                idx
            };
            nodes_acc[idx as usize].record_file(fid as u32, sym_count);
            file_node.push((idx, false));
        }
    }

    let mut edge_acc: HashMap<u64, EdgeAcc> = HashMap::new();

    if edge_types.calls || edge_types.type_refs {
        for (name_id, decls) in facts.decl_files.iter().enumerate() {
            if decls.is_empty() || decls.len() > MAX_DECL_FILES_FOR_SIGNAL {
                continue;
            }
            let is_callable = facts.decl_is_callable.get(name_id).copied().unwrap_or(true);
            if is_callable && !edge_types.calls {
                continue;
            }
            if !is_callable && !edge_types.type_refs {
                continue;
            }
            let name = &facts.names[name_id];
            if name.len() < 2 {
                continue;
            }
            let Some(Some(refs)) = facts.ref_files.get(name_id) else {
                continue;
            };
            if file_count >= 20 && refs.len() * 10 > file_count * 6 {
                continue;
            }
            for &caller_fid in refs {
                let Some(&(from_idx, from_internal)) = file_node.get(caller_fid as usize) else {
                    continue;
                };
                for &callee_fid in decls {
                    if caller_fid == callee_fid {
                        continue;
                    }
                    if !sites::same_lang_family(&facts.files[caller_fid as usize], &facts.files[callee_fid as usize]) {
                        continue;
                    }
                    let Some(&(to_idx, to_internal)) = file_node.get(callee_fid as usize) else {
                        continue;
                    };
                    if from_idx == to_idx || (!from_internal && !to_internal) {
                        continue;
                    }
                    let entry = edge_acc.entry(edge_key(from_idx, to_idx)).or_default();
                    entry.record_pair(caller_fid, callee_fid);
                    if is_callable {
                        entry.call_refs += 1;
                    } else {
                        entry.type_refs += 1;
                    }
                    entry.record_symbol(name_id as u32, 1);
                }
            }
        }
    }

    if edge_types.base_refs {
        for &(derived_fid, base_name_id) in &facts.base_edges {
            let Some(decls) = facts.decl_files.get(base_name_id as usize) else {
                continue;
            };
            if decls.is_empty() || decls.len() > MAX_DECL_FILES_FOR_BASE {
                continue;
            }
            let Some(&(from_idx, from_internal)) = file_node.get(derived_fid as usize) else {
                continue;
            };
            for &base_fid in decls {
                if derived_fid == base_fid {
                    continue;
                }
                let Some(&(to_idx, to_internal)) = file_node.get(base_fid as usize) else {
                    continue;
                };
                if from_idx == to_idx || (!from_internal && !to_internal) {
                    continue;
                }
                let entry = edge_acc.entry(edge_key(from_idx, to_idx)).or_default();
                entry.record_pair(derived_fid, base_fid);
                entry.base_refs += 1;
                entry.record_symbol(base_name_id, 2);
            }
        }
    }

    finalize_overview(
        scope,
        effective_depth,
        breadcrumbs,
        nodes_acc,
        edge_acc,
        total_files,
        total_symbols,
        |fid| facts.files.get(fid as usize).cloned().unwrap_or_default(),
        |nid| facts.names.get(nid as usize).cloned().unwrap_or_default(),
    )
}

#[allow(clippy::too_many_arguments)]
fn finalize_overview(
    scope: String,
    effective_depth: u8,
    breadcrumbs: Vec<String>,
    nodes_acc: Vec<NodeAcc>,
    edge_acc: HashMap<u64, EdgeAcc>,
    total_files: usize,
    total_symbols: usize,
    file_path_of: impl Fn(u32) -> String,
    name_of: impl Fn(u32) -> String,
) -> ModuleOverview {
    let total_edges = edge_acc.len();
    let node_count = nodes_acc.len();

    // Rank external nodes by total incident weight and cap to MAX_EXTERNAL_NODES.
    let mut external_weight: HashMap<u32, usize> = HashMap::new();
    let mut internal_weight: Vec<usize> = vec![0; node_count];
    for (&key, acc) in &edge_acc {
        let from_idx = (key >> 32) as u32;
        let to_idx = (key & 0xffff_ffff) as u32;
        let w = acc.weight();
        if nodes_acc[from_idx as usize].kind == "external" {
            *external_weight.entry(from_idx).or_default() += w;
        } else {
            internal_weight[from_idx as usize] += w;
        }
        if nodes_acc[to_idx as usize].kind == "external" {
            *external_weight.entry(to_idx).or_default() += w;
        } else {
            internal_weight[to_idx as usize] += w;
        }
    }
    let mut ext_ranked: Vec<(u32, usize)> = external_weight.into_iter().collect();
    ext_ranked.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| nodes_acc[a.0 as usize].id.cmp(&nodes_acc[b.0 as usize].id))
    });
    let kept_external: HashSet<u32> = ext_ranked
        .into_iter()
        .take(MAX_EXTERNAL_NODES)
        .map(|(idx, _)| idx)
        .collect();

    // Iterative Tarjan SCC on all internal nodes first so cycle members are prioritized
    // if a huge repository exceeds MAX_OVERVIEW_NODES.
    let internal_indices: Vec<u32> = (0..node_count as u32)
        .filter(|&i| nodes_acc[i as usize].kind != "external")
        .collect();
    let internal_edge_pairs_idx: Vec<(u32, u32)> = edge_acc
        .keys()
        .filter_map(|&key| {
            let u = (key >> 32) as u32;
            let v = (key & 0xffff_ffff) as u32;
            (nodes_acc[u as usize].kind != "external" && nodes_acc[v as usize].kind != "external")
                .then_some((u, v))
        })
        .collect();

    let (scc_of_idx, cycles_idx) = compute_sccs_idx(&internal_indices, &internal_edge_pairs_idx);
    let cycle_node_set: HashSet<u32> = cycles_idx.iter().flat_map(|c| c.iter().copied()).collect();

    // Cap internal nodes to MAX_OVERVIEW_NODES, prioritizing cycle members, then highest
    // incident edge weight, then symbol count.
    let kept_internal: HashSet<u32> = if internal_indices.len() <= MAX_OVERVIEW_NODES {
        internal_indices.iter().copied().collect()
    } else {
        let mut ranked = internal_indices.clone();
        ranked.sort_by(|&a, &b| {
            cycle_node_set
                .contains(&b)
                .cmp(&cycle_node_set.contains(&a))
                .then_with(|| internal_weight[b as usize].cmp(&internal_weight[a as usize]))
                .then_with(|| nodes_acc[b as usize].symbols.cmp(&nodes_acc[a as usize].symbols))
                .then_with(|| nodes_acc[a as usize].id.cmp(&nodes_acc[b as usize].id))
        });
        ranked.truncate(MAX_OVERVIEW_NODES);
        ranked.into_iter().collect()
    };

    let is_kept = |idx: u32| kept_internal.contains(&idx) || kept_external.contains(&idx);

    // Filter edges to kept nodes, mark cycle edges, and cap to MAX_OVERVIEW_EDGES.
    let mut raw_edges: Vec<(u32, u32, ModuleEdge)> = edge_acc
        .into_iter()
        .filter_map(|(key, acc)| {
            let from_idx = (key >> 32) as u32;
            let to_idx = (key & 0xffff_ffff) as u32;
            if !is_kept(from_idx) || !is_kept(to_idx) {
                return None;
            }
            let weight = acc.weight();
            let mut syms: Vec<(u32, u32)> = acc.sym_counts.into_iter().collect();
            syms.sort_by(|a, b| {
                b.1.cmp(&a.1)
                    .then_with(|| name_of(a.0).cmp(&name_of(b.0)))
            });
            let top_symbols: Vec<String> = syms
                .into_iter()
                .take(TOP_SYMBOLS_PER_EDGE)
                .map(|(nid, _)| name_of(nid))
                .collect();
            let symbol_refs = acc.call_refs + acc.type_refs;
            let from = nodes_acc[from_idx as usize].id.clone();
            let to = nodes_acc[to_idx as usize].id.clone();
            let is_cycle = matches!(
                (scc_of_idx.get(&from_idx), scc_of_idx.get(&to_idx)),
                (Some(&sa), Some(&sb)) if sa == sb && cycle_node_set.contains(&from_idx)
            );
            let edge = ModuleEdge {
                id: format!("{from}→{to}"),
                from,
                to,
                weight,
                symbol_refs,
                call_refs: acc.call_refs,
                type_refs: acc.type_refs,
                base_refs: acc.base_refs,
                import_refs: acc.import_refs,
                file_pairs: acc.file_pairs.len(),
                top_symbols,
                is_cycle,
            };
            Some((from_idx, to_idx, edge))
        })
        .collect();

    raw_edges.sort_by(|a, b| {
        b.2.is_cycle
            .cmp(&a.2.is_cycle)
            .then_with(|| b.2.weight.cmp(&a.2.weight))
            .then_with(|| a.2.from.cmp(&b.2.from))
            .then_with(|| a.2.to.cmp(&b.2.to))
    });
    if raw_edges.len() > MAX_OVERVIEW_EDGES {
        raw_edges.truncate(MAX_OVERVIEW_EDGES);
    }
    // Re-sort by weight descending for stable display order.
    raw_edges.sort_by(|a, b| {
        b.2.weight
            .cmp(&a.2.weight)
            .then_with(|| a.2.from.cmp(&b.2.from))
            .then_with(|| a.2.to.cmp(&b.2.to))
    });

    // Recompute cycles & layers over the kept internal subgraph so metrics match displayed edges.
    let kept_internal_list: Vec<u32> = internal_indices
        .into_iter()
        .filter(|i| kept_internal.contains(i))
        .collect();
    let kept_internal_edges: Vec<(u32, u32)> = raw_edges
        .iter()
        .filter(|(u, v, _)| kept_internal.contains(u) && kept_internal.contains(v))
        .map(|(u, v, _)| (*u, *v))
        .collect();
    let (final_scc, final_cycles_idx) = compute_sccs_idx(&kept_internal_list, &kept_internal_edges);
    let final_cycle_nodes: HashSet<u32> = final_cycles_idx
        .iter()
        .flat_map(|c| c.iter().copied())
        .collect();
    let mut cycles: Vec<Vec<String>> = final_cycles_idx
        .into_iter()
        .map(|comp| {
            let mut ids: Vec<String> = comp
                .into_iter()
                .map(|idx| nodes_acc[idx as usize].id.clone())
                .collect();
            ids.sort();
            ids
        })
        .collect();
    cycles.sort();

    let mut edges: Vec<ModuleEdge> = Vec::with_capacity(raw_edges.len());
    let mut fan_in: Vec<usize> = vec![0; node_count];
    let mut fan_out: Vec<usize> = vec![0; node_count];
    for (u, v, mut edge) in raw_edges {
        edge.is_cycle = matches!(
            (final_scc.get(&u), final_scc.get(&v)),
            (Some(&sa), Some(&sb)) if sa == sb && final_cycle_nodes.contains(&u)
        );
        fan_out[u as usize] += 1;
        fan_in[v as usize] += 1;
        edges.push(edge);
    }

    let internal_layers = compute_layers_idx(&kept_internal_list, &kept_internal_edges, &final_scc);
    let has_ext_inbound = kept_external.iter().any(|&idx| fan_out[idx as usize] > 0);
    let layer_shift = u32::from(has_ext_inbound);
    let max_internal_layer = internal_layers.values().copied().max().unwrap_or(0) + layer_shift;

    let mut nodes: Vec<ModuleNode> = Vec::with_capacity(kept_internal.len() + kept_external.len());
    for (idx_usize, mut acc) in nodes_acc.into_iter().enumerate() {
        let idx = idx_usize as u32;
        if !is_kept(idx) {
            continue;
        }
        acc.top_files.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then_with(|| file_path_of(a.0).cmp(&file_path_of(b.0)))
        });
        let top_files = acc
            .top_files
            .into_iter()
            .map(|(fid, symbols)| ModuleFileSummary {
                path: file_path_of(fid),
                symbols: symbols as usize,
            })
            .collect();
        let ca = fan_in[idx_usize];
        let ce = fan_out[idx_usize];
        let instability = if ca + ce == 0 {
            0.0
        } else {
            ((ce as f32 / (ca + ce) as f32) * 100.0).round() / 100.0
        };
        let layer = if acc.kind == "external" {
            if ce > 0 && ca == 0 {
                0
            } else {
                max_internal_layer + 1
            }
        } else {
            internal_layers.get(&idx).copied().unwrap_or(0) + layer_shift
        };
        let expandable = acc.kind == "module" && (acc.has_child_dirs || acc.file_count > 0);
        let in_cycle = final_cycle_nodes.contains(&idx);
        nodes.push(ModuleNode {
            id: acc.id,
            label: acc.label,
            kind: acc.kind.to_owned(),
            expandable,
            files: acc.file_count,
            symbols: acc.symbols,
            fan_in: ca,
            fan_out: ce,
            instability,
            in_cycle,
            layer,
            top_files,
        });
    }
    nodes.sort_by(|a, b| {
        a.layer
            .cmp(&b.layer)
            .then_with(|| (b.fan_in + b.fan_out).cmp(&(a.fan_in + a.fan_out)))
            .then_with(|| a.id.cmp(&b.id))
    });

    let mermaid = overview_to_mermaid(&nodes, &edges);

    ModuleOverview {
        scope,
        depth: effective_depth,
        breadcrumbs,
        nodes,
        edges,
        cycles,
        total_files,
        total_symbols,
        total_edges,
        mermaid,
    }
}

/// One file pair's L2 evidence: the shared symbols and the capped call-site list.
type PairEvidence = (BTreeMap<String, ()>, Vec<EdgeCallSite>);

/// Extract a minimal `EdgeDetailPlan` directly from `&SymbolStore` under its read lock,
/// avoiding any full-store cloning. Execute the disk scan lock-free via [`scan_edge_detail`].
pub fn prepare_edge_detail_from_store(
    store: &SymbolStore,
    from_id: &str,
    to_id: &str,
    scope: Option<&str>,
    depth: u8,
    folders: &[String],
) -> EdgeDetailPlan {
    let folders = normalize_scope(folders);
    let scope = normalize_single_scope(scope);
    let file_count = store.file_count();
    let effective_depth = pick_effective_depth_iter(
        (0..file_count).filter_map(|fid| store.file_path(fid)),
        &scope,
        &folders,
        depth,
    );

    let mut from_fids: Vec<u32> = Vec::new();
    let mut to_fids: HashSet<u32> = HashSet::new();
    for fid in 0..file_count {
        let Some(path) = store.file_path(fid) else {
            continue;
        };
        let internal = in_folders(path, &folders) && in_scope(path, &scope);
        let gid = if internal {
            internal_group(path, &scope, effective_depth, &folders).0
        } else {
            external_group(path, &scope, &folders).0
        };
        if gid == from_id {
            from_fids.push(fid as u32);
        }
        if gid == to_id {
            to_fids.insert(fid as u32);
        }
    }

    if from_fids.is_empty() || to_fids.is_empty() {
        return EdgeDetailPlan {
            from: from_id.to_owned(),
            to: to_id.to_owned(),
            scan_files: Vec::new(),
            all_paths: HashSet::new(),
            to_paths: HashSet::new(),
            to_sym_decls: HashMap::new(),
        };
    }

    let name_count = store.name_count();
    let mut decl_counts = vec![0u8; name_count];
    let mut to_decls_by_name: HashMap<u32, Vec<u32>> = HashMap::new();
    let max_decls = (MAX_DECL_FILES_FOR_SIGNAL + 2) as u8;
    store.for_each_file_decl(|fid, name_id, _is_callable| {
        let nid = name_id as usize;
        if let Some(c) = decl_counts.get_mut(nid) {
            if *c <= max_decls {
                // Approximate distinct file count; `to_decls_by_name` deduplicates below.
                *c = c.saturating_add(1);
            }
        }
        if to_fids.contains(&fid) {
            let entry = to_decls_by_name.entry(name_id).or_default();
            if entry.last().copied() != Some(fid) {
                entry.push(fid);
            }
        }
    });

    let from_fid_set: HashSet<u32> = from_fids.iter().copied().collect();
    let mut candidate_from_fids: HashSet<u32> = HashSet::new();
    let mut to_sym_decls: HashMap<String, Vec<String>> = HashMap::new();

    for (name_id, in_to) in to_decls_by_name {
        if decl_counts.get(name_id as usize).copied().unwrap_or(0) > max_decls {
            continue;
        }
        let Some(name) = store.name_str(name_id as usize) else {
            continue;
        };
        if name.len() < 2 {
            continue;
        }
        let Some(refs) = store.ref_files_of(name_id as usize) else {
            continue;
        };
        let mut matched = false;
        for &rfid in refs {
            if from_fid_set.contains(&rfid) {
                candidate_from_fids.insert(rfid);
                matched = true;
            }
        }
        if matched {
            let paths: Vec<String> = in_to
                .into_iter()
                .filter_map(|tfid| store.file_path(tfid as usize).map(str::to_owned))
                .collect();
            if !paths.is_empty() {
                to_sym_decls.insert(name.to_owned(), paths);
            }
        }
    }

    let mut scan_fids: Vec<u32> = if from_fids.len() <= 40 {
        from_fids
    } else {
        let mut list: Vec<u32> = candidate_from_fids.into_iter().collect();
        list.sort_unstable();
        list
    };
    scan_fids.truncate(MAX_DETAIL_SCAN_FILES);

    let scan_files: Vec<String> = scan_fids
        .into_iter()
        .filter_map(|fid| store.file_path(fid as usize).map(str::to_owned))
        .collect();
    let all_paths: HashSet<String> = (0..file_count)
        .filter_map(|fid| store.file_path(fid).map(str::to_owned))
        .collect();
    let to_paths: HashSet<String> = to_fids
        .into_iter()
        .filter_map(|fid| store.file_path(fid as usize).map(str::to_owned))
        .collect();

    EdgeDetailPlan {
        from: from_id.to_owned(),
        to: to_id.to_owned(),
        scan_files,
        all_paths,
        to_paths,
        to_sym_decls,
    }
}

/// Execute the disk scan for an [`EdgeDetailPlan`] outside the store lock.
pub fn scan_edge_detail(root: &str, plan: &EdgeDetailPlan) -> ModuleEdgeDetail {
    if plan.scan_files.is_empty() || plan.to_paths.is_empty() {
        return ModuleEdgeDetail {
            from: plan.from.clone(),
            to: plan.to.clone(),
            imports: Vec::new(),
            file_pairs: Vec::new(),
            scanned_files: 0,
        };
    }

    let all_paths_ref: HashSet<&str> = plan.all_paths.iter().map(String::as_str).collect();
    let mut imports: Vec<EdgeImport> = Vec::new();
    let mut pairs_map: BTreeMap<(String, String), PairEvidence> = BTreeMap::new();
    let mut scanned_files = 0usize;

    for from_path in &plan.scan_files {
        let Ok(bytes) = std::fs::read(Path::new(root).join(from_path)) else {
            continue;
        };
        scanned_files += 1;
        let text = String::from_utf8_lossy(&bytes);
        let ext = from_path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");

        // 1. Exact resolved imports from `from_path` into `to_id`.
        for spec in sites::import_spellings(ext, &text) {
            if let Some(target) = resolve_import(from_path, ext, &spec, &all_paths_ref) {
                if plan.to_paths.contains(&target) && target != *from_path {
                    imports.push(EdgeImport {
                        from_file: from_path.clone(),
                        to_file: target,
                        specifier: spec,
                    });
                }
            }
        }

        // 2. Exact call sites in `from_path` targeting symbols declared in `to_id`.
        if !plan.to_sym_decls.is_empty() {
            for site in sites::call_sites(ext, &text, &|name: &str| {
                plan.to_sym_decls.contains_key(name)
            }) {
                let Some(targets) = plan.to_sym_decls.get(site.name.as_str()) else {
                    continue;
                };
                for to_path in targets {
                    if to_path == from_path {
                        continue;
                    }
                    let entry = pairs_map
                        .entry((from_path.clone(), to_path.clone()))
                        .or_default();
                    entry.0.insert(site.name.clone(), ());
                    if entry.1.len() < MAX_SITES_PER_PAIR {
                        entry.1.push(EdgeCallSite {
                            symbol: site.name.clone(),
                            receiver: site.receiver.clone(),
                            line: site.line,
                            column: site.column,
                        });
                    }
                }
            }
        }
    }

    imports.sort_by(|a, b| {
        a.from_file
            .cmp(&b.from_file)
            .then_with(|| a.to_file.cmp(&b.to_file))
            .then_with(|| a.specifier.cmp(&b.specifier))
    });
    imports.dedup();

    let mut file_pairs: Vec<EdgeFilePair> = pairs_map
        .into_iter()
        .map(|((from_file, to_file), (syms, sites))| EdgeFilePair {
            from_file,
            to_file,
            symbols: syms.into_keys().collect(),
            sites,
        })
        .collect();
    file_pairs.sort_by(|a, b| {
        b.sites
            .len()
            .cmp(&a.sites.len())
            .then_with(|| b.symbols.len().cmp(&a.symbols.len()))
            .then_with(|| a.from_file.cmp(&b.from_file))
            .then_with(|| a.to_file.cmp(&b.to_file))
    });

    ModuleEdgeDetail {
        from: plan.from.clone(),
        to: plan.to.clone(),
        imports,
        file_pairs,
        scanned_files,
    }
}

/// On-demand L2 evidence for a single dependency edge `from → to` over a `StoreDependencyFacts`
/// snapshot (retained for compatibility and tests).
pub fn module_edge_detail(
    root: &str,
    facts: &StoreDependencyFacts,
    from_id: &str,
    to_id: &str,
    scope: Option<&str>,
    depth: u8,
    folders: &[String],
) -> ModuleEdgeDetail {
    let folders = normalize_scope(folders);
    let scope = normalize_single_scope(scope);
    let effective_depth = pick_effective_depth_iter(
        facts.files.iter().map(String::as_str),
        &scope,
        &folders,
        depth,
    );

    let mut from_fids: Vec<u32> = Vec::new();
    let mut to_fids: HashSet<u32> = HashSet::new();
    for (fid, path) in facts.files.iter().enumerate() {
        let internal = in_folders(path, &folders) && in_scope(path, &scope);
        let gid = if internal {
            internal_group(path, &scope, effective_depth, &folders).0
        } else {
            external_group(path, &scope, &folders).0
        };
        if gid == from_id {
            from_fids.push(fid as u32);
        }
        if gid == to_id {
            to_fids.insert(fid as u32);
        }
    }

    if from_fids.is_empty() || to_fids.is_empty() {
        return ModuleEdgeDetail {
            from: from_id.to_owned(),
            to: to_id.to_owned(),
            imports: Vec::new(),
            file_pairs: Vec::new(),
            scanned_files: 0,
        };
    }

    let from_fid_set: HashSet<u32> = from_fids.iter().copied().collect();
    let mut to_sym_decls: HashMap<String, Vec<String>> = HashMap::new();
    let mut candidate_from_fids: HashSet<u32> = HashSet::new();

    for (name_id, decls) in facts.decl_files.iter().enumerate() {
        if decls.is_empty() || decls.len() > MAX_DECL_FILES_FOR_SIGNAL + 2 {
            continue;
        }
        let in_to: Vec<u32> = decls
            .iter()
            .copied()
            .filter(|fid| to_fids.contains(fid))
            .collect();
        if in_to.is_empty() {
            continue;
        }
        let name = facts.names[name_id].as_str();
        if name.len() < 2 {
            continue;
        }
        if let Some(Some(refs)) = facts.ref_files.get(name_id) {
            let mut matched = false;
            for &rfid in refs {
                if from_fid_set.contains(&rfid) {
                    candidate_from_fids.insert(rfid);
                    matched = true;
                }
            }
            if matched {
                to_sym_decls.insert(
                    name.to_owned(),
                    in_to
                        .into_iter()
                        .map(|fid| facts.files[fid as usize].clone())
                        .collect(),
                );
            }
        }
    }

    let mut scan_fids: Vec<u32> = if from_fids.len() <= 40 {
        from_fids
    } else {
        let mut list: Vec<u32> = candidate_from_fids.into_iter().collect();
        list.sort_unstable();
        list
    };
    scan_fids.truncate(MAX_DETAIL_SCAN_FILES);

    let plan = EdgeDetailPlan {
        from: from_id.to_owned(),
        to: to_id.to_owned(),
        scan_files: scan_fids
            .into_iter()
            .map(|fid| facts.files[fid as usize].clone())
            .collect(),
        all_paths: facts.files.iter().cloned().collect(),
        to_paths: to_fids
            .into_iter()
            .map(|fid| facts.files[fid as usize].clone())
            .collect(),
        to_sym_decls,
    };
    scan_edge_detail(root, &plan)
}

/// Iterative Tarjan SCC over integer node indices; returns `(node_idx -> scc_id, cycles)`
/// where `cycles` holds every strongly-connected component with >= 2 members.
fn compute_sccs_idx(
    nodes: &[u32],
    edges: &[(u32, u32)],
) -> (HashMap<u32, usize>, Vec<Vec<u32>>) {
    let mut adj: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(u, v) in edges {
        adj.entry(u).or_default().push(v);
    }
    let mut index: HashMap<u32, usize> = HashMap::with_capacity(nodes.len());
    let mut lowlink: HashMap<u32, usize> = HashMap::with_capacity(nodes.len());
    let mut on_stack: HashSet<u32> = HashSet::with_capacity(nodes.len());
    let mut stack: Vec<u32> = Vec::new();
    let mut next_index = 0usize;
    let mut scc_of: HashMap<u32, usize> = HashMap::with_capacity(nodes.len());
    let mut scc_count = 0usize;
    let mut cycles: Vec<Vec<u32>> = Vec::new();

    for &start in nodes {
        if index.contains_key(&start) {
            continue;
        }
        let mut frames: Vec<(u32, usize)> = vec![(start, 0)];
        while let Some(&mut (node, ref mut cursor)) = frames.last_mut() {
            if *cursor == 0 {
                index.insert(node, next_index);
                lowlink.insert(node, next_index);
                next_index += 1;
                stack.push(node);
                on_stack.insert(node);
            }
            let children = adj.get(&node).map(Vec::as_slice).unwrap_or(&[]);
            let mut recursed = false;
            while *cursor < children.len() {
                let child = children[*cursor];
                *cursor += 1;
                if !index.contains_key(&child) {
                    frames.push((child, 0));
                    recursed = true;
                    break;
                } else if on_stack.contains(&child) {
                    let low = lowlink[&node].min(index[&child]);
                    lowlink.insert(node, low);
                }
            }
            if recursed {
                continue;
            }
            if lowlink[&node] == index[&node] {
                let mut component: Vec<u32> = Vec::new();
                while let Some(top) = stack.pop() {
                    on_stack.remove(&top);
                    scc_of.insert(top, scc_count);
                    component.push(top);
                    if top == node {
                        break;
                    }
                }
                if component.len() > 1 {
                    cycles.push(component);
                }
                scc_count += 1;
            }
            frames.pop();
            if let Some(&(parent, _)) = frames.last() {
                let low = lowlink[&parent].min(lowlink[&node]);
                lowlink.insert(parent, low);
            }
        }
    }
    (scc_of, cycles)
}

/// Longest-path topological layering on the condensed SCC DAG (Kahn's algorithm).
/// Layer 0 = nodes with no incoming dependencies from other SCCs (top-level callers).
fn compute_layers_idx(
    nodes: &[u32],
    edges: &[(u32, u32)],
    scc_of: &HashMap<u32, usize>,
) -> HashMap<u32, u32> {
    let scc_count = scc_of.values().copied().max().map_or(0, |m| m + 1);
    let mut dag_adj: Vec<Vec<usize>> = vec![Vec::new(); scc_count];
    let mut indeg: Vec<usize> = vec![0; scc_count];
    let mut seen_edges: HashSet<(usize, usize)> = HashSet::new();

    for &(u, v) in edges {
        let (Some(&su), Some(&sv)) = (scc_of.get(&u), scc_of.get(&v)) else {
            continue;
        };
        if su != sv && seen_edges.insert((su, sv)) {
            dag_adj[su].push(sv);
            indeg[sv] += 1;
        }
    }

    let mut queue: std::collections::VecDeque<usize> = (0..scc_count)
        .filter(|&s| indeg[s] == 0)
        .collect();
    let mut scc_layer: Vec<u32> = vec![0; scc_count];

    while let Some(u) = queue.pop_front() {
        let next_layer = scc_layer[u] + 1;
        for &v in &dag_adj[u] {
            if next_layer > scc_layer[v] {
                scc_layer[v] = next_layer;
            }
            indeg[v] = indeg[v].saturating_sub(1);
            if indeg[v] == 0 {
                queue.push_back(v);
            }
        }
    }

    let mut out = HashMap::with_capacity(nodes.len());
    for &node in nodes {
        let layer = scc_of
            .get(&node)
            .and_then(|&s| scc_layer.get(s).copied())
            .unwrap_or(0);
        out.insert(node, layer);
    }
    out
}

/// Export the current module overview as clean Mermaid `flowchart TD` source (capped for large repos).
pub fn overview_to_mermaid(nodes: &[ModuleNode], edges: &[ModuleEdge]) -> String {
    if nodes.is_empty() {
        return String::new();
    }
    let kept_nodes = &nodes[..nodes.len().min(MAX_MERMAID_NODES)];
    let id_of: HashMap<&str, String> = kept_nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id.as_str(), format!("M{i}")))
        .collect();
    let escape = |s: &str| s.replace('"', "'").replace('\n', " ");

    let mut out = String::from("flowchart TD\n");
    for (i, node) in kept_nodes.iter().enumerate() {
        let label = escape(&node.label);
        let meta = format!("{} files · {} syms", node.files, node.symbols);
        let cls = if node.in_cycle {
            ":::cycle"
        } else if node.kind == "external" {
            ":::ext"
        } else {
            ""
        };
        out.push_str(&format!("  M{i}[\"{label}<br/>{meta}\"]{cls}\n"));
    }
    let mut emitted_edges = 0usize;
    for edge in edges {
        if emitted_edges >= MAX_MERMAID_EDGES {
            break;
        }
        let (Some(from), Some(to)) = (id_of.get(edge.from.as_str()), id_of.get(edge.to.as_str()))
        else {
            continue;
        };
        if edge.is_cycle {
            out.push_str(&format!(
                "  {from} -.->|\"{} refs (cycle)\"| {to}\n",
                edge.weight
            ));
        } else {
            out.push_str(&format!("  {from} -->|\"{} refs\"| {to}\n", edge.weight));
        }
        emitted_edges += 1;
    }
    out.push_str("  classDef cycle stroke:#f14c4c,stroke-width:2px;\n");
    out.push_str("  classDef ext stroke-dasharray:4 3,opacity:0.8;\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ggs_index::symbols::store::SymbolStore;

    fn write(root: &Path, path: &str, text: &str) {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap_or(root)).unwrap();
        std::fs::write(file, text).unwrap();
    }

    fn store_of(root: &Path) -> SymbolStore {
        SymbolStore::build(&root.display().to_string(), 4, &|_, _| {}, &|| false).unwrap()
    }

    fn facts_of(root: &Path) -> StoreDependencyFacts {
        store_of(root).dependency_facts()
    }

    #[test]
    fn overview_aggregates_modules_detects_cycles_and_layers_dag() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "app/main.ts",
            "import { runCore } from '../core/engine';\nexport function startApp() { runCore(); }\n",
        );
        write(
            dir.path(),
            "core/engine.ts",
            "import { queryDb } from '../db/store';\nexport function runCore() { queryDb(); }\n",
        );
        write(
            dir.path(),
            "db/store.ts",
            "export function queryDb() { return 42; }\n",
        );
        let store = store_of(dir.path());
        let ov = module_overview_from_store(&store, None, 1, &[], ModuleEdgeTypes::default(), None);

        assert_eq!(ov.nodes.len(), 3);
        assert!(ov.cycles.is_empty());
        assert_eq!(ov.edges.len(), 2);
        assert!(ov.edges.iter().all(|e| e.call_refs > 0 && e.type_refs == 0 && e.base_refs == 0));
        let app = ov.nodes.iter().find(|n| n.id == "app").unwrap();
        let core = ov.nodes.iter().find(|n| n.id == "core").unwrap();
        let db = ov.nodes.iter().find(|n| n.id == "db").unwrap();
        assert!(app.layer < core.layer && core.layer < db.layer);
        assert_eq!(app.instability, 1.0);
        assert_eq!(db.instability, 0.0);
        assert!(ov.mermaid.contains("flowchart TD"));
    }

    #[test]
    fn default_edge_types_only_include_function_calls_and_filters_each_type() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "caller/entry.cpp",
            "#include \"../mod_import/header.h\"\nclass DerivedWidget : public BaseWidget {};\nvoid runEntry(SharedConfig cfg) { invokeHelper(); }\n",
        );
        write(
            dir.path(),
            "mod_call/helper.cpp",
            "void invokeHelper() {}\n",
        );
        write(
            dir.path(),
            "mod_type/config.cpp",
            "struct SharedConfig { int value; };\n",
        );
        write(
            dir.path(),
            "mod_base/base.cpp",
            "class BaseWidget {};\n",
        );
        write(
            dir.path(),
            "mod_import/header.h",
            "static const int MAGIC_NUM = 7;\n",
        );

        let store = store_of(dir.path());
        let root_str = dir.path().display().to_string();

        // 1. Default: calls only.
        let calls_only = module_overview_with_store(
            &store,
            Some(&root_str),
            None,
            1,
            &[],
            ModuleEdgeTypes::default(),
        );
        assert!(calls_only
            .edges
            .iter()
            .any(|e| e.from == "caller" && e.to == "mod_call" && e.call_refs > 0));
        assert!(!calls_only
            .edges
            .iter()
            .any(|e| e.from == "caller" && e.to == "mod_type"));
        assert!(!calls_only
            .edges
            .iter()
            .any(|e| e.from == "caller" && e.to == "mod_base"));
        assert!(!calls_only
            .edges
            .iter()
            .any(|e| e.from == "caller" && e.to == "mod_import"));

        // 2. typeRefs only.
        let types_only = module_overview_with_store(
            &store,
            Some(&root_str),
            None,
            1,
            &[],
            ModuleEdgeTypes {
                calls: false,
                type_refs: true,
                base_refs: false,
                imports: false,
            },
        );
        assert!(types_only
            .edges
            .iter()
            .any(|e| e.from == "caller" && e.to == "mod_type" && e.type_refs > 0));
        assert!(!types_only
            .edges
            .iter()
            .any(|e| e.from == "caller" && e.to == "mod_call"));

        // 3. baseRefs only.
        let bases_only = module_overview_with_store(
            &store,
            Some(&root_str),
            None,
            1,
            &[],
            ModuleEdgeTypes {
                calls: false,
                type_refs: false,
                base_refs: true,
                imports: false,
            },
        );
        assert!(bases_only
            .edges
            .iter()
            .any(|e| e.from == "caller" && e.to == "mod_base" && e.base_refs > 0));
        assert!(!bases_only
            .edges
            .iter()
            .any(|e| e.from == "caller" && e.to == "mod_call"));

        // 4. imports only (using TS relative imports for clean resolution).
        write(
            dir.path(),
            "ts_a/index.ts",
            "import { VAL } from '../ts_b/lib';\nexport const x = VAL;\n",
        );
        write(dir.path(), "ts_b/lib.ts", "export const VAL = 1;\n");
        let store2 = store_of(dir.path());
        let imports_only = module_overview_with_store(
            &store2,
            Some(&root_str),
            None,
            1,
            &[],
            ModuleEdgeTypes {
                calls: false,
                type_refs: false,
                base_refs: false,
                imports: true,
            },
        );
        assert!(imports_only
            .edges
            .iter()
            .any(|e| e.from == "ts_a" && e.to == "ts_b" && e.import_refs > 0));
        assert!(!imports_only
            .edges
            .iter()
            .any(|e| e.from == "caller" && e.to == "mod_call"));
    }

    #[test]
    fn overview_keeps_cycle_edges_and_marks_scc() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "alpha/a.rs",
            "pub fn alpha_work() { beta_work(); }\n",
        );
        write(
            dir.path(),
            "beta/b.rs",
            "pub fn beta_work() { alpha_work(); }\n",
        );
        let facts = facts_of(dir.path());
        let ov = module_overview(&facts, None, 1, &[]);

        assert_eq!(ov.cycles, vec![vec!["alpha".to_owned(), "beta".to_owned()]]);
        assert_eq!(ov.edges.len(), 2);
        assert!(ov.edges.iter().all(|e| e.is_cycle));
        assert!(ov.nodes.iter().all(|n| n.in_cycle));
    }

    #[test]
    fn drill_down_scope_exposes_external_context_and_edge_detail_finds_sites() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "src/ui/view.ts",
            "import { formatTitle } from '../util/fmt';\nexport function paintView() { return formatTitle('hi'); }\n",
        );
        write(
            dir.path(),
            "src/util/fmt.ts",
            "export function formatTitle(s: string) { return s.trim(); }\n",
        );
        let store = store_of(dir.path());
        // Drill into `src/ui` -> `src/util` appears as external context node.
        let ov = module_overview_from_store(
            &store,
            Some("src/ui"),
            1,
            &[],
            ModuleEdgeTypes::default(),
            None,
        );
        assert!(ov
            .nodes
            .iter()
            .any(|n| n.id == "src/ui/view.ts" && n.kind == "file"));
        assert!(ov
            .nodes
            .iter()
            .any(|n| n.id == "src/util" && n.kind == "external"));

        // Inspect the edge `src/ui/view.ts -> src/util` via zero-clone plan + lock-free scan.
        let plan =
            prepare_edge_detail_from_store(&store, "src/ui/view.ts", "src/util", Some("src/ui"), 1, &[]);
        let detail = scan_edge_detail(&dir.path().display().to_string(), &plan);
        assert_eq!(detail.imports.len(), 1);
        assert_eq!(detail.imports[0].to_file, "src/util/fmt.ts");
        assert_eq!(detail.file_pairs.len(), 1);
        assert_eq!(detail.file_pairs[0].sites[0].symbol, "formatTitle");
        assert_eq!(detail.file_pairs[0].sites[0].line, 1);
    }

    #[test]
    fn nested_folder_filter_keeps_internal_and_external_nodes_disjoint() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "src/features/a.ts",
            "import { helper } from '../platform/b';\nexport function runA() { return helper(); }\n",
        );
        write(
            dir.path(),
            "src/platform/b.ts",
            "export function helper() { return 1; }\n",
        );
        let facts = facts_of(dir.path());
        let ov = module_overview(&facts, None, 0, &["src/features".to_owned()]);
        assert!(ov
            .nodes
            .iter()
            .any(|n| n.id == "src/features" && n.kind == "module"));
        assert!(ov
            .nodes
            .iter()
            .any(|n| n.id == "src/platform" && n.kind == "external"));
        assert!(ov
            .edges
            .iter()
            .any(|e| e.from == "src/features" && e.to == "src/platform"));
    }

    #[test]
    fn c_cpp_and_python_without_real_calls_are_not_linked_in_module_overview() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "c_mod/engine.c",
            "static int internal_step(int x) { return x + 1; }\nint compute_value(int x) { return internal_step(x); }\n",
        );
        write(
            dir.path(),
            "cpp_mod/worker.cpp",
            "// compute_value mentioned in comment only, plus static name internal_step\nint worker_fn(int compute_value) { return compute_value + internal_step(1); }\n",
        );
        write(
            dir.path(),
            "py_mod/script.py",
            "def run_script():\n    \"\"\"compute_value() in docstring\"\"\"\n    # compute_value() in comment\n    return compute_value(1)\n",
        );

        let store = store_of(dir.path());
        let ov = module_overview_from_store(&store, None, 1, &[], ModuleEdgeTypes::default(), None);

        // Neither cpp_mod (parameter/comment + calling C static) nor py_mod (different language family)
        // may produce a false call edge to c_mod.
        assert!(
            ov.edges.is_empty(),
            "expected zero false cross-module call edges, got: {:?}",
            ov.edges
        );
    }
}
