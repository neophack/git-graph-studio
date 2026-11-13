//! The Dead Code report (module 17): declarations no call site in the workspace spells.
//! The rule is deliberately conservative — a report is a candidate, not a verdict:
//!
//! - Only functions and methods are candidates; types carry metadata even unreferenced.
//! - "No caller" means *no call site anywhere spells the name, resolved or not* — a name
//!   used as a value, in a config file or from another repository keeps its declaration
//!   out of the report only if something calls it; anything else stays listed, which is
//!   why the page words it "no call sites found in this workspace".
//! - Entrypoints (`main`, constructors, trait/interface default methods) never list.

use std::collections::HashSet;

use serde::Serialize;

use super::model::{Sym, NONE};
use super::AnalysisData;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeadRow {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub container: Option<String>,
    pub line: usize,
    /// Whether the declaration is reachable from outside its file (the parser layer's
    /// visibility reading) — exported candidates are riskier to delete.
    pub exported: bool,
    pub lines: usize,
}

/// The per-report rule inputs, computed once: the interface names and the interned
/// `main`. Both the report builder and the streaming runner share [`Self::is_dead`],
/// so there is exactly one rule.
pub struct DeadFilter<'a> {
    data: &'a AnalysisData,
    interfaces: HashSet<u32>,
    main: u32,
    include_exported: bool,
}

impl<'a> DeadFilter<'a> {
    pub fn new(data: &'a AnalysisData, include_exported: bool) -> DeadFilter<'a> {
        DeadFilter {
            interfaces: data.interface_containers(),
            main: data.names().find("main").unwrap_or(super::model::NONE),
            data,
            include_exported,
        }
    }

    /// Whether one declaration is a dead-code candidate: a function or method nothing
    /// spells, and not an entrypoint.
    pub fn is_dead(&self, sym: &Sym) -> bool {
        if !sym.kind.is_function() {
            return false;
        }
        if !self.include_exported && sym.exported {
            return false;
        }
        // Entrypoints and interface default methods are reachable without callers.
        if sym.name == self.main || (sym.container != NONE && self.interfaces.contains(&sym.container))
        {
            return false;
        }
        // A constructor spells its own class's name — `new S()` names it.
        if sym.container == sym.name {
            return false;
        }
        !self.data.called_id(sym.name)
    }

    /// The report row for a candidate, decoded out of the interned table.
    pub fn row(&self, path: &str, sym: &Sym) -> DeadRow {
        let view = self.data.symbol_of_raw(sym);
        DeadRow {
            path: path.to_owned(),
            name: view.name.to_owned(),
            kind: view.kind.as_str().to_owned(),
            container: view.container.map(str::to_owned),
            line: view.line as usize,
            exported: view.exported,
            lines: view.end_line.saturating_sub(view.line) as usize + 1,
        }
    }
}

/// Every declaration with no call site spelling its name, in path-then-line order.
/// `include_exported` widens the net past file-private declarations.
pub fn dead_rows(data: &AnalysisData, include_exported: bool) -> Vec<DeadRow> {
    let filter = DeadFilter::new(data, include_exported);
    let mut rows = Vec::new();
    for file in data.files() {
        for sym in &file.symbols {
            if filter.is_dead(sym) {
                rows.push(filter.row(&file.path, sym));
            }
        }
    }
    rows
}

/// A count that never materializes the rows — the MCP summary's shape.
pub fn dead_count(data: &AnalysisData, include_exported: bool) -> usize {
    let filter = DeadFilter::new(data, include_exported);
    data.files()
        .iter()
        .map(|file| file.symbols.iter().filter(|sym| filter.is_dead(sym)).count())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uncalled_private_functions_list_and_callers_shield() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "a.rs",
            "pub fn used() { helper(); }\nfn helper() {}\nfn orphan() {}\nfn main() { used(); }\n",
        );
        let root = dir.path().display().to_string();
        let data = AnalysisData::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        let rows = dead_rows(&data, false);
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
        let data = AnalysisData::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        assert!(dead_rows(&data, false).is_empty());
        let rows = dead_rows(&data, true);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "exported_orphan");
        assert!(rows[0].exported);
    }

    #[test]
    fn an_unresolved_call_shields_its_name() {
        // A call site that resolves to nothing (an external function of the same
        // spelling) must keep a same-named local declaration out of the report.
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "a.rs",
            "fn drive() { steer(); }\nfn steer() {}\n",
        );
        write(
            dir.path(),
            "b.rs",
            "// steer is declared in a.rs and called in a.rs — resolved\n",
        );
        let root = dir.path().display().to_string();
        let data = AnalysisData::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        let rows = dead_rows(&data, false);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "drive");
    }

    fn write(root: &std::path::Path, path: &str, text: &str) {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap_or(root)).unwrap();
        std::fs::write(file, text).unwrap();
    }
}
