//! The Complexity & Hotspots report (module 17): every function and method with the
//! shape the parser layer measured — cyclomatic complexity, lines, parameters, nesting —
//! ranked by whatever the caller sorts by. The hotspot score (complexity × how many
//! files mention the name) comes from the symbol index's occurrence counts, blended in
//! by the command layer.

use serde::Serialize;

use super::AnalysisData;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetricRow {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub container: Option<String>,
    pub line: usize,
    /// Whole lines the declaration spans.
    pub lines: usize,
    pub params: usize,
    pub complexity: u32,
    pub nesting: u32,
    /// How many files in the workspace mention the name (the symbol index's occurrence
    /// list; 0 when it has not landed).
    pub refs: usize,
    /// complexity × max(refs, 1) — the hotspot ranking the page opens sorted by.
    pub hotspot: u32,
}

/// Every function and method in the workspace, in path-then-line order (the command
/// streams them in that order; the page re-sorts).
pub fn metric_rows(data: &AnalysisData, refs_of: &dyn Fn(&str) -> usize) -> Vec<MetricRow> {
    let mut rows = Vec::new();
    for file in data.files() {
        for symbol in &file.symbols {
            if symbol.kind != "function" && symbol.kind != "method" {
                continue;
            }
            let refs = refs_of(&symbol.name);
            rows.push(MetricRow {
                path: file.path.clone(),
                name: symbol.name.clone(),
                kind: symbol.kind.to_owned(),
                container: symbol.container.clone(),
                line: symbol.line,
                lines: symbol.end_line.saturating_sub(symbol.line) + 1,
                params: symbol.params,
                complexity: symbol.complexity,
                nesting: symbol.nesting,
                hotspot: symbol.complexity * refs.max(1) as u32,
                refs,
            });
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_carry_the_measured_shape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("src/m.rs"),
            "pub fn wide(a: u32, b: u32) -> u32 {\n    if a > b { a } else { b }\n}\nstruct T;\nimpl T { fn m(&self) {} }\n",
        )
        .unwrap();
        let data =
            AnalysisData::build(&root.display().to_string(), 4, &|_, _| {}, &|| false).unwrap();
        let rows = metric_rows(&data, &|name| if name == "wide" { 3 } else { 1 });
        assert_eq!(rows.len(), 2);
        let wide = &rows[0];
        assert_eq!(
            (wide.name.as_str(), wide.params, wide.complexity, wide.lines),
            ("wide", 2, 2, 3)
        );
        assert_eq!(wide.refs, 3);
        assert_eq!(wide.hotspot, 6, "complexity 2 × refs 3");
        let method = &rows[1];
        assert_eq!(method.container.as_deref(), Some("T"));
        assert_eq!(method.refs, 1);
    }
}
