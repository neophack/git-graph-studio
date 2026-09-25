//! The pretend Node runtime binary: a one-line shell over the library's node-runtime module.

#[cfg(feature = "node-runtime")]
fn main() {
    git_graph_studio_lib::node_runtime::run();
}

#[cfg(not(feature = "node-runtime"))]
fn main() {
    compile_error!("ggs-node needs the `node-runtime` feature");
}
