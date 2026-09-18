//! The big-code-analysis bridge (module 17): the richer columns of the
//! Complexity & Hotspots report — cognitive complexity, Halstead volume,
//! logical SLOC and the maintainability index — measured per function by the
//! rust-code-analysis fork over the same tree-sitter grammars the parser layer
//! embeds (each forwarded one-for-one from the `grammar-*` features). It runs
//! at report time only: the index's hot path keeps its own fast shape
//! extraction, and a report re-reads the files it measures — the security
//! scan's precedent. Honest about gaps: a language whose grammar is not
//! compiled in, a file that no longer reads, or a declaration the two
//! grammars disagree about simply keeps the zero columns.

use big_code_analysis::{analyze, MetricsOptions, Source, LANG};

use super::metrics::MetricRow;
use big_code_analysis::SpaceKind;

/// How far a declaration's line may sit from the space's first line for the
/// two to be the same declaration — annotations and doc comments shift one
/// grammar's start against the other's.
const JOIN_WINDOW: usize = 3;

/// The extension table, mirroring the parser layer's (`symbols::parse`'s
/// `lang_of`) so a file the index parsed is a file this engine measures.
fn lang_of(ext: &str) -> Option<LANG> {
	Some(match ext {
		"rs" => LANG::Rust,
		"py" => LANG::Python,
		"go" => LANG::Go,
		"js" | "jsx" => LANG::Javascript,
		"ts" => LANG::Typescript,
		"tsx" => LANG::Tsx,
		"java" => LANG::Java,
		"c" | "h" => LANG::C,
		"cpp" | "hpp" => LANG::Cpp,
		"cs" => LANG::Csharp,
		_ => return None,
	})
}

/// One measured function space: its name, 0-based first line, and the columns
/// big-code-analysis adds. Cyclomatic, size, params and nesting stay the
/// parser layer's — this fills what that layer cannot measure.
struct Measured {
	name: String,
	line: usize,
	cognitive: u32,
	halstead: u32,
	lloc: u32,
	mi: u32,
}

/// Walk the space tree collecting every function/method space (methods are
/// function spaces nested inside class spaces; the aggregates on containers
/// are skipped — the report is per function).
fn collect(space: &big_code_analysis::FuncSpace, out: &mut Vec<Measured>) {
	if space.kind == SpaceKind::Function {
		if let Some(name) = &space.name {
			out.push(Measured {
				name: name.clone(),
				// FuncSpace lines are 1-based; the parser layer's are 0-based.
				line: space.start_line.saturating_sub(1),
				cognitive: space.metrics.cognitive.cognitive_sum() as u32,
				halstead: space.metrics.halstead.volume().round().max(0.0) as u32,
				lloc: space.metrics.loc.lloc() as u32,
				mi: space.metrics.mi.visual_studio().clamp(0.0, 100.0).round() as u32,
			});
		}
	}
	for child in &space.spaces {
		collect(child, out);
	}
}

/// Fill one file's rows with the big-code-analysis columns. A row joins the
/// same-named space whose first line is nearest (the exact line wins, which
/// the window bound keeps from reaching across overloads); a row that finds
/// no partner keeps its zeros.
pub fn enrich_file(ext: &str, text: &str, rows: &mut [MetricRow]) {
	if rows.is_empty() {
		return;
	}
	let Some(lang) = lang_of(ext) else {
		return;
	};
	// A disabled grammar, or a file the fork cannot parse, is not an error
	// here — the columns stay empty and the report stays honest about it.
	let Ok(space) = analyze(Source::new(lang, text.as_bytes()), MetricsOptions::default()) else {
		return;
	};
	let mut measured = Vec::new();
	collect(&space, &mut measured);
	if measured.is_empty() {
		return;
	}
	for row in rows.iter_mut() {
		let Some(best) = measured
			.iter()
			.filter(|m| m.name == row.name && m.line.abs_diff(row.line) <= JOIN_WINDOW)
			.min_by_key(|m| (m.line.abs_diff(row.line), m.line))
		else {
			continue;
		};
		row.cognitive = Some(best.cognitive);
		row.halstead = Some(best.halstead);
		row.lloc = Some(best.lloc);
		row.mi = Some(best.mi);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn row(name: &str, line: usize) -> MetricRow {
		MetricRow {
			path: "m.rs".to_owned(),
			name: name.to_owned(),
			kind: "function".to_owned(),
			container: None,
			line,
			lines: 1,
			params: 0,
			complexity: 1,
			nesting: 0,
			refs: 0,
			hotspot: 1,
			cognitive: None,
			halstead: None,
			lloc: None,
			mi: None,
		}
	}

	#[test]
	fn nested_conditionals_measure_cognitive_and_mi() {
		let text = "fn deep(a: u32) -> u32 {\n    if a > 0 {\n        if a > 10 { 2 } else { 1 }\n    } else { 0 }\n}\nfn flat() -> u32 { 7 }\n";
		let mut rows = vec![row("deep", 0), row("flat", 5)];
		enrich_file("rs", text, &mut rows);
		let deep = &rows[0];
		// Campbell's rules: outer if 1 + its else 1 + nested if 2 + its else 1.
		assert_eq!(deep.cognitive, Some(5));
		assert!(deep.halstead.is_some_and(|h| h > 0));
		assert!(deep.lloc.is_some_and(|l| l > 0));
		assert!(deep.mi.is_some_and(|m| (1..=100).contains(&m)));
		let flat = &rows[1];
		assert_eq!(flat.cognitive, Some(0), "a straight-line function");
	}

	#[test]
	fn a_row_the_engine_cannot_match_keeps_empty_columns() {
		let text = "fn deep() -> u32 { 1 }\n";
		// A different name, and a same-named row far past the join window.
		let mut rows = vec![row("other", 0), row("deep", 40)];
		enrich_file("rs", text, &mut rows);
		assert!(rows[0].cognitive.is_none());
		assert!(rows[1].cognitive.is_none());
	}

	#[test]
	fn a_language_without_a_grammar_leaves_the_rows_alone() {
		let mut rows = vec![row("anything", 0)];
		enrich_file("rb", "def anything; end", &mut rows);
		assert!(rows[0].cognitive.is_none());
	}
}
