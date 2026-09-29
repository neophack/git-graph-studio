//! A scratch probe (deleted after use): runs the real Module Analysis over a
//! repository and writes the `analysis_module_diagram` / `analysis_module_graph`
//! answers as JSON, so the browser harness can serve the real thing.

use git_graph_studio_lib::analysis::diagram::module_diagram;
use git_graph_studio_lib::analysis::modules::module_graph;
use git_graph_studio_lib::analysis::AnalysisData;

fn main() {
    let root = std::env::args().nth(1).unwrap_or_else(|| ".".to_owned());
    let filter = std::env::args().nth(2).unwrap_or_default();
    let data = AnalysisData::build(&root, 8, &|_, _| {}, &|| false).expect("the analysis built");
    let graph = module_graph(&data, &[]);
    let diagram = module_diagram(&graph, None, &filter, &[]);
    eprintln!(
        "nodes: {}, edges: {}, dropped: {}/{}",
        diagram.nodes.len(),
        diagram.edges.len(),
        diagram.dropped_edges,
        diagram.dropped_edges + diagram.edges.len(),
    );
    let out = std::env::var("DUMP_DIR").unwrap_or_else(|_| "..".to_owned());
    std::fs::write(
        format!("{out}/target/studio/module-diagram.json"),
        serde_json::to_string(&diagram).unwrap(),
    )
    .unwrap();
    std::fs::write(
        format!("{out}/target/studio/module-graph.json"),
        serde_json::to_string(&graph).unwrap(),
    )
    .unwrap();
}
