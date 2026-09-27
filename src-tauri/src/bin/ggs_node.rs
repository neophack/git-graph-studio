//! The pretend Node runtime binary: a one-line shell over the library's node-runtime module.

/// Size-class free lists in front of the system heap (see `node_runtime::alloc`): a
/// bundle load is millions of small allocations, a third of its compile time on the
/// system heap alone.
#[cfg(feature = "node-runtime")]
#[global_allocator]
static ALLOC: git_graph_studio_lib::node_runtime::alloc::GgsAlloc =
    git_graph_studio_lib::node_runtime::alloc::GgsAlloc;

#[cfg(feature = "node-runtime")]
fn main() {
    git_graph_studio_lib::node_runtime::run();
}

#[cfg(not(feature = "node-runtime"))]
fn main() {
    compile_error!("ggs-node needs the `node-runtime` feature");
}
