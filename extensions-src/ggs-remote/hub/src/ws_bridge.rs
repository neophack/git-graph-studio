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
use tokio::sync::mpsc;

use crate::frame::{ty, Frame};
use crate::front::{forward_headers, hub_extras};
use crate::msg::{ConnClose, ConnOpen};
use crate::state::{Hub, ToConn, Tunnel};

pub async fn bridge(
    hub: Arc<Hub>,
    tunnel: Arc<Tunnel>,
    upgrade: WebSocketUpgrade,
    ip: IpAddr,
    base_path: String,
    headers: HeaderMap,
) -> Response {
    if tunnel.sessions() >= hub.config.sessions_per_tunnel {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    upgrade
        .max_message_size(crate::frame::MAX_PAYLOAD + 64)
        .on_upgrade(move |socket| run(hub, tunnel, socket, ip, base_path, headers))
}

async fn run(
    hub: Arc<Hub>,
    tunnel: Arc<Tunnel>,
    socket: WebSocket,
    ip: IpAddr,
    base_path: String,
    headers: HeaderMap,
) {
    let session = hub.alloc_session();
    hub.counters.sessions_total.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = socket.split();

    let mut open = ConnOpen {
        session,
        kind: "ws".into(),
        ip: ip.to_string(),
        ua: String::new(),
        base_path: base_path.clone(),
        headers: forward_headers(&headers),
    };
    for (name, value) in hub_extras(&hub.config, &base_path, ip, &headers) {
        open.headers.insert(name, value);
    }
    if !tunnel.send(&Frame::msgpack(ty::CONN_OPEN, &open)) {
        let _ = sink
            .send(Message::Close(Some(CloseFrame {
                code: 1013,
                reason: "pc-offline".into(),
            })))
            .await;
        return;
    }

    let (conn_tx, mut conn_rx) = mpsc::unbounded_channel::<ToConn>();
    tunnel.conns.lock().unwrap().insert(session, conn_tx);
    crate::info!("session {session} on {} from {ip}", tunnel.uuid);
    hub.audit.log(
        "session_open",
        &[
            ("uuid", serde_json::json!(tunnel.uuid)),
            ("session", serde_json::json!(session)),
            ("ip", serde_json::json!(ip.to_string())),
        ],
    );

    // The writer: downlink messages and closes from the tunnel.
    let writer = tokio::spawn(async move {
        while let Some(to_conn) = conn_rx.recv().await {
            match to_conn {
                ToConn::Bytes(bytes) => {
                    if sink.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                ToConn::Close { code, reason } => {
                    let _ = sink
                        .send(Message::Close(Some(CloseFrame {
                            code,
                            reason: reason.into(),
                        })))
                        .await;
                    break;
                }
            }
        }
    });

    // The reader: browser frames, session-stamped, to the PC. Uplink coalescing the browser
    // already did (§6.4) survives: one WS message becomes one tunnel message.
    let mut close = (1000, "closed".to_owned());
    while let Some(Ok(message)) = stream.next().await {
        match message {
            Message::Binary(message_bytes) => {
                let mut bytes = message_bytes.to_vec();
                hub.counters
                    .bytes_down
                    .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                if !tunnel.spend(bytes.len() as u64) {
                    close = (1013, "budget".into());
                    break;
                }
                if !crate::frame::stamp_session(&mut bytes, session)
                    || tunnel.tx.send(bytes.to_vec()).is_err()
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
    hub.audit.log(
        "session_close",
        &[
            ("uuid", serde_json::json!(tunnel.uuid)),
            ("session", serde_json::json!(session)),
            ("code", serde_json::json!(close.0)),
        ],
    );
    crate::info!("session {session} on {} closed", tunnel.uuid);
}
