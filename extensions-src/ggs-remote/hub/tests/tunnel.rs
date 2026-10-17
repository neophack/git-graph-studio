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

/// The joint login's test password (§20.14): the fake PC presents this hash as its verifier
/// and answers the daemon's half of every forwarded login.
const LINK_PASSWORD: &str = "tangerine-kayak-42";

fn verifier(epoch: u64) -> ggs_remote_hub::msg::TCredential {
    use argon2::password_hash::{PasswordHasher, SaltString};
    static HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let hash = HASH
        .get_or_init(|| {
            argon2::Argon2::default()
                .hash_password(
                    LINK_PASSWORD.as_bytes(),
                    &SaltString::encode_b64(&[3u8; 16]).unwrap(),
                )
                .expect("a verifier hash")
                .to_string()
        })
        .clone();
    ggs_remote_hub::msg::TCredential {
        hash,
        epoch,
        lang: "en".into(),
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

/// The first frame of a type, hunting across messages — the tunnel's bookkeeping frames
/// (a CONN_CLOSE, a heartbeat) interleave freely with the one a test waits for.
async fn next_frame_of(ws: &mut Pc, wanted: u8) -> Frame {
    loop {
        let frames = next_frames(ws).await;
        if let Some(frame) = frames.into_iter().find(|frame| frame.ty == wanted) {
            return frame;
        }
    }
}

/// Complete the challenge handshake in place, presenting the password verifier right after
/// `T_READY` the way the daemon does (§20.14) — every test that proxies anything needs it,
/// because the Hub gates the whole link behind the joint login.
async fn answer_challenge(ws: &mut Pc, signing: &SigningKey, host: &str) -> TReady {
    let ready = answer_challenge_without_credential(ws, signing, host).await;
    present_verifier(ws, 1).await;
    ready
}

async fn present_verifier(ws: &mut Pc, epoch: u64) {
    ws.send(Message::Binary(
        Frame::msgpack(ty::T_CREDENTIAL, &verifier(epoch))
            .encode()
            .into(),
    ))
    .await
    .unwrap();
}

/// The handshake without the verifier: the shape an OLD daemon still speaks.
async fn answer_challenge_without_credential(
    ws: &mut Pc,
    signing: &SigningKey,
    host: &str,
) -> TReady {
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

/// Wait until the tunnel's verifier has landed — the credential frame crosses
/// asynchronously, and nothing behind the joint login's gate may run before it.
async fn await_verifier(fixture: &Fixture, uuid: &str) {
    let settled = tokio::time::timeout(Duration::from_secs(5), async {
        while fixture
            .state
            .tunnel(uuid)
            .and_then(|tunnel| tunnel.credential())
            .is_none()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(settled.is_ok(), "the verifier must arrive before a login");
}

/// The joint login from the browser side (§20.14): one password entry, the Hub checks it
/// against the verifier and forwards the login, the fake PC answers the daemon's half with
/// its own 200 — and the helper hands back the Hub cookie header every later request
/// carries. One entry, both halves: exactly the flow the product promises.
async fn joint_login(fixture: &Fixture, ws: &mut Pc, uuid: &str) -> String {
    await_verifier(fixture, uuid).await;
    let request = tokio::spawn(http(
        fixture.hub,
        "POST",
        format!("/u/{uuid}/api/hub-login"),
        vec![("Content-Type".into(), "application/json".into())],
        Some(format!(
            r#"{{"password":"{LINK_PASSWORD}","device":"test","remember":false}}"#
        )),
    ));
    // The daemon's half arrives as an ordinary forwarded POST /api/login.
    let seen = serve_one_http(ws, 200, "{\"ok\":true}").await;
    assert_eq!(
        seen.path, "/api/login",
        "the forwarded login is the daemon's own"
    );
    let (status, head, body) = request.await.unwrap();
    assert_eq!(status, 200, "{head} {body}");
    let cookie = head
        .lines()
        .find(|line| line.to_ascii_lowercase().starts_with("set-cookie: ggsrh="))
        .and_then(|line| line.split_once(':').map(|(_, rest)| rest.trim().to_owned()))
        .expect("the Hub's own session cookie");
    assert!(
        cookie.contains("HttpOnly") && cookie.contains(&format!("Path=/u/{uuid}/")),
        "the cookie is scoped to the link: {cookie}"
    );
    cookie
        .split(';')
        .next()
        .expect("the cookie pair")
        .to_owned()
}

async fn http(
    addr: std::net::SocketAddr,
    method: &str,
    path: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
) -> (u16, String, String) {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let body = body.unwrap_or_default();
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nContent-Length: {}\r\n",
        addr.port(),
        body.len()
    );
    for (name, value) in &headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(&body);
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

    // A request for this PC's path reaches the tunnel, and its answer reaches the browser —
    // behind the joint login's gate (§20.14), the Hub's own cookie riding along.
    let link_cookie = joint_login(&fixture, &mut ws, &uuid).await;
    let request = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/api/session"),
        vec![("Cookie".into(), format!("ggsr=tok; {link_cookie}"))],
        None,
    ));
    let seen = serve_one_http(&mut ws, 200, "the session answer").await;
    let (status, _head, body) = request.await.unwrap();
    assert_eq!(status, 200);
    assert_eq!(body, "the session answer");
    // The PC saw the request stripped of the prefix, with its cookie and base path intact.
    assert_eq!(seen.path, "/api/session");
    assert_eq!(
        seen.headers.get("cookie").map(String::as_str),
        Some(format!("ggsr=tok; {link_cookie}").as_str())
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
    let link_cookie = joint_login(&fixture, &mut ws, &uuid).await;

    let request = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/windows"),
        vec![
            ("X-Forwarded-Proto".into(), "https".into()),
            ("Cookie".into(), link_cookie.clone()),
        ],
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
    let link_cookie = joint_login(&fixture, &mut ws, &uuid).await;
    let request = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/windows"),
        vec![
            ("X-Forwarded-Proto".into(), "https".into()),
            ("Cookie".into(), link_cookie),
        ],
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
    let link_cookie = joint_login(&fixture, &mut ws, uuid).await;

    for path in [format!("/u/{uuid}/"), format!("/u/{uuid}")] {
        let request = tokio::spawn(http(
            fixture.hub,
            "GET",
            path.clone(),
            vec![("Cookie".into(), link_cookie.clone())],
            None,
        ));
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
        let (status, _head, body) = http(fixture.hub, "GET", path.to_owned(), vec![], None).await;
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

/// The relay may never be turned toward unrelated websites: an absolute-form request
/// target — `GET http://example.com/…`, the open-proxy probe shape — drops at the gate
/// with zero bytes, EVEN with a live link and a valid joint session embedded in the URL
/// (the control request below proves both were good). And a foreign URL spelled INSIDE
/// the link namespace rides the tunnel to that link's own PC as a plain local path — the
/// uuid segment alone picks the destination; example.com is never one.
#[tokio::test]
async fn the_hub_is_not_a_forward_proxy_for_foreign_sites() {
    let fixture = start_hub(Config::default()).await;
    let signing = SigningKey::from_bytes(&[5u8; 32]);
    let mut ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut ws, &signing, &host).await;
    let uuid = &ready.uuid;
    let link_cookie = joint_login(&fixture, &mut ws, uuid).await;

    // The probe shapes, on raw sockets: a foreign site's absolute-form target, then the
    // same site wrapped around THIS live link's path with the valid session riding along —
    // both close with zero bytes, like every other scan path.
    for target in [
        "http://example.com/",
        "https://example.com/wp-admin/setup.php",
        &format!("http://evil.example/u/{uuid}/api/session"),
    ] {
        let mut stream = tokio::net::TcpStream::connect(fixture.hub).await.unwrap();
        stream
            .write_all(
                format!(
                    "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ggsr=tok; {link_cookie}\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        assert!(
            raw.is_empty(),
            "{target}: the port answered {} bytes for a foreign site",
            raw.len()
        );
    }

    // The control: the origin-form of the very same link, same cookie — still serves.
    let request = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/api/session"),
        vec![("Cookie".into(), format!("ggsr=tok; {link_cookie}"))],
        None,
    ));
    serve_one_http(&mut ws, 200, "still serving").await;
    let (status, _head, _body) = request.await.unwrap();
    assert_eq!(status, 200, "the drop above was the form, never the link");

    // The link namespace is not a door either: `http://…` after the uuid is that PC's own
    // local path — the tunnel hears `/http://…`, and nothing anywhere dials example.com.
    let request = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/http://example.com/secret"),
        vec![("Cookie".into(), format!("ggsr=tok; {link_cookie}"))],
        None,
    ));
    let seen = serve_one_http(&mut ws, 404, "no such page").await;
    assert_eq!(
        seen.path, "/http://example.com/secret",
        "a foreign URL crosses as the PC's own local path"
    );
    let (status, _head, body) = request.await.unwrap();
    assert_eq!(status, 404);
    assert_eq!(body, "no such page");
}

#[tokio::test]
async fn the_browser_websocket_rides_the_tunnel() {
    let fixture = start_hub(Config::default()).await;
    let signing = SigningKey::from_bytes(&[3u8; 32]);
    let mut pc_ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut pc_ws, &signing, &host).await;
    let uuid = &ready.uuid;
    let link_cookie = joint_login(&fixture, &mut pc_ws, uuid).await;

    let mut request = format!("ws://{}/u/{}/ws", fixture.hub, uuid)
        .as_str()
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Cookie",
        format!("ggsr=tok; {link_cookie}").parse().unwrap(),
    );
    let (mut browser, _) = tokio_tungstenite::connect_async(request).await.unwrap();

    // The PC hears CONN_OPEN with the browser's headers.
    let open_frame = next_frame_of(&mut pc_ws, ty::CONN_OPEN).await;
    let open = open_frame
        .decode_msgpack::<ConnOpen>()
        .expect("a CONN_OPEN");
    assert_eq!(open.kind, "ws");
    assert_eq!(
        open.headers.get("cookie").map(String::as_str),
        Some(format!("ggsr=tok; {link_cookie}").as_str())
    );
    assert_eq!(open.base_path, format!("/u/{uuid}/"));
    // Tunnel control rides session 0 on the wire; the session number is in the payload.
    assert!(
        open_frame.session == 0,
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
    let cookie_a = joint_login(&fixture, &mut pc_a, &ready_a.uuid).await;

    // A request for A's link is served by A; B stays quiet.
    let request = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{}/api/session", ready_a.uuid),
        vec![("Cookie".into(), format!("ggsr=a-token; {cookie_a}"))],
        None,
    ));
    let seen = serve_one_http(&mut pc_a, 200, "{}").await;
    let (_status, _head, _body) = request.await.unwrap();
    assert_eq!(seen.path, "/api/session");
    assert_eq!(
        seen.headers.get("cookie").map(String::as_str),
        Some(format!("ggsr=a-token; {cookie_a}").as_str())
    );
    // B has nothing pending (the heartbeat gives it a moment to have delivered anything).
    let heard = tokio::time::timeout(Duration::from_millis(300), pc_b.next()).await;
    assert!(!matches!(heard, Ok(Some(Ok(Message::Binary(_))))));
}

/// §20.6 `http_rate`: the session ceiling caps concurrency, not rate — a single address
/// hammering one link sequentially needs its own guard, and one that does not throttle a
/// page's burst of asset loads (the cap here is per minute; the joint login's own POST is
/// one of the window's entries).
#[tokio::test]
async fn the_http_rate_refuses_a_hammering_ip() {
    let config = Config {
        http_rate: 2,
        ..Config::default()
    };
    let fixture = start_hub(config).await;
    let signing = SigningKey::from_bytes(&[21u8; 32]);
    let mut ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut ws, &signing, &host).await;
    let link_cookie = joint_login(&fixture, &mut ws, &ready.uuid).await;

    let first = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{}/windows", ready.uuid),
        vec![("Cookie".into(), link_cookie.clone())],
        None,
    ));
    let _seen = serve_one_http(&mut ws, 200, "ok").await;
    assert_eq!(first.await.unwrap().0, 200);
    // The same IP inside the same minute: refused without waking the tunnel.
    let second = http(
        fixture.hub,
        "GET",
        format!("/u/{}/windows", ready.uuid),
        vec![("Cookie".into(), link_cookie)],
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
        visitors_per_day_per_tunnel: 2,
        ..Config::default()
    };
    let fixture = start_hub(config).await;
    let signing = SigningKey::from_bytes(&[22u8; 32]);
    let mut ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut ws, &signing, &host).await;
    let uuid = &ready.uuid;
    let link_cookie = joint_login(&fixture, &mut ws, uuid).await;

    let first = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/windows"),
        vec![
            ("X-Forwarded-For".into(), "203.0.113.31".into()),
            ("Cookie".into(), link_cookie.clone()),
        ],
        None,
    ));
    let _seen = serve_one_http(&mut ws, 200, "ok").await;
    assert_eq!(first.await.unwrap().0, 200);

    // The same viewer again: already inside the bucket, costs nothing.
    let again = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/windows"),
        vec![
            ("X-Forwarded-For".into(), "203.0.113.31".into()),
            ("Cookie".into(), link_cookie),
        ],
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
        vec![("X-Forwarded-For".into(), "203.0.113.32".into())],
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
        http(fixture.hub, "GET", format!("/u/{uuid}/login"), vec![], None).await;
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
    let link_cookie = joint_login(&fixture, &mut ws, uuid).await;

    // One request whose client vanishes before the PC answers it.
    let mut ghost = tokio::net::TcpStream::connect(fixture.hub).await.unwrap();
    ghost
        .write_all(
            format!(
                "GET /u/{uuid}/api/session HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: {link_cookie}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
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
        format!("/u/{uuid}/api/session"),
        vec![("Cookie".into(), link_cookie)],
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

/// §20.6 login throttling through the Hub (state.rs `LOGIN_MAX`, 10/min per IP+uuid) —
/// now the joint login's own door (§20.14): a wrong password is answered by the HUB's
/// Argon2 check and never wakes the tunnel at all, and the eleventh entry inside the
/// minute is refused before even that.
#[tokio::test]
async fn a_hammered_login_is_throttled() {
    let fixture = start_hub(Config::default()).await;
    let signing = SigningKey::from_bytes(&[25u8; 32]);
    let mut ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut ws, &signing, &host).await;
    let uuid = &ready.uuid;

    // The window's ten: each is checked against the verifier and answered 401 here —
    // the PC never hears one of them.
    for _ in 0..10 {
        let (status, head, body) = http(
            fixture.hub,
            "POST",
            format!("/u/{uuid}/api/hub-login"),
            vec![("Content-Type".into(), "application/json".into())],
            Some(r#"{"password":"not-the-password"}"#.into()),
        )
        .await;
        assert_eq!(status, 401, "{head} {body}");
    }
    // Heartbeats (T_PING every 25 s) ride the same socket, and ten Argon2 checks can take
    // longer than one interval on a slow machine — the assertion is that no LOGIN traffic
    // woke the tunnel, not that the heartbeat stopped, so the drain skips pings.
    let heard = tokio::time::timeout(Duration::from_millis(300), async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Binary(bytes))) => {
                    if let Some(frames) = Frame::decode_all(&bytes) {
                        for frame in frames {
                            if frame.ty != ty::T_PING {
                                return Some(frame);
                            }
                        }
                    }
                }
                Some(Ok(_)) => continue,
                Some(Err(_)) | None => return None,
            }
        }
    })
    .await;
    assert!(
        !matches!(heard, Ok(Some(_))),
        "a wrong password must never wake the tunnel"
    );

    // The eleventh inside the same minute: refused outright. The timeout is the red-state
    // detector — unthrottled, this request pays for another Argon2 instead of answering.
    let refused = tokio::time::timeout(
        Duration::from_secs(5),
        http(
            fixture.hub,
            "POST",
            format!("/u/{uuid}/api/hub-login"),
            vec![("Content-Type".into(), "application/json".into())],
            Some(r#"{"password":"not-the-password"}"#.into()),
        ),
    )
    .await
    .expect("the Hub must refuse, not verify an eleventh login");
    assert_eq!(refused.0, 429, "{}", refused.1);
}

/// §20.8 `bytes_per_day_per_tunnel`: a spent budget must take the tunnel down — the PC
/// unregisters (the link answers the plain offline page) and its browsers close. Before,
/// the refusal only broke out of the frame batch and the select loop kept the dead tunnel
/// Online forever, dropping every further PC→browser frame one warn at a time.
#[tokio::test]
async fn a_spent_byte_budget_takes_the_tunnel_offline() {
    // The joint login's request AND answer both ride the daily budget now (the uplink
    // spent nothing before), so the allowance covers the login and the frame below is
    // what breaks it.
    let config = Config {
        bytes_per_day_per_tunnel: 4096,
        ..Config::default()
    };
    let fixture = start_hub(config).await;
    let signing = SigningKey::from_bytes(&[26u8; 32]);
    let mut pc_ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut pc_ws, &signing, &host).await;
    let uuid = ready.uuid.clone();
    let link_cookie = joint_login(&fixture, &mut pc_ws, &uuid).await;

    // A browser on the link, so a downlink frame has somewhere to go.
    let mut browser_request = format!("ws://{}/u/{uuid}/ws", fixture.hub)
        .as_str()
        .into_client_request()
        .unwrap();
    browser_request
        .headers_mut()
        .insert("Cookie", link_cookie.parse().unwrap());
    let (mut browser, _) = tokio_tungstenite::connect_async(browser_request)
        .await
        .unwrap();
    let open = next_frame_of(&mut pc_ws, ty::CONN_OPEN)
        .await
        .decode_msgpack::<ConnOpen>()
        .expect("a CONN_OPEN");

    // One downlink frame bigger than the rest of the budget.
    let big = Frame::raw(0x52, open.session, vec![0u8; 8192]);
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
    let link_cookie = joint_login(&fixture, &mut pc_ws, uuid).await;

    let url = format!("ws://{}/u/{uuid}/ws", fixture.hub);
    let mut first_request = url.as_str().into_client_request().unwrap();
    first_request
        .headers_mut()
        .insert("Cookie", link_cookie.parse().unwrap());
    let (first, _) = tokio_tungstenite::connect_async(first_request)
        .await
        .unwrap();
    let _open = next_frame_of(&mut pc_ws, ty::CONN_OPEN).await;
    assert_eq!(_open.ty, ty::CONN_OPEN);

    // The slot is taken: the next upgrade is refused before it becomes a session.
    let mut second_request = url.as_str().into_client_request().unwrap();
    second_request
        .headers_mut()
        .insert("Cookie", link_cookie.parse().unwrap());
    let refused = tokio_tungstenite::connect_async(second_request).await;
    assert!(refused.is_err(), "the ceiling must refuse a second browser");
    drop(first);
}

/// The joint login end to end (§20.14, the owner's 2026-10-16 direction): the login page is
/// the HUB's own — served here, in the PC's language, never proxied — nothing on the link
/// is proxied before it passes (a relay must not be turnable into a content host by
/// whoever holds the uuid), and ONE password entry authenticates on both halves: the Hub's
/// own Argon2 check against the verifier, then the daemon's own check of the forwarded
/// login, whose session cookie rides the same answer.
#[tokio::test]
async fn the_joint_login_is_the_hubs_own_page_and_gates_the_link() {
    let fixture = start_hub(Config::default()).await;
    let signing = SigningKey::from_bytes(&[31u8; 32]);
    let mut ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut ws, &signing, &host).await;
    let uuid = &ready.uuid;
    await_verifier(&fixture, uuid).await;

    // No session: a navigation is sent to the login page; an API call is a plain 401; the
    // WebSocket is refused its upgrade — and none of the three wake the tunnel.
    let landing = http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/"),
        vec![("Accept".into(), "text/html,application/xhtml+xml".into())],
        None,
    )
    .await;
    assert_eq!(landing.0, 302, "{}", landing.1);
    assert!(
        landing
            .1
            .to_ascii_lowercase()
            .contains(&format!("location: /u/{uuid}/login")),
        "{}",
        landing.1
    );
    let api = http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/api/session"),
        vec![],
        None,
    )
    .await;
    assert_eq!(api.0, 401, "{}", api.1);
    let mut ws_request = format!("ws://{}/u/{uuid}/ws", fixture.hub)
        .as_str()
        .into_client_request()
        .unwrap();
    ws_request
        .headers_mut()
        .insert("Cookie", "ggsr=daemon-cookie".parse().unwrap());
    let refused_ws = tokio_tungstenite::connect_async(ws_request).await;
    assert!(
        refused_ws.is_err(),
        "an unlogged WebSocket must not upgrade"
    );
    let heard = tokio::time::timeout(Duration::from_millis(300), ws.next()).await;
    assert!(
        !matches!(heard, Ok(Some(Ok(Message::Binary(_))))),
        "the gate must not wake the tunnel"
    );

    // The login page itself: the Hub's own, carrying its own form, in the PC's language.
    let page = http(fixture.hub, "GET", format!("/u/{uuid}/login"), vec![], None).await;
    assert_eq!(page.0, 200, "{}", page.1);
    assert!(
        page.2.contains("api/hub-login"),
        "the form posts to the Hub"
    );
    assert!(page.2.contains("Access password"), "the PC's language (en)");
    // The page signs in with fetch(): its CSP must let it reach its own origin, or every
    // browser blocks the one request the page exists to make.
    let csp = page
        .1
        .lines()
        .find(|line| {
            line.to_ascii_lowercase()
                .starts_with("content-security-policy:")
        })
        .unwrap_or_default()
        .to_owned();
    assert!(
        page.2.contains("fetch(") && csp.contains("connect-src 'self'"),
        "the login page's own fetch must be allowed by its CSP: {csp}"
    );
    assert!(!page.2.contains("__"), "no token survived: {}", page.2);

    // One entry, both halves: the wrong password is answered by the Hub alone…
    let wrong = http(
        fixture.hub,
        "POST",
        format!("/u/{uuid}/api/hub-login"),
        vec![("Content-Type".into(), "application/json".into())],
        Some(r#"{"password":"wrong"}"#.into()),
    )
    .await;
    assert_eq!(wrong.0, 401, "{}", wrong.1);
    // …the right one is verified here AND forwarded, the daemon answers with its own
    // session, and both cookies land in one response.
    let cookie = joint_login(&fixture, &mut ws, uuid).await;

    // With the Hub's cookie the link serves again — proxied, the daemon's own checks on
    // duty (here: its 401 for a request that carries no daemon session).
    let through = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/api/session"),
        vec![("Cookie".into(), cookie)],
        None,
    ));
    let seen = serve_one_http_401(&mut ws).await;
    let (through_status, ..) = through.await.unwrap();
    assert_eq!(
        through_status, 401,
        "the daemon's own half still checks its cookie"
    );
    assert_eq!(seen.path, "/api/session");
}

/// The daemon's 401 for a proxied request with no session — the joint-login test reads it.
async fn serve_one_http_401(ws: &mut Pc) -> HttpReq {
    serve_one_http(ws, 401, "{\"error\":\"no-session\"}").await
}

/// A password change on the PC (§20.14): the new `T_CREDENTIAL` epoch ends every Hub-side
/// login issued under the old password — the relay's sessions follow the daemon's own to
/// the same second, and the browser lands on the login page again.
#[tokio::test]
async fn a_password_change_on_the_pc_ends_the_hubs_logins() {
    let fixture = start_hub(Config::default()).await;
    let signing = SigningKey::from_bytes(&[32u8; 32]);
    let mut ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut ws, &signing, &host).await;
    let uuid = &ready.uuid;
    let cookie = joint_login(&fixture, &mut ws, uuid).await;

    // The login holds before the change.
    let before = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/api/session"),
        vec![("Cookie".into(), cookie.clone())],
        None,
    ));
    let seen = serve_one_http(&mut ws, 200, "ok").await;
    let (before_status, ..) = before.await.unwrap();
    assert_eq!(before_status, 200);
    assert_eq!(seen.path, "/api/session");

    // The PC changed its password: a fresh verifier under a new epoch.
    present_verifier(&mut ws, 2).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    // The old Hub cookie no longer passes the gate — a navigation lands on the login page.
    let after = http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/api/session"),
        vec![
            ("Cookie".into(), cookie),
            ("Accept".into(), "text/html,application/xhtml+xml".into()),
        ],
        None,
    )
    .await;
    assert_eq!(after.0, 302, "{}", after.1);
}

/// The frame-level half of the gate (§6.1/§20.4): everything the daemon's decoder refuses,
/// the Hub's re-stamp must refuse too — before it caught up, one empty WebSocket message
/// (or one with dirty reserved bytes) from ANY browser holding the uuid tore the whole
/// tunnel down, taking every live remote session on that PC with it.
#[tokio::test]
async fn an_empty_browser_message_cannot_kill_the_tunnel() {
    let fixture = start_hub(Config::default()).await;
    let signing = SigningKey::from_bytes(&[33u8; 32]);
    let mut pc_ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge(&mut pc_ws, &signing, &host).await;
    let uuid = &ready.uuid;
    let cookie = joint_login(&fixture, &mut pc_ws, uuid).await;

    let mut request = format!("ws://{}/u/{uuid}/ws", fixture.hub)
        .as_str()
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Cookie", cookie.parse().unwrap());
    let (mut browser, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let _open = next_frame_of(&mut pc_ws, ty::CONN_OPEN).await;

    // The kill-shot as it was: an empty binary message the old stamp waved through.
    browser
        .send(Message::Binary(Vec::new().into()))
        .await
        .unwrap();
    // The browser socket closes (nothing decodable rides a dead frame); the TUNNEL stays.
    let closed = tokio::time::timeout(Duration::from_secs(5), browser.next())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(closed, Ok(Message::Close(_)) | Err(_)),
        "the browser socket ends, not the tunnel"
    );
    assert!(
        fixture.state.tunnel(uuid).is_some(),
        "the tunnel must survive an empty browser message"
    );

    // And the link still serves: the tunnel answers the next request as if nothing happened.
    let request = tokio::spawn(http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/api/session"),
        vec![("Cookie".into(), format!("ggsr=x; {cookie}"))],
        None,
    ));
    let _seen = serve_one_http(&mut pc_ws, 401, "no").await;
    assert_eq!(request.await.unwrap().0, 401);
}

/// A daemon that never presents its verifier (§20.14): the link fails CLOSED. While the
/// tunnel settles it answers "coming online"; past that window it is the upgrade page —
/// never the proxy, because a login the Hub cannot check is a login it must not forward.
#[tokio::test]
async fn a_tunnel_without_a_verifier_never_proxies() {
    let fixture = start_hub(Config::default()).await;
    let signing = SigningKey::from_bytes(&[34u8; 32]);
    let mut ws = pc(fixture.hub, &signing, None).await;
    let host = format!("127.0.0.1:{}", fixture.hub.port());
    let ready = answer_challenge_without_credential(&mut ws, &signing, &host).await;
    let uuid = &ready.uuid;

    // Still settling: the frame rides right behind T_READY, so the first moments say so.
    let settling = http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/api/session"),
        vec![],
        None,
    )
    .await;
    assert_eq!(settling.0, 503, "{}", settling.1);
    assert!(settling.2.contains("coming online"));

    // Past the window: the upgrade page, and still nothing reaches the PC.
    tokio::time::sleep(Duration::from_secs(6)).await;
    let upgrade = http(
        fixture.hub,
        "GET",
        format!("/u/{uuid}/api/session"),
        vec![],
        None,
    )
    .await;
    assert_eq!(upgrade.0, 503, "{}", upgrade.1);
    assert!(upgrade.2.contains("update"), "{}", upgrade.2);
    let heard = tokio::time::timeout(Duration::from_millis(300), ws.next()).await;
    assert!(
        !matches!(heard, Ok(Some(Ok(Message::Binary(_))))),
        "nothing may be proxied without the verifier"
    );
}
