//! The browser WebSocket ↔ tunnel session bridge (docs/ggs-remote-plan.md §20.4): the Hub
//! accepts the browser's `/ws` upgrade itself, opens a logical session on the tunnel with a
//! `CONN_OPEN` carrying the headers the daemon's checks read, and then moves frames both
//! ways, re-stamping the `session` field — the browser link always spells 0 (§6.1).

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use std::net::IpAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::frame::{ty, Frame};
use crate::front::{forward_headers, hub_extras};
use crate::msg::{ConnClose, ConnOpen};
use crate::state::{Hub, ToConn, Tunnel};

/// The keepalive cadence on the browser leg — the tunnel leg's own heartbeat rhythm (§20.4).
const SESSION_PING: Duration = Duration::from_secs(25);
/// No received message for this long ends the session: three-plus ping intervals of
/// silence, the same budget the tunnel leg's three-missed-heartbeats rule allows.
const SESSION_IDLE: Duration = Duration::from_secs(90);

pub async fn bridge(
    hub: Arc<Hub>,
    tunnel: Arc<Tunnel>,
    upgrade: WebSocketUpgrade,
    ip: IpAddr,
    // The DIRECT socket peer — the trusted-proxy gate for the forwarded headers.
    peer: IpAddr,
    base_path: String,
    headers: HeaderMap,
) -> Response {
    if tunnel.sessions() >= hub.config.sessions_per_tunnel {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    upgrade
        .max_message_size(crate::frame::MAX_PAYLOAD + 64)
        .on_upgrade(move |socket| run(hub, tunnel, socket, ip, peer, base_path, headers))
}

async fn run(
    hub: Arc<Hub>,
    tunnel: Arc<Tunnel>,
    socket: WebSocket,
    ip: IpAddr,
    peer: IpAddr,
    base_path: String,
    headers: HeaderMap,
) {
    let session = hub.alloc_session();
    let (mut sink, mut stream) = socket.split();

    // Reserve the slot against the ceiling, atomically and BEFORE the session goes anywhere:
    // bridge()'s check ran ahead of the upgrade's arbitrary gap, and a burst of concurrent
    // upgrades each passed it — the ceiling (shared with the HTTP proxy's sessions) overshot
    // without bound. The refusal is a clean close: the PC never hears of this session.
    let (conn_tx, mut conn_rx) = mpsc::unbounded_channel::<ToConn>();
    if !tunnel.reserve_conn(hub.config.sessions_per_tunnel, session, conn_tx) {
        let _ = sink
            .send(Message::Close(Some(CloseFrame {
                code: 1013,
                reason: "capacity".into(),
            })))
            .await;
        return;
    }
    hub.counters.sessions_total.fetch_add(1, Ordering::Relaxed);

    let mut open = ConnOpen {
        session,
        kind: "ws".into(),
        ip: ip.to_string(),
        ua: String::new(),
        base_path: base_path.clone(),
        headers: forward_headers(&headers),
    };
    for (name, value) in hub_extras(&hub, peer, &base_path, ip, &headers) {
        open.headers.insert(name, value);
    }
    if !tunnel.send(&Frame::msgpack(ty::CONN_OPEN, &open)) {
        // The PC is gone: roll the reservation back — the session never happened.
        tunnel.conns.lock().unwrap().remove(&session);
        let _ = sink
            .send(Message::Close(Some(CloseFrame {
                code: 1013,
                reason: "pc-offline".into(),
            })))
            .await;
        return;
    }

    crate::info!("session {session} on {} from {ip}", tunnel.uuid);
    if hub.audit.enabled() {
        hub.audit.log(
            "session_open",
            &[
                ("uuid", serde_json::json!(tunnel.uuid)),
                ("session", serde_json::json!(session)),
                ("ip", serde_json::json!(ip.to_string())),
            ],
        );
    }

    // The writer: downlink messages and closes from the tunnel, plus the keepalive ping —
    // the browser's JS answers a ping automatically, so its pong proves the peer still
    // lives even while the session carries no traffic. Without it a reader parked on a
    // vanished browser (sleeping phone, NAT reaping, no FIN) held one of the
    // `sessions_per_tunnel` slots until the OS gave up on the half-open TCP peer — eight
    // ghosts and the link's every further request answered 429.
    let writer = tokio::spawn(async move {
        let mut ping =
            tokio::time::interval_at(tokio::time::Instant::now() + SESSION_PING, SESSION_PING);
        loop {
            tokio::select! {
                to_conn = conn_rx.recv() => {
                    match to_conn {
                        Some(ToConn::Bytes(bytes)) => {
                            if sink.send(Message::Binary(bytes.into())).await.is_err() {
                                break;
                            }
                        }
                        Some(ToConn::Close { code, reason }) => {
                            let _ = sink
                                .send(Message::Close(Some(CloseFrame {
                                    code,
                                    reason: reason.into(),
                                })))
                                .await;
                            break;
                        }
                        None => break,
                    }
                }
                _ = ping.tick() => {
                    if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // The reader: browser frames, session-stamped, to the PC. Uplink coalescing the browser
    // already did (§6.4) survives: one WS message becomes one tunnel message. Any received
    // message — data, a pong, anything — refreshes the idle deadline; the writer's pings
    // keep a live browser answering them, so only a peer that is really gone runs it out.
    let mut close = (1000, "closed".to_owned());
    loop {
        let next = match tokio::time::timeout(SESSION_IDLE, stream.next()).await {
            Ok(item) => item,
            Err(_elapsed) => {
                close = (1001, "idle".to_owned());
                break;
            }
        };
        let Some(Ok(message)) = next else { break };
        match message {
            Message::Binary(message_bytes) => {
                // The daemon may have closed this session (a 4401, a sign-out) while the
                // browser keeps sending: the writer heard it as `ToConn::Close`, but the
                // reader would have kept stamping every further frame into the tunnel's
                // unbounded uplink — frames the PC drops, so nothing ever applied
                // backpressure. A session that is no longer registered ends the reading.
                if !tunnel.conns.lock().unwrap().contains_key(&session) {
                    close = (1000, "closed".to_owned());
                    break;
                }
                // A `Bytes` from a fresh network read is unique, so the stamp usually
                // happens without a copy (`try_into_mut` + the zero-copy `BytesMut →
                // Vec` move); the send then moves the buffer — this is the relay's
                // hottest path, and a dead `.to_vec()` here copied every uplink frame
                // twice for nothing.
                let mut bytes = match message_bytes.try_into_mut() {
                    Ok(owned) => Vec::from(owned),
                    Err(shared) => shared.to_vec(),
                };
                hub.counters
                    .bytes_down
                    .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                if !tunnel.spend(bytes.len() as u64) {
                    close = (1013, "budget".into());
                    break;
                }
                if !crate::frame::stamp_session(&mut bytes, session)
                    || tunnel.tx.send(bytes).is_err()
                {
                    close = (1011, "pc-offline".into());
                    break;
                }
            }
            Message::Close(frame) => {
                if let Some(frame) = frame {
                    close = (frame.code, frame.reason.to_string());
                }
                break;
            }
            _ => {}
        }
    }

    // The browser went away: tell the PC so the daemon frees the session's state, and stop
    // the writer. (A daemon-side close arrived as CONN_CLOSE in the tunnel task instead.)
    tunnel.conns.lock().unwrap().remove(&session);
    let _ = tunnel.send(&Frame::msgpack(
        ty::CONN_CLOSE,
        &ConnClose {
            session,
            code: close.0,
            reason: close.1,
        },
    ));
    writer.abort();
    if hub.audit.enabled() {
        hub.audit.log(
            "session_close",
            &[
                ("uuid", serde_json::json!(tunnel.uuid)),
                ("session", serde_json::json!(session)),
                ("code", serde_json::json!(close.0)),
            ],
        );
    }
    crate::info!("session {session} on {} closed", tunnel.uuid);
}
