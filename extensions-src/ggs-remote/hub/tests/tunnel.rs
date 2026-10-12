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
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

struct Fixture {
    hub: std::net::SocketAddr,
    _stop: tokio::sync::oneshot::Sender<()>,
}

async fn start_hub(config: Config) -> Fixture {
    let hub = Hub::new(config);
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let addr = listener.local_addr().unwrap();
    let app = ggs_remote_hub::gated(hub);
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
