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
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::sync::mpsc;

use crate::frame::{flag, ty, Frame};
use crate::front::{forward_headers, hub_extras};
use crate::msg::{ConnClose, HttpReq, HttpRes};
use crate::state::{Hub, ToConn, Tunnel};

/// Request bodies are small JSON — file uploads cross as WS `UPLOAD` frames (§7.3); a bigger
/// HTTP body is refused rather than buffered.
const MAX_REQUEST_BODY: usize = 1 << 20;
/// The largest asset the shared cache keeps.
const CACHE_ENTRY_CAP: usize = 2 << 20;

pub fn peer_ip(hub: &Hub, peer: IpAddr, request: &Request) -> IpAddr {
    if hub.config.trust_proxy && peer.is_loopback() {
        if let Some(ip) = request
            .headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
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
    if method == Method::POST && rest.ends_with("/api/login") && !hub.login_entry(ip, &uuid) {
        return too_many_requests();
    }
    let query = request.uri().query().unwrap_or_default().to_owned();
    let headers = request.headers().clone();
    let conditional = headers.contains_key(header::IF_NONE_MATCH)
        || headers.contains_key(header::IF_MODIFIED_SINCE)
        || headers.contains_key(header::RANGE);
    let cache_key =
        (method == Method::GET && query.is_empty() && !conditional).then(|| format!("/{rest}"));

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

    let mut head = HttpReq {
        method: method.as_str().to_owned(),
        path: format!("/{rest}"),
        query,
        headers: forward_headers(&headers),
        ip: ip.to_string(),
        base_path: base_path.clone(),
    };
    for (name, value) in hub_extras(&base_path, ip, &headers) {
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

    // The answer's head first; its body streams after it.
    let http = match wait_head(&mut conn_rx).await {
        Some(head) => head,
        None => return gone_offline(),
    };
    let status = StatusCode::from_u16(http.status).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut builder = Response::builder().status(status);
    for (name, value) in &http.headers {
        // Reframing is ours: the framing headers would clash with the streamed body.
        if name.eq_ignore_ascii_case("transfer-encoding")
            || name.eq_ignore_ascii_case("connection")
            || name.eq_ignore_ascii_case("keep-alive")
        {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            builder = builder.header(name, value);
        }
    }

    let cacheable = cache_key.is_some()
        && status == StatusCode::OK
        && builder
            .headers_ref()
            .and_then(|h| h.get(header::CACHE_CONTROL))
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("immutable"))
        && builder
            .headers_ref()
            .and_then(|h| h.get(header::CONTENT_LENGTH))
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<usize>().ok())
            .is_some_and(|len| len <= CACHE_ENTRY_CAP);

    let body = ProxyBody {
        rx: Some(conn_rx),
        buffered: Vec::new(),
        cache: cacheable.then(|| (hub.clone(), cache_key.clone().unwrap_or_default())),
        store: http,
        tunnel: tunnel.clone(),
        session,
        done: false,
    };
    builder
        .body(Body::from_stream(body))
        .unwrap_or_else(|_| bad_gateway())
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
}

impl ProxyBody {
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

fn too_many_requests() -> Response {
    error_page(
        StatusCode::TOO_MANY_REQUESTS,
        "too many requests — wait a minute",
    )
}

/// A cached asset becomes the response it was cached as.
impl IntoResponse for crate::cache::Entry {
    fn into_response(self) -> Response {
        let mut builder = Response::builder()
            .status(StatusCode::from_u16(self.head.status).unwrap_or(StatusCode::OK));
        for (name, value) in &self.head.headers {
            if name.eq_ignore_ascii_case("transfer-encoding")
                || name.eq_ignore_ascii_case("connection")
                || name.eq_ignore_ascii_case("keep-alive")
            {
                continue;
            }
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_str(value),
            ) {
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

fn gone_offline() -> Response {
    error_page(StatusCode::SERVICE_UNAVAILABLE, "this PC went offline")
}

fn error_page(status: StatusCode, message: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        message.to_owned(),
    )
        .into_response()
}
