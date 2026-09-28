//! The Module Analysis drawing (module 17) — the workspace's cross-file calls as a
//! gitdiagram-style architecture diagram, computed here in the backend (the heavy
//! analysis belongs in Rust, plan §3.4). The backend decides WHAT the diagram is —
//! the model follows gitdiagram's own schema and caps (at most 10 groups — deeper
//! areas roll up to the depth that fits, the overflow draws unboxed, its
//! `groupId: null` — 34 blocks, 48 arrows, no block fanning past eight), the busiest
//! files become two-line cards
//! (the name over the bracketed directory, gitdiagram's `Component<br/>[file.ts]`
//! shape) each carrying its area's tone class — and emits the diagram as mermaid
//! `flowchart TD` source with gitdiagram's tone classDefs verbatim. The page feeds
//! that source to mermaid itself (the same renderer, the same ELK layered layout
//! and spacing gitdiagram initializes), so the layout is ELK's — nodes never
//! overlap — and the copy-the-source export is the exact source rendered.

use std::collections::HashMap;

use serde::Serialize;

use super::modules::{module_of, CallSiteRow, FileDep, ModuleGraph};

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

/// How deep a group box's directory path may run before the roll-up starts folding
/// areas into their parents.
const MAX_GROUP_DEPTH: usize = 3;

/// The pastel tone palette's size (gitdiagram's six: blue, amber, mint, rose,
/// indigo, teal); the neutral gray behind it is the ungrouped overflow's.
const TONES: u32 = 6;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramNode {
    pub path: String,
    /// The file's base name — the card's first line (the second, the bracketed
    /// directory, rides the mermaid label).
    pub label: String,
    /// The area (directory, rolled up to the depth that fits the group cap) whose
    /// subgraph holds the block; "" is the workspace root, `None` the unboxed
    /// overflow of a workspace with more areas than the cap (gitdiagram's
    /// `groupId: null`).
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
    /// The diagram as mermaid `flowchart LR` source — the copy-the-source export.
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

/// The group keys of the kept files: the deepest directory depth (to
/// `MAX_GROUP_DEPTH`) whose distinct areas fit the group cap — the roll-up that
/// keeps a deep workspace's boxes readable the way gitdiagram's curated areas do.
/// A workspace with more top-level areas than the cap keeps its busiest areas
/// boxed and the rest unboxed (`None` — gitdiagram's `groupId: null`), so the cap
/// always holds.
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
    keys
}

/// Whether a call site spells part of the query (case-insensitive).
fn site_contains(site: &CallSiteRow, filter: &str) -> bool {
    site.from.to_lowercase().contains(filter) || site.to.to_lowercase().contains(filter)
}

/// Whether a pair survives the filter: its file names, or a symbol at one of its
/// call sites, spelling part of the query — the page's tree follows the same rule.
fn pair_matches(dep: &FileDep, filter: &str) -> bool {
    filter.is_empty()
        || dep.from.to_lowercase().contains(filter)
        || dep.to.to_lowercase().contains(filter)
        || dep.sites.iter().any(|site| site_contains(site, filter))
}

/// Build the Module Analysis diagram of a module graph: the filter and the focus
/// (a file whose neighbourhood the drawing isolates) narrow the pairs first, then
/// the busiest files become blocks, their dependencies arrows, and the layered
/// pass places everything. Pure function — the same graph, focus and filter always
/// lay out identically.
pub fn module_diagram(graph: &ModuleGraph, focus: Option<&str>, filter: &str) -> ModuleDiagram {
    let filter = filter.trim().to_lowercase();
    let focus = focus.filter(|path| !path.is_empty());
    let deps: Vec<&FileDep> = graph
        .file_edges
        .iter()
        .filter(|dep| pair_matches(dep, &filter))
        .filter(|dep| match focus {
            Some(path) => dep.from == path || dep.to == path,
            None => true,
        })
        .collect();
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
    let kept: Vec<(&str, (u32, u32))> = ranked.into_iter().take(MAX_NODES).collect();
    if kept.is_empty() {
        return ModuleDiagram {
            nodes: Vec::new(),
            edges: Vec::new(),
            dropped_files: 0,
            dropped_edges: 0,
            mermaid: "flowchart TD\n".to_owned(),
        };
    }
    let kept_set: Vec<&str> = kept.iter().map(|(path, _)| *path).collect();
    let both_kept = |dep: &FileDep| {
        kept_set.contains(&dep.from.as_str()) && kept_set.contains(&dep.to.as_str())
    };

    let keys = group_keys(&kept_set);
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
    let mut fan_out: HashMap<&str, u32> = HashMap::new();
    let mut fan_in: HashMap<&str, u32> = HashMap::new();
    let mut drawn: Vec<&FileDep> = Vec::new();
    let mut considered = 0usize;
    for (dep, dashed) in candidates.iter().copied() {
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

/// The diagram as mermaid source: one subgraph per area, its blocks inside, every
/// arrow labelled with its call count — the source a paste into any mermaid
/// renderer redraws (gitdiagram's copy-the-diagram export).
fn mermaid_source(
    nodes: &[DiagramNode],
    index_of: &HashMap<&str, usize>,
    edges: &[DiagramEdge],
) -> String {
    let label_of = |node: &DiagramNode| {
        // gitdiagram's two-line card: the name over the bracketed directory.
        let dir = module_of(&node.path);
        let shown: String = dir.chars().take(24).collect();
        if dir.is_empty() {
            mermaid_text(&node.label)
        } else {
            format!(
                "{}<br/>[{}]",
                mermaid_text(&node.label),
                mermaid_text(&shown)
            )
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
        let label = if area.is_empty() {
            "(root)".to_owned()
        } else {
            area.to_owned()
        };
        let label = mermaid_text(&label);
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
        if !index_of.contains_key(edge.from.as_str()) || !index_of.contains_key(edge.to.as_str()) {
            eprintln!(
                "[ggs] missing endpoint: {} -> {} (nodes: {})",
                edge.from,
                edge.to,
                nodes.len()
            );
        }
        let from = index_of[edge.from.as_str()];
        let to = index_of[edge.to.as_str()];
        let arrow = if edge.dashed { "-.->" } else { "-->" };
        out.push_str(&format!(
            "  N{from} {arrow}|\"{} calls\"| N{to}\n",
            edge.calls
        ));
    }
    // gitdiagram's own tone palette, verbatim — a paste into any mermaid renderer
    // redraws the same pastel cards.
    out.push_str(
        "  classDef t0 fill:#dbeafe,stroke:#2563eb,stroke-width:1.5px,color:#172554\n  classDef t1 fill:#fef3c7,stroke:#d97706,stroke-width:1.5px,color:#78350f\n  classDef t2 fill:#dcfce7,stroke:#16a34a,stroke-width:1.5px,color:#14532d\n  classDef t3 fill:#ffe4e6,stroke:#e11d48,stroke-width:1.5px,color:#881337\n  classDef t4 fill:#e0e7ff,stroke:#4f46e5,stroke-width:1.5px,color:#312e81\n  classDef t5 fill:#ccfbf1,stroke:#0f766e,stroke-width:1.5px,color:#134e4a\n  classDef t6 fill:#f8fafc,stroke:#334155,stroke-width:1.5px,color:#0f172a\n",
    );
    for (index, node) in nodes.iter().enumerate() {
        out.push_str(&format!("  class N{index} t{}\n", node.tone));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::modules::{ModuleGraph, ModuleInfo};

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
    fn the_model_ranks_traffic_and_tones_the_areas() {
        let diagram = module_diagram(&chain_graph(), None, "");
        // The busiest files lead: a.rs (7 calls of traffic) before ui.rs (5) before top.rs (2).
        let order: Vec<&str> = diagram.nodes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(order, ["src/a.rs", "src/ui.rs", "top.rs"]);
        let a = &diagram.nodes[0];
        assert_eq!((a.calls_in, a.calls_out), (2, 5));
        assert_eq!(a.module.as_deref(), Some("src"));
        // The palette slot follows the area's name order ("" then "src").
        assert_eq!(diagram.nodes[2].tone, 0);
        assert_eq!(a.tone, 1);
        assert_eq!(
            diagram
                .edges
                .iter()
                .map(|edge| edge.id.as_str())
                .collect::<Vec<_>>(),
            ["top.rs→src/a.rs", "src/a.rs→src/ui.rs"]
        );
        assert_eq!(diagram.dropped_files, 0);
        assert_eq!(diagram.dropped_edges, 0);
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
        let mut file_edges = Vec::new();
        for a in 0..10 {
            for b in 10..30 {
                file_edges.push(dep(&format!("m/a{a}.rs"), &format!("m/b{b}.rs"), 1, &[]));
            }
        }
        let diagram = module_diagram(&graph(&[("m", 30, 30)], file_edges), None, "");
        assert_eq!(diagram.nodes.len(), 30);
        assert_eq!(diagram.edges.len(), MAX_EDGES);
        assert_eq!(diagram.dropped_edges, 200 - MAX_EDGES);
    }

    #[test]
    fn areas_roll_up_until_they_fit_the_group_cap() {
        // Fifteen areas, two files each, all calling one hub at the root: the deepest
        // cut names fifteen subgraphs, so the roll-up folds to a shallower one; the
        // areas that still do not fit draw unboxed (gitdiagram's `groupId: null`).
        let mut file_edges = Vec::new();
        for area in 0..15 {
            let dir = format!("a{area:02}/b{area:02}/c{area:02}");
            file_edges.push(dep(&format!("{dir}/one.rs"), "hub.rs", 1, &[]));
            file_edges.push(dep(&format!("{dir}/two.rs"), "hub.rs", 1, &[]));
        }
        let diagram = module_diagram(&graph(&[("", 1, 1)], file_edges), None, "");
        let subgraphs = diagram.mermaid.matches("subgraph G").count();
        assert!(subgraphs <= MAX_GROUPS, "rolled up to {subgraphs} groups");
        assert!(subgraphs >= 2, "the cut keeps some detail");
        assert!(
            diagram.nodes.iter().any(|n| n.module.is_none()),
            "the overflow draws unboxed"
        );
        assert_eq!(
            subgraphs,
            diagram
                .nodes
                .iter()
                .filter_map(|n| n.module.as_deref())
                .collect::<std::collections::HashSet<&str>>()
                .len()
        );
        // A flat workspace needs no roll-up: one subgraph per directory at full depth.
        let flat = module_diagram(&chain_graph(), None, "");
        assert_eq!(flat.mermaid.matches("subgraph G").count(), 2);
    }

    #[test]
    fn focus_and_filter_narrow_the_pairs() {
        // Focus keeps only the pairs the file touches.
        let focused = module_diagram(&chain_graph(), Some("src/a.rs"), "");
        let mut paths: Vec<&str> = focused.nodes.iter().map(|n| n.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, ["src/a.rs", "src/ui.rs", "top.rs"]);
        // A filter may reach through a call-site symbol to its pair.
        let by_symbol = module_diagram(&chain_graph(), None, "boot");
        let paths: Vec<&str> = by_symbol.nodes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(paths, ["src/a.rs", "top.rs"]);
        // Nothing matches: the empty diagram, mermaid header only.
        let none = module_diagram(&chain_graph(), None, "zzz");
        assert!(none.nodes.is_empty());
        assert_eq!(none.mermaid, "flowchart TD\n");
    }

    #[test]
    fn mermaid_source_carries_groups_labels_and_calls() {
        let diagram = module_diagram(&chain_graph(), None, "");
        let mermaid = &diagram.mermaid;
        assert!(mermaid.starts_with("flowchart TD\n"));
        // The blocks carry gitdiagram's two-line label, inside their area's subgraph.
        assert!(
            mermaid.contains("N2[\"top.rs\"]"),
            "a root file keeps one line"
        );
        assert!(mermaid.contains("N0[\"a.rs<br/>[src]\"]"));
        assert!(
            mermaid.contains("subgraph G0[\"src\"]"),
            "first-appearance order"
        );
        assert!(mermaid.contains("subgraph G1[\"(root)\"]"));
        // The arrows carry their call counts; the tone classes ride along.
        assert!(mermaid.contains("N2 -->|\"2 calls\"| N0"));
        assert!(mermaid.contains("N0 -->|\"5 calls\"| N1"));
        assert!(mermaid.contains("classDef t0 fill:#dbeafe,stroke:#2563eb"));
        assert!(
            mermaid.contains("class N0 t1"),
            "the block carries its area's tone"
        );
    }

    #[test]
    fn the_same_inputs_build_identically() {
        let first = module_diagram(&chain_graph(), None, "");
        let second = module_diagram(&chain_graph(), None, "");
        assert_eq!(first, second);
    }
}
