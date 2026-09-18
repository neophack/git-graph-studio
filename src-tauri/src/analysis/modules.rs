//! The Module Analysis report (module 17): the workspace's cross-file call
//! relationships lifted to the files that carry them and the directories (the
//! "modules") that group them — which module depends on which, which file calls which,
//! and the individual call sites under each file pair. The same call resolution the
//! engine always did (name matching with receiver hints), presented twice by the page:
//! a drawing (every busy file a block, every cross-file dependency an arrow — the
//! positions the @antv/G6 layouts assign in the page, not geometry shipped over IPC)
//! and a collapsible tree (module edges open into file pairs and call sites). Both
//! views cap what they draw; the totals stay honest about what was capped away.

use std::collections::HashMap;

use serde::Serialize;

use super::AnalysisData;

/// File dependencies itemised (also per module edge); pairs beyond this are counted in
/// the module edges and `total_file_edges` but not listed.
const MAX_FILE_EDGES: usize = 5000;
/// Call sites listed under one file pair.
const SITES_PER_EDGE: usize = 50;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleInfo {
    /// The directory path (forward slashes); "" is the workspace root.
    pub name: String,
    pub files: u32,
    pub symbols: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleEdge {
    pub from: String,
    pub to: String,
    /// Resolved cross-file calls between the two modules.
    pub calls: u32,
    /// How many file pairs carry them (every pair, also ones the listing cap drops).
    pub files: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CallSiteRow {
    /// The caller as the page prints it: `container.name` when it has a container.
    pub from: String,
    pub to: String,
    /// Where the call happens — in the pair's `from` file.
    pub line: usize,
    pub column: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileDep {
    pub from: String,
    pub to: String,
    /// Every resolved call between the two files (the sites below are a prefix).
    pub calls: u32,
    pub sites: Vec<CallSiteRow>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleGraph {
    /// Every directory with source files, sorted by name.
    pub modules: Vec<ModuleInfo>,
    /// Module dependencies sorted by calls, most first.
    pub edges: Vec<ModuleEdge>,
    /// File dependencies sorted by calls, most first.
    pub file_edges: Vec<FileDep>,
    /// The workspace totals before the caps above.
    pub total_calls: usize,
    pub total_file_edges: usize,
}

/// Build the module graph of an analysis.
pub fn module_graph(data: &AnalysisData) -> ModuleGraph {
    let mut modules: HashMap<String, (u32, u32)> = HashMap::new();
    for file in data.files() {
        let entry = modules.entry(module_of(&file.path).to_owned()).or_default();
        entry.0 += 1;
        entry.1 += file.symbols.len() as u32;
    }
    let modules: Vec<ModuleInfo> = {
        let mut list: Vec<ModuleInfo> = modules
            .into_iter()
            .map(|(name, (files, symbols))| ModuleInfo {
                name,
                files,
                symbols,
            })
            .collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        list
    };
    // Group every cross-file call under its file pair, then lift the pairs to modules —
    // the module aggregation runs over the full pairs so its counts never depend on the
    // listing caps.
    let mut pairs: HashMap<(String, String), Vec<CallSiteRow>> = HashMap::new();
    for call in data.cross_file_calls() {
        pairs
            .entry((call.from_file, call.to_file))
            .or_default()
            .push(CallSiteRow {
                from: call.from_name,
                to: call.to_name,
                line: call.line,
                column: call.column,
            });
    }
    let total_file_edges = pairs.len();
    let total_calls: usize = pairs.values().map(Vec::len).sum();
    let mut file_edges: Vec<FileDep> = pairs
        .into_iter()
        .map(|((from, to), mut sites)| {
            // Call order inside the caller file; the name tiebreak keeps it total.
            sites.sort_by(|a, b| {
                (a.line, a.column, &a.from, &a.to).cmp(&(b.line, b.column, &b.from, &b.to))
            });
            FileDep {
                from,
                to,
                calls: sites.len() as u32,
                sites,
            }
        })
        .collect();
    file_edges.sort_by(|a, b| {
        b.calls
            .cmp(&a.calls)
            .then((&a.from, &a.to).cmp(&(&b.from, &b.to)))
    });
    let mut edges: HashMap<(String, String), ModuleEdge> = HashMap::new();
    for dep in &file_edges {
        let entry = edges
            .entry((
                module_of(&dep.from).to_owned(),
                module_of(&dep.to).to_owned(),
            ))
            .or_insert_with(|| ModuleEdge {
                from: module_of(&dep.from).to_owned(),
                to: module_of(&dep.to).to_owned(),
                calls: 0,
                files: 0,
            });
        entry.calls += dep.calls;
        entry.files += 1;
    }
    let mut edges: Vec<ModuleEdge> = edges.into_values().collect();
    edges.sort_by(|a, b| {
        b.calls
            .cmp(&a.calls)
            .then((&a.from, &a.to).cmp(&(&b.from, &b.to)))
    });
    for dep in &mut file_edges {
        dep.sites.truncate(SITES_PER_EDGE);
    }
    file_edges.truncate(MAX_FILE_EDGES);
    ModuleGraph {
        modules,
        edges,
        file_edges,
        total_calls,
        total_file_edges,
    }
}

/// A file's module: its directory; "" is the workspace root.
pub fn module_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(at) => &path[..at],
        None => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &std::path::Path, path: &str, text: &str) {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap_or(root)).unwrap();
        std::fs::write(file, text).unwrap();
    }

    fn built(root: &std::path::Path) -> AnalysisData {
        AnalysisData::build(&root.display().to_string(), 4, &|_, _| {}, &|| false).unwrap()
    }

    #[test]
    fn cross_file_calls_group_into_modules_files_and_sites() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "src/a.rs",
            "fn main() { render(); helper(); }\n",
        );
        write(
            dir.path(),
            "src/ui.rs",
            "pub fn render() { paint(); }\npub fn paint(&self) {}\n",
        );
        write(dir.path(), "src/util.rs", "pub fn helper() {}\n");
        write(dir.path(), "top.rs", "fn boot() { main(); }\n");
        let data = built(dir.path());
        let graph = module_graph(&data);

        // render→paint stays inside ui.rs — the report is the cross-file view.
        let mut names: Vec<&str> = graph.modules.iter().map(|m| m.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["", "src"]);
        let src = graph.modules.iter().find(|m| m.name == "src").unwrap();
        assert_eq!((src.files, src.symbols), (3, 4));

        // src→src carries 2 calls over 2 pairs; the root file's edge names "".
        assert_eq!(
            graph.edges,
            vec![
                ModuleEdge {
                    from: "src".to_owned(),
                    to: "src".to_owned(),
                    calls: 2,
                    files: 2
                },
                ModuleEdge {
                    from: "".to_owned(),
                    to: "src".to_owned(),
                    calls: 1,
                    files: 1
                },
            ]
        );
        // Equal call counts tie-break by path; each pair keeps its sites in call order.
        assert_eq!(
            graph
                .file_edges
                .iter()
                .map(|dep| (dep.from.as_str(), dep.to.as_str(), dep.calls))
                .collect::<Vec<_>>(),
            vec![
                ("src/a.rs", "src/ui.rs", 1),
                ("src/a.rs", "src/util.rs", 1),
                ("top.rs", "src/a.rs", 1),
            ]
        );
        let first = &graph.file_edges[0];
        assert_eq!(
            (
                first.sites[0].from.as_str(),
                first.sites[0].to.as_str(),
                first.sites[0].line
            ),
            ("main", "render", 0)
        );
        assert_eq!(graph.total_file_edges, 3);
        assert_eq!(graph.total_calls, 3);
    }

    #[test]
    fn methods_carry_their_container_and_sites_cap_at_fifty() {
        let dir = tempfile::tempdir().unwrap();
        let mut text = String::from("struct View;\nimpl View {\n    pub fn render(&self) {\n");
        for _ in 0..60 {
            text.push_str("        helper();\n");
        }
        text.push_str("    }\n}\n");
        write(dir.path(), "paint.rs", &text);
        write(dir.path(), "help.rs", "pub fn helper() {}\n");
        let data = built(dir.path());
        let graph = module_graph(&data);
        let dep = &graph.file_edges[0];
        assert_eq!(
            (dep.from.as_str(), dep.to.as_str()),
            ("paint.rs", "help.rs")
        );
        assert_eq!(dep.calls, 60, "the count stays whole");
        assert_eq!(dep.sites.len(), 50, "the listing caps at 50");
        assert_eq!(
            dep.sites[0].from, "View.render",
            "methods print as container.name"
        );
        assert_eq!(dep.sites[0].to, "helper");
    }
}
