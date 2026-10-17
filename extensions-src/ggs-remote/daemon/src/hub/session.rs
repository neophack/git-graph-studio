//! What the Hub forwards, served (docs/ggs-remote-plan.md §20.2 note 4): a browser's
//! WebSocket runs the same connection logic the LAN `/ws` does (cookie, HELLO + CSRF, frame
//! handling, kicks, the resume window), and a proxied HTTP request is handed to the very
//! router the public listener serves — one code path for both listeners, which is the whole
//! point of the design.

use axum::body::{Body, HttpBody};
use axum::extract::ConnectInfo;
use axum::http::{HeaderName, HeaderValue, Method, Uri};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tower::ServiceExt;

use super::link::Tunnel;
use super::msg::{ConnOpen, HttpReq};
use crate::session::Session;
use crate::state::Daemon;
use crate::ws::conn::Conn;
use crate::ws::frame::{ty, Frame};
use crate::ws::msg::{Hello, HelloAck, HEARTBEAT_MS, INITIAL_CREDIT, PROTO};

const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const RECHECK_EVERY: Duration = Duration::from_secs(60);
/// A tunnel session with no frame for this long is reclaimed (the tunnel's own heartbeat
/// would have reaped the link long before).
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// A proxied request's body cap — the LAN listener allows 64 KB; through a tunnel the same
/// request shape arrives, so a generous ceiling that still refuses runaway bodies.
const MAX_HTTP_BODY: usize = 4 << 20;

/// A browser WebSocket the Hub accepted: authenticate from the CONN_OPEN's headers, then
/// run the ordinary connection state machine over the tunnel.
pub async fn ws(
    daemon: Arc<Daemon>,
    tunnel: Arc<Tunnel>,
    open: ConnOpen,
    mut pump_rx: mpsc::UnboundedReceiver<Vec<u8>>,
) {
    let session = open.session;
    let ip: IpAddr = open.ip.parse().unwrap_or([127, 0, 0, 1].into());
    daemon.note_foreign(ip);
    let headers = header_map(&open.headers);
    let peer = SocketAddr::new(ip, 0);
    // The synthesized request arrives from loopback (this daemon's own tunnel task) carrying
    // the browser's own headers: the proxy-trust path in http::client_ip / origin_ok.
    let Some(user) = crate::http::session_of(&daemon, &headers) else {
        tunnel.close_session(session, 4401, "no-session");
        return;
    };
    if !crate::http::origin_ok_proxied(&daemon, peer, &headers) {
        tunnel.close_session(session, 4403, "origin");
        return;
    }
    let base = crate::http::base_path(&headers);

    // HELLO first, carrying the session's CSRF value (the socket path's rule, §7.7).
    let hello = match tokio::time::timeout(HELLO_TIMEOUT, pump_rx.recv()).await {
        Ok(Some(bytes)) => Frame::decode_all(&bytes)
            .ok()
            .and_then(|frames| frames.into_iter().next())
            .filter(|f| f.ty == ty::HELLO)
            .and_then(|mut f| {
                f.decompress()
                    .ok()
                    .and_then(|_| f.decode_msgpack::<Hello>())
            }),
        _ => None,
    };
    let Some(hello) = hello else {
        tunnel.close_session(session, 4403, "hello-required");
        return;
    };
    if hello.proto != PROTO || !crate::util::ct_eq(hello.csrf.as_bytes(), user.csrf.as_bytes()) {
        tunnel.close_session(session, 4403, "csrf");
        return;
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let deflate = hello.caps.deflate;
    let (conn, resumed, gen) = establish(
        &daemon,
        &Establishment {
            user: &user,
            ip,
            base: &base,
            hello: &hello,
            deflate,
        },
        &tx,
        &mut rx,
    );
    if !resumed {
        conn.push(crate::ws::windows_frame(&daemon));
    }
    daemon.update_tray();
    crate::info!(
        "tunnel session {session} connected from {ip} ({})",
        user.device
    );

    let mut kicks = daemon.kicks.subscribe();
    let mut recheck = tokio::time::interval(RECHECK_EVERY);
    recheck.tick().await;
    let mut last_frame = tokio::time::Instant::now();
    // Whether the loop left because the tunnel went quiet under us — the one exit that
    // must free the tunnel session without ending the resume window (the browser may
    // still be there, merely silent; its next frame resumes on whatever tunnel answers).
    let mut idle = false;

    let ended = loop {
        tokio::select! {
            message = pump_rx.recv() => {
                let Some(bytes) = message else { break false; };
                last_frame = tokio::time::Instant::now();
                let Ok(frames) = Frame::decode_all(&bytes) else {
                    break true;
                };
                for frame in frames {
                    crate::ws::handle(&daemon, &conn, frame);
                }
            }
            Some(bytes) = rx.recv() => {
                if !tunnel.send_session(session, bytes) {
                    // The tunnel went away under us — not the browser (§6.5): park the
                    // resume window; the push above is already in the ring and replays on
                    // resume through whatever tunnel answers next.
                    break false;
                }
            }
            kick = kicks.recv() => {
                match kick {
                    Ok(kick) if kick.token_hash.as_deref().is_none_or(|h| h == user.token_hash) => {
                        flush_downlink(&mut rx, &tunnel, session);
                        conn.close(kick.code, &kick.reason);
                        flush_downlink(&mut rx, &tunnel, session);
                        tunnel.close_session(session, kick.code, &kick.reason);
                        break true;
                    }
                    _ => {}
                }
            }
            _ = recheck.tick() => {
                if !daemon.session_valid(&user.token_hash) {
                    conn.close(crate::ws::msg::code::CREDENTIALS, "expired");
                    flush_downlink(&mut rx, &tunnel, session);
                    tunnel.close_session(session, crate::ws::msg::code::CREDENTIALS, "expired");
                    break true;
                }
                if last_frame.elapsed() > IDLE_TIMEOUT {
                    idle = true;
                    break false;
                }
            }
        }
    };

    if ended {
        // Only the session task that owns the live binding may end the connection: a
        // stale tunnel session (superseded by a resume, exiting on its idle check)
        // leaves its successor's connection alone.
        if conn.owns_live(gen) {
            crate::router::end_conn(&daemon, &conn);
        }
        tunnel.close_session(session, 1000, "closed");
    } else if idle {
        // Five minutes with no frame (a phone black-holed by NAT, no FIN ever arriving):
        // free the tunnel session — before, this exit left it bound on both sides, and a
        // tunnel's ceiling slowly filled with ghosts until every later login 429'd — but
        // keep the resume window open for the browser's return.
        conn.go_offline(gen);
        tunnel.close_session(session, 1000, "idle");
    } else {
        // The tunnel went away under us: keep the resume window open (§6.5) — the browser
        // reconnects through whatever tunnel answers next and presents its sid.
        conn.go_offline(gen);
    }
    daemon.update_tray();
    crate::info!("tunnel session {session} disconnected");
}

fn flush_downlink(rx: &mut mpsc::UnboundedReceiver<Vec<u8>>, tunnel: &Arc<Tunnel>, session: u32) {
    while let Ok(bytes) = rx.try_recv() {
        if !tunnel.send_session(session, bytes) {
            return;
        }
    }
}

/// What establishing a connection needs — the socket path performs this inline (§7.7).
struct Establishment<'a> {
    user: &'a Session,
    ip: IpAddr,
    base: &'a str,
    hello: &'a Hello,
    deflate: bool,
}

/// The fresh-or-resume establishment: resume onto the connection the browser's
/// `HELLO.resume.sid` names, or start a new one. Answers the connection, whether it
/// resumed, and the live-binding generation the calling task owns.
fn establish(
    daemon: &Arc<Daemon>,
    ask: &Establishment<'_>,
    tx: &mpsc::UnboundedSender<Vec<u8>>,
    rx: &mut mpsc::UnboundedReceiver<Vec<u8>>,
) -> (Arc<Conn>, bool, u64) {
    let (user, hello, ip, base, deflate) = (ask.user, ask.hello, ask.ip, ask.base, ask.deflate);
    let resumable = hello.resume.as_ref().and_then(|r| {
        daemon
            .conn_by_sid(&r.sid, &user.token_hash)
            .map(|c| (c, r.last_seq))
    });
    match resumable {
        Some((conn, last_seq)) => {
            let _ = tx.send(ack(&conn, true));
            if let Some(gen) = conn.resume(tx.clone(), deflate, last_seq) {
                (conn, true, gen)
            } else {
                // The ring no longer covers the gap: a fresh connection (the browser soft-
                // reloads on `resumed: false`). The premature {resumed: true} ack waiting
                // in the DOWNLINK goes with it (the LAN path's rule, §7.7) — never the
                // uplink, whose pipelined frames are the browser's own.
                crate::router::end_conn(daemon, &conn);
                let fresh = daemon.new_conn(
                    crate::util::token(16),
                    user.token_hash.clone(),
                    base.to_owned(),
                    ip,
                );
                while rx.try_recv().is_ok() {}
                let _ = tx.send(ack(&fresh, false));
                let gen = fresh.go_live(tx.clone(), deflate);
                (fresh, false, gen)
            }
        }
        None => {
            let fresh = daemon.new_conn(
                crate::util::token(16),
                user.token_hash.clone(),
                base.to_owned(),
                ip,
            );
            let _ = tx.send(ack(&fresh, false));
            let gen = fresh.go_live(tx.clone(), deflate);
            (fresh, false, gen)
        }
    }
}

fn ack(conn: &Conn, resumed: bool) -> Vec<u8> {
    Frame::msgpack(
        ty::HELLO_ACK,
        &HelloAck {
            sid: conn.sid.clone(),
            server_time: crate::util::now_millis(),
            heartbeat_ms: HEARTBEAT_MS,
            max_frame: crate::ws::frame::MAX_PAYLOAD as u32,
            credit: INITIAL_CREDIT,
            resumed,
            base_path: conn.base_path.clone(),
        },
    )
    .encode()
}

/// One proxied HTTP request (§20.4 `HTTP_REQ`): body chunks arrive on the same session,
/// the answer streams back as `HTTP_RES` + chunks. The request is handed to the public
/// router unchanged — its guards, sessions and asset serving all apply.
pub async fn http(
    daemon: Arc<Daemon>,
    tunnel: Arc<Tunnel>,
    session: u32,
    head: HttpReq,
    mut pump_rx: mpsc::UnboundedReceiver<Vec<u8>>,
) {
    // The body: RAW frames until FIN.
    let mut body = Vec::new();
    let complete = loop {
        match tokio::time::timeout(Duration::from_secs(30), pump_rx.recv()).await {
            Ok(Some(bytes)) => {
                let Ok(frames) = Frame::decode_all(&bytes) else {
                    break false;
                };
                let mut fin = false;
                for frame in frames {
                    if frame.ty == ty::HTTP_REQ {
                        fin |= frame.has(crate::ws::frame::flag::FIN);
                        body.extend_from_slice(&frame.payload);
                    }
                }
                if fin || body.len() > MAX_HTTP_BODY {
                    break true;
                }
            }
            _ => break false,
        }
    };
    if body.len() > MAX_HTTP_BODY {
        reply_head(
            &tunnel,
            session,
            413,
            &[("content-type".to_owned(), "text/plain".to_owned())],
        );
        tunnel.close_session(session, 1000, "done");
        return;
    }
    if !complete {
        // A body that never reached its FIN — a timeout, a decode failure, the session's
        // channel gone. That is a gateway timeout, not a payload problem: 413 here lied
        // to the browser (and the logs) about a request that was never too large.
        reply_head(
            &tunnel,
            session,
            504,
            &[("content-type".to_owned(), "text/plain".to_owned())],
        );
        tunnel.close_session(session, 1000, "done");
        return;
    }

    let request = match synthesize(&head, body) {
        Ok(request) => request,
        Err(message) => {
            crate::warn!("tunnel http: {message}");
            reply_head(
                &tunnel,
                session,
                400,
                &[("content-type".to_owned(), "text/plain".to_owned())],
            );
            tunnel.close_session(session, 1000, "done");
            return;
        }
    };
    daemon.note_foreign(head.ip.parse().unwrap_or([127, 0, 0, 1].into()));

    let router = crate::http::public_router(daemon.clone());
    let response = router
        .oneshot(request)
        .await
        .unwrap_or_else(|never| match never {});

    let (parts, response_body) = response.into_parts();
    let mut heads: Vec<(String, String)> = parts
        .headers
        .iter()
        .filter(|(name, _)| !matches!(name.as_str(), "transfer-encoding" | "connection"))
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_owned(), value.to_owned()))
        })
        .collect();
    // A body of known size carries its length: hyper adds content-length only on the wire
    // (the LAN listener), never in the router's parts — without it the Hub's shared cache
    // refuses every proxied asset (§20.6), and immutable answers were never cached at all.
    if let (Some(exact), None) = (
        response_body.size_hint().exact(),
        parts.headers.get(axum::http::header::CONTENT_LENGTH),
    ) {
        heads.push(("content-length".to_owned(), exact.to_string()));
    }
    reply_head(&tunnel, session, parts.status.as_u16(), &heads);

    // The body streams: chunks become RAW frames, an empty FIN frame ends the answer.
    use futures_util::StreamExt;
    let mut stream = response_body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else { break };
        for piece in chunk.chunks(crate::ws::frame::MAX_PAYLOAD) {
            // The tunnel is gone once a send fails: stop pulling the rest of the body —
            // a multi-gigabyte download used to keep draining, encoding frames nobody
            // received, for as long as the router produced them.
            if !tunnel.send_control(
                &Frame::new(ty::HTTP_RES, crate::ws::frame::Enc::Raw, piece.to_vec())
                    .with_session(session),
            ) {
                tunnel.close_session(session, 1000, "done");
                return;
            }
        }
    }
    let mut fin =
        Frame::new(ty::HTTP_RES, crate::ws::frame::Enc::Raw, Vec::new()).with_session(session);
    fin.flags |= crate::ws::frame::flag::FIN;
    let _ = tunnel.send_control(&fin);
    tunnel.close_session(session, 1000, "done");
}

fn reply_head(tunnel: &Arc<Tunnel>, session: u32, status: u16, headers: &[(String, String)]) {
    let res = super::msg::HttpRes {
        status,
        headers: headers.to_vec(),
    };
    let _ = tunnel.send_control(&Frame::msgpack(ty::HTTP_RES, &res).with_session(session));
}

/// Build the axum request the router serves: the path the Hub stripped the prefix from, the
/// forwarded headers (the Hub marked it with `x-ggs-base-path` / `x-forwarded-for`).
fn synthesize(head: &HttpReq, body: Vec<u8>) -> Result<axum::http::Request<Body>, String> {
    let method = Method::from_bytes(head.method.as_bytes())
        .map_err(|_| format!("bad method {:?}", head.method))?;
    let mut uri = head.path.clone();
    if !uri.starts_with('/') {
        uri.insert(0, '/');
    }
    if !head.query.is_empty() {
        uri.push('?');
        uri.push_str(&head.query);
    }
    let uri: Uri = uri.parse().map_err(|_| format!("bad path {uri}"))?;
    let mut builder = axum::http::Request::builder().method(method).uri(uri);
    for (name, value) in &head.headers {
        let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) else {
            continue; // one malformed header never sinks the request
        };
        builder = builder.header(name, value);
    }
    let mut request = builder
        .body(Body::from(body))
        .map_err(|e| format!("request build: {e}"))?;
    // The tunnel's mark is the PEER, not a header: every tunneled request is synthesized
    // with `TUNNEL_BUCKET` as its peer (an address no LAN connection can carry), so the
    // shared-bucket rule of audit F6 cannot be forged onto a direct LAN request by anyone
    // stamping `x-ggs-base-path` themselves (2026-10-16). The limiter keys on that bucket;
    // the browser's real address rides the unforgeable `OriginIp` extension for the logs,
    // and reaches the tray through `head.ip` / `note_foreign` above.
    request.extensions_mut().insert(crate::http::OriginIp(
        head.ip.parse().unwrap_or(crate::http::TUNNEL_BUCKET),
    ));
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::new(crate::http::TUNNEL_BUCKET, 0)));
    Ok(request)
}

fn header_map(source: &std::collections::BTreeMap<String, String>) -> axum::http::HeaderMap {
    let mut headers = axum::http::HeaderMap::new();
    for (name, value) in source {
        let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) else {
            continue;
        };
        headers.insert(name, value);
    }
    headers
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Paths;
    use crate::ws::msg::Resume;

    fn daemon() -> (tempfile::TempDir, Arc<Daemon>) {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
        paths.ensure().unwrap();
        (
            dir,
            Daemon::new(paths, crate::config::Config::default()).unwrap(),
        )
    }

    fn user() -> Session {
        Session {
            token_hash: "hash".into(),
            epoch: 0,
            device: "test".into(),
            ua: String::new(),
            ip: String::new(),
            created: 0,
            last_seen: 0,
            remember: false,
            csrf: "csrf".into(),
        }
    }

    /// A failed resume drains the DOWNLINK — the premature {resumed: true} ack waiting in
    /// it — never the uplink, whose pipelined frames (a PING, a CREDIT, keystrokes) are
    /// the browser's own (2026-10-16): before, `establish` emptied `pump_rx` and left the
    /// stale ack queued ahead of the fresh one.
    #[test]
    fn a_failed_resume_drains_the_downlink_not_the_uplink() {
        let (_dir, daemon) = daemon();
        let user = user();
        // A conn whose ring no longer covers the browser's last_seq: an oversized push
        // evicts unacknowledged frames, so a resume from 0 cannot replay.
        let old = daemon.new_conn(
            "sid-old".into(),
            user.token_hash.clone(),
            "/".into(),
            "127.0.0.1".parse().unwrap(),
        );
        let (old_tx, _old_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let old_gen = old.go_live(old_tx, false);
        old.push(Frame::new(
            ty::NOTICE,
            crate::ws::frame::Enc::Raw,
            vec![0; 2 << 20],
        ));
        old.go_offline(old_gen);

        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (pump_tx, mut pump_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        pump_tx.send(b"pipelined".to_vec()).unwrap();
        let hello = Hello {
            resume: Some(Resume {
                sid: "sid-old".into(),
                last_seq: 0,
            }),
            ..Default::default()
        };
        let (conn, resumed, _gen) = establish(
            &daemon,
            &Establishment {
                user: &user,
                ip: "127.0.0.1".parse().unwrap(),
                base: "/",
                hello: &hello,
                deflate: false,
            },
            &tx,
            &mut rx,
        );
        assert!(!resumed);
        assert_ne!(conn.sid, "sid-old");
        // Exactly the fresh {resumed: false} ack waits in the downlink — the premature
        // {resumed: true} one went with the old connection.
        let mut frames = Vec::new();
        while let Ok(bytes) = rx.try_recv() {
            frames.extend(Frame::decode_all(&bytes).unwrap());
        }
        assert_eq!(frames.len(), 1);
        let acked: HelloAck = frames[0].decode_msgpack().unwrap();
        assert!(!acked.resumed);
        assert_eq!(acked.sid, conn.sid);
        // The uplink's pipelined bytes survived.
        assert_eq!(pump_rx.try_recv().unwrap(), b"pipelined".to_vec());
        // The old connection is ended.
        assert!(daemon.conn_by_sid("sid-old", "hash").is_none());
    }

    /// A hostile or foreign URL in a forwarded head — an absolute `http://…`, an
    /// authority-shaped `//host/…` — must stay THIS PC's local path: the synthesized
    /// request never carries a scheme or authority, so there is nothing to route toward
    /// another site. The daemon has no outbound fetch in this path at all; this pins that
    /// a future edit cannot quietly grow one either.
    #[test]
    fn a_forwarded_head_naming_a_foreign_site_stays_a_local_path() {
        let head = |path: &str| HttpReq {
            method: "GET".into(),
            path: path.into(),
            query: String::new(),
            headers: Default::default(),
            ip: "203.0.113.9".into(),
            base_path: "/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3/".into(),
        };
        for foreign in [
            "http://example.com/secret",
            "https://example.com/",
            "http://user:pass@example.com:8443/admin",
            "//example.com/secret",
        ] {
            let request = synthesize(&head(foreign), Vec::new())
                .unwrap_or_else(|e| panic!("{foreign} must synthesize, not fail: {e}"));
            let uri = request.uri();
            assert!(
                uri.scheme().is_none() && uri.authority().is_none(),
                "{foreign}: the request must stay origin-form, got {uri:?}"
            );
            assert!(
                uri.path().starts_with('/'),
                "{foreign}: the PC serves it as its own local path, got {uri:?}"
            );
            assert_eq!(
                uri.host(),
                None,
                "{foreign}: there is no host to connect to"
            );
        }
    }

    /// The same heads through the real public router: the answer is the router's own 404 —
    /// the request never leaves this process. A proxy would have answered a foreign site's
    /// bytes; nothing here has a client to fetch them with.
    #[tokio::test]
    async fn a_foreign_site_head_is_answered_by_the_local_router_alone() {
        let (_dir, daemon) = daemon();
        daemon.auth.set_password("local-router-test").await.unwrap();
        for foreign in ["http://example.com/secret", "//example.com/secret"] {
            let head = HttpReq {
                method: "GET".into(),
                path: foreign.into(),
                query: String::new(),
                headers: Default::default(),
                ip: "203.0.113.9".into(),
                base_path: "/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3/".into(),
            };
            let request = synthesize(&head, Vec::new()).unwrap();
            let response = crate::http::public_router(daemon.clone())
                .oneshot(request)
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                axum::http::StatusCode::NOT_FOUND,
                "{foreign}: the local router answers 404, never a fetched site"
            );
        }
    }
}
