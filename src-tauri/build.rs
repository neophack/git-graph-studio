//! Build script: Tauri's code generation, then the compile-time seam check (docs/ggs-development-plan.md §3.7): the engine crate
//! (`git-graph-core`) is named by nothing under `src/` at all — it lives in the git-graph-rs
//! plugin's own backend sources (`plugins/git-graph-rs/src/`, the `engine`-feature binary
//! `git-graph-backend`). Any module of the app that names the crate fails the build here, so
//! the coupling cannot quietly spread back into the app.

use std::fs;
use std::path::Path;

fn main() {
    // Tauri's code generation needs the `tauri` crate itself, which only the `desktop` feature
    // pulls in; a bare library build (the tests) builds without it.
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some() {
        tauri_build::build();
        // The desktop feature links the dialog plugin, whose message dialogs import
        // `TaskDialogIndirect` from common-controls v6 — an export the System32 v5
        // comctl32.dll lacks, so a manifest-less exe dies at load with
        // STATUS_ENTRYPOINT_NOT_FOUND. The app's binaries get v6 through tauri-build's own
        // embedded manifest resource; the lib's test exe does not, so the side-by-side
        // dependency is spelled for every target here and link.exe writes it as an
        // EXTERNAL manifest beside the exes that lack an embedded one (the loader prefers
        // an embedded manifest, so the shipped app binary is untouched).
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
            println!(
                "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' publicKeyToken='6595b64144ccf1df' language='*' processorArchitecture='*'"
            );
        }
    }
    println!("cargo:rerun-if-changed=src");
    let mut violations = Vec::new();
    visit(Path::new("src"), &mut violations);
    if !violations.is_empty() {
        panic!(
            "the app's own sources under src/ may not name git-graph-core (the engine lives in \
             the git-graph-rs plugin's backend, plugins/git-graph-rs/src/); found references in:\n  {}",
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
        let content = fs::read_to_string(&path).expect("readable source file");
        if content.contains("git_graph_core") {
            violations.push(path.display().to_string());
        }
    }
}
