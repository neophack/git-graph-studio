//! The marketplace's command adapters (module 12): Open VSX featured ids, lookup,
//! search, asset fetch and download-and-install. The engine — the origin-confined
//! registry client, the Open VSX answer mapping, the `.vsix` download — lives in
//! `ggs_ext::gallery`; a marketplace package installs through `cmd_ext`'s ordinary
//! VSIX path.

use std::path::PathBuf;

use ggs_ext::ExtInfo;
use ggs_ext::gallery::{download_vsix, gallery_url, get, lookup, search, GalleryEntry, GallerySearch, ASSET_CAP, FEATURED};

#[tauri::command]
pub fn ext_gallery_featured() -> Vec<String> {
    FEATURED.iter().map(|id| (*id).to_owned()).collect()
}

/// One exact id's entry for this machine's platform — a featured row's marketplace half,
/// and how a package's declared dependencies resolve (a search ranks, and can miss, the
/// exact id).
#[tauri::command]
pub async fn ext_gallery_lookup(
    gallery: Option<String>,
    id: String,
) -> Result<GalleryEntry, String> {
    let base = gallery_url(gallery)?;
    tauri::async_runtime::spawn_blocking(move || lookup(&base, &id))
        .await
        .map_err(|e| format!("the lookup was cancelled: {e}"))?
}

/// Search the marketplace for `query`.
#[tauri::command]
pub async fn ext_gallery_search(
    gallery: Option<String>,
    query: String,
) -> Result<GallerySearch, String> {
    let base = gallery_url(gallery)?;
    tauri::async_runtime::spawn_blocking(move || search(&base, &query))
        .await
        .map_err(|e| format!("the search was cancelled: {e}"))?
}

/// One marketplace asset (an extension's icon), base64-encoded — the same shape
/// `ext_read_file_base64` serves installed packages' icons in.
#[tauri::command]
pub async fn ext_gallery_asset(gallery: Option<String>, url: String) -> Result<String, String> {
    let base = gallery_url(gallery)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = get(&base, &url)?;
        if bytes.len() > ASSET_CAP {
            return Err("the marketplace asset is too large to inline".to_owned());
        }
        use base64::Engine;
        Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
    })
    .await
    .map_err(|e| format!("the fetch was cancelled: {e}"))?
}

/// Download and install a marketplace package: the `.vsix` the search offered, through
/// the ordinary install path (manifest validation, forward-only upgrade, the
/// unhostable-`.node` door) — and with the same backend stop-first an explicit VSIX
/// install performs, so an upgraded process package's old exe is never replaced while
/// it runs.
#[tauri::command]
pub async fn ext_gallery_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, ggs_ext::process::ExtHost>,
    gallery: Option<String>,
    download_url: String,
) -> Result<ExtInfo, String> {
    let base = gallery_url(gallery)?;
    // Download and read the manifest off the UI thread; the backend stop and the install
    // follow once the id is known (the two things that touch shared state).
    let (package, ext_id) =
        tauri::async_runtime::spawn_blocking(move || -> Result<(PathBuf, String), String> {
            let package = download_vsix(&base, &download_url)?;
            let manifest = ggs_ext::read_vsix_manifest(&package).inspect_err(|_| {
                let _ = std::fs::remove_file(&package); // an unreadable package leaves no temp copy
            })?;
            Ok((package, manifest.extension_id()))
        })
        .await
        .map_err(|e| format!("the download was cancelled: {e}"))??;
    // The old install's backend cannot outlive the directory its exe lives in.
    let _ = state.stop(&ext_id);
    let dir = crate::cmd_ext::extensions_dir(&app)?;
    let installed = tauri::async_runtime::spawn_blocking(move || {
        let result = ggs_ext::install_from_vsix_into(&dir, &package, false);
        let _ = std::fs::remove_file(&package); // the temp copy never outlives the install
        result
    })
    .await
    .map_err(|e| format!("the install was cancelled: {e}"))?;
    installed
}
