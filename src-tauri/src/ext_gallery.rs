//! The extension marketplace: search and one-click install over Open VSX's public REST
//! API — the registry the open-source VS Code ecosystem runs on (code-server and Theia
//! point here too), so a VSIX published anywhere in that ecosystem installs with the same
//! rules as a local file. Three commands, all network-confined: `ext_gallery_search`
//! queries, `ext_gallery_asset` fetches a result's icon (base64, capped), and
//! `ext_gallery_install` downloads the `.vsix` and hands it to [`crate::cmd_ext`]'s
//! ordinary install path — the same manifest validation, forward-only upgrades and
//! unhostable-`.node` rejection a picked file meets.
//!
//! Every URL a command touches is confined to the gallery's own origin (same scheme,
//! same host): the commands can neither fetch nor install from anywhere else, so a
//! crafted answer from the registry cannot turn the app into a downloader for arbitrary
//! hosts. The gallery base defaults to <https://open-vsx.org>; the commands accept an
//! override so a self-hosted registry can be pointed at later.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

use crate::cmd_ext::ExtInfo;

/// The default marketplace: the public Open VSX registry.
pub const DEFAULT_GALLERY: &str = "https://open-vsx.org";
/// The search page size — enough to fill the Extensions view without a second page.
const SEARCH_SIZE: u32 = 20;
/// One gallery request's ceiling: a search or an icon is small; a `.vsix` download is
/// not bounded here (it lands on disk as it streams, not in memory).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// The icon cap: an extension icon is a few KB; anything megabyte-sized is not an icon.
const ASSET_CAP: usize = 2 * 1024 * 1024;

/// One marketplace search result, as the Extensions view renders it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GalleryEntry {
    /// `{namespace}.{name}` — the same shape as an installed extension's id.
    pub id: String,
    pub name: String,
    pub namespace: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub version: String,
    pub download_count: u64,
    pub average_rating: Option<f64>,
    pub verified: bool,
    /// First-publish / last-update time, ISO 8601.
    pub timestamp: String,
    /// The icon's URL (gallery origin), when the listing carries one.
    pub icon_url: Option<String>,
    /// The `.vsix` download URL (gallery origin) — what `ext_gallery_install` takes.
    pub download_url: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GallerySearch {
    /// The registry's total match count (the view shows "of N").
    pub total_size: u64,
    pub entries: Vec<GalleryEntry>,
}

/* ---------- Open VSX's wire shapes ---------- */

#[derive(Deserialize, Debug)]
struct OvsxSearch {
    #[serde(rename = "totalSize", default)]
    total_size: u64,
    #[serde(default)]
    extensions: Vec<OvsxExtension>,
}

#[derive(Deserialize, Debug)]
struct OvsxExtension {
    #[serde(default)]
    name: String,
    #[serde(default)]
    namespace: String,
    #[serde(default)]
    version: String,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(rename = "downloadCount", default)]
    download_count: u64,
    #[serde(rename = "averageRating", default)]
    average_rating: Option<f64>,
    #[serde(default)]
    verified: bool,
    #[serde(default)]
    timestamp: String,
    #[serde(default)]
    files: OvsxFiles,
}

#[derive(Deserialize, Debug, Default)]
struct OvsxFiles {
    download: Option<String>,
    icon: Option<String>,
}

/// The gallery base URL as the commands use it: trimmed, https (a marketplace reached
/// over plain http would let anything on the wire stand in for a package).
fn gallery_url(gallery: Option<String>) -> Result<String, String> {
    let base = gallery.unwrap_or_else(|| DEFAULT_GALLERY.to_owned());
    let trimmed = base.trim().trim_end_matches('/').to_owned();
    if !trimmed.starts_with("https://") || trimmed.len() == "https://".len() {
        return Err(format!("the marketplace URL must be https: {base}"));
    }
    Ok(trimmed)
}

/// The `host[:port]` of an https URL ("" when the URL is not one): enough origin to
/// compare, without pulling a URL crate in for two string splits.
fn authority_of(url: &str) -> &str {
    let Some(rest) = url.strip_prefix("https://") else {
        return "";
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    &rest[..end]
}

/// `url` must sit on the gallery's own origin — see the module doc.
fn confined(base: &str, url: &str) -> Result<String, String> {
    let url = url.trim();
    let origin = authority_of(base);
    if origin.is_empty() || authority_of(url) != origin {
        return Err(format!("refusing a non-marketplace URL: {url}"));
    }
    Ok(url.to_owned())
}

/// Percent-encode a query value (RFC 3986 unreserved characters pass through).
fn encode_query(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The search endpoint URL. `target=universal` keeps results to host-anywhere packages —
/// this app has no Node runtime, so a platform-target VSIX's native binaries would be
/// rejected at the install door anyway; the search should not offer them.
fn search_url(base: &str, query: &str) -> String {
    format!(
        "{base}/api/-/search?query={}&size={SEARCH_SIZE}&target=universal",
        encode_query(query)
    )
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(REQUEST_TIMEOUT))
        .build()
        .into()
}

/// GET `url` (confined to the gallery origin) and return its body.
fn get(base: &str, url: &str) -> Result<Vec<u8>, String> {
    let url = confined(base, url)?;
    let mut response = agent()
        .get(&url)
        .call()
        .map_err(|e| format!("request to the marketplace failed: {e}"))?;
    response
        .body_mut()
        .read_to_vec()
        .map_err(|e| format!("read the marketplace answer: {e}"))
}

/// The registry's answer as the view's entries. A listing without a `files.download` is
/// not installable here — it is skipped, not surfaced as a dead row.
fn search_map(parsed: OvsxSearch) -> GallerySearch {
    let entries = parsed
        .extensions
        .into_iter()
        .filter_map(|extension| {
            let download = extension.files.download?;
            if extension.name.is_empty() || extension.namespace.is_empty() {
                return None;
            }
            Some(GalleryEntry {
                id: format!("{}.{}", extension.namespace, extension.name),
                name: extension.name,
                namespace: extension.namespace,
                display_name: extension.display_name,
                description: extension.description,
                version: extension.version,
                download_count: extension.download_count,
                average_rating: extension.average_rating,
                verified: extension.verified,
                timestamp: extension.timestamp,
                icon_url: extension.files.icon,
                download_url: download,
            })
        })
        .collect();
    GallerySearch {
        total_size: parsed.total_size,
        entries,
    }
}

/// Run one search against the registry.
fn search(base: &str, query: &str) -> Result<GallerySearch, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(GallerySearch {
            total_size: 0,
            entries: Vec::new(),
        });
    }
    let bytes = get(base, &search_url(base, query))?;
    let parsed: OvsxSearch = serde_json::from_slice(&bytes)
        .map_err(|e| format!("the marketplace's answer is not valid JSON: {e}"))?;
    Ok(search_map(parsed))
}

/// Download the `.vsix` `download_url` names into a temp file (confined to the gallery
/// origin — nothing else on the network is reachable through this path).
fn download_vsix(base: &str, download_url: &str) -> Result<PathBuf, String> {
    let bytes = get(base, download_url)?;
    let name = download_url
        .rsplit('/')
        .next()
        .filter(|stem| stem.ends_with(".vsix"))
        .unwrap_or("extension.vsix");
    let path = std::env::temp_dir().join(format!("ggs-gallery-{}-{name}", std::process::id()));
    std::fs::write(&path, &bytes).map_err(|e| format!("write the downloaded package: {e}"))?;
    Ok(path)
}

/// Search the marketplace for `query` — the Extensions view's search box.
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
pub async fn ext_gallery_asset(
    gallery: Option<String>,
    url: String,
) -> Result<String, String> {
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
    state: tauri::State<'_, crate::ext_process::ProcessHostState>,
    gallery: Option<String>,
    download_url: String,
) -> Result<ExtInfo, String> {
    let base = gallery_url(gallery)?;
    // Download and read the manifest off the UI thread; the backend stop and the install
    // follow once the id is known (the two things that touch shared state).
    let (package, ext_id) = tauri::async_runtime::spawn_blocking(move || -> Result<(PathBuf, String), String> {
        let package = download_vsix(&base, &download_url)?;
        let manifest = crate::cmd_ext::read_vsix_manifest(&package)?;
        Ok((package, manifest.extension_id()))
    })
    .await
    .map_err(|e| format!("the download was cancelled: {e}"))??;
    // The old install's backend cannot outlive the directory its exe lives in.
    let _ = state.stop(&ext_id);
    let dir = crate::cmd_ext::extensions_dir(&app)?;
    let installed = tauri::async_runtime::spawn_blocking(move || {
        let result = crate::cmd_ext::install_from_vsix_into(&dir, &package, false);
        let _ = std::fs::remove_file(&package); // the temp copy never outlives the install
        result
    })
    .await
    .map_err(|e| format!("the install was cancelled: {e}"))?;
    installed
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real (trimmed) Open VSX search answer — two entries, one with every field, one
    /// without a rating — captured from the live registry, kept verbatim so the mapping
    /// is tested against the wire format, not a re-typing of it.
    const SAMPLE_SEARCH: &str = r#"{"extensions":[
        {"deprecated":false,"description":"Fancy, smooth and beautiful UI like Lazyvim",
         "displayName":"LazyVscode Theme","downloadCount":28367,
         "files":{"download":"https://open-vsx.org/api/lazyvscode-theme/lazyvscode-theme/6.5.2/file/lazyvscode-theme.lazyvscode-theme-6.5.2.vsix",
                  "icon":"https://open-vsx.org/api/lazyvscode-theme/lazyvscode-theme/6.5.2/file/logo.png"},
         "name":"lazyvscode-theme","namespace":"lazyvscode-theme","timestamp":"2026-01-05T10:18:55.324226Z",
         "url":"https://open-vsx.org/api/lazyvscode-theme/lazyvscode-theme","verified":true,"version":"6.5.2"},
        {"deprecated":false,"description":"MQL5 Syntax Highlighting and Themes",
         "displayName":"MQL5 Support","downloadCount":8199,
         "files":{"download":"https://open-vsx.org/api/MQL5-Theme-syntax/mql5-support/1.5.6/file/MQL5-Theme-syntax.mql5-support-1.5.6.vsix"},
         "name":"mql5-support","namespace":"MQL5-Theme-syntax","timestamp":"2026-02-10T10:18:55.191871Z",
         "url":"https://open-vsx.org/api/MQL5-Theme-syntax/mql5-support","verified":false,"version":"1.5.6"}],
        "offset":0,"totalSize":2351}"#;

    #[test]
    fn maps_the_open_vsx_search_answer() {
        let parsed: OvsxSearch = serde_json::from_str(SAMPLE_SEARCH).unwrap();
        let answer = search_map(parsed);
        assert_eq!(answer.total_size, 2351);
        assert_eq!(answer.entries.len(), 2);
        let first = &answer.entries[0];
        assert_eq!(first.id, "lazyvscode-theme.lazyvscode-theme");
        assert_eq!(first.display_name.as_deref(), Some("LazyVscode Theme"));
        assert_eq!(first.version, "6.5.2");
        assert_eq!(first.download_count, 28367);
        assert!(first.verified);
        assert!(first.icon_url.as_deref().unwrap_or_default().ends_with("logo.png"));
        assert!(first.download_url.ends_with(".vsix"));
        assert!(answer.entries[1].icon_url.is_none());
        assert!(!answer.entries[1].verified);
    }

    #[test]
    fn entries_without_a_download_are_skipped() {
        let answer: OvsxSearch = serde_json::from_str(
            r#"{"totalSize":1,"extensions":[
                {"name":"orphan","namespace":"acme","version":"1.0.0","files":{}}]}"#,
        )
        .unwrap();
        let mapped = search_map(answer);
        assert_eq!(mapped.total_size, 1);
        assert!(mapped.entries.is_empty());
    }

    #[test]
    fn the_query_is_percent_encoded_into_the_search_url() {
        let url = search_url("https://open-vsx.org", "c++ theme");
        assert!(url.starts_with("https://open-vsx.org/api/-/search?query=c%2B%2B%20theme&"));
        assert!(url.contains("size=20"));
        assert!(url.contains("target=universal"));
    }

    #[test]
    fn the_gallery_must_be_https_and_defaults_to_open_vsx() {
        assert_eq!(gallery_url(None).unwrap(), DEFAULT_GALLERY);
        assert_eq!(
            gallery_url(Some("https://self-hosted.example/".into())).unwrap(),
            "https://self-hosted.example"
        );
        assert!(gallery_url(Some("http://open-vsx.org".into())).is_err());
        assert!(gallery_url(Some("https://".into())).is_err());
    }

    #[test]
    fn only_the_gallery_origin_is_reachable() {
        let base = "https://open-vsx.org";
        assert_eq!(
            confined(base, "https://open-vsx.org/api/acme/demo/1.0.0/file/demo.vsix").unwrap(),
            "https://open-vsx.org/api/acme/demo/1.0.0/file/demo.vsix"
        );
        assert!(confined(base, "https://evil.example/demo.vsix").is_err());
        assert!(confined(base, "http://open-vsx.org/demo.vsix").is_err());
        assert!(confined(base, "not a url").is_err());
    }
}
