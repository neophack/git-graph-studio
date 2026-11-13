//! ggs-analysis (L1, module 17): the Code Analysis engine — the in-memory workspace
//! model the five analysis tools read, plus the per-root `AnalysisIndex` (module `index`)
//! and the streaming report runners behind the app's command adapters. Where the symbol
//! store (ggs-index's `symbols::store`) is the persistent name-and-occurrence database,
//! this is the parsed-tree database — every source file's declarations, call sites and
//! imports (via ggs-index's `symbols::parse`), resolved into a workspace-wide call graph.
//! It lives only for the session (a restart rebuilds; parse speed makes persistence
//! unnecessary), updated file-by-file from the same watcher batches the symbol index eats.
//!
//! The model is compact by construction (module `model`): every string interns to a
//! `u32` over one shared table, each declaration and call site is one fixed-size
//! record, and the call resolution the engine used to materialize as per-edge rows —
//! the caller table and the callee table, each entry carrying a cloned file path — is
//! not stored at all. A call site stores how its name resolved (one [`ResolveClass`]
//! byte, decided once at derive time with the same pecking order the old resolver
//! walked), and both graph directions re-derive the targets from that record at query
//! time: the unique or receiver-narrowed target set is a slice of the name index, and
//! membership tests are O(1). On the corpus that used to take ~3.8 GB resident and
//! ~15 GB at the Module Analysis peak, the same analysis now sits in the tens of
//! megabytes and the reports stream in bounded batches.
//!
//! Resolution is honest about what it is: name matching with receiver hints, not type
//! inference. A call edge exists when a call site's spelling matches a declaration —
//! preferring methods whose container matches the receiver, and `self`/`this` receivers
//! preferring the enclosing type's methods. Ambiguity stays visible (one call site may
//! fan out to several same-named declarations), and every call-site name is recorded so
//! the dead-code report can stay conservative.

pub mod bca;
pub mod deadcode;
pub mod diagram;
pub mod imports;
pub mod index;
pub mod metrics;
pub mod model;
pub mod modules;
pub mod security;

pub use model::{Call, Names, ResolveClass, Sym, SymKind, NONE};

use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use rayon::prelude::*;

use ggs_fs::walk_files;
use ggs_index::scan::is_symbol_source;
use ggs_index::symbols::parse::{self, ParsedFile};

/// Files per progress batch; also the cancellation checkpoint (the symbol store's rhythm).
pub const BUILD_BATCH: usize = 256;

/// One file's analysis content plus the fingerprint it was parsed at. The records are
/// compact (module `model`): names are [`Names`] ids and the call sites carry their
/// owner and resolution class. The owner table (`owner_heads`/`owner_order`) is the
/// per-file CSR from declaration to its call sites, in document order.
pub struct FileAnalysis {
    pub path: String,
    pub mtime_ms: u64,
    pub size: u64,
    pub symbols: Vec<Sym>,
    pub calls: Vec<Call>,
    pub imports: Vec<u32>,
    pub owner_heads: Vec<u32>,
    pub owner_order: Vec<u32>,
}

impl FileAnalysis {
    /// The file's call sites owned by symbol `symbol_index`, in document order.
    pub fn calls_of(&self, symbol_index: u32) -> &[u32] {
        let start = self.owner_heads[symbol_index as usize] as usize;
        let end = self.owner_heads[symbol_index as usize + 1] as usize;
        &self.owner_order[start..end]
    }
}

/// A declaration's address: the file's index in `files` and the symbol's index in the
/// file's `symbols`. Only meaningful inside one `AnalysisData`.
pub type DefKey = (u32, u32);

/// A declaration decoded for reading: the interned strings as slices, the shape as
/// measured. Everything the reports and the graph nodes show.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SymView<'a> {
    pub name: &'a str,
    pub container: Option<&'a str>,
    pub kind: SymKind,
    pub exported: bool,
    pub params: u16,
    pub complexity: u16,
    pub nesting: u8,
    pub line: u32,
    pub end_line: u32,
    pub signature: &'a str,
}

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

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Callers,
    Callees,
}

/// The workspace analysis of one root: the compact parsed files plus the derived name
/// index. The call graph itself is never materialized — it is re-derived from the call
/// sites' resolution classes on demand (see the module doc).
pub struct AnalysisData {
    root: String,
    names: Names,
    /// Every declaration's signature, one arena (offsets live in the [`Sym`] records).
    sigs: String,
    /// Sorted by path.
    files: Vec<FileAnalysis>,
    /// Global call-id bases: file `i`'s calls are ids `call_bases[i]..call_bases[i+1]`.
    call_bases: Vec<u32>,
    /// Declarations CSR by name id: `decls[decl_heads[name]..decl_heads[name + 1]]`,
    /// file order then declaration order within a name.
    decl_heads: Vec<u32>,
    decls: Vec<DefKey>,
    /// Every container id any declaration names — the receiver-narrowing gate.
    containers: HashSet<u32>,
    /// Name ids at least one call site spells (the dead-code shield), one bit per name.
    called: Vec<u64>,
    /// Call sites CSR by name id: global call ids grouped by `call.name`, file order
    /// then document order within a name — what the callers direction walks.
    site_heads: Vec<u32>,
    site_order: Vec<u32>,
    symbols_total: usize,
    calls_total: usize,
}

impl AnalysisData {
    /// The empty analysis (nothing built yet).
    pub fn empty(root: &str) -> AnalysisData {
        AnalysisData {
            root: root.to_owned(),
            names: Names::new(),
            sigs: String::new(),
            files: Vec::new(),
            call_bases: vec![0],
            decl_heads: vec![0],
            decls: Vec::new(),
            containers: HashSet::new(),
            called: Vec::new(),
            site_heads: vec![0],
            site_order: Vec::new(),
            symbols_total: 0,
            calls_total: 0,
        }
    }

    pub fn root(&self) -> &str {
        &self.root
    }

    /// The interned string table (the reports decode call-site names through it).
    pub fn names(&self) -> &Names {
        &self.names
    }

    pub fn name(&self, id: u32) -> &str {
        self.names.get(id)
    }

    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    pub fn symbol_count(&self) -> usize {
        self.symbols_total
    }

    pub fn call_count(&self) -> usize {
        self.calls_total
    }

    pub fn files(&self) -> &[FileAnalysis] {
        &self.files
    }

    /// One declaration, decoded.
    pub fn symbol(&self, key: DefKey) -> SymView<'_> {
        let file = &self.files[key.0 as usize];
        self.decode_sym(&file.symbols[key.1 as usize])
    }

    /// One raw record decoded with its file path already at hand.
    pub(crate) fn symbol_of_raw(&self, sym: &Sym) -> SymView<'_> {
        self.decode_sym(sym)
    }

    fn decode_sym(&self, sym: &Sym) -> SymView<'_> {
        SymView {
            name: self.names.get(sym.name),
            container: (sym.container != NONE).then(|| self.names.get(sym.container)),
            kind: sym.kind,
            exported: sym.exported,
            params: sym.params,
            complexity: sym.complexity,
            nesting: sym.nesting,
            line: sym.line,
            end_line: sym.end_line,
            signature: self.signature_of(sym),
        }
    }

    /// Whether any call site in the workspace spells the interned `name` id.
    pub(crate) fn called_id(&self, name: u32) -> bool {
        let (word, bit) = (name / 64, name % 64);
        self.called
            .get(word as usize)
            .is_some_and(|word| word & (1u64 << bit) != 0)
    }

    pub(crate) fn signature_of(&self, sym: &Sym) -> &str {
        let start = sym.sig_off as usize;
        &self.sigs[start..start + sym.sig_len as usize]
    }

    /// Every declaration of exactly `name`, with its file path.
    pub fn lookup(&self, name: &str) -> Vec<(String, DefKey)> {
        let Some(id) = self.names.find(name) else {
            return Vec::new();
        };
        self.decl_range(id)
            .iter()
            .map(|&key| (self.files[key.0 as usize].path.clone(), key))
            .collect()
    }

    /// How many call sites resolve to any declaration of `name`.
    pub fn incoming_count(&self, name: &str) -> usize {
        let Some(id) = self.names.find(name) else {
            return 0;
        };
        self.site_range(id)
            .iter()
            .map(|&gid| {
                let call = self.call(gid);
                self.resolved_len(call, self.file_of_call(gid))
            })
            .sum()
    }

    /// Whether any call site in the workspace spells `name` (resolved or not).
    pub fn called_anywhere(&self, name: &str) -> bool {
        let Some(id) = self.names.find(name) else {
            return false;
        };
        let (word, bit) = (id / 64, id % 64);
        self.called
            .get(word as usize)
            .is_some_and(|word| word & (1u64 << bit) != 0)
    }

    /// The names every interface declares — dead code skips their methods (dynamic
    /// dispatch makes "no callers" meaningless there).
    pub fn interface_containers(&self) -> HashSet<u32> {
        self.files
            .iter()
            .flat_map(|f| f.symbols.iter())
            .filter(|s| s.kind == SymKind::Interface)
            .map(|s| s.name)
            .collect()
    }

    /* ---------- Building ---------- */

    /// The full build: parse every source file under `root` (parallel), intern into the
    /// compact records (per batch, serial), then derive the tables. `report` fires once
    /// per batch; `cancelled` is honoured between batches. `None` means cancelled —
    /// nothing is installed.
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
            let mut data = AnalysisData::empty(root);
            for batch in paths.chunks(BUILD_BATCH) {
                if cancelled() {
                    return None;
                }
                let mut parsed: Vec<ParsedOne> = batch
                    .par_iter()
                    .filter_map(|relative| read_one(root, relative))
                    .collect();
                // The interning pass is serial on purpose: one shared table, no lock,
                // and the strings never outlive this loop.
                for one in parsed.drain(..) {
                    data.files.push(convert(&mut data.names, &mut data.sigs, one));
                }
                report(data.files.len(), total);
            }
            data.files.sort_by(|a, b| a.path.cmp(&b.path));
            data.derive();
            Some(data)
        })
    }

    /// Recompute the derived tables over the current files (after a build or an
    /// incremental change): the name CSR, the call sites' owner and resolution class,
    /// the called-name bitset — and nothing else. The call graph is derived on demand.
    fn derive(&mut self) {
        self.call_bases.clear();
        self.call_bases.push(0u32);
        let mut running = 0u32;
        for file in &self.files {
            running += file.calls.len() as u32;
            self.call_bases.push(running);
        }
        self.symbols_total = self.files.iter().map(|f| f.symbols.len()).sum();
        self.calls_total = running as usize;

        let name_count = self.names.len() as u32;
        self.decl_heads = vec![0u32; name_count as usize + 1];
        self.site_heads = vec![0u32; name_count as usize + 1];
        self.called = vec![0u64; name_count.div_ceil(64) as usize];
        self.containers.clear();
        self.decls.clear();
        self.site_order.clear();

        // Pass 1: counts — declarations per name, call sites per name, the called
        // bitset, the container set.
        for file in &self.files {
            for symbol in &file.symbols {
                self.decl_heads[symbol.name as usize + 1] += 1;
                if symbol.container != NONE {
                    self.containers.insert(symbol.container);
                }
            }
            for call in &file.calls {
                self.site_heads[call.name as usize + 1] += 1;
                let (word, bit) = (call.name / 64, call.name % 64);
                self.called[word as usize] |= 1u64 << bit;
            }
        }
        for i in 0..name_count as usize {
            self.decl_heads[i + 1] += self.decl_heads[i];
            self.site_heads[i + 1] += self.site_heads[i];
        }
        self.decls = vec![(0u32, 0u32); self.symbols_total];
        self.site_order = vec![0u32; self.calls_total];
        // Pass 2: placement — files iterate in path order and symbols in document
        // order, so each name's slice is (file, declaration) ordered, and each call
        // name's slice is (file, position) ordered — the graph walks' stable output
        // order.
        let mut decl_cursor = self.decl_heads[..name_count as usize].to_vec();
        let mut site_cursor = self.site_heads[..name_count as usize].to_vec();
        for (file_idx, file) in self.files.iter().enumerate() {
            let file_idx = file_idx as u32;
            for (symbol_idx, symbol) in file.symbols.iter().enumerate() {
                let at = decl_cursor[symbol.name as usize] as usize;
                self.decls[at] = (file_idx, symbol_idx as u32);
                decl_cursor[symbol.name as usize] += 1;
            }
            let base = self.call_bases[file_idx as usize];
            for (call_idx, call) in file.calls.iter().enumerate() {
                let at = site_cursor[call.name as usize] as usize;
                self.site_order[at] = base + call_idx as u32;
                site_cursor[call.name as usize] += 1;
            }
        }

        // Pass 3: per call site — which declaration owns it, and how its name
        // resolved. The sweep attributes owners in O(1) amortized per call (the
        // first-containing declaration in document order, the rule the old linear
        // scan applied); the classification is the old resolver's pecking order,
        // decided once here. The tables the classification reads were snapshotted
        // above, so the pass holds disjoint borrows from the `files` it mutates.
        for file in &mut self.files {
            let mut cursor = 0usize;
            for call in file.calls.iter_mut() {
                call.owner = enclosing_sweep(&file.symbols, &mut cursor, call.line);
            }
        }
        // The classification reads every candidate declaration's container, in any
        // file — one flat snapshot of the container ids keeps the pass below free of
        // aliasing with the mutable call records.
        let mut sym_bases = Vec::with_capacity(self.files.len() + 1);
        let mut running = 0u32;
        for file in &self.files {
            sym_bases.push(running);
            running += file.symbols.len() as u32;
        }
        sym_bases.push(running);
        let containers_by_def: Vec<u32> = self
            .files
            .iter()
            .flat_map(|file| file.symbols.iter().map(|sym| sym.container))
            .collect();
        let container_of =
            |key: DefKey| containers_by_def[sym_bases[key.0 as usize] as usize + key.1 as usize];
        let (decl_heads, decls, containers, names) =
            (&self.decl_heads, &self.decls, &self.containers, &self.names);
        for file in &mut self.files {
            // Field-precise borrows: the classification reads the symbols while the
            // calls are being written.
            let FileAnalysis { symbols, calls, .. } = file;
            for call in calls.iter_mut() {
                call.class = classify_call(
                    call,
                    symbols,
                    decl_heads,
                    decls,
                    containers,
                    names,
                    &container_of,
                );
            }
            // The owner CSR: calls grouped by their declaration, document order
            // within each.
            let mut counts = vec![0u32; file.symbols.len() + 1];
            for call in &file.calls {
                let owner = if call.owner == NONE {
                    file.symbols.len()
                } else {
                    call.owner as usize
                };
                counts[owner] += 1;
            }
            let mut heads = Vec::with_capacity(counts.len() + 1);
            let mut running = 0u32;
            for &count in &counts {
                heads.push(running);
                running += count;
            }
            heads.push(running);
            let mut order = vec![0u32; file.calls.len()];
            let mut cursor = heads[..counts.len()].to_vec();
            for (call_idx, call) in file.calls.iter().enumerate() {
                let owner = if call.owner == NONE {
                    file.symbols.len()
                } else {
                    call.owner as usize
                };
                order[cursor[owner] as usize] = call_idx as u32;
                cursor[owner] += 1;
            }
            file.owner_heads = heads;
            file.owner_order = order;
        }
    }

    /* ---------- Lazy resolution ---------- */

    fn decl_range(&self, name: u32) -> &[DefKey] {
        let start = self.decl_heads[name as usize] as usize;
        let end = self.decl_heads[name as usize + 1] as usize;
        &self.decls[start..end]
    }

    fn site_range(&self, name: u32) -> &[u32] {
        let start = self.site_heads[name as usize] as usize;
        let end = self.site_heads[name as usize + 1] as usize;
        &self.site_order[start..end]
    }

    /// One declaration's container id (`NONE` when it has none) without a decode.
    fn container_of(&self, key: DefKey) -> u32 {
        self.files[key.0 as usize].symbols[key.1 as usize].container
    }

    /// One global call id decoded to its record.
    pub(crate) fn call(&self, id: u32) -> &Call {
        let file_idx = self.file_of_call(id);
        &self.files[file_idx as usize].calls[(id - self.call_bases[file_idx as usize]) as usize]
    }

    /// One global call id decoded to its file.
    pub(crate) fn file_of_call(&self, id: u32) -> u32 {
        self.call_bases
            .partition_point(|&base| base <= id)
            .saturating_sub(1) as u32
    }

    /// Every declaration a call site (may) reach: the name index's slice for the
    /// unambiguous classes, a filtered Vec for the narrowed ones (small, transient —
    /// one allocation per queried site, never stored).
    fn resolved_targets(&self, call: &Call, file_idx: u32) -> Cow<'_, [DefKey]> {
        let candidates = self.decl_range(call.name);
        match call.class {
            ResolveClass::Unique | ResolveClass::AllCandidates => Cow::Borrowed(candidates),
            ResolveClass::ByContainer => {
                let wanted = call.receiver;
                Cow::Owned(
                    candidates
                        .iter()
                        .copied()
                        .filter(|&key| self.container_of(key) == wanted)
                        .collect(),
                )
            }
            ResolveClass::SelfType => {
                let wanted = self.self_target_of(call, file_idx);
                Cow::Owned(
                    candidates
                        .iter()
                        .copied()
                        .filter(|&key| self.container_of(key) == wanted)
                        .collect(),
                )
            }
        }
    }

    /// How many declarations a call site (may) reach.
    fn resolved_len(&self, call: &Call, file_idx: u32) -> usize {
        match call.class {
            ResolveClass::Unique | ResolveClass::AllCandidates => {
                self.decl_range(call.name).len()
            }
            ResolveClass::ByContainer | ResolveClass::SelfType => {
                self.resolved_targets(call, file_idx).len()
            }
        }
    }

    /// Whether the call's resolution reaches `target` — O(1) by the stored class.
    fn resolves_to(&self, call: &Call, target: DefKey, file_idx: u32) -> bool {
        match call.class {
            ResolveClass::Unique => self.decl_range(call.name) == [target],
            ResolveClass::AllCandidates => true,
            ResolveClass::ByContainer => self.container_of(target) == call.receiver,
            ResolveClass::SelfType => {
                self.container_of(target) == self.self_target_of(call, file_idx)
            }
        }
    }

    /// The container id a `self`/`this` call resolves through: its owner declaration's
    /// container, or the declaration itself when it has none (a free function is its
    /// own scope). `NONE` when the call has no owner.
    fn self_target_of(&self, call: &Call, file_idx: u32) -> u32 {
        if call.owner == NONE {
            return NONE;
        }
        let owner = &self.files[file_idx as usize].symbols[call.owner as usize];
        if owner.container != NONE {
            owner.container
        } else {
            owner.name
        }
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
            .filter_map(|path| {
                read_one(&root, path).map(|one| {
                    convert(&mut self.names, &mut self.sigs, one)
                })
            })
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
            None => self
                .names
                .find(name)
                .map(|id| self.decl_range(id).to_vec())
                .unwrap_or_default(),
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
                match direction {
                    Direction::Callees => {
                        let file = &self.files[key.0 as usize];
                        for &call_idx in file.calls_of(key.1) {
                            let call = &file.calls[call_idx as usize];
                            let targets = self.resolved_targets(call, key.0);
                            ambiguous += targets.len().saturating_sub(1);
                            for &target in targets.iter() {
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
                                edges.push(GraphEdge {
                                    from: self.endpoint_of(key),
                                    to: self.endpoint_of(&target),
                                    call_path: file.path.clone(),
                                    call_line: call.line as usize,
                                    call_column: call.column as usize,
                                });
                            }
                        }
                    }
                    Direction::Callers => {
                        let name_id = self.files[key.0 as usize].symbols[key.1 as usize].name;
                        for &gid in self.site_range(name_id) {
                            let call = self.call(gid);
                            let caller_file = self.file_of_call(gid);
                            if call.owner == NONE || !self.resolves_to(call, *key, caller_file) {
                                continue;
                            }
                            let caller = (caller_file, call.owner);
                            if seen.insert(caller) {
                                nodes.push(self.node_of(&caller, depth + 1));
                                if nodes.len() >= MAX_NODES {
                                    return CallGraph {
                                        nodes,
                                        edges,
                                        ambiguous,
                                    };
                                }
                                next.push(caller);
                            }
                            edges.push(GraphEdge {
                                from: self.endpoint_of(&caller),
                                to: self.endpoint_of(key),
                                call_path: self.files[caller_file as usize].path.clone(),
                                call_line: call.line as usize,
                                call_column: call.column as usize,
                            });
                        }
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

    /// Every resolved cross-file call, streamed to `visit` in caller order (file, then
    /// declaration, then call position) — the Module Analysis report's material. The
    /// report folds pairs as they stream instead of ever holding the whole set (the
    /// ambiguity fan-out used to make that set the engine's largest allocation).
    /// Calls from top-level code (no owning declaration) do not stream, exactly as the
    /// caller table never carried them.
    pub(crate) fn walk_resolved(
        &self,
        mut visit: impl FnMut(u32, u32, &Call, DefKey),
    ) {
        for (file_idx, file) in self.files.iter().enumerate() {
            let file_idx = file_idx as u32;
            for sym_idx in 0..file.symbols.len() as u32 {
                for &call_idx in file.calls_of(sym_idx) {
                    let call = &file.calls[call_idx as usize];
                    for target in self.resolved_targets(call, file_idx).iter() {
                        visit(file_idx, sym_idx, call, *target);
                    }
                }
            }
        }
    }

    /// A shortest callee chain between any declaration of `from` and any declaration of
    /// `to` (a direct `from == to` identity is not a chain).
    pub fn call_path(&self, from: &str, to: &str) -> Option<Vec<GraphNode>> {
        let (start_id, goal_id) = (self.names.find(from)?, self.names.find(to)?);
        let starts = self.decl_range(start_id);
        let goals: HashSet<DefKey> = self.decl_range(goal_id).iter().copied().collect();
        let mut parent: HashMap<DefKey, DefKey> = HashMap::new();
        let mut queue: VecDeque<DefKey> = VecDeque::new();
        for &start in starts {
            queue.push_back(start);
        }
        let mut goal = None;
        while let Some(key) = queue.pop_front() {
            if goals.contains(&key) && !starts.contains(&key) {
                goal = Some(key);
                break;
            }
            let file = &self.files[key.0 as usize];
            for &call_idx in file.calls_of(key.1) {
                let call = &file.calls[call_idx as usize];
                for target in self.resolved_targets(call, key.0).iter() {
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
        let line = line as u32;
        let mut cursor = 0usize;
        let symbol_id = match enclosing_sweep(&file.symbols, &mut cursor, line) {
            NONE => None,
            id => Some(id),
        }?;
        Some((file_id, symbol_id))
    }

    fn node_of(&self, key: &DefKey, depth: u32) -> GraphNode {
        let view = self.symbol(*key);
        GraphNode {
            kind: view.kind.as_str().to_owned(),
            name: view.name.to_owned(),
            container: view.container.map(str::to_owned),
            path: self.files[key.0 as usize].path.clone(),
            line: view.line as usize,
            complexity: u32::from(view.complexity),
            signature: view.signature.to_owned(),
            depth,
        }
    }

    fn endpoint_of(&self, key: &DefKey) -> GraphEndpoint {
        let view = self.symbol(*key);
        GraphEndpoint {
            name: view.name.to_owned(),
            path: self.files[key.0 as usize].path.clone(),
            line: view.line as usize,
        }
    }
}

/// How a call's spelling resolves — the old resolver's pecking order, once:
/// one declaration wins outright; otherwise a receiver naming a known type takes
/// its methods; otherwise `self`/`this` takes the enclosing type's; otherwise
/// every declaration of the name stands (the visible ambiguity). A free function
/// over the derived tables and the container snapshot, so the derive pass can call
/// it while mutating the call records.
fn classify_call(
    call: &Call,
    file_symbols: &[Sym],
    decl_heads: &[u32],
    decls: &[DefKey],
    containers: &HashSet<u32>,
    names: &Names,
    container_of: &dyn Fn(DefKey) -> u32,
) -> ResolveClass {
    let start = decl_heads[call.name as usize] as usize;
    let end = decl_heads[call.name as usize + 1] as usize;
    let candidates = &decls[start..end];
    if candidates.len() <= 1 {
        return ResolveClass::Unique;
    }
    if call.receiver != NONE
        && containers.contains(&call.receiver)
        && candidates
            .iter()
            .any(|&key| container_of(key) == call.receiver)
    {
        return ResolveClass::ByContainer;
    }
    if call.receiver != NONE
        && matches!(names.get(call.receiver), "self" | "this")
        && call.owner != NONE
    {
        let owner = &file_symbols[call.owner as usize];
        let enclosing = if owner.container != NONE {
            owner.container
        } else {
            owner.name
        };
        if candidates.iter().any(|&key| container_of(key) == enclosing) {
            return ResolveClass::SelfType;
        }
    }
    ResolveClass::AllCandidates
}

/// The first declaration whose span contains `line` (document order wins on ties), with
/// an O(1)-amortized cursor: a declaration whose end passed the line can never contain
/// a later line, so the cursor only ever moves forward. Calls stream in document order,
/// so one sweep per file assigns every owner.
fn enclosing_sweep(symbols: &[Sym], cursor: &mut usize, line: u32) -> u32 {
    while *cursor < symbols.len() && symbols[*cursor].end_line < line {
        *cursor += 1;
    }
    match symbols.get(*cursor) {
        Some(sym) if sym.line <= line => *cursor as u32,
        _ => NONE,
    }
}

/// A file read and parsed by a build worker — everything `convert` needs to intern.
pub(crate) struct ParsedOne {
    pub(crate) path: String,
    pub(crate) mtime_ms: u64,
    pub(crate) size: u64,
    pub(crate) parsed: ParsedFile,
}

/// Read and parse one file. `None` when it is gone. Non-UTF-8 bytes decode lossily — the
/// ASCII identifiers and string literals survive, so a GBK or UTF-16 file keeps its
/// declarations and stays scannable instead of silently dropping out of the `files`
/// count — and an extension-less name parses under the outline fallback (its extension
/// table answers nothing) rather than being skipped.
fn read_one(root: &str, relative: &str) -> Option<ParsedOne> {
    let path = std::path::Path::new(root).join(relative);
    let (mtime_ms, size) = file_stat(&path)?;
    let bytes = std::fs::read(&path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let ext = relative
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or("");
    let parsed = parse::parse_file(&text, ext);
    Some(ParsedOne {
        path: relative.to_owned(),
        mtime_ms,
        size,
        parsed,
    })
}

/// Intern one parsed file into the compact records. The parse layer's shapes clamp to
/// the record's fields (a declaration with 70 000 parameters is a generated oddity, not
/// a number the reports need exactly).
pub(crate) fn convert(names: &mut Names, sigs: &mut String, one: ParsedOne) -> FileAnalysis {
    let ParsedOne {
        path,
        mtime_ms,
        size,
        parsed,
    } = one;
    let mut symbols = Vec::with_capacity(parsed.symbols.len());
    for s in parsed.symbols {
        let sig_off = sigs.len() as u32;
        let sig_len = s.signature.len().min(u16::MAX as usize) as u16;
        sigs.push_str(&s.signature[..sig_len as usize]);
        symbols.push(Sym {
            name: names.intern(&s.name),
            container: s
                .container
                .as_deref()
                .map(|c| names.intern(c))
                .unwrap_or(NONE),
            kind: SymKind::of_capture(s.kind),
            exported: s.exported,
            params: s.params.min(u16::MAX as usize) as u16,
            complexity: s.complexity.min(u16::MAX as u32) as u16,
            nesting: s.nesting.min(u8::MAX as u32) as u8,
            line: s.line as u32,
            end_line: s.end_line as u32,
            sig_off,
            sig_len,
        });
    }
    let calls = parsed
        .calls
        .into_iter()
        .map(|c| Call {
            name: names.intern(&c.name),
            receiver: c
                .receiver
                .as_deref()
                .map(|r| names.intern(r))
                .unwrap_or(NONE),
            line: c.line as u32,
            column: c.column as u32,
            owner: NONE,
            class: ResolveClass::Unique,
        })
        .collect();
    let imports = parsed
        .imports
        .iter()
        .map(|import| names.intern(import))
        .collect();
    FileAnalysis {
        path,
        mtime_ms,
        size,
        symbols,
        calls,
        imports,
        owner_heads: Vec::new(),
        owner_order: Vec::new(),
    }
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

    #[test]
    fn a_top_level_call_never_panics_the_callers_walk() {
        // A call outside any declaration body used to land in the caller table as a
        // pseudo-declaration the walk then dereferenced; the compact model skips it,
        // like the callee table always did.
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "main.js",
            "function boot() {}\nboot();\n",
        );
        let root = dir.path().display().to_string();
        let data = built(&root);
        let graph = data.call_graph("boot", None, Direction::Callers, 1);
        assert_eq!(graph.nodes.len(), 1, "no caller is recorded for top-level code");
        assert_eq!(graph.edges.len(), 0);
    }

    #[test]
    fn the_name_index_stays_compact_and_correct() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "a.rs",
            "fn shared() {}\npub struct Svc;\nimpl Svc { fn shared(&self) {} }\nfn user() { shared(); shared(); }\n",
        );
        let root = dir.path().display().to_string();
        let data = built(&root);
        assert_eq!(data.lookup("shared").len(), 2);
        // Two call sites, each fanning to both declarations.
        assert_eq!(data.incoming_count("shared"), 4);
        assert!(data.called_anywhere("shared"));
        assert!(!data.called_anywhere("never"));
        assert_eq!(data.call_count(), 2);
        assert_eq!(data.symbol_count(), 4);
    }
}
