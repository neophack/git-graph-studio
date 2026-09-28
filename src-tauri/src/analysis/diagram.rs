//! The Module Analysis drawing (module 17) — the workspace's cross-file calls as a
//! gitdiagram-style architecture diagram, computed here in the backend (the heavy
//! analysis belongs in Rust, plan §3.4). The model follows gitdiagram's own schema
//! and its caps — at most 10 group boxes, 34 blocks and 48 arrows — because that is
//! what makes its diagrams readable: an architecture diagram orients, the page's
//! tree lists everything. The busiest files become two-line blocks (the name over
//! the directory, gitdiagram's `Component<br/>[file.ts]` shape) inside their area's
//! box (the file's directory, rolled up to the depth that fits the group cap), each
//! area one of gitdiagram's six pastel tones; every kept dependency a straight
//! arrow labelled by its call count (mermaid's `curve: "linear"`), the cycle's back
//! edges dashed around the side; the whole flow runs top-down (`flowchart TD`),
//! positioned by a compact layered pass — cycle break, longest-path layering,
//! barycenter ordering — with gitdiagram's airy spacing. The geometry ships ready
//! to set (the page writes the SVG path strings verbatim), and the answer carries
//! the diagram's mermaid source, the export gitdiagram popularised.

use std::collections::HashMap;

use serde::Serialize;

use super::modules::{module_of, CallSiteRow, FileDep, ModuleGraph};

/// The three caps of gitdiagram's diagram schema: groups (its `MAX_GRAPH_GROUPS`),
/// blocks (`MAX_GRAPH_NODES`) and arrows (`MAX_GRAPH_EDGES`).
const MAX_GROUPS: usize = 10;
const MAX_NODES: usize = 34;
const MAX_EDGES: usize = 48;

/// How deep a group box's directory path may run before the roll-up starts folding
/// areas into their parents.
const MAX_GROUP_DEPTH: usize = 3;

/// The layered pass's geometry, gitdiagram's spacing (mermaid's `nodeSpacing: 50`,
/// `rankSpacing: 50` read at the app's font): how far apart the columns sit, the gap
/// between two blocks of one area, and the wider break when the area changes inside
/// a column (an area's files read as one cluster).
const RANK_SEP: f64 = 110.0;
const NODE_SEP: f64 = 44.0;
const GROUP_SEP: f64 = 60.0;
/// The block's fixed height — two label lines (the name over the directory); its
/// width derives from the wider of the two.
const NODE_H: f64 = 44.0;
/// Blocks one row carries — a layer with more wraps into a row of its own, so a
/// deep workspace's diagram stays a readable top-down flow.
const MAX_ROW: usize = 8;
/// The pastel tone palette's size (gitdiagram's six: blue, amber, mint, rose,
/// indigo, teal); the neutral gray behind it is the ungrouped overflow's.
const TONES: u32 = 6;
/// The group box's padding: the title strip above, the margin on the other sides.
const BOX_PAD: f64 = 16.0;
const BOX_TITLE: f64 = 30.0;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramNode {
    pub path: String,
    /// The file's base name — what the block prints.
    pub label: String,
    /// The area (directory, rolled up to the depth that fits the group cap) whose
    /// group box holds the block; "" is the workspace root, `None` the unboxed
    /// overflow of a workspace with more areas than the cap (gitdiagram's
    /// `groupId: null`).
    pub module: Option<String>,
    pub calls_in: u32,
    pub calls_out: u32,
    /// The area's pastel tone slot (gitdiagram's `toneBlue` &c.); `TONES` is the
    /// neutral gray of the ungrouped overflow.
    pub tone: u32,
    /// The block's rectangle in diagram space (the viewport fits to the extent).
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramEdge {
    /// `from→to` — unique among the drawn pairs.
    pub id: String,
    pub from: String,
    pub to: String,
    pub calls: u32,
    /// The stroke width, weighted by call count.
    pub width: f64,
    /// A cycle's back edge — drawn dashed around the side (gitdiagram's `-.->`).
    pub dashed: bool,
    /// The ready-to-set SVG geometry: the arrow's path `d` and its head's points.
    pub path: String,
    pub head: String,
    /// Where the call-count label sits — the path's midpoint.
    pub label_x: f64,
    pub label_y: f64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramGroup {
    /// The area path; "" is the workspace root (the page labels it).
    pub name: String,
    /// The area's pastel tone slot — the colour its blocks and title carry.
    pub tone: u32,
    /// The box's rectangle, title strip included.
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleDiagram {
    pub nodes: Vec<DiagramNode>,
    pub edges: Vec<DiagramEdge>,
    /// The group boxes, by name.
    pub groups: Vec<DiagramGroup>,
    /// The diagram's extent — everything drawn sits in `[0, w] × [0, h]`.
    pub width: f64,
    pub height: f64,
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
            groups: Vec::new(),
            width: 0.0,
            height: 0.0,
            dropped_files: 0,
            dropped_edges: 0,
            mermaid: "flowchart LR\n".to_owned(),
        };
    }
    let kept_set: Vec<&str> = kept.iter().map(|(path, _)| *path).collect();
    let both_kept = |dep: &FileDep| {
        kept_set.contains(&dep.from.as_str()) && kept_set.contains(&dep.to.as_str())
    };
    let drawn: Vec<&FileDep> = deps
        .iter()
        .copied()
        .filter(|dep| both_kept(dep))
        .take(MAX_EDGES)
        .collect();
    let dropped_files = total_files - kept.len();
    let dropped_edges = deps.iter().copied().filter(|dep| both_kept(dep)).count() - drawn.len();

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
        .map(|((path, (calls_in, calls_out)), module)| {
            let label = basename(path);
            // The second line's directory, capped the way the page prints it.
            let dir = module_of(path);
            let shown_dir: String = dir.chars().take(24).collect();
            let wide = (label.chars().count() as f64 * 7.0)
                .max(shown_dir.chars().count() as f64 * 6.5 + 12.0);
            DiagramNode {
                path: (*path).to_owned(),
                label: label.to_owned(),
                module: module.clone(),
                calls_in: *calls_in,
                calls_out: *calls_out,
                tone: module.as_deref().map_or(TONES, |area| tone_of[area]),
                x: 0.0,
                y: 0.0,
                w: (wide + 24.0).clamp(84.0, 216.0),
                h: NODE_H,
            }
        })
        .collect();
    let index_of: HashMap<&str, usize> = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| (node.path.as_str(), index))
        .collect();
    let pairs: Vec<(usize, usize)> = drawn
        .iter()
        .map(|dep| (index_of[dep.from.as_str()], index_of[dep.to.as_str()]))
        .collect();

    let mut nodes = nodes;
    let row_of = layout(&mut nodes, &pairs);
    let groups = group_boxes(&nodes, &row_of, &tone_of);
    let edges = route_edges(&nodes, &pairs, &drawn);
    let extent = extent(&nodes, &groups, &edges);
    ModuleDiagram {
        mermaid: mermaid_source(&nodes, &groups, &edges),
        nodes,
        edges,
        groups,
        width: extent.0,
        height: extent.1,
        dropped_files,
        dropped_edges,
    }
}

/// The layered pass: break cycles (the back edges stay, drawn as elbow dashes),
/// assign every node its longest-path layer, order each row by area cluster then
/// barycenter, and stack the rows. Returns the row each node landed in (the group
/// boxes are built per row run from it). Positions land in `x`/`y`.
fn layout(nodes: &mut [DiagramNode], pairs: &[(usize, usize)]) -> Vec<usize> {
    let count = nodes.len();
    let neighbours: Vec<Vec<usize>> = {
        let mut lists: Vec<Vec<usize>> = vec![Vec::new(); count];
        for (from, to) in pairs {
            lists[*from].push(*to);
            lists[*to].push(*from); // the barycenter reads both directions
        }
        lists
    };
    // Cycle break: a depth-first pass marks the edges that close a cycle; they join
    // no layer constraint (their arrow dips below the columns instead).
    let mut back = vec![false; pairs.len()];
    {
        let mut edge_adj: Vec<Vec<usize>> = vec![Vec::new(); count];
        for (edge, (from, _)) in pairs.iter().enumerate() {
            edge_adj[*from].push(edge);
        }
        let mut state = vec![0u8; count];
        for start in 0..count {
            if state[start] == 0 {
                break_cycles(&edge_adj, pairs, &mut state, &mut back, start);
            }
        }
    }
    // Longest-path layering over the non-back edges — iterate to the fixpoint (the
    // graph is acyclic once the back edges leave, so this terminates).
    let mut layer = vec![0usize; count];
    loop {
        let mut changed = false;
        for (edge, (from, to)) in pairs.iter().enumerate() {
            if back[edge] {
                continue;
            }
            if layer[*to] < layer[*from] + 1 {
                layer[*to] = layer[*from] + 1;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let depth = layer.iter().copied().max().unwrap_or(0) + 1;
    let mut order: Vec<Vec<usize>> = vec![Vec::new(); depth];
    for index in 0..count {
        order[layer[index]].push(index);
    }
    // Columns start clustered by area (the boxes read as clusters), path the
    // tiebreak; the sweeps then trade cluster for fewer crossings, area first.
    // `cluster` reads `nodes` at each call (not a capture) — the columns' stacking
    // below assigns into the same slice.
    fn cluster(nodes: &[DiagramNode], index: usize) -> &Option<String> {
        &nodes[index].module
    }
    for list in &mut order {
        list.sort_by(|&a, &b| {
            cluster(nodes, a)
                .cmp(cluster(nodes, b))
                .then_with(|| nodes[a].path.cmp(&nodes[b].path))
        });
    }
    for pass in 0..4 {
        let mut pos = vec![0usize; count];
        for list in &order {
            for (at, node) in list.iter().enumerate() {
                pos[*node] = at;
            }
        }
        let layers: Vec<usize> = if pass % 2 == 0 {
            (0..depth).collect()
        } else {
            (0..depth).rev().collect()
        };
        for l in layers {
            let mut keyed: Vec<(f64, &Option<String>, usize)> = order[l]
                .iter()
                .map(|&node| {
                    let mut sum = 0.0;
                    let mut seen = 0.0;
                    for &other in &neighbours[node] {
                        sum += pos[other] as f64;
                        seen += 1.0;
                    }
                    let key = if seen > 0.0 {
                        sum / seen
                    } else {
                        pos[node] as f64
                    };
                    (key, cluster(nodes, node), node)
                })
                .collect();
            keyed.sort_by(|a, b| {
                a.0.partial_cmp(&b.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.1.cmp(b.1))
                    .then_with(|| a.2.cmp(&b.2))
            });
            order[l] = keyed.into_iter().map(|(_, _, node)| node).collect();
        }
    }
    // Contiguity: regroup each row by area in order of first appearance, keeping the
    // within-area barycenter order — an area's blocks then form one run per row, so
    // its group boxes tile without overlapping (ELK keeps clusters contiguous too);
    // the sweeps' crossing wins survive as the area-level ordering.
    for list in &mut order {
        let mut areas: Vec<Option<String>> = Vec::new();
        let mut buckets: HashMap<Option<String>, Vec<usize>> = HashMap::new();
        for &index in list.iter() {
            let area = cluster(nodes, index).clone();
            if !areas.contains(&area) {
                areas.push(area.clone());
            }
            buckets.entry(area).or_default().push(index);
        }
        let mut merged = Vec::with_capacity(list.len());
        for area in areas {
            merged.extend(buckets.remove(&area).unwrap_or_default());
        }
        *list = merged;
    }
    // The layers wrap into rows of at most `MAX_ROW` blocks; the flow runs top-down
    // (`flowchart TD`): y steps by the row gap, x stacks left-to-right with the area
    // break, every row centred on the widest.
    let mut rows: Vec<Vec<usize>> = Vec::new();
    for list in &order {
        for chunk in list.chunks(MAX_ROW) {
            rows.push(chunk.to_vec());
        }
    }
    let mut row_of = vec![0usize; count];
    for (at, list) in rows.iter().enumerate() {
        for &index in list {
            row_of[index] = at;
        }
    }
    let row_count = rows.len();
    let mut row_y = vec![0.0f64; row_count];
    for r in 1..row_count {
        row_y[r] = row_y[r - 1] + NODE_H + RANK_SEP;
    }
    let mut widths = vec![0.0f64; row_count];
    for r in 0..row_count {
        let mut cursor = 0.0f64;
        let mut previous: Option<&Option<String>> = None;
        for &index in &rows[r] {
            if let Some(area) = previous {
                cursor += if area == cluster(nodes, index) {
                    NODE_SEP
                } else {
                    GROUP_SEP
                };
            }
            nodes[index].x = cursor;
            nodes[index].y = row_y[r];
            cursor += nodes[index].w + NODE_SEP;
            previous = Some(cluster(nodes, index));
        }
        widths[r] = cursor - NODE_SEP;
    }
    let widest = widths.iter().copied().fold(0.0f64, f64::max);
    for r in 0..row_count {
        let shift = (widest - widths[r]) / 2.0;
        for &index in &rows[r] {
            nodes[index].x += shift;
        }
    }
    // The group boxes carry negative top/left padding — move everything into the
    // positive quadrant so the viewport's fit stays simple.
    let min_x = nodes.iter().map(|node| node.x).fold(0.0f64, f64::min) - BOX_PAD;
    let min_y = nodes.iter().map(|node| node.y).fold(0.0f64, f64::min) - BOX_TITLE;
    let (dx, dy) = (min_x.min(0.0).abs(), min_y.min(0.0).abs());
    for node in nodes.iter_mut() {
        node.x += dx;
        node.y += dy;
    }
    row_of
}

fn break_cycles(
    edge_adj: &[Vec<usize>],
    pairs: &[(usize, usize)],
    state: &mut [u8],
    back: &mut [bool],
    node: usize,
) {
    state[node] = 1;
    for &edge in &edge_adj[node] {
        let to = pairs[edge].1;
        if state[to] == 1 {
            back[edge] = true;
        } else if state[to] == 0 {
            break_cycles(edge_adj, pairs, state, back, to);
        }
    }
    state[node] = 2;
}

/// The area boxes: one per contiguous (area, row) run — an area that spans rows
/// draws one box per row, which is what keeps every pair of boxes from overlapping
/// (the rows tile vertically, the runs tile horizontally). Padded around its blocks
/// with the title strip above; the tone is the area's own.
fn group_boxes(
    nodes: &[DiagramNode],
    row_of: &[usize],
    tone_of: &HashMap<&str, u32>,
) -> Vec<DiagramGroup> {
    let mut order: Vec<usize> = (0..nodes.len())
        .filter(|index| nodes[*index].module.is_some())
        .collect();
    order.sort_by(|a, b| {
        row_of[*a].cmp(&row_of[*b]).then_with(|| {
            nodes[*a]
                .x
                .partial_cmp(&nodes[*b].x)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    let mut groups = Vec::new();
    let mut run: Option<(String, u32, f64, f64, f64, f64, usize)> = None; // name, tone, min_x, min_y, max_x, max_y, row
    for index in order {
        let node = &nodes[index];
        let row = row_of[index];
        let (name, tone) = match (
            &node.module,
            node.module.as_deref().and_then(|area| tone_of.get(area)),
        ) {
            (Some(area), Some(&tone)) => (area.clone(), tone),
            (Some(area), None) => (area.clone(), TONES),
            (None, _) => continue,
        };
        match &mut run {
            Some((run_name, _, min_x, min_y, max_x, max_y, run_row))
                if *run_name == name && *run_row == row =>
            {
                *min_x = min_x.min(node.x);
                *min_y = min_y.min(node.y);
                *max_x = max_x.max(node.x + node.w);
                *max_y = max_y.max(node.y + node.h);
            }
            finished => {
                if let Some((name, tone, min_x, min_y, max_x, max_y, _)) = finished.take() {
                    groups.push(DiagramGroup {
                        name,
                        tone,
                        x: min_x - BOX_PAD,
                        y: min_y - BOX_TITLE,
                        w: max_x - min_x + BOX_PAD * 2.0,
                        h: max_y - min_y + BOX_TITLE + BOX_PAD,
                    });
                }
                *finished = Some((
                    name,
                    tone,
                    node.x,
                    node.y,
                    node.x + node.w,
                    node.y + node.h,
                    row,
                ));
            }
        }
    }
    if let Some((name, tone, min_x, min_y, max_x, max_y, _)) = run.take() {
        groups.push(DiagramGroup {
            name,
            tone,
            x: min_x - BOX_PAD,
            y: min_y - BOX_TITLE,
            w: max_x - min_x + BOX_PAD * 2.0,
            h: max_y - min_y + BOX_TITLE + BOX_PAD,
        });
    }
    groups
}

/// The arrows, mermaid's `curve: "linear"` in a top-down flow: caller's bottom edge
/// to callee's top edge as one straight segment; the cycle's back edges (dashed,
/// gitdiagram's `-.->`) route around the side as a three-segment elbow. The head is
/// a triangle on the end direction, the label the path's midpoint.
fn route_edges(
    nodes: &[DiagramNode],
    pairs: &[(usize, usize)],
    deps: &[&FileDep],
) -> Vec<DiagramEdge> {
    let mut edges = Vec::with_capacity(pairs.len());
    for (at, ((from, to), dep)) in pairs.iter().zip(deps.iter()).enumerate() {
        let (fx, fy) = (
            nodes[*from].x + nodes[*from].w / 2.0,
            nodes[*from].y + nodes[*from].h,
        );
        let (tx, ty) = (nodes[*to].x + nodes[*to].w / 2.0, nodes[*to].y);
        let (path, label_x, label_y, dir_x, dir_y, dashed) = if ty >= fy + 8.0 {
            (
                format!("M {fx:.1} {fy:.1} L {tx:.1} {ty:.1}"),
                (fx + tx) / 2.0,
                (fy + ty) / 2.0,
                tx - fx,
                ty - fy,
                false,
            )
        } else {
            let side = 40.0 + (at % 3) as f64 * 18.0;
            let (ax, ay) = (fx + side, fy + 30.0);
            let (bx, by) = (tx + side, ty - 30.0);
            (
                format!("M {fx:.1} {fy:.1} L {ax:.1} {ay:.1} L {bx:.1} {by:.1} L {tx:.1} {ty:.1}"),
                (ax + bx) / 2.0,
                (ay + by) / 2.0,
                tx - bx,
                ty - by,
                true,
            )
        };
        let (mut vx, mut vy) = (dir_x, dir_y);
        let length = (vx * vx + vy * vy).sqrt();
        if length < 1e-6 {
            vx = 1.0;
            vy = 0.0;
        } else {
            vx /= length;
            vy /= length;
        }
        let (px, py) = (-vy, vx);
        let (bx, by) = (tx - vx * 11.0, ty - vy * 11.0);
        let (p1x, p1y) = (bx + px * 5.5, by + py * 5.5);
        let (p2x, p2y) = (bx - px * 5.5, by - py * 5.5);
        edges.push(DiagramEdge {
            id: format!("{}→{}", dep.from, dep.to),
            from: dep.from.clone(),
            to: dep.to.clone(),
            calls: dep.calls,
            // gitdiagram's edges read uniformly thin; the call count rides the
            // label, the weight only hints (1.2–2.4 px).
            width: 1.2 + ((dep.calls as f64 + 1.0).log2().min(2.0)) * 0.6,
            dashed,
            path,
            head: format!("{tx:.1},{ty:.1} {p1x:.1},{p1y:.1} {p2x:.1},{p2y:.1}"),
            label_x,
            label_y,
        });
    }
    edges
}

/// The diagram's extent — every block, box and arrow inside it (the back edges'
/// elbows reach past the cards; the viewport's fit must see them or it clips).
fn extent(nodes: &[DiagramNode], groups: &[DiagramGroup], edges: &[DiagramEdge]) -> (f64, f64) {
    let mut w = 0.0f64;
    let mut h = 0.0f64;
    for node in nodes {
        w = w.max(node.x + node.w);
        h = h.max(node.y + node.h);
    }
    for group in groups {
        w = w.max(group.x + group.w);
        h = h.max(group.y + group.h);
    }
    for edge in edges {
        // The path spells its coordinates in x, y pairs; the pairs bound the extent.
        let numbers: Vec<f64> = edge
            .path
            .split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
            .filter(|token| !token.is_empty())
            .filter_map(|token| token.parse().ok())
            .collect();
        for pair in numbers.chunks(2) {
            if let [x, y] = pair {
                w = w.max(*x);
                h = h.max(*y);
            }
        }
    }
    (w, h)
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
fn mermaid_source(nodes: &[DiagramNode], groups: &[DiagramGroup], edges: &[DiagramEdge]) -> String {
    let index_of: HashMap<&str, usize> = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| (node.path.as_str(), index))
        .collect();
    let label_of = |node: &DiagramNode| {
        // gitdiagram's two-line block: the name over the bracketed directory.
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
    let mut emitted: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for (at, group) in groups.iter().enumerate() {
        if !emitted.insert(group.name.as_str()) {
            continue; // an area spanning rows draws one box per row; one subgraph total
        }
        let label = if group.name.is_empty() {
            "(root)".to_owned()
        } else {
            group.name.clone()
        };
        let label = mermaid_text(&label);
        out.push_str(&format!("  subgraph G{at}[\"{label}\"]\n"));
        for node in nodes
            .iter()
            .filter(|node| node.module.as_deref() == Some(group.name.as_str()))
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
    fn chain_layers_left_to_right_inside_group_boxes() {
        let diagram = module_diagram(&chain_graph(), None, "");
        let by_path = |path: &str| diagram.nodes.iter().find(|n| n.path == path).unwrap();
        // The busiest files lead: a.rs (7 calls of traffic) before ui.rs (5) before top.rs (2).
        let order: Vec<&str> = diagram.nodes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(order, ["src/a.rs", "src/ui.rs", "top.rs"]);
        // The call chain reads left to right: each callee a column further right.
        let top = by_path("top.rs");
        let a = by_path("src/a.rs");
        let ui = by_path("src/ui.rs");
        assert!(
            top.y < a.y && a.y < ui.y,
            "the flow runs top-down with the calls"
        );
        assert_eq!(diagram.edges.len(), 2);
        // Every boxed block sits inside exactly one of its area's boxes, with room
        // for the title strip; no two boxes overlap — the page's tiling guarantee.
        for node in diagram.nodes.iter() {
            let Some(area) = node.module.as_deref() else {
                continue;
            };
            let containing = diagram
                .groups
                .iter()
                .filter(|g| {
                    g.name == area
                        && node.x >= g.x
                        && node.x + node.w <= g.x + g.w
                        && node.y >= g.y
                        && node.y + node.h <= g.y + g.h
                })
                .count();
            assert_eq!(
                containing, 1,
                "{} sits in exactly one {} box",
                node.path, area
            );
            let box_ = diagram
                .groups
                .iter()
                .find(|g| {
                    g.name == area && node.x >= g.x && node.x + node.w <= g.x + g.w && node.y >= g.y
                })
                .unwrap();
            assert!(node.y - box_.y >= BOX_TITLE - 1.0, "room for the title");
        }
        for (i, first) in diagram.groups.iter().enumerate() {
            for second in diagram.groups.iter().skip(i + 1) {
                let overlap = first.x < second.x + second.w
                    && second.x < first.x + first.w
                    && first.y < second.y + second.h
                    && second.y < first.y + first.h;
                assert!(
                    !overlap,
                    "boxes {:?} and {:?} overlap",
                    first.name, second.name
                );
            }
        }
        // No two blocks overlap — the layered columns never stack.
        for (i, first) in diagram.nodes.iter().enumerate() {
            for second in diagram.nodes.iter().skip(i + 1) {
                let overlap = first.x < second.x + second.w
                    && second.x < first.x + first.w
                    && first.y < second.y + second.h
                    && second.y < first.y + first.h;
                assert!(!overlap, "{} overlaps {}", first.path, second.path);
            }
        }
        // The arrows are straight segments carrying ready geometry, the call-count
        // label at the midpoint, weighted by calls.
        let edge = &diagram.edges[0];
        assert_eq!(edge.id, "top.rs→src/a.rs");
        assert!(edge.path.starts_with('M') && edge.path.contains(" L "));
        assert_eq!(edge.head.split_whitespace().count(), 3, "three x,y pairs");
        assert!(edge.label_x > top.x && edge.label_x < a.x + a.w);
        assert!(edge.width > 1.0 && edge.width <= 4.0, "weighted by calls");
        // Everything sits in the extent, in the positive quadrant.
        for node in &diagram.nodes {
            assert!(node.x >= 0.0 && node.y >= 0.0);
            assert!(node.x + node.w <= diagram.width + 0.5);
            assert!(node.y + node.h <= diagram.height + 0.5);
        }
    }

    #[test]
    fn cycles_break_and_dip_instead_of_hanging() {
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
        assert_eq!(diagram.nodes.len(), 3);
        assert_eq!(diagram.edges.len(), 3, "the back edge stays drawn");
        // Every node still landed a finite position in the positive quadrant.
        for node in &diagram.nodes {
            assert!(node.x.is_finite() && node.y.is_finite());
            assert!(node.x >= 0.0 && node.y >= 0.0);
        }
        // At least one arrow dips — its elbow sits below both ends — the cycle's
        // back edge routes around the columns rather than through them.
        let dipping = diagram.edges.iter().any(|edge| {
            let numbers: Vec<f64> = edge
                .path
                .split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
                .filter_map(|token| token.parse().ok())
                .collect();
            let ys: Vec<f64> = numbers.iter().skip(1).step_by(2).copied().collect();
            ys.len() >= 4 && ys[1] > ys[0] && ys[1] > ys[3]
        });
        assert!(dipping, "a back edge dips below the columns");
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
        // The hub — all the traffic — is kept, and the pairs among the kept blocks
        // all fit the edge cap (the dropped pairs belong to dropped files).
        assert!(diagram.nodes.iter().any(|node| node.path == "hub.rs"));
        assert_eq!(diagram.edges.len(), MAX_NODES - 1);
        assert_eq!(diagram.dropped_edges, 0);
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
        // Fifteen areas, two files each, all calling one hub at the root: the
        // deepest cut names fifteen boxes, so the roll-up folds to a shallower one.
        let mut file_edges = Vec::new();
        for area in 0..15 {
            let dir = format!("a{area:02}/b{area:02}/c{area:02}");
            file_edges.push(dep(&format!("{dir}/one.rs"), "hub.rs", 1, &[]));
            file_edges.push(dep(&format!("{dir}/two.rs"), "hub.rs", 1, &[]));
        }
        let diagram = module_diagram(&graph(&[("", 1, 1)], file_edges), None, "");
        let unique: std::collections::HashSet<&str> =
            diagram.groups.iter().map(|g| g.name.as_str()).collect();
        assert!(
            unique.len() <= MAX_GROUPS,
            "rolled up to {} groups",
            unique.len()
        );
        assert!(diagram.groups.len() >= 2, "the cut keeps some detail");
        // Every boxed block sits inside exactly one of its area's boxes; the overflow
        // of areas beyond the cap draws unboxed (the hub — the root lost the size race).
        for node in &diagram.nodes {
            if let Some(area) = node.module.as_deref() {
                let containing = diagram
                    .groups
                    .iter()
                    .filter(|g| {
                        g.name == area
                            && node.x >= g.x
                            && node.x + node.w <= g.x + g.w
                            && node.y >= g.y
                            && node.y + node.h <= g.y + g.h
                    })
                    .count();
                assert_eq!(
                    containing, 1,
                    "{} sits in exactly one {} box",
                    node.path, area
                );
            }
        }
        assert!(
            diagram.nodes.iter().any(|n| n.module.is_none()),
            "the overflow draws unboxed"
        );
        // And the boxes tile: no two overlap.
        for (i, first) in diagram.groups.iter().enumerate() {
            for second in diagram.groups.iter().skip(i + 1) {
                let overlap = first.x < second.x + second.w
                    && second.x < first.x + first.w
                    && first.y < second.y + second.h
                    && second.y < first.y + first.h;
                assert!(
                    !overlap,
                    "boxes {:?} and {:?} overlap",
                    first.name, second.name
                );
            }
        }
        // A flat workspace needs no roll-up: one area per directory at full depth.
        // An area spanning rows draws one box per row, so `src` (two layers) lists twice.
        let flat = module_diagram(&chain_graph(), None, "");
        let names: Vec<&str> = flat.groups.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, ["", "src", "src"]);
        let unique: std::collections::HashSet<&str> = names.into_iter().collect();
        assert_eq!(unique.len(), 2, "two areas");
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
        assert_eq!(none.mermaid, "flowchart LR\n");
    }

    #[test]
    fn mermaid_source_carries_groups_labels_and_calls() {
        let diagram = module_diagram(&chain_graph(), None, "");
        let mermaid = &diagram.mermaid;
        assert!(mermaid.starts_with("flowchart TD\n"));
        assert_eq!(mermaid.matches("subgraph").count(), 2);
        assert!(mermaid.contains("subgraph G0[\"(root)\"]"));
        assert!(mermaid.contains("subgraph G1[\"src\"]"));
        // The blocks are declared inside their group's subgraph, gitdiagram's
        // two-line label (the name over the bracketed directory).
        assert!(
            mermaid.contains("N2[\"top.rs\"]"),
            "a root file keeps one line"
        );
        assert!(mermaid.contains("N0[\"a.rs<br/>[src]\"]"));
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
    fn the_same_inputs_lay_out_identically() {
        let first = module_diagram(&chain_graph(), None, "");
        let second = module_diagram(&chain_graph(), None, "");
        assert_eq!(first, second);
    }
}
