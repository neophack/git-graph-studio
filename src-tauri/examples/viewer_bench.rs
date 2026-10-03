//! The viewer document's open-path phases (scratch, like boa_bench): the syntax set, the
//! rope, `ViewerDoc::new` whole, and the first highlight window.
//! `viewer_bench [mb]`
use std::time::Instant;

fn main() {
	let mb: usize = std::env::args().nth(1).and_then(|v| v.parse().ok()).unwrap_or(32);
	let line = "fn worker(index: usize) -> usize { let doubled = index * 2; doubled + 1 } // TODO measure\n";
	let mut text = String::with_capacity(mb * 1024 * 1024);
	while text.len() < mb * 1024 * 1024 {
		text.push_str(line);
	}
	println!("file: {mb} MB, {} lines", text.lines().count());

	let started = Instant::now();
	let set = git_graph_studio_lib::viewer::doc::syntax_set();
	let elapsed = started.elapsed();
	println!("syntax_set (cold OnceLock build): {elapsed:?}");

	let started = Instant::now();
	let _rust = set.find_syntax_by_extension("rs").cloned();
	println!("find_syntax_by_extension: {:?}", started.elapsed());

	let started = Instant::now();
	let rope = ropey::Rope::from(text.as_str());
	println!("Rope::from: {:?} ({} chars)", started.elapsed(), rope.len_chars());

	let started = Instant::now();
	let mut doc = git_graph_studio_lib::viewer::doc::ViewerDoc::new("bench.rs".into(), &text, "rs");
	println!("ViewerDoc::new (syntax set warm): {:?}", started.elapsed());

	let started = Instant::now();
	let highlighted = doc.highlight_lines(0, 100);
	println!("highlight_lines(0, 100): {:?} ({} lines)", started.elapsed(), highlighted.len());

	let started = Instant::now();
	let lines = doc.line_count();
	println!("line_count: {:?} ({lines})", started.elapsed());
}
