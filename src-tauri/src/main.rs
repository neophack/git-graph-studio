//! Git Graph Studio: the desktop app. Everything lives in the library crate (`lib.rs`).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Keep the N-API host's exports in this image (ggs-node loads the addons; this
    // binary never does, and the /EXPORT directives need the object present).
    #[cfg(feature = "node-runtime")]
    git_graph_studio_lib::node_runtime::link_napi_host();
    git_graph_studio_lib::run();
}
