//! The Dead Code report (module 17): declarations no call site in the workspace
//! spells — read straight off the project volumes' store, never the Code Analysis
//! engine. The catalogue is the store's own (every file the volumes carry, every
//! function/method row with its span), the occurrence lists are the store's (which
//! files mention a name at all — the per-name lists the volumes persist), and the
//! confirmation is the masked token walk (`sites::call_sites`) over the declaring
//! files' text — one read per file, the security scan's rhythm. A folder the index
//! covers answers instantly; nothing parses a tree to answer it.
//!
//! The rule is deliberately conservative — a report is a candidate, not a verdict:
//!
//! - Only functions and methods are candidates; types carry metadata even unreferenced.
//! - "No caller" means the name's every occurrence sits in a file that also declares it
//!   AND no unmasked `name(` spelling stands outside that name's own declaration
//!   spellings (the store's recorded (line, column) per declaration — a one-liner's
//!   recursion stands at a different column and still shields) —
//!   a name used as a value, in a config file or from another repository keeps its
//!   declaration out of the report (the occurrence lists keep it out of step 2), which
//!   is why the page words it "no call sites found in this workspace".
//! - A name the store's occurrence lists do not vouch for (an incrementally-updated
//!   name whose list is not trusted complete) never becomes a candidate.
//! - Entrypoints (`main`, constructors, trait/interface methods) never list.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use ggs_index::symbols::sites;
use ggs_index::symbols::store::SymbolStore;
use ggs_index::symbols::vol_reader::XcBloomCache;
use ggs_index::symbols::WorkspaceSymbol;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeadRow {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub container: Option<String>,
    pub line: usize,
    /// Whether the declaration is reachable from outside its file (the line-text
    /// visibility reading, `sites::exported_of_line`) — exported candidates are
    /// riskier to delete.
    pub exported: bool,
    pub lines: usize,
}

/// The store's facts the rule reads, snapshotted under the store's lock in
/// milliseconds — the catalogue pass and the occurrence lookups are the only store
/// work, and the file reads of the confirmation pass run lock-free (the save's own
/// discipline: a report never stalls the queries).
pub struct DeadCatalogue {
    /// Every declaration the store carries, in the store's path-then-line order.
    pub symbols: Vec<WorkspaceSymbol>,
    /// The occurrence lists of the names the catalogue puts forward as candidates:
    /// name → the files mentioning it. A name absent here was never vouched for.
    pub refs: HashMap<String, Vec<String>>,
}

/// The snapshot: the store walked once under its lock (every declaration, every
/// interface name), the function/method names' occurrence lists looked up beside them.
pub fn dead_catalogue(store: &SymbolStore) -> DeadCatalogue {
    dead_catalogue_with_vols(store, None)
}

/// Volume-accelerated dead-code catalogue: when the 9-volume directory is fresh, loads
/// `.ggs_xc` (code-only Bloom signature) once and intersects each candidate's occurrence
/// list so comment/string-only mentions in other files do not falsely shield dead code.
pub fn dead_catalogue_with_vols(
    store: &SymbolStore,
    vol_dir: Option<&std::path::Path>,
) -> DeadCatalogue {
    let symbols = store.all_symbols();
    let mut candidate_names: HashSet<String> = HashSet::new();
    for symbol in &symbols {
        if symbol.kind == "function" || symbol.kind == "method" {
            candidate_names.insert(symbol.name.clone());
        }
    }
    let all_files: Vec<String> = if vol_dir.is_some() {
        store
            .files_with_counts()
            .into_iter()
            .map(|(p, _)| p)
            .collect()
    } else {
        Vec::new()
    };
    let xc = vol_dir.and_then(|dir| XcBloomCache::load(dir, all_files.len()));
    let mut refs = HashMap::new();
    for name in candidate_names {
        if let Some(containing) = store.files_containing(&name) {
            let narrowed = if let Some(ref bloom) = xc {
                if let Some(code_files) = bloom.filter_files(&name, &all_files) {
                    let set: HashSet<&str> = code_files.iter().map(String::as_str).collect();
                    containing
                        .into_iter()
                        .filter(|p| set.contains(p.as_str()))
                        .collect()
                } else {
                    containing
                }
            } else {
                containing
            };
            refs.insert(name, narrowed);
        }
    }
    DeadCatalogue { symbols, refs }
}

/// One candidate row while the report walks: the store's declaration facts plus where
/// the candidate stands for the confirmation pass.
struct Candidate {
    path: String,
    name: String,
    kind: String,
    container: Option<String>,
    line: usize,
    column: usize,
    end_line: usize,
}

/// The report's own rule, in one streaming pass. `emit` receives every row in
/// path-then-line order; the answer is the row count. `is_current` gates the walk —
/// a cancelled report stops where it stands and the count covers the rows emitted.
pub fn dead_rows_streaming(
    root: &str,
    catalogue: &DeadCatalogue,
    include_exported: bool,
    is_current: &dyn Fn() -> bool,
    mut emit: impl FnMut(DeadRow),
) -> usize {
    /* Pass 1 — the catalogue: every function/method declaration, every interface name,
     * and which files declare each name (any kind — a prototype's file declares it
     * too). */
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut interfaces: HashSet<String> = HashSet::new();
    let mut declaring: HashMap<String, HashSet<String>> = HashMap::new();
    for symbol in &catalogue.symbols {
        declaring
            .entry(symbol.name.clone())
            .or_default()
            .insert(symbol.path.clone());
        match symbol.kind.as_str() {
            "function" | "method" => candidates.push(Candidate {
                path: symbol.path.clone(),
                name: symbol.name.clone(),
                kind: symbol.kind.clone(),
                container: symbol.container.clone(),
                line: symbol.line,
                column: symbol.column,
                end_line: symbol.end_line,
            }),
            "interface" => {
                interfaces.insert(symbol.name.clone());
            }
            _ => {}
        }
    }

    /* Pass 2 — the exemptions (per declaration: `main`, a constructor spelling its
     * own class's name, an interface's method) and the occurrence pre-filter (per
     * name: the name's every mention sits in a file that also declares it; a name
     * the snapshot does not vouch for is skipped whole). */
    candidates.retain(|candidate| {
        candidate.name != "main"
            && candidate.container.as_deref() != Some(candidate.name.as_str())
            && !candidate
                .container
                .as_ref()
                .is_some_and(|c| interfaces.contains(c))
    });
    let mut verdicts: HashMap<String, bool> = HashMap::new();
    candidates.retain(|candidate| {
        *verdicts
            .entry(candidate.name.clone())
            .or_insert_with(|| {
                catalogue.refs.get(&candidate.name).is_some_and(|refs| {
                    let declared = declaring.get(&candidate.name);
                    refs.iter()
                        .all(|file| declared.is_some_and(|d| d.contains(file)))
                })
            })
    });

    /* Pass 3 — the masked call confirmation over the candidates' declaring files.
     * One read per file; a `name(` that is not one of that name's own declaration
     * spellings marks the name called. The exclusion is the declaration's own
     * (line, column) — the exact spelling the store recorded — so a one-line
     * `fn alpha() { alpha(); }`'s recursion counts (the tree-sitter call bitset's
     * verdict, kept) while the declaration itself never does. The exported flag
     * reads off the same lines. */
    let mut by_file: HashMap<&str, Vec<&Candidate>> = HashMap::new();
    let mut decl_spells: HashMap<(&str, &str), Vec<(usize, usize)>> = HashMap::new();
    for candidate in &candidates {
        by_file
            .entry(candidate.path.as_str())
            .or_default()
            .push(candidate);
        decl_spells
            .entry((candidate.path.as_str(), candidate.name.as_str()))
            .or_default()
            .push((candidate.line, candidate.column));
    }
    let mut called: HashSet<String> = HashSet::new();
    let mut exported: HashMap<(&str, &str), bool> = HashMap::new();
    let mut paths: Vec<&str> = by_file.keys().copied().collect();
    paths.sort_unstable();
    for path in paths {
        if !is_current() {
            break;
        }
        let Ok(bytes) = std::fs::read(std::path::Path::new(root).join(path)) else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        let ext = path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
        let wanted: HashSet<&str> = by_file[path]
            .iter()
            .map(|candidate| candidate.name.as_str())
            .collect();
        for site in sites::call_sites(ext, &text, &|name| wanted.contains(name)) {
            let own = decl_spells
                .get(&(path, site.name.as_str()))
                .is_some_and(|spells| spells.contains(&(site.line, site.column)));
            if !own {
                called.insert(site.name);
            }
        }
        // The candidates' visibility lines, read off the same text.
        let lines: Vec<&str> = text.lines().collect();
        for candidate in &by_file[path] {
            let key = (path, candidate.name.as_str());
            let decl = lines.get(candidate.line).copied().unwrap_or_default();
            let prev = candidate
                .line
                .checked_sub(1)
                .and_then(|at| lines.get(at))
                .copied()
                .unwrap_or_default();
            exported.insert(key, sites::exported_of_line(ext, prev, decl, &candidate.name));
        }
    }

    /* Pass 4 — the rows, path-then-line order, the store's own order. */
    let mut total = 0usize;
    for candidate in &candidates {
        if called.contains(candidate.name.as_str()) {
            continue;
        }
        let exported_flag = exported
            .get(&(candidate.path.as_str(), candidate.name.as_str()))
            .copied()
            .unwrap_or(true);
        if !include_exported && exported_flag {
            continue;
        }
        total += 1;
        emit(DeadRow {
            path: candidate.path.clone(),
            name: candidate.name.clone(),
            kind: candidate.kind.clone(),
            container: candidate.container.clone(),
            line: candidate.line,
            exported: exported_flag,
            lines: candidate.end_line.saturating_sub(candidate.line) + 1,
        });
    }
    total
}

/// Every candidate as one list — the tests' shape over the streaming rule.
pub fn dead_rows(root: &str, catalogue: &DeadCatalogue, include_exported: bool) -> Vec<DeadRow> {
    let mut rows = Vec::new();
    dead_rows_streaming(root, catalogue, include_exported, &|| true, |row| {
        rows.push(row)
    });
    rows
}

/// A count that never materializes the rows — the MCP summary's shape.
pub fn dead_count(root: &str, catalogue: &DeadCatalogue, include_exported: bool) -> usize {
    dead_rows_streaming(root, catalogue, include_exported, &|| true, |_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_of(root: &str) -> SymbolStore {
        SymbolStore::build(root, 4, &|_, _| {}, &|| false).unwrap()
    }

    fn catalogue_of(root: &str) -> DeadCatalogue {
        dead_catalogue(&store_of(root))
    }

    #[test]
    fn uncalled_private_functions_list_and_callers_shield() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "a.rs",
            "pub fn used() { helper(); }\nfn helper() {}\nfn orphan() {}\nfn main() { used(); }\n",
        );
        let root = dir.path().display().to_string();
        let rows = dead_rows(&root, &catalogue_of(&root), false);
        let names: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(
            names,
            ["orphan"],
            "helper is called, main is an entrypoint, used is exported"
        );
    }

    #[test]
    fn include_exported_widens_the_net() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.rs", "pub fn exported_orphan() {}\n");
        let root = dir.path().display().to_string();
        assert!(dead_rows(&root, &catalogue_of(&root), false).is_empty());
        let rows = dead_rows(&root, &catalogue_of(&root), true);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "exported_orphan");
        assert!(rows[0].exported);
    }

    #[test]
    fn a_use_in_another_file_shields_its_name() {
        // The conservative rule: a word use (not a call) in another file still keeps
        // the declaration out — the occurrence lists answer before any scan.
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.rs", "fn drive() { steer(); }\nfn steer() {}\n");
        write(dir.path(), "b.rs", "const TABLE: &[&str] = &[\"steer\"];\n");
        let root = dir.path().display().to_string();
        let rows = dead_rows(&root, &catalogue_of(&root), false);
        let names: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["drive"], "steer is named in b.rs: {names:?}");
    }

    #[test]
    fn a_commented_call_never_shields() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "a.rs",
            "fn gone() {}\nfn kept() {}\nfn main() {\n    // gone();\n    kept();\n}\n",
        );
        let root = dir.path().display().to_string();
        let rows = dead_rows(&root, &catalogue_of(&root), true);
        let names: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["gone"], "the comment's spelling is no call: {names:?}");
    }

    #[test]
    fn recursion_and_self_files_count() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.rs", "fn loops(n: u32) -> u32 {\n    if n > 0 { loops(n - 1) } else { 0 }\n}\nfn main() { loops(3); }\n");
        let root = dir.path().display().to_string();
        let rows = dead_rows(&root, &catalogue_of(&root), true);
        assert!(
            rows.iter().all(|r| r.name != "loops"),
            "the recursive call shields loops: {rows:?}"
        );
    }

    #[test]
    fn a_one_line_recursion_counts_like_the_engine_did() {
        // The declaration exclusion is the declaration's own (line, column), not the
        // whole declaration span: a one-liner's recursive call stands on the same line
        // at a different column and still shields its name — the tree-sitter call
        // bitset's exact verdict.
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.rs", "fn again() { again(); }\nfn main() { again(); }\n");
        let root = dir.path().display().to_string();
        let rows = dead_rows(&root, &catalogue_of(&root), true);
        assert!(
            rows.iter().all(|r| r.name != "again"),
            "the one-line recursion shields again: {rows:?}"
        );
    }

    fn write(root: &std::path::Path, path: &str, text: &str) {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap_or(root)).unwrap();
        std::fs::write(file, text).unwrap();
    }
}

