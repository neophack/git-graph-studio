//! The `/tunnel` WebSocket (docs/ggs-remote-plan.md §20.3–§20.4): a PC's outbound connection
//! and its handshake — key → uuid, challenge → signature, `T_READY` — then the frame pump.
//! The Hub never looks inside a browser frame's payload: it stamps the `session` field
//! between the browser side (always 0) and the tunnel (its own number per connection), and
//! moves bytes.

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use subtle::ConstantTimeEq;
use tokio::sync::mpsc;

use crate::config::Config;
use crate::frame::{ty, Frame};
use crate::identity;
use crate::msg::{ConnClose, Limits, TAuth, TChallenge, THello, TReady, TRejected, PROTO};
use crate::state::{Hub, Tunnel};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// §20.4: heartbeat every 25 s, reconnect after three misses.
const HEARTBEAT: Duration = Duration::from_secs(25);
const MISSES: u32 = 3;

pub async fn tunnel_handler(
    State(hub): State<Arc<Hub>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    // Proxy-aware (audit H-1): behind a front proxy the raw peer is the proxy's address,
    // and one fleet plus every attacker would share a single handshake bucket.
    let peer_addr = crate::http_proxy::peer_ip(&hub, peer.ip(), &{
        let mut request = Request::new(axum::body::Body::empty());
        *request.headers_mut() = headers.clone();
        request
    });
    if !hub.hello_allowed(peer_addr) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    upgrade
        .max_message_size(crate::frame::MAX_PAYLOAD + 64)
        .on_upgrade(move |socket| run(hub, socket, peer, host))
}

async fn reject(sink: &mut futures_util::stream::SplitSink<WebSocket, Message>, reason: &str) {
    let frame = Frame::msgpack(
        ty::T_REJECTED,
        &TRejected {
            reason: reason.into(),
        },
    );
    let _ = sink.send(Message::Binary(frame.encode().into())).await;
    let _ = sink
        .send(Message::Close(Some(CloseFrame {
            code: 1008,
            reason: "rejected".into(),
        })))
        .await;
}

async fn run(hub: Arc<Hub>, socket: WebSocket, peer: SocketAddr, host: Option<String>) {
    let (mut sink, mut stream) = socket.split();

    // T_HELLO — the key names the PC; the join key names the server.
    let hello = match tokio::time::timeout(HANDSHAKE_TIMEOUT, stream.next()).await {
        Ok(Some(Ok(Message::Binary(bytes)))) => Frame::decode_all(&bytes)
            .and_then(|frames| frames.into_iter().next())
            .filter(|f| f.ty == ty::T_HELLO)
            .and_then(|f| f.decode_msgpack::<THello>()),
        _ => None,
    };
    let Some(hello) = hello else {
        reject(&mut sink, "version").await;
        return;
    };
    if hello.proto != PROTO {
        reject(&mut sink, "version").await;
        return;
    }
    if !join_key_ok(&hub.config, hello.join_key.as_deref().unwrap_or("")) {
        crate::warn!("tunnel from {} refused: wrong join key", peer.ip());
        reject(&mut sink, "join-key").await;
        return;
    }
    let Ok(public_key) = hello.pubkey.clone().try_into() else {
        reject(&mut sink, "auth").await;
        return;
    };
    let uuid = identity::uuid_for(&public_key);

    // Challenge → signature: proves this key owns the uuid it derives to, bound to this Hub's
    // host name so a capture taken at one Hub is worthless at another (§20.6).
    let bind_host = host
        .clone()
        .or_else(|| configured_host(&hub.config))
        .unwrap_or_default();
    let nonce = crate::util::random_bytes::<32>();
    let challenge = Frame::msgpack(
        ty::T_CHALLENGE,
        &TChallenge {
            nonce: nonce.to_vec(),
            host: bind_host.clone(),
        },
    );
    if sink
        .send(Message::Binary(challenge.encode().into()))
        .await
        .is_err()
    {
        return;
    }
    let auth = match tokio::time::timeout(HANDSHAKE_TIMEOUT, stream.next()).await {
        Ok(Some(Ok(Message::Binary(bytes)))) => Frame::decode_all(&bytes)
            .and_then(|frames| frames.into_iter().next())
            .filter(|f| f.ty == ty::T_AUTH)
            .and_then(|f| f.decode_msgpack::<TAuth>()),
        _ => None,
    };
    let Some(auth) = auth else {
        reject(&mut sink, "auth").await;
        return;
    };
    if !identity::verify(&public_key, &nonce, &bind_host, &auth.sig) {
        crate::warn!("tunnel for {uuid} refused: bad signature");
        reject(&mut sink, "auth").await;
        return;
    }

    // The operator's kill switch (§20.6): a blocklisted device key is refused here and its
    // online tunnel (if any) is taken off the air by the periodic refresh — both look like
    // a plain offline PC from every other vantage.
    if hub.blocklist.blocked(&uuid) {
        crate::warn!("tunnel for {uuid} refused: blocklisted");
        hub.audit.log(
            "tunnel_refused",
            &[
                ("uuid", serde_json::json!(uuid)),
                ("ip", serde_json::json!(peer.ip().to_string())),
                ("reason", serde_json::json!("banned")),
            ],
        );
        reject(&mut sink, "banned").await;
        return;
    }

    // Capacity counts distinct PCs, not connections of the same one.
    if hub.tunnel(&uuid).is_none() && hub.tunnel_count() >= hub.config.max_tunnels {
        crate::warn!("tunnel for {uuid} refused: at capacity");
        reject(&mut sink, "capacity").await;
        return;
    }

    let public_origin = hub.config.public_origin(host.as_deref());
    let base_path = format!("/u/{uuid}/");
    let ready = Frame::msgpack(
        ty::T_READY,
        &TReady {
            uuid: uuid.clone(),
            public_base: format!("{public_origin}/u/{uuid}/"),
            base_path: base_path.clone(),
            limits: Limits {
                sessions: hub.config.sessions_per_tunnel as u32,
                bytes_per_day: hub.config.bytes_per_day_per_tunnel,
            },
        },
    );
    if sink
        .send(Message::Binary(ready.encode().into()))
        .await
        .is_err()
    {
        return;
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let tunnel = Arc::new(hub.new_tunnel(uuid.clone(), tx));
    if let Some(displaced) = hub.register(uuid.clone(), tunnel.clone()) {
        // The same device key connected again: the newcomer wins (§20.1). The old tunnel's
        // run loop sees T_REPLACED on its own writer, tells its browsers, and unwinds.
        let _ = displaced.send(&Frame::raw(ty::T_REPLACED, 0, Vec::new()));
        displaced.close_all(1001, "link-changed");
        crate::info!("tunnel {uuid}: replaced by a newer connection");
    }
    crate::info!("tunnel {uuid} online from {}", peer.ip());
    hub.audit.log(
        "tunnel_online",
        &[
            ("uuid", serde_json::json!(uuid)),
            ("ip", serde_json::json!(peer.ip().to_string())),
        ],
    );

    // The writer: everything the Hub sends the PC — browser frames (session stamped),
    // heartbeats, the goodbye — goes through the tunnel's channel so ordering is one queue.
    let writer = tokio::spawn(async move {
        while let Some(bytes) = rx.recv().await {
            if sink.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let mut beat = tokio::time::interval(HEARTBEAT);
    beat.tick().await; // the first tick is immediate
    let mut missed = 0u32;
    let mut kicked = false;
    loop {
        tokio::select! {
            message = stream.next() => {
                let Some(Ok(message)) = message else { break };
                missed = 0;
                let Message::Binary(bytes) = message else { continue };
                let Some(frames) = Frame::decode_all(&bytes) else { break };
                for frame in frames {
                    if !route(&hub, &tunnel, frame) {
                        break;
                    }
                }
            }
            _ = beat.tick() => {
                missed += 1;
                if missed >= MISSES {
                    crate::warn!("tunnel {uuid}: missed {missed} heartbeats");
                    break;
                }
                if !tunnel.send(&Frame::raw(ty::T_PING, 0, Vec::new())) {
                    break;
                }
            }
            // The blocklist's kill: `kill()` stored its permit, so this arm wakes on the
            // next poll and the exit path below takes the tunnel off the table.
            _ = tunnel.killed.notified() => {
                kicked = true;
                break;
            }
        }
    }

    hub.unregister(&uuid, tunnel.id);
    tunnel.close_all(4503, "pc-offline");
    writer.abort();
    hub.audit.log(
        "tunnel_offline",
        &[
            ("uuid", serde_json::json!(uuid)),
            (
                "reason",
                serde_json::json!(if kicked { "blocked" } else { "gone" }),
            ),
        ],
    );
    crate::info!("tunnel {uuid} offline");
}

/// One frame from the PC. Answers `false` when the tunnel must stop.
fn route(hub: &Arc<Hub>, tunnel: &Arc<Tunnel>, mut frame: Frame) -> bool {
    if frame.ty == ty::T_PONG {
        return true;
    }
    if frame.ty == ty::CONN_CLOSE {
        if let Some(close) = frame.decode_msgpack::<ConnClose>() {
            tunnel.close_conn(close.session, close.code, &close.reason);
        }
        return true;
    }
    if frame.session == 0 {
        // Only tunnel control may ride session 0 here, and it was handled above.
        return true;
    }
    let session = frame.session;
    // Toward the browser the link's session is always 0 (§6.1).
    frame.session = 0;
    let message = frame.encode();
    hub.counters
        .bytes_up
        .fetch_add(message.len() as u64, Ordering::Relaxed);
    if !tunnel.spend(message.len() as u64) {
        crate::warn!("tunnel {}: daily byte budget spent", tunnel.uuid);
        return false;
    }
    tunnel.to_conn(session, message);
    true
}

fn join_key_ok(config: &Config, given: &str) -> bool {
    let expected = config.join_key.as_bytes();
    if expected.is_empty() {
        return true;
    }
    given.as_bytes().ct_eq(expected).into()
}

fn configured_host(config: &Config) -> Option<String> {
    let url = config.public_url.trim_end_matches('/');
    let rest = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let host = rest.split(':').next().unwrap_or(rest);
    (!host.is_empty()).then(|| host.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_join_key_admits_anything() {
        let config = Config::default();
        assert!(join_key_ok(&config, ""));
        assert!(join_key_ok(&config, "whatever"));
    }

    #[test]
    fn a_join_key_is_compared_in_constant_time() {
        let config = Config {
            join_key: "sesame".into(),
            ..Config::default()
        };
        assert!(join_key_ok(&config, "sesame"));
        assert!(!join_key_ok(&config, "sesam"));
        assert!(!join_key_ok(&config, "sesames"));
        assert!(!join_key_ok(&config, ""));
    }

    #[test]
    fn the_host_comes_from_the_public_url() {
        let config = Config {
            public_url: "https://remote.example.com".into(),
            ..Config::default()
        };
        assert_eq!(
            configured_host(&config).as_deref(),
            Some("remote.example.com")
        );
        let config = Config {
            public_url: "https://remote.example.com:9443/".into(),
            ..Config::default()
        };
        assert_eq!(
            configured_host(&config).as_deref(),
            Some("remote.example.com")
        );
    }
}
