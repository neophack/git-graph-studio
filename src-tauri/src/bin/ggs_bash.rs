//! The `ggs-bash` sidecar's entry (module 18): Git Graph Studio's bundled bash-like
//! shell. Everything of substance lives in the library's `ggs_bash` module, pure Rust,
//! no feature gates — the sidecar builds with `--no-default-features` like `ggs-node`
//! does, so it never drags the window stack in.

fn main() {
    std::process::exit(git_graph_studio_lib::ggs_bash::run_main());
}
