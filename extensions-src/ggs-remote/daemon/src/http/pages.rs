//! The daemon's own pages (docs/ggs-remote-plan.md §7.3): `/` routing, the login page, the
//! window picker, the loopback pair page, the CA downloads and the embedded static files.

use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use std::collections::HashMap;
use std::sync::Arc;

use super::{base_path, redirect, session_of};
use crate::state::Daemon;

fn html(body: String) -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .expect("valid html response")
}

pub async fn root(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    let base = base_path(&headers);
    if session_of(&daemon, &headers).is_some() {
        redirect(&format!("{base}windows"))
    } else {
        redirect(&format!("{base}login"))
    }
}

pub async fn login(headers: HeaderMap) -> Response {
    html(crate::web::html_with_base("login.html", &base_path(&headers)).unwrap_or_default())
}

pub async fn windows(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    let base = base_path(&headers);
    if session_of(&daemon, &headers).is_none() {
        return redirect(&format!("{base}login"));
    }
    html(crate::web::html_with_base("picker.html", &base).unwrap_or_default())
}

/// The pair page (loopback only, §7.6 R19): opened with a one-time ticket from the tray or
/// the extension page; the page itself asks for the password before it shows anything.
pub async fn pair(
    State(daemon): State<Arc<Daemon>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let ok = query
        .get("t")
        .is_some_and(|t| daemon.tickets.lock().unwrap().check_pair(t));
    if !ok {
        return (StatusCode::FORBIDDEN, "This pairing link expired. Open it again from the GGS Remote tray menu or the Remote Access page.").into_response();
    }
    html(crate::web::html_with_base("pair.html", "/").unwrap_or_default())
}

/// A full-page notice (paused, no password yet) for any public route.
pub fn notice_page(_daemon: &Daemon, request: &Request, kind: &str) -> Response {
    let base = base_path(request.headers());
    if request.uri().path().starts_with("/api/") || request.uri().path() == "/ws" {
        return super::error(StatusCode::SERVICE_UNAVAILABLE, kind);
    }
    let body = crate::web::html_with_base("notice.html", &base)
        .unwrap_or_default()
        .replace("data-kind=\"\"", &format!("data-kind=\"{kind}\""));
    let mut response = html(body);
    *response.status_mut() = StatusCode::SERVICE_UNAVAILABLE;
    response
}

/// The page language (2026-10-12, the owner's direction: the pages follow the user's set
/// language): a tiny script every page loads before its modules — the app's
/// `~/.ggs/settings.json` when it spells one, an empty string (the browser's language,
/// which `i18n.js` then reads) when it does not. `no-store`, so a language switched in the
/// app takes effect on the page's next load.
pub async fn lang_js(State(daemon): State<Arc<Daemon>>) -> Response {
    let lang = daemon.paths.display_language().unwrap_or_default();
    Response::builder()
        .header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(format!("window.ggsLang = {lang:?};\n")))
        .expect("valid lang response")
}

pub async fn static_file(Path(file): Path<String>, headers: HeaderMap) -> Response {
    let Some(prepared) = crate::web::get(&file).filter(|_| !file.ends_with(".html")) else {
        return super::error(StatusCode::NOT_FOUND, "not found");
    };
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|tag| tag == prepared.etag)
    {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    let br = accepts_br(&headers);
    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, prepared.content_type)
        .header(header::ETAG, &prepared.etag)
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::VARY, "accept-encoding");
    let body = if br {
        builder = builder.header(header::CONTENT_ENCODING, "br");
        Body::from(prepared.br.clone())
    } else {
        Body::from(prepared.identity)
    };
    builder.body(body).expect("valid static response")
}

pub fn accepts_br(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|e| e.trim().starts_with("br")))
}

/// The PWA manifest (§10.2), relative to the base path so it works under a Hub prefix.
pub async fn manifest(headers: HeaderMap) -> Response {
    let base = base_path(&headers);
    let body = serde_json::json!({
        "name": "Git Graph Studio Remote",
        "short_name": "GGS Remote",
        "start_url": base,
        "scope": base,
        "display": "standalone",
        "background_color": "#1f1f1f",
        "theme_color": "#1f1f1f",
        "icons": [{ "src": format!("{base}static/icon.svg"), "sizes": "any", "type": "image/svg+xml" }]
    });
    (
        [(header::CONTENT_TYPE, "application/manifest+json")],
        body.to_string(),
    )
        .into_response()
}

pub async fn ca_crt(State(daemon): State<Arc<Daemon>>) -> Response {
    match crate::tls::ca_pem(&daemon.paths) {
        Some(pem) => Response::builder()
            .header(header::CONTENT_TYPE, "application/x-x509-ca-cert")
            .header(
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"ggs-remote-ca.crt\"",
            )
            .body(Body::from(pem))
            .expect("valid response"),
        None => super::error_page(StatusCode::NOT_FOUND, "no certificate has been issued"),
    }
}

pub async fn ca_mobileconfig(State(daemon): State<Arc<Daemon>>) -> Response {
    match crate::tls::mobileconfig(&daemon.paths) {
        Some(profile) => Response::builder()
            .header(header::CONTENT_TYPE, "application/x-apple-aspen-config")
            .header(
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"ggs-remote.mobileconfig\"",
            )
            .body(Body::from(profile))
            .expect("valid response"),
        None => super::error_page(StatusCode::NOT_FOUND, "no certificate has been issued"),
    }
}
