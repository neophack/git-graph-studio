//! The relation queries behind the Relation window: one subject
//! definition's inbound ring (`refsTo` — who references it) and outbound ring (`refsFrom`
//! — what its body references), every child carried with the reference site that produced
//! the edge. Inbound rides the same occurrence-narrowed whole-word scan Find References
//! speaks, and the store's per-file def intervals attribute each raw hit to the definition
//! that owns its line — so a declaration line is skipped and a call inside a caller's body
//! names that caller. Hits the file's comment/string mask covers
//! ([`crate::symbols::mask`]) are the comment's or string's own words, not code,
//! and go. Outbound reads the subject's own file once and resolves every distinct word of
//! its body — unmasked body words — against the store's declarations. Repeated sites of
//! one edge merge into the single node whose `edge_count` accumulates and whose
//! `edge_line` keeps the earliest site — the callers-and-calls count, one node per
//! counterpart. Nothing here materializes the index: each step asks
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
use crate::symbols::mask::{mask, CodeMask};
use crate::symbols::store::{FileOutlineRow, SymbolStore};
use crate::symbols::WorkspaceSymbol;

/// The children one direction returns at most: the window expands ring by ring, and a
/// hub name's caller list is read, not painted as a graph. Tripping it marks the answer
/// truncated — the ring had more to show.
const MAX_NODES: usize = 500;
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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelationDirection {
    RefsTo,
    RefsFrom,
}

impl RelationDirection {
    /// The wire spelling the frontend sends; anything else is an error, not a default.
    pub fn parse(value: &str) -> Result<RelationDirection, String> {
        match value {
            "refsTo" => Ok(RelationDirection::RefsTo),
            "refsFrom" => Ok(RelationDirection::RefsFrom),
            other => Err(format!("unknown relation direction: {other}")),
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
/// cursor with the location the context-symbol resolution reported. `refsTo` needs only
/// the name (its edges are found by scanning the name everywhere and attributing each
/// hit, so the subject itself is never resolved); `refsFrom` resolves the subject's body
/// extent from all three.
pub fn relation_children(
    root: &str,
    store: &SymbolStore,
    name: &str,
    path: &str,
    line: usize,
    direction: RelationDirection,
) -> Result<RelationAnswer, String> {
    relation_children_budgeted(root, store, name, path, line, direction, RELATION_BUDGET_MS)
}

/// The same query under an explicit budget in milliseconds — the tests' dial; 0 means
/// the budget is spent before the first item and the ring truncates immediately.
pub fn relation_children_budgeted(
    root: &str,
    store: &SymbolStore,
    name: &str,
    path: &str,
    line: usize,
    direction: RelationDirection,
    budget_ms: u64,
) -> Result<RelationAnswer, String> {
    let budget = Budget::after(budget_ms);
    match direction {
        RelationDirection::RefsTo => refs_to(root, store, name, MAX_NODES, true, &budget),
        RelationDirection::RefsFrom => {
            refs_from(store, name, path, line, MAX_NODES, true, &budget)
        }
    }
}

/* ---------- refsTo ---------- */

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
    limit: usize,
    with_flags: bool,
    budget: &Budget,
) -> Result<RelationAnswer, String> {
    let narrow = store.files_containing(name);
    let (files, _) = scan_references_bounded(root, name, narrow, SCAN_KEEP, "")?;
    let mut nodes: Vec<RelationNode> = Vec::new();
    let mut index_of: HashMap<(String, String, usize), usize> = HashMap::new();
    let mut masks: HashMap<String, Option<CodeMask>> = HashMap::new();
    let mut truncated = false;
    let mut files_seen = 0usize;
    let mut hits_seen = 0usize;
    'files: for file in files {
        files_seen += 1;
        if files_seen % BUDGET_FILES_PER_CHECK == 1 && budget.expired() {
            truncated = true;
            break;
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
            if file_mask(root, &mut masks, &file.path)
                .is_some_and(|mask| mask.is_masked(site, hit.column - 1))
            {
                continue;
            }
            let key = (def.name.clone(), def.kind.to_owned(), def.line);
            if let Some(&at) = index_of.get(&key) {
                // The pair's later sites only thicken the edge they already made.
                nodes[at].edge_count += 1;
                nodes[at].edge_line = nodes[at].edge_line.min(site);
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
                edge_kind: if is_call_site(&hit.text, hit.column, hit.length) {
                    "call"
                } else {
                    "use"
                }
                .to_owned(),
                edge_count: 1,
                // The peek turns its own flags off: a flag computed inside a peek would
                // chase the whole ring depth-first, one scan per level.
                has_children: with_flags && has_refs_to_children(root, store, &def.name, budget),
            });
            if nodes.len() >= limit {
                truncated = true;
                break 'files;
            }
        }
    }
    nodes.sort_by_key(|node| node.edge_line);
    Ok(RelationAnswer { nodes, truncated })
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
            read_searchable(&Path::new(root).join(path))
                .map(|(bytes, _)| mask(&String::from_utf8_lossy(&bytes)))
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
fn has_refs_to_children(root: &str, store: &SymbolStore, name: &str, budget: &Budget) -> bool {
    match store.files_containing(name) {
        None => true,
        Some(files) if files.len() > PEEK_FILE_CAP => true,
        Some(_) => refs_to(root, store, name, 1, false, budget)
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
    limit: usize,
    with_flags: bool,
    budget: &Budget,
) -> Result<RelationAnswer, String> {
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
    let body_mask = mask(&text);
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
                return Ok(RelationAnswer { nodes, truncated });
            }
            if let Some(&at) = node_of.get(word) {
                // The word's target is fixed; later sites only thicken its edge.
                nodes[at].edge_count += 1;
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
            let Some(target) = same_file
                .iter()
                .find(|def| def.name == word)
                .map(|row| row_def(&subject.path, row))
                .or_else(|| pick_def(&store.lookup(word)).map(sym_def))
            else {
                continue;
            };
            node_of.insert(word, nodes.len());
            nodes.push(RelationNode {
                kind: target.kind.clone(),
                name: target.name.clone(),
                container: target.container.clone(),
                path: target.path.clone(),
                line: target.line,
                edge_path: subject.path.clone(),
                edge_line: line_no,
                edge_kind: if line_text[end..].trim_start().starts_with('(') {
                    "call"
                } else {
                    "use"
                }
                .to_owned(),
                edge_count: 1,
                has_children: with_flags && has_refs_from_children(store, &target, budget),
            });
            if nodes.len() >= limit {
                truncated = true;
                return Ok(RelationAnswer { nodes, truncated });
            }
        }
        if seen.len() > MAX_WORDS {
            break;
        }
    }
    nodes.sort_by_key(|node| node.edge_line);
    Ok(RelationAnswer { nodes, truncated })
}

/// Whether expanding a node as refsFrom yields children — **precise**: the peek re-runs
/// the direction with limit 1 and its flags off, which reads just the node's own file
/// (the bounded read) and stops at the first unmasked edge.
fn has_refs_from_children(store: &SymbolStore, target: &DefRow, budget: &Budget) -> bool {
    refs_from(store, &target.name, &target.path, target.line, 1, false, budget)
        .is_ok_and(|answer| !answer.nodes.is_empty())
}

/// The subject's definition row: the exact `(path, line, name)` hit in that file's
/// outline first — the coordinates the context-symbol resolution reported — then the
/// best global declaration of the name. `None` answers an empty direction, never an
/// error: a subject the index never declared has no body to walk.
fn resolve_def(store: &SymbolStore, name: &str, path: &str, line: usize) -> Option<DefRow> {
    if let Some(rows) = store.file_symbols(path) {
        if let Some(row) = rows.iter().find(|row| row.line == line && row.name == name) {
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
    match ext {
        "c" | "h" => C_KEYWORDS,
        "cpp" | "hpp" => CPP_KEYWORDS,
        "rs" => RUST_KEYWORDS,
        "py" => PYTHON_KEYWORDS,
        "go" => GO_KEYWORDS,
        "js" | "jsx" | "ts" | "tsx" => JS_KEYWORDS,
        "java" => JAVA_KEYWORDS,
        "cs" => CSHARP_KEYWORDS,
        _ => &[],
    }
}

const C_KEYWORDS: &[&str] = &[
    "auto", "break", "case", "char", "const", "continue", "default", "do", "double",
    "else", "enum", "extern", "float", "for", "goto", "if", "inline", "int", "long",
    "register", "restrict", "return", "short", "signed", "sizeof", "static", "struct",
    "switch", "typedef", "union", "unsigned", "void", "volatile", "while",
];

const CPP_KEYWORDS: &[&str] = &[
    "auto", "bool", "break", "case", "catch", "char", "class", "const", "continue",
    "default", "delete", "do", "double", "else", "enum", "explicit", "extern", "false",
    "float", "for", "friend", "goto", "if", "inline", "int", "long", "mutable",
    "namespace", "new", "nullptr", "operator", "private", "protected", "public",
    "register", "return", "short", "signed", "sizeof", "static", "struct", "switch",
    "template", "this", "throw", "true", "try", "typedef", "typename", "union",
    "unsigned", "using", "virtual", "void", "volatile", "while",
];

const RUST_KEYWORDS: &[&str] = &[
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else",
    "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match",
    "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct",
    "super", "trait", "true", "type", "unsafe", "use", "where", "while",
];

const PYTHON_KEYWORDS: &[&str] = &[
    "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
    "del", "elif", "else", "except", "False", "finally", "for", "from", "global", "if",
    "import", "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass", "raise",
    "return", "True", "try", "while", "with", "yield",
];

const GO_KEYWORDS: &[&str] = &[
    "break", "case", "chan", "const", "continue", "default", "defer", "else",
    "fallthrough", "false", "for", "func", "go", "goto", "if", "import", "interface",
    "map", "nil", "package", "range", "return", "select", "struct", "switch", "true",
    "type", "var",
];

const JS_KEYWORDS: &[&str] = &[
    "abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
    "continue", "debugger", "declare", "default", "delete", "do", "else", "enum",
    "export", "extends", "false", "finally", "for", "from", "function", "get", "if",
    "implements", "import", "in", "infer", "instanceof", "interface", "is", "keyof",
    "let", "namespace", "new", "null", "of", "private", "protected", "public",
    "readonly", "return", "set", "static", "super", "switch", "this", "throw", "true",
    "try", "type", "typeof", "undefined", "var", "void", "while", "yield",
];

const JAVA_KEYWORDS: &[&str] = &[
    "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class",
    "continue", "default", "do", "double", "else", "enum", "extends", "false", "final",
    "finally", "float", "for", "if", "implements", "import", "instanceof", "int",
    "interface", "long", "native", "new", "null", "package", "private", "protected",
    "public", "return", "short", "static", "super", "switch", "synchronized", "this",
    "throw", "throws", "transient", "true", "try", "void", "volatile", "while",
];

const CSHARP_KEYWORDS: &[&str] = &[
    "abstract", "as", "async", "await", "base", "bool", "break", "byte", "case",
    "catch", "char", "checked", "class", "const", "continue", "decimal", "default",
    "delegate", "do", "double", "else", "enum", "event", "explicit", "extern", "false",
    "finally", "fixed", "float", "for", "foreach", "goto", "if", "implicit", "in",
    "int", "interface", "internal", "is", "lock", "long", "namespace", "new", "null",
    "object", "operator", "out", "override", "params", "private", "protected", "public",
    "readonly", "ref", "return", "sbyte", "sealed", "short", "sizeof", "stackalloc",
    "static", "string", "struct", "switch", "this", "throw", "true", "try", "typeof",
    "uint", "ulong", "unchecked", "unsafe", "ushort", "using", "var", "virtual", "void",
    "volatile", "when", "while", "yield",
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
        direction: RelationDirection,
    ) -> Vec<RelationNode> {
        answer(store, root, name, path, line, direction).nodes
    }

    fn answer(
        store: &SymbolStore,
        root: &str,
        name: &str,
        path: &str,
        line: usize,
        direction: RelationDirection,
    ) -> RelationAnswer {
        relation_children(root, store, name, path, line, direction).unwrap()
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

        let nodes = children(&store, &root, "alpha", "src/a.c", 1, RelationDirection::RefsTo);
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
        // beta is itself called from gamma's body; wrap is called from nowhere.
        assert!(nodes[0].has_children);
        assert!(!nodes[1].has_children);
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
            RelationDirection::RefsTo,
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
            RelationDirection::RefsFrom,
        );
        assert_eq!(nodes.len(), 2, "alpha twice collapses, locals never resolve");
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
            RelationDirection::RefsFrom,
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
            RelationDirection::RefsFrom,
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
            RelationDirection::RefsFrom,
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
            RelationDirection::RefsFrom,
        );
        assert!(nodes.is_empty());
    }

    /// The direction parses only the two wire spellings; anything else is an error.
    #[test]
    fn direction_parses_the_wire_spelling_only() {
        assert_eq!(
            RelationDirection::parse("refsTo"),
            Ok(RelationDirection::RefsTo)
        );
        assert_eq!(
            RelationDirection::parse("refsFrom"),
            Ok(RelationDirection::RefsFrom)
        );
        assert!(RelationDirection::parse("sideways").is_err());
        assert!(RelationDirection::parse("").is_err());
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
            RelationDirection::RefsTo,
        );
        assert_eq!(nodes.len(), MAX_NODES);
        assert_eq!(nodes[0].name, "caller000");
        assert!(nodes.windows(2).all(|pair| pair[0].edge_line <= pair[1].edge_line));
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
        let nodes = children(&store, &root, "alpha", "src/a.c", 0, RelationDirection::RefsTo);
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
        let nodes = children(&store, &root, "alpha", "src/a.c", 0, RelationDirection::RefsTo);
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
            RelationDirection::RefsTo,
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
            RelationDirection::RefsFrom,
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
            RelationDirection::RefsTo,
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
            RelationDirection::RefsTo,
        );
        assert_eq!(ans.nodes.len(), MAX_NODES);
        assert!(ans.truncated);
    }
}
