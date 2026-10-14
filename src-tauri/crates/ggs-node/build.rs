//! The ggs-node sidecar's build script: the N-API host's symbol exports. It MUST live
//! in the same package as the binary — `cargo:rustc-link-arg-bins` only reaches the
//! bins of its own package, and an executable does not export its symbols by default.
//! napi-rs resolves the `napi_*` surface from the host image at registration
//! (`napi-sys`' `find_node_library` probes the executable first).

use std::fs;
use std::path::Path;

fn main() {
    export_napi_host_symbols();
    println!("cargo:rerun-if-changed=src/napi_host.rs");
}

fn export_napi_host_symbols() {
    let host = Path::new("src/napi_host.rs");
    let Ok(source) = fs::read_to_string(host) else {
        return; // the module is always compiled in this package; absent builds never happen
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
