//! The relation queries behind the Relation window: one subject
//! definition's inbound ring (`refsTo` — who references it), outbound ring (`refsFrom`
//! — what its body references), and member ring (`contains` — the declarations whose
//! container is the subject, the type's own fold-out), every child carried with the
//! reference site that produced the edge. Inbound rides the same occurrence-narrowed
//! whole-word scan Find References
//! speaks, and the store's per-file def intervals attribute each raw hit to the definition
//! that owns its line — so a declaration line is skipped and a call inside a caller's body
//! names that caller. Hits the file's comment/string mask covers
//! ([`crate::symbols::mask`]) are the comment's or string's own words, not code,
//! and go. Outbound reads the subject's own file once and resolves every distinct word of
//! its body — unmasked body words — against the store's declarations. `contains` is a pure
//! store query (the container is an interned name, `SymbolStore::members_of`) and needs no
//! file reads at all. Repeated sites of
//! one edge merge into the single node whose `edge_count` accumulates and whose
//! `edge_line` keeps the earliest site — the callers-and-calls count, one node per
//! counterpart — and whose `edge_lines` keeps every site's line (ascending, at most
//! [`MAX_EDGE_LINES`]), the numbered rows the relation graph draws under a multi-site
//! card (the reference reconstruction's ShowGraphDetails, "N. line L"). Nothing here
//! materializes the index: each step asks
//! the store for one file's rows or one name's declarations.
//!
//! One call answers one ring under one wall-clock budget (a time-slice
//! discipline): the expansion stops mid-scan when the budget runs out and `truncated`
//! says the ring was cut — the same flag the node cap trips.
//!
//! The caller (the command adapter, over [`crate::symbols::index::SymbolIndex::with_store`])
//! holds the store's lock for the computation's length, so the per-file reads stay
//! consistent — the same bargain `symbols_with_refs` makes when it clones the whole index
//! under the lock.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::scan::read_searchable;
use crate::symbols::index::scan_references_bounded;
use crate::symbols::mask::{mask_for_ext, CodeMask};
use crate::symbols::sites::{lang_family, same_lang_family};
use crate::symbols::store::{FileOutlineRow, SymbolStore};
use crate::symbols::WorkspaceSymbol;

/// The children one direction returns at most: the window expands ring by ring, and a
/// hub name's caller list is read, not painted as a graph. The 64-children cap keeps
/// every node's ring answerable — the overflow is reported, not painted; the
/// same ceiling here marks the answer truncated — the ring had more to show.
const MAX_NODES: usize = 64;
/// One relation call's wall-clock budget, a time-slice discipline: a
/// pathological workspace stops the expansion mid-scan (`truncated`) instead of holding
/// the store's lock past the user's patience.
const RELATION_BUDGET_MS: u64 = 250;
/// Distinct words a body scan resolves at most; a giant function stops there.
const MAX_WORDS: usize = 2000;
/// A refsTo peek stays precise while the child's name occurs in at most this many files
/// (the peek rescans just those and re-attributes); a hotter name — and a list the store
/// does not trust — takes the optimistic heuristic, because the truth would cost
/// Find-References-scale work per child, up to [`MAX_NODES`] children per ring.
const PEEK_FILE_CAP: usize = 16;
/// The bounded scan's kept window. The exact total streams past regardless; the window
/// only holds the head the attribution consumes, and skips (declaration lines, sites no
/// interval covers) may eat into it before a real edge lands.
const SCAN_KEEP: usize = 4096;
/// A node's edge keeps at most this many site lines — the numbered rows the graph card
/// draws under it; `edge_count` stays the whole truth past the cap, the "+N" tail the
/// card appends reading its remainder.
const MAX_EDGE_LINES: usize = 16;
/// The budget check's rhythm: the clock is read every 32
/// files or 256 hits, not on every item — the check itself is never the scan's cost.
const BUDGET_FILES_PER_CHECK: usize = 32;
const BUDGET_HITS_PER_CHECK: usize = 256;

/// One child of the relation tree: the referencing (or referenced) definition with the
/// reference site that produced the edge. Serialized to the workbench as-is.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelationNode {
    pub kind: String,
    pub name: String,
    pub container: Option<String>,
    /// The node's own definition: repo-relative path, 0-based line.
    pub path: String,
    pub line: usize,
    /// The earliest reference site this edge came from: repo-relative path, 0-based line.
    pub edge_path: String,
    pub edge_line: usize,
    /// `call` when the site reaches an argument list, `use` for any other reference.
    pub edge_kind: String,
    /// How many reference sites this edge aggregates — the callers-and-calls count.
    pub edge_count: usize,
    /// Every kept site's 0-based line, ascending, at most [`MAX_EDGE_LINES`] — the
    /// numbered rows the graph card draws for a multi-site edge (ShowGraphDetails).
    pub edge_lines: Vec<usize>,
    /// In a combined `CallsAndCallers` ring, whether this node came from the caller side
    /// (`Some(true)`) or the callee side (`Some(false)`) — same-file callers included.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller_side: Option<bool>,
    /// Whether expanding this node again yields children — best effort (the peek
    /// helpers below document which side answers precisely and which heuristically).
    pub has_children: bool,
}

/// One ring's answer: the children and whether the ring was cut short — the node cap or
/// the time budget ran out with unshown nodes left.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelationAnswer {
    pub nodes: Vec<RelationNode>,
    pub truncated: bool,
}

/// The one call's wall-clock budget, borrowed by the direction and its peeks alike — a
/// peek under an expired budget answers empty at once, and the ring stops expanding.
struct Budget(Instant);

impl Budget {
    /// A budget of 0 ms is spent before the first item.
    fn after(ms: u64) -> Budget {
        Budget(Instant::now() + Duration::from_millis(ms))
    }

    fn expired(&self) -> bool {
        Instant::now() >= self.0
    }
}

/// `refsTo`: who references the subject. `refsFrom`: what the subject references.
/// `contains`: the members declared inside the subject. The remaining ten kinds
/// (added 2026-11-20) complete the relation-type set: Calls (the call edges out),
/// Callers (the call edges in), Calls and Callers (both, caller branches first),
/// Referenced by Functions (== refsTo), Referenced by Files / Modules (the references
/// keyed by their file — files are leaves), Container (the enclosing type, the chain
/// walked upward one ring per drill), Member Types / Member Classes (the members by
/// kind), Types Used (the type-category declarations the body references), Base Classes
/// / Derived Classes (the inheritance the parser captures).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelationKind {
    RefsTo,
    RefsFrom,
    Contains,
    Calls,
    Callers,
    CallsAndCallers,
    RefByFiles,
    RefByModules,
    Container,
    MemberTypes,
    MemberClasses,
    TypesUsed,
    BaseClasses,
    DerivedClasses,
}

impl RelationKind {
    /// The wire spelling the frontend sends. Every view name answers in every spelling
    /// it is written in — camelCase, lower case without spaces, the `callees` legacy
    /// alias for Calls — anything else is an error, not a default.
    pub fn parse(value: &str) -> Result<RelationKind, String> {
        let name: String = value.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase();
        match name.as_str() {
            "refsto" | "referencedbyfunctions" => Ok(RelationKind::RefsTo),
            "refsfrom" => Ok(RelationKind::RefsFrom),
            "contains" => Ok(RelationKind::Contains),
            "calls" | "callees" => Ok(RelationKind::Calls),
            "callers" => Ok(RelationKind::Callers),
            "callsandcallers" | "callersandcalls" => Ok(RelationKind::CallsAndCallers),
            "referencedbyfiles" => Ok(RelationKind::RefByFiles),
            "referencedbymodules" => Ok(RelationKind::RefByModules),
            "container" => Ok(RelationKind::Container),
            "membertypes" => Ok(RelationKind::MemberTypes),
            "memberclasses" => Ok(RelationKind::MemberClasses),
            "typesused" => Ok(RelationKind::TypesUsed),
            "baseclasses" => Ok(RelationKind::BaseClasses),
            "derivedclasses" => Ok(RelationKind::DerivedClasses),
            other => Err(format!("unknown relation direction: {other}")),
        }
    }
}

/// The reference edges a ring keeps: every site (the refsTo/refsFrom vocabulary), or one
/// of the filtered views — the call edges only, or the edges landing on type-category
/// declarations.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EdgeFilter {
    All,
    CallsOnly,
    TypesOnly,
}

impl EdgeFilter {
    /// Whether a node of this kind and edge kind survives the filter.
    fn keeps(&self, kind: &str, edge_kind: &str) -> bool {
        match self {
            EdgeFilter::All => true,
            EdgeFilter::CallsOnly => edge_kind == "call",
            EdgeFilter::TypesOnly => is_typeish(kind),
        }
    }
}

/// The declaration kinds that count as types — the `refs_is_typeish` vocabulary of the
/// reference reconstruction, over the index's own kind names: the types a `Types Used`
/// ring keeps and the `Member Types` filter's members.
const TYPEISH: &[&str] = &["class", "struct", "interface", "enum", "type", "module"];

/// The class-kind members only — `Member Classes`' filter.
const CLASSISH: &[&str] = &["class"];

fn is_typeish(kind: &str) -> bool {
    TYPEISH.contains(&kind)
}

/// One ring's shape beyond its subject: how many nodes it keeps (the 64-children cap),
/// whether its nodes' ring markers are peeked (a peek inside a peek would chase the
/// whole ring depth-first), and which edges it keeps (the Calls / Types Used views).
#[derive(Clone, Copy, Debug)]
struct RingOpts {
    limit: usize,
    with_flags: bool,
    filter: EdgeFilter,
}

impl RingOpts {
    fn new(limit: usize, with_flags: bool, filter: EdgeFilter) -> RingOpts {
        RingOpts {
            limit,
            with_flags,
            filter,
        }
    }

    /// The peeks-off twin a peek itself runs with.
    fn bare(&self) -> RingOpts {
        RingOpts {
            limit: 1,
            with_flags: false,
            filter: self.filter,
        }
    }
}

/// One definition row as the queries see it: the store's outline row plus its file.
#[derive(Clone, Debug)]
struct DefRow {
    kind: String,
    name: String,
    container: Option<String>,
    path: String,
    /// 0-based; `[line, end_line]` is the definition body's extent.
    line: usize,
    end_line: usize,
}

fn row_def(path: &str, row: &FileOutlineRow) -> DefRow {
    DefRow {
        kind: row.kind.to_owned(),
        name: row.name.clone(),
        container: row.container.clone(),
        path: path.to_owned(),
        line: row.line,
        end_line: row.end_line,
    }
}

fn sym_def(symbol: &WorkspaceSymbol) -> DefRow {
    DefRow {
        kind: symbol.kind.clone(),
        name: symbol.name.clone(),
        container: symbol.container.clone(),
        path: symbol.path.clone(),
        line: symbol.line,
        end_line: symbol.end_line,
    }
}

/// The children of one subject definition, the next ring of the relation graph, under
/// the default time budget. The subject is `(name, path, line)` — the symbol under the
/// cursor with the location the context-symbol resolution reported. Every name-scanned
/// kind (the refsTo family) needs only the name — the edges are found by scanning the
/// name everywhere and attributing each hit, so the subject itself is never resolved;
/// every body-walking kind (the refsFrom family) and every resolution-backed kind
/// (Container, Base/Derived) resolve the subject's definition from all three.
pub fn relation_children(
    root: &str,
    store: &SymbolStore,
    name: &str,
    path: &str,
    line: usize,
    kind: RelationKind,
) -> Result<RelationAnswer, String> {
    relation_children_budgeted(root, store, name, path, line, kind, RELATION_BUDGET_MS)
}

/// The same query under an explicit budget in milliseconds — the tests' dial; 0 means
/// the budget is spent before the first item and the ring truncates immediately.
pub fn relation_children_budgeted(
    root: &str,
    store: &SymbolStore,
    name: &str,
    path: &str,
    line: usize,
    kind: RelationKind,
    budget_ms: u64,
) -> Result<RelationAnswer, String> {
    let budget = Budget::after(budget_ms);
    match kind {
        RelationKind::RefsTo => refs_to(root, store, name, path, Some(line), RingOpts::new(MAX_NODES, true, EdgeFilter::All), &budget),
        RelationKind::RefsFrom => refs_from(store, name, path, line, RingOpts::new(MAX_NODES, true, EdgeFilter::All), &budget),
        // A pure store query: no file read, no wall-clock budget to respect.
        RelationKind::Contains => contains_members(store, name, MAX_NODES, true, MemberFilter::All),
        // The Calls / Callers views: the same scans through the call edges only —
        // the peeks ask the same filtered question, so a node's ring marker never promises
        // a drill the kind answers empty.
        RelationKind::Calls => refs_from(store, name, path, line, RingOpts::new(MAX_NODES, true, EdgeFilter::CallsOnly), &budget),
        RelationKind::Callers => refs_to(root, store, name, path, Some(line), RingOpts::new(MAX_NODES, true, EdgeFilter::CallsOnly), &budget),
        // The combined view: the caller ring first, the callee ring merged in — a
        // counterpart met on both sides keeps one node whose count is the pair's total.
        // Caller branches drill as Callers, callee branches as Calls (the node's edge
        // coordinates tell the frontend which side it stands on: a caller's edge lives in
        // its own file, a callee's in the subject's).
        RelationKind::CallsAndCallers => calls_and_callers(root, store, name, path, line, &budget),
        // Referenced by Files / Modules: the same attributed sites keyed
        // by their file; the files are leaves.
        RelationKind::RefByFiles | RelationKind::RefByModules => {
            refs_by_files(root, store, name, path, Some(line), MAX_NODES, &budget)
        }
        // The enclosing type, one ring per drill — the walk upward.
        RelationKind::Container => container_chain(store, name, path, line),
        RelationKind::MemberTypes => contains_members(store, name, MAX_NODES, true, MemberFilter::Types),
        RelationKind::MemberClasses => contains_members(store, name, MAX_NODES, true, MemberFilter::Classes),
        RelationKind::TypesUsed => refs_from(store, name, path, line, RingOpts::new(MAX_NODES, true, EdgeFilter::TypesOnly), &budget),
        RelationKind::BaseClasses => base_classes(store, name, path, line, MAX_NODES, &budget),
        RelationKind::DerivedClasses => derived_classes(store, name, path, line, MAX_NODES, &budget),
    }
}

/* ---------- refsTo ---------- */

/// The ring's final shape: each edge's site lines sorted, deduplicated and capped (two
/// sites on one line are one row — the references view's own dedup), the nodes ordered
/// by their earliest site. Every direction returns through here.
fn finish_ring(mut nodes: Vec<RelationNode>) -> Vec<RelationNode> {
    for node in &mut nodes {
        node.edge_lines.sort_unstable();
        node.edge_lines.dedup();
        node.edge_lines.truncate(MAX_EDGE_LINES);
    }
    nodes.sort_by_key(|node| node.edge_line);
    nodes
}


/// The definitions that reference `name`: every whole-word occurrence of it (the
/// occurrence-narrowed scan), attributed through the file's own def intervals, hits the
/// file's comment/string mask covers dropped (the mask is read and computed once per
/// file, cached for the ring). A hit on a definition's own line is that declaration or
/// prototype line, not a use, and goes; a hit no interval covers (an include line, a
/// global statement) goes the same way; the remaining hits of one (caller, callee) pair
/// merge into the single node — count accumulates, the earliest line stays. A hit inside
/// the subject's own body survives as the self-edge — the declaration-line skip never
/// reaches a body line, so recursion stays a child.
fn refs_to(
    root: &str,
    store: &SymbolStore,
    name: &str,
    subject_path: &str,
    subject_line: Option<usize>,
    opts: RingOpts,
    budget: &Budget,
) -> Result<RelationAnswer, String> {
    let RingOpts {
        limit,
        with_flags,
        filter,
    } = opts;
    let subject_is_private =
        !subject_path.is_empty() && store.is_symbol_private(subject_path, name, subject_line);
    let narrow = if subject_is_private {
        Some(vec![subject_path.to_owned()])
    } else {
        store.files_containing(name)
    };
    let (files, _) = scan_references_bounded(root, name, narrow, SCAN_KEEP, "")?;
    let mut nodes: Vec<RelationNode> = Vec::new();
    let mut index_of: HashMap<(String, String, String, usize), usize> = HashMap::new();
    let mut masks: HashMap<String, Option<CodeMask>> = HashMap::new();
    let mut locals_by_file: HashMap<String, Vec<crate::symbols::parse::ParsedSymbol>> =
        HashMap::new();
    let mut truncated = false;
    let mut files_seen = 0usize;
    let mut hits_seen = 0usize;
    'files: for file in files {
        files_seen += 1;
        if files_seen % BUDGET_FILES_PER_CHECK == 1 && budget.expired() {
            truncated = true;
            break;
        }
        if !subject_path.is_empty() {
            if subject_is_private && file.path != subject_path {
                continue;
            }
            if !same_lang_family(subject_path, &file.path) {
                continue;
            }
        }
        // A file the store never indexed contributes no attributable rows.
        let Some(defs) = store.file_symbols(&file.path) else {
            continue;
        };
        for hit in &file.matches {
            hits_seen += 1;
            if hits_seen.is_multiple_of(BUDGET_HITS_PER_CHECK) && budget.expired() {
                truncated = true;
                break 'files;
            }
            let site = hit.line.saturating_sub(1); // the scan counts 1-based; defs 0-based
            let Some(def) = owning_def(&defs, site) else {
                continue;
            };
            if site == def.line {
                continue;
            }
            // A multi-line typedef (`typedef struct { ... } Foo;`) records `def.line` at
            // the `typedef` opener and `def.end_line` on the closing `} Foo;` row: the
            // closing declarator token itself is the declaration, not a reference.
            if def.kind == "type" && def.name == name && site == def.end_line {
                continue;
            }
            if file_mask(root, &mut masks, &file.path)
                .is_some_and(|mask| mask.is_masked(site, hit.column - 1))
            {
                continue;
            }
            // A parameter or local variable declared in the enclosing function shadows any
            // same-named global symbol in the workspace index.
            if file_locals(root, &mut locals_by_file, &file.path)
                .iter()
                .any(|local| {
                    local.name == name
                        && local
                            .scope
                            .is_some_and(|(from, to)| from <= site && site <= to)
                })
            {
                continue;
            }
            let edge_kind = if is_call_site(&hit.text, hit.column, hit.length) {
                "call"
            } else {
                "use"
            };
            // A filtered ring (Calls) skips the sites it does not keep before they count
            // — the pair's total is the kept sites' count, never the scan's.
            if !filter.keeps(def.kind, edge_kind) {
                continue;
            }
            let key = (
                file.path.clone(),
                def.name.clone(),
                def.kind.to_owned(),
                def.line,
            );
            if let Some(&at) = index_of.get(&key) {
                // The pair's later sites only thicken the edge they already made.
                nodes[at].edge_count += 1;
                nodes[at].edge_line = nodes[at].edge_line.min(site);
                nodes[at].edge_lines.push(site);
                continue;
            }
            index_of.insert(key, nodes.len());
            nodes.push(RelationNode {
                kind: def.kind.to_owned(),
                name: def.name.clone(),
                container: def.container.clone(),
                path: file.path.clone(),
                line: def.line,
                edge_path: file.path.clone(),
                edge_line: site,
                edge_kind: edge_kind.to_owned(),
                edge_count: 1,
                edge_lines: vec![site],
                caller_side: None,
                // The peek turns its own flags off: a flag computed inside a peek would
                // chase the whole ring depth-first, one scan per level. The filtered
                // rings' peeks ask the same filtered question.
                has_children: with_flags
                    && has_refs_to_children(
                        root,
                        store,
                        &def.name,
                        &file.path,
                        Some(def.line),
                        opts.bare(),
                        budget,
                    ),
            });
            if nodes.len() >= limit {
                truncated = true;
                break 'files;
            }
        }
    }
    Ok(RelationAnswer {
        nodes: finish_ring(nodes),
        truncated,
    })
}

/// The file's scope-local declarations (parameters and local variables), parsed once per
/// file per call so `refs_to` can drop hits shadowed by a local variable or parameter.
fn file_locals<'a>(
    root: &str,
    locals: &'a mut HashMap<String, Vec<crate::symbols::parse::ParsedSymbol>>,
    path: &str,
) -> &'a [crate::symbols::parse::ParsedSymbol] {
    locals.entry(path.to_owned()).or_insert_with(|| {
        let ext = path.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
        read_searchable(&Path::new(root).join(path))
            .map(|(bytes, _)| {
                crate::symbols::parse::parse_file(&String::from_utf8_lossy(&bytes), ext).locals
            })
            .unwrap_or_default()
    })
}

/// The file's comment/string mask, read and computed once per file per call (`masks`
/// caches across the ring); a vanished or binary file answers no mask and no filtering —
/// the hits it has stay attributed as before.
fn file_mask<'a>(
    root: &str,
    masks: &'a mut HashMap<String, Option<CodeMask>>,
    path: &str,
) -> Option<&'a CodeMask> {
    masks
        .entry(path.to_owned())
        .or_insert_with(|| {
            let ext = path.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
            read_searchable(&Path::new(root).join(path))
                .map(|(bytes, _)| mask_for_ext(ext, &String::from_utf8_lossy(&bytes)))
        })
        .as_ref()
}

/// Whether expanding `name` as a refsTo node yields children. **Precise while cheap**:
/// while the name's occurrence list is narrow (at most [`PEEK_FILE_CAP`] files) the peek
/// rescans just those files and re-attributes — through the same mask and declaration
/// skips, so a name whose users live only inside comments answers false — so the flag is
/// the real answer. A hotter name — a word spread over dozens of files almost certainly
/// has users — and a list the store does not trust (whose truth would cost a full-tree
/// scan) answer optimistically.
fn has_refs_to_children(
    root: &str,
    store: &SymbolStore,
    name: &str,
    subject_path: &str,
    subject_line: Option<usize>,
    peek: RingOpts,
    budget: &Budget,
) -> bool {
    match store.files_containing(name) {
        None => true,
        Some(files) if files.len() > PEEK_FILE_CAP => true,
        Some(_) => refs_to(root, store, name, subject_path, subject_line, peek, budget)
            .is_ok_and(|answer| !answer.nodes.is_empty()),
    }
}

/// The def whose `[line, end_line]` extent is the smallest containing `site` — the
/// definition a raw line belongs to. Nested definitions (a method in its impl, a nested
/// function) beat their enclosing ones; nothing covering answers `None` and the caller
/// skips the site (it is file furniture: an include, a global statement).
fn owning_def(defs: &[FileOutlineRow], site: usize) -> Option<&FileOutlineRow> {
    defs.iter()
        .filter(|def| def.line <= site && site <= def.end_line)
        .min_by_key(|def| def.end_line.saturating_sub(def.line))
}

/// Whether the matched identifier is followed (past whitespace) by an argument list's
/// open paren — `call` against every other `use`. The scan reports character columns,
/// so the walk past the identifier is by characters, not bytes.
fn is_call_site(line_text: &str, column: usize, length: usize) -> bool {
    let past = (column - 1 + length).min(line_text.chars().count());
    line_text.chars().skip(past).find(|c| !c.is_whitespace()) == Some('(')
}

/* ---------- refsFrom ---------- */

/// The definitions `subject`'s body references: the file read whole (the shared bounded
/// read; beyond it, or for a binary file, the direction answers empty), the body extent
/// scanned word by word over unmasked text only (a word inside the file's comments or
/// strings is the comment's own words, not a reference — the mask is computed once for
/// the read), every distinct word resolved against the store's declarations — a
/// same-file def first, then the best global one. A word's later sites thicken the edge
/// its first site made (count accumulates, the earliest line stays — the dedup set only
/// skips the resolve, never the count). The subject's own name is skipped (a recursive
/// call belongs to `refsTo`, where the scan finds it); keywords never resolve; a word
/// that is only a local or parameter — which ride the index never — finds no declaration
/// and goes.
fn refs_from(
    store: &SymbolStore,
    name: &str,
    path: &str,
    line: usize,
    opts: RingOpts,
    budget: &Budget,
) -> Result<RelationAnswer, String> {
    let RingOpts {
        limit,
        with_flags,
        filter,
    } = opts;
    let Some(subject) = resolve_def(store, name, path, line) else {
        return Ok(RelationAnswer {
            nodes: Vec::new(),
            truncated: false,
        });
    };
    let abs = Path::new(store.root()).join(&subject.path);
    let Some((bytes, _)) = read_searchable(&abs) else {
        return Ok(RelationAnswer {
            nodes: Vec::new(),
            truncated: false,
        });
    };
    let text = String::from_utf8_lossy(&bytes);
    let same_file = store.file_symbols(&subject.path).unwrap_or_default();
    let keywords = keywords_for(&subject.path);
    let ext = subject
        .path
        .rsplit_once('.')
        .map(|(_, ext)| ext)
        .unwrap_or("");
    let locals = crate::symbols::parse::parse_file(&text, ext).locals;
    let body_mask = mask_for_ext(ext, &text);
    let is_c_cpp = lang_family(ext) == "c_cpp";
    let mut seen: HashSet<&str> = HashSet::new();
    let mut node_of: HashMap<&str, usize> = HashMap::new();
    let mut nodes: Vec<RelationNode> = Vec::new();
    let mut truncated = false;
    let mut words_seen = 0usize;
    for (line_no, line_text) in text.lines().enumerate() {
        if !(subject.line..=subject.end_line).contains(&line_no) {
            continue;
        }
        let mut chars = line_text.char_indices().peekable();
        while let Some((start, c)) = chars.next() {
            if !(c.is_alphanumeric() || c == '_') {
                continue;
            }
            let mut end = start + c.len_utf8();
            while let Some(&(at, w)) = chars.peek() {
                if w.is_alphanumeric() || w == '_' {
                    end = at + w.len_utf8();
                    chars.next();
                } else {
                    break;
                }
            }
            let word = &line_text[start..end];
            // A masked word is furniture; it never makes, nor thickens, an edge.
            if body_mask.is_masked(line_no, start) {
                continue;
            }
            words_seen += 1;
            if words_seen.is_multiple_of(BUDGET_HITS_PER_CHECK) && budget.expired() {
                truncated = true;
                return Ok(RelationAnswer {
                    nodes: finish_ring(nodes),
                    truncated,
                });
            }
            // A parameter or local variable declared in the enclosing function shadows any
            // same-named global symbol in the workspace index.
            if locals.iter().any(|local| {
                local.name == word
                    && local
                        .scope
                        .is_some_and(|(from, to)| from <= line_no && line_no <= to)
            }) {
                continue;
            }
            let edge_kind = if line_text[end..].trim_start().starts_with('(') {
                "call"
            } else {
                "use"
            };
            if let Some(&at) = node_of.get(word) {
                // The word's target is fixed; later sites that pass the ring's filter
                // thicken its edge.
                if filter.keeps(&nodes[at].kind, edge_kind) {
                    nodes[at].edge_count += 1;
                    nodes[at].edge_lines.push(line_no);
                    if edge_kind == "call" && nodes[at].edge_kind != "call" {
                        nodes[at].edge_kind = "call".to_owned();
                    }
                }
                continue;
            }
            if filter == EdgeFilter::CallsOnly && edge_kind != "call" {
                continue;
            }
            // The first unmasked occurrence carries the edge; later ones only count.
            if !seen.insert(word) {
                continue;
            }
            if seen.len() > MAX_WORDS {
                break;
            }
            if word == name || keywords.contains(&word) {
                continue;
            }
            let col_chars = line_text[..start].chars().count();
            let before_word = line_text[..start].trim_end();
            let is_member_access = before_word.ends_with('.') || before_word.ends_with("->");
            let member_hit: Vec<WorkspaceSymbol> =
                crate::symbols::type_resolve::resolve_member_symbol(
                    store, &text, ext, line_no, col_chars, word,
                )
                .into_iter()
                .filter(|sym| same_lang_family(&subject.path, &sym.path))
                .collect();
            let Some(target) = pick_def(&member_hit)
                .map(sym_def)
                .or_else(|| {
                    same_file
                        .iter()
                        .filter(|def| {
                            def.name == word && (!is_c_cpp || !is_member_access || def.container.is_some())
                        })
                        .max_by_key(|def| def.end_line > def.line)
                        .map(|row| row_def(&subject.path, row))
                })
                .or_else(|| {
                    let global: Vec<WorkspaceSymbol> = store
                        .lookup(word)
                        .into_iter()
                        .filter(|sym| {
                            same_lang_family(&subject.path, &sym.path)
                                && (!is_c_cpp || !is_member_access || sym.container.is_some())
                                && (sym.path == subject.path
                                    || !store.is_symbol_private(&sym.path, &sym.name, Some(sym.line)))
                        })
                        .collect();
                    pick_def(&global).map(sym_def)
                })
            else {
                continue;
            };
            // A filtered ring (Calls, Types Used) drops the target before it counts —
            // the ring is the kept edges', never the scan's.
            if !filter.keeps(&target.kind, edge_kind) {
                continue;
            }
            node_of.insert(word, nodes.len());
            nodes.push(RelationNode {
                kind: target.kind.clone(),
                name: target.name.clone(),
                container: target.container.clone(),
                path: target.path.clone(),
                line: target.line,
                edge_path: subject.path.clone(),
                edge_line: line_no,
                edge_kind: edge_kind.to_owned(),
                edge_count: 1,
                edge_lines: vec![line_no],
                caller_side: None,
                has_children: with_flags
                    && has_refs_from_children(store, &target, opts.bare(), budget),
            });
            if nodes.len() >= limit {
                truncated = true;
                return Ok(RelationAnswer {
                    nodes: finish_ring(nodes),
                    truncated,
                });
            }
        }
        if seen.len() > MAX_WORDS {
            break;
        }
    }
    Ok(RelationAnswer {
        nodes: finish_ring(nodes),
        truncated,
    })
}

/// Whether expanding a node as refsFrom yields children — **precise**: the peek re-runs
/// the direction with limit 1 and its flags off, which reads just the node's own file
/// (the bounded read) and stops at the first edge the ring's filter keeps.
fn has_refs_from_children(
    store: &SymbolStore,
    target: &DefRow,
    peek: RingOpts,
    budget: &Budget,
) -> bool {
    refs_from(store, &target.name, &target.path, target.line, peek, budget)
        .is_ok_and(|answer| !answer.nodes.is_empty())
}

/* ---------- contains ---------- */

/// The member rings' kind filters: every member (`contains`), the type-category members
/// (`Member Types`), the class-kind members (`Member Classes`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MemberFilter {
    All,
    Types,
    Classes,
}

impl MemberFilter {
    /// The kind slice the store filters members by; `None` keeps every member.
    fn kinds(self) -> Option<&'static [&'static str]> {
        match self {
            MemberFilter::All => None,
            MemberFilter::Types => Some(TYPEISH),
            MemberFilter::Classes => Some(CLASSISH),
        }
    }
}

/// The subject's members: every declaration whose container is the subject's name, one
/// store query (`members_of` — the container is an interned name, so the filter runs
/// inside the store and only the hits leave it), path-then-line sorted, the node cap the
/// ceiling — one member past it marks the ring truncated, never silently shortened. The
/// edge is the member's own declaration (`edge_kind: "member"`, one site per member), and
/// `has_children` peeks whether the member's name is itself a container **of members the
/// ring's own filter keeps** — the nested-type fold-out the window drills into next (one
/// scan for the whole ring). A root nothing declares members of — a plain function, an
/// unknown name — answers the empty ring.
fn contains_members(
    store: &SymbolStore,
    name: &str,
    limit: usize,
    with_flags: bool,
    filter: MemberFilter,
) -> Result<RelationAnswer, String> {
    let mut rows = store.members_of(name, limit.saturating_add(1), filter.kinds());
    let truncated = rows.len() > limit;
    rows.truncate(limit);
    let drillable = if with_flags && !rows.is_empty() {
        let names: Vec<&str> = rows.iter().map(|(_, row)| row.name.as_str()).collect();
        store.container_names_among(&names, filter.kinds())
    } else {
        HashSet::new()
    };
    let nodes = rows
        .into_iter()
        .map(|(path, row)| RelationNode {
            kind: row.kind.to_owned(),
            container: row.container,
            edge_count: 1,
            edge_lines: vec![row.line],
            edge_kind: "member".to_owned(),
            edge_line: row.line,
            edge_path: path.clone(),
            caller_side: None,
            has_children: with_flags && drillable.contains(&row.name),
            line: row.line,
            name: row.name,
            path,
        })
        .collect();
    Ok(RelationAnswer { nodes, truncated })
}

/* ---------- Calls and Callers ---------- */

/// The combined view: the caller ring first, the callee ring merged in — a counterpart
/// met on both sides keeps one node whose count is the pair's total sites, the caller's
/// counter and the callee's summed, and whose edge stays the caller side's. Every node's
/// ring marker asks its own side's question — callers for the caller nodes (whose edge
/// site lives in their own file), calls for the callee nodes — so a drill never promises
/// a ring the branch answers empty.
fn calls_and_callers(
    root: &str,
    store: &SymbolStore,
    name: &str,
    path: &str,
    line: usize,
    budget: &Budget,
) -> Result<RelationAnswer, String> {
    let bare = RingOpts::new(MAX_NODES, false, EdgeFilter::All);
    let callers = refs_to(root, store, name, path, Some(line), bare, budget)?;
    let callees = refs_from(store, name, path, line, bare, budget)?;
    let mut truncated = callers.truncated || callees.truncated;
    let caller_count = callers.nodes.len();
    let mut nodes = callers.nodes;
    let mut index_of: HashMap<(String, String, usize), usize> = nodes
        .iter()
        .enumerate()
        .map(|(at, node)| ((node.name.clone(), node.path.clone(), node.line), at))
        .collect();
    for callee in callees.nodes {
        let key = (callee.name.clone(), callee.path.clone(), callee.line);
        if let Some(&at) = index_of.get(&key) {
            // The caller side's coordinates stay — the branch drills as Callers — and
            // the count is the pair's total sites, the caller's and the callee's summed,
            // the site lines both sides kept.
            nodes[at].edge_count += callee.edge_count;
            nodes[at].edge_lines.extend(callee.edge_lines);
            continue;
        }
        index_of.insert(key, nodes.len());
        nodes.push(callee);
    }
    for (at, node) in nodes.iter_mut().enumerate() {
        // The first `caller_count` entries came from the caller ring (same-file callers
        // included); everything appended after came from the callee ring.
        let caller_side = at < caller_count;
        node.caller_side = Some(caller_side);
        node.has_children = if caller_side {
            has_refs_to_children(
                root,
                store,
                &node.name,
                &node.path,
                Some(node.line),
                RingOpts::new(1, false, EdgeFilter::All),
                budget,
            )
        } else {
            let target = DefRow {
                kind: node.kind.clone(),
                name: node.name.clone(),
                container: node.container.clone(),
                path: node.path.clone(),
                line: node.line,
                end_line: node.line,
            };
            has_refs_from_children(store, &target, RingOpts::new(1, false, EdgeFilter::All), budget)
        };
    }
    if !truncated && (nodes.len() >= MAX_NODES) {
        truncated = true;
    }
    Ok(RelationAnswer {
        nodes: finish_ring(nodes),
        truncated,
    })
}

/* ---------- Referenced by Files / Modules ---------- */

/// The attributed reference sites keyed by their file — the Referenced by
/// Files / Modules view (`refs_refby_mods` in the reference reconstruction): one node per
/// file, count the file's kept sites, line the earliest. The same attribution discipline
/// `refs_to` keeps (the declaration lines, the comment/string mask, the intervals), and
/// the files are leaves: `has_children` is false down the ring.
fn refs_by_files(
    root: &str,
    store: &SymbolStore,
    name: &str,
    subject_path: &str,
    subject_line: Option<usize>,
    limit: usize,
    budget: &Budget,
) -> Result<RelationAnswer, String> {
    let subject_is_private =
        !subject_path.is_empty() && store.is_symbol_private(subject_path, name, subject_line);
    let narrow = if subject_is_private {
        Some(vec![subject_path.to_owned()])
    } else {
        store.files_containing(name)
    };
    let (files, _) = scan_references_bounded(root, name, narrow, SCAN_KEEP, "")?;
    let mut nodes: Vec<RelationNode> = Vec::new();
    let mut index_of: HashMap<String, usize> = HashMap::new();
    let mut masks: HashMap<String, Option<CodeMask>> = HashMap::new();
    let mut locals_by_file: HashMap<String, Vec<crate::symbols::parse::ParsedSymbol>> =
        HashMap::new();
    let mut truncated = false;
    let mut files_seen = 0usize;
    let mut hits_seen = 0usize;
    'files: for file in files {
        files_seen += 1;
        if files_seen % BUDGET_FILES_PER_CHECK == 1 && budget.expired() {
            truncated = true;
            break;
        }
        if !subject_path.is_empty() {
            if subject_is_private && file.path != subject_path {
                continue;
            }
            if !same_lang_family(subject_path, &file.path) {
                continue;
            }
        }
        let Some(defs) = store.file_symbols(&file.path) else {
            continue;
        };
        for hit in &file.matches {
            hits_seen += 1;
            if hits_seen.is_multiple_of(BUDGET_HITS_PER_CHECK) && budget.expired() {
                truncated = true;
                break 'files;
            }
            let site = hit.line.saturating_sub(1);
            let Some(def) = owning_def(&defs, site) else {
                continue;
            };
            if site == def.line {
                continue;
            }
            if file_mask(root, &mut masks, &file.path)
                .is_some_and(|mask| mask.is_masked(site, hit.column - 1))
            {
                continue;
            }
            if file_locals(root, &mut locals_by_file, &file.path)
                .iter()
                .any(|local| {
                    local.name == name
                        && local
                            .scope
                            .is_some_and(|(from, to)| from <= site && site <= to)
                })
            {
                continue;
            }
            if let Some(&at) = index_of.get(&file.path) {
                nodes[at].edge_count += 1;
                nodes[at].edge_line = nodes[at].edge_line.min(site);
                nodes[at].edge_lines.push(site);
                nodes[at].line = nodes[at].line.min(site);
                continue;
            }
            index_of.insert(file.path.clone(), nodes.len());
            nodes.push(RelationNode {
                kind: "file".to_owned(),
                name: file.path.rsplit(['/', '\\']).next().unwrap_or(&file.path).to_owned(),
                container: None,
                path: file.path.clone(),
                line: site,
                edge_path: file.path.clone(),
                edge_line: site,
                edge_kind: "use".to_owned(),
                edge_count: 1,
                edge_lines: vec![site],
                caller_side: None,
                has_children: false,
            });
            if nodes.len() >= limit {
                truncated = true;
                break 'files;
            }
        }
    }
    Ok(RelationAnswer {
        nodes: finish_ring(nodes),
        truncated,
    })
}

/* ---------- Container ---------- */

/// The subject's enclosing type — the Container view, walked one ring per
/// drill: the ring names the container, the next drill on that node names its own. The
/// edge is the membership fact itself (the subject's declaration line); the ring marker
/// answers whether the container has a container of its own.
fn container_chain(
    store: &SymbolStore,
    name: &str,
    path: &str,
    line: usize,
) -> Result<RelationAnswer, String> {
    let Some(subject) = resolve_def(store, name, path, line) else {
        return Ok(RelationAnswer {
            nodes: Vec::new(),
            truncated: false,
        });
    };
    let Some(container) = subject.container else {
        return Ok(RelationAnswer {
            nodes: Vec::new(),
            truncated: false,
        });
    };
    // The container's own definition: its file's outline first (the same file usually),
    // then the best global declaration.
    let container_def = store
        .file_symbols(&subject.path)
        .unwrap_or_default()
        .iter()
        .find(|row| row.name == container)
        .map(|row| row_def(&subject.path, row))
        .or_else(|| pick_def(&store.lookup(&container)).map(sym_def));
    let Some(def) = container_def else {
        return Ok(RelationAnswer {
            nodes: Vec::new(),
            truncated: false,
        });
    };
    Ok(RelationAnswer {
        nodes: vec![RelationNode {
            kind: def.kind.clone(),
            name: def.name.clone(),
            container: def.container.clone(),
            path: def.path.clone(),
            line: def.line,
            edge_path: subject.path.clone(),
            edge_line: subject.line,
            edge_kind: "member".to_owned(),
            edge_count: 1,
            edge_lines: vec![subject.line],
            caller_side: None,
            has_children: def.container.is_some(),
        }],
        truncated: false,
    })
}

/* ---------- Base Classes / Derived Classes ---------- */

/// The base types the subject derives from — the Base Classes view: one node
/// per base in source order, the edge at the derivation's own line (the declaration line
/// the `extends`/`: public Base` clause sits on), and the ring marker peeking whether the
/// base derives from anything itself — the chain drills upward the same way.
fn base_classes(
    store: &SymbolStore,
    name: &str,
    path: &str,
    line: usize,
    limit: usize,
    budget: &Budget,
) -> Result<RelationAnswer, String> {
    let subject = resolve_def(store, name, path, line);
    let bases = store.bases_of(name);
    let mut truncated = bases.len() > limit;
    let nodes: Vec<RelationNode> = bases
        .iter()
        .take(limit)
        .filter_map(|base| {
            // The base's definition: the subject's own file first, then the best global.
            let def = store
                .file_symbols(path)
                .unwrap_or_default()
                .iter()
                .find(|row| row.name == *base)
                .map(|row| row_def(path, row))
                .or_else(|| pick_def(&store.lookup(base)).map(sym_def))
                .or_else(|| {
                    // A base nothing declares still rings: the name is the node, its own
                    // declaration line unknown.
                    Some(DefRow {
                        kind: "type".to_owned(),
                        name: base.clone(),
                        container: None,
                        path: String::new(),
                        line: 0,
                        end_line: 0,
                    })
                })?;
            Some(RelationNode {
                caller_side: None,
                has_children: !budget.expired() && !store.bases_of(base).is_empty(),
                kind: def.kind.clone(),
                name: def.name.clone(),
                container: def.container.clone(),
                path: def.path.clone(),
                line: def.line,
                edge_path: subject.as_ref().map_or(path, |s| s.path.as_str()).to_owned(),
                edge_line: subject.as_ref().map_or(line, |s| s.line),
                edge_kind: "base".to_owned(),
                edge_count: 1,
                edge_lines: vec![subject.as_ref().map_or(line, |s| s.line)],
            })
        })
        .collect();
    if !truncated && nodes.len() >= limit && bases.len() > nodes.len() {
        truncated = true;
    }
    Ok(RelationAnswer { nodes, truncated })
}

/// The declarations that derive from the subject — the Derived Classes view:
/// the store's base table scanned the other way, one node per derived declaration with
/// its own declaration line for the edge, and the ring marker peeking its own derived
/// classes.
fn derived_classes(
    store: &SymbolStore,
    name: &str,
    path: &str,
    line: usize,
    limit: usize,
    _budget: &Budget,
) -> Result<RelationAnswer, String> {
    // The reverse scan walks the store's base table and never needs the subject's own
    // resolution — the coordinates ride along unused, the shared signature's shape.
    let _ = (path, line);
    let rows = store.derived_of(name, limit.saturating_add(1));
    let truncated = rows.len() > limit;
    let nodes: Vec<RelationNode> = rows
        .into_iter()
        .take(limit)
        .map(|(child_path, row)| RelationNode {
            caller_side: None,
            has_children: !store.derived_of(&row.name, 1).is_empty(),
            kind: row.kind.to_owned(),
            name: row.name.clone(),
            container: row.container.clone(),
            path: child_path.clone(),
            line: row.line,
            edge_path: child_path,
            edge_line: row.line,
            edge_kind: "base".to_owned(),
            edge_count: 1,
            edge_lines: vec![row.line],
        })
        .collect();
    Ok(RelationAnswer { nodes, truncated })
}

/// The subject's definition row: the exact `(path, line, name)` hit in that file's
/// outline first — the coordinates the context-symbol resolution reported — then any
/// covering or nearest declaration of `name` in that same file, and only when the file
/// itself declares nothing of that name does it fall back to the best global declaration.
/// `None` answers an empty direction, never an error: a subject the index never declared
/// has no body to walk.
fn resolve_def(store: &SymbolStore, name: &str, path: &str, line: usize) -> Option<DefRow> {
    if let Some(rows) = store.file_symbols(path) {
        if let Some(row) = rows.iter().find(|row| row.line == line && row.name == name) {
            return Some(row_def(path, row));
        }
        if let Some(row) = rows
            .iter()
            .find(|row| row.name == name && row.line <= line && line <= row.end_line)
        {
            return Some(row_def(path, row));
        }
        if let Some(row) = rows
            .iter()
            .filter(|row| row.name == name)
            .min_by_key(|row| {
                (
                    row.end_line <= row.line,
                    row.line.abs_diff(line),
                )
            })
        {
            return Some(row_def(path, row));
        }
    }
    pick_def(&store.lookup(name)).map(sym_def)
}

/// The best of a lookup's declarations for an edge target: one with a body first (the
/// definition, not a same-named one-line declaration elsewhere), then the first row.
fn pick_def(defs: &[WorkspaceSymbol]) -> Option<&WorkspaceSymbol> {
    defs.iter()
        .find(|def| def.end_line > def.line)
        .or_else(|| defs.first())
}

/// The minimal keyword set the body scan must never resolve, per source extension: a
/// keyword kept here never reaches the store's lookup, so `int alpha(int)` in a body
/// stays language furniture instead of an edge to the language's own words. A word
/// missing from the table costs one binary search that finds nothing — the table only
/// keeps that noise out.
fn keywords_for(path: &str) -> &'static [&'static str] {
    let ext = path.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    match ext.to_ascii_lowercase().as_str() {
        "c" | "h" => C_KEYWORDS,
        "cpp" | "hpp" | "cc" | "hh" | "cxx" | "hxx" | "ipp" => CPP_KEYWORDS,
        "rs" => RUST_KEYWORDS,
        "py" => PYTHON_KEYWORDS,
        "go" => GO_KEYWORDS,
        "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" => JS_KEYWORDS,
        "java" => JAVA_KEYWORDS,
        "cs" => CSHARP_KEYWORDS,
        _ => &[],
    }
}

const C_KEYWORDS: &[&str] = &[
    "auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else",
    "enum", "extern", "float", "for", "goto", "if", "inline", "int", "long", "register",
    "restrict", "return", "short", "signed", "sizeof", "static", "struct", "switch", "typedef",
    "union", "unsigned", "void", "volatile", "while",
];

const CPP_KEYWORDS: &[&str] = &[
    "auto",
    "bool",
    "break",
    "case",
    "catch",
    "char",
    "class",
    "const",
    "continue",
    "default",
    "delete",
    "do",
    "double",
    "else",
    "enum",
    "explicit",
    "extern",
    "false",
    "float",
    "for",
    "friend",
    "goto",
    "if",
    "inline",
    "int",
    "long",
    "mutable",
    "namespace",
    "new",
    "nullptr",
    "operator",
    "private",
    "protected",
    "public",
    "register",
    "return",
    "short",
    "signed",
    "sizeof",
    "static",
    "struct",
    "switch",
    "template",
    "this",
    "throw",
    "true",
    "try",
    "typedef",
    "typename",
    "union",
    "unsigned",
    "using",
    "virtual",
    "void",
    "volatile",
    "while",
];

const RUST_KEYWORDS: &[&str] = &[
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern",
    "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
    "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type",
    "unsafe", "use", "where", "while",
];

const PYTHON_KEYWORDS: &[&str] = &[
    "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
    "else", "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is",
    "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while",
    "with", "yield",
];

const GO_KEYWORDS: &[&str] = &[
    "break",
    "case",
    "chan",
    "const",
    "continue",
    "default",
    "defer",
    "else",
    "fallthrough",
    "false",
    "for",
    "func",
    "go",
    "goto",
    "if",
    "import",
    "interface",
    "map",
    "nil",
    "package",
    "range",
    "return",
    "select",
    "struct",
    "switch",
    "true",
    "type",
    "var",
];

const JS_KEYWORDS: &[&str] = &[
    "abstract",
    "as",
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "declare",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "from",
    "function",
    "get",
    "if",
    "implements",
    "import",
    "in",
    "infer",
    "instanceof",
    "interface",
    "is",
    "keyof",
    "let",
    "namespace",
    "new",
    "null",
    "of",
    "private",
    "protected",
    "public",
    "readonly",
    "return",
    "set",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "type",
    "typeof",
    "undefined",
    "var",
    "void",
    "while",
    "yield",
];

const JAVA_KEYWORDS: &[&str] = &[
    "abstract",
    "assert",
    "boolean",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "class",
    "continue",
    "default",
    "do",
    "double",
    "else",
    "enum",
    "extends",
    "false",
    "final",
    "finally",
    "float",
    "for",
    "if",
    "implements",
    "import",
    "instanceof",
    "int",
    "interface",
    "long",
    "native",
    "new",
    "null",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "short",
    "static",
    "super",
    "switch",
    "synchronized",
    "this",
    "throw",
    "throws",
    "transient",
    "true",
    "try",
    "void",
    "volatile",
    "while",
];

const CSHARP_KEYWORDS: &[&str] = &[
    "abstract",
    "as",
    "async",
    "await",
    "base",
    "bool",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "checked",
    "class",
    "const",
    "continue",
    "decimal",
    "default",
    "delegate",
    "do",
    "double",
    "else",
    "enum",
    "event",
    "explicit",
    "extern",
    "false",
    "finally",
    "fixed",
    "float",
    "for",
    "foreach",
    "goto",
    "if",
    "implicit",
    "in",
    "int",
    "interface",
    "internal",
    "is",
    "lock",
    "long",
    "namespace",
    "new",
    "null",
    "object",
    "operator",
    "out",
    "override",
    "params",
    "private",
    "protected",
    "public",
    "readonly",
    "ref",
    "return",
    "sbyte",
    "sealed",
    "short",
    "sizeof",
    "stackalloc",
    "static",
    "string",
    "struct",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "uint",
    "ulong",
    "unchecked",
    "unsafe",
    "ushort",
    "using",
    "var",
    "virtual",
    "void",
    "volatile",
    "when",
    "while",
    "yield",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, path: &str, text: &str) {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap_or(root)).unwrap();
        std::fs::write(file, text).unwrap();
    }

    fn seeded(files: &[(&str, &str)]) -> (tempfile::TempDir, SymbolStore) {
        let dir = tempfile::tempdir().unwrap();
        for (path, text) in files {
            write(dir.path(), path, text);
        }
        let root = dir.path().display().to_string();
        let store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        (dir, store)
    }

    fn children(
        store: &SymbolStore,
        root: &str,
        name: &str,
        path: &str,
        line: usize,
        kind: RelationKind,
    ) -> Vec<RelationNode> {
        answer(store, root, name, path, line, kind).nodes
    }

    fn answer(
        store: &SymbolStore,
        root: &str,
        name: &str,
        path: &str,
        line: usize,
        kind: RelationKind,
    ) -> RelationAnswer {
        relation_children(root, store, name, path, line, kind).unwrap()
    }

    /// Cross-file refsTo: b.c's beta and gamma call alpha, the header's prototype line
    /// and the declaration lines contribute nothing, and the peek flags separate a
    /// caller-with-children (beta) from a leaf (wrap).
    #[test]
    fn refs_to_finds_callers_across_files_and_skips_declarations() {
        let (_dir, store) = seeded(&[
            (
                "src/a.c",
                "#include \"util.h\"\nint alpha(int x)\n{\n    return x + 1;\n}\nint wrap(int y)\n{\n    return alpha(y) + alpha(y);\n}\n",
            ),
            (
                "src/b.c",
                "#include \"util.h\"\nint beta(int n)\n{\n    return alpha(n) * 2;\n}\nint gamma(int n)\n{\n    return beta(n) - 1;\n}\n",
            ),
            (
                "src/util.h",
                "int alpha(int x);\nstatic int helper(void)\n{\n    return 0;\n}\n",
            ),
        ]);
        let root = store.root().to_owned();

        let nodes = children(
            &store,
            &root,
            "alpha",
            "src/a.c",
            1,
            RelationKind::RefsTo,
        );
        // The util.h prototype sits outside every def interval (skipped unattributed);
        // alpha's own declaration line (a.c line 1) and wrap's two same-line calls
        // (deduped) leave exactly the two callers, earliest edge first.
        assert_eq!(nodes.len(), 2);
        assert_eq!(
            (
                nodes[0].name.as_str(),
                nodes[0].path.as_str(),
                nodes[0].line,
                nodes[0].edge_path.as_str(),
                nodes[0].edge_line,
                nodes[0].edge_kind.as_str()
            ),
            ("beta", "src/b.c", 1, "src/b.c", 3, "call")
        );
        assert_eq!(
            (
                nodes[1].name.as_str(),
                nodes[1].edge_path.as_str(),
                nodes[1].edge_line,
                nodes[1].edge_kind.as_str()
            ),
            ("wrap", "src/a.c", 7, "call")
        );
        // beta is itself called from gamma's body; wrap is called from nowhere. The
        // numbered rows the graph card draws: each edge's own site lines, wrap's two
        // same-line calls deduplicated into one.
        assert!(nodes[0].has_children);
        assert!(!nodes[1].has_children);
        assert_eq!(nodes[0].edge_lines, vec![3]);
        assert_eq!(nodes[1].edge_lines, vec![7]);
    }

    /// A hit on a definition's own line is skipped as the declaration; a hit inside the
    /// subject's own body survives as the self-edge (recursion stays a child).
    #[test]
    fn declaration_lines_go_but_recursion_stays() {
        let (_dir, store) = seeded(&[(
            "rec.c",
            "int loop(int n)\n{\n    if (n > 0) { return loop(n - 1); }\n    return 0;\n}\n",
        )]);
        let nodes = children(
            &store,
            store.root(),
            "loop",
            "rec.c",
            0,
            RelationKind::RefsTo,
        );
        assert_eq!(nodes.len(), 1);
        assert_eq!(
            (
                nodes[0].name.as_str(),
                nodes[0].path.as_str(),
                nodes[0].line,
                nodes[0].edge_line,
                nodes[0].edge_kind.as_str()
            ),
            ("loop", "rec.c", 0, 2, "call")
        );
    }

    /// refsFrom over a body: a callee is a `call` edge, a macro reference a `use` edge,
    /// a local variable resolves to nothing, the subject's own name is skipped, and a
    /// callee referenced twice keeps the earliest edge only.
    #[test]
    fn refs_from_marks_calls_and_uses_and_dedups() {
        let (_dir, store) = seeded(&[(
            "use.c",
            "#define MAGIC_NUM 7\nint alpha(int x)\n{\n    return x;\n}\nint beta(int y)\n{\n    int t = alpha(y) + alpha(y);\n    t = t + MAGIC_NUM;\n    return t + alpha(t);\n}\n",
        )]);
        let nodes = children(
            &store,
            store.root(),
            "beta",
            "use.c",
            5,
            RelationKind::RefsFrom,
        );
        assert_eq!(
            nodes.len(),
            2,
            "alpha twice collapses, locals never resolve"
        );
        assert_eq!(
            (
                nodes[0].name.as_str(),
                nodes[0].path.as_str(),
                nodes[0].line,
                nodes[0].edge_path.as_str(),
                nodes[0].edge_line,
                nodes[0].edge_kind.as_str(),
                nodes[0].has_children
            ),
            ("alpha", "use.c", 1, "use.c", 7, "call", false)
        );
        assert_eq!(
            (
                nodes[1].name.as_str(),
                nodes[1].kind.as_str(),
                nodes[1].edge_line,
                nodes[1].edge_kind.as_str()
            ),
            ("MAGIC_NUM", "macro", 8, "use")
        );
        // alpha's three sites — two on one line, one further down — keep both their
        // lines, ascending and deduplicated, for the card's numbered rows.
        assert_eq!(nodes[0].edge_count, 3);
        assert_eq!(nodes[0].edge_lines, vec![7, 9]);
    }

    /// The subject's body extent: an exact `(path, line, name)` hit wins; a wrong line
    /// falls back to the lookup with the same file preferred; a subject only another
    /// file declares resolves there; an undeclared name answers empty.
    #[test]
    fn refs_from_resolves_the_subject_and_prefers_the_same_file() {
        let (_dir, store) = seeded(&[
            (
                "src/lib.c",
                "int alpha(int x)\n{\n    return beta(x) + 1;\n}\nint beta(int y)\n{\n    return alpha(y) + 1;\n}\n",
            ),
            ("src/other.c", "int helper(void)\n{\n    return 0;\n}\n"),
        ]);
        let root = store.root().to_owned();

        // The exact hit: beta's body references alpha.
        let nodes = children(
            &store,
            &root,
            "beta",
            "src/lib.c",
            4,
            RelationKind::RefsFrom,
        );
        assert_eq!(nodes.len(), 1);
        assert_eq!(
            (
                nodes[0].name.as_str(),
                nodes[0].edge_path.as_str(),
                nodes[0].edge_line
            ),
            ("alpha", "src/lib.c", 6)
        );

        // A wrong line misses the exact hit; the lookup picks the same file back.
        let nodes = children(
            &store,
            &root,
            "beta",
            "src/lib.c",
            999,
            RelationKind::RefsFrom,
        );
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].edge_path, "src/lib.c");

        // A name only another file declares: the subject resolves there.
        let nodes = children(
            &store,
            &root,
            "alpha",
            "src/other.c",
            42,
            RelationKind::RefsFrom,
        );
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "beta");
        assert_eq!(nodes[0].edge_path, "src/lib.c");

        // Nothing declares the name: an empty answer, not an error.
        let nodes = children(
            &store,
            &root,
            "nosuch",
            "src/other.c",
            0,
            RelationKind::RefsFrom,
        );
        assert!(nodes.is_empty());
    }

    /// The kind parses the wire spellings and the view names in every spelling they are
    /// written in; anything else is an error.
    #[test]
    fn direction_parses_the_wire_spelling_only() {
        assert_eq!(RelationKind::parse("refsTo"), Ok(RelationKind::RefsTo));
        assert_eq!(RelationKind::parse("refsFrom"), Ok(RelationKind::RefsFrom));
        assert_eq!(RelationKind::parse("contains"), Ok(RelationKind::Contains));
        // The view names' alternate spellings: camelCase, lower case without spaces, and
        // the `callees` legacy alias of the Calls view.
        assert_eq!(
            RelationKind::parse("referencedByFunctions"),
            Ok(RelationKind::RefsTo)
        );
        assert_eq!(
            RelationKind::parse("referencedbyfiles"),
            Ok(RelationKind::RefByFiles)
        );
        assert_eq!(
            RelationKind::parse("referencedbymodules"),
            Ok(RelationKind::RefByModules)
        );
        assert_eq!(RelationKind::parse("calls"), Ok(RelationKind::Calls));
        assert_eq!(RelationKind::parse("callees"), Ok(RelationKind::Calls));
        assert_eq!(RelationKind::parse("callers"), Ok(RelationKind::Callers));
        assert_eq!(
            RelationKind::parse("CallsAndCallers"),
            Ok(RelationKind::CallsAndCallers)
        );
        assert_eq!(
            RelationKind::parse("callsandcallers"),
            Ok(RelationKind::CallsAndCallers)
        );
        assert_eq!(RelationKind::parse("container"), Ok(RelationKind::Container));
        assert_eq!(
            RelationKind::parse("memberTypes"),
            Ok(RelationKind::MemberTypes)
        );
        assert_eq!(
            RelationKind::parse("memberclasses"),
            Ok(RelationKind::MemberClasses)
        );
        assert_eq!(RelationKind::parse("typesUsed"), Ok(RelationKind::TypesUsed));
        assert_eq!(
            RelationKind::parse("BaseClasses"),
            Ok(RelationKind::BaseClasses)
        );
        assert_eq!(
            RelationKind::parse("derivedclasses"),
            Ok(RelationKind::DerivedClasses)
        );
        assert!(RelationKind::parse("sideways").is_err());
        assert!(RelationKind::parse("").is_err());
    }

    /// The contains ring: a receiver type's methods across files, path-then-line sorted,
    /// every edge the member's own declaration (`member`, one site), leaves not drillable.
    #[test]
    fn contains_lists_members_across_files_sorted() {
        let (_dir, store) = seeded(&[
            (
                "a.go",
                "package app\n\ntype Widget struct{}\nfunc (w Widget) Draw() {}\n",
            ),
            ("b.go", "package app\n\nfunc (w Widget) Spin() {}\n"),
        ]);
        let nodes = children(
            &store,
            store.root(),
            "Widget",
            "a.go",
            2,
            RelationKind::Contains,
        );
        assert_eq!(nodes.len(), 2);
        assert_eq!(
            (
                nodes[0].name.as_str(),
                nodes[0].kind.as_str(),
                nodes[0].container.as_deref(),
                nodes[0].path.as_str(),
                nodes[0].line,
                nodes[0].edge_path.as_str(),
                nodes[0].edge_line,
                nodes[0].edge_kind.as_str(),
                nodes[0].edge_count
            ),
            (
                "Draw",
                "method",
                Some("Widget"),
                "a.go",
                3,
                "a.go",
                3,
                "member",
                1
            )
        );
        assert_eq!(
            (
                nodes[1].name.as_str(),
                nodes[1].path.as_str(),
                nodes[1].line
            ),
            ("Spin", "b.go", 2)
        );
        assert!(!nodes[0].has_children);
        assert!(!nodes[1].has_children);
    }

    /// A member whose name is itself a container drills — the peek is the same members
    /// query (a method named after another type) — while a leaf stays closed; a member
    /// past the cap marks the ring truncated.
    #[test]
    fn contains_drills_into_nested_types_and_marks_truncation() {
        let (_dir, store) = seeded(&[(
            "a.go",
            "package app\n\ntype Hub struct{}\nfunc (h Hub) Run() {}\n\ntype Port struct{}\nfunc (p Port) Hub() {}\nfunc (p Port) Open() {}\n",
        )]);
        let nodes = children(
            &store,
            store.root(),
            "Port",
            "a.go",
            5,
            RelationKind::Contains,
        );
        assert_eq!(nodes.len(), 2);
        assert_eq!(
            (
                nodes[0].name.as_str(),
                nodes[0].has_children,
                nodes[1].name.as_str(),
                nodes[1].has_children
            ),
            ("Hub", true, "Open", false)
        );

        // The cap: a type with MAX_NODES + 1 members truncates and says so.
        let mut big = String::from("package app\n\ntype Massive struct{}\n");
        for i in 0..=MAX_NODES {
            big.push_str(&format!("func (m Massive) M{i:03}() {{}}\n"));
        }
        let (_big_dir, big_store) = seeded(&[("big.go", big.as_str())]);
        let ans = answer(
            &big_store,
            big_store.root(),
            "Massive",
            "big.go",
            2,
            RelationKind::Contains,
        );
        assert_eq!(ans.nodes.len(), MAX_NODES);
        assert!(ans.truncated);
    }

    /// A root nothing declares members of — a plain function's name, an unknown name —
    /// answers the empty ring, not an error.
    #[test]
    fn contains_answers_empty_for_a_memberless_root() {
        let (_dir, store) = seeded(&[(
            "a.go",
            "package app\n\ntype Hub struct{}\nfunc (h Hub) Run() {}\n",
        )]);
        let nodes = children(
            &store,
            store.root(),
            "Run",
            "a.go",
            3,
            RelationKind::Contains,
        );
        assert!(nodes.is_empty());
        let nodes = children(
            &store,
            store.root(),
            "nowhere",
            "a.go",
            0,
            RelationKind::Contains,
        );
        assert!(nodes.is_empty());
    }

    /// The ring truncates at the cap: 505 callers of one hub yield exactly 500 nodes,
    /// the scan's earliest edges first.
    #[test]
    fn the_ring_truncates_at_the_cap() {
        let mut big = String::from("int hub(int x)\n{\n    return x;\n}\n");
        for i in 0..505 {
            // A two-line body keeps the call off the caller's own declaration line.
            big.push_str(&format!("int caller{i:03}(int n)\n{{ return hub(n); }}\n"));
        }
        let (_dir, store) = seeded(&[("big.c", big.as_str())]);
        let nodes = children(
            &store,
            store.root(),
            "hub",
            "big.c",
            0,
            RelationKind::RefsTo,
        );
        assert_eq!(nodes.len(), MAX_NODES);
        assert_eq!(nodes[0].name, "caller000");
        assert!(nodes
            .windows(2)
            .all(|pair| pair[0].edge_line <= pair[1].edge_line));
        assert!(nodes
            .iter()
            .all(|node| node.edge_kind == "call" && node.path == "big.c"));
    }

    /// A call living inside a comment is the comment's own words, not a reference: a
    /// line comment in one caller and a block comment spanning another's body lines
    /// leave only the real caller as the child (refsTo).
    #[test]
    fn commented_calls_are_not_children() {
        let (_dir, store) = seeded(&[
            (
                "src/a.c",
                "int alpha(int x)\n{\n    return x;\n}\n",
            ),
            (
                "src/b.c",
                "#include \"util.h\"\nint beta(int n)\n{\n    // alpha(n) mentioned in prose\n    return n;\n}\nint gamma(int n)\n{\n    /* alpha(n)\n       alpha(n + 1) */\n    return n;\n}\nint delta(int n)\n{\n    return alpha(n) + 1;\n}\n",
            ),
        ]);
        let root = store.root().to_owned();
        let nodes = children(
            &store,
            &root,
            "alpha",
            "src/a.c",
            0,
            RelationKind::RefsTo,
        );
        assert_eq!(nodes.len(), 1, "only delta's real call survives");
        assert_eq!(
            (nodes[0].name.as_str(), nodes[0].line, nodes[0].edge_line),
            ("delta", 12, 14)
        );
    }

    /// The name inside a string literal is the string's content, not a reference (refsTo).
    #[test]
    fn string_literal_names_are_not_references() {
        let (_dir, store) = seeded(&[
            ("src/a.c", "int alpha(int x)\n{\n    return x;\n}\n"),
            (
                "src/b.c",
                "int beta(int n)\n{\n    log(\"alpha was called\");\n    return n;\n}\nint gamma(int n)\n{\n    return alpha(n);\n}\n",
            ),
        ]);
        let root = store.root().to_owned();
        let nodes = children(
            &store,
            &root,
            "alpha",
            "src/a.c",
            0,
            RelationKind::RefsTo,
        );
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "gamma");
    }

    /// The edge aggregation: one caller's several call sites are one edge whose
    /// count accumulates and whose line keeps the earliest site (refsTo).
    #[test]
    fn repeated_call_sites_aggregate_into_one_edge() {
        let (_dir, store) = seeded(&[(
            "call.c",
            "int alpha(int x)\n{\n    return x;\n}\nint wrap(int y)\n{\n    int t = alpha(y);\n    return alpha(t) + alpha(1);\n}\n",
        )]);
        let nodes = children(
            &store,
            store.root(),
            "alpha",
            "call.c",
            0,
            RelationKind::RefsTo,
        );
        assert_eq!(nodes.len(), 1);
        assert_eq!(
            (
                nodes[0].name.as_str(),
                nodes[0].edge_line,
                nodes[0].edge_count
            ),
            ("wrap", 6, 3)
        );
    }

    /// refsFrom counts the body's repeated unmasked calls and skips the commented one:
    /// alpha twice as code (one edge, count 2), never the prose mention.
    #[test]
    fn refs_from_counts_unmasked_calls_only() {
        let (_dir, store) = seeded(&[(
            "use.c",
            "int alpha(int x)\n{\n    return x;\n}\nint beta(int y)\n{\n    int t = alpha(y);\n    /* alpha(y) twice would be greedy */\n    return alpha(t);\n}\n",
        )]);
        let nodes = children(
            &store,
            store.root(),
            "beta",
            "use.c",
            4,
            RelationKind::RefsFrom,
        );
        assert_eq!(nodes.len(), 1, "the commented mention is not a second edge");
        assert_eq!(
            (
                nodes[0].name.as_str(),
                nodes[0].edge_path.as_str(),
                nodes[0].edge_line,
                nodes[0].edge_kind.as_str(),
                nodes[0].edge_count
            ),
            ("alpha", "use.c", 6, "call", 2)
        );
    }

    /// A spent budget stops the ring before its first file: truncated with nothing shown.
    #[test]
    fn zero_budget_truncates_immediately() {
        let mut big = String::from("int hub(int x)\n{\n    return x;\n}\n");
        for i in 0..20 {
            big.push_str(&format!("int caller{i:02}(int n)\n{{ return hub(n); }}\n"));
        }
        let (_dir, store) = seeded(&[("big.c", big.as_str())]);
        let ans = relation_children_budgeted(
            store.root(),
            &store,
            "hub",
            "big.c",
            0,
            RelationKind::RefsTo,
            0,
        )
        .unwrap();
        assert!(ans.truncated);
        assert!(ans.nodes.is_empty());
    }

    /// The truncated flag rides the node cap too: 505 callers cut at 500 report the cut.
    #[test]
    fn the_node_cap_marks_the_answer_truncated() {
        let mut big = String::from("int hub(int x)\n{\n    return x;\n}\n");
        for i in 0..505 {
            big.push_str(&format!("int caller{i:03}(int n)\n{{ return hub(n); }}\n"));
        }
        let (_dir, store) = seeded(&[("big.c", big.as_str())]);
        let ans = answer(
            &store,
            store.root(),
            "hub",
            "big.c",
            0,
            RelationKind::RefsTo,
        );
        assert_eq!(ans.nodes.len(), MAX_NODES);
        assert!(ans.truncated);
    }

    /// The Calls view: the body's call edges only — a macro reference and a
    /// local never answer; the `callees` spelling rides parse() into the same view.
    #[test]
    fn calls_keeps_only_the_call_edges() {
        let (_dir, store) = seeded(&[(
            "use.c",
            "#define MAGIC_NUM 7\nint alpha(int x)\n{\n    return x;\n}\nint beta(int y)\n{\n    int t = alpha(y) + MAGIC_NUM;\n    return t + alpha(t);\n}\n",
        )]);
        let calls = children(&store, store.root(), "beta", "use.c", 6, RelationKind::Calls);
        assert_eq!(
            calls.len(),
            1,
            "the macro reference is a use, the local resolves to nothing: {calls:?}"
        );
        assert_eq!(
            (calls[0].name.as_str(), calls[0].edge_kind.as_str()),
            ("alpha", "call")
        );
    }

    /// The Callers view: refsTo through the call edges only — a use-site
    /// reference never poses as a caller.
    #[test]
    fn callers_keeps_only_the_call_edges() {
        let (_dir, store) = seeded(&[(
            "src/a.c",
            "int alpha(int x)\n{\n    return x;\n}\nint calls_it(int y)\n{\n    return alpha(y);\n}\nint names_it(void)\n{\n    typedef int Fn;\n    return 0;\n}\n",
        )]);
        let callers = children(
            &store,
            store.root(),
            "alpha",
            "src/a.c",
            0,
            RelationKind::Callers,
        );
        assert_eq!(callers.len(), 1);
        assert_eq!(callers[0].name, "calls_it");
    }

    /// Calls and Callers: the caller ring first, the callee ring merged in, a mutual
    /// counterpart keeping one node whose count is the pair's total sites; each node's
    /// edge coordinates name its side (a caller's edge site lives in its own file, a
    /// callee's in the subject's) so the branch drills by its own kind.
    #[test]
    fn calls_and_callers_merges_both_sides_callers_first() {
        let (_dir, store) = seeded(&[
            ("src/lib.c", "int alpha(int x)\n{\n    return beta(x) + 1;\n}\n"),
            ("src/beta.c", "int beta(int y)\n{\n    return alpha(y) + 1;\n}\n"),
            ("src/other.c", "int gamma(int n)\n{\n    return alpha(n) - 1;\n}\n"),
        ]);
        let root = store.root().to_owned();
        let nodes = children(
            &store,
            &root,
            "alpha",
            "src/lib.c",
            0,
            RelationKind::CallsAndCallers,
        );
        // alpha's callers: beta (the mutual pair) and gamma; alpha's callees: beta. The
        // merged ring keeps one node per counterpart — beta's count is the pair's total —
        // and the caller side's coordinates stay, so the frontend's branch reads beta as
        // a caller. Equal earliest sites run in file order (beta.c before other.c).
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].name, "beta");
        assert_eq!(nodes[0].edge_count, 2);
        assert_eq!(nodes[0].edge_path, "src/beta.c");
        // The merged edge keeps both sides' site lines (here the same line twice — the
        // dedup collapses them; the count stays the pair's total).
        assert_eq!(nodes[0].edge_lines, vec![2]);
        assert!(nodes[0].has_children);
        assert_eq!(nodes[1].name, "gamma");
        assert_eq!(nodes[1].edge_path, "src/other.c");
        assert_eq!(nodes[1].edge_lines, vec![2]);
        assert!(!nodes[1].has_children, "nobody calls gamma");
    }

    /// Referenced by Files / Modules: one node per file, the count the file's kept sites,
    /// the earliest line kept, and the files answering leaves.
    #[test]
    fn referenced_by_files_keys_the_ring_by_file() {
        let (_dir, store) = seeded(&[
            (
                "src/a.c",
                "int alpha(int x)\n{\n    return x;\n}\nint wrap(int y)\n{\n    return alpha(y) + alpha(y);\n}\n",
            ),
            ("src/b.c", "int beta(int n)\n{\n    return alpha(n) * 2;\n}\n"),
        ]);
        let nodes = children(
            &store,
            store.root(),
            "alpha",
            "src/a.c",
            0,
            RelationKind::RefByFiles,
        );
        assert_eq!(nodes.len(), 2);
        assert!(
            nodes.iter().all(|node| node.kind == "file" && !node.has_children),
            "{nodes:?}"
        );
        let a = nodes.iter().find(|node| node.path == "src/a.c").unwrap();
        let b = nodes.iter().find(|node| node.path == "src/b.c").unwrap();
        assert_eq!((a.edge_count, a.edge_line), (2, 6));
        assert_eq!((b.edge_count, b.edge_line), (1, 2));
        // The file node's own numbered rows: a.c's two same-line sites dedup into one.
        assert_eq!(a.edge_lines, vec![6]);
        assert_eq!(b.edge_lines, vec![2]);
        // The Referenced by Modules spelling parses into the same ring.
        let modules = children(
            &store,
            store.root(),
            "alpha",
            "src/a.c",
            0,
            RelationKind::parse("referencedbymodules").unwrap(),
        );
        assert_eq!(modules.len(), 2);
    }

    /// Container: the enclosing type one ring up, the membership edge at the subject's
    /// declaration, and the marker answering whether the container has a container of
    /// its own — the chain drills upward one ring at a time.
    #[test]
    fn container_names_the_enclosing_type() {
        let (_dir, store) = seeded(&[(
            "src/gui.cpp",
            "class Shell\n{\npublic:\n    void draw();\n};\nvoid Shell::draw()\n{\n}\n",
        )]);
        // The indexed definition of draw is the out-of-line one (line 5) — the class's
        // prototype is not a captured def; the subject resolves there.
        let nodes = children(
            &store,
            store.root(),
            "draw",
            "src/gui.cpp",
            5,
            RelationKind::Container,
        );
        assert_eq!(nodes.len(), 1);
        assert_eq!(
            (
                nodes[0].name.as_str(),
                nodes[0].kind.as_str(),
                nodes[0].path.as_str()
            ),
            ("Shell", "class", "src/gui.cpp")
        );
        assert_eq!(
            (nodes[0].edge_path.as_str(), nodes[0].edge_line),
            ("src/gui.cpp", 5)
        );
        assert!(!nodes[0].has_children, "Shell has no container of its own");
    }

    /// Member Types / Member Classes: the members filtered by kind — the type-category
    /// members and the class-kind members — with the marker peeking same-kind members
    /// only, so a drill never promises a ring the filter answers empty.
    #[test]
    fn member_rings_filter_by_kind() {
        let (_dir, store) = seeded(&[(
            "src/box.cpp",
            "class Outer\n{\npublic:\n    class Inner\n    {\n    public:\n        class Deepest\n        {\n        };\n    };\n    struct Record\n    {\n    };\n    enum Mode\n    {\n    };\n    void Method()\n    {\n    }\n};\n",
        )]);
        let all = children(
            &store,
            store.root(),
            "Outer",
            "src/box.cpp",
            0,
            RelationKind::Contains,
        );
        assert_eq!(all.len(), 4, "Inner, Record, Mode, Method: {all:?}");
        let types = children(
            &store,
            store.root(),
            "Outer",
            "src/box.cpp",
            0,
            RelationKind::MemberTypes,
        );
        assert_eq!(types.len(), 3, "Inner, Record, Mode: {types:?}");
        let classes = children(
            &store,
            store.root(),
            "Outer",
            "src/box.cpp",
            0,
            RelationKind::MemberClasses,
        );
        assert_eq!(classes.len(), 1, "Inner only: {classes:?}");
        let inner = types.iter().find(|node| node.name == "Inner").unwrap();
        assert!(inner.has_children, "Inner holds one class member");
        let record = types.iter().find(|node| node.name == "Record").unwrap();
        assert!(!record.has_children, "Record holds no type members");
    }

    /// Base Classes / Derived Classes: the parser's base table walked both ways — the
    /// chain's edges at the derivations' own lines, and the markers peeking one level
    /// up, so the inheritance chain drills ring by ring.
    #[test]
    fn base_and_derived_classes_walk_the_inheritance() {
        let (_dir, store) = seeded(&[(
            "src/shape.cpp",
            "class Base\n{\n};\nclass Mid : public Base\n{\n};\nclass Leaf : public Mid\n{\n};\n",
        )]);
        let bases = children(
            &store,
            store.root(),
            "Leaf",
            "src/shape.cpp",
            6,
            RelationKind::BaseClasses,
        );
        assert_eq!(bases.len(), 1);
        assert_eq!(
            (
                bases[0].name.as_str(),
                bases[0].kind.as_str(),
                bases[0].edge_kind.as_str()
            ),
            ("Mid", "class", "base")
        );
        assert_eq!(
            (bases[0].edge_path.as_str(), bases[0].edge_line),
            ("src/shape.cpp", 6)
        );
        assert!(bases[0].has_children, "Mid derives from Base — the chain drills");
        let derived = children(
            &store,
            store.root(),
            "Base",
            "src/shape.cpp",
            0,
            RelationKind::DerivedClasses,
        );
        assert_eq!(derived.len(), 1);
        assert_eq!(derived[0].name, "Mid");
        assert_eq!(derived[0].edge_path, "src/shape.cpp");
        // A leaf nothing derives answers the empty ring.
        let none = children(
            &store,
            store.root(),
            "Leaf",
            "src/shape.cpp",
            6,
            RelationKind::DerivedClasses,
        );
        assert_eq!(none.len(), 0);
    }

    /// Referenced by Functions is refsTo under its own view name — the same ring, the
    /// same answer, one query.
    #[test]
    fn referenced_by_functions_is_refs_to() {
        let (_dir, store) = seeded(&[(
            "src/a.c",
            "int alpha(int x)\n{\n    return x;\n}\nint wrap(int y)\n{\n    return alpha(y);\n}\n",
        )]);
        let by_functions = answer(
            &store,
            store.root(),
            "alpha",
            "src/a.c",
            0,
            RelationKind::parse("referencedByFunctions").unwrap(),
        );
        let refs_to = answer(
            &store,
            store.root(),
            "alpha",
            "src/a.c",
            0,
            RelationKind::RefsTo,
        );
        assert_eq!(by_functions, refs_to);
        assert_eq!(by_functions.nodes.len(), 1);
        assert_eq!(by_functions.nodes[0].name, "wrap");
    }

    /// A parameter or local variable declared in the first few lines of a function
    /// shadows any global symbol of the same name in other files during refsFrom, and
    /// same-line callers in different files stay distinct during refsTo.
    #[test]
    fn refs_from_ignores_shadowing_locals_and_refs_to_keeps_same_line_callers_across_files() {
        let (_dir, store) = seeded(&[
            (
                "src/a.c",
                "int target(void)\n{\n    return 1;\n}\nint step(int count)\n{\n    int res = count + 1;\n    return target() + res;\n}\n",
            ),
            (
                "src/b.c",
                "int step(int n)\n{\n    return target() + n;\n}\n",
            ),
            (
                "src/globals.c",
                "int count = 10;\nint res = 20;\nint step(void)\n{\n    return target();\n}\n",
            ),
        ]);
        let root = store.root().to_owned();

        // Inside `src/a.c::step`, `count` is a parameter and `res` is a local variable;
        // neither may resolve to `src/globals.c`'s global variables of the same name.
        let callees = children(&store, &root, "step", "src/a.c", 5, RelationKind::RefsFrom);
        assert_eq!(
            callees.iter().map(|n| (n.name.as_str(), n.path.as_str())).collect::<Vec<_>>(),
            vec![("target", "src/a.c")]
        );

        // Both `src/a.c` and `src/b.c` define a caller `work` on line 0 that calls `target`:
        // `refs_to` must keep every file's caller separate even when two files define the
        // caller on the same line number.
        let (_dir2, store2) = seeded(&[
            (
                "src/a.c",
                "int work(void)\n{\n    return target();\n}\nint target(void)\n{\n    return 0;\n}\n",
            ),
            (
                "src/b.c",
                "int work(void)\n{\n    return target();\n}\n",
            ),
        ]);
        let callers = children(&store2, store2.root(), "target", "src/a.c", 4, RelationKind::RefsTo);
        assert_eq!(
            callers.iter().map(|n| (n.name.as_str(), n.path.as_str(), n.line)).collect::<Vec<_>>(),
            vec![("work", "src/a.c", 0), ("work", "src/b.c", 0)]
        );
    }
}