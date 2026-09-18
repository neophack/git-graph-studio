//! The Import Graph report (module 17): the workspace's file-to-file dependency edges —
//! each import statement resolved to the workspace file it names, per language — plus
//! the strongly-connected components (the import cycles) and fan-in/out material for the
//! page. Import resolution is deliberately per-language and heuristic where the language
//! itself is (JS extension guessing, Java/C# suffix matching); an import that names
//! nothing in the workspace (a package from outside) contributes no edge.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use super::AnalysisData;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportGraph {
    /// from → to, both repo-relative forward-slash paths; sorted, deduplicated.
    pub edges: Vec<(String, String)>,
    /// Every cycle as the files in one strongly-connected component (sorted inside,
    /// cycles sorted by their first file).
    pub cycles: Vec<Vec<String>>,
}

/// Build the import graph of an analysis.
pub fn import_graph(data: &AnalysisData) -> ImportGraph {
    let paths: HashSet<&str> = data.files().iter().map(|f| f.path.as_str()).collect();
    let mut edges: Vec<(String, String)> = Vec::new();
    for file in data.files() {
        let ext = file.path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
        for import in &file.imports {
            if let Some(target) = resolve_import(&file.path, ext, import, &paths) {
                if target != file.path {
                    edges.push((file.path.clone(), target));
                }
            }
        }
    }
    edges.sort();
    edges.dedup();
    let cycles = cycles_of(&edges);
    ImportGraph { edges, cycles }
}

/// Resolve one import spelling to a workspace file, per language.
fn resolve_import(from: &str, ext: &str, import: &str, paths: &HashSet<&str>) -> Option<String> {
    let dir = &from[..from.rfind('/').unwrap_or(0)];
    match ext {
        "js" | "jsx" | "ts" | "tsx" => {
            if !import.starts_with('.') {
                return None; // a package, not a workspace file
            }
            // './b', '../x/b' — walk the segments off the importing file's directory.
            let mut parts: Vec<&str> = if dir.is_empty() {
                Vec::new()
            } else {
                dir.split('/').collect()
            };
            for segment in import.split('/') {
                match segment {
                    "." | "" => {}
                    ".." => {
                        parts.pop();
                    }
                    other => parts.push(other),
                }
            }
            let base = parts.join("/");
            for candidate in [
                format!("{base}.ts"),
                format!("{base}.tsx"),
                format!("{base}.js"),
                format!("{base}.jsx"),
                format!("{base}/index.ts"),
                format!("{base}/index.tsx"),
                format!("{base}/index.js"),
            ] {
                if paths.contains(candidate.as_str()) {
                    return Some(candidate);
                }
            }
            None
        }
        "rs" => {
            // crate::a::b and self::/super:: paths resolve inside the workspace; use
            // declarations of other crates (std, external) are not files here. The crate
            // root's own directory is not known, so module paths match by suffix — the
            // trailing segments that name a file (`crate::extra::helper` → `…/extra.rs`,
            // the helper being an item, not a module).
            let rest = import
                .strip_prefix("crate::")
                .or_else(|| import.strip_prefix("self::"))
                .or_else(|| import.strip_prefix("super::"))?;
            let segments: Vec<&str> = rest.split("::").map(str::trim).collect();
            for width in (1..=segments.len()).rev() {
                let module = segments[..width].join("/");
                for tail in [format!("{module}.rs"), format!("{module}/mod.rs")] {
                    let wanted = format!("/{tail}");
                    if let Some(hit) = paths.iter().copied().find(|p| p.ends_with(&wanted)) {
                        return Some(hit.to_owned());
                    }
                }
            }
            None
        }
        "py" => {
            // `pkg.other` is root-relative; `.base` / `..base` are package-relative —
            // one dot level stays in the package directory, each extra one goes up.
            let up = import.find(|c: char| c != '.').unwrap_or(import.len());
            let module = &import[up.min(import.len())..];
            let mut parts: Vec<&str> = if up > 0 {
                let mut dir_parts: Vec<&str> = dir.split('/').collect();
                for _ in 0..up.saturating_sub(1) {
                    dir_parts.pop();
                }
                dir_parts
            } else {
                Vec::new()
            };
            parts.extend(module.split('.').filter(|s| !s.is_empty()));
            let base = parts.join("/");
            if base.is_empty() {
                return None;
            }
            for candidate in [format!("{base}.py"), format!("{base}/__init__.py")] {
                if paths.contains(candidate.as_str()) {
                    return Some(candidate);
                }
            }
            None
        }
        "c" | "h" | "cpp" | "hpp" => {
            if import.contains(':') || import.starts_with('/') {
                return None; // absolute or system-ish
            }
            let candidate = if dir.is_empty() {
                import.to_owned()
            } else {
                format!("{dir}/{import}")
            };
            paths.contains(candidate.as_str()).then_some(candidate)
        }
        "java" | "cs" => {
            // com.x.Y → a workspace file ending /Y.java (or /Y.cs); a unique match wins.
            let type_name = import.rsplit('.').next()?.trim();
            if type_name.contains('*') || type_name.is_empty() {
                return None;
            }
            let wanted = format!("/{type_name}.{ext}");
            let hits: Vec<&str> = paths
                .iter()
                .copied()
                .filter(|p| p.ends_with(&wanted))
                .collect();
            match hits.as_slice() {
                [only] => Some((*only).to_owned()),
                _ => None,
            }
        }
        "go" => {
            // github.com/x/repo/pkg/sub → the workspace dir pkg/sub, when it is unique.
            let segments: Vec<&str> = import.split('/').filter(|s| !s.is_empty()).collect();
            for width in (2..=segments.len()).rev() {
                let tail = segments[segments.len() - width..].join("/");
                let prefix = format!("{tail}/");
                let mut hits = paths
                    .iter()
                    .copied()
                    .filter(|p| p.starts_with(&prefix))
                    .filter(|p| p.ends_with(".go"));
                if let (first, None) = (hits.next().unwrap_or(""), hits.next()) {
                    if !first.is_empty() {
                        return Some(first.to_owned());
                    }
                }
            }
            None
        }
        _ => None,
    }
}

/// Tarjan's strongly-connected components over the file graph; only components that are
/// cycles (more than one file, or a self-import) are reported.
fn cycles_of(edges: &[(String, String)]) -> Vec<Vec<String>> {
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    let nodes: HashSet<&str> = edges
        .iter()
        .flat_map(|(from, to)| [from.as_str(), to.as_str()])
        .collect();
    for (from, to) in edges {
        adjacency
            .entry(from.as_str())
            .or_default()
            .push(to.as_str());
    }
    // Iterative Tarjan: index/lowlink per node, an explicit stack of (node, child
    // cursor) replaces recursion (a deep import chain must not overflow).
    let mut index: HashMap<&str, usize> = HashMap::new();
    let mut lowlink: HashMap<&str, usize> = HashMap::new();
    let mut on_stack: HashSet<&str> = HashSet::new();
    let mut stack: Vec<&str> = Vec::new();
    let mut next_index = 0usize;
    let mut cycles: Vec<Vec<String>> = Vec::new();
    for &start in &nodes {
        if index.contains_key(start) {
            continue;
        }
        let mut frames: Vec<(&str, usize)> = vec![(start, 0)];
        while let Some(&mut (node, ref mut cursor)) = frames.last_mut() {
            if *cursor == 0 {
                index.insert(node, next_index);
                lowlink.insert(node, next_index);
                next_index += 1;
                stack.push(node);
                on_stack.insert(node);
            }
            let children = adjacency.get(node).cloned().unwrap_or_default();
            let mut recursed = false;
            while *cursor < children.len() {
                let child = children[*cursor];
                *cursor += 1;
                if !index.contains_key(child) {
                    frames.push((child, 0));
                    recursed = true;
                    break;
                } else if on_stack.contains(child) {
                    let low = lowlink
                        .get(&node)
                        .copied()
                        .unwrap_or(usize::MAX)
                        .min(index.get(&child).copied().unwrap_or(usize::MAX));
                    lowlink.insert(node, low);
                }
            }
            if recursed {
                continue;
            }
            let own_low = lowlink.get(&node).copied().unwrap_or(usize::MAX);
            let children_low = children
                .iter()
                .filter_map(|c| lowlink.get(c).copied())
                .min()
                .unwrap_or(usize::MAX);
            let merged = own_low.min(children_low);
            lowlink.insert(node, merged);
            if merged == index.get(&node).copied().unwrap_or(usize::MAX) {
                let mut component: Vec<&str> = Vec::new();
                while let Some(top) = stack.pop() {
                    on_stack.remove(top);
                    component.push(top);
                    if top == node {
                        break;
                    }
                }
                let self_loop = component.len() == 1
                    && adjacency
                        .get(component[0])
                        .is_some_and(|list| list.contains(&component[0]));
                if component.len() > 1 || self_loop {
                    let mut files: Vec<String> =
                        component.iter().map(|s| (*s).to_owned()).collect();
                    files.sort();
                    cycles.push(files);
                }
            }
            frames.pop();
            if let Some(&(parent, _)) = frames.last() {
                let low = lowlink
                    .get(&parent)
                    .copied()
                    .unwrap_or(usize::MAX)
                    .min(lowlink.get(&node).copied().unwrap_or(usize::MAX));
                lowlink.insert(parent, low);
            }
        }
    }
    cycles.sort();
    cycles
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
    fn relative_js_imports_link_and_cycles_list() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "a.js",
            "import { b } from './b';\nexport const a = 1;\n",
        );
        write(dir.path(), "b.js", "import { a } from './a';\n");
        write(dir.path(), "c.ts", "import { b } from './b';\n");
        let data = built(dir.path());
        let graph = import_graph(&data);
        assert_eq!(
            graph.edges,
            vec![
                ("a.js".to_owned(), "b.js".to_owned()),
                ("b.js".to_owned(), "a.js".to_owned()),
                ("c.ts".to_owned(), "b.js".to_owned()),
            ]
        );
        assert_eq!(
            graph.cycles,
            vec![vec!["a.js".to_owned(), "b.js".to_owned()]]
        );
    }

    #[test]
    fn rust_crate_imports_resolve() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "src/lib.rs",
            "mod util;\npub fn api() { util::deep() }\n",
        );
        write(
            dir.path(),
            "src/util.rs",
            "use crate::extra::helper;\npub fn deep() { helper() }\n",
        );
        write(dir.path(), "src/extra.rs", "pub fn helper() {}\n");
        let data = built(dir.path());
        let graph = import_graph(&data);
        assert_eq!(
            graph.edges,
            vec![("src/util.rs".to_owned(), "src/extra.rs".to_owned())]
        );
        assert!(graph.cycles.is_empty());
    }

    #[test]
    fn python_relative_and_package_imports() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "pkg/mod.py",
            "from . import base\nfrom pkg.other import thing\n",
        );
        write(dir.path(), "pkg/__init__.py", "");
        write(dir.path(), "pkg/base.py", "x = 1\n");
        write(dir.path(), "pkg/other.py", "thing = 2\n");
        let data = built(dir.path());
        let graph = import_graph(&data);
        let targets: Vec<&(String, String)> = graph
            .edges
            .iter()
            .filter(|(from, _)| from == "pkg/mod.py")
            .collect();
        assert_eq!(targets.len(), 2, "{:?}", graph.edges);
        // `from . import base` names the package itself — v1 maps it to its __init__.
        assert!(graph
            .edges
            .contains(&("pkg/mod.py".to_owned(), "pkg/__init__.py".to_owned())));
        assert!(graph
            .edges
            .contains(&("pkg/mod.py".to_owned(), "pkg/other.py".to_owned())));
    }

    #[test]
    fn c_includes_link_to_siblings() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "main.c",
            "#include \"util.h\"\nint main(void) { return f(); }\n",
        );
        write(dir.path(), "util.h", "int f(void);\n");
        let data = built(dir.path());
        let graph = import_graph(&data);
        assert_eq!(
            graph.edges,
            vec![("main.c".to_owned(), "util.h".to_owned())]
        );
    }
}
