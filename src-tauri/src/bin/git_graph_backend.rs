//! The engine host binary: a one-line shell over the library's engine-host module.

#[cfg(feature = "engine")]
fn main() {
    git_graph_studio_lib::engine_host::run();
}

#[cfg(not(feature = "engine"))]
fn main() {
    compile_error!("git-graph-backend needs the `engine` feature");
}
