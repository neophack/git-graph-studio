//! The Module Analysis report (module 17): the workspace's cross-file call
//! relationships lifted to the files that carry them and the directories (the
//! "modules") that group them — which module depends on which, which file calls which,
//! and the individual call sites under each file pair. The same call resolution the
//! engine always did (name matching with receiver hints), presented twice by the page:
//! a drawing (every busy file a block, every cross-file dependency an arrow — the
//! positions the @antv/G6 layouts assign in the page, not geometry shipped over IPC)
//! and a collapsible tree (module edges open into file pairs and call sites). Both
//! views cap what they draw; the totals stay honest about what was capped away.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use super::AnalysisData;

/// File dependencies itemised (also per module edge); pairs beyond this are counted in
/// the module edges and `total_file_edges` but not listed.
const MAX_FILE_EDGES: usize = 5000;
/// Module dependencies itemised; module edges beyond this are counted in
/// `total_module_edges` but not listed (the drawing caps itself far below anyway).
const MAX_MODULE_EDGES: usize = 5000;
/// Call sites listed under one file pair.
const SITES_PER_EDGE: usize = 50;
/// How many file pairs and module edges the aggregation tracks with their counts
/// before the spillover takes over: a workspace with more distinct pairs than this
/// keeps exact totals (every call and every new pair is counted as it streams) while
/// the listing covers the tracked ones — beyond the cap ANY bounded listing is a
/// sample, and the honest numbers are the totals. ~80 MB of tracked state, bounded
/// regardless of the workspace's shape.
const PAIR_TRACK_CAP: usize = 2_000_000;

/// One kept pair's capped site records: (line, column, owner symbol, callee name id).
type SiteList = Vec<(u32, u32, u32, u32)>;
type SiteLists = HashMap<(u32, u32), SiteList>;

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
    /// Module dependencies sorted by calls, most first, capped at
    /// [`MAX_MODULE_EDGES`].
    pub edges: Vec<ModuleEdge>,
    /// File dependencies sorted by calls, most first, capped at [`MAX_FILE_EDGES`].
    pub file_edges: Vec<FileDep>,
    /// The workspace totals before the caps above (and, past the tracking cap, the
    /// spillover's exact counts).
    pub total_calls: usize,
    pub total_file_edges: usize,
    pub total_module_edges: usize,
}

/// Build the module graph of an analysis. An empty `scope` aggregates the whole
/// workspace; otherwise only the files under the scope's folders (and the pairs
/// with both ends under them) aggregate — a folder-picked report counts exactly
/// what those folders carry, and the listing caps prune inside the scope
/// instead of the scope's edges being crowded out by the rest of the workspace.
///
/// The resolved calls stream through twice instead of ever materializing: pass one
/// counts the file pairs and lifts them to module edges (the ambiguity fan-out made
/// the old full row set the engine's largest allocation); pass two re-walks to fill
/// the capped site lists of the pairs the listing keeps. A pair's sites arrive in
/// document order, which is call order — the cap keeps the earliest.
pub fn module_graph(data: &AnalysisData, scope: &[String]) -> ModuleGraph {
    // The modules themselves: every in-scope directory with its file and symbol
    // counts (cheap — file-level). The per-file directory rides alongside for the
    // module-edge lift.
    let mut dirs: Vec<&str> = Vec::with_capacity(data.file_count());
    let mut modules: HashMap<&str, (u32, u32)> = HashMap::new();
    for file in data.files() {
        let dir = module_of(&file.path);
        dirs.push(dir);
        if !in_scope(&file.path, scope) {
            continue;
        }
        let entry = modules.entry(dir).or_default();
        entry.0 += 1;
        entry.1 += file.symbols.len() as u32;
    }
    let in_scope_file: Vec<bool> = data
        .files()
        .iter()
        .map(|file| in_scope(&file.path, scope))
        .collect();
    let modules: Vec<ModuleInfo> = {
        let mut list: Vec<ModuleInfo> = modules
            .into_iter()
            .map(|(name, (files, symbols))| ModuleInfo {
                name: name.to_owned(),
                files,
                symbols,
            })
            .collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        list
    };

    // Pass one: count every resolved cross-file call per file pair inside the scope,
    // and lift the pairs to module edges as they land. Past the tracking cap the
    // counts go to the exact totals only (see [`PAIR_TRACK_CAP`]); the tracked ones
    // still rank.
    let mut pair_counts: HashMap<(u32, u32), u32> = HashMap::new();
    let mut module_edges: HashMap<(&str, &str), (u32, u32)> = HashMap::new(); // (calls, files)
    let mut total_calls = 0usize;
    let mut spilled_pairs = 0usize;
    let mut spilled_module_edges = 0usize;
    data.walk_resolved(|from_file, _owner, _call, target| {
        if target.0 == from_file {
            return; // the module report is the cross-file view
        }
        if !in_scope_file[from_file as usize] || !in_scope_file[target.0 as usize] {
            return; // an end outside the scope: the pair is the workspace's story
        }
        total_calls += 1;
        let pair = (from_file, target.0);
        let edge_pair = (dirs[from_file as usize], dirs[target.0 as usize]);
        let new_pair = !pair_counts.contains_key(&pair);
        if new_pair && pair_counts.len() >= PAIR_TRACK_CAP {
            spilled_pairs += 1;
        } else {
            *pair_counts.entry(pair).or_default() += 1;
        }
        let new_module_edge =
            new_pair && !module_edges.contains_key(&edge_pair);
        if new_module_edge && module_edges.len() >= PAIR_TRACK_CAP {
            spilled_module_edges += 1;
        } else {
            let edge = module_edges.entry(edge_pair).or_default();
            edge.0 += 1;
            if new_pair {
                edge.1 += 1; // the pair counts once toward its module edge
            }
        }
    });
    let total_file_edges = pair_counts.len() + spilled_pairs;
    let total_module_edges = module_edges.len() + spilled_module_edges;

    // The listings keep the busiest edges; the tiebreak is the file order for pairs
    // (which is the path order — `files` is path-sorted) and the path order for
    // modules — the old string compares, without the strings where ids serve.
    let mut ranked: Vec<((u32, u32), u32)> = pair_counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    ranked.truncate(MAX_FILE_EDGES);
    let kept: HashSet<(u32, u32)> = ranked.iter().map(|&(pair, _)| pair).collect();

    // Pass two: the kept pairs' first sites in call order, ids only — strings decode
    // when the answer assembles.
    let mut sites: SiteLists = HashMap::new();
    data.walk_resolved(|from_file, owner, call, target| {
        if target.0 == from_file {
            return;
        }
        let pair = (from_file, target.0);
        if !kept.contains(&pair) {
            return;
        }
        let list = sites.entry(pair).or_default();
        if list.len() < SITES_PER_EDGE {
            let to_name = data.files()[target.0 as usize].symbols[target.1 as usize].name;
            list.push((call.line, call.column, owner, to_name));
        }
    });

    // Assemble the answer: strings decode only here, for what the report carries.
    let mut file_edges: Vec<FileDep> = ranked
        .iter()
        .map(|&((from, to), calls)| {
            let mut rows: Vec<CallSiteRow> = sites
                .get(&(from, to))
                .map(|list| {
                    list.iter()
                        .map(|&(line, column, from_sym, to_name)| CallSiteRow {
                            from: display_of(data, from, from_sym),
                            to: data.name(to_name).to_owned(),
                            line: line as usize,
                            column: column as usize,
                        })
                        .collect()
                })
                .unwrap_or_default();
            // Call order inside the caller file; the name tiebreak keeps it total.
            rows.sort_by(|a, b| {
                (a.line, a.column, &a.from, &a.to).cmp(&(b.line, b.column, &b.from, &b.to))
            });
            FileDep {
                from: data.files()[from as usize].path.clone(),
                to: data.files()[to as usize].path.clone(),
                calls,
                sites: rows,
            }
        })
        .collect();
    file_edges.sort_by(|a, b| {
        b.calls
            .cmp(&a.calls)
            .then((&a.from, &a.to).cmp(&(&b.from, &b.to)))
    });

    let mut edges: Vec<ModuleEdge> = module_edges
        .into_iter()
        .map(|((from, to), (calls, files))| ModuleEdge {
            from: from.to_owned(),
            to: to.to_owned(),
            calls,
            files,
        })
        .collect();
    edges.sort_by(|a, b| {
        b.calls
            .cmp(&a.calls)
            .then((&a.from, &a.to).cmp(&(&b.from, &b.to)))
    });
    edges.truncate(MAX_MODULE_EDGES);

    ModuleGraph {
        modules,
        edges,
        file_edges,
        total_calls,
        total_file_edges,
        total_module_edges,
    }
}

/// The caller's display spelling, `container.name` when its declaration has a
/// container — what the page prints under a pair's sites.
fn display_of(data: &AnalysisData, from_file: u32, owner: u32) -> String {
    let view = data.symbol((from_file, owner));
    match view.container {
        Some(container) => format!("{container}.{}", view.name),
        None => view.name.to_owned(),
    }
}

/// The Module Analysis aggregation the MCP server reads: module edges and the exact
/// totals, without the file-pair ranking or the site lists the page's answer carries.
/// A bounded distinct-pair set keeps every count exact below [`SUMMARY_PAIR_CAP`];
/// beyond it the totals stay exact (each new pair is counted as it spills) while a
/// module edge's `files` reads as the tracked floor — the fold holds a few megabytes
/// on any workspace, where the full graph's pair ranking holds tens on the extreme
/// ones.
pub const SUMMARY_PAIR_CAP: usize = 200_000;

pub struct ModuleEdgeSummary {
    /// How many distinct directories carry in-scope files.
    pub modules: u32,
    /// Module edges ranked by calls, most first, capped at [`MAX_MODULE_EDGES`].
    pub edges: Vec<ModuleEdge>,
    pub total_calls: usize,
    pub total_file_edges: usize,
    pub total_module_edges: usize,
}

/// The one-pass fold behind [`ModuleEdgeSummary`] — `module_graph`'s pass one with a
/// seen-pair set instead of per-pair counts (the MCP answer never ranks file pairs)
/// and no second pass.
pub fn module_edge_summary(data: &AnalysisData, scope: &[String]) -> ModuleEdgeSummary {
    let mut dirs: Vec<&str> = Vec::with_capacity(data.file_count());
    let mut dir_count: HashMap<&str, ()> = HashMap::new();
    let mut in_scope_dirs: HashMap<&str, ()> = HashMap::new();
    let mut in_scope_file: Vec<bool> = Vec::with_capacity(data.file_count());
    for file in data.files() {
        let dir = module_of(&file.path);
        let scoped = in_scope(&file.path, scope);
        dirs.push(dir);
        in_scope_file.push(scoped);
        dir_count.entry(dir).or_insert(());
        if scoped {
            in_scope_dirs.entry(dir).or_insert(());
        }
    }
    let mut seen: HashSet<(u32, u32)> = HashSet::new();
    let mut module_edges: HashMap<(&str, &str), (u32, u32)> = HashMap::new(); // (calls, files)
    let mut total_calls = 0usize;
    let mut spilled_pairs = 0usize;
    let mut spilled_module_edges = 0usize;
    data.walk_resolved(|from_file, _owner, _call, target| {
        if target.0 == from_file {
            return;
        }
        if !in_scope_file[from_file as usize] || !in_scope_file[target.0 as usize] {
            return;
        }
        total_calls += 1;
        let pair = (from_file, target.0);
        let new_pair = !seen.contains(&pair);
        if new_pair && seen.len() >= SUMMARY_PAIR_CAP {
            spilled_pairs += 1;
        } else {
            seen.insert(pair);
        }
        let edge_pair = (dirs[from_file as usize], dirs[target.0 as usize]);
        let new_edge = new_pair && !module_edges.contains_key(&edge_pair);
        if new_edge && module_edges.len() >= SUMMARY_PAIR_CAP {
            spilled_module_edges += 1;
        } else {
            let edge = module_edges.entry(edge_pair).or_default();
            edge.0 += 1;
            if new_pair {
                edge.1 += 1;
            }
        }
    });
    let tracked_module_edges = module_edges.len();
    let mut edges: Vec<ModuleEdge> = module_edges
        .into_iter()
        .map(|((from, to), (calls, files))| ModuleEdge {
            from: from.to_owned(),
            to: to.to_owned(),
            calls,
            files,
        })
        .collect();
    edges.sort_by(|a, b| {
        b.calls
            .cmp(&a.calls)
            .then((&a.from, &a.to).cmp(&(&b.from, &b.to)))
    });
    edges.truncate(MAX_MODULE_EDGES);
    ModuleEdgeSummary {
        modules: in_scope_dirs.len() as u32,
        edges,
        total_calls,
        total_file_edges: seen.len() + spilled_pairs,
        total_module_edges: tracked_module_edges + spilled_module_edges,
    }
}

/// A file's module: its directory; "" is the workspace root.
pub fn module_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(at) => &path[..at],
        None => "",
    }
}

/// The folders a scoped report runs over, spelled repo-relative with forward
/// slashes: trimmed, backslashes folded to slashes, `./` prefixes and trailing
/// slashes dropped, empties discarded — then a folder another selected folder
/// already covers folds into it (analyzing `src` and `src/editor` is analyzing
/// `src`). The explorer hands Windows-style relatives in; the page hands what
/// it got back verbatim.
pub fn normalize_scope(folders: &[String]) -> Vec<String> {
    let mut cleaned: Vec<String> = folders
        .iter()
        .map(|raw| {
            raw.trim()
                .replace('\\', "/")
                .trim_start_matches("./")
                .trim_end_matches('/')
                .to_owned()
        })
        .filter(|folder| !folder.is_empty() && folder != ".")
        .collect();
    cleaned.sort();
    cleaned.dedup();
    let folded = cleaned.clone();
    cleaned.retain(|folder| {
        !folded
            .iter()
            .any(|other| other != folder && folder.starts_with(&format!("{other}/")))
    });
    cleaned
}

/// Whether a repo-relative file sits inside the scope: an empty scope is the
/// whole workspace; otherwise the file must live under one of the folders.
pub fn in_scope(path: &str, folders: &[String]) -> bool {
    folders.is_empty()
        || folders
            .iter()
            .any(|folder| path.starts_with(&format!("{folder}/")))
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
        let graph = module_graph(&data, &[]);

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
        let graph = module_graph(&data, &[]);
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

    #[test]
    fn a_scope_covers_only_its_folders_and_the_pairs_inside() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "src/a.rs",
            "fn main() { render(); helper(); }\n",
        );
        write(dir.path(), "src/ui.rs", "pub fn render() {}\n");
        write(dir.path(), "src/util.rs", "pub fn helper() {}\n");
        write(dir.path(), "top.rs", "fn boot() { main(); }\n");
        write(dir.path(), "lib/other.rs", "pub fn away() { helper(); }\n");
        let data = built(dir.path());

        // The scope normalizes: backslashes, `./`, a trailing slash, and the
        // nested `src/ui` folding into the `src` that already covers it.
        assert_eq!(
            normalize_scope(&[".\\src\\".to_owned(), "src/ui/".to_owned(), "".to_owned()]),
            ["src".to_owned()]
        );

        // Everything outside the folder — and every pair with an end outside —
        // drops; the totals count the scope, not the workspace.
        let graph = module_graph(&data, &["src".to_owned()]);
        let names: Vec<&str> = graph.modules.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, ["src"]);
        assert_eq!(
            graph.edges,
            vec![ModuleEdge {
                from: "src".to_owned(),
                to: "src".to_owned(),
                calls: 2,
                files: 2
            }]
        );
        assert_eq!(
            graph
                .file_edges
                .iter()
                .map(|dep| (dep.from.as_str(), dep.to.as_str()))
                .collect::<Vec<_>>(),
            vec![("src/a.rs", "src/ui.rs"), ("src/a.rs", "src/util.rs")]
        );
        assert_eq!(graph.total_file_edges, 2);
        assert_eq!(graph.total_calls, 2);

        // Two folders union: `lib` joins, and with it the pair lib carries
        // into src (both ends now inside the scope).
        let graph = module_graph(&data, &["src".to_owned(), "lib".to_owned()]);
        assert_eq!(
            graph
                .file_edges
                .iter()
                .map(|dep| (dep.from.as_str(), dep.to.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("lib/other.rs", "src/util.rs"),
                ("src/a.rs", "src/ui.rs"),
                ("src/a.rs", "src/util.rs")
            ]
        );
        assert_eq!(graph.total_file_edges, 3);
    }
}
