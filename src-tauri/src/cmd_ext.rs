//! Extension management for Git Graph Studio — the app's adapter half (module 12).
//!
//! The engine lives in the `ggs-ext` crate: `.vsix` install / uninstall / upgrade over an
//! explicit store directory, the runtime `manifest.json` and the backend derivation, the
//! `ggs://` page-serving core, the workspace-confined `ext_fs`, the frame code preload,
//! the logs and the Node environment facts. This file keeps what cannot leave the app:
//! the `#[tauri::command]` adapters, the store-directory resolution (`~/.ggs/extensions`,
//! the one-time migration from the pre-`.ggs` location, the isolated-store test pin), the
//! bundled-package root discovery (the installer's resource directory and a dev tree's
//! output), and the `ggs://` protocol registration over tauri's asset resolver.

use std::path::{Path, PathBuf};

use tauri::Manager;

use ggs_ext::vsix::read_vsix_manifest;
use ggs_ext::store::ext_storage_paths_in;
use ggs_ext::{
    bundled_offer, bundled_packages_in, bundled_vsix_packages_in, ext_fs_core,
    ext_page_file_chunk_core, ext_page_revision_bytes_core, find_installed,
    install_from_vsix_into, install_missing_bundled_in, list_installed, load_code_from,
    node_env, refresh_bundled_installs_in, safe_join, uninstall, ExtInfo, ExtNodeEnv,
    ExtPageBytes,
};

pub fn extensions_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = extensions_home_dir()?;
    migrate_from_app_data(app, &dir);
    Ok(dir)
}

/// `~/.ggs/extensions`, created if missing — the store itself, without the one-time
/// migration only the app performs (the headless `--measure` run uses this).
pub fn extensions_home_dir() -> Result<PathBuf, String> {
    // Tests pin the store to an isolated empty directory (test_isolated_store::isolated_extension_store):
    // the developer's real `~/.ggs/extensions` may well hold a backend-carrying package (any run
    // of the app installs one), and "no backend reachable" assertions must not depend on that.
    #[cfg(test)]
    if let Some(dir) = TEST_EXTENSIONS_HOME.lock().unwrap().clone() {
        return Ok(dir);
    }
    let dir = ggs_base::paths::extensions_home()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

#[cfg(test)]
static TEST_EXTENSIONS_HOME: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

#[cfg(test)]
pub(crate) fn pin_extensions_home(dir: PathBuf) {
    *TEST_EXTENSIONS_HOME.lock().unwrap() = Some(dir);
}

#[cfg(test)]
pub(crate) fn unpin_extensions_home() {
    *TEST_EXTENSIONS_HOME.lock().unwrap() = None;
}

/// One-time move from the pre-`.ggs` location (`{app_data}/extensions`) so existing installs
/// keep working. Entries already present at the new location (a newer version installed there)
/// are left behind with the old directory itself.
fn migrate_from_app_data(app: &tauri::AppHandle, dir: &Path) {
    let Ok(old) = app.path().app_data_dir() else {
        return;
    };
    let old = old.join("extensions");
    let entries = match std::fs::read_dir(&old) {
        Ok(entries) => entries,
        Err(_) => return, // nothing to migrate (the usual case after the first run)
    };
    for entry in entries.flatten() {
        let dest = dir.join(entry.file_name());
        if !dest.exists() {
            let _ = std::fs::rename(entry.path(), &dest);
        }
    }
    if std::fs::read_dir(&old).is_ok_and(|mut e| e.next().is_none()) {
        let _ = std::fs::remove_dir(&old);
    }
}

#[tauri::command]
pub fn ext_list(app: tauri::AppHandle) -> Result<Vec<ExtInfo>, String> {
    let dir = extensions_dir(&app)?;
    let mut list = list_installed(&dir)?;
    // The bundled offers follow the installs: a package already installed is its own listing
    // (its version is the install's), and only the not-installed bundled ones remain offers —
    // safe because the boot pass's refresh brings an installed one current (an upgrade when
    // the bundled build is newer, a refresh when it is a rebuild of the same version).
    for package in bundled_packages(&app) {
        if list.iter().any(|ext| ext.id == package.id) {
            continue;
        }
        list.push(bundled_offer(&package));
    }
    Ok(list)
}

/// The directories a bundled package can sit in: the installer's `extensions/` resource
/// directory first, then a dev run's `target/studio/bundled` (its versioned packages and
/// the fixed-name copies prepare.mjs assembles for the installer).
fn bundled_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(resource) = app
        .path()
        .resolve("extensions", tauri::path::BaseDirectory::Resource)
    {
        roots.push(resource);
    }
    // 'tauri dev' runs cargo from src-tauri/; the bat and CI from the repository root.
    for base in [
        "target/studio/bundled",
        "target/studio/bundled/app-resources/extensions",
        "../target/studio/bundled",
        "../target/studio/bundled/app-resources/extensions",
    ] {
        roots.push(PathBuf::from(base));
    }
    roots
}

/// The `.vsix` packages shipped beside the app (the engine's `bundled_packages_in` does the
/// scan; the app only names the roots, so it still names no package id of its own).
fn bundled_packages(app: &tauri::AppHandle) -> Vec<ggs_ext::BundledPackage> {
    bundled_packages_in(&bundled_roots(app))
}

/// Install a `.vsix` package — the store's own format, and for git-graph-rs the only one it
/// ships (its `ggs` key makes it a full package here). A newer version replaces an
/// installed package of the same id, forward-only.
#[tauri::command]
pub fn ext_install_from_vsix(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::ext_process::ProcessHostState>,
    path: String,
) -> Result<ExtInfo, String> {
    let dir = extensions_dir(&app)?;
    // The old install's backend cannot outlive the directory its exe lives in.
    let manifest = read_vsix_manifest(Path::new(&path))?;
    let _ = state.stop(&manifest.extension_id());
    install_from_vsix_into(&dir, Path::new(&path), false)
}

/// Install one of the bundled packages the installer ships — the one-click Install on the
/// Extensions view's bundled offers. The id is explicit (the frontend names the row it
/// installs) and the package is found by discovery, so the app still names no id of its own.
/// A standard install either way: forward-only like any package, uninstallable like any
/// package.
#[tauri::command]
pub fn ext_install_bundled(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::ext_process::ProcessHostState>,
    ext_id: String,
) -> Result<ExtInfo, String> {
    let dir = extensions_dir(&app)?;
    let package = bundled_packages(&app)
        .into_iter()
        .find(|package| package.id == ext_id)
        .ok_or_else(|| format!("{ext_id} has no bundled package"))?;
    // The old install's backend cannot outlive the directory its exe lives in —
    // the same stop-first the VSIX and gallery installs enforce (a live backend
    // running from unlinked files answers RPCs for code no longer on disk).
    let _ = state.stop(&ext_id);
    let info = install_from_vsix_into(&dir, &package.path, false)?;
    ggs_ext::store::record_bundled_stamp(
        &dir.join(format!("{ext_id}-{}", info.version)),
        &package.path,
    );
    Ok(info)
}

/// The boot pass's refresh of installed packages the installer also ships (the engine's
/// `refresh_bundled_installs_in` decides what each install needs). Returns one line per
/// refreshed, upgraded or failed package, for the boot log.
pub fn refresh_bundled_installs(app: &tauri::AppHandle) -> Vec<Result<String, String>> {
    let Ok(dir) = extensions_dir(app) else {
        return Vec::new();
    };
    refresh_bundled_installs_in(&dir, &bundled_packages(app))
}

/// First-launch auto-install: a bundled package the store carries but nothing installed —
/// exactly the state right after the installer ran — installs here, the way VS Code's
/// bundled extensions are simply there on first run. A dismissal marker (written at
/// uninstall) or an existing install skips; the refresh pass keeps an install current.
pub fn install_missing_bundled(app: &tauri::AppHandle) -> Vec<Result<String, String>> {
    let Ok(dir) = extensions_dir(app) else {
        return Vec::new();
    };
    let packages: Vec<PathBuf> = bundled_vsix_packages_in(&bundled_roots(app));
    install_missing_bundled_in(&dir, &packages)
}

/// The uninstall every caller runs: this app's own backend for the extension dies first — its
/// exe lives inside the directory being removed, and on Windows a running binary cannot be
/// deleted — then the install goes.
pub fn uninstall_stopping(
    dir: &Path,
    ext_id: &str,
    host: &crate::ext_process::ProcessHostState,
) -> Result<(), String> {
    let _ = host.stop(ext_id);
    uninstall(dir, ext_id)
}

/// Uninstall an extension. The bundled git-graph-rs copy carries the built-in flag and is
/// refused by the core (`uninstall`); a user-installed copy — an upgrade of it — goes freely.
#[tauri::command]
pub fn ext_uninstall(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::ext_process::ProcessHostState>,
    ext_id: String,
) -> Result<(), String> {
    let dir = extensions_dir(&app)?;
    uninstall_stopping(&dir, &ext_id, &state)?;
    // A deliberate uninstall of a bundled package is remembered: the boot pass
    // auto-installs only what the user never removed (the marker file, not the package
    // directory, is what a later boot reads).
    let _ = std::fs::write(
        dir.join(format!(".bundled-dismissed-{ext_id}")),
        b"uninstalled\n",
    );
    Ok(())
}

/// Read a file inside an installed extension's directory (the extension host loads the
/// entry bundle this way). Paths are confined to the extension's own directory.
#[tauri::command]
pub fn ext_read_file(
    app: tauri::AppHandle,
    ext_id: String,
    rel_path: String,
) -> Result<String, String> {
    let dir = extensions_dir(&app)?;
    let versions = find_installed(&dir, &ext_id)?;
    let version = versions
        .last()
        .ok_or_else(|| format!("{ext_id} is not installed"))?;
    let ext_dir = dir.join(format!("{ext_id}-{version}"));
    let path = safe_join(&ext_dir, &rel_path)?;
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))
}

/// A file inside an installed extension's directory, base64-encoded - how the UI reads icons and
/// README images (binary files `ext_read_file` cannot return as text). Paths are confined to the
/// extension's own directory.
#[tauri::command]
pub fn ext_read_file_base64(
    app: tauri::AppHandle,
    ext_id: String,
    rel_path: String,
) -> Result<String, String> {
    let dir = extensions_dir(&app)?;
    let versions = find_installed(&dir, &ext_id)?;
    let version = versions
        .last()
        .ok_or_else(|| format!("{ext_id} is not installed"))?;
    let ext_dir = dir.join(format!("{ext_id}-{version}"));
    let path = safe_join(&ext_dir, &rel_path)?;
    // Size guard: a stray large binary would balloon the IPC message; icons and doc images stay
    // well below this.
    let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(format!("{} is too large to inline", rel_path));
    }
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// The extension's loadable code map — what the host hands the frame at activation.
#[tauri::command]
pub fn ext_load_code(app: tauri::AppHandle, ext_id: String) -> Result<ggs_ext::ExtCodeBundle, String> {
    let dir = extensions_dir(&app)?;
    let root = ggs_ext::installed_dir(&dir, &ext_id)?;
    load_code_from(&root)
}

/// The frame's Node environment facts, as `os` / `process` report them: the sandboxed frame
/// cannot read env vars or the host's paths, so the activation context carries these in.
#[tauri::command]
pub fn ext_node_env() -> ExtNodeEnv {
    node_env()
}

/// `vscode.workspace.fs` over one command: every op confines its path to the workspace
/// folders first (the engine's `confine_to_roots`), so an extension can never reach
/// outside them. `exists` / `find` answer matching paths (empty = none) — the activation
/// pass uses them for `workspaceContains`, the frame's `workspace.fs` for everything else.
#[tauri::command]
pub fn ext_fs(
    op: String,
    roots: Vec<String>,
    path: String,
    to: Option<String>,
    data: Option<String>,
) -> Result<serde_json::Value, String> {
    use base64::Engine;
    ext_fs_core(
        &op,
        &roots,
        &path,
        to.as_deref(),
        data.as_deref(),
        |bytes| base64::engine::general_purpose::STANDARD.encode(bytes),
    )
}

/// `__revisionFileBytes`: a file's whole bytes at one revision (`git cat-file blob`),
/// base64 — the working-tree sentinel `*` reads the file on disk instead.
#[tauri::command]
pub async fn ext_page_revision_bytes(
    roots: Vec<String>,
    repo: String,
    revision: String,
    path: String,
) -> Result<ExtPageBytes, String> {
    use base64::Engine;
    tauri::async_runtime::spawn_blocking(move || {
        ext_page_revision_bytes_core(&roots, &repo, &revision, &path, |bytes| {
            base64::engine::general_purpose::STANDARD.encode(bytes)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `__fileChunk`: a working-tree file's window — `offset`, at most `len` bytes — base64,
/// with the file's whole size (`stat` and the stream end both read it).
#[tauri::command]
pub async fn ext_page_file_chunk(
    roots: Vec<String>,
    repo: String,
    path: String,
    offset: i64,
    len: i64,
) -> Result<ExtPageBytes, String> {
    use base64::Engine;
    tauri::async_runtime::spawn_blocking(move || {
        ext_page_file_chunk_core(&roots, &repo, &path, offset, len, |bytes| {
            base64::engine::general_purpose::STANDARD.encode(bytes)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Append the workbench's buffered extension-host log lines (`src/extLog.ts`) to
/// `~/.ggs/logs/ext-host.log` (the engine's bounded append).
#[tauri::command]
pub fn ext_log_append(lines: Vec<String>) -> Result<(), String> {
    ggs_ext::append_host_log(lines)
}

/// Where the extension host's log file lives (the "Open Extension Host Log" command).
#[tauri::command]
pub fn ext_log_path() -> Result<String, String> {
    ggs_ext::host_log_path()
}

/// `ext_storage_paths`: the extension's storage directories for the current workspace.
#[tauri::command]
pub fn ext_storage_paths(
    ext_id: String,
    workspace: Option<String>,
) -> Result<ggs_ext::ExtStoragePaths, String> {
    let store = extensions_home_dir()?;
    let home = store
        .parent()
        .ok_or_else(|| "the extension store has no parent".to_owned())?;
    ext_storage_paths_in(home, &ext_id, workspace.as_deref())
}

// ---------------------------------------------------------------------------
// The `ggs://` protocol: how an installed package's pages reach a sandboxed iframe
// ---------------------------------------------------------------------------

/// Serve one `ggs://` request: a file of an installed package, as the extension pages'
/// iframes load them. URL shape `/{id}-{version}/{path}`; the package segment and the path
/// are both confined (no `..`), the root is the extensions home. An HTML page is composed
/// with the page bootstrap (`page_boot.js`) the way graphPreload composes the Git Graph
/// page — the host environment joins the extension's own document, never a copy of it.
///
/// Two reserved names (`ext-host.html`, `assets/…`) are answered from the app's own
/// embedded frontend assets instead — the extension host frame's document (see
/// [`is_app_asset_path`]).
pub fn serve_ext_asset(
    request: &tauri::http::Request<Vec<u8>>,
    assets: &tauri::AssetResolver<tauri::Wry>,
) -> tauri::http::Response<Vec<u8>> {
    // Diagnostics for the page-loading seam: every asset request and its status, so a frame
    // that never renders can be attributed (never reached the handler / 404 / served).
    let uri = request.uri().to_string();
    let path = ggs_base::fsx::percent_decode(request.uri().path().trim_start_matches('/'));
    let response = if is_app_asset_path(&path) {
        serve_app_asset(assets, &path).unwrap_or_else(|| ggs_ext::ext_not_found(&path))
    } else {
        match extensions_home_dir() {
            Ok(home) => ggs_ext::serve_ext_asset_from(&home, request.uri().path()),
            Err(_) => ggs_ext::ext_not_found(&path),
        }
    };
    eprintln!("[ext-asset] {} {uri}", response.status().as_u16());
    response
}

/// The extension host frame's document (`ext-host.html`) and its hashed assets
/// (`assets/…`) ride this protocol too. The frame is sandboxed without `allow-same-origin`,
/// so its document sits on an opaque origin and the `type=module` scripts it references
/// load CORS-checked — the tauri protocol answers those with the app's own origin, never
/// `null`, and the load dies (no frame extension would ever activate in the packaged app).
/// This protocol answers `*`, which an opaque origin passes. The names are reserved: an
/// installed package's directory always spells `{id}-{version}`, so neither can be one.
fn is_app_asset_path(path: &str) -> bool {
    path == "ext-host.html" || path.starts_with("assets/")
}

fn serve_app_asset(
    assets: &tauri::AssetResolver<tauri::Wry>,
    path: &str,
) -> Option<tauri::http::Response<Vec<u8>>> {
    let bytes = assets.get(path.to_owned())?.bytes;
    Some(app_asset_response(path, &bytes))
}

/// The response shape an opaque-origin frame needs: the permissive allow-origin beside the
/// exact content-length (the same Content-Length contract the engine's page core states).
fn app_asset_response(path: &str, bytes: &[u8]) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .header(
            tauri::http::header::CONTENT_TYPE,
            ggs_ext::content_type(Path::new(path)),
        )
        .header(tauri::http::header::CONTENT_LENGTH, bytes.len())
        .header(tauri::http::header::CACHE_CONTROL, "max-age=3600")
        .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(bytes.to_vec())
        .expect("a response with a valid header value")
}

#[cfg(test)]
mod app_asset_tests {
    use super::*;

    #[test]
    fn the_frame_document_names_are_reserved_for_the_app_assets() {
        // The routing predicate: an installed directory always spells `{id}-{version}`, so
        // the frame document and the vite asset root can never be one and the reserved
        // names are answered from the embedded app assets unconditionally.
        assert!(is_app_asset_path("ext-host.html"));
        assert!(is_app_asset_path("assets/extHost-CKH6j0OT.js"));
        assert!(!is_app_asset_path("acme.demo-1.0.0/web/view.html"));
        assert!(!is_app_asset_path(""));
        // The response shape an opaque-origin frame needs: `*` allow-origin (the tauri
        // protocol answers with the app origin, which a `null`-origin frame can never
        // pass), an exact content-length, and the vite build's content types.
        let response = app_asset_response("ext-host.html", b"<html></html>");
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        let header = |name| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned()
        };
        assert_eq!(
            header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN),
            "*"
        );
        assert_eq!(header(tauri::http::header::CONTENT_LENGTH), "13");
        assert_eq!(
            header(tauri::http::header::CONTENT_TYPE),
            "text/html; charset=utf-8"
        );
        let script = app_asset_response("assets/extHost-CKH6j0OT.js", b";");
        assert_eq!(
            script
                .headers()
                .get(tauri::http::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("text/javascript; charset=utf-8")
        );
    }
}
