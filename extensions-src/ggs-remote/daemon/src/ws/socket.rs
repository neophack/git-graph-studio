//! The `/ws` connection task (docs/ggs-remote-plan.md §7.7): cookie + Origin at the upgrade,
//! a HELLO with the session's CSRF value within 5 s, then one loop that reads browser frames,
//! writes the connection's downlink, pushes WINDOWS on registry changes, honours kicks
//! (password change, sign-out, pause) and re-validates the session every 60 s.

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

use super::conn::{is_relay_bound, Conn};
use super::frame::{ty, Frame, MAX_MESSAGE};
use super::msg::{
    code, Attach, Close, Credit, Hello, HelloAck, InstanceClose, InstanceDisplay, InstanceRestart,
    Notice, Pong, Spawn, Spawned, Windows, HEARTBEAT_MS, INITIAL_CREDIT, PROTO,
};
use crate::control_msg::ToInstance;
use crate::http::{base_path, client_ip, origin_ok, session_of};
use crate::session::Session;
use crate::state::Daemon;

const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const RECHECK_EVERY: Duration = Duration::from_secs(60);
/// Without any frame for this long the socket is considered dead (the browser pings every
/// `HEARTBEAT_MS`; a backgrounded tab every 60 s).
const IDLE_TIMEOUT: Duration = Duration::from_secs(150);

pub async fn ws_handler(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(session) = session_of(&daemon, &headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !origin_ok(&daemon, peer, &headers) {
        crate::warn!("websocket with a foreign Origin refused");
        return StatusCode::FORBIDDEN.into_response();
    }
    let ip = client_ip(&daemon, peer, &headers);
    daemon.note_foreign(ip);
    let base = base_path(&headers);
    upgrade
        .max_message_size(MAX_MESSAGE)
        .on_upgrade(move |socket| run(daemon, socket, session, ip, base))
}

enum Exit {
    /// The socket dropped: keep the state for the resume window.
    Dropped,
    /// Ended for good (kick, protocol error).
    Ended,
}

async fn close_with(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    code: u16,
    reason: &str,
) {
    let frame = Frame::msgpack(
        ty::CLOSE,
        &Close {
            code,
            reason: reason.to_owned(),
        },
    );
    let _ = sink.send(Message::Binary(frame.encode().into())).await;
    let _ = sink
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.to_owned().into(),
        })))
        .await;
}

async fn run(
    daemon: Arc<Daemon>,
    socket: WebSocket,
    session: Session,
    ip: std::net::IpAddr,
    base: String,
) {
    let (mut sink, mut stream) = socket.split();

    // HELLO first, with the session's CSRF value.
    let hello = match tokio::time::timeout(HELLO_TIMEOUT, stream.next()).await {
        Ok(Some(Ok(Message::Binary(bytes)))) => Frame::decode_all(&bytes)
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
        close_with(&mut sink, code::ORIGIN, "hello-required").await;
        return;
    };
    if hello.proto != PROTO {
        close_with(&mut sink, code::VERSION, "protocol-version").await;
        return;
    }
    if !crate::util::ct_eq(hello.csrf.as_bytes(), session.csrf.as_bytes()) {
        close_with(&mut sink, code::ORIGIN, "csrf").await;
        return;
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let deflate = hello.caps.deflate;
    let resumable = hello.resume.as_ref().and_then(|r| {
        daemon
            .conn_by_sid(&r.sid, &session.token_hash)
            .map(|c| (c, r.last_seq))
    });
    let (conn, resumed) = match resumable {
        Some((conn, last_seq)) => {
            let ack = hello_ack(&conn, true);
            let _ = tx.send(ack.clone());
            if conn.resume(tx.clone(), deflate, last_seq) {
                (conn, true)
            } else {
                // The ring no longer covers the gap: a fresh connection (the browser soft-
                // reloads on `resumed: false`).
                crate::router::end_conn(&daemon, &conn);
                let fresh = daemon.new_conn(
                    crate::util::token(16),
                    session.token_hash.clone(),
                    base.clone(),
                    ip,
                );
                while rx.try_recv().is_ok() {}
                let _ = tx.send(hello_ack(&fresh, false));
                fresh.go_live(tx.clone(), deflate);
                (fresh, false)
            }
        }
        None => {
            let fresh = daemon.new_conn(
                crate::util::token(16),
                session.token_hash.clone(),
                base.clone(),
                ip,
            );
            let _ = tx.send(hello_ack(&fresh, false));
            fresh.go_live(tx.clone(), deflate);
            (fresh, false)
        }
    };
    if !resumed {
        conn.push(windows_frame(&daemon));
    }
    daemon.update_tray();
    crate::info!(
        "remote session {} connected from {ip} ({})",
        conn.id,
        session.device
    );

    let mut kicks = daemon.kicks.subscribe();
    let mut recheck = tokio::time::interval(RECHECK_EVERY);
    recheck.tick().await;
    let mut last_frame = tokio::time::Instant::now();

    let exit = loop {
        tokio::select! {
            message = stream.next() => {
                let Some(Ok(message)) = message else { break Exit::Dropped };
                last_frame = tokio::time::Instant::now();
                match message {
                    Message::Binary(bytes) => {
                        let Ok(frames) = Frame::decode_all(&bytes) else {
                            close_with(&mut sink, code::VERSION, "bad-frame").await;
                            break Exit::Ended;
                        };
                        for frame in frames {
                            handle(&daemon, &conn, frame);
                        }
                    }
                    Message::Close(_) => break Exit::Dropped,
                    _ => {}
                }
            }
            Some(bytes) = rx.recv() => {
                if sink.send(Message::Binary(bytes.into())).await.is_err() {
                    break Exit::Dropped;
                }
            }
            kick = kicks.recv() => {
                match kick {
                    Ok(kick) if kick.token_hash.as_deref().is_none_or(|h| h == session.token_hash) => {
                        flush(&mut rx, &mut sink).await;
                        close_with(&mut sink, kick.code, &kick.reason).await;
                        break Exit::Ended;
                    }
                    _ => {}
                }
            }
            _ = recheck.tick() => {
                if !daemon.session_valid(&session.token_hash) {
                    flush(&mut rx, &mut sink).await;
                    close_with(&mut sink, code::CREDENTIALS, "expired").await;
                    break Exit::Ended;
                }
                if last_frame.elapsed() > IDLE_TIMEOUT {
                    break Exit::Dropped;
                }
            }
        }
    };
    match exit {
        Exit::Dropped => conn.go_offline(),
        Exit::Ended => crate::router::end_conn(&daemon, &conn),
    }
    daemon.update_tray();
    crate::info!("remote session {} disconnected", conn.id);
}

async fn flush(
    rx: &mut mpsc::UnboundedReceiver<Vec<u8>>,
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
) {
    while let Ok(bytes) = rx.try_recv() {
        if sink.send(Message::Binary(bytes.into())).await.is_err() {
            return;
        }
    }
}

fn hello_ack(conn: &Conn, resumed: bool) -> Vec<u8> {
    Frame::msgpack(
        ty::HELLO_ACK,
        &HelloAck {
            sid: conn.sid.clone(),
            server_time: crate::util::now_millis(),
            heartbeat_ms: HEARTBEAT_MS,
            max_frame: super::frame::MAX_PAYLOAD as u32,
            credit: INITIAL_CREDIT,
            resumed,
            base_path: conn.base_path.clone(),
        },
    )
    .encode()
}

/// Whether a remote session may drive this instance: with the sandbox on (§23), only
/// sandboxed instances are a remote session's to touch — attach, close or restart alike.
fn remote_may_drive(daemon: &Daemon, instance: &str) -> bool {
    !daemon.config().sandbox.enabled
        || daemon
            .registry
            .with(instance, |i| i.info.sandboxed)
            .unwrap_or(false)
}

pub fn windows_frame(daemon: &Daemon) -> Frame {
    // With the sandbox enabled (§23) a remote session sees sandboxed instances only:
    // the desktop windows stay the user's own. The recent list narrows with them.
    let sandbox = daemon.config().sandbox.enabled;
    let (instances, recent) = if sandbox {
        let root = crate::sandbox::effective_root(&daemon.config(), &daemon.paths);
        (
            daemon
                .registry
                .snapshot()
                .into_iter()
                .filter(|info| info.sandboxed)
                .collect(),
            daemon
                .recent
                .lock()
                .unwrap()
                .list()
                .iter()
                .filter(|folder| {
                    std::path::Path::new(folder.as_str()).starts_with(&root)
                        || crate::sandbox::folder_in_root(std::path::Path::new(folder), &root)
                })
                .cloned()
                .collect(),
        )
    } else {
        (
            daemon.registry.snapshot(),
            daemon.recent.lock().unwrap().list().to_vec(),
        )
    };
    Frame::msgpack(
        ty::WINDOWS,
        &Windows {
            instances,
            recent_folders: recent,
        },
    )
}

fn notice(conn: &Conn, notice: Notice) {
    conn.push(Frame::msgpack(ty::NOTICE, &notice));
}

/// One browser frame — the LAN socket and a Hub-tunneled session both call this.
pub fn handle(daemon: &Arc<Daemon>, conn: &Arc<Conn>, mut frame: Frame) {
    if is_relay_bound(frame.ty) {
        crate::router::to_relay(daemon, conn, frame);
        return;
    }
    if frame.decompress().is_err() {
        return;
    }
    match frame.ty {
        ty::ATTACH => {
            let Some(attach) = frame.decode_msgpack::<Attach>() else {
                return;
            };
            let daemon = daemon.clone();
            let conn = conn.clone();
            tokio::spawn(async move {
                if !remote_may_drive(&daemon, &attach.instance) {
                    conn.close(code::INSTANCE_GONE, "instance-exited");
                    return;
                }
                match crate::router::attach(&daemon, &conn, &attach.instance).await {
                    Ok(attached) => conn.push(Frame::msgpack(ty::ATTACHED, &attached)),
                    Err(crate::router::AttachError::NoInstance) => {
                        conn.close(code::INSTANCE_GONE, "instance-exited")
                    }
                    Err(crate::router::AttachError::RelayTimeout) => notice(
                        &conn,
                        Notice {
                            instance: Some(attach.instance.clone()),
                            message: Some("the window did not answer in time".into()),
                            ..Notice::kind("attach-failed")
                        },
                    ),
                }
            });
        }
        ty::DETACH => crate::router::detach(daemon, conn),
        ty::CREDIT => {
            if let Some(credit) = frame.decode_msgpack::<Credit>() {
                conn.grant(credit.bytes, credit.ack_seq);
            }
        }
        ty::PING => {
            if let Some(pong) = frame.decode_msgpack::<Pong>() {
                conn.ack(pong.ack_seq);
            }
            conn.push(
                Frame::msgpack(
                    ty::PONG,
                    &Pong {
                        ack_seq: conn.acked(),
                    },
                )
                .with_stream(frame.stream),
            );
        }
        ty::PONG => {
            if let Some(pong) = frame.decode_msgpack::<Pong>() {
                conn.ack(pong.ack_seq);
            }
        }
        ty::SPAWN => {
            // SPAWN is the PC user's own (docs/remote-client-plan.md §3.3): the tray and
            // the management API spawn through `lifecycle::spawn` in-process; a frame on
            // this socket is by definition a browser session's, and a session switches
            // between the windows the PC already opened — it never creates one (K4).
            let _ = frame.decode_msgpack::<Spawn>();
            notice(
                conn,
                Notice {
                    message: Some(
                        "spawning windows is the PC user's own — open one at the PC".to_owned(),
                    ),
                    ..Notice::kind("spawn-failed")
                },
            );
        }
        ty::INSTANCE_CLOSE => {
            let Some(close) = frame.decode_msgpack::<InstanceClose>() else {
                return;
            };
            let (daemon, conn) = (daemon.clone(), conn.clone());
            tokio::spawn(async move {
                // The same boundary as ATTACH (2026-10-13 audit F1): a desktop window is
                // not a remote session's to close or force-kill either.
                if !remote_may_drive(&daemon, &close.instance) {
                    notice(
                        &conn,
                        Notice {
                            instance: Some(close.instance.clone()),
                            ..Notice::kind("instance-exited")
                        },
                    );
                    return;
                }
                match crate::lifecycle::close(&daemon, &close.instance, close.force).await {
                    crate::lifecycle::CloseOutcome::Blocked(dirty) => notice(
                        &conn,
                        Notice {
                            instance: Some(close.instance.clone()),
                            dirty,
                            ..Notice::kind("close-blocked")
                        },
                    ),
                    crate::lifecycle::CloseOutcome::Missing => notice(
                        &conn,
                        Notice {
                            instance: Some(close.instance.clone()),
                            ..Notice::kind("instance-exited")
                        },
                    ),
                    crate::lifecycle::CloseOutcome::Closed => {}
                }
            });
        }
        ty::INSTANCE_RESTART => {
            let Some(restart) = frame.decode_msgpack::<InstanceRestart>() else {
                return;
            };
            let (daemon, conn) = (daemon.clone(), conn.clone());
            tokio::spawn(async move {
                if !remote_may_drive(&daemon, &restart.instance) {
                    notice(
                        &conn,
                        Notice {
                            instance: Some(restart.instance.clone()),
                            ..Notice::kind("restart-failed")
                        },
                    );
                    return;
                }
                match crate::lifecycle::restart(&daemon, &restart.instance).await {
                    Ok(instance) => conn.push(Frame::msgpack(ty::SPAWNED, &Spawned { instance })),
                    Err(message) => notice(
                        &conn,
                        Notice {
                            instance: Some(restart.instance.clone()),
                            message: Some(message),
                            ..Notice::kind("restart-failed")
                        },
                    ),
                }
            });
        }
        // A session showing or hiding the PC's window (§17.4): the window goes away or
        // comes back, the instance itself never stops — and the session that asked stays
        // attached either way. The same boundary as ATTACH and INSTANCE_CLOSE: with the
        // sandbox on, a desktop window is not a remote session's to touch.
        ty::INSTANCE_DISPLAY => {
            let Some(display) = frame.decode_msgpack::<InstanceDisplay>() else {
                return;
            };
            let (daemon, conn) = (daemon.clone(), conn.clone());
            tokio::spawn(async move {
                if !remote_may_drive(&daemon, &display.instance) {
                    notice(
                        &conn,
                        Notice {
                            instance: Some(display.instance.clone()),
                            message: Some(
                                "that window is not a remote session's to touch".into(),
                            ),
                            ..Notice::kind("display-failed")
                        },
                    );
                    return;
                }
                let message = if display.visible {
                    ToInstance::Show
                } else {
                    ToInstance::Hide
                };
                if !daemon.registry.send(&display.instance, message) {
                    notice(
                        &conn,
                        Notice {
                            instance: Some(display.instance.clone()),
                            ..Notice::kind("instance-exited")
                        },
                    );
                }
            });
        }
        _ => {}
    }
}
