//! The `ggs://` page-serving core: a file of an installed package answered over plain
//! `http` types (the app's protocol adapter hands them to tauri unchanged — tauri's
//! `tauri::http` is this same crate), the boot-script composition into every HTML page,
//! and the retired-version fallback that keeps a living page's assets answerable.

use std::path::Path;

use ggs_base::fsx::percent_decode;

use crate::store::list_installed;

/// Serve one `ggs://` request over an explicit extensions home: a file of an installed
/// package, as the extension pages' iframes load them. URL shape
/// `/{id}-{version}/{path}`; the package segment and the path are both confined (no
/// `..`), the root is the home the caller resolved. An HTML page is composed with the
/// page bootstrap (`page_boot.js`) — the host environment joins the extension's own
/// document, never a copy of it.
pub fn serve_ext_asset_from(home: &Path, uri_path: &str) -> http::Response<Vec<u8>> {
    let requested = uri_path.trim_start_matches('/').to_owned();
    let decoded = percent_decode(&requested);
    let mut segments = decoded.split(['/', '\\']).filter(|s| !s.is_empty());
    let Some(package) = segments.next() else {
        return ext_not_found(&requested);
    };
    let rel: Vec<&str> = segments.collect();
    if package.contains("..") || rel.is_empty() || rel.iter().any(|segment| segment.contains(".."))
    {
        return ext_not_found(&requested);
    }
    let file = home.join(package).join(rel.join("/"));
    // A retired version's directory is gone while one of its pages lives on: another app
    // instance (or this one's boot pass) upgraded the package in this shared store, and a
    // page activated before the upgrade still composes its asset URLs out of the old
    // directory name. The package's current install answers for its retired one — the page
    // keeps its assets instead of breaking on every image — and an id nothing installed
    // stays a 404. The HTML composition applies to the fallback too, so a reloaded page
    // even re-points its own URLs at the living directory.
    let serving = match std::fs::read(&file) {
        Ok(bytes) => (file, bytes),
        Err(_) => {
            let Some(current) = current_install_dir(home, package) else {
                return ext_not_found(&requested);
            };
            let current_file = home.join(&current).join(rel.join("/"));
            match std::fs::read(&current_file) {
                Ok(bytes) => (current_file, bytes),
                Err(_) => return ext_not_found(&requested),
            }
        }
    };
    let (serving_path, bytes) = serving;
    let is_page = serving_path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm"));
    let content = if is_page {
        compose_page(&String::from_utf8_lossy(&bytes)).into_bytes()
    } else {
        bytes
    };
    http::Response::builder()
        .header(http::header::CONTENT_TYPE, content_type(&serving_path))
        // Content-Length is load-bearing on WebView2: a custom-scheme response without it
        // leaves the loader waiting for a stream end that never comes, and a multi-megabyte
        // bundle (claude-code's 5.4 MB webview/index.js) never finishes loading — the page
        // stays blank forever (a cold cache makes it deterministic; a warm one masked it).
        .header(http::header::CONTENT_LENGTH, content.len())
        // The pages are static per installed version; caching shaves the re-fetch of a
        // multi-megabyte bundle off every newly opened webview.
        .header(http::header::CACHE_CONTROL, "max-age=3600")
        // The webview pages load these as type=module scripts (and fetch() their data) -
        // module scripts are CORS-checked even same-site, so the response must carry the
        // allow-origin header or the browser blocks the load and the page mounts nothing
        // (the blank-webview failure mode).
        .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(content)
        .expect("a response with a valid header value")
}

pub fn ext_not_found(requested: &str) -> http::Response<Vec<u8>> {
    let body = format!("no such extension asset: {requested}").into_bytes();
    http::Response::builder()
        .status(http::StatusCode::NOT_FOUND)
        .header(
            http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )
        .header(http::header::CONTENT_LENGTH, body.len())
        // The 404 must carry the same allow-origin as a served file: the host's page-bundle
        // prewarm fetches `webview/index.js` of every activation cross-origin, a package
        // without one answers here, and a 404 without the header is unreadable cross-origin -
        // the fetch dies as a CORS violation instead of resolving, one console error per
        // installed package that ships no page bundle (the prewarm's own contract is that a
        // 404 is the silent "this package ships none" case).
        .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .expect("a response with a valid header value")
}

/// The directory name of the package's current install, when `requested` names a retired
/// version of an installed package (`{id}-{version}` matched against the manifests' real
/// ids, never by splitting the name: an id that is another's prefix must not steal its
/// requests — the longest matching id wins). None when nothing installed carries the id.
fn current_install_dir(home: &Path, requested: &str) -> Option<String> {
    let mut best: Option<(usize, String)> = None;
    for info in list_installed(home).ok()? {
        let prefix = format!("{}-", info.id);
        if requested
            .strip_prefix(&prefix)
            .is_some_and(|tail| !tail.is_empty())
            && best.as_ref().is_none_or(|(len, _)| info.id.len() > *len)
        {
            best = Some((info.id.len(), format!("{}-{}", info.id, info.version)));
        }
    }
    best.map(|(_, dir)| dir)
}

pub fn content_type(file: &Path) -> &'static str {
    let Some(ext) = file.extension().and_then(|e| e.to_str()) else {
        return "application/octet-stream";
    };
    match ext.to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Prepend the page bootstrap to the document: as the FIRST script of `<head>` when there is
/// one (a page's own top-level scripts call `acquireGgsApi()` the moment they parse — the
/// authored view shells load their bridge before anything else), else right after the
/// `<html>` tag (a script before the doctype would force quirks mode), else at the very start.
pub fn compose_page(html: &str) -> String {
    let boot = format!("<script>\n{}\n</script>\n", include_str!("page_boot.js"));
    for marker in ["<head>", "<HEAD>"] {
        if let Some(at) = html.find(marker) {
            let end = at + marker.len();
            return format!("{}{}{}", &html[..end], boot, &html[end..]);
        }
    }
    if let Some(at) = html.find("<html") {
        let end = html[at..]
            .find('>')
            .map(|offset| at + offset + 1)
            .unwrap_or(html.len());
        return format!("{}{}{}", &html[..end], boot, &html[end..]);
    }
    format!("{}{}", boot, html)
}
