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
    // a plain offline PC from every other vantage. The refresh runs at the handshake itself
    // (the contract's other half — cheap while the file is unchanged): without it a newly
    // listed uuid could still handshake until the next 30 s tick.
    hub.blocklist.refresh();
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

    // Capacity counts distinct PCs, not connections of the same one. The check and the
    // register are one critical section (`register_within_limit`): a check-then-register
    // pair made before let two concurrent handshakes for different uuids each observe
    // `count == max - 1` and both register, overshooting `max_tunnels`.
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let tunnel = Arc::new(hub.new_tunnel(uuid.clone(), tx));
    // The tunnel joins the table BEFORE T_READY leaves: the daemon reports Online the
    // instant it hears T_READY, and a request landing in the gap between the send and
    // the registration found the uuid "not online" — the first login after `wait_online`
    // raced it and drew a 503 under CI load.
    let Some(displaced) = hub.register_within_limit(uuid.clone(), tunnel.clone()) else {
        crate::warn!("tunnel for {uuid} refused: at capacity");
        reject(&mut sink, "capacity").await;
        return;
    };
    if let Some(displaced) = displaced {
        // The same device key connected again: the newcomer wins (§20.1). The old tunnel's
        // run loop sees T_REPLACED on its own writer, tells its browsers, and unwinds.
        let _ = displaced.send(&Frame::raw(ty::T_REPLACED, 0, Vec::new()));
        displaced.close_all(1001, "link-changed");
        crate::info!("tunnel {uuid}: replaced by a newer connection");
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
        hub.unregister(&uuid, tunnel.id);
        tunnel.close_all(4503, "pc-offline");
        return;
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
    'pump: loop {
        tokio::select! {
            message = stream.next() => {
                let Some(Ok(message)) = message else { break };
                missed = 0;
                let Message::Binary(bytes) = message else { continue };
                let Some(frames) = Frame::decode_all(&bytes) else { break };
                for frame in frames {
                    // A refused route (the daily byte budget spent) must stop the tunnel,
                    // not just this batch — a bare `break` left the select loop running an
                    // online-but-dead registration: Online forever, every frame dropped.
                    if !route(&hub, &tunnel, frame) {
                        break 'pump;
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
    // The joint login's verifier (§20.14): the daemon's Argon2id hash, right after
    // T_READY and again on every password change. With it the Hub serves the login page
    // and checks the password itself; an epoch change ends every Hub-side login issued
    // under the old password — the daemon ends its own sessions at the same moment.
    if frame.ty == ty::T_CREDENTIAL {
        if let Some(presented) = frame.decode_msgpack::<crate::msg::TCredential>() {
            let plausible = credential_plausible(&presented.hash, &presented.lang);
            if plausible {
                let next = crate::state::Credential {
                    hash: presented.hash,
                    epoch: presented.epoch,
                    lang: presented.lang,
                };
                let moved = tunnel.set_credential(next);
                hub.audit.log(
                    "credential",
                    &[
                        ("uuid", serde_json::json!(tunnel.uuid)),
                        ("epoch", serde_json::json!(presented.epoch)),
                        ("changed", serde_json::json!(moved)),
                    ],
                );
                if moved {
                    crate::info!(
                        "tunnel {}: password changed on the PC — link logins ended",
                        tunnel.uuid
                    );
                    hub.drop_link_sessions(&tunnel.uuid);
                }
            } else {
                crate::warn!(
                    "tunnel {}: a malformed credential frame was ignored",
                    tunnel.uuid
                );
            }
        }
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

/// The verifier's PHC parameters must sit inside bounds the Hub's verify pool can carry:
/// the hash crosses from the daemon, and the Argon2 verify reads m/t/p out of the string
/// itself — a hostile one spelling `$argon2id$v=19$m=1048576,t=1,p=1$…` (still well under
/// the 512-char length gate) allocates a GiB per attempt through the Hub's own login
/// corner, OOMing it. The daemon's real parameters (19 MiB, two passes, one lane) sit far
/// inside; a PHC string missing any of the three is not one the daemon writes.
fn credential_plausible(hash: &str, lang: &str) -> bool {
    /// m in KiB, at most 64 MiB — the daemon ships 19 MiB (19456).
    const MAX_M_KIB: u64 = 65_536;
    const MAX_T: u64 = 8;
    const MAX_P: u64 = 4;
    if !(hash.starts_with("$argon2") && hash.len() <= 512 && lang.len() <= 16) {
        return false;
    }
    // `$argon2id$v=19$m=19456,t=2,p=1$salt$digest` — the parameters are the third `$`
    // segment's `key=value` list.
    let Some(params) = hash.split('$').nth(3) else {
        return false;
    };
    let (mut m, mut t, mut p) = (None, None, None);
    for pair in params.split(',') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let Ok(value) = value.parse::<u64>() else {
            continue;
        };
        match key {
            "m" => m = Some(value),
            "t" => t = Some(value),
            "p" => p = Some(value),
            _ => {}
        }
    }
    m.is_some_and(|m| m <= MAX_M_KIB)
        && t.is_some_and(|t| t <= MAX_T)
        && p.is_some_and(|p| p <= MAX_P)
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
    fn credential_plausibility_bounds_the_phc_parameters() {
        // The daemon's own shape passes.
        assert!(credential_plausible(
            "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$ZGlnZXN0",
            "zh-cn"
        ));
        // Memory is the attack: 1 GiB (and anything past 64 MiB) is refused outright.
        assert!(!credential_plausible(
            "$argon2id$v=19$m=1048576,t=1,p=1$c2FsdA$ZGlnZXN0",
            "en"
        ));
        assert!(!credential_plausible(
            "$argon2id$v=19$m=19456,t=99,p=1$c2FsdA$ZGlnZXN0",
            "en"
        ));
        assert!(!credential_plausible(
            "$argon2id$v=19$m=19456,t=2,p=9$c2FsdA$ZGlnZXN0",
            "en"
        ));
        // A missing parameter, a non-PHC string, an over-long language: all refused.
        assert!(!credential_plausible(
            "$argon2id$v=19$m=19456,t=2$c2FsdA$ZGlnZXN0",
            "en"
        ));
        assert!(!credential_plausible("not-a-hash", "en"));
        assert!(!credential_plausible(
            "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$ZGlnZXN0",
            "an-over-long-language-tag"
        ));
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
