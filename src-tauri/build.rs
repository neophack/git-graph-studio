//! Build script: Tauri's code generation, the embedded manifest of the integrated git-graph-rs
//! extension, then the compile-time seam check (docs/ggs-development-plan.md §3.7): the
//! extension's Rust code — the `git-graph-core` crate — is linked through exactly one module,
//! `src/cmd_graph.rs`. Any other module that names the crate fails the build here, so the
//! coupling cannot quietly spread back out of the seam file.

use std::fs;
use std::path::Path;

fn main() {
    // Tauri's code generation needs the `tauri` crate itself, which only the `desktop` feature
    // pulls in; a bare library build (the tests) builds without it.
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some() {
        tauri_build::build();
    }
    // The integrated git-graph-rs extension's manifest and localisation, embedded from the
    // repository's own files (the app is never built outside it): what the built-in entry in
    // the Extensions view and the workbench's command contributions read.
    let manifest = Path::new("../../package.json").canonicalize().expect("the repository's package.json");
    let nls = Path::new("../../package.nls.json").canonicalize().expect("the repository's package.nls.json");
    println!("cargo:rustc-env=GITGRAPH_PACKAGE_JSON={}", manifest.display());
    println!("cargo:rustc-env=GITGRAPH_NLS_JSON={}", nls.display());
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rerun-if-changed={}", nls.display());
    println!("cargo:rerun-if-changed=src");
    let mut violations = Vec::new();
    visit(Path::new("src"), &mut violations);
    if !violations.is_empty() {
        panic!(
            "git-graph-core may only be used by src/cmd_graph.rs (the engine seam); found references in:\n  {}",
            violations.join("\n  ")
        );
    }
}

fn visit(dir: &Path, violations: &mut Vec<String>) {
    for entry in fs::read_dir(dir).expect("readable src directory") {
        let entry = entry.expect("readable src entry");
        let path = entry.path();
        if path.is_dir() {
            visit(&path, violations);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        // The seam file itself (and the write-path tests beside it, which exercise `handle`).
        if path.file_name().and_then(|n| n.to_str()) == Some("cmd_graph.rs") {
            continue;
        }
        let content = fs::read_to_string(&path).expect("readable source file");
        if content.contains("git_graph_core") {
            violations.push(path.display().to_string());
        }
    }
}
