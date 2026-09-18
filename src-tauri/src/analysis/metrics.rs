//! The Complexity & Hotspots report (module 17): every function and method with the
//! shape the parser layer measured — cyclomatic complexity, lines, parameters, nesting —
//! ranked by whatever the caller sorts by. The hotspot score (complexity × how many
//! files mention the name) comes from the symbol index's occurrence counts, blended in
//! by the command layer. The big-code-analysis columns (bca.rs) — cognitive complexity,
//! Halstead volume, logical SLOC, the maintainability index — join at report time,
//! re-reading what they measure.

use serde::Serialize;

use super::bca;
use super::{AnalysisData, FileAnalysis};

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
    /// The big-code-analysis columns, `None` where that engine did not measure (its
    /// grammar is off, the file no longer reads, or the two grammars disagree about
    /// where the declaration starts). See `bca::enrich_file`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cognitive: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub halstead: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lloc: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mi: Option<u32>,
}

/// One file's rows, in line order.
pub fn rows_for_file(file: &FileAnalysis, refs_of: &dyn Fn(&str) -> usize) -> Vec<MetricRow> {
    file.symbols
        .iter()
        .filter(|symbol| symbol.kind == "function" || symbol.kind == "method")
        .map(|symbol| {
            let refs = refs_of(&symbol.name);
            MetricRow {
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
                cognitive: None,
                halstead: None,
                lloc: None,
                mi: None,
            }
        })
        .collect()
}

/// Every function and method in the workspace, in path-then-line order, as the
/// index measured them (no big-code-analysis columns — see [`enriched_rows`]).
pub fn metric_rows(data: &AnalysisData, refs_of: &dyn Fn(&str) -> usize) -> Vec<MetricRow> {
    data.files()
        .iter()
        .flat_map(|file| rows_for_file(file, refs_of))
        .collect()
}

/// The rows with the big-code-analysis columns filled in: each file is re-read
/// and measured by the fork's engine (a report run, not the index's hot path —
/// the security scan's precedent). Files that no longer read keep zero columns.
pub fn enriched_rows(
    data: &AnalysisData,
    refs_of: &dyn Fn(&str) -> usize,
    root: &str,
) -> Vec<MetricRow> {
    let mut rows = Vec::new();
    for file in data.files() {
        let mut part = rows_for_file(file, refs_of);
        let ext = file.path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
        if let Ok(text) = std::fs::read_to_string(std::path::Path::new(root).join(&file.path)) {
            bca::enrich_file(ext, &text, &mut part);
        }
        rows.append(&mut part);
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

    #[test]
    fn enriched_rows_carry_the_bca_columns() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("src/m.rs"),
            "pub fn deep(a: u32) -> u32 {\n    if a > 0 { 1 } else { 0 }\n}\n",
        )
        .unwrap();
        let data =
            AnalysisData::build(&root.display().to_string(), 4, &|_, _| {}, &|| false).unwrap();
        let rows = enriched_rows(&data, &|_| 0, &root.display().to_string());
        assert_eq!(rows.len(), 1);
        let deep = &rows[0];
        assert_eq!(deep.cognitive, Some(2), "if 1 + else 1, no nesting");
        assert!(deep.halstead.is_some_and(|h| h > 0));
        assert!(deep.lloc.is_some_and(|l| l > 0));
        assert!(deep.mi.is_some_and(|m| (1..=100).contains(&m)));
        // The plain path stays unmeasured — its callers opt in.
        assert_eq!(metric_rows(&data, &|_| 0)[0].cognitive, None);
    }
}
