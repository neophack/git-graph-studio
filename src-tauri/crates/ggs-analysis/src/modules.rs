//! Module Architecture Analysis (module 17): fast, progressive-disclosure module
//! dependency graphs built directly over the nine `project.ggs_*` volumes
//! ([`StoreDependencyFacts`] + [`ggs_index::symbols::sites`]), with zero dependency on
//! the legacy `AnalysisData` engine.
//!
//! Two-tier execution model:
//! 1. **L0 / L1 (`module_overview`) — pure in-memory, zero disk I/O**:
//!    Aggregates high-specificity symbol references and inheritance edges from
//!    `SymbolStore::dependency_facts()` into a scoped, depth-controlled module graph,
//!    runs iterative Tarjan SCC to highlight dependency cycles (never dropping back-edges),
//!    computes Robert C. Martin coupling metrics ($C_a$, $C_e$, Instability $I$), and
//!    assigns condensed-DAG topological layers.
//! 2. **L2 (`module_edge_detail`) — on-demand local file scan**:
//!    Only when inspecting a specific dependency edge `from → to`, reads the relevant
//!    source files on the `from` side and extracts exact resolved imports
//!    (`sites::import_spellings` + `imports::resolve_import`) and call sites
//!    (`sites::call_sites`), giving clickable `file:line` evidence without ever parsing
//!    the whole repository.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use serde::Serialize;

use ggs_index::symbols::sites;
use ggs_index::symbols::store::StoreDependencyFacts;

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
/// Maximum top files embedded on each module node for instant Inspector display.
const TOP_FILES_PER_NODE: usize = 8;
/// Maximum top symbol names embedded on each module edge.
const TOP_SYMBOLS_PER_EDGE: usize = 6;
/// Maximum `from`-side files read from disk when inspecting a single edge's detail.
const MAX_DETAIL_SCAN_FILES: usize = 120;
/// Maximum call sites returned per file pair in edge detail.
const MAX_SITES_PER_PAIR: usize = 30;
/// Auto-depth switches from depth 1 to depth 2 when depth 1 yields at most this many
/// modules and depth 2 stays within `AUTO_DEPTH2_MAX`.
const AUTO_DEPTH1_MIN: usize = 3;
const AUTO_DEPTH2_MAX: usize = 28;

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
    /// Combined dependency strength (`symbol_refs + base_refs * 2`).
    pub weight: usize,
    pub symbol_refs: usize,
    pub base_refs: usize,
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
fn internal_group(path: &str, scope: &str, depth: u8) -> (String, String, bool) {
    let rel = relative_to_scope(path, scope);
    if depth >= 3 {
        return (path.to_owned(), rel.to_owned(), true);
    }
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.len() == 1 {
        // Direct file sitting immediately inside `scope`.
        return (path.to_owned(), rel.to_owned(), true);
    }
    let dir_segments = parts.len() - 1;
    let take = (depth as usize).min(dir_segments);
    let rel_dir = parts[..take].join("/");
    let id = if scope.is_empty() {
        rel_dir.clone()
    } else {
        format!("{scope}/{rel_dir}")
    };
    (id, rel_dir, false)
}

/// Group an external file (outside `scope` or `folders`) into a concise external context
/// bucket: 1st segment by default, or 2nd segment if it shares the top-level directory
/// with `scope` (so drilling into `src/features` sees `src/platform` instead of `src`).
fn external_group(path: &str, scope: &str) -> (String, String) {
    let scope_top = scope.split('/').next().unwrap_or("");
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() == 1 {
        return ("".to_owned(), "(root)".to_owned());
    }
    let want = if !scope_top.is_empty() && parts[0] == scope_top && parts.len() >= 3 {
        2
    } else {
        1
    };
    let take = want.min(parts.len() - 1);
    let id = parts[..take].join("/");
    (id.clone(), id)
}

/// Choose the cleanest architectural depth when `requested == 0` (Auto).
fn pick_effective_depth(facts: &StoreDependencyFacts, scope: &str, folders: &[String], requested: u8) -> u8 {
    if requested > 0 {
        return requested.clamp(1, 3);
    }
    let mut d1: HashSet<String> = HashSet::new();
    let mut d2: HashSet<String> = HashSet::new();
    let mut has_subdirs = false;
    for path in &facts.files {
        if !in_folders(path, folders) || !in_scope(path, scope) {
            continue;
        }
        let rel = relative_to_scope(path, scope);
        if rel.contains('/') {
            has_subdirs = true;
        }
        d1.insert(internal_group(path, scope, 1).0);
        d2.insert(internal_group(path, scope, 2).0);
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

struct NodeAcc {
    label: String,
    kind: &'static str,
    files: Vec<(String, usize)>,
    symbols: usize,
    has_child_dirs: bool,
}

#[derive(Default)]
struct EdgeAcc {
    symbol_refs: usize,
    base_refs: usize,
    file_pairs: HashSet<(u32, u32)>,
    sym_counts: HashMap<u32, usize>,
}

/// Build the scoped, layered module architecture overview purely in memory from the
/// nine-volume store snapshot (`StoreDependencyFacts`). Zero disk I/O.
pub fn module_overview(
    facts: &StoreDependencyFacts,
    scope: Option<&str>,
    depth: u8,
    folders: &[String],
) -> ModuleOverview {
    let folders = normalize_scope(folders);
    let scope = normalize_single_scope(scope);
    let effective_depth = pick_effective_depth(facts, &scope, &folders, depth);
    let breadcrumbs: Vec<String> = if scope.is_empty() {
        Vec::new()
    } else {
        scope.split('/').map(str::to_owned).collect()
    };

    // Map every file_id -> (node_id, is_internal) and accumulate per-node file/symbol counts.
    let mut file_node: Vec<(String, bool)> = Vec::with_capacity(facts.files.len());
    let mut nodes_acc: BTreeMap<String, NodeAcc> = BTreeMap::new();
    let mut total_files = 0usize;
    let mut total_symbols = 0usize;

    for (fid, path) in facts.files.iter().enumerate() {
        let sym_count = facts.symbol_counts.get(fid).copied().unwrap_or(0) as usize;
        let internal = in_folders(path, &folders) && in_scope(path, &scope);
        if internal {
            total_files += 1;
            total_symbols += sym_count;
            let (id, label, is_file) = internal_group(path, &scope, effective_depth);
            let entry = nodes_acc.entry(id.clone()).or_insert_with(|| NodeAcc {
                label,
                kind: if is_file { "file" } else { "module" },
                files: Vec::new(),
                symbols: 0,
                has_child_dirs: false,
            });
            entry.files.push((path.clone(), sym_count));
            entry.symbols += sym_count;
            if !is_file {
                // Check if this file sits in a deeper directory or if multiple files exist.
                let prefix = format!("{id}/");
                if let Some(rest) = path.strip_prefix(&prefix) {
                    if rest.contains('/') {
                        entry.has_child_dirs = true;
                    }
                }
            }
            file_node.push((id, true));
        } else {
            let (id, label) = external_group(path, &scope);
            let entry = nodes_acc.entry(id.clone()).or_insert_with(|| NodeAcc {
                label,
                kind: "external",
                files: Vec::new(),
                symbols: 0,
                has_child_dirs: false,
            });
            entry.files.push((path.clone(), sym_count));
            entry.symbols += sym_count;
            file_node.push((id, false));
        }
    }

    // Aggregate cross-module dependencies from high-specificity symbol refs + base edges.
    let mut edge_acc: HashMap<(String, String), EdgeAcc> = HashMap::new();
    let total_repo_files = facts.files.len();

    for (name_id, decls) in facts.decl_files.iter().enumerate() {
        if decls.is_empty() || decls.len() > MAX_DECL_FILES_FOR_SIGNAL {
            continue;
        }
        let name = &facts.names[name_id];
        if name.len() < 2 {
            continue;
        }
        let Some(Some(refs)) = facts.ref_files.get(name_id) else {
            continue;
        };
        // Skip ubiquitous tokens that appear in > 60% of a non-trivial repository.
        if total_repo_files >= 20 && refs.len() * 10 > total_repo_files * 6 {
            continue;
        }
        for &caller_fid in refs {
            let Some((from_id, from_internal)) = file_node.get(caller_fid as usize) else {
                continue;
            };
            for &callee_fid in decls {
                if caller_fid == callee_fid {
                    continue;
                }
                let Some((to_id, to_internal)) = file_node.get(callee_fid as usize) else {
                    continue;
                };
                if from_id == to_id || (!*from_internal && !*to_internal) {
                    continue;
                }
                let entry = edge_acc
                    .entry((from_id.clone(), to_id.clone()))
                    .or_default();
                if entry.file_pairs.insert((caller_fid, callee_fid)) {
                    // Track distinct file pair; always count distinct symbol reference below.
                }
                entry.symbol_refs += 1;
                *entry.sym_counts.entry(name_id as u32).or_default() += 1;
            }
        }
    }

    // Overlay inheritance / implementation base edges (strong structural signal).
    for &(derived_fid, base_name_id) in &facts.base_edges {
        let Some(decls) = facts.decl_files.get(base_name_id as usize) else {
            continue;
        };
        if decls.is_empty() || decls.len() > MAX_DECL_FILES_FOR_BASE {
            continue;
        }
        let Some((from_id, from_internal)) = file_node.get(derived_fid as usize) else {
            continue;
        };
        for &base_fid in decls {
            if derived_fid == base_fid {
                continue;
            }
            let Some((to_id, to_internal)) = file_node.get(base_fid as usize) else {
                continue;
            };
            if from_id == to_id || (!*from_internal && !*to_internal) {
                continue;
            }
            let entry = edge_acc
                .entry((from_id.clone(), to_id.clone()))
                .or_default();
            entry.file_pairs.insert((derived_fid, base_fid));
            entry.base_refs += 1;
            *entry.sym_counts.entry(base_name_id).or_default() += 2;
        }
    }

    let total_edges = edge_acc.len();

    // Determine which external nodes survive (only connected ones, capped to top N by weight).
    let mut external_weight: HashMap<String, usize> = HashMap::new();
    for ((from, to), acc) in &edge_acc {
        let w = acc.symbol_refs + acc.base_refs * 2;
        if nodes_acc.get(from).is_some_and(|n| n.kind == "external") {
            *external_weight.entry(from.clone()).or_default() += w;
        }
        if nodes_acc.get(to).is_some_and(|n| n.kind == "external") {
            *external_weight.entry(to.clone()).or_default() += w;
        }
    }
    let mut ext_ranked: Vec<(String, usize)> = external_weight.into_iter().collect();
    ext_ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let kept_external: HashSet<String> = ext_ranked
        .into_iter()
        .take(MAX_EXTERNAL_NODES)
        .map(|(id, _)| id)
        .collect();

    // Keep all internal nodes + the top connected external context nodes.
    let kept_ids: HashSet<String> = nodes_acc
        .iter()
        .filter(|(id, acc)| acc.kind != "external" || kept_external.contains(*id))
        .map(|(id, _)| id.clone())
        .collect();

    // Filter edges to kept nodes and build edge list.
    let mut raw_edges: Vec<ModuleEdge> = edge_acc
        .into_iter()
        .filter(|((from, to), _)| kept_ids.contains(from) && kept_ids.contains(to))
        .map(|((from, to), acc)| {
            let mut syms: Vec<(u32, usize)> = acc.sym_counts.into_iter().collect();
            syms.sort_by(|a, b| {
                b.1.cmp(&a.1)
                    .then_with(|| facts.names[a.0 as usize].cmp(&facts.names[b.0 as usize]))
            });
            let top_symbols: Vec<String> = syms
                .into_iter()
                .take(TOP_SYMBOLS_PER_EDGE)
                .map(|(nid, _)| facts.names[nid as usize].clone())
                .collect();
            let weight = acc.symbol_refs + acc.base_refs * 2;
            ModuleEdge {
                id: format!("{from}→{to}"),
                from,
                to,
                weight,
                symbol_refs: acc.symbol_refs,
                base_refs: acc.base_refs,
                file_pairs: acc.file_pairs.len(),
                top_symbols,
                is_cycle: false,
            }
        })
        .collect();
    raw_edges.sort_by(|a, b| {
        b.weight
            .cmp(&a.weight)
            .then_with(|| a.from.cmp(&b.from))
            .then_with(|| a.to.cmp(&b.to))
    });

    // Iterative Tarjan SCC on internal nodes to detect dependency cycles.
    let internal_ids: Vec<String> = nodes_acc
        .iter()
        .filter(|(_, acc)| acc.kind != "external")
        .map(|(id, _)| id.clone())
        .collect();
    let internal_set: HashSet<&str> = internal_ids.iter().map(String::as_str).collect();
    // Owned endpoints: the pairs must not borrow `raw_edges` — the cycle pass below
    // takes `&mut raw_edges` between the two computations that read these pairs.
    let internal_edge_pairs: Vec<(String, String)> = raw_edges
        .iter()
        .filter(|e| internal_set.contains(e.from.as_str()) && internal_set.contains(e.to.as_str()))
        .map(|e| (e.from.clone(), e.to.clone()))
        .collect();

    let (scc_of, cycles) = compute_sccs(&internal_ids, &internal_edge_pairs);
    let cycle_nodes: HashSet<&str> = cycles
        .iter()
        .flat_map(|c| c.iter().map(String::as_str))
        .collect();

    for edge in &mut raw_edges {
        if let (Some(&sa), Some(&sb)) = (
            scc_of.get(edge.from.as_str()),
            scc_of.get(edge.to.as_str()),
        ) {
            if sa == sb && cycle_nodes.contains(edge.from.as_str()) {
                edge.is_cycle = true;
            }
        }
    }

    // Compute topological layers on the condensed SCC DAG (internal nodes).
    let internal_layers = compute_layers(&internal_ids, &internal_edge_pairs, &scc_of);

    // Compute per-node fan-in / fan-out.
    let mut fan_in: HashMap<&str, usize> = HashMap::new();
    let mut fan_out: HashMap<&str, usize> = HashMap::new();
    for edge in &raw_edges {
        *fan_out.entry(edge.from.as_str()).or_default() += 1;
        *fan_in.entry(edge.to.as_str()).or_default() += 1;
    }

    // Shift internal layers by +1 if there are inbound-only external callers so external
    // callers cleanly sit on layer 0 and external callees sit on the bottom layer.
    let has_ext_inbound = kept_external
        .iter()
        .any(|id| fan_out.get(id.as_str()).copied().unwrap_or(0) > 0);
    let layer_shift = u32::from(has_ext_inbound);
    let max_internal_layer = internal_layers
        .values()
        .copied()
        .max()
        .unwrap_or(0)
        + layer_shift;

    let mut nodes: Vec<ModuleNode> = Vec::with_capacity(kept_ids.len());
    for (id, mut acc) in nodes_acc {
        if !kept_ids.contains(&id) {
            continue;
        }
        acc.files
            .sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let file_count = acc.files.len();
        let top_files = acc
            .files
            .into_iter()
            .take(TOP_FILES_PER_NODE)
            .map(|(path, symbols)| ModuleFileSummary { path, symbols })
            .collect();
        let ca = fan_in.get(id.as_str()).copied().unwrap_or(0);
        let ce = fan_out.get(id.as_str()).copied().unwrap_or(0);
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
            internal_layers.get(id.as_str()).copied().unwrap_or(0) + layer_shift
        };
        let expandable = acc.kind == "module" && (acc.has_child_dirs || file_count > 0);
        let in_cycle = cycle_nodes.contains(id.as_str());
        nodes.push(ModuleNode {
            id,
            label: acc.label,
            kind: acc.kind.to_owned(),
            expandable,
            files: file_count,
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

    let mermaid = overview_to_mermaid(&nodes, &raw_edges);

    ModuleOverview {
        scope,
        depth: effective_depth,
        breadcrumbs,
        nodes,
        edges: raw_edges,
        cycles,
        total_files,
        total_symbols,
        total_edges,
        mermaid,
    }
}

/// One file pair's L2 evidence: the shared symbols and the capped call-site list.
type PairEvidence = (BTreeMap<String, ()>, Vec<EdgeCallSite>);

/// On-demand L2 evidence for a single dependency edge `from → to`: reads only the
/// relevant `from`-side files on disk and extracts exact resolved imports and call sites
/// targeting symbols declared in `to`.
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
    let effective_depth = pick_effective_depth(facts, &scope, &folders, depth);

    let mut from_fids: Vec<u32> = Vec::new();
    let mut to_fids: HashSet<u32> = HashSet::new();
    for (fid, path) in facts.files.iter().enumerate() {
        let internal = in_folders(path, &folders) && in_scope(path, &scope);
        let gid = if internal {
            internal_group(path, &scope, effective_depth).0
        } else {
            external_group(path, &scope).0
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

    // Build symbol -> declaring to_fids map for symbols declared inside `to_id`, and
    // narrow which `from_fids` actually mention any of them.
    let from_fid_set: HashSet<u32> = from_fids.iter().copied().collect();
    let mut to_sym_decls: HashMap<&str, Vec<u32>> = HashMap::new();
    let mut candidate_from_fids: HashSet<u32> = HashSet::new();
    let mut wanted_names: HashSet<String> = HashSet::new();

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
                to_sym_decls.insert(name, in_to);
                wanted_names.insert(name.to_owned());
            }
        }
    }

    // If the `from` module is small, include all its files so direct imports (even
    // re-exports without call sites) are also captured.
    let mut scan_fids: Vec<u32> = if from_fids.len() <= 40 {
        from_fids
    } else {
        let mut list: Vec<u32> = candidate_from_fids.into_iter().collect();
        list.sort_unstable();
        list
    };
    scan_fids.truncate(MAX_DETAIL_SCAN_FILES);

    let all_paths: HashSet<&str> = facts.files.iter().map(String::as_str).collect();
    let to_paths: HashSet<&str> = to_fids
        .iter()
        .map(|&fid| facts.files[fid as usize].as_str())
        .collect();

    let mut imports: Vec<EdgeImport> = Vec::new();
    let mut pairs_map: BTreeMap<(String, String), PairEvidence> = BTreeMap::new();
    let mut scanned_files = 0usize;

    for fid in scan_fids {
        let from_path = &facts.files[fid as usize];
        let Ok(bytes) = std::fs::read(Path::new(root).join(from_path)) else {
            continue;
        };
        scanned_files += 1;
        let text = String::from_utf8_lossy(&bytes);
        let ext = from_path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");

        // 1. Exact resolved imports from `from_path` into `to_id`.
        for spec in sites::import_spellings(ext, &text) {
            if let Some(target) = resolve_import(from_path, ext, &spec, &all_paths) {
                if to_paths.contains(target.as_str()) && target != *from_path {
                    imports.push(EdgeImport {
                        from_file: from_path.clone(),
                        to_file: target,
                        specifier: spec,
                    });
                }
            }
        }

        // 2. Exact call sites in `from_path` targeting symbols declared in `to_id`.
        if !wanted_names.is_empty() {
            for site in sites::call_sites(ext, &text, &|name: &str| {
                wanted_names.contains(name)
            }) {
                let Some(targets) = to_sym_decls.get(site.name.as_str()) else {
                    continue;
                };
                for &tfid in targets {
                    let to_path = &facts.files[tfid as usize];
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
        from: from_id.to_owned(),
        to: to_id.to_owned(),
        imports,
        file_pairs,
        scanned_files,
    }
}

/// Iterative Tarjan SCC over module ids; returns `(node -> scc_id, cycles)` where
/// `cycles` holds every strongly-connected component with >= 2 members.
fn compute_sccs<'a>(
    nodes: &'a [String],
    edges: &'a [(String, String)],
) -> (HashMap<&'a str, usize>, Vec<Vec<String>>) {
    let mut adj: HashMap<&'a str, Vec<&'a str>> = HashMap::new();
    for (u, v) in edges {
        adj.entry(u.as_str()).or_default().push(v.as_str());
    }
    let mut index: HashMap<&'a str, usize> = HashMap::new();
    let mut lowlink: HashMap<&'a str, usize> = HashMap::new();
    let mut on_stack: HashSet<&'a str> = HashSet::new();
    let mut stack: Vec<&'a str> = Vec::new();
    let mut next_index = 0usize;
    let mut scc_of: HashMap<&'a str, usize> = HashMap::new();
    let mut scc_count = 0usize;
    let mut cycles: Vec<Vec<String>> = Vec::new();

    for start in nodes {
        let start = start.as_str();
        if index.contains_key(start) {
            continue;
        }
        let mut frames: Vec<(&'a str, usize)> = vec![(start, 0)];
        while let Some(&mut (node, ref mut cursor)) = frames.last_mut() {
            if *cursor == 0 {
                index.insert(node, next_index);
                lowlink.insert(node, next_index);
                next_index += 1;
                stack.push(node);
                on_stack.insert(node);
            }
            let children = adj.get(node).map(Vec::as_slice).unwrap_or(&[]);
            let mut recursed = false;
            while *cursor < children.len() {
                let child = children[*cursor];
                *cursor += 1;
                if !index.contains_key(child) {
                    frames.push((child, 0));
                    recursed = true;
                    break;
                } else if on_stack.contains(child) {
                    let low = lowlink[node].min(index[child]);
                    lowlink.insert(node, low);
                }
            }
            if recursed {
                continue;
            }
            if lowlink[node] == index[node] {
                let mut component: Vec<&'a str> = Vec::new();
                while let Some(top) = stack.pop() {
                    on_stack.remove(top);
                    scc_of.insert(top, scc_count);
                    component.push(top);
                    if top == node {
                        break;
                    }
                }
                if component.len() > 1 {
                    let mut cycle: Vec<String> =
                        component.into_iter().map(str::to_owned).collect();
                    cycle.sort();
                    cycles.push(cycle);
                }
                scc_count += 1;
            }
            frames.pop();
            if let Some(&(parent, _)) = frames.last() {
                let low = lowlink[parent].min(lowlink[node]);
                lowlink.insert(parent, low);
            }
        }
    }
    cycles.sort();
    (scc_of, cycles)
}

/// Longest-path topological layering on the condensed SCC DAG (Kahn's algorithm).
/// Layer 0 = nodes with no incoming dependencies from other SCCs (top-level callers).
fn compute_layers<'a>(
    nodes: &'a [String],
    edges: &[(String, String)],
    scc_of: &HashMap<&'a str, usize>,
) -> HashMap<&'a str, u32> {
    let scc_count = scc_of.values().copied().max().map_or(0, |m| m + 1);
    let mut dag_adj: Vec<Vec<usize>> = vec![Vec::new(); scc_count];
    let mut indeg: Vec<usize> = vec![0; scc_count];
    let mut seen_edges: HashSet<(usize, usize)> = HashSet::new();

    for (u, v) in edges {
        let (Some(&su), Some(&sv)) = (scc_of.get(u.as_str()), scc_of.get(v.as_str())) else {
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
    for node in nodes {
        let layer = scc_of
            .get(node.as_str())
            .and_then(|&s| scc_layer.get(s).copied())
            .unwrap_or(0);
        out.insert(node.as_str(), layer);
    }
    out
}

/// Export the current module overview as clean Mermaid `flowchart TD` source.
pub fn overview_to_mermaid(nodes: &[ModuleNode], edges: &[ModuleEdge]) -> String {
    if nodes.is_empty() {
        return String::new();
    }
    let id_of: HashMap<&str, String> = nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id.as_str(), format!("M{i}")))
        .collect();
    let escape = |s: &str| s.replace('"', "'").replace('\n', " ");

    let mut out = String::from("flowchart TD\n");
    for (i, node) in nodes.iter().enumerate() {
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
    for edge in edges {
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

    fn facts_of(root: &Path) -> StoreDependencyFacts {
        let store =
            SymbolStore::build(&root.display().to_string(), 4, &|_, _| {}, &|| false).unwrap();
        store.dependency_facts()
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
        let facts = facts_of(dir.path());
        let ov = module_overview(&facts, None, 1, &[]);

        assert_eq!(ov.nodes.len(), 3);
        assert!(ov.cycles.is_empty());
        assert_eq!(ov.edges.len(), 2);
        let app = ov.nodes.iter().find(|n| n.id == "app").unwrap();
        let core = ov.nodes.iter().find(|n| n.id == "core").unwrap();
        let db = ov.nodes.iter().find(|n| n.id == "db").unwrap();
        assert!(app.layer < core.layer && core.layer < db.layer);
        assert_eq!(app.instability, 1.0);
        assert_eq!(db.instability, 0.0);
        assert!(ov.mermaid.contains("flowchart TD"));
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
        let facts = facts_of(dir.path());
        // Drill into `src/ui` -> `src/util` appears as external context node.
        let ov = module_overview(&facts, Some("src/ui"), 1, &[]);
        assert!(ov.nodes.iter().any(|n| n.id == "src/ui/view.ts" && n.kind == "file"));
        assert!(ov.nodes.iter().any(|n| n.id == "src/util" && n.kind == "external"));

        // Inspect the edge `src/ui/view.ts -> src/util` on demand.
        let detail = module_edge_detail(
            &dir.path().display().to_string(),
            &facts,
            "src/ui/view.ts",
            "src/util",
            Some("src/ui"),
            1,
            &[],
        );
        assert_eq!(detail.imports.len(), 1);
        assert_eq!(detail.imports[0].to_file, "src/util/fmt.ts");
        assert_eq!(detail.file_pairs.len(), 1);
        assert_eq!(detail.file_pairs[0].sites[0].symbol, "formatTitle");
        assert_eq!(detail.file_pairs[0].sites[0].line, 1);
    }
}
