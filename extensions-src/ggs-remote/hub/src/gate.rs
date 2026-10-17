//! The silence gate (docs/ggs-remote-plan.md §20.5): unless the request addresses a
//! well-formed `/u/<uuid>/…` link (or is the PCs' own `/tunnel` WebSocket handshake), the
//! Hub answers nothing at all — the socket closes without one byte of HTTP, as if nothing
//! had this port open. A well-formed link keeps its §20.5 behavior (the PC's answers, or
//! the one byte-identical offline page while it is unknown or away); a malformed uuid
//! segment is not a link and drops like every other scan path. The operator's corners
//! (`/healthz`, `/metrics`) live on the configured `metrics_listen`, never the public
//! port.
//!
//! Mechanically the gate is a tower service whose error type is [`Silent`]: hyper writes a
//! response only after the service answers `Ok`, so on `Err` it closes the connection
//! having sent nothing — the "port not there" shape a scanner sees.

use std::convert::Infallible;
use std::future::{ready, Future, Ready};
use std::net::SocketAddr;
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::extract::ConnectInfo;
use axum::http::{header, HeaderMap, Method, Request, Uri, Version};
use axum::response::Response;
use axum::Router;
use tower_service::Service;

use crate::identity;

/// The "answer nothing" error — see the module docs. hyper's contract: no `Ok`, no bytes.
#[derive(Debug)]
pub struct Silent;

impl std::fmt::Display for Silent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "dropped at the gate: not a /u/<uuid>/ link request")
    }
}

impl std::error::Error for Silent {}

/// The per-connection service: the router behind the gate. Cloned per connection by
/// [`GateListener`], which stamps the peer address in so the `ConnectInfo` extractors the
/// handlers use keep working.
#[derive(Clone)]
pub struct Gate {
    router: Router,
    peer: Option<SocketAddr>,
}

/// The make service `serve` runs: one [`Gate`] per connection.
#[derive(Clone)]
pub struct GateListener {
    gate: Gate,
}

impl GateListener {
    pub fn new(router: Router) -> Self {
        GateListener {
            gate: Gate { router, peer: None },
        }
    }
}

impl Service<SocketAddr> for GateListener {
    type Response = Gate;
    type Error = Infallible;
    type Future = Ready<Result<Gate, Infallible>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, peer: SocketAddr) -> Self::Future {
        ready(Ok(Gate {
            router: self.gate.router.clone(),
            peer: Some(peer),
        }))
    }
}

impl<B> Service<Request<B>> for Gate
where
    B: axum::body::HttpBody<Data = bytes::Bytes> + Send + 'static,
    B::Error: Into<axum::BoxError>,
{
    type Response = Response;
    type Error = Silent;
    type Future = Pin<Box<dyn Future<Output = Result<Response, Silent>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, mut request: Request<B>) -> Self::Future {
        let allowed = answered(
            request.version(),
            request.method(),
            request.uri(),
            request.headers(),
        );
        if !allowed {
            if let Some(peer) = self.peer {
                crate::debug!(
                    "dropped {} {} from {peer}",
                    request.method(),
                    request.uri().path()
                );
            }
            return Box::pin(ready(Err(Silent)));
        }
        if let Some(peer) = self.peer {
            request.extensions_mut().insert(ConnectInfo(peer));
        }
        let mut router = self.router.clone();
        Box::pin(async move {
            // The state-applied router is infallible; `Silent` is the only error this
            // stack can produce.
            router.call(request).await.map_err(|never| match never {})
        })
    }
}

/// Does this request belong to the Hub's public surface (§20.5)?
///
/// `/u/<uuid>/…` — the uuid segment must be well-formed (`identity::valid_uuid`: the
/// lowercase dashed v8 shape every real link spells, no percent-tricks). Whether such a
/// uuid is unknown or merely away stays the router's business (the one identical offline
/// page). `/tunnel` passes only as a WebSocket handshake. Everything else — `/`,
/// `/healthz`, `/metrics`, `/favicon.ico`, `/u/not-a-uuid`, any scan path — drops.
///
/// The request-target must also be origin-form. An absolute-form target
/// (`GET http://example.com/… HTTP/1.1`) is how a client speaks to a PROXY — this Hub
/// forwards nothing but its own links' paths toward the PCs' tunnels and never fetches,
/// so a foreign site's URL is not this port's vocabulary, even when a real link path is
/// embedded inside it. The same silence answers the scan as every other probe: the port
/// is not an open proxy for unrelated websites.
pub fn answered(version: Version, method: &Method, uri: &Uri, headers: &HeaderMap) -> bool {
    if version <= Version::HTTP_11 && (uri.scheme().is_some() || uri.authority().is_some()) {
        return false;
    }
    if let Some(rest) = uri.path().strip_prefix("/u/") {
        let segment = rest.split('/').next().unwrap_or_default();
        return identity::valid_uuid(segment);
    }
    if uri.path() == "/tunnel" {
        return websocket_handshake(version, method, headers);
    }
    false
}

/// The handshake shape axum's `WebSocketUpgrade` extractor itself demands (HTTP/1.1 only —
/// the daemon's client is HTTP/1.1), so nothing that would only draw an extractor
/// rejection ever passes the gate.
fn websocket_handshake(version: Version, method: &Method, headers: &HeaderMap) -> bool {
    if version > Version::HTTP_11 || *method != Method::GET {
        return false;
    }
    header_contains(headers, header::CONNECTION, "upgrade")
        && header_eq(headers, header::UPGRADE, "websocket")
        && headers.contains_key(header::SEC_WEBSOCKET_KEY)
        && header_eq(headers, header::SEC_WEBSOCKET_VERSION, "13")
}

fn header_eq(headers: &HeaderMap, name: header::HeaderName, value: &str) -> bool {
    headers
        .get(&name)
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(value.as_bytes()))
}

fn header_contains(headers: &HeaderMap, name: header::HeaderName, value: &str) -> bool {
    headers
        .get(&name)
        .and_then(|v| std::str::from_utf8(v.as_bytes()).ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri(target: &str) -> Uri {
        target.parse().expect("a test request target")
    }

    fn ws_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONNECTION, "Upgrade".parse().unwrap());
        headers.insert(header::UPGRADE, "websocket".parse().unwrap());
        headers.insert(
            header::SEC_WEBSOCKET_KEY,
            "dGhlIHNhbXBsZSBub25jZQ==".parse().unwrap(),
        );
        headers.insert(header::SEC_WEBSOCKET_VERSION, "13".parse().unwrap());
        headers
    }

    #[test]
    fn the_link_namespace_passes_in_every_shape() {
        let none = HeaderMap::new();
        for path in [
            "/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3",
            "/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3/",
            "/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3/login",
            "/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3/a/deeper/path",
        ] {
            assert!(
                answered(Version::HTTP_11, &Method::GET, &uri(path), &none),
                "{path} must reach the router"
            );
        }
    }

    #[test]
    fn everything_else_drops() {
        let none = HeaderMap::new();
        for path in [
            "/",
            "/healthz",
            "/metrics",
            "/favicon.ico",
            "/wp-admin/setup.php",
            "/u",
            "/u/",
            "/u//x",
            // A malformed uuid segment is not a link — the gate judges the shape, so the
            // router's identical-offline-page business covers only unknown-but-well-formed.
            "/u/not-a-uuid",
            "/u/not-a-uuid/",
            "/u/not-a-uuid/login",
            // Wrong shape spellings: uppercase, a v4 version digit, percent-encoded.
            "/u/3F9C2A6E-8B1D-8C7A-9E45-2D6F0B8A71C3",
            "/u/3f9c2a6e-8b1d-4c7a-9e45-2d6f0b8a71c3",
            "/u/%33%66%39%63%32%61%36%65-8b1d-8c7a-9e45-2d6f0b8a71c3",
        ] {
            assert!(
                !answered(Version::HTTP_11, &Method::GET, &uri(path), &none),
                "{path} must drop"
            );
        }
    }

    /// The Hub is not a forward proxy (the relay may never be turned toward unrelated
    /// websites): an absolute-form request target — the open-proxy probe shape — drops
    /// with the same silence as every scan path, EVEN when the URL embeds a well-formed
    /// link path that would otherwise pass. Authority-form and asterisk-form targets are
    /// proxy speak too.
    #[test]
    fn proxy_form_targets_drop_even_when_they_spell_a_link() {
        let none = HeaderMap::new();
        for target in [
            "http://example.com/",
            "https://example.com/wp-admin/setup.php",
            "http://example.com:8080/",
            // The shape this guard exists for: a foreign site wrapped around a REAL link
            // path — the link inside must not make this port answer for that site.
            "http://evil.example/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3/api/session",
            "https://evil.example/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3/login",
            // Authority-form (the CONNECT-adjacent proxy spelling) and the asterisk.
            "example.com:8443",
            "*",
        ] {
            assert!(
                !answered(Version::HTTP_11, &Method::GET, &uri(target), &none),
                "{target} must drop — this port is not a proxy for unrelated sites"
            );
        }
        // POST probes of the same shapes drop identically.
        assert!(!answered(
            Version::HTTP_11,
            &Method::POST,
            &uri("http://evil.example/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3/api/login"),
            &none
        ));
        // A perfect WebSocket handshake is not a proxy excuse either: the PCs' leg speaks
        // origin-form, so an absolute-form `/tunnel` drops with the rest.
        assert!(!answered(
            Version::HTTP_11,
            &Method::GET,
            &uri("http://127.0.0.1:8443/tunnel"),
            &ws_headers()
        ));
        // The origin-form of the very same embedded link keeps passing — the drop is the
        // form, never the link.
        assert!(answered(
            Version::HTTP_11,
            &Method::GET,
            &uri("/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3/api/session"),
            &none
        ));
    }

    #[test]
    fn the_tunnel_passes_only_a_websocket_handshake() {
        let ws = ws_headers();
        assert!(answered(
            Version::HTTP_11,
            &Method::GET,
            &uri("/tunnel"),
            &ws
        ));
        // Plain probes of the PCs' leg: nothing.
        assert!(!answered(
            Version::HTTP_11,
            &Method::GET,
            &uri("/tunnel"),
            &HeaderMap::new()
        ));
        assert!(!answered(
            Version::HTTP_11,
            &Method::POST,
            &uri("/tunnel"),
            &ws
        ));
        let mut missing_key = ws.clone();
        missing_key.remove(header::SEC_WEBSOCKET_KEY);
        assert!(!answered(
            Version::HTTP_11,
            &Method::GET,
            &uri("/tunnel"),
            &missing_key
        ));
        let mut wrong_version = ws;
        wrong_version.insert(header::SEC_WEBSOCKET_VERSION, "8".parse().unwrap());
        assert!(!answered(
            Version::HTTP_11,
            &Method::GET,
            &uri("/tunnel"),
            &wrong_version
        ));
    }
}
