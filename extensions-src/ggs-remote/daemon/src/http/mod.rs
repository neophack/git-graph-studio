//! The HTTP surface (docs/ggs-remote-plan.md §7.3): the public listener (login, window picker,
//! the remote workbench's assets, `/ws`) and the loopback-only listener (the Relay link, the
//! pair page, the admin API). Shared request helpers live here: the session cookie, the
//! client address behind a trusted proxy, the Origin check and the proxied base path.

pub mod admin;
pub mod api;
pub mod assets;
pub mod pages;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::Router;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use crate::session::{hash_token, Session};
use crate::state::Daemon;

pub const COOKIE: &str = "ggsr";
/// The header a Hub tunnel stamps on every request it forwards (§20.5): the path prefix the
/// browser sees, e.g. `/u/<uuid>/`. Absent on the LAN, where the base is `/`.
pub const BASE_HEADER: &str = "x-ggs-base-path";

/// The one bucket every tunnel-carried client shares (audit F6, 2026-10-13): a loopback
/// address nothing real answers from, so it never collides with a LAN peer.
pub const TUNNEL_BUCKET: std::net::IpAddr =
    std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 127));

/// The public router: what a phone reaches.
pub fn public_router(daemon: Arc<Daemon>) -> Router {
    Router::new()
        .route("/", get(pages::root))
        .route("/login", get(pages::login))
        .route("/windows", get(pages::windows))
        .route("/lang.js", get(pages::lang_js))
        .route("/static/{file}", get(pages::static_file))
        .route("/manifest.webmanifest", get(pages::manifest))
        .route("/sw.js", get(assets::service_worker))
        .route("/ca.crt", get(pages::ca_crt))
        .route("/ca.mobileconfig", get(pages::ca_mobileconfig))
        .route("/api/login", post(api::login))
        .route("/api/logout", post(api::logout))
        .route("/api/session", get(api::session))
        .route("/api/password", post(api::change_password))
        .route("/api/devices", get(api::devices))
        .route("/api/devices/{id}", delete(api::remove_device))
        .route("/api/download-ticket", post(api::download_ticket))
        .route("/w/{inst}/v/{ver}/{*path}", get(assets::app_asset))
        .route("/w/{inst}/ggs/{tok}/{*path}", get(assets::ext_asset))
        .route("/w/{inst}/download", get(assets::download))
        .route("/ws", get(crate::ws::ws_handler))
        .layer(axum::extract::DefaultBodyLimit::max(64 * 1024))
        .layer(axum::middleware::from_fn_with_state(daemon.clone(), guard))
        .layer(axum::middleware::from_fn(security_headers))
        .with_state(daemon)
}

/// The loopback router: the Relay link, the pair page and the admin API.
pub fn loopback_router(daemon: Arc<Daemon>) -> Router {
    Router::new()
        .route("/relay", get(crate::relay_link::relay_handler))
        .route("/pair", get(pages::pair))
        .route("/pair/unlock", post(api::pair_unlock))
        .route("/pair/state", get(api::pair_state))
        .route("/pair/password", post(api::pair_password))
        .route("/pair/hub/connect", post(api::pair_hub_connect))
        .route("/pair/hub/disconnect", post(api::pair_hub_disconnect))
        .route("/pair/qr", get(api::pair_qr))
        .route("/lang.js", get(pages::lang_js))
        .route("/static/{file}", get(pages::static_file))
        .route("/admin/status", get(admin::status))
        .route("/admin/password", post(admin::password))
        .route("/admin/pause", post(admin::pause))
        .route("/admin/resume", post(admin::resume))
        .route("/admin/devices", get(admin::devices))
        .route("/admin/devices/{id}", delete(admin::remove_device))
        .route("/admin/signout-all", post(admin::signout_all))
        .route("/admin/qr", get(admin::qr))
        .route("/admin/config", put(admin::config))
        .route("/admin/pair-ticket", post(admin::pair_ticket))
        .route("/admin/unlock", post(admin::unlock))
        .route("/admin/shutdown", post(admin::shutdown))
        .route("/admin/hub/status", get(admin::hub_status))
        .route("/admin/hub/connect", post(admin::hub_connect))
        .route("/admin/hub/disconnect", post(admin::hub_disconnect))
        .route("/admin/hub/relink", post(admin::hub_relink))
        .route("/admin/hub/export-key", post(admin::hub_export_key))
        .route("/admin/hub/import-key", post(admin::hub_import_key))
        .route("/admin/spawn", post(admin::spawn))
        .layer(axum::extract::DefaultBodyLimit::max(64 * 1024))
        .layer(axum::middleware::from_fn(security_headers))
        .with_state(daemon)
}

/// Pause and password-not-set gates on the public listener (§7.6: until a password exists,
/// the public port only says "set it on the PC").
async fn guard(
    axum::extract::State(daemon): axum::extract::State<Arc<Daemon>>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path().to_owned();
    let exempt = path.starts_with("/static/")
        || path == "/ca.crt"
        || path == "/ca.mobileconfig"
        || path == "/manifest.webmanifest"
        || path == "/lang.js";
    if !exempt {
        if daemon.config.lock().unwrap().paused {
            return pages::notice_page(&daemon, &request, "paused");
        }
        if !daemon.auth.is_set() {
            return pages::notice_page(&daemon, &request, "no-password");
        }
    }
    next.run(request).await
}

/// The security response headers (§7.3). The daemon's own pages get the strict CSP; the
/// workbench's assets carry what the desktop build needs (its CSP is `null` in
/// tauri.conf.json), so they get the frame and sniffing protections only.
async fn security_headers(request: Request, next: Next) -> Response {
    let workbench = request.uri().path().starts_with("/w/");
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    if !workbench && !headers.contains_key("content-security-policy") {
        headers.insert(
            "content-security-policy",
            HeaderValue::from_static(
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
                 connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
            ),
        );
        headers.insert(
            "cross-origin-opener-policy",
            HeaderValue::from_static("same-origin"),
        );
    }
    if workbench && !headers.contains_key("x-frame-options") {
        headers.insert("x-frame-options", HeaderValue::from_static("SAMEORIGIN"));
    }
    response
}

pub fn cookie_token(headers: &HeaderMap) -> Option<String> {
    for value in headers.get_all(header::COOKIE) {
        let Ok(text) = value.to_str() else { continue };
        for part in text.split(';') {
            if let Some((name, value)) = part.trim().split_once('=') {
                if name == COOKIE {
                    return Some(value.to_owned());
                }
            }
        }
    }
    None
}

/// The valid session the request's cookie names.
pub fn session_of(daemon: &Daemon, headers: &HeaderMap) -> Option<Session> {
    daemon.session_for(&cookie_token(headers)?)
}

pub fn token_hash_of(headers: &HeaderMap) -> Option<String> {
    hash_token(&cookie_token(headers)?)
}

/// The client address: the peer, or — behind a trusted local proxy — the first
/// `X-Forwarded-For` hop (§7.4).
pub fn client_ip(daemon: &Daemon, peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
    // Through the tunnel the WHOLE header set is the Hub's (audit F6): it stamps a fresh
    // address per attempt, so any per-IP accounting on the forwarded value is mintable.
    // Everything the tunnel carries lands in one shared bucket — the global limiter
    // still bounds it, and the Hub's own logs hold the real addresses.
    if headers.contains_key(BASE_HEADER) {
        return TUNNEL_BUCKET;
    }
    let trust = peer.ip().is_loopback() && daemon.config.lock().unwrap().trust_proxy;
    if trust {
        if let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            // The RIGHTMOST hop is the one the immediate trusted proxy appended; the
            // leftmost is whoever forged the header before it (audit 2026-10-13).
            .and_then(|v| v.rsplit(',').next())
            .and_then(|v| v.trim().parse().ok())
        {
            return ip;
        }
    }
    peer.ip()
}

/// The base path the browser sees (`/` on the LAN; the Hub's `/u/<uuid>/`), always with a
/// trailing slash.
pub fn base_path(headers: &HeaderMap) -> String {
    let base = headers
        .get(BASE_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("/");
    let valid = base.starts_with('/')
        && base
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/-_".contains(c));
    if !valid {
        return "/".into();
    }
    if base.ends_with('/') {
        base.to_owned()
    } else {
        format!("{base}/")
    }
}

/// Cross-site WebSocket hijacking guard (§16): the Origin must name this very host.
pub fn origin_ok(daemon: &Daemon, peer: SocketAddr, headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let origin_host = origin
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(origin);
    let forwarded = peer.ip().is_loopback() && daemon.config.lock().unwrap().trust_proxy;
    let host = if forwarded {
        headers
            .get("x-forwarded-host")
            .or_else(|| headers.get(header::HOST))
    } else {
        headers.get(header::HOST)
    };
    host.and_then(|v| v.to_str().ok())
        .is_some_and(|host| host.eq_ignore_ascii_case(origin_host))
}

/// The same guard for a Hub-tunneled session (§20.5): the request arrived on this daemon's
/// own tunnel carrying the browser's headers and the `x-ggs-base-path` mark, so the Host
/// header is the browser's own and comparing against it directly is the check.
pub fn origin_ok_proxied(daemon: &Daemon, peer: SocketAddr, headers: &HeaderMap) -> bool {
    if peer.ip().is_loopback() && headers.contains_key(BASE_HEADER) {
        let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
            return false;
        };
        let origin_host = origin
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(origin);
        return headers
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|host| host.eq_ignore_ascii_case(origin_host));
    }
    origin_ok(daemon, peer, headers)
}

/// State-changing API requests must be JSON (blocks plain form posts, §16) and same-site.
pub fn json_request_ok(headers: &HeaderMap) -> bool {
    let json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/json"));
    let site_ok = headers
        .get("sec-fetch-site")
        .and_then(|v| v.to_str().ok())
        .is_none_or(|v| v == "same-origin" || v == "none");
    json && site_ok
}

pub fn json_response(status: StatusCode, value: serde_json::Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        value.to_string(),
    )
        .into_response()
}

pub fn error(status: StatusCode, message: &str) -> Response {
    json_response(status, serde_json::json!({ "error": message }))
}

pub fn redirect(location: &str) -> Response {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, location)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::empty())
        .expect("valid redirect")
}

/// Whether the request is a browser navigation for a document (the workbench shell's own
/// load) rather than a subresource the loaded page pulls: `Sec-Fetch-Dest` says so on every
/// current browser, and an `Accept` led by `text/html` is the pre-Sec-Fetch fallback.
pub fn wants_document(headers: &HeaderMap) -> bool {
    if headers
        .get("sec-fetch-dest")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == "document")
    {
        return true;
    }
    headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim_start().starts_with("text/html"))
}

/// A navigation's error page (2026-10-16, the owner's direction: Safari 打开 remote 直接
/// 下载了): a bare status with an empty body and no Content-Type is saved as a zero-byte
/// file named after the URL — Safari downloaded `remote.html` where Chromium draws its own
/// error page — so every answer a navigation can reach carries `text/html` and a line of
/// prose. Where the person's real next step is another page (the login, the picker) the
/// answer is a redirect instead; this is what the errors with no next page land on.
pub fn error_page(status: StatusCode, message: &str) -> Response {
    let title = format!(
        "{} {}",
        status.as_u16(),
        status.canonical_reason().unwrap_or("error")
    );
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title}</title>\
         <style>body{{font:14px/1.6 system-ui;padding:2rem;background:#1f1f1f;color:#eee}}\
         h1{{font-size:1.1rem;margin:0 0 .5rem}}p{{margin:0}}</style>\
         <h1>GGS Remote</h1><p>{message}</p>"
    );
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .expect("valid error page")
}

/// Normalize a request path for the asset routes (§16 path traversal): reject `..`, absolute
/// paths, backslashes and NUL.
pub fn safe_rel_path(path: &str) -> Option<String> {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return None;
    }
    if path
        .split('/')
        .any(|seg| seg == ".." || seg == "." || seg.is_empty())
    {
        return None;
    }
    Some(path.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal() {
        assert_eq!(safe_rel_path("assets/a.js").as_deref(), Some("assets/a.js"));
        for bad in [
            "../x",
            "a/../b",
            "/etc/passwd",
            "a\\b",
            "a//b",
            "a\0",
            "",
            "./a",
        ] {
            assert!(safe_rel_path(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn base_path_is_validated() {
        let mut headers = HeaderMap::new();
        assert_eq!(base_path(&headers), "/");
        headers.insert(
            BASE_HEADER,
            HeaderValue::from_static("/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3"),
        );
        assert_eq!(
            base_path(&headers),
            "/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3/"
        );
        headers.insert(BASE_HEADER, HeaderValue::from_static("/u/<script>"));
        assert_eq!(base_path(&headers), "/");
    }

    #[test]
    fn cookie_parsing() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("a=1; ggsr=tok123; b=2"),
        );
        assert_eq!(cookie_token(&headers).as_deref(), Some("tok123"));
    }

    #[test]
    fn json_guard() {
        let mut headers = HeaderMap::new();
        assert!(!json_request_ok(&headers));
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        assert!(json_request_ok(&headers));
        headers.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
        assert!(!json_request_ok(&headers));
    }
}
