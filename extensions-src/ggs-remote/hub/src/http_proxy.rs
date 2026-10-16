//! The HTTP half of `/u/<uuid>/…` (docs/ggs-remote-plan.md §20.4, §20.5): one request
//! becomes one tunnel session — the `HTTP_REQ` head (path stripped of the prefix, the
//! forwarded headers, the client IP, the base path), the body as RAW chunks, the answer
//! streamed back as `HTTP_RES` + chunks. The workbench's immutable assets (identical on
//! every PC) are served from a shared cache without waking the tunnel (§20.6).

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures_util::Stream;
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::mpsc;

use crate::audit::mask_path;
use crate::frame::{flag, ty, Frame};
use crate::front::{forward_headers, hub_extras};
use crate::msg::{ConnClose, HttpReq, HttpRes};
use crate::state::{Hub, ToConn, Tunnel};

/// Request bodies are small JSON — file uploads cross as WS `UPLOAD` frames (§7.3); a bigger
/// HTTP body is refused rather than buffered.
const MAX_REQUEST_BODY: usize = 1 << 20;
/// The largest asset the shared cache keeps.
const CACHE_ENTRY_CAP: usize = 2 << 20;
/// The PC may accept a request and never answer it (a hung or hostile daemon): the browser
/// hears a 504 instead of a request that hangs forever — and the session slot frees either
/// way (the `SessionSlot` guard below).
const HEAD_TIMEOUT: Duration = Duration::from_secs(30);

/// The shared cache's key (§20.6): only the workbench's app-asset shape `/w/<inst>/v/<ver>/…`
/// is keyed, with the per-window instance segment normalized away — every PC ships the same
/// bytes for the same version and hashed name whatever its window ids are (`ggs-<pid>`), and
/// a key that kept them never matched across PCs. Only immutable-marked answers are ever
/// stored (see below), so nothing per-PC — API answers, package files, downloads — can land
/// under it.
fn cache_key_of(
    method: &Method,
    link: &str,
    rest: &str,
    query: &str,
    conditional: bool,
) -> Option<String> {
    if method != Method::GET || !query.is_empty() || conditional {
        return None;
    }
    let after_inst = rest.strip_prefix("w/")?.splitn(3, '/');
    let mut parts = after_inst;
    let _inst = parts.next()?; // per-window (`ggs-<pid>`): not part of the key
    if parts.next()? != "v" {
        return None; // `/w/<inst>/ggs/<tok>/…` package files ride their own tunnel
    }
    let tail = parts.next()?; // the tail is a single segment: the path wildcard
                              // The PC's link id is part of the key (audit H-2, 2026-10-13): cross-PC dedup let
                              // any keyholder's daemon poison an entry that every other PC's browsers then ran
                              // as same-origin script. Losing that dedup costs some bytes; the isolation is the
                              // point of a relay.
    Some(format!("{link}/w/_/v/{tail}"))
}

pub fn peer_ip(hub: &Hub, peer: IpAddr, request: &Request) -> IpAddr {
    let trusted = (hub.config.trust_proxy && peer.is_loopback())
        || hub
            .config
            .trusted_proxies
            .iter()
            .filter_map(|cidr| cidr.parse::<ipnet::IpNet>().ok())
            .any(|net| net.contains(&peer));
    if trusted {
        if let Some(ip) = request
            .headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            // The RIGHTMOST hop is the one the immediate trusted proxy appended; the
            // leftmost is a client-forged value that survived the append (audit H-1).
            .and_then(|v| v.rsplit(',').next())
            .and_then(|v| v.trim().parse().ok())
        {
            return ip;
        }
    }
    peer
}

pub async fn proxy(
    hub: Arc<Hub>,
    tunnel: Arc<Tunnel>,
    uuid: String,
    rest: String,
    base_path: String,
    ip: IpAddr,
    request: Request,
) -> Response {
    hub.counters.http_requests.fetch_add(1, Ordering::Relaxed);
    let method = request.method().clone();
    // `rest` is the axum wildcard capture and never carries a leading slash, so the login
    // path matches it exactly — `ends_with("/api/login")` never matched "api/login" (the
    // pattern is a character longer) and this limiter never ran at all.
    if method == Method::POST && rest == "api/login" && !hub.login_entry(ip, &uuid) {
        return too_many_requests();
    }
    let query = request.uri().query().unwrap_or_default().to_owned();
    let headers = request.headers().clone();
    let conditional = headers.contains_key(header::IF_NONE_MATCH)
        || headers.contains_key(header::IF_MODIFIED_SINCE)
        || headers.contains_key(header::RANGE);
    let cache_key = cache_key_of(&method, &uuid, &rest, &query, conditional);

    if let Some(key) = &cache_key {
        if let Some(cached) = hub.cache_get(key) {
            crate::debug!("cache hit for {key}");
            return cached.into_response();
        }
    }

    let body = match axum::body::to_bytes(request.into_body(), MAX_REQUEST_BODY).await {
        Ok(body) => body,
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
    };

    let session = hub.alloc_session();
    if tunnel.sessions() >= hub.config.sessions_per_tunnel {
        return too_many_requests();
    }
    let (conn_tx, mut conn_rx) = mpsc::unbounded_channel::<ToConn>();
    tunnel.conns.lock().unwrap().insert(session, conn_tx);
    // The slot owns the session entry from here: a request whose browser vanishes before
    // the PC's answer head arrives is cancelled mid-await, and before this guard nothing
    // revisited its entry — a tunnel's ceiling slowly filled with ghosts until every
    // request 429'd (an 8-slot tunnel bricked by eight dropped connections).
    let mut slot = SessionSlot {
        tunnel: tunnel.clone(),
        session,
        armed: true,
    };

    let mut head = HttpReq {
        method: method.as_str().to_owned(),
        path: format!("/{rest}"),
        query,
        headers: forward_headers(&headers),
        ip: ip.to_string(),
        base_path: base_path.clone(),
    };
    for (name, value) in hub_extras(&hub.config, &base_path, ip, &headers) {
        head.headers.insert(name, value);
    }
    let mut frames = vec![Frame::msgpack(ty::HTTP_REQ, &head).with_session(session)];
    if body.is_empty() {
        frames.push(Frame::raw(ty::HTTP_REQ, session, Vec::new()).with_flags(flag::FIN));
    } else {
        frames.extend(body_frames(session, &body));
        if let Some(last) = frames.last_mut() {
            last.flags |= flag::FIN;
        }
    }
    for frame in &frames {
        hub.counters
            .bytes_down
            .fetch_add(frame.encode().len() as u64, Ordering::Relaxed);
    }
    for frame in frames {
        if !tunnel.send(&frame) {
            return gone_offline();
        }
    }

    // The answer's head first; its body streams after it. A PC that never sends one runs
    // out the clock — the slot frees with the return either way.
    let http = match tokio::time::timeout(HEAD_TIMEOUT, wait_head(&mut conn_rx)).await {
        Ok(Some(head)) => head,
        Ok(None) => return gone_offline(),
        Err(_) => return gateway_timeout(),
    };
    // The streamed body owns the session from here — its drop is the cleanup.
    slot.disarm();
    let status = StatusCode::from_u16(http.status).unwrap_or(StatusCode::BAD_GATEWAY);
    hub.audit.log(
        "http",
        &[
            ("uuid", serde_json::json!(uuid)),
            ("ip", serde_json::json!(ip.to_string())),
            ("method", serde_json::json!(method.as_str())),
            ("path", serde_json::json!(mask_path(&format!("/{rest}")))),
            ("status", serde_json::json!(http.status)),
            (
                "content_type",
                serde_json::json!(header_of(&http.headers, "content-type").unwrap_or_default()),
            ),
            (
                "content_length",
                serde_json::json!(header_of(&http.headers, "content-length")),
            ),
        ],
    );
    let mut builder = Response::builder().status(status);
    for (name, value) in &http.headers {
        // Reframing is ours: the framing headers would clash with the streamed body —
        // hyper writes content-length itself (audit L-1, 2026-10-13). content-encoding
        // STAYS: the daemon's brotli-marked answers cross byte-identical, and without
        // the header the browser cannot decode them.
        if name.eq_ignore_ascii_case("transfer-encoding")
            || name.eq_ignore_ascii_case("connection")
            || name.eq_ignore_ascii_case("keep-alive")
            || name.eq_ignore_ascii_case("content-length")
        {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            if builder
                .headers_ref()
                .is_some_and(|set| set.contains_key(&name))
            {
                continue; // a duplicated header is the first one's
            }
            builder = builder.header(name, value);
        }
    }

    // Decided on the PC's own answer head (`http.headers`), not on the response builder:
    // the builder's framing headers are the Hub's to write, and the live response no
    // longer carries the PC's content-length at all (the header-hygiene drop).
    let cacheable = cache_key.is_some()
        && status == StatusCode::OK
        && http
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("cache-control"))
            .and_then(|(_, value)| value.parse::<String>().ok())
            .is_some_and(|v| v.contains("immutable"))
        && http
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.parse::<usize>().ok())
            .is_some_and(|len| len <= CACHE_ENTRY_CAP);

    let body = ProxyBody {
        rx: Some(conn_rx),
        buffered: Vec::new(),
        cache: cacheable.then(|| (hub.clone(), cache_key.clone().unwrap_or_default())),
        store: http,
        tunnel: tunnel.clone(),
        session,
        done: false,
        idle: Some(Box::pin(tokio::time::sleep(BODY_IDLE))),
    };
    builder
        .body(Body::from_stream(body))
        .unwrap_or_else(|_| bad_gateway())
}

/// One case-insensitive header out of a `HttpRes` head.
fn header_of(headers: &[(String, String)], name: &str) -> Option<String> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
}

/// Chunk `MAX_PAYLOAD` at a time; the caller marks the last FIN.
fn body_frames(session: u32, body: &[u8]) -> Vec<Frame> {
    body.chunks(crate::frame::MAX_PAYLOAD)
        .map(|chunk| Frame::raw(ty::HTTP_REQ, session, chunk.to_vec()))
        .collect()
}

async fn wait_head(rx: &mut mpsc::UnboundedReceiver<ToConn>) -> Option<HttpRes> {
    loop {
        match rx.recv().await {
            Some(ToConn::Bytes(bytes)) => {
                let Some(frame) =
                    Frame::decode_all(&bytes).and_then(|frames| frames.into_iter().next())
                else {
                    continue;
                };
                if frame.ty == ty::HTTP_RES {
                    return frame.decode_msgpack::<HttpRes>();
                }
            }
            Some(ToConn::Close { .. }) | None => return None,
        }
    }
}

/// Ownership of one session slot on a tunnel, from the request's entry into the table
/// until the PC's answer head arrives: freed on drop — removed from the table, closed
/// toward the PC — however `proxy` leaves, cancellation included. Before it, an abandoned
/// request's entry was never revisited (a failed `to_conn` send did not remove it either),
/// and the ghosts piled up against `sessions_per_tunnel` until the tunnel refused
/// everything. Once the head lands the streamed body takes the session over (`disarm`) —
/// its own drop is the cleanup then.
struct SessionSlot {
    tunnel: Arc<Tunnel>,
    session: u32,
    armed: bool,
}

impl SessionSlot {
    /// Hand the session to the streamed answer body: its drop frees the slot from here on.
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for SessionSlot {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.tunnel.conns.lock().unwrap().remove(&self.session);
        let _ = self.tunnel.send(&Frame::msgpack(
            ty::CONN_CLOSE,
            &ConnClose {
                session: self.session,
                code: 1000,
                reason: String::new(),
            },
        ));
    }
}

/// The streamed answer body: decodes the PC's RAW chunks, tees into the shared cache when the
/// head said the asset is immutable, and frees the tunnel session when it ends (or drops).
struct ProxyBody {
    rx: Option<mpsc::UnboundedReceiver<ToConn>>,
    buffered: Vec<u8>,
    cache: Option<(Arc<Hub>, String)>,
    store: HttpRes,
    tunnel: Arc<Tunnel>,
    session: u32,
    done: bool,
    /// The idle-gap deadline (audit M-3, 2026-10-13): the 30 s head timeout bounded only
    /// the answer's head — a body that never trickles another byte held one of the eight
    /// session slots and the browser connection forever. Thirty seconds between chunks,
    /// renewed by every chunk, ends the response instead.
    idle: Option<std::pin::Pin<Box<tokio::time::Sleep>>>,
}

/// The largest gap between body chunks before the response is terminated.
const BODY_IDLE: std::time::Duration = std::time::Duration::from_secs(30);

impl ProxyBody {
    /// A buffer that reached the head's content-length is the whole asset: finish the
    /// store. The FIN branch below is the ordinary path, but a client that disconnects the
    /// moment its bytes arrive (hyper stops polling once content-length is written) must
    /// not lose the cache entry.
    fn store_if_complete(&mut self) {
        let Some((hub, key)) = self.cache.clone() else {
            return;
        };
        let complete = self.store.headers.iter().any(|(name, value)| {
            name.eq_ignore_ascii_case("content-length") && value == &self.buffered.len().to_string()
        });
        if complete {
            hub.cache_store(&key, &self.store, std::mem::take(&mut self.buffered));
        }
    }

    fn cleanup(&self) {
        self.tunnel.conns.lock().unwrap().remove(&self.session);
        let _ = self.tunnel.send(&Frame::msgpack(
            ty::CONN_CLOSE,
            &ConnClose {
                session: self.session,
                code: 1000,
                reason: String::new(),
            },
        ));
    }
}

impl Drop for ProxyBody {
    fn drop(&mut self) {
        self.store_if_complete();
        self.cleanup();
    }
}

impl Stream for ProxyBody {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if this.done {
            return Poll::Ready(None);
        }
        let Some(rx) = this.rx.as_mut() else {
            return Poll::Ready(None);
        };
        if let Some(deadline) = this.idle.as_mut() {
            if std::pin::pin!(deadline.as_mut()).poll(cx).is_ready() {
                this.done = true;
                crate::warn!("body idle timeout on session {}", this.session);
                return Poll::Ready(None);
            }
        }
        match rx.poll_recv(cx) {
            Poll::Ready(Some(ToConn::Bytes(bytes))) => {
                let Some(frames) = Frame::decode_all(&bytes) else {
                    return Poll::Ready(Some(Ok(Bytes::new())));
                };
                let mut out = Vec::new();
                let mut fin = false;
                for frame in frames {
                    fin |= frame.fin();
                    out.extend_from_slice(&frame.payload);
                }
                if let Some((hub, key)) = &this.cache {
                    if this.buffered.len() + out.len() <= CACHE_ENTRY_CAP {
                        this.buffered.extend_from_slice(&out);
                        if fin {
                            hub.cache_store(key, &this.store, std::mem::take(&mut this.buffered));
                        }
                    }
                }
                if fin {
                    this.done = true;
                }
                if let Some(sleep) = this.idle.as_mut() {
                    sleep
                        .as_mut()
                        .reset(tokio::time::Instant::now() + BODY_IDLE);
                }
                Poll::Ready(Some(Ok(Bytes::from(out))))
            }
            Poll::Ready(Some(ToConn::Close { .. })) | Poll::Ready(None) => {
                this.done = true;
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

pub fn too_many_requests() -> Response {
    error_page(
        StatusCode::TOO_MANY_REQUESTS,
        "too many requests — wait a minute",
    )
}

/// The daily distinct-viewer ceiling (§20.6): a personal link has a handful of viewers;
/// this answer means the link is being shared like a public site.
pub fn too_many_viewers() -> Response {
    error_page(
        StatusCode::TOO_MANY_REQUESTS,
        "this link has too many viewers today",
    )
}

/// A cached asset becomes the response it was cached as.
impl IntoResponse for crate::cache::Entry {
    fn into_response(self) -> Response {
        let mut builder = Response::builder()
            .status(StatusCode::from_u16(self.head.status).unwrap_or(StatusCode::OK));
        let mut seen = std::collections::HashSet::new();
        for (name, value) in &self.head.headers {
            if name.eq_ignore_ascii_case("transfer-encoding")
                || name.eq_ignore_ascii_case("connection")
                || name.eq_ignore_ascii_case("keep-alive")
                || name.eq_ignore_ascii_case("content-length")
            {
                continue;
            }
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_str(value),
            ) {
                if !seen.insert(name.clone()) {
                    continue; // a duplicated header is the first one's
                }
                builder = builder.header(name, value);
            }
        }
        builder
            .body(Body::from(self.body))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
    }
}

fn bad_gateway() -> Response {
    error_page(StatusCode::BAD_GATEWAY, "this PC did not answer")
}

fn gateway_timeout() -> Response {
    error_page(
        StatusCode::GATEWAY_TIMEOUT,
        "this PC did not answer in time",
    )
}

fn gone_offline() -> Response {
    error_page(StatusCode::SERVICE_UNAVAILABLE, "this PC went offline")
}

/// An answer a browser can render (2026-10-16, the owner's direction: Safari 打开 remote
/// 直接下载了): a bare status with an empty body and no Content-Type is saved by Safari as
/// a zero-byte file, so every answer a navigation can reach carries a type and some prose.
pub(crate) fn error_page(status: StatusCode, message: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        message.to_owned(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The regression this guard exists for: a request cancelled before the PC's answer
    /// head (its browser gone) must leave nothing behind — before, the entry lingered
    /// forever and eight of them bricked the tunnel's session ceiling.
    #[test]
    fn an_abandoned_request_frees_its_session_slot() {
        let hub = Hub::new(crate::config::Config::default());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let tunnel = Arc::new(hub.new_tunnel("u".into(), tx));
        {
            let (conn_tx, _conn_rx) = mpsc::unbounded_channel();
            tunnel.conns.lock().unwrap().insert(7, conn_tx);
            let _slot = SessionSlot {
                tunnel: tunnel.clone(),
                session: 7,
                armed: true,
            };
            assert_eq!(tunnel.sessions(), 1);
        }
        assert_eq!(tunnel.sessions(), 0);
        let bytes = rx.try_recv().unwrap();
        let frames = Frame::decode_all(&bytes).unwrap();
        assert!(frames.iter().any(|f| f.ty == ty::CONN_CLOSE
            && f.decode_msgpack::<ConnClose>()
                .is_some_and(|c| c.session == 7)));
    }

    fn get(rest: &str) -> Option<String> {
        cache_key_of(&Method::GET, "u1", rest, "", false)
    }

    #[test]
    fn workbench_assets_key_across_instance_ids_but_keep_the_version() {
        // The same PC's link, the same version and hashed tail, two window ids: one key.
        assert_eq!(
            get("w/ggs-101/v/0.1.10/assets/remote-Ab12Cd34.js").as_deref(),
            Some("u1/w/_/v/0.1.10/assets/remote-Ab12Cd34.js")
        );
        assert_eq!(
            get("w/ggs-98765/v/0.1.10/assets/remote-Ab12Cd34.js").as_deref(),
            Some("u1/w/_/v/0.1.10/assets/remote-Ab12Cd34.js")
        );
        // Another PC's link NEVER shares the entry (audit H-2): cross-PC dedup let any
        // keyholder's daemon poison same-origin script for everyone else's browsers.
        assert_ne!(
            get("w/ggs-101/v/0.1.10/assets/remote-Ab12Cd34.js"),
            cache_key_of(
                &Method::GET,
                "another-link",
                "w/ggs-101/v/0.1.10/assets/remote-Ab12Cd34.js",
                "",
                false
            )
        );
        // A different version is a different build: a different key.
        assert_ne!(
            get("w/ggs-101/v/0.1.11/assets/remote-Ab12Cd34.js"),
            get("w/ggs-101/v/0.1.10/assets/remote-Ab12Cd34.js")
        );
    }

    #[test]
    fn nothing_else_is_keyed() {
        // API answers, package files, queries, conditional gets: never cached.
        assert!(get("api/session").is_none());
        assert!(get("w/ggs-101/ggs/tok/pkg/index.html").is_none());
        assert!(get("login").is_none());
        assert!(cache_key_of(&Method::GET, "u1", "w/g/v/1/a.js", "x=1", false).is_none());
        assert!(cache_key_of(&Method::GET, "u1", "w/g/v/1/a.js", "", true).is_none());
        assert!(cache_key_of(&Method::POST, "u1", "w/g/v/1/a.js", "", false).is_none());
    }
}
