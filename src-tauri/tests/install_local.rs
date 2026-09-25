//! One-off local probe (never runs in CI): install the two VSIX files the owner is testing
//! with — straight from Downloads — through the app's own `install_from_vsix_into`, into
//! the real `~/.ggs/extensions/` directory, so a live `tauri` run picks them up exactly as
//! if they had been installed through the Extensions view. Skipped unless both files exist
//! and `--ignored` is passed.

#![cfg(feature = "desktop")]

// The N-API host's exported surface must be in this image for the /EXPORT directives
// to resolve; this suite never loads an addon itself, so this test holds the reference
// the linker needs (a const cannot — it folds away).
#[test]
#[cfg(feature = "node-runtime")]
fn the_napi_surface_links() {
    git_graph_studio_lib::node_runtime::link_napi_host();
}

use git_graph_studio_lib::cmd_ext;
use std::path::PathBuf;

#[test]
#[ignore = "local-only: installs the owner's Downloads VSIX files into the real ~/.ggs/extensions"]
fn install_the_local_test_vsix_files_into_the_real_extensions_dir() {
    let downloads = PathBuf::from("C:/Users/penghongxia/Downloads");
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap();
    let exts = PathBuf::from(&home).join(".ggs").join("extensions");
    std::fs::create_dir_all(&exts).unwrap();
    let mut targets = vec![
        downloads.join("ggs-vsix/EditorConfig-0.18.2.vsix"),
        downloads.join("ggs-vsix/prettier-vscode-12.4.0.vsix"),
        downloads.join("ggs-vsix/code-spell-checker-4.9.3.vsix"),
    ];
    if std::env::var("INSTALL_GITGRAPH_1025").is_ok() {
        // The owner's machine carries a newer git-graph-rs; the forward-only rule rightly
        // refuses the downgrade, so the 1.0.25 file gets a clean slot: uninstall first.
        let _ = cmd_ext::uninstall_stopping(&exts, "neophack.git-graph-rs", &Default::default());
        targets.push(downloads.join("git-graph-rs-1.0.25.vsix"));
        targets.push(downloads.join("ms-python.python-2026.4.0.vsix"));
    }
    if targets.iter().any(|path| !path.is_file()) {
        eprintln!("skipping: not all test VSIX files are present");
        return;
    }
    for vsix in targets {
        match cmd_ext::install_from_vsix_into(&exts, &vsix, false) {
            Ok(info) => {
                let backend = info
                    .capabilities
                    .as_ref()
                    .and_then(|capabilities| capabilities.backend.as_ref())
                    .map(|backend| {
                        format!(
                            "{} -> {} (host {})",
                            backend.kind,
                            backend.command,
                            backend.host.as_deref().unwrap_or("<default>")
                        )
                    })
                    .unwrap_or_else(|| "no backend".to_owned());
                eprintln!("installed {}: {backend}", info.id);
            }
            // An "already installed" answer is fine — the package is there, which is the point.
            Err(error) if error.contains("already installed") => {
                eprintln!("already installed: {error}")
            }
            Err(error) => panic!("install {}: {error}", vsix.display()),
        }
    }
}

#[test]
#[ignore = "local-only: installs the probe extension"]
fn install_the_probe_extension() {
    let vsix = PathBuf::from("C:/Users/penghongxia/ZCodeProject/git-graph-studio/target/studio/probe-ext/local.probe-0.0.1.vsix");
    if !vsix.is_file() {
        eprintln!("skipping: probe vsix missing");
        return;
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap();
    let exts = PathBuf::from(&home).join(".ggs").join("extensions");
    std::fs::create_dir_all(&exts).unwrap();
    let _ = cmd_ext::uninstall_stopping(&exts, "local.probe", &Default::default());
    match cmd_ext::install_from_vsix_into(&exts, &vsix, false) {
        Ok(info) => eprintln!(
            "installed {}: {:?}",
            info.id,
            info.capabilities
                .as_ref()
                .map(|c| c.backend.as_ref().map(|b| b.kind.clone()))
        ),
        Err(error) if error.contains("already installed") => {
            eprintln!("already installed: {error}")
        }
        Err(error) => panic!("install: {error}"),
    }
}
