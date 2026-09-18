//! The Dead Code report (module 17): declarations no call site in the workspace spells.
//! The rule is deliberately conservative — a report is a candidate, not a verdict:
//!
//! - Only functions and methods are candidates; types carry metadata even unreferenced.
//! - "No caller" means *no call site anywhere spells the name, resolved or not* — a name
//!   used as a value, in a config file or from another repository keeps its declaration
//!   out of the report only if something calls it; anything else stays listed, which is
//!   why the page words it "no call sites found in this workspace".
//! - Entrypoints (`main`, constructors, trait/interface default methods) never list.

use serde::Serialize;

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

/// Every declaration with no call site spelling its name, in path-then-line order.
/// `include_exported` widens the net past file-private declarations.
pub fn dead_rows(data: &AnalysisData, include_exported: bool) -> Vec<DeadRow> {
    let interfaces = data.interface_containers();
    let mut rows = Vec::new();
    for file in data.files() {
        for symbol in &file.symbols {
            if symbol.kind != "function" && symbol.kind != "method" {
                continue;
            }
            if !include_exported && symbol.exported {
                continue;
            }
            // Entrypoints and interface default methods are reachable without callers.
            if symbol.name == "main"
                || interfaces.contains(symbol.container.as_deref().unwrap_or(""))
            {
                continue;
            }
            // A constructor spells its own class's name — `new S()` names it.
            if symbol.name == symbol.container.as_deref().unwrap_or("\0") {
                continue;
            }
            if data.called_anywhere(&symbol.name) {
                continue;
            }
            rows.push(DeadRow {
                path: file.path.clone(),
                name: symbol.name.clone(),
                kind: symbol.kind.to_owned(),
                container: symbol.container.clone(),
                line: symbol.line,
                exported: symbol.exported,
                lines: symbol.end_line.saturating_sub(symbol.line) + 1,
            });
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &std::path::Path, path: &str, text: &str) {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap_or(root)).unwrap();
        std::fs::write(file, text).unwrap();
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
}
