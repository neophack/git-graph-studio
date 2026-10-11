//! End-to-end across both crates (docs/ggs-remote-plan.md §20.12): a real Hub, a real
//! daemon, the outbound tunnel between them, and a fake browser — login over the Hub's
//! `/u/<uuid>/` path, a WebSocket session through the tunnel carrying a real invoke, and a
//! password change kicking the tunneled session within a second.

use futures_util::{SinkExt, StreamExt};
use ggs_remote::config::{Config, TlsConfig, TlsMode};
use ggs_remote::hub::{Settings, Status};
use ggs_remote::paths::Paths;
use ggs_remote::state::Daemon;
use ggs_remote::ws::frame::{ty, Frame};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const PASSWORD: &str = "tangerine-kayak-42";

struct Both {
    _dir: tempfile::TempDir,
    daemon: Arc<Daemon>,
    hub_addr: std::net::SocketAddr,
    uuid: String,
}

async fn start() -> Both {
    // The serve task detaches — the anonymous server runs for the test's lifetime.
    start_owned().await.0
}

/// The same, but the Hub's serve task is handed back — the restart test stops it and brings
/// a fresh Hub (fresh state, nothing persisted, §20.2) up on the same port.
async fn start_owned() -> (Both, tokio::task::JoinHandle<()>) {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
    paths.ensure().unwrap();
    let config = Config {
        port: 0,
        bind: "127.0.0.1".into(),
        tls: TlsConfig {
            mode: TlsMode::None,
            ..Default::default()
        },
        ..Default::default()
    };
    config.save(&paths).unwrap();
    let daemon = Daemon::new(paths, config).unwrap();
    let run = daemon.clone();
    tokio::spawn(async move { ggs_remote::server::run(run).await });

    let hub = ggs_remote_hub::state::Hub::new(ggs_remote_hub::config::Config {
        listen: "127.0.0.1:0".into(),
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let hub_addr = listener.local_addr().unwrap();
    let app =
        ggs_remote_hub::router(hub).into_make_service_with_connect_info::<std::net::SocketAddr>();
    let task = tokio::spawn(async move {
        let app = app;
        let _ = axum::serve(listener, app).await;
    });

    // The daemon needs its password before it will expose anything through a Hub (§20.3).
    daemon.auth.set_password(PASSWORD).await.unwrap();
    daemon
        .hub
        .connect(Settings {
            url: format!("http://127.0.0.1:{}", hub_addr.port()),
            join_key: String::new(),
            fingerprint: String::new(),
        })
        .unwrap();
    let uuid = loop {
        if let Status::Online { uuid, .. } = daemon.hub.snapshot() {
            break uuid;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    (
        Both {
            _dir: dir,
            daemon,
            hub_addr,
            uuid,
        },
        task,
    )
}

async fn http(
    addr: std::net::SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (u16, String, String) {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
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

fn find_cookie(head: &str) -> Option<String> {
    for line in head.lines() {
        if let Some(rest) = line.strip_prefix("set-cookie: ") {
            return rest.split(';').next().map(str::to_owned);
        }
    }
    None
}

/// Login through the Hub, then ride one WebSocket: HELLO (with the CSRF from /api/session),
/// ATTACH-less INVOKE (the daemon answers "not attached"), and the WINDOWS push.
async fn browser_session(
    both: &Both,
) -> (
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Vec<Frame>,
) {
    let base = format!("/u/{}/", both.uuid);
    let (status, head, _body) = http(
        both.hub_addr,
        "POST",
        &format!("{base}api/login"),
        &[
            ("content-type", "application/json"),
            (
                "origin",
                &format!("http://127.0.0.1:{}", both.hub_addr.port()),
            ),
        ],
        &format!("{{\"password\":\"{PASSWORD}\",\"device\":\"test\",\"remember\":false}}"),
    )
    .await;
    assert_eq!(status, 200, "login through the hub: {head}");
    let cookie = find_cookie(&head).expect("a session cookie");

    let (status, _head, body) = http(
        both.hub_addr,
        "GET",
        &format!("{base}api/session"),
        &[("cookie", &cookie)],
        "",
    )
    .await;
    assert_eq!(status, 200);
    let csrf = serde_json::from_str::<serde_json::Value>(&body).unwrap()["csrf"]
        .as_str()
        .unwrap()
        .to_owned();

    let ws_url = format!("ws://{}{}ws", both.hub_addr, base);
    let mut request = ws_url.as_str().into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Cookie", cookie.parse().unwrap());
    request.headers_mut().insert(
        "Origin",
        format!("http://127.0.0.1:{}", both.hub_addr.port())
            .parse()
            .unwrap(),
    );
    let (ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();

    // HELLO with the CSRF value; then an INVOKE the daemon rejects with a message — proof
    // the frame crossed the tunnel, hit the connection logic and came back.
    let hello = Frame::msgpack(
        ty::HELLO,
        &serde_json::json!({ "proto": 1, "client": "web", "csrf": csrf }),
    );
    let invoke = Frame::json(
        ty::INVOKE,
        &serde_json::json!({ "c": "list_dir", "a": { "path": "." } }),
    )
    .with_stream(1);
    let (mut ws, _) = (ws, ());
    ws.send(Message::Binary(
        [hello.encode(), invoke.encode()].concat().into(),
    ))
    .await
    .unwrap();

    let mut got_hello_ack = false;
    let mut windows = Vec::new();
    let mut frames = Vec::new();
    for _ in 0..12 {
        let message = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Message::Binary(bytes) = message else {
            continue;
        };
        let Ok(decoded) = Frame::decode_all(&bytes) else {
            continue;
        };
        for frame in decoded {
            match frame.ty {
                t if t == ty::HELLO_ACK => got_hello_ack = true,
                t if t == ty::WINDOWS => windows.push(frame),
                _ => frames.push(frame),
            }
        }
        if got_hello_ack && !windows.is_empty() && !frames.is_empty() {
            break;
        }
    }
    assert!(got_hello_ack, "the tunneled HELLO was answered");
    assert!(!windows.is_empty(), "WINDOWS arrived through the tunnel");
    (ws, frames)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_browser_lives_entirely_through_the_hub() {
    let both = start().await;
    let (_ws, frames) = browser_session(&both).await;
    // The INVOKE's answer: an ERROR RESULT (no window attached) — the whole loop closed.
    let result = frames
        .iter()
        .find(|f| f.ty == ty::RESULT)
        .expect("a RESULT");
    assert!(result.has(ggs_remote::ws::frame::flag::ERROR));
    let body: serde_json::Value = result.decode_msgpack().unwrap_or_default();
    let _ = body;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_password_change_kicks_the_tunneled_session() {
    let both = start().await;
    let (mut ws, _frames) = browser_session(&both).await;
    both.daemon
        .auth
        .set_password("new-horizon-77")
        .await
        .unwrap();
    both.daemon.credentials_changed("credentials-changed");

    // The protocol CLOSE frame lands first, the WebSocket close right behind it.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    let mut saw_frame = false;
    loop {
        let message = match tokio::time::timeout_at(deadline, ws.next()).await {
            Ok(message) => message.expect("the socket stays open until the close"),
            Err(_) => panic!("the kick did not arrive within a second (R9 through a Hub)"),
        };
        match message.unwrap() {
            Message::Binary(bytes) => {
                let frames = Frame::decode_all(&bytes).unwrap_or_default();
                saw_frame |= frames.iter().any(|f| f.ty == ty::CLOSE);
            }
            Message::Close(frame) => {
                let code: u16 = frame.map(|f| f.code).map(|c| c.into()).unwrap_or(0);
                assert_eq!(code, 4401u16);
                assert!(
                    saw_frame,
                    "the protocol CLOSE frame precedes the socket close"
                );
                break;
            }
            _ => {}
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_offline_link_after_a_disconnect_shows_the_page() {
    let both = start().await;
    let base = format!("/u/{}/", both.uuid);
    let (status, _h, _b) = http(both.hub_addr, "GET", &format!("{base}login"), &[], "").await;
    assert_eq!(status, 200);
    both.daemon.hub.disconnect().unwrap();
    // The tunnel unwinds; the link then answers the not-online page.
    let mut saw_offline = false;
    for _ in 0..100 {
        let (status, _head, body) =
            http(both.hub_addr, "GET", &format!("{base}login"), &[], "").await;
        if status == 503 && body.contains("not online") {
            saw_offline = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(saw_offline, "the link must go offline after disconnect");
}
/// §20.12: "Hub 重启后 PC 自动重连、链接不变" — a restarted Hub is a brand-new process
/// with empty state (nothing is persisted, §20.2). The in-process `axum::serve` cannot play
/// that role (aborting it leaves accepted connections alive, so the tunnel never dies), so
/// this test speaks the tunnel protocol itself: one minimal Hub generation per listener,
/// whose single task the test genuinely kills. The daemon must notice, back off, and run a
/// whole fresh handshake against the next generation — same device key, same uuid,
/// byte-for-byte the same link.
struct FakeHub {
    /// Resolves once the generation finished a full handshake (its T_READY went out).
    ready: tokio::sync::oneshot::Receiver<(String, String)>,
    task: tokio::task::JoinHandle<()>,
}

/// Spawn one Hub generation on `port`: accept exactly one tunnel connection, handshake it,
/// then pump until killed. Returns at once — the generation signals `(uuid, base_path)`
/// through `ready` when its half of the handshake completes.
fn spawn_fake_hub(port: u16) -> FakeHub {
    let (tx, ready) = tokio::sync::oneshot::channel();
    let task = tokio::task::spawn(async move {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .expect("the port must rebind between hub generations");
        let (stream, _) = listener.accept().await.expect("the daemon's tunnel");
        drop(listener); // one connection per generation
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();

        // T_HELLO → T_CHALLENGE → T_AUTH (taken, not verified) → T_READY with the uuid the
        // daemon's own key derives to.
        let message = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("a T_HELLO within 10 s")
            .unwrap()
            .unwrap();
        let Message::Binary(bytes) = message else {
            panic!("the tunnel speaks binary frames");
        };
        let hello = Frame::decode_all(&bytes)
            .unwrap()
            .into_iter()
            .find(|f| f.ty == ty::T_HELLO)
            .and_then(|f| f.decode_msgpack::<ggs_remote::hub::msg::THello>())
            .expect("a T_HELLO");
        let challenge = ggs_remote::hub::msg::TChallenge {
            nonce: vec![7u8; 32],
            host: format!("127.0.0.1:{port}"),
        };
        ws.send(Message::Binary(
            Frame::msgpack(ty::T_CHALLENGE, &challenge).encode().into(),
        ))
        .await
        .unwrap();
        let _auth = ws.next().await.unwrap().unwrap();
        let pubkey: [u8; 32] = hello.pubkey.clone().try_into().unwrap();
        let uuid = ggs_remote::hub::identity::uuid_for(&pubkey);
        let ready_msg = ggs_remote::hub::msg::TReady {
            base_path: format!("/u/{uuid}/"),
            public_base: format!("http://127.0.0.1:{port}/u/{uuid}/"),
            uuid: uuid.clone(),
            limits: Default::default(),
        };
        ws.send(Message::Binary(
            Frame::msgpack(ty::T_READY, &ready_msg).encode().into(),
        ))
        .await
        .unwrap();
        let _ = tx.send((uuid, ready_msg.base_path));

        // Pump: answer the tunnel heartbeats; everything else is none of a fake's business.
        while let Some(Ok(message)) = ws.next().await {
            if let Message::Binary(bytes) = message {
                for frame in Frame::decode_all(&bytes).unwrap_or_default() {
                    if frame.ty == ty::T_PING {
                        let _ = ws
                            .send(Message::Binary(
                                Frame::empty(ty::T_PONG).encode().into(),
                            ))
                            .await;
                    }
                }
            }
        }
    });
    FakeHub { ready, task }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restarted_hub_is_rejoined_with_the_same_link() {
    // A daemon, alone — no real Hub in this test (the fake plays it).
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
    paths.ensure().unwrap();
    let config = Config {
        port: 0,
        bind: "127.0.0.1".into(),
        tls: TlsConfig {
            mode: TlsMode::None,
            ..Default::default()
        },
        ..Default::default()
    };
    config.save(&paths).unwrap();
    let daemon = Daemon::new(paths, config).unwrap();
    let run = daemon.clone();
    tokio::spawn(async move { ggs_remote::server::run(run).await });
    daemon.auth.set_password(PASSWORD).await.unwrap();

    let probe = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);

    // Hub generation one: the daemon connects, handshakes, goes Online.
    let first = spawn_fake_hub(port);
    daemon
        .hub
        .connect(ggs_remote::hub::Settings {
            url: format!("http://127.0.0.1:{port}"),
            join_key: String::new(),
            fingerprint: String::new(),
        })
        .unwrap();
    let (uuid, base_path) = tokio::time::timeout(Duration::from_secs(10), first.ready)
        .await
        .expect("the first handshake")
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if daemon.hub.snapshot().online() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the daemon never went Online against the first generation"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // The Hub dies — the whole process: the generation's task is killed, the socket truly
    // closes, exactly what a restart looks like from the PC's side of the tunnel.
    first.task.abort();
    let _ = first.task.await;

    // … and generation two comes up on the same port. The daemon notices on its own, backs
    // off, and runs a whole fresh handshake (the generation's ready only fires after one).
    let second = spawn_fake_hub(port);
    let (uuid_two, base_two) = tokio::time::timeout(Duration::from_secs(30), second.ready)
        .await
        .expect("the daemon must re-handshake against the restarted Hub within 30 s")
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if daemon.hub.snapshot().online() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the daemon never went Online against the second generation"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Same device key → same uuid → byte-for-byte the same link the bookmark spells.
    assert_eq!(uuid_two, uuid);
    assert_eq!(base_two, base_path);
    second.task.abort();
    let _ = second.task.await;
}
