//! Build script: Tauri's code generation, the N-API host's symbol exports, then the
//! compile-time seam check (docs/ggs-development-plan.md §3.7): the engine crate
//! (`git-graph-core`) is named by nothing under `src/` at all — it lives in the
//! git-graph-rs package as `git-graph.node`, hosted by whatever N-API runtime loads it.
//! Any module of the app that names the crate fails the build here, so the coupling
//! cannot quietly spread back into the app.

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
    export_napi_host_symbols();
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=src/node_runtime/napi_host.rs");
    let mut violations = Vec::new();
    visit(Path::new("src"), &mut violations);
    if !violations.is_empty() {
        panic!(
            "the app's own sources under src/ may not name git-graph-core (nothing in this \
             tree links it — the engine ships inside the package as git-graph.node, hosted by \
             the extension's N-API runtime); found references in:\n  {}",
            violations.join("\n  ")
        );
    }
}

/// The N-API host's symbols must be visible to the addons it loads: napi-rs resolves the
/// `napi_*` surface from the host image at registration (`napi-sys`' `find_node_library`
/// probes the executable first), and an executable does not export its symbols by default.
/// On Windows every function in `napi_host.rs` gets an `/EXPORT:` link argument for the
/// `ggs-node` binary; on Linux one `-rdynamic` exports the whole image.
fn export_napi_host_symbols() {
    // Without the feature the module is not compiled: an `/EXPORT:` of a symbol that does
    // not exist fails the link (LNK2001), so a default `desktop` build exports nothing.
    if std::env::var_os("CARGO_FEATURE_NODE_RUNTIME").is_none() {
        return;
    }
    let host = Path::new("src/node_runtime/napi_host.rs");
    let Ok(source) = fs::read_to_string(host) else {
        return; // the node-runtime feature's file; absent builds never load addons
    };
    let mut names: Vec<String> = source
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            // The `napi_fn!` macro's own definition body says `fn $name(…)` — a macro
            // placeholder, not a symbol; the invocations below carry the real names.
            if trimmed.contains('$') {
                return None;
            }
            trimmed
                .strip_prefix("pub unsafe extern \"C\" fn ")
                .or_else(|| trimmed.strip_prefix("pub extern \"C\" fn "))
        })
        .map(|name| name.split(['(', ' ']).next().unwrap_or(name).to_owned())
        .collect();
    // The `napi_fn!` macro declares the implemented surface: each invocation names one
    // exported function.
    for line in source.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("napi_fn!(") {
            let name = rest.split(['(', ' ']).next().unwrap_or(rest);
            names.push(name.to_owned());
        }
    }
    // The macro-declared stubs spell their names as bare idents, not fn signatures.
    for chunk in source.split("napi_stub!").skip(1) {
        for line in chunk.lines() {
            let trimmed = line.trim().trim_end_matches(',');
            if trimmed.starts_with("napi_")
                && trimmed
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                names.push(trimmed.to_owned());
            }
        }
    }
    names.sort_unstable();
    names.dedup();
    if names.is_empty() {
        return;
    }
    // The exports only exist under the `node-runtime` feature (the module compiles under
    // it); a default desktop build links none of this.
    if std::env::var_os("CARGO_FEATURE_NODE_RUNTIME").is_none() {
        return;
    }
    // Every linked target, not only the ggs-node binary: the lib's own test exes host
    // addons exactly the same way (the N-API test loads the real engine through them).
    // `/INCLUDE` first — a target that references nothing from the module would otherwise
    // never pull the object out of the rlib, and `/EXPORT` of an absent symbol fails the
    // link; including it pulls the definition, and the export names it.
    match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("windows") => {
            for name in &names {
                println!("cargo:rustc-link-arg=/EXPORT:{name}");
            }
        }
        Ok("linux") | Ok("freebsd") | Ok("openbsd") => {
            println!("cargo:rustc-link-arg=-rdynamic");
        }
        // macOS: two flags per symbol family. `-u` forces each definition out of the rlib
        // and past `-dead_strip` (nothing in the binary references them — the addon calls
        // them), the way `/INCLUDE:` does on Windows; `-export_dynamic` then keeps the
        // linked definitions in the executable's dynamic symbol table, where an addon's
        // `-undefined dynamic_lookup` imports resolve them. Without the pair the symbols
        // bind to NULL and the engine's registration jumped through address zero.
        Ok("macos") => {
            for name in &names {
                println!("cargo:rustc-link-arg=-Wl,-u,_{name}");
            }
            println!("cargo:rustc-link-arg=-Wl,-export_dynamic");
        }
        _ => {}
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
