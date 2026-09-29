//! The Module Analysis drawing (module 17) — the workspace's cross-file calls as a
//! gitdiagram-style architecture diagram, computed here in the backend (the heavy
//! analysis belongs in Rust, plan §3.4). The backend decides WHAT the diagram is —
//! the model follows gitdiagram's own schema and caps (at most 10 groups — deeper
//! areas roll up to the depth that fits, an area too small to be a subsystem folds
//! into its parent, and what still does not fit draws unboxed, its `groupId:
//! null` — 34 blocks, 48 arrows, no block fanning past eight), the busiest
//! architecture files become two-line cards
//! (the name over the bracketed directory below its box, gitdiagram's
//! `Component<br/>[file.ts]` shape) each carrying its area's tone class — and
//! emits the diagram as mermaid `flowchart TD` source with gitdiagram's tone
//! classDefs verbatim. Curation is gitdiagram's, made deterministic: vendored
//! and test trees stay off the drawing (they build the project, they are not its
//! architecture), and the blocks cluster by locality before the caps prune.
//! The page feeds that source to mermaid itself (the same renderer, the same
//! ELK layered layout and spacing gitdiagram initializes), so the layout is
//! ELK's — nodes never overlap — and the copy-the-source export is the exact
//! source rendered.

use std::collections::HashMap;

use serde::Serialize;

use super::modules::{module_of, FileDep, ModuleGraph};

/// The three caps of gitdiagram's diagram schema: groups (its `MAX_GRAPH_GROUPS`),
/// blocks (`MAX_GRAPH_NODES`) and arrows (`MAX_GRAPH_EDGES`).
const MAX_GROUPS: usize = 10;
const MAX_NODES: usize = 34;
const MAX_EDGES: usize = 48;
/// How many arrows one block may fan out and take in — a call-volume hub would
/// otherwise hang twenty off a single card and the structure reads as one bundle
/// (gitdiagram's curated graphs top out around eight per node).
const MAX_FAN_OUT: u32 = 8;
const MAX_FAN_IN: u32 = 8;
/// Blocks one area may contribute — gitdiagram's groups hold four to nine
/// components; without the balance one deep directory floods the canvas.
const MAX_PER_AREA: usize = 9;
/// The candidate pool the curation scores over (the busiest files by traffic,
/// before locality rebalancing picks the final blocks).
const CANDIDATE_POOL: usize = 120;

/// How deep a group box's directory path may run before the roll-up starts folding
/// areas into their parents.
const MAX_GROUP_DEPTH: usize = 3;

/// The smallest box worth drawing — an area the fold leaves below this many
/// files merges into its parent area (gitdiagram's groups hold four to nine
/// components; a one-card box reads as clutter, not a subsystem).
const MIN_PER_AREA: usize = 3;

/// Directory components that mark trees a checkout carries beside the project's
/// own code: vendored crates, minified bundles, node packages. They build the
/// app; they are not its architecture, and their dense internal traffic crowds
/// the project's own modules off the canvas (gitdiagram's curation picks the
/// repository's components — a vendored tree is nobody's component).
const VENDOR_DIRS: [&str; 5] = ["vendor", "vendors", "node_modules", "third_party", "thirdparty"];
/// Directory components that hold code about the project rather than of it.
const ANCILLARY_DIRS: [&str; 7] = ["tests", "__tests__", "spec", "specs", "examples", "benches", "fixtures"];

/// Whether a file belongs to the architecture the drawing curates: nothing under
/// a vendored, test, example or bench tree, and no test module by name. The
/// calls of what this rules out stay in the tree page and the counts — only the
/// drawing is curated. A focus overrides the rule: the file the user named
/// decides its own neighbourhood, wherever it lives.
fn is_architecture_code(path: &str) -> bool {
    let mut parts = path.split('/');
    let base = parts.next_back().unwrap_or("");
    let stem = base.split('.').next().unwrap_or(base);
    let test_tree = parts.any(|part| VENDOR_DIRS.contains(&part) || ANCILLARY_DIRS.contains(&part));
    let test_name = stem.starts_with("test_")
        || stem.ends_with("_test")
        || base.contains(".test.")
        || base.contains(".spec.");
    !(test_tree || test_name)
}

/// The pastel tone palette's size (gitdiagram's six: blue, amber, mint, rose,
/// indigo, teal); the neutral gray behind it is the ungrouped overflow's.
const TONES: u32 = 6;

/// gitdiagram's own tone classes, by slot — the names its compiled diagrams
/// carry, so a paste of the exported source renders with its palette intact.
const TONE_CLASSES: [(&str, (&str, &str, &str)); 7] = [
    ("toneBlue", ("#dbeafe", "#2563eb", "#172554")),
    ("toneAmber", ("#fef3c7", "#d97706", "#78350f")),
    ("toneMint", ("#dcfce7", "#16a34a", "#14532d")),
    ("toneRose", ("#ffe4e6", "#e11d48", "#881337")),
    ("toneIndigo", ("#e0e7ff", "#4f46e5", "#312e81")),
    ("toneTeal", ("#ccfbf1", "#0f766e", "#134e4a")),
    ("toneNeutral", ("#f8fafc", "#334155", "#0f172a")),
];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramNode {
    pub path: String,
    /// The file's base name — the card's first line (the second, the bracketed
    /// directory, rides the mermaid label).
    pub label: String,
    /// The area (directory, rolled up to the depth that fits the group cap)
    /// whose subgraph holds the block; `None` draws unboxed — root files,
    /// trivial areas folded past their last parent, and the overflow of a
    /// workspace with more areas than the cap (gitdiagram's `groupId: null`).
    pub module: Option<String>,
    pub calls_in: u32,
    pub calls_out: u32,
    /// The area's pastel tone slot (gitdiagram's `toneBlue` &c.); `TONES` is the
    /// neutral gray of the ungrouped overflow.
    pub tone: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramEdge {
    /// `from→to` — unique among the drawn pairs.
    pub id: String,
    pub from: String,
    pub to: String,
    pub calls: u32,
    /// A cycle's back edge — mermaid's dashed `-.->` (gitdiagram's fallback arrow).
    pub dashed: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleDiagram {
    pub nodes: Vec<DiagramNode>,
    pub edges: Vec<DiagramEdge>,
    /// Files / dependencies the caps left out, busiest first.
    pub dropped_files: usize,
    pub dropped_edges: usize,
    /// The diagram as mermaid `flowchart TD` source — the copy-the-source export.
    pub mermaid: String,
}

/// A file's base name — the block's label.
fn basename(path: &str) -> &str {
    match path.rfind('/') {
        Some(at) => &path[at + 1..],
        None => path,
    }
}

/// The area a file groups under at a directory depth: the first `depth` segments of
/// its directory. Root files group under "" at every depth.
fn group_at(path: &str, depth: usize) -> String {
    let dir = module_of(path);
    if dir.is_empty() {
        return String::new();
    }
    dir.split('/').take(depth).collect::<Vec<_>>().join("/")
}

/// The group keys of the given files: the deepest directory depth (to
/// `MAX_GROUP_DEPTH`) whose distinct areas fit the group cap — the roll-up that
/// keeps a deep workspace's boxes readable the way gitdiagram's curated areas do
/// — then two folds that keep every box reading as a subsystem: root files
/// never box (the workspace root is not a subsystem — gitdiagram's
/// `groupId: null`), and an area holding fewer than `MIN_PER_AREA` files folds
/// into its parent area, up to the root, where it draws unboxed. A workspace
/// with more areas than the cap even after the roll-up keeps its busiest boxed
/// and the rest unboxed, so the cap always holds. Pure and deterministic.
fn group_keys(paths: &[&str]) -> Vec<Option<String>> {
    let keys_for = |depth: usize| {
        paths
            .iter()
            .map(|p| Some(group_at(p, depth)))
            .collect::<Vec<_>>()
    };
    let distinct = |keys: &[Option<String>]| {
        keys.iter()
            .filter(|key| key.is_some())
            .collect::<std::collections::HashSet<&Option<String>>>()
            .len()
    };
    let mut depth = MAX_GROUP_DEPTH;
    let mut keys = keys_for(depth);
    while depth > 1 && distinct(&keys) > MAX_GROUPS {
        depth -= 1;
        keys = keys_for(depth);
    }
    if distinct(&keys) > MAX_GROUPS {
        let mut counts: HashMap<&str, usize> = HashMap::new();
        for key in keys.iter().flatten() {
            *counts.entry(key.as_str()).or_default() += 1;
        }
        let mut ranked: Vec<(&str, usize)> = counts.into_iter().collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        let keep: std::collections::HashSet<&str> = ranked
            .into_iter()
            .take(MAX_GROUPS)
            .map(|(name, _)| name)
            .collect();
        keys = keys
            .iter()
            .map(|key| {
                key.as_ref()
                    .filter(|name| keep.contains(name.as_str()))
                    .cloned()
            })
            .collect();
    }
    // The workspace root is not a subsystem: root files draw unboxed.
    let mut keys: Vec<Option<String>> = keys
        .into_iter()
        .map(|key| key.filter(|name| !name.is_empty()))
        .collect();
    // Fold trivial boxes into their parents until every box is a subsystem. The
    // deepest small area goes first (its parent may then carry enough on its
    // own); every fold strictly lowers the areas' total depth, so this settles.
    loop {
        let mut counts: HashMap<String, usize> = HashMap::new();
        for key in keys.iter().flatten() {
            *counts.entry((*key).clone()).or_default() += 1;
        }
        let fold = counts
            .iter()
            .filter(|(_, &count)| count < MIN_PER_AREA)
            .map(|(name, _)| (name.matches('/').count(), name.as_str()))
            .min_by_key(|(depth, name)| (*depth, *name))
            .map(|(_, name)| name.to_owned());
        let Some(fold) = fold else { break };
        let parent = match fold.rfind('/') {
            Some(at) => fold[..at].to_owned(),
            None => String::new(),
        };
        keys = keys
            .into_iter()
            .map(|key| {
                if key.as_deref() != Some(fold.as_str()) {
                    key
                } else if parent.is_empty() {
                    None
                } else {
                    Some(parent.clone())
                }
            })
            .collect();
    }
    keys
}

/// Whether a file spells part of the query (case-insensitive) — the drawing's
/// filter narrows to the blocks whose own path matches. Symbol-level matches
/// (a call site naming the query) stay the tree page's filter: there they list
/// their sites, here they would refill the canvas with every pair that rides
/// on one, and a filtered drawing that does not shrink reads as unfiltered.
fn path_matches(path: &str, filter: &str) -> bool {
    filter.is_empty() || path.to_lowercase().contains(filter)
}

/// Build the Module Analysis diagram of a module graph: the filter and the focus
/// (a file whose neighbourhood the drawing isolates) narrow the pairs first, then
/// the busiest files become blocks, their dependencies arrows, and the layered
/// pass places everything. Pure function — the same graph, focus and filter always
/// lay out identically.
pub fn module_diagram(graph: &ModuleGraph, focus: Option<&str>, filter: &str) -> ModuleDiagram {
    let filter = filter.trim().to_lowercase();
    let focus = focus.filter(|path| !path.is_empty());
    // The drawing's filter narrows to the files that spell the query: a pair
    // survives while BOTH endpoints match, so the drawing shrinks with the
    // filter. A query that isolates one file (nothing else spells it) would
    // draw nothing, so the strict view falls back to that file's pairs — the
    // focus's neighbourhood, on the filter's terms. Symbol-level matches (a
    // call site naming the query) stay the tree page's filter: there they list
    // their sites, here they would refill the canvas with every pair that rides
    // on one, and a filtered drawing that does not shrink reads as unfiltered.
    let strict_matches = |dep: &FileDep| {
        path_matches(&dep.from, &filter) && path_matches(&dep.to, &filter)
    };
    let loose_matches = |dep: &FileDep| {
        path_matches(&dep.from, &filter) || path_matches(&dep.to, &filter)
    };
    let pick = |pair_matches: &dyn Fn(&FileDep) -> bool| {
        graph
            .file_edges
            .iter()
            .filter(|dep| pair_matches(dep))
            .filter(|dep| match focus {
                Some(path) => dep.from == path || dep.to == path,
                None => true,
            })
            // The drawing curates the architecture: vendored and test trees stay
            // off it (their calls remain in the tree page and the counts). A
            // named focus overrides the rule — the user picked the
            // neighbourhood, wherever it lives.
            .filter(|dep| {
                focus.is_some()
                    || (is_architecture_code(&dep.from) && is_architecture_code(&dep.to))
            })
            .collect::<Vec<&FileDep>>()
    };
    let mut deps = pick(&strict_matches);
    if !filter.is_empty() && deps.is_empty() {
        deps = pick(&loose_matches);
    }
    // Traffic per file over the surviving pairs, then the busiest files as blocks —
    // ties break by path so the layout never depends on hash order.
    let mut traffic: HashMap<&str, (u32, u32)> = HashMap::new();
    for dep in &deps {
        traffic.entry(dep.from.as_str()).or_default().1 += dep.calls;
        traffic.entry(dep.to.as_str()).or_default().0 += dep.calls;
    }
    let mut ranked: Vec<(&str, (u32, u32))> = traffic.into_iter().collect();
    ranked.sort_by(|a, b| {
        (b.1 .0 + b.1 .1)
            .cmp(&(a.1 .0 + a.1 .1))
            .then_with(|| a.0.cmp(b.0))
    });
    let total_files = ranked.len();
    if ranked.is_empty() {
        return ModuleDiagram {
            nodes: Vec::new(),
            edges: Vec::new(),
            dropped_files: 0,
            dropped_edges: 0,
            mermaid: "flowchart TD\n".to_owned(),
        };
    }
    // gitdiagram's curation, deterministic: score the busiest pool by how much of
    // a file's traffic stays local (its own area and the areas it touches), then
    // pick the winners under a per-area balance — coherent clusters instead of a
    // heap of cross-boundary hubs.
    let pool: Vec<(&str, (u32, u32))> = ranked.into_iter().take(CANDIDATE_POOL).collect();
    let pool_set: Vec<&str> = pool.iter().map(|(path, _)| *path).collect();
    // One area assignment serves the whole curation — locality scoring, the
    // per-area balance and the boxes the drawing names — so the granularity the
    // selection balanced over is exactly the granularity that renders.
    let key_of: HashMap<&str, Option<String>> = pool
        .iter()
        .map(|(path, _)| *path)
        .zip(group_keys(&pool_set))
        .collect();
    let area_of: HashMap<&str, &str> = key_of
        .iter()
        .map(|(path, key)| (*path, key.as_deref().unwrap_or("")))
        .collect();
    let mut adjacent: HashMap<&str, std::collections::HashSet<&str>> = HashMap::new();
    for dep in &deps {
        let (Some(&from_area), Some(&to_area)) =
            (area_of.get(dep.from.as_str()), area_of.get(dep.to.as_str()))
        else {
            continue;
        };
        if from_area != to_area {
            adjacent.entry(from_area).or_default().insert(to_area);
            adjacent.entry(to_area).or_default().insert(from_area);
        }
    }
    let local_traffic = |path: &str| -> (u32, u32) {
        let own = area_of.get(path).copied().unwrap_or("");
        let neighbours = adjacent.get(own);
        let mut local = 0u32;
        let mut all = 0u32;
        for dep in &deps {
            let end = if dep.from == path {
                dep.to.as_str()
            } else if dep.to == path {
                dep.from.as_str()
            } else {
                continue;
            };
            all += dep.calls;
            let other = area_of.get(end).copied().unwrap_or("");
            if other == own || neighbours.map(|set| set.contains(other)).unwrap_or(false) {
                local += dep.calls;
            }
        }
        (local, all)
    };
    let mut scored: Vec<(u64, &str, (u32, u32))> = pool
        .iter()
        .map(|(path, counts)| {
            let (local, all) = local_traffic(path);
            let ratio = if all > 0 {
                local as f64 / all as f64
            } else {
                0.0
            };
            let weight = ((counts.0 + counts.1) as f64 * (0.35 + 0.65 * ratio)) as u64;
            (weight, *path, *counts)
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
    let mut per_area: HashMap<&str, usize> = HashMap::new();
    let mut kept: Vec<(&str, (u32, u32))> = Vec::new();
    for (_, path, counts) in scored {
        if kept.len() >= MAX_NODES {
            break;
        }
        // The balance caps a box, not the unboxed cards — root files and folded
        // overflow draw beside the boxes, and only the node cap limits them.
        if let Some(area) = key_of.get(path).and_then(|key| key.as_deref()) {
            let filled = per_area.get(area).copied().unwrap_or(0);
            if filled >= MAX_PER_AREA {
                continue;
            }
            per_area.insert(area, filled + 1);
        }
        kept.push((path, counts));
    }
    // Deterministic order: the busiest kept file first (the pool's traffic order).
    let rank_of: HashMap<&str, usize> = pool
        .iter()
        .enumerate()
        .map(|(index, (path, _))| (*path, index))
        .collect();
    kept.sort_by_key(|(path, _)| rank_of.get(*path).copied().unwrap_or(usize::MAX));
    let kept_set: Vec<&str> = kept.iter().map(|(path, _)| *path).collect();
    let both_kept = |dep: &FileDep| {
        kept_set.contains(&dep.from.as_str()) && kept_set.contains(&dep.to.as_str())
    };

    let keys: Vec<Option<String>> = kept
        .iter()
        .map(|(path, _)| key_of.get(*path).cloned().flatten())
        .collect();
    // The areas in name order, one tone each; the ungrouped overflow shares the
    // neutral gray behind the palette.
    let tone_of: HashMap<&str, u32> = keys
        .iter()
        .flatten()
        .collect::<std::collections::BTreeSet<&String>>()
        .into_iter()
        .enumerate()
        .map(|(index, name)| (name.as_str(), index as u32 % TONES))
        .collect();
    let nodes: Vec<DiagramNode> = kept
        .iter()
        .zip(keys.iter())
        .map(|((path, (calls_in, calls_out)), module)| DiagramNode {
            path: (*path).to_owned(),
            label: basename(path).to_owned(),
            module: module.clone(),
            calls_in: *calls_in,
            calls_out: *calls_out,
            tone: module.as_deref().map_or(TONES, |area| tone_of[area]),
        })
        .collect();
    let index_of: HashMap<&str, usize> = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| (node.path.as_str(), index))
        .collect();

    // The arrows: weight order (the graph's own calls-first order), but a block
    // fans out at most `MAX_FAN_OUT` and takes in at most `MAX_FAN_IN` — the rest
    // of a hub's traffic stays in the counts and the tree, off the drawing. The
    // pairs that close a cycle stay off too: the forward edges already tell the
    // story, a DAG layers cleanly (no arrow routing around the whole canvas), and
    // the cycles themselves are the Import Graph page's subject.
    let candidates: Vec<(&FileDep, bool)> = {
        let kept_pairs: Vec<&FileDep> = deps.iter().copied().filter(|dep| both_kept(dep)).collect();
        let mut slot: HashMap<&str, usize> = HashMap::new();
        for dep in &kept_pairs {
            for path in [dep.from.as_str(), dep.to.as_str()] {
                let next = slot.len();
                slot.entry(path).or_insert(next);
            }
        }
        let mut back = vec![false; kept_pairs.len()];
        {
            let mut edge_adj: Vec<Vec<usize>> = vec![Vec::new(); kept_pairs.len() * 2];
            for (at, dep) in kept_pairs.iter().enumerate() {
                let from = slot[dep.from.as_str()];
                edge_adj[from].push(at);
            }
            let mut state = vec![0u8; kept_pairs.len() * 2];
            fn mark(
                edge_adj: &[Vec<usize>],
                kept_pairs: &[&FileDep],
                slot: &HashMap<&str, usize>,
                state: &mut [u8],
                back: &mut [bool],
                node: usize,
            ) {
                state[node] = 1;
                for &edge in &edge_adj[node] {
                    let to = slot[kept_pairs[edge].to.as_str()];
                    match state[to] {
                        1 => back[edge] = true,
                        0 => mark(edge_adj, kept_pairs, slot, state, back, to),
                        _ => {}
                    }
                }
                state[node] = 2;
            }
            for node in 0..kept_pairs.len() * 2 {
                if state[node] == 0 {
                    mark(&edge_adj, &kept_pairs, &slot, &mut state, &mut back, node);
                }
            }
        }
        kept_pairs
            .iter()
            .enumerate()
            .map(|(at, &dep)| (dep, back[at]))
            .collect()
    };
    // The arrows read locality-first (gitdiagram's edges flow between related
    // components): same-area pairs before adjacent areas before anything far,
    // calls breaking ties — then the degree caps and the edge cap do the pruning.
    let area_distance = |dep: &FileDep| -> u32 {
        match (area_of.get(dep.from.as_str()), area_of.get(dep.to.as_str())) {
            (Some(&from), Some(&to)) if from == to => 0,
            (Some(&from), Some(&to))
                if adjacent
                    .get(from)
                    .is_some_and(|set| set.contains(to)) =>
            {
                1
            }
            _ => 2,
        }
    };
    let mut ordered: Vec<(&FileDep, bool)> = candidates;
    ordered.sort_by(|(a, _), (b, _)| {
        area_distance(a)
            .cmp(&area_distance(b))
            .then_with(|| b.calls.cmp(&a.calls))
            .then_with(|| (a.from.as_str(), a.to.as_str()).cmp(&(b.from.as_str(), b.to.as_str())))
    });
    let mut fan_out: HashMap<&str, u32> = HashMap::new();
    let mut fan_in: HashMap<&str, u32> = HashMap::new();
    let mut drawn: Vec<&FileDep> = Vec::new();
    let mut considered = 0usize;
    for (dep, dashed) in ordered {
        if dashed {
            continue;
        }
        considered += 1;
        if drawn.len() >= MAX_EDGES {
            continue;
        }
        let out = fan_out.get(dep.from.as_str()).copied().unwrap_or(0);
        let inn = fan_in.get(dep.to.as_str()).copied().unwrap_or(0);
        if out >= MAX_FAN_OUT || inn >= MAX_FAN_IN {
            continue;
        }
        *fan_out.entry(dep.from.as_str()).or_default() += 1;
        *fan_in.entry(dep.to.as_str()).or_default() += 1;
        drawn.push(dep);
    }
    let dropped_files = total_files - kept.len();
    let dropped_edges = considered - drawn.len();
    let edges: Vec<DiagramEdge> = drawn
        .iter()
        .map(|dep| DiagramEdge {
            id: format!("{}→{}", dep.from, dep.to),
            from: dep.from.clone(),
            to: dep.to.clone(),
            calls: dep.calls,
            dashed: false,
        })
        .collect();
    let mermaid = mermaid_source(&nodes, &index_of, &edges);
    ModuleDiagram {
        nodes,
        edges,
        dropped_files,
        dropped_edges,
        mermaid,
    }
}

/// A label mermaid carries safely inside its quotes.
fn mermaid_text(text: &str) -> String {
    text.chars()
        .filter(|c| *c >= ' ')
        .collect::<String>()
        .replace('\\', "\\\\")
        .replace('"', "&quot;")
}

/// A directory shown past this many characters cuts on separators from the left
/// — the tail components name where the file lives; the head is usually shared
/// with its box.
const DIR_SHOWN_MAX: usize = 28;

/// A directory short enough to read on the card: whole when it fits, else the
/// tail past as many whole components as 28 characters carry.
fn clip_dir(dir: &str) -> String {
    let mut rest = dir;
    while rest.chars().count() > DIR_SHOWN_MAX {
        match rest.find('/') {
            Some(at) => rest = &rest[at + 1..],
            None => break,
        }
    }
    if rest.len() == dir.len() {
        dir.to_owned()
    } else {
        format!("…{rest}")
    }
}

/// The diagram as mermaid source: one subgraph per area, its blocks inside, every
/// arrow labelled with its call count — the source a paste into any mermaid
/// renderer redraws (gitdiagram's copy-the-diagram export).
fn mermaid_source(
    nodes: &[DiagramNode],
    index_of: &HashMap<&str, usize>,
    edges: &[DiagramEdge],
) -> String {
    let label_of = |node: &DiagramNode| {
        // gitdiagram's two-line card: the name over the bracketed directory —
        // here the part of the directory the file's box does not already name,
        // so a card inside its own area keeps one line and a deeper file shows
        // just what is below the box (`store.rs<br/>[symbols]`).
        let dir = module_of(&node.path);
        let below = match node.module.as_deref() {
            Some(area) if dir == area => None,
            Some(area) if dir.strip_prefix(area).is_some_and(|rest| rest.starts_with('/')) => {
                Some(dir[area.len() + 1..].to_owned())
            }
            _ => (!dir.is_empty()).then(|| dir.to_owned()),
        };
        match below {
            None => mermaid_text(&node.label),
            Some(shown) => format!(
                "{}<br/>[{}]",
                mermaid_text(&node.label),
                mermaid_text(&clip_dir(&shown))
            ),
        }
    };
    let mut out = String::from("flowchart TD\n");
    for node in nodes.iter().filter(|node| node.module.is_none()) {
        let index = index_of[node.path.as_str()];
        let label = label_of(node);
        out.push_str(&format!("  N{index}[\"{label}\"]\n"));
    }
    let mut areas: Vec<&str> = Vec::new();
    for node in nodes.iter().filter_map(|node| node.module.as_deref()) {
        if !areas.contains(&node) {
            areas.push(node);
        }
    }
    for (at, &area) in areas.iter().enumerate() {
        let label = mermaid_text(area);
        out.push_str(&format!("  subgraph G{at}[\"{label}\"]\n"));
        for node in nodes
            .iter()
            .filter(|node| node.module.as_deref() == Some(area))
        {
            let index = index_of[node.path.as_str()];
            let label = label_of(node);
            out.push_str(&format!("    N{index}[\"{label}\"]\n"));
        }
        out.push_str("  end\n");
    }
    for edge in edges {
        let from = index_of[edge.from.as_str()];
        let to = index_of[edge.to.as_str()];
        let arrow = if edge.dashed { "-.->" } else { "-->" };
        out.push_str(&format!(
            "  N{from} {arrow}|\"{} calls\"| N{to}\n",
            edge.calls
        ));
    }
    // gitdiagram's own tone palette, verbatim — its class names and colours — so
    // a paste into any mermaid renderer redraws the same pastel cards, and the
    // assignments batch one line per tone as its compiler writes them.
    for (name, (fill, stroke, colour)) in TONE_CLASSES.iter() {
        out.push_str(&format!(
            "  classDef {name} fill:{fill},stroke:{stroke},stroke-width:1.5px,color:{colour}\n"
        ));
    }
    for (slot, (name, _)) in TONE_CLASSES.iter().enumerate() {
        let ids: Vec<String> = nodes
            .iter()
            .enumerate()
            .filter(|(_, node)| node.tone as usize == slot)
            .map(|(index, _)| format!("N{index}"))
            .collect();
        if !ids.is_empty() {
            out.push_str(&format!("  class {} {}\n", ids.join(","), name));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::modules::{CallSiteRow, ModuleGraph, ModuleInfo};

    fn dep(from: &str, to: &str, calls: u32, sites: &[(&str, &str, usize)]) -> FileDep {
        FileDep {
            from: from.to_owned(),
            to: to.to_owned(),
            calls,
            sites: sites
                .iter()
                .map(|(from, to, line)| CallSiteRow {
                    from: from.to_string(),
                    to: to.to_string(),
                    line: *line,
                    column: 0,
                })
                .collect(),
        }
    }

    fn graph(modules: &[(&str, usize, usize)], file_edges: Vec<FileDep>) -> ModuleGraph {
        ModuleGraph {
            modules: modules
                .iter()
                .map(|(name, files, symbols)| ModuleInfo {
                    name: name.to_string(),
                    files: *files as u32,
                    symbols: *symbols as u32,
                })
                .collect(),
            edges: Vec::new(),
            file_edges,
            total_calls: 0,
            total_file_edges: 0,
        }
    }

    fn chain_graph() -> ModuleGraph {
        graph(
            &[("", 1, 1), ("src", 2, 3)],
            vec![
                dep("top.rs", "src/a.rs", 2, &[("boot", "main", 1)]),
                dep("src/a.rs", "src/ui.rs", 5, &[("main", "render", 3)]),
            ],
        )
    }

    #[test]
    fn the_model_ranks_traffic_and_small_workspaces_draw_unboxed() {
        let diagram = module_diagram(&chain_graph(), None, "");
        // The busiest files lead: a.rs (7 calls of traffic) before ui.rs (5) before top.rs (2).
        let order: Vec<&str> = diagram.nodes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(order, ["src/a.rs", "src/ui.rs", "top.rs"]);
        let a = &diagram.nodes[0];
        assert_eq!((a.calls_in, a.calls_out), (2, 5));
        // Two files under `src` are not a subsystem — the box folds away and the
        // cards draw unboxed (gitdiagram's `groupId: null`), in the neutral tone.
        assert_eq!(a.module, None);
        assert!(diagram.nodes.iter().all(|node| node.module.is_none()));
        assert!(diagram.nodes.iter().all(|node| node.tone == TONES));
        assert!(!diagram.mermaid.contains("subgraph"));
        assert_eq!(
            diagram
                .edges
                .iter()
                .map(|edge| edge.id.as_str())
                .collect::<Vec<_>>(),
            // The arrows read locality-first, calls breaking ties — the busier
            // same-area pair leads.
            ["src/a.rs→src/ui.rs", "top.rs→src/a.rs"]
        );
        assert_eq!(diagram.dropped_files, 0);
        assert_eq!(diagram.dropped_edges, 0);
    }

    #[test]
    fn real_areas_box_tone_and_label_their_cards() {
        // Two areas big enough to be subsystems, one deeper directory inside
        // `src` too small to box, and a root file.
        let file_edges = vec![
            dep("top.rs", "src/a.rs", 2, &[]),
            dep("src/a.rs", "src/b.rs", 5, &[]),
            dep("src/b.rs", "src/c.rs", 5, &[]),
            dep("src/c.rs", "src/a.rs", 1, &[]),
            dep("src/a.rs", "src/ui/d.rs", 4, &[]),
            dep("src/a.rs", "lib/x.rs", 3, &[]),
            dep("lib/x.rs", "lib/y.rs", 5, &[]),
            dep("lib/y.rs", "lib/z.rs", 5, &[]),
        ];
        let diagram = module_diagram(&graph(&[("", 1, 1), ("src", 5, 5), ("lib", 3, 3)], file_edges), None, "");
        let mut boxed: Vec<&str> = diagram
            .nodes
            .iter()
            .filter_map(|node| node.module.as_deref())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        boxed.sort_unstable();
        assert_eq!(boxed, ["lib", "src"]);
        // `src` carries ui's card folded in; the tones follow the area name order.
        let src = &diagram.nodes.iter().find(|n| n.path == "src/a.rs").unwrap();
        assert_eq!(src.module.as_deref(), Some("src"));
        let lib = &diagram.nodes.iter().find(|n| n.path == "lib/x.rs").unwrap();
        assert_eq!(lib.module.as_deref(), Some("lib"));
        assert_ne!(src.tone, lib.tone);
        assert!(src.tone < TONES && lib.tone < TONES);
        // The deeper file's card brackets only what the box does not name.
        assert!(diagram.mermaid.contains("d.rs<br/>[ui]"));
        // A file directly in its box keeps one line; the root file draws unboxed.
        assert!(diagram.mermaid.contains("[\"b.rs\"]"));
        assert!(diagram.mermaid.contains("[\"top.rs\"]"));
    }

    #[test]
    fn the_cycles_back_edge_stays_off_the_drawing() {
        // a.rs → b.rs → c.rs → a.rs: the first two arrows tell the story; the pair
        // that closes the cycle would route around the whole layout, so it stays
        // off (the Import Graph page is where cycles are the subject).
        let diagram = module_diagram(
            &graph(
                &[("", 3, 3)],
                vec![
                    dep("a.rs", "b.rs", 1, &[]),
                    dep("b.rs", "c.rs", 1, &[]),
                    dep("c.rs", "a.rs", 1, &[]),
                ],
            ),
            None,
            "",
        );
        let ids: Vec<&str> = diagram.edges.iter().map(|edge| edge.id.as_str()).collect();
        assert_eq!(ids, ["a.rs→b.rs", "b.rs→c.rs"]);
        // The back edge is policy-excluded, not cap-dropped — the dropped count
        // stays about what the caps squeezed out.
        assert_eq!(diagram.dropped_edges, 0);
        assert!(
            !diagram.mermaid.contains("-.->"),
            "no dashed arrows in the source"
        );
    }

    #[test]
    fn caps_keep_the_busiest_files_and_count_the_rest() {
        let mut file_edges = Vec::new();
        for index in 0..60 {
            file_edges.push(dep(&format!("f{index:02}.rs"), "hub.rs", 1, &[]));
        }
        let diagram = module_diagram(&graph(&[("", 61, 61)], file_edges), None, "");
        assert_eq!(diagram.nodes.len(), MAX_NODES);
        assert_eq!(diagram.dropped_files, 61 - MAX_NODES);
        assert!(diagram.nodes.iter().any(|node| node.path == "hub.rs"));
        // The star's hub takes at most MAX_FAN_IN arrows — the rest of its traffic
        // stays in the counts (dropped_edges) and the tree, off the drawing.
        assert_eq!(diagram.edges.len(), MAX_FAN_IN as usize);
        assert_eq!(diagram.dropped_edges, (MAX_NODES - 1) - MAX_FAN_IN as usize);
        let ins: u32 = diagram.edges.iter().map(|edge| edge.calls).sum();
        assert_eq!(ins, MAX_FAN_IN as usize as u32);
    }

    #[test]
    fn the_fan_out_cap_keeps_a_hub_legible_and_keeps_the_heaviest() {
        // One file calling twenty others: only its top-eight calls draw, and they
        // are the highest-call ones (the candidates arrive calls-first).
        let mut file_edges = Vec::new();
        for target in 0..20 {
            file_edges.push(dep(
                "hub.rs",
                &format!("t{target:02}.rs"),
                (20 - target) as u32,
                &[],
            ));
        }
        let diagram = module_diagram(&graph(&[("", 21, 21)], file_edges), None, "");
        assert_eq!(diagram.edges.len(), MAX_FAN_OUT as usize);
        let targets: Vec<&str> = diagram.edges.iter().map(|edge| edge.to.as_str()).collect();
        assert_eq!(
            targets,
            ["t00.rs", "t01.rs", "t02.rs", "t03.rs", "t04.rs", "t05.rs", "t06.rs", "t07.rs"]
        );
        assert_eq!(diagram.dropped_edges, 20 - MAX_FAN_OUT as usize);
    }

    #[test]
    fn no_block_exceeds_the_degree_caps() {
        let mut file_edges = Vec::new();
        // A dense committee: every file calls every other.
        for a in 0..12 {
            for b in 0..12 {
                if a != b {
                    file_edges.push(dep(&format!("f{a:02}.rs"), &format!("f{b:02}.rs"), 1, &[]));
                }
            }
        }
        let diagram = module_diagram(&graph(&[("", 12, 12)], file_edges), None, "");
        let mut out: HashMap<String, u32> = HashMap::new();
        let mut inn: HashMap<String, u32> = HashMap::new();
        for edge in &diagram.edges {
            *out.entry(edge.from.clone()).or_default() += 1;
            *inn.entry(edge.to.clone()).or_default() += 1;
        }
        assert!(out.values().all(|&degree| degree <= MAX_FAN_OUT));
        assert!(inn.values().all(|&degree| degree <= MAX_FAN_IN));
    }

    #[test]
    fn the_edge_cap_counts_what_it_leaves_out() {
        // Two areas, every card of one calling every card of the other: the caps
        // (nine cards per box, forty-eight arrows) leave the rest counted.
        let mut file_edges = Vec::new();
        for a in 0..10 {
            for b in 0..10 {
                file_edges.push(dep(&format!("m/a{a}.rs"), &format!("n/b{b}.rs"), 1, &[]));
            }
        }
        let diagram = module_diagram(&graph(&[("m", 10, 10), ("n", 10, 10)], file_edges), None, "");
        assert_eq!(diagram.nodes.len(), MAX_PER_AREA * 2);
        let considered = MAX_PER_AREA * MAX_PER_AREA;
        assert_eq!(diagram.edges.len(), MAX_EDGES);
        assert_eq!(diagram.dropped_edges, considered - MAX_EDGES);
    }

    #[test]
    fn trivial_areas_fold_into_their_parent_box() {
        // `src/ui` carries two files — not a subsystem; its cards fold into the
        // `src` box, bracketed by what the box does not already name.
        let file_edges = vec![
            dep("src/a.rs", "src/b.rs", 3, &[]),
            dep("src/b.rs", "src/c.rs", 3, &[]),
            dep("src/c.rs", "src/a.rs", 1, &[]),
            dep("src/ui/x.rs", "src/ui/y.rs", 2, &[]),
            dep("src/a.rs", "lib/l.rs", 1, &[]),
            dep("lib/l.rs", "lib/m.rs", 3, &[]),
            dep("lib/m.rs", "lib/n.rs", 3, &[]),
        ];
        let diagram = module_diagram(
            &graph(&[("src", 5, 5), ("src/ui", 2, 2), ("lib", 3, 3)], file_edges),
            None,
            "",
        );
        assert!(
            !diagram.mermaid.contains("[\"src/ui\"]"),
            "the two-file area never boxes"
        );
        let boxed: Vec<&str> = diagram
            .nodes
            .iter()
            .filter_map(|n| n.module.as_deref())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        assert_eq!(boxed.len(), 2, "src and lib box, src/ui folded away");
        assert!(diagram.mermaid.contains("x.rs<br/>[ui]"));
        assert!(diagram.mermaid.contains("y.rs<br/>[ui]"));
    }

    #[test]
    fn areas_roll_up_until_they_fit_the_group_cap() {
        // Twelve areas of six files each, the last two the busiest: the deepest
        // cut names twelve subgraphs, the roll-up folds to one segment per area,
        // and the two that still do not fit the ten-group cap draw unboxed
        // (gitdiagram's `groupId: null`) — while every box that remains is big
        // enough to be a subsystem.
        let mut file_edges = Vec::new();
        for area in 0..12 {
            let dir = format!("a{area:02}/deep");
            let calls = if area >= 10 { 5 } else { 1 };
            for from in 0..6 {
                for to in (from + 1)..6 {
                    file_edges.push(dep(
                        &format!("{dir}/f{from}.rs"),
                        &format!("{dir}/f{to}.rs"),
                        calls,
                        &[],
                    ));
                }
            }
        }
        let diagram = module_diagram(&graph(&[], file_edges), None, "");
        let subgraphs = diagram.mermaid.matches("subgraph G").count();
        assert!(subgraphs <= MAX_GROUPS, "rolled up to {subgraphs} groups");
        let mut per_area: HashMap<&str, usize> = HashMap::new();
        for node in &diagram.nodes {
            if let Some(area) = node.module.as_deref() {
                *per_area.entry(area).or_default() += 1;
            }
        }
        assert_eq!(subgraphs, per_area.len());
        assert!(
            per_area.values().all(|&count| count >= MIN_PER_AREA),
            "no trivial boxes: {per_area:?}"
        );
        assert!(
            diagram.nodes.iter().any(|n| n.module.is_none()),
            "the overflow draws unboxed"
        );
    }

    #[test]
    fn focus_and_filter_narrow_the_pairs() {
        // Focus keeps only the pairs the file touches.
        let focused = module_diagram(&chain_graph(), Some("src/a.rs"), "");
        let mut paths: Vec<&str> = focused.nodes.iter().map(|n| n.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, ["src/a.rs", "src/ui.rs", "top.rs"]);
        // The drawing's filter narrows to the files that spell the query — the
        // pair that crosses out of the matching set drops with its endpoint.
        let by_path = module_diagram(&chain_graph(), None, "src");
        let paths: Vec<&str> = by_path.nodes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(paths, ["src/a.rs", "src/ui.rs"]);
        assert_eq!(
            by_path.edges.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["src/a.rs→src/ui.rs"]
        );
        // A query no other file spells falls back to that file's neighbourhood
        // (the focus's view, on the filter's terms) instead of drawing nothing.
        let lone = module_diagram(&chain_graph(), None, "top");
        let mut paths: Vec<&str> = lone.nodes.iter().map(|n| n.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, ["src/a.rs", "top.rs"]);
        assert_eq!(
            lone.edges.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["top.rs→src/a.rs"]
        );
        // A symbol-named query matches no path — the tree is where symbols list
        // their sites; nothing matches: the empty diagram, mermaid header only.
        let none = module_diagram(&chain_graph(), None, "zzz");
        assert!(none.nodes.is_empty());
        assert_eq!(none.mermaid, "flowchart TD\n");
    }

    #[test]
    fn the_source_carries_gitdiagrams_shapes() {
        // The same shape gitdiagram's own compiler writes: two-line cards in
        // named subgraphs, call-count arrows, its tone classDefs under its own
        // class names, the assignments batched one line per tone — and never a
        // "(root)" box.
        let file_edges = vec![
            dep("top.rs", "src/a.rs", 2, &[]),
            dep("src/a.rs", "src/b.rs", 5, &[]),
            dep("src/b.rs", "src/c.rs", 5, &[]),
            dep("src/a.rs", "lib/x.rs", 3, &[]),
            dep("lib/x.rs", "lib/y.rs", 5, &[]),
            dep("lib/y.rs", "lib/z.rs", 5, &[]),
        ];
        let diagram = module_diagram(
            &graph(&[("", 1, 1), ("src", 3, 3), ("lib", 3, 3)], file_edges),
            None,
            "",
        );
        let mermaid = &diagram.mermaid;
        assert!(mermaid.starts_with("flowchart TD\n"));
        // The boxes appear in first-appearance order — the busiest file's area
        // first (lib/y.rs edges the traffic ranking).
        assert!(mermaid.contains("subgraph G0[\"lib\"]"));
        assert!(mermaid.contains("subgraph G1[\"src\"]"));
        assert!(!mermaid.contains("(root)"));
        // The arrows carry their call counts.
        assert!(mermaid.contains("|\"5 calls\"|"));
        assert!(mermaid.contains("|\"2 calls\"|"));
        // gitdiagram's tone palette, under its own class names, batched one
        // line per tone that carries cards.
        assert!(mermaid.contains("classDef toneBlue fill:#dbeafe,stroke:#2563eb"));
        assert!(mermaid.contains("classDef toneNeutral fill:#f8fafc,stroke:#334155"));
        let batched = mermaid
            .lines()
            .filter(|line| line.starts_with("  class "))
            .collect::<Vec<_>>();
        let tones_used: std::collections::HashSet<u32> =
            diagram.nodes.iter().map(|node| node.tone).collect();
        assert_eq!(batched.len(), tones_used.len());
        assert!(
            batched.iter().all(|line| line
                .split_whitespace()
                .nth(2)
                .is_some_and(|name| TONE_CLASSES.iter().any(|&(tone, _)| tone == name))),
            "every assignment names one of gitdiagram's tones"
        );
    }

    #[test]
    fn vendored_and_test_trees_stay_off_the_drawing() {
        // The drawing curates the architecture: vendored crates, minified
        // bundles and test trees build or verify the project, they are not its
        // components, and their traffic never reaches the canvas.
        assert!(!is_architecture_code("src-tauri/vendor/boa-engine/src/lib.rs"));
        assert!(!is_architecture_code("static/vendor/markdown-it.min.js"));
        assert!(!is_architecture_code("src-tauri/tests/node_runtime.rs"));
        assert!(!is_architecture_code("tests/mermaidStub.ts"));
        assert!(!is_architecture_code("src/widget.spec.ts"));
        assert!(!is_architecture_code("src-tauri/src/test_support.rs"));
        assert!(is_architecture_code("src/workbench.ts"));
        assert!(is_architecture_code("src-tauri/src/analysis/diagram.rs"));
        let file_edges = vec![
            dep("src/app.rs", "vendor/dep/x.rs", 9, &[]),
            dep("src/app.rs", "src/core.rs", 5, &[]),
            dep("src/app.rs", "tests/it.rs", 7, &[]),
        ];
        let graph = graph(&[("src", 2, 2), ("vendor/dep", 1, 1), ("tests", 1, 1)], file_edges);
        let diagram = module_diagram(&graph, None, "");
        let paths: Vec<&str> = diagram.nodes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(paths, ["src/app.rs", "src/core.rs"]);
        assert_eq!(
            diagram.edges.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["src/app.rs→src/core.rs"]
        );
        // A focus overrides the rule: the file the user named decides its own
        // neighbourhood, wherever it lives.
        let focused = module_diagram(&graph, Some("vendor/dep/x.rs"), "");
        let mut paths: Vec<&str> = focused.nodes.iter().map(|n| n.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, ["src/app.rs", "vendor/dep/x.rs"]);
    }

    #[test]
    fn the_same_inputs_build_identically() {
        let first = module_diagram(&chain_graph(), None, "");
        let second = module_diagram(&chain_graph(), None, "");
        assert_eq!(first, second);
    }
}
