//! The Code Analysis engine (module 17): the in-memory workspace model the five analysis
//! tools read. Where the symbol store (symbols/) is the persistent name-and-occurrence
//! database, this is the parsed-tree database — every source file's declarations, call
//! sites and imports (via `symbols::parse`), resolved into a workspace-wide call graph.
//! It lives only for the session (a restart rebuilds; parse speed makes persistence
//! unnecessary), updated file-by-file from the same watcher batches the symbol index eats.
//!
//! Resolution is honest about what it is: name matching with receiver hints, not type
//! inference. A call edge exists when a call site's spelling matches a declaration —
//! preferring methods whose container matches the receiver, and `self`/`this` receivers
//! preferring the enclosing type's methods. Ambiguity stays visible (one call site may
//! fan out to several same-named declarations), and every call-site name is recorded so
//! the dead-code report can stay conservative.

pub mod deadcode;
pub mod imports;
pub mod metrics;
pub mod security;

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use rayon::prelude::*;

use crate::cmd_fs::walk_files;
use crate::cmd_search::is_symbol_source;
use crate::symbols::parse::{self, CallSite, ParsedFile, ParsedSymbol};

/// Files per progress batch; also the cancellation checkpoint (the symbol store's rhythm).
pub const BUILD_BATCH: usize = 256;

/// One file's analysis content plus the fingerprint it was parsed at.
pub struct FileAnalysis {
    pub path: String,
    pub mtime_ms: u64,
    pub size: u64,
    pub symbols: Vec<ParsedSymbol>,
    pub calls: Vec<CallSite>,
    pub imports: Vec<String>,
}

/// A declaration's address: the file's index in `files` and the symbol's index in the
/// file's `symbols`. Only meaningful inside one `AnalysisData`.
pub type DefKey = (u32, u32);

/// The "no enclosing declaration" symbol index (a call outside any function body).
const NO_ENCLOSING: u32 = u32::MAX;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub kind: String,
    pub name: String,
    pub container: Option<String>,
    /// Repo-relative, forward slashes.
    pub path: String,
    pub line: usize,
    pub complexity: u32,
    pub signature: String,
    /// 0 for the root(s); each edge away from a root adds one.
    pub depth: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub from: GraphEndpoint,
    pub to: GraphEndpoint,
    /// Where the call happens.
    pub call_path: String,
    pub call_line: usize,
    pub call_column: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphEndpoint {
    pub name: String,
    pub path: String,
    pub line: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CallGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    /// How many edges a receiver could not narrow away (see the module doc).
    pub ambiguous: usize,
}

/// The workspace-wide call graph the Call Graph page opens on: every declaration a
/// resolved call touches (as caller or callee), one edge per caller→callee pair — the
/// pair's first call site names it — layered by call depth, entry points at the top.
/// `total_*` count before the caps below bite, so the page can say how much it shows.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCallGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub ambiguous: usize,
    pub total_nodes: usize,
    pub total_edges: usize,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Callers,
    Callees,
}

/// The workspace analysis of one root: the parsed files plus the derived name index and
/// call edges.
pub struct AnalysisData {
    root: String,
    /// Sorted by path.
    files: Vec<FileAnalysis>,
    /// name → every declaration of it, in file order.
    by_name: HashMap<String, Vec<DefKey>>,
    /// Declaration → what it (may) call, one entry per resolution.
    callees: HashMap<DefKey, Vec<(DefKey, String, usize, usize)>>,
    /// Declaration → what (may) call it (the transpose, same sites).
    callers: HashMap<DefKey, Vec<(DefKey, String, usize, usize)>>,
    /// Every name any call site spells, resolved or not — the dead-code escape hatch.
    called_names: HashSet<String>,
}

impl AnalysisData {
    /// The empty analysis (nothing built yet).
    pub fn empty(root: &str) -> AnalysisData {
        AnalysisData {
            root: root.to_owned(),
            files: Vec::new(),
            by_name: HashMap::new(),
            callees: HashMap::new(),
            callers: HashMap::new(),
            called_names: HashSet::new(),
        }
    }

    pub fn root(&self) -> &str {
        &self.root
    }

    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    pub fn symbol_count(&self) -> usize {
        self.files.iter().map(|f| f.symbols.len()).sum()
    }

    pub fn call_count(&self) -> usize {
        self.files.iter().map(|f| f.calls.len()).sum()
    }

    pub fn files(&self) -> &[FileAnalysis] {
        &self.files
    }

    /// Every declaration of exactly `name`, with its file path.
    pub fn lookup(&self, name: &str) -> Vec<(String, &ParsedSymbol)> {
        self.by_name
            .get(name)
            .map(|keys| {
                keys.iter()
                    .map(|&(file, symbol)| {
                        let entry = &self.files[file as usize];
                        (entry.path.clone(), &entry.symbols[symbol as usize])
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// How many call sites resolve to any declaration of `name`.
    pub fn incoming_count(&self, name: &str) -> usize {
        self.by_name
            .get(name)
            .map(|keys| {
                keys.iter()
                    .filter_map(|key| self.callers.get(key))
                    .map(|list| list.len())
                    .sum()
            })
            .unwrap_or(0)
    }

    /// Whether any call site in the workspace spells `name` (resolved or not).
    pub fn called_anywhere(&self, name: &str) -> bool {
        self.called_names.contains(name)
    }

    /// The names every interface declares — dead code skips their methods (dynamic
    /// dispatch makes "no callers" meaningless there).
    pub fn interface_containers(&self) -> HashSet<String> {
        self.files
            .iter()
            .flat_map(|f| f.symbols.iter())
            .filter(|s| s.kind == "interface")
            .map(|s| s.name.clone())
            .collect()
    }

    /* ---------- Building ---------- */

    /// The full build: parse every source file under `root`, then derive the name index
    /// and the call edges. `report` fires once per batch; `cancelled` is honoured between
    /// batches. `None` means cancelled — nothing is installed.
    pub fn build(
        root: &str,
        threads: usize,
        report: &(dyn Fn(usize, usize) + Sync),
        cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Option<AnalysisData> {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads.max(1))
            .build()
            .ok()?;
        pool.install(|| {
            let paths: Vec<String> = walk_files(root)
                .into_iter()
                .filter(|p| is_symbol_source(p))
                .collect();
            let total = paths.len();
            let mut parsed: Vec<FileAnalysis> = Vec::with_capacity(total);
            for batch in paths.chunks(BUILD_BATCH) {
                if cancelled() {
                    return None;
                }
                let mut part: Vec<FileAnalysis> = batch
                    .par_iter()
                    .filter_map(|relative| parse_one(root, relative))
                    .collect();
                parsed.append(&mut part);
                report(parsed.len(), total);
            }
            parsed.sort_by(|a, b| a.path.cmp(&b.path));
            Some(Self::from_files(root, parsed))
        })
    }

    /// Assemble the derived tables over already-parsed files (files must be path-sorted).
    fn from_files(root: &str, files: Vec<FileAnalysis>) -> AnalysisData {
        let mut data = AnalysisData::empty(root);
        data.files = files;
        data.derive();
        data
    }

    /// Recompute the name index and the call edges over the current files (after a build
    /// or an incremental change).
    fn derive(&mut self) {
        self.by_name.clear();
        self.callees.clear();
        self.callers.clear();
        self.called_names.clear();
        for (file_id, file) in self.files.iter().enumerate() {
            for (symbol_id, symbol) in file.symbols.iter().enumerate() {
                self.by_name
                    .entry(symbol.name.clone())
                    .or_default()
                    .push((file_id as u32, symbol_id as u32));
            }
        }
        let containers: HashSet<String> = self
            .files
            .iter()
            .flat_map(|f| f.symbols.iter())
            .filter_map(|s| s.container.clone())
            .collect();
        for (file_id, file) in self.files.iter().enumerate() {
            let file_id = file_id as u32;
            for call in &file.calls {
                self.called_names.insert(call.name.clone());
                let caller = match enclosing_symbol(file, call.line) {
                    Some(symbol_id) => (file_id, symbol_id),
                    None => (file_id, NO_ENCLOSING),
                };
                for target in self.resolve(call, file_id, &containers) {
                    if caller.1 != NO_ENCLOSING {
                        self.callees.entry(caller).or_default().push((
                            target,
                            file.path.clone(),
                            call.line,
                            call.column,
                        ));
                    }
                    self.callers.entry(target).or_default().push((
                        caller,
                        file.path.clone(),
                        call.line,
                        call.column,
                    ));
                }
            }
        }
        // The no-enclosing pseudo-declaration never appears as a caller in `callees`
        // (guarded above), but `callers` may carry it; drop those keys so graph walks
        // only ever meet real declarations.
        let stray: Vec<DefKey> = self
            .callers
            .iter()
            .filter(|(key, _)| key.1 == NO_ENCLOSING)
            .map(|(key, _)| *key)
            .collect();
        for key in stray {
            self.callers.remove(&key);
        }
    }

    /// Resolve one call site to the declarations it (may) name. See the module doc for
    /// the pecking order; the empty answer means "external or unresolvable".
    fn resolve(
        &self,
        call: &CallSite,
        home_file: u32,
        containers: &HashSet<String>,
    ) -> Vec<DefKey> {
        let Some(candidates) = self.by_name.get(call.name.as_str()) else {
            return Vec::new();
        };
        if candidates.len() == 1 {
            return candidates.clone();
        }
        let container_of = |key: DefKey| {
            self.files[key.0 as usize].symbols[key.1 as usize]
                .container
                .as_deref()
        };
        if let Some(receiver) = call.receiver.as_deref() {
            // `obj.method()` with obj naming a known type: that type's methods. Also
            // covers static/namespace calls like `Y.z()` (Java) and `fmt.Println` (Go).
            let by_container: Vec<DefKey> = candidates
                .iter()
                .copied()
                .filter(|&key| container_of(key) == Some(receiver))
                .collect();
            if !by_container.is_empty() && containers.contains(receiver) {
                return by_container;
            }
            // `self.x()` / `this.x()`: the enclosing type's methods win.
            if receiver == "self" || receiver == "this" {
                if let Some(container) = self.enclosing_container(home_file, call.line) {
                    let same_type: Vec<DefKey> = candidates
                        .iter()
                        .copied()
                        .filter(|&key| container_of(key) == Some(container.as_str()))
                        .collect();
                    if !same_type.is_empty() {
                        return same_type;
                    }
                }
            }
        }
        candidates.clone()
    }

    /// The type of the declaration whose body contains `line` in file `home_file`: its
    /// container when it has one (a method's class), itself otherwise (a free function
    /// is its own scope).
    fn enclosing_container(&self, home_file: u32, line: usize) -> Option<String> {
        let file = self.files.get(home_file as usize)?;
        enclosing_symbol(file, line).map(|symbol_id| {
            let symbol = &file.symbols[symbol_id as usize];
            symbol
                .container
                .clone()
                .unwrap_or_else(|| symbol.name.clone())
        })
    }

    /* ---------- Incremental updates ---------- */

    /// Apply a watcher batch: gone files drop out, changed files re-parse (a matching
    /// fingerprint skips the work), new files join, then the derived tables rebuild.
    pub fn apply_changes(&mut self, paths: &[String]) {
        let wanted: HashSet<&str> = paths
            .iter()
            .map(String::as_str)
            .filter(|p| is_symbol_source(p))
            .collect();
        let root = self.root.clone();
        let mut keep: Vec<bool> = Vec::with_capacity(self.files.len());
        let mut to_parse: HashSet<String> = HashSet::new();
        for file in &self.files {
            let touched = wanted.contains(file.path.as_str());
            let path = std::path::Path::new(&root).join(&file.path);
            let stat = file_stat(&path);
            let unchanged = !touched
                && stat
                    .as_ref()
                    .is_some_and(|s| s.0 == file.mtime_ms && s.1 == file.size);
            if unchanged {
                keep.push(true);
                continue;
            }
            if stat.is_some() {
                to_parse.insert(file.path.clone());
            }
            keep.push(false);
        }
        for path in &wanted {
            if !to_parse.iter().any(|p| p == path)
                && std::path::Path::new(&root).join(path).exists()
            {
                to_parse.insert((*path).to_owned());
            }
        }
        let mut files: Vec<FileAnalysis> = Vec::with_capacity(self.files.len());
        for (file, keep_file) in std::mem::take(&mut self.files).into_iter().zip(keep) {
            if keep_file {
                files.push(file);
            }
        }
        let mut reparsed: Vec<FileAnalysis> = to_parse
            .iter()
            .filter_map(|path| parse_one(&root, path))
            .collect();
        files.append(&mut reparsed);
        files.sort_by(|a, b| a.path.cmp(&b.path));
        files.dedup_by(|a, b| a.path == b.path);
        self.files = files;
        self.derive();
    }

    /* ---------- The call graph ---------- */

    /// The graph around every declaration of `name` (or one exact declaration, when
    /// `path` and `line` name it): `max_depth` levels of callers or callees.
    pub fn call_graph(
        &self,
        name: &str,
        exact: Option<(&str, usize)>,
        direction: Direction,
        max_depth: u32,
    ) -> CallGraph {
        let max_depth = max_depth.clamp(1, 8);
        let roots: Vec<DefKey> = match exact {
            Some((path, line)) => self.find_at(path, line).into_iter().collect(),
            None => self.by_name.get(name).cloned().unwrap_or_default(),
        };
        let adjacency: &HashMap<DefKey, Vec<(DefKey, String, usize, usize)>> = match direction {
            Direction::Callees => &self.callees,
            Direction::Callers => &self.callers,
        };
        // BFS outward from the roots, collecting each node once and every edge once. A
        // call site that resolved to several declarations fans out; the ambiguity count
        // keeps that visible instead of pretending precision.
        const MAX_NODES: usize = 2000;
        let mut seen: HashSet<DefKey> = roots.iter().copied().collect();
        let mut nodes: Vec<GraphNode> = roots.iter().map(|&key| self.node_of(&key, 0)).collect();
        let mut edges: Vec<GraphEdge> = Vec::new();
        let mut ambiguous = 0usize;
        let mut frontier: Vec<DefKey> = roots;
        for depth in 0..max_depth {
            let mut next: Vec<DefKey> = Vec::new();
            for key in &frontier {
                let Some(list) = adjacency.get(key) else {
                    continue;
                };
                let mut by_site: HashMap<(String, usize, usize), Vec<DefKey>> = HashMap::new();
                for (target, path, line, column) in list {
                    by_site
                        .entry((path.clone(), *line, *column))
                        .or_default()
                        .push(*target);
                }
                // Call order (line, then column) — the same order the sites appear in
                // the file, so the graph is stable across runs.
                let mut sites: Vec<((String, usize, usize), Vec<DefKey>)> =
                    by_site.into_iter().collect();
                sites.sort_by_key(|(site, _)| (site.1, site.2));
                for ((path, line, column), targets) in sites {
                    ambiguous += targets.len().saturating_sub(1);
                    for target in targets {
                        if seen.insert(target) {
                            nodes.push(self.node_of(&target, depth + 1));
                            if nodes.len() >= MAX_NODES {
                                return CallGraph {
                                    nodes,
                                    edges,
                                    ambiguous,
                                };
                            }
                            next.push(target);
                        }
                        edges.push(match direction {
                            // The site tuple's path is the file the call happens in —
                            // the caller's file, whichever way the graph walks.
                            Direction::Callees => GraphEdge {
                                from: self.endpoint_of(key),
                                to: self.endpoint_of(&target),
                                call_path: path.clone(),
                                call_line: line,
                                call_column: column,
                            },
                            Direction::Callers => GraphEdge {
                                from: self.endpoint_of(&target),
                                to: self.endpoint_of(key),
                                call_path: path.clone(),
                                call_line: line,
                                call_column: column,
                            },
                        });
                    }
                }
            }
            if next.is_empty() {
                break;
            }
            frontier = next;
        }
        CallGraph {
            nodes,
            edges,
            ambiguous,
        }
    }

    /// Every call relationship in the workspace at once (see [`WorkspaceCallGraph`]) —
    /// the Call Graph page's opening view, before any symbol is picked. Capped: a
    /// hundred-thousand-node SVG helps nobody; the page says what was left out, and the
    /// filter and the per-symbol walk cover the rest.
    pub fn workspace_call_graph(&self) -> WorkspaceCallGraph {
        const MAX_NODES: usize = 2000;
        const MAX_EDGES: usize = 6000;
        // Participants: every declaration that calls or is called. Emission in file
        // order keeps the caps deterministic run to run.
        let participants: HashSet<DefKey> = self
            .callees
            .keys()
            .chain(self.callers.keys())
            .copied()
            .collect();
        let total_nodes = participants.len();
        let mut kept: Vec<DefKey> = Vec::new();
        'emit: for (file_id, file) in self.files.iter().enumerate() {
            for symbol_id in 0..file.symbols.len() {
                let key = (file_id as u32, symbol_id as u32);
                if participants.contains(&key) {
                    kept.push(key);
                    if kept.len() >= MAX_NODES {
                        break 'emit;
                    }
                }
            }
        }
        let kept_set: HashSet<DefKey> = kept.iter().copied().collect();
        // Every distinct pair workspace-wide, so `total_edges` counts what the caps hid.
        let total_edges = self
            .callees
            .iter()
            .flat_map(|(caller, list)| list.iter().map(move |(target, ..)| (*caller, *target)))
            .collect::<HashSet<(DefKey, DefKey)>>()
            .len();
        // One drawn edge per pair, at the pair's first call site (call order). A site
        // that resolved to several same-named declarations fans out in `ambiguous`
        // exactly as the per-symbol walk counts it.
        let mut edges: Vec<GraphEdge> = Vec::new();
        let mut ambiguous = 0usize;
        let mut drawn: HashSet<(DefKey, DefKey)> = HashSet::new();
        let mut preds: HashMap<DefKey, Vec<DefKey>> = HashMap::new();
        for &caller in &kept {
            let Some(list) = self.callees.get(&caller) else {
                continue;
            };
            let mut by_site: HashMap<(String, usize, usize), Vec<DefKey>> = HashMap::new();
            for (target, path, line, column) in list {
                by_site
                    .entry((path.clone(), *line, *column))
                    .or_default()
                    .push(*target);
            }
            let mut sites: Vec<((String, usize, usize), Vec<DefKey>)> =
                by_site.into_iter().collect();
            sites.sort_by_key(|(site, _)| (site.1, site.2));
            for ((path, line, column), targets) in sites {
                let targets: Vec<DefKey> = targets
                    .into_iter()
                    .filter(|target| kept_set.contains(target))
                    .collect();
                if targets.is_empty() {
                    continue;
                }
                ambiguous += targets.len() - 1;
                for target in targets {
                    if drawn.insert((caller, target)) {
                        // The pair's first sight feeds the layering; the drawing stops
                        // at its own cap.
                        preds.entry(target).or_default().push(caller);
                        if edges.len() < MAX_EDGES {
                            edges.push(GraphEdge {
                                from: self.endpoint_of(&caller),
                                to: self.endpoint_of(&target),
                                call_path: path.clone(),
                                call_line: line,
                                call_column: column,
                            });
                        }
                    }
                }
            }
        }
        edges.sort_by(|a, b| {
            (&a.from.path, a.from.line, &a.to.path, a.to.line).cmp(&(
                &b.from.path,
                b.from.line,
                &b.to.path,
                b.to.line,
            ))
        });
        // Longest-path layering: a declaration no kept node calls sits at 0, everything
        // else one row below its deepest caller. A back edge (recursion, mutual
        // recursion) stops at the node already on the stack — the edge still draws,
        // just upward.
        let mut color: HashMap<DefKey, u8> = HashMap::new();
        let mut depth: HashMap<DefKey, u32> = HashMap::new();
        fn layer(
            key: DefKey,
            preds: &HashMap<DefKey, Vec<DefKey>>,
            color: &mut HashMap<DefKey, u8>,
            depth: &mut HashMap<DefKey, u32>,
        ) {
            if depth.contains_key(&key) {
                return;
            }
            color.insert(key, 1);
            let mut level = 0u32;
            if let Some(list) = preds.get(&key) {
                for &p in list {
                    if color.get(&p) == Some(&1) {
                        continue;
                    }
                    layer(p, preds, color, depth);
                    level = level.max(depth[&p] + 1);
                }
            }
            color.insert(key, 2);
            depth.insert(key, level);
        }
        for &key in &kept {
            layer(key, &preds, &mut color, &mut depth);
        }
        let nodes: Vec<GraphNode> = kept
            .iter()
            .map(|&key| {
                let mut node = self.node_of(&key, 0);
                node.depth = depth[&key];
                node
            })
            .collect();
        WorkspaceCallGraph {
            nodes,
            edges,
            ambiguous,
            total_nodes,
            total_edges,
        }
    }

    /// A shortest callee chain between any declaration of `from` and any declaration of
    /// `to` (a direct `from == to` identity is not a chain).
    pub fn call_path(&self, from: &str, to: &str) -> Option<Vec<GraphNode>> {
        let starts = self.by_name.get(from)?.clone();
        let goals: HashSet<DefKey> = self.by_name.get(to)?.iter().copied().collect();
        let mut parent: HashMap<DefKey, DefKey> = HashMap::new();
        let mut queue: VecDeque<DefKey> = VecDeque::new();
        for &start in &starts {
            queue.push_back(start);
        }
        let mut goal = None;
        while let Some(key) = queue.pop_front() {
            if goals.contains(&key) && !starts.contains(&key) {
                goal = Some(key);
                break;
            }
            if let Some(list) = self.callees.get(&key) {
                for (target, _, _, _) in list {
                    if !parent.contains_key(target) && !starts.contains(target) {
                        parent.insert(*target, key);
                        queue.push_back(*target);
                    }
                }
            }
        }
        let goal = goal?;
        let mut chain: Vec<DefKey> = Vec::new();
        let mut current = goal;
        while let Some(&step) = parent.get(&current) {
            chain.push(current);
            current = step;
        }
        chain.push(current);
        chain.reverse();
        Some(
            chain
                .iter()
                .enumerate()
                .map(|(i, &key)| self.node_of(&key, i as u32))
                .collect(),
        )
    }

    fn find_at(&self, path: &str, line: usize) -> Option<DefKey> {
        let file_id = self.files.iter().position(|f| f.path == path)? as u32;
        let file = &self.files[file_id as usize];
        let symbol_id = file
            .symbols
            .iter()
            .position(|s| s.line == line || (s.line..=s.end_line).contains(&line))?;
        Some((file_id, symbol_id as u32))
    }

    fn node_of(&self, key: &DefKey, depth: u32) -> GraphNode {
        let file = &self.files[key.0 as usize];
        let symbol = &file.symbols[key.1 as usize];
        GraphNode {
            kind: symbol.kind.to_owned(),
            name: symbol.name.clone(),
            container: symbol.container.clone(),
            path: file.path.clone(),
            line: symbol.line,
            complexity: symbol.complexity,
            signature: symbol.signature.clone(),
            depth,
        }
    }

    fn endpoint_of(&self, key: &DefKey) -> GraphEndpoint {
        let file = &self.files[key.0 as usize];
        let symbol = &file.symbols[key.1 as usize];
        GraphEndpoint {
            name: symbol.name.clone(),
            path: file.path.clone(),
            line: symbol.line,
        }
    }
}

/// The symbol whose body spans `line` in `file`, if one does. The first containing
/// declaration wins: two symbols that start on the same line are declaration order
/// (`impl A { fn go… fn step… }` puts a call on that line inside `go`, not `step`).
fn enclosing_symbol(file: &FileAnalysis, line: usize) -> Option<u32> {
    file.symbols
        .iter()
        .position(|s| s.line <= line && line <= s.end_line)
        .map(|id| id as u32)
}

/// Read and parse one file. `None` when it is gone or not decodable text.
fn parse_one(root: &str, relative: &str) -> Option<FileAnalysis> {
    let path = std::path::Path::new(root).join(relative);
    let (mtime_ms, size) = file_stat(&path)?;
    let text = std::fs::read_to_string(&path).ok()?;
    let ext = relative.rsplit_once('.')?.1;
    let ParsedFile {
        symbols,
        calls,
        imports,
    } = parse::parse_file(&text, ext);
    Some(FileAnalysis {
        path: relative.to_owned(),
        mtime_ms,
        size,
        symbols,
        calls,
        imports,
    })
}

fn file_stat(path: &std::path::Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some((mtime_ms, meta.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &std::path::Path, path: &str, text: &str) {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap_or(root)).unwrap();
        std::fs::write(file, text).unwrap();
    }

    fn built(root: &str) -> AnalysisData {
        AnalysisData::build(root, 4, &|_, _| {}, &|| false).unwrap()
    }

    #[test]
    fn call_edges_follow_names_and_receivers() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "a.rs",
            "pub struct Svc;\nimpl Svc {\n    pub fn run(&self) -> u32 { helper(); self.tune() }\n    pub fn tune(&self) -> u32 { 0 }\n}\npub fn tune() -> u32 { 1 }\n",
        );
        write(dir.path(), "b.rs", "fn helper() -> u32 { 2 }\n");
        let root = dir.path().display().to_string();
        let data = built(&root);

        // `self.tune()` resolves to the method only; nothing calls the free `tune`.
        let graph = data.call_graph("run", None, Direction::Callees, 2);
        let names: Vec<&str> = graph.nodes.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["run", "helper", "tune"]);
        assert_eq!(graph.edges.len(), 2);
        assert_eq!(graph.ambiguous, 0);

        // Callers of helper: Svc::run.
        let graph = data.call_graph("helper", None, Direction::Callers, 1);
        assert_eq!(graph.nodes.len(), 2);
        assert_eq!(graph.nodes[1].name, "run");
        assert_eq!(graph.edges[0].call_path, "a.rs");
        // The free `tune` (a.rs line 5) is never called; only the method is.
        let free_tune = data.call_graph("tune", Some(("a.rs", 5)), Direction::Callers, 1);
        assert_eq!(
            free_tune.nodes.len(),
            1,
            "no callers reach the free function"
        );
    }

    #[test]
    fn call_path_finds_a_chain() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "a.rs",
            "fn start() -> u32 { middle() }\nfn middle() -> u32 { leaf() }\nfn leaf() -> u32 { 0 }\n",
        );
        let root = dir.path().display().to_string();
        let data = built(&root);
        let chain = data.call_path("start", "leaf").expect("a chain exists");
        let names: Vec<&str> = chain.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["start", "middle", "leaf"]);
        assert!(
            data.call_path("leaf", "start").is_none(),
            "no reverse chain"
        );
    }

    #[test]
    fn watcher_batches_reparse_changed_files() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.rs", "fn alpha() { beta(); }\n");
        write(dir.path(), "b.rs", "fn beta() {}\n");
        let root = dir.path().display().to_string();
        let mut data = built(&root);
        assert_eq!(data.symbol_count(), 2);
        assert_eq!(data.incoming_count("beta"), 1);

        write(dir.path(), "b.rs", "fn other() {}\n");
        write(dir.path(), "c.rs", "fn gamma() { alpha(); }\n");
        data.apply_changes(&["b.rs".to_owned(), "c.rs".to_owned()]);
        assert_eq!(data.lookup("beta").len(), 0);
        assert_eq!(data.lookup("other").len(), 1);
        let graph = data.call_graph("alpha", None, Direction::Callers, 1);
        assert_eq!(graph.nodes.len(), 2);
        assert_eq!(graph.nodes[1].name, "gamma");
    }

    #[test]
    fn self_receiver_prefers_the_enclosing_type() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "s.rs",
            "struct A;\nstruct B;\nimpl A { pub fn go(&self) { self.step(); } pub fn step(&self) {} }\nimpl B { pub fn step(&self) {} }\n",
        );
        let root = dir.path().display().to_string();
        let data = built(&root);
        let graph = data.call_graph("go", None, Direction::Callees, 1);
        // self.step() inside A::go resolves to A::step only, not B::step.
        assert_eq!(graph.edges.len(), 1);
        assert_eq!(graph.nodes.len(), 2);
        assert_eq!(graph.nodes[1].container.as_deref(), Some("A"));
    }

    #[test]
    fn workspace_graph_covers_every_relationship() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "a.rs",
            "fn start() -> u32 { middle(); middle() }\nfn middle() -> u32 { helper() }\nfn helper() -> u32 { 7 }\nfn orphan() -> u32 { 0 }\n",
        );
        let root = dir.path().display().to_string();
        let data = built(&root);
        let graph = data.workspace_call_graph();
        // orphan joins no call relationship, so it is not a node; the two start→middle
        // sites fold into one edge at the first site.
        assert_eq!(graph.total_nodes, 3);
        assert_eq!(graph.total_edges, 2);
        assert_eq!(graph.nodes.len(), 3);
        assert_eq!(graph.edges.len(), 2);
        assert_eq!(graph.ambiguous, 0);
        let depth_of = |name: &str| graph.nodes.iter().find(|n| n.name == name).unwrap().depth;
        assert_eq!(depth_of("start"), 0);
        assert_eq!(depth_of("middle"), 1);
        assert_eq!(depth_of("helper"), 2);
        let first = &graph.edges[0];
        assert_eq!(
            first.call_line, 0,
            "the pair's first call site names the edge"
        );
    }

    #[test]
    fn workspace_graph_layers_cycles_without_hanging() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "a.rs",
            "fn ping() { pong() }\nfn pong() { ping() }\nfn lone() -> u32 { 1 }\n",
        );
        let root = dir.path().display().to_string();
        let data = built(&root);
        let graph = data.workspace_call_graph();
        // The mutual recursion lays out (a back edge stops the layering) and both
        // directions of the cycle draw.
        assert_eq!(graph.nodes.len(), 2);
        assert_eq!(graph.edges.len(), 2);
        assert!(graph.nodes.iter().all(|n| n.depth <= 1));
    }

    #[test]
    fn workspace_graph_counts_ambiguity_and_caps_the_drawing() {
        let dir = tempfile::tempdir().unwrap();
        let mut text = String::new();
        for i in 0..2100u32 {
            text.push_str(&format!("fn f{i:04}() -> u32 {{ f{:04}() }}\n", i + 1));
        }
        text.push_str("fn f2100() -> u32 { 0 }\n");
        // A bare call to a name declared twice: one site, two targets, one ambiguity.
        text.push_str("fn steer() {}\nstruct Car;\nimpl Car { fn steer(&self) {} }\n");
        text.push_str("fn drive() { steer() }\n");
        write(dir.path(), "a.rs", &text);
        let root = dir.path().display().to_string();
        let data = built(&root);
        let graph = data.workspace_call_graph();
        // 2101 chain participants + drive + both steers (lone f2100 is called, so in).
        assert_eq!(graph.total_nodes, 2104);
        assert_eq!(graph.nodes.len(), 2000, "the drawing caps at 2000 nodes");
        assert_eq!(graph.total_edges, 2102);
        assert!(graph.edges.len() <= 6000);
        assert!(graph.edges.len() < graph.total_edges, "the cap hid edges");
        // drive sits past the cap (file order), so its ambiguity is not drawn — the
        // count stays honest about what is shown.
        assert_eq!(graph.ambiguous, 0);
        let graph = data.call_graph("drive", None, Direction::Callees, 1);
        assert_eq!(graph.ambiguous, 1);
    }

    #[test]
    fn an_ambiguous_bare_call_fans_out_visibly() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "a.rs",
            "fn drive() { steer(); }\nfn steer() {}\nstruct Car;\nimpl Car { fn steer(&self) {} }\n",
        );
        let root = dir.path().display().to_string();
        let data = built(&root);
        let graph = data.call_graph("drive", None, Direction::Callees, 1);
        // The bare steer() matches both declarations — one call site, two edges.
        assert_eq!(graph.edges.len(), 2);
        assert_eq!(graph.nodes.len(), 3);
        assert_eq!(graph.ambiguous, 1);
    }
}
