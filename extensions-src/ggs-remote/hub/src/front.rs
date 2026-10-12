//! The browser entry (docs/ggs-remote-plan.md §20.5): `/u/<uuid>/<rest>` — find the tunnel,
//! hand `/ws` to the bridge and everything else to the HTTP proxy; a uuid that is malformed,
//! unknown or merely offline all answer the same page, so nothing about which PCs exist
//! leaks. The port answers nothing else — the [`crate::gate`] drops every non-link request
//! without a byte. `/healthz` and `/metrics` are the operator's corners, served on the
//! configured metrics listener.

use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{ConnectInfo, FromRequest, Path, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use crate::state::Hub;
use crate::{http_proxy, identity, ws_bridge};

pub async fn entry(
    State(hub): State<Arc<Hub>>,
    Path((uuid, rest)): Path<(String, String)>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: axum::extract::Request,
) -> Response {
    serve(hub, uuid, rest, peer, request).await
}

/// `/u/<uuid>` and `/u/<uuid>/` — the link shapes a browser actually opens: the canonical
/// `publicBase` carries the trailing slash, and a hand-stripped one does not. Both are the
/// same serving with an empty rest, which the PC answers like its own `/` (a redirect to
/// its login or window page, honouring the base path). Neither may fall out of the router:
/// the canonical link once answered a bare 404, the stripped one a 500 from this handler's
/// two-parameter extractor running on a one-parameter route.
pub async fn entry_root(
    State(hub): State<Arc<Hub>>,
    Path(uuid): Path<String>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: axum::extract::Request,
) -> Response {
    serve(hub, uuid, String::new(), peer, request).await
}

async fn serve(
    hub: Arc<Hub>,
    uuid: String,
    rest: String,
    peer: SocketAddr,
    request: axum::extract::Request,
) -> Response {
    let peer_ip = http_proxy::peer_ip(&hub, peer.ip(), &request);
    if !identity::valid_uuid(&uuid) || hub.is_banned(peer_ip) {
        return offline_page();
    }
    let Some(tunnel) = hub.tunnel(&uuid) else {
        if hub.offline_probe(peer_ip) {
            crate::debug!("offline link {uuid} probed from {peer_ip}");
        }
        return offline_page();
    };
    // A blocklisted PC answers exactly like an absent one — nothing about the operator's
    // actions leaks to the browser (§20.6).
    if hub.blocklist.blocked(&uuid) {
        return offline_page();
    }
    if !hub.request_allowed(peer_ip) {
        return http_proxy::too_many_requests();
    }
    if !hub.admit_visitor(&uuid, peer_ip) {
        hub.counters
            .visitor_refused
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        return http_proxy::too_many_viewers();
    }
    let base_path = format!("/u/{uuid}/");
    if rest == "ws" && request.method() == Method::GET {
        let headers = request.headers().clone();
        return match WebSocketUpgrade::from_request(request, &()).await {
            Ok(upgrade) => {
                ws_bridge::bridge(hub, tunnel, upgrade, peer_ip, base_path, headers).await
            }
            Err(_) => StatusCode::BAD_REQUEST.into_response(),
        };
    }
    http_proxy::proxy(hub, tunnel, uuid, rest, base_path, peer_ip, request).await
}

/// The one answer for a well-formed link whose PC is unknown or away (§20.5): a page under
/// 10 KB that retries itself, identical in both cases. (A malformed uuid never gets this
/// far — the gate drops it; this handler's own `valid_uuid` check stays as defense in
/// depth for the bare-router stacks the daemon suite runs.)
pub fn offline_page() -> Response {
    let html = include_str!("../web/offline.html");
    // No `refresh` header: the page carries its own meta-refresh fallback, which its script
    // replaces with a soft poll (no full-reload flash) at the same 15 s cadence.
    Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(html))
        .expect("a static page")
}

/// Liveness, on the metrics listener only (§20.5) — the public port never answers it.
pub async fn healthz() -> Response {
    StatusCode::OK.into_response()
}

pub async fn metrics(State(hub): State<Arc<Hub>>) -> Response {
    (
        [(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        hub.metrics_text(),
    )
        .into_response()
}

/// Every header the daemon's checks or its asset serving may read (§20.5): the Hub forwards
/// these and nothing else — its own additions (`x-ggs-base-path`, `x-forwarded-*`) included.
pub const FORWARDED_HEADERS: &[&str] = &[
    "host",
    "cookie",
    "origin",
    "user-agent",
    "content-type",
    "accept",
    "accept-language",
    "range",
    "if-range",
    "if-none-match",
    "if-modified-since",
    "referer",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
];

pub fn forward_headers(headers: &HeaderMap) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    for name in FORWARDED_HEADERS {
        if let Some(value) = headers.get(*name).and_then(|v| v.to_str().ok()) {
            out.insert((*name).to_owned(), value.to_owned());
        }
    }
    out
}

/// The Hub's own request extras: the path prefix the browser sees and the client address
/// behind the proxy chain, in the forms the daemon's `client_ip` / `base_path` read, plus
/// the scheme the browser spoke (`x-forwarded-proto`) — the daemon's session cookie marks
/// `Secure` only for https, or a plain-HTTP browser silently drops it and no login ever
/// holds (§7.6).
pub fn hub_extras(
    config: &crate::config::Config,
    base_path: &str,
    ip: IpAddr,
    headers: &HeaderMap,
) -> Vec<(String, String)> {
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    // A front proxy's word for the scheme wins when trusted (Caddy ends TLS in front of a
    // `tls = "none"` Hub); otherwise this Hub's own listener says it. Browsers cannot
    // smuggle the header through — `FORWARDED_HEADERS` never forwards it.
    let proto = if config.trust_proxy {
        headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    } else {
        None
    }
    .unwrap_or_else(|| {
        if config.tls.mode == crate::config::TlsMode::None {
            "http".to_owned()
        } else {
            "https".to_owned()
        }
    });
    vec![
        ("x-ggs-base-path".into(), base_path.to_owned()),
        ("x-forwarded-for".into(), ip.to_string()),
        ("x-forwarded-host".into(), host.to_owned()),
        ("x-forwarded-proto".into(), proto),
    ]
}
