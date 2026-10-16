//! End-to-end: a real Hub on a loopback port (plain HTTP), fake PCs speaking the tunnel
//! protocol over tokio-tungstenite, and a fake browser — the plan's §20.12 tunnel suite:
//! the handshake, the join key, replacement, the offline page, HTTP proxying, the WebSocket
//! bridge, the silence outside the links and two PCs never hearing each other's traffic.

use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use ggs_remote_hub::config::Config;
use ggs_remote_hub::frame::{flag, ty, Frame};
use ggs_remote_hub::identity;
use ggs_remote_hub::msg::{ConnClose, ConnOpen, HttpReq, HttpRes, TAuth, THello, TReady, PROTO};
use ggs_remote_hub::state::Hub;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

struct Fixture {
    hub: std::net::SocketAddr,
    state: Arc<Hub>,
    _stop: tokio::sync::oneshot::Sender<()>,
}

/// The shipped stack verbatim (§20.5): the router behind the silence gate on
/// axum-server — the same `gated` service `serve` runs, so what the suite exercises is
/// what a deployment serves.
async fn start_hub(config: Config) -> Fixture {
    let hub = Hub::new(config);
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let addr = listener.local_addr().unwrap();
    let app = ggs_remote_hub::gated(hub.clone());
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let server = axum_server::from_tcp(listener);
        tokio::select! {
            _ = server.serve(app) => {}
            _ = stopped => {}
        }
    });
    Fixture {
        hub: addr,
        state: hub,
        _stop: stop,
    }
}

type Pc = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// One fake PC: connect, prove its key, answer T_READY. `host` is what the links spell.
async fn pc(addr: std::net::SocketAddr, signing: &SigningKey, join_key: Option<&str>) -> Pc {
    let url = format!("ws://{addr}/tunnel");
    let mut request = url.as_str().into_client_request().unwrap();
    request.headers_mut().insert(
        "Host",
        format!("127.0.0.1:{}", addr.port()).parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let hello = THello {
        pubkey: signing.verifying_key().to_bytes().to_vec(),
        join_key: join_key.map(str::to_owned),
        daemon_version: "test".into(),
        proto: PROTO,
    };
    ws.send(Message::Binary(
        Frame::msgpack(ty::T_HELLO, &hello).encode().into(),
    ))
    .await
    .unwrap();
    ws
}

async fn next_frames(ws: &mut Pc) -> Vec<Frame> {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Message::Binary(bytes)))) => {
                if let Some(frames) = Frame::decode_all(&bytes) {
                    return frames;
                }
            }
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => panic!("tunnel closed"),
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(e))) => panic!("tunnel error: {e}"),
            Err(_) => panic!("timed out waiting for a tunnel frame"),
        }
    }
}

/// Complete the challenge handshake in place.
async fn answer_challenge(ws: &mut Pc, signing: &SigningKey, host: &str) -> TReady {
    let frames = next_frames(ws).await;
    let challenge = frames
        .iter()
        .find(|f| f.ty == ty::T_CHALLENGE)
        .and_then(|f| f.decode_msgpack::<ggs_remote_hub::msg::TChallenge>())
        .expect("a challenge");
    let message = identity::auth_message(&challenge.nonce, &challenge.host);
    ws.send(Message::Binary(
        Frame::msgpack(
            ty::T_AUTH,
            &TAuth {
                sig: signing.sign(&message).to_bytes().to_vec(),
            },
        )
        .encode()
        .into(),
    ))
    .await
    .unwrap();
    let frames = next_frames(ws).await;
    let ready = frames
        .iter()
        .find(|f| f.ty == ty::T_READY)
        .and_then(|f| f.decode_msgpack::<TReady>())
        .expect("T_READY");
    assert_eq!(challenge.host, host);
    ready
}

async fn http(
    addr: std::net::SocketAddr,
    method: &'static str,
    path: String,
    headers: &'static [(&'static str, &'static str)],
    body: Option<&'static str>,
) -> (u16, String, String) {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let body = body.unwrap_or("");
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nContent-Length: {}\r\n",
        addr.port(),
        body.len()
    );
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(body);
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, rest) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let chunked = head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked");
    let body = if chunked {
        dechunk(rest)
    } else {
        rest.to_owned()
    };
    (status, head.to_owned(), body)
}

fn dechunk(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    while let Some((size, tail)) = rest.split_once("\r\n") {
        let Ok(size) = usize::from_str_radix(size.trim(), 16) else {
            break;
        };
        if size == 0 {
            break;
        }
        let bytes: Vec<u8> = tail.bytes().take(size).collect();
        out.push_str(&String::from_utf8_lossy(&bytes));
        rest = tail.get(size..).unwrap_or("");
    }
    out
}

/// Answer one proxied HTTP request from the PC side with a fixed body. A request crosses as
/// its own head message followed by a FIN-only one — back-to-back requests leave that FIN
/// queued, so the hunt for a decodable head spans messages.
async fn serve_one_http(ws: &mut Pc, status: u16, body: &str) -> HttpReq {
    let (head, session) = loop {
        let frames = next_frames(ws).await;
        let mut found = None;
        for frame in &frames {
            if frame.ty == ty::HTTP_REQ {
                if let Some(head) = frame.decode_msgpack::<HttpReq>() {
                    found = Some((head, frame.session));
                }
            }
        }
        if let Some(found) = found {
            break found;
        }
    };
    let res = Frame::msgpack(
        ty::HTTP_RES,
        &HttpRes {
            status,
            headers: vec![
                ("content-type".into(), "text/plain".into()),
                ("content-length".into(), body.len().to_string()),
            ],
        },
    )
    .with_session(session);
    let fin = Frame::raw(ty::HTTP_RES, session, body.as_bytes().to_vec()).with_flags(flag::FIN);
    ws.send(Message::Binary(
        [res.encode(), fin.encode()].concat().into(),
    ))
    .await
    .unwrap();
    head
}

#[tokio::test]
async fn the_handshake_and_an_http_round_trip() {
    let fixture = start_hub(Config::default()).await;
    let signing = SigningKey::from_bytes(&[7u8; 32]);
    let mut ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut ws, &signing, &host).await;
    let uuid = identity::uuid_for(&signing.verifying_key().to_bytes());
    assert_eq!(ready.uuid, uuid);
    assert_eq!(ready.base_path, format!("/u/{uuid}/"));
    assert!(ready.public_base.ends_with(&format!("/u/{uuid}/")));

    // A request for this PC's path reaches the tunnel, and its answer reaches the browser.
    let request = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/login"),
        &[("Cookie", "ggsr=tok")],
        None,
    ));
    let seen = serve_one_http(&mut ws, 200, "the login page").await;
    let (status, _head, body) = request.await.unwrap();
    assert_eq!(status, 200);
    assert_eq!(body, "the login page");
    // The PC saw the request stripped of the prefix, with its cookie and base path intact.
    assert_eq!(seen.path, "/login");
    assert_eq!(
        seen.headers.get("cookie").map(String::as_str),
        Some("ggsr=tok")
    );
    assert_eq!(
        seen.headers.get("x-ggs-base-path").map(String::as_str),
        Some(format!("/u/{uuid}/").as_str())
    );
    // The scheme the browser spoke rides along: the daemon's session cookie marks `Secure`
    // only for https (§7.6 — a plain-HTTP browser silently drops a Secure cookie).
    assert_eq!(
        seen.headers.get("x-forwarded-proto").map(String::as_str),
        Some("http")
    );
}

/// `trust_proxy` set: a front proxy's own `x-forwarded-proto` (Caddy ending TLS in front of
/// a `tls = "none"` Hub) is the browser's real scheme and must win over the listener's.
/// Without trust the Hub derives it from its own TLS mode and ignores the wire's copy.
#[tokio::test]
async fn the_forwarded_proto_follows_the_front_proxy_when_trusted() {
    let fronted = Config {
        trust_proxy: true,
        ..Config::default()
    };
    let fixture = start_hub(fronted).await;
    let signing = SigningKey::from_bytes(&[9u8; 32]);
    let mut ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let _ready = answer_challenge(&mut ws, &signing, &host).await;
    let uuid = identity::uuid_for(&signing.verifying_key().to_bytes());

    let request = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/login"),
        &[("X-Forwarded-Proto", "https")],
        None,
    ));
    let seen = serve_one_http(&mut ws, 200, "ok").await;
    let (_status, _head, _body) = request.await.unwrap();
    assert_eq!(
        seen.headers.get("x-forwarded-proto").map(String::as_str),
        Some("https")
    );

    // Untrusted: the Hub speaks for itself (a browser cannot spoof the scheme through it).
    let fixture = start_hub(Config::default()).await;
    let signing = SigningKey::from_bytes(&[11u8; 32]);
    let mut ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let _ready = answer_challenge(&mut ws, &signing, &host).await;
    let uuid = identity::uuid_for(&signing.verifying_key().to_bytes());
    let request = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/login"),
        &[("X-Forwarded-Proto", "https")],
        None,
    ));
    let seen = serve_one_http(&mut ws, 200, "ok").await;
    let (_status, _head, _body) = request.await.unwrap();
    assert_eq!(
        seen.headers.get("x-forwarded-proto").map(String::as_str),
        Some("http")
    );
}

/// The canonical link a PC hands out spells the trailing slash (`T_READY.publicBase`), and a
/// hand-typed one may strip it: both must reach the tunnel as the PC's own `/` — before the
/// router knew these shapes, the canonical link answered a bare 404 and the stripped one a
/// 500 from the two-parameter extractor on a one-parameter route.
#[tokio::test]
async fn the_link_shapes_a_browser_opens_reach_the_pc() {
    let fixture = start_hub(Config::default()).await;
    let signing = SigningKey::from_bytes(&[5u8; 32]);
    let mut ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut ws, &signing, &host).await;
    let uuid = &ready.uuid;

    for path in [format!("/u/{uuid}/"), format!("/u/{uuid}")] {
        let request = tokio::spawn(http(fixture.hub, "GET", path.clone(), &[], None));
        let seen = serve_one_http(&mut ws, 302, "redirected").await;
        let (status, head, body) = request.await.unwrap();
        assert_eq!(status, 302, "{path}: {head}");
        assert_eq!(body, "redirected", "{path}");
        // The PC saw its own root, with the base path a redirect needs to stay on its link.
        assert_eq!(seen.path, "/", "{path}");
        assert_eq!(
            seen.headers.get("x-ggs-base-path").map(String::as_str),
            Some(format!("/u/{uuid}/").as_str()),
            "{path}"
        );
    }
}

#[tokio::test]
async fn a_wrong_join_key_is_refused() {
    let config = Config {
        join_key: "sesame".into(),
        ..Config::default()
    };
    let fixture = start_hub(config).await;
    let signing = SigningKey::from_bytes(&[1u8; 32]);
    let mut ws = pc(fixture.hub, &signing, Some("open")).await;
    let frames = next_frames(&mut ws).await;
    let rejected = frames
        .iter()
        .find(|f| f.ty == ty::T_REJECTED)
        .and_then(|f| f.decode_msgpack::<ggs_remote_hub::msg::TRejected>());
    assert_eq!(rejected.map(|r| r.reason), Some("join-key".into()));
}

#[tokio::test]
async fn a_second_connection_with_the_same_key_replaces_the_first() {
    let fixture = start_hub(Config::default()).await;
    let signing = SigningKey::from_bytes(&[2u8; 32]);
    let mut first = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    answer_challenge(&mut first, &signing, &host).await;
    let mut second = pc(fixture.hub, &signing, None).await;
    answer_challenge(&mut second, &signing, &host).await;
    let frames = next_frames(&mut first).await;
    assert!(
        frames.iter().any(|f| f.ty == ty::T_REPLACED),
        "the first tunnel must hear T_REPLACED"
    );
}

#[tokio::test]
async fn a_not_online_link_answers_the_same_page() {
    let fixture = start_hub(Config::default()).await;
    // Well-formed uuids only — the gate drops a malformed segment before the router ever
    // sees it. Unknown and away answer the same page, not on a router 404 or an
    // extractor 500; both bare link shapes included.
    for path in [
        "/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3/login",
        "/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3/",
        "/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3",
    ] {
        let (status, _head, body) = http(fixture.hub, "GET", path.to_owned(), &[], None).await;
        assert_eq!(status, 503, "{path}");
        // The page's own fallback refresh (the script swaps it for a soft poll).
        assert!(body.contains("http-equiv=\"refresh\""), "{path}");
        assert!(body.contains("not online"), "{path}");
    }
}

/// §20.5, the silence: a request that does not address a well-formed `/u/<uuid>/…` link
/// (nor the PCs' `/tunnel` WebSocket handshake — every other test's `pc()` proves that leg
/// still passes) closes the connection with zero bytes, as if nothing had this port open.
/// The uuid shape is judged here too: a malformed segment is not a link.
#[tokio::test]
async fn paths_outside_the_links_answer_nothing() {
    let fixture = start_hub(Config::default()).await;
    for path in [
        "/",
        "/healthz",
        "/metrics",
        "/favicon.ico",
        "/wp-admin/setup.php",
        "/u",
        "/u/",
        "/u//x",
        // Not a uuid — the shape fails the gate, no page, no bytes.
        "/u/not-a-uuid",
        "/u/not-a-uuid/",
        "/u/not-a-uuid/login",
        "/u/3F9C2A6E-8B1D-8C7A-9E45-2D6F0B8A71C3",
        "/u/3f9c2a6e-8b1d-4c7a-9e45-2d6f0b8a71c3",
        // The PCs' own leg probed as plain HTTP — not a WebSocket handshake.
        "/tunnel",
    ] {
        let mut stream = tokio::net::TcpStream::connect(fixture.hub).await.unwrap();
        stream
            .write_all(
                format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        assert!(
            raw.is_empty(),
            "{path}: the port answered {} bytes",
            raw.len()
        );
    }
}

#[tokio::test]
async fn the_browser_websocket_rides_the_tunnel() {
    let fixture = start_hub(Config::default()).await;
    let signing = SigningKey::from_bytes(&[3u8; 32]);
    let mut pc_ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut pc_ws, &signing, &host).await;
    let uuid = &ready.uuid;

    let mut request = format!("ws://{}/u/{}/ws", fixture.hub, uuid)
        .as_str()
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Cookie", "ggsr=tok".parse().unwrap());
    let (mut browser, _) = tokio_tungstenite::connect_async(request).await.unwrap();

    // The PC hears CONN_OPEN with the browser's headers.
    let frames = next_frames(&mut pc_ws).await;
    let open = frames
        .iter()
        .find(|f| f.ty == ty::CONN_OPEN)
        .and_then(|f| f.decode_msgpack::<ConnOpen>())
        .expect("a CONN_OPEN");
    assert_eq!(open.kind, "ws");
    assert_eq!(
        open.headers.get("cookie").map(String::as_str),
        Some("ggsr=tok")
    );
    assert_eq!(open.base_path, format!("/u/{uuid}/"));
    // Tunnel control rides session 0 on the wire; the session number is in the payload.
    assert!(
        frames.iter().all(|f| f.session == 0),
        "tunnel control frames ride session 0"
    );
    let session = open.session;
    assert!(session != 0);

    // Uplink: the browser's frame arrives session-stamped.
    let hello = Frame::msgpack(0x01, &serde_json::json!({ "csrf": "x" }));
    browser
        .send(Message::Binary(hello.encode().into()))
        .await
        .unwrap();
    let frames = next_frames(&mut pc_ws).await;
    let up = frames
        .iter()
        .find(|f| f.ty == 0x01)
        .expect("the browser's HELLO");
    assert_eq!(up.session, session);

    // Downlink: the PC's frame reaches the browser with session 0.
    let pong = Frame::raw(0x52, session, b"pong".to_vec());
    pc_ws
        .send(Message::Binary(pong.encode().into()))
        .await
        .unwrap();
    let message = tokio::time::timeout(Duration::from_secs(5), browser.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let frames = Frame::decode_all(&message.into_data()).unwrap();
    let down = frames.first().unwrap();
    assert_eq!(down.ty, 0x52);
    assert_eq!(down.session, 0);

    // A daemon-side close (the 4401 of a password change) closes the browser socket.
    pc_ws
        .send(Message::Binary(
            Frame::msgpack(
                ty::CONN_CLOSE,
                &ConnClose {
                    session,
                    code: 4401,
                    reason: "credentials-changed".into(),
                },
            )
            .encode()
            .into(),
        ))
        .await
        .unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(5), browser.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(closed, Message::Close(_)));
}

#[tokio::test]
async fn two_pcs_never_hear_each_other() {
    let fixture = start_hub(Config::default()).await;
    let a = SigningKey::from_bytes(&[4u8; 32]);
    let b = SigningKey::from_bytes(&[5u8; 32]);
    let mut pc_a = pc(fixture.hub, &a, None).await;
    let mut pc_b = pc(fixture.hub, &b, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready_a = answer_challenge(&mut pc_a, &a, &host).await;
    let ready_b = answer_challenge(&mut pc_b, &b, &host).await;
    assert_ne!(ready_a.uuid, ready_b.uuid);

    // A request for A's link is served by A; B stays quiet.
    let request = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{}/api/session", ready_a.uuid),
        &[("Cookie", "ggsr=a-token")],
        None,
    ));
    let seen = serve_one_http(&mut pc_a, 200, "{}").await;
    let (_status, _head, _body) = request.await.unwrap();
    assert_eq!(seen.path, "/api/session");
    assert_eq!(
        seen.headers.get("cookie").map(String::as_str),
        Some("ggsr=a-token")
    );
    // B has nothing pending (the heartbeat gives it a moment to have delivered anything).
    let heard = tokio::time::timeout(Duration::from_millis(300), pc_b.next()).await;
    assert!(!matches!(heard, Ok(Some(Ok(Message::Binary(_))))));
}

/// §20.6 `http_rate`: the session ceiling caps concurrency, not rate — a single address
/// hammering one link sequentially needs its own guard, and one that does not throttle a
/// page's burst of asset loads (the cap here is per minute).
#[tokio::test]
async fn the_http_rate_refuses_a_hammering_ip() {
    let config = Config {
        http_rate: 1,
        ..Config::default()
    };
    let fixture = start_hub(config).await;
    let signing = SigningKey::from_bytes(&[21u8; 32]);
    let mut ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut ws, &signing, &host).await;

    let first = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{}/login", ready.uuid),
        &[],
        None,
    ));
    let _seen = serve_one_http(&mut ws, 200, "ok").await;
    assert_eq!(first.await.unwrap().0, 200);
    // The same IP inside the same minute: refused without waking the tunnel.
    let second = http(
        fixture.hub,
        "GET",
        format!("/u/{}/login", ready.uuid),
        &[],
        None,
    )
    .await;
    assert_eq!(second.0, 429, "{}", second.1);
}

/// §20.6 `visitors_per_day_per_tunnel`: a personal link has a handful of viewers, a link
/// shared like a public site hundreds — the second IP past the ceiling answers 429 while
/// the first keeps working. The browser IPs come from `x-forwarded-for` (`trust_proxy`
/// from a loopback front), which is how a real fronted deployment sees them.
#[tokio::test]
async fn the_visitor_ceiling_refuses_a_new_ip_but_not_a_seen_one() {
    let config = Config {
        trust_proxy: true,
        visitors_per_day_per_tunnel: 1,
        ..Config::default()
    };
    let fixture = start_hub(config).await;
    let signing = SigningKey::from_bytes(&[22u8; 32]);
    let mut ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut ws, &signing, &host).await;
    let uuid = &ready.uuid;

    let first = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/login"),
        &[("X-Forwarded-For", "203.0.113.31")],
        None,
    ));
    let _seen = serve_one_http(&mut ws, 200, "ok").await;
    assert_eq!(first.await.unwrap().0, 200);

    // The same viewer again: already inside the bucket, costs nothing.
    let again = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/windows"),
        &[("X-Forwarded-For", "203.0.113.31")],
        None,
    ));
    let _seen = serve_one_http(&mut ws, 200, "ok").await;
    assert_eq!(again.await.unwrap().0, 200);

    // A second distinct IP past the ceiling of one: 429, and the PC never hears a request
    // for it (the CONN_CLOSE of the answered requests above is ordinary bookkeeping).
    let stranger = http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/login"),
        &[("X-Forwarded-For", "203.0.113.32")],
        None,
    )
    .await;
    assert_eq!(stranger.0, 429, "{}", stranger.1);
    assert_eq!(stranger.2, "this link has too many viewers today");
    let mut drained = Vec::new();
    let heard = tokio::time::timeout(Duration::from_millis(300), ws.next()).await;
    if let Ok(Some(Ok(Message::Binary(bytes)))) = &heard {
        drained = bytes.to_vec();
    }
    assert!(
        !matches!(heard, Ok(Some(Err(_))) | Ok(None)),
        "the tunnel itself must stay up"
    );
    if let Some(frames) = Frame::decode_all(&drained) {
        assert!(
            !frames
                .iter()
                .any(|f| f.ty == ty::HTTP_REQ && f.decode_msgpack::<HttpReq>().is_some()),
            "the refused request must never reach the PC"
        );
    }
}

/// §20.6 `blocklist`: editing the file and refreshing takes the listed PC off the air —
/// its tunnel closes (browsers see the plain offline page), and its next handshake is
/// refused with `banned`.
#[tokio::test]
async fn the_blocklist_takes_a_pc_off_the_air() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("block.txt");
    std::fs::write(&file, "").unwrap();
    let config = Config {
        blocklist: file.to_str().unwrap().to_owned(),
        ..Config::default()
    };
    let fixture = start_hub(config).await;
    let signing = SigningKey::from_bytes(&[23u8; 32]);
    let mut ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut ws, &signing, &host).await;
    let uuid = ready.uuid.clone();

    // The operator lists the PC and the periodic refresh runs (the test calls it directly).
    std::fs::write(&file, format!("{uuid}\n")).unwrap();
    fixture.state.enforce_blocklist();
    let ended = tokio::time::timeout(Duration::from_secs(5), ws.next()).await;
    assert!(
        // Err is the abrupt close of the dropped socket — the tunnel is just as gone.
        matches!(
            ended,
            Ok(None) | Ok(Some(Ok(Message::Close(_)))) | Ok(Some(Err(_)))
        ),
        "the tunnel must end after the kick"
    );

    // The link now answers the plain offline page — indistinguishable from an away PC.
    let (status, _head, body) =
        http(fixture.hub, "GET", format!("/u/{uuid}/login"), &[], None).await;
    assert_eq!(status, 503);
    assert!(body.contains("not online"));

    // And the PC cannot handshake back in: rejected with `banned`.
    let mut again = pc(fixture.hub, &signing, None).await;
    let frames = next_frames(&mut again).await;
    let challenge = frames
        .iter()
        .find(|f| f.ty == ty::T_CHALLENGE)
        .and_then(|f| f.decode_msgpack::<ggs_remote_hub::msg::TChallenge>())
        .expect("a challenge");
    let message = identity::auth_message(&challenge.nonce, &challenge.host);
    again
        .send(Message::Binary(
            Frame::msgpack(
                ty::T_AUTH,
                &TAuth {
                    sig: signing.sign(&message).to_bytes().to_vec(),
                },
            )
            .encode()
            .into(),
        ))
        .await
        .unwrap();
    let frames = next_frames(&mut again).await;
    let rejected = frames
        .iter()
        .find(|f| f.ty == ty::T_REJECTED)
        .and_then(|f| f.decode_msgpack::<ggs_remote_hub::msg::TRejected>());
    assert_eq!(
        rejected.map(|r| r.reason),
        Some("banned".into()),
        "the same device key must be refused"
    );
}

/// The `SessionSlot` regression, end to end: with a session ceiling of one, a browser that
/// abandons its request before the PC's answer (the connection dropped mid-await) must not
/// hold the ceiling hostage — before the guard, eight such ghosts would brick a default
/// tunnel and one is enough at ceiling 1.
#[tokio::test]
async fn an_abandoned_request_frees_the_tunnel_for_the_next_one() {
    let config = Config {
        sessions_per_tunnel: 1,
        ..Config::default()
    };
    let fixture = start_hub(config).await;
    let signing = SigningKey::from_bytes(&[24u8; 32]);
    let mut ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut ws, &signing, &host).await;
    let uuid = &ready.uuid;

    // One request whose client vanishes before the PC answers it.
    let mut ghost = tokio::net::TcpStream::connect(fixture.hub).await.unwrap();
    ghost
        .write_all(
            format!(
                "GET /u/{uuid}/login HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
                fixture.hub.port()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    // The PC seeing the request means the session is allocated and parked on the answer.
    let _head = serve_one_http_head_only(&mut ws).await;
    drop(ghost);

    // The cancelled request's slot frees (the browser is gone, hyper dropped the handler).
    let tunnel = fixture.state.tunnel(uuid).expect("the tunnel");
    let deadline = tokio::time::timeout(Duration::from_secs(5), async {
        while tunnel.sessions() > 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(deadline.is_ok(), "the ghost session must leave");

    // The next browser through the same ceiling of one is served normally.
    let request = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/login"),
        &[],
        None,
    ));
    let _seen = serve_one_http(&mut ws, 200, "still alive").await;
    assert_eq!(request.await.unwrap().0, 200);
}

/// Watch one HTTP request arrive from the PC side without answering it — the abandonment
/// test needs the request parked on the tunnel, not answered.
async fn serve_one_http_head_only(ws: &mut Pc) -> HttpReq {
    loop {
        let frames = next_frames(ws).await;
        for frame in &frames {
            if frame.ty == ty::HTTP_REQ {
                if let Some(head) = frame.decode_msgpack::<HttpReq>() {
                    return head;
                }
            }
        }
    }
}

/// §20.6 login throttling through the Hub (state.rs `LOGIN_MAX`, 10/min per IP+uuid): the
/// wildcard `rest` never carries a leading slash, so the guard must name the path exactly —
/// `ends_with("/api/login")` never matched "api/login" and the limiter never ran at all.
#[tokio::test]
async fn a_hammered_login_is_throttled() {
    let fixture = start_hub(Config::default()).await;
    let signing = SigningKey::from_bytes(&[25u8; 32]);
    let mut ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut ws, &signing, &host).await;
    let uuid = &ready.uuid;

    // The window's ten: each crosses to the PC and is answered (a wrong password).
    for _ in 0..10 {
        let request = tokio::spawn(http(
            fixture.hub,
            "POST",
            format!("/u/{uuid}/api/login"),
            &[],
            Some("{}"),
        ));
        let _seen = serve_one_http(&mut ws, 401, "no").await;
        assert_eq!(request.await.unwrap().0, 401);
    }
    // The eleventh inside the same minute: the Hub refuses without waking the tunnel. The
    // timeout is the red-state detector — unthrottled, this request parks on the PC's
    // answer instead of coming back.
    let refused = tokio::time::timeout(
        Duration::from_secs(5),
        http(
            fixture.hub,
            "POST",
            format!("/u/{uuid}/api/login"),
            &[],
            Some("{}"),
        ),
    )
    .await
    .expect("the Hub must refuse, not forward an eleventh login");
    assert_eq!(refused.0, 429, "{}", refused.1);
}

/// §20.8 `bytes_per_day_per_tunnel`: a spent budget must take the tunnel down — the PC
/// unregisters (the link answers the plain offline page) and its browsers close. Before,
/// the refusal only broke out of the frame batch and the select loop kept the dead tunnel
/// Online forever, dropping every further PC→browser frame one warn at a time.
#[tokio::test]
async fn a_spent_byte_budget_takes_the_tunnel_offline() {
    let config = Config {
        bytes_per_day_per_tunnel: 256,
        ..Config::default()
    };
    let fixture = start_hub(config).await;
    let signing = SigningKey::from_bytes(&[26u8; 32]);
    let mut pc_ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut pc_ws, &signing, &host).await;
    let uuid = ready.uuid.clone();

    // A browser on the link, so a downlink frame has somewhere to go.
    let (mut browser, _) =
        tokio_tungstenite::connect_async(format!("ws://{}/u/{uuid}/ws", fixture.hub).as_str())
            .await
            .unwrap();
    let frames = next_frames(&mut pc_ws).await;
    let open = frames
        .iter()
        .find(|f| f.ty == ty::CONN_OPEN)
        .and_then(|f| f.decode_msgpack::<ConnOpen>())
        .expect("a CONN_OPEN");

    // One downlink frame bigger than the rest of the budget.
    let big = Frame::raw(0x52, open.session, vec![0u8; 1024]);
    pc_ws
        .send(Message::Binary(big.encode().into()))
        .await
        .unwrap();

    // The tunnel leaves the table: the link answers offline from here, not 504-forever.
    let gone = tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.state.tunnel(&uuid).is_some() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(gone.is_ok(), "a spent budget must unregister the tunnel");

    // The browser hears the tunnel's close, never the oversized frame.
    let closed = tokio::time::timeout(Duration::from_secs(5), browser.next())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(closed, Ok(Message::Close(_)) | Err(_)),
        "the browser session must close with the tunnel"
    );
}

/// §20.6 `blocklist`, the handshake half: the file is re-read at the handshake itself
/// (cheap while unchanged), so a key listed moments ago is refused right away — not
/// whenever the next 30 s `enforce_blocklist` tick happens to land.
#[tokio::test]
async fn a_newly_listed_key_is_refused_at_its_handshake() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("block.txt");
    std::fs::write(&file, "").unwrap();
    let config = Config {
        blocklist: file.to_str().unwrap().to_owned(),
        ..Config::default()
    };
    let fixture = start_hub(config).await;
    let signing = SigningKey::from_bytes(&[27u8; 32]);

    // Listed moments before the handshake — no refresh tick in between.
    let uuid = identity::uuid_for(&signing.verifying_key().to_bytes());
    std::fs::write(&file, format!("{uuid}\n")).unwrap();

    let mut ws = pc(fixture.hub, &signing, None).await;
    let frames = next_frames(&mut ws).await;
    let challenge = frames
        .iter()
        .find(|f| f.ty == ty::T_CHALLENGE)
        .and_then(|f| f.decode_msgpack::<ggs_remote_hub::msg::TChallenge>())
        .expect("a challenge");
    let message = identity::auth_message(&challenge.nonce, &challenge.host);
    ws.send(Message::Binary(
        Frame::msgpack(
            ty::T_AUTH,
            &TAuth {
                sig: signing.sign(&message).to_bytes().to_vec(),
            },
        )
        .encode()
        .into(),
    ))
    .await
    .unwrap();
    let frames = next_frames(&mut ws).await;
    let rejected = frames
        .iter()
        .find(|f| f.ty == ty::T_REJECTED)
        .and_then(|f| f.decode_msgpack::<ggs_remote_hub::msg::TRejected>());
    assert_eq!(
        rejected.map(|r| r.reason),
        Some("banned".into()),
        "a key listed since the last tick must still be refused at its handshake"
    );
}

/// §20.4 `sessions_per_tunnel`, the browser side end to end: the second connection past a
/// ceiling of one is refused. (The pre-fix race itself — concurrent upgrades each passing
/// the check inside the upgrade gap — cannot be parked deterministically from a test; the
/// atomic check-and-insert it needed is pinned by `reserve_conn`'s unit test in state.rs.)
#[tokio::test]
async fn a_browser_past_the_session_ceiling_is_refused() {
    let config = Config {
        sessions_per_tunnel: 1,
        ..Config::default()
    };
    let fixture = start_hub(config).await;
    let signing = SigningKey::from_bytes(&[28u8; 32]);
    let mut pc_ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut pc_ws, &signing, &host).await;
    let uuid = &ready.uuid;

    let url = format!("ws://{}/u/{uuid}/ws", fixture.hub);
    let (first, _) = tokio_tungstenite::connect_async(url.as_str())
        .await
        .unwrap();
    let frames = next_frames(&mut pc_ws).await;
    assert!(frames.iter().any(|f| f.ty == ty::CONN_OPEN));

    // The slot is taken: the next upgrade is refused before it becomes a session.
    let refused = tokio_tungstenite::connect_async(url.as_str()).await;
    assert!(refused.is_err(), "the ceiling must refuse a second browser");
    drop(first);
}
