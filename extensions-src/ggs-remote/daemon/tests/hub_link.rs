//! End-to-end across both crates (docs/ggs-remote-plan.md §20.12): a real Hub, a real
//! daemon, the outbound tunnel between them, and a fake browser — login over the Hub's
//! `/u/<uuid>/` path, a WebSocket session through the tunnel carrying a real invoke, and a
//! password change kicking the tunneled session within a second. The password-first flow
//! (relay saved before any password exists — the Remote Access page's set-password screen)
//! and the link pages' relay-first ordering live here too.
//!
//! The `Joint` suite below is the multi-PC half of the same table: one Hub, a spawnable
//! family of real daemons, fake GGS instances feeding them assets — two PCs side by side,
//! the join key, a link change retiring the old link at once, an exported device key taking
//! the link over on a second PC (T_REPLACED), a browser session resuming through a
//! recovered tunnel, and the cross-PC cache answering immutable assets without waking the
//! serving tunnel.

use futures_util::{SinkExt, StreamExt};
use ggs_remote::config::{Config, TlsConfig, TlsMode};
use ggs_remote::control_msg::{self, FromInstance, LaunchSpec, ToInstance};
use ggs_remote::hub::{Settings, Status};
use ggs_remote::paths::Paths;
use ggs_remote::state::Daemon;
use ggs_remote::ws::frame::{ty, Frame};
use ggs_remote::ws::msg::HelloAck;
use interprocess::local_socket::tokio::{prelude::*, RecvHalf, SendHalf, Stream};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const PASSWORD: &str = "tangerine-kayak-42";

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

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

/// Login through the Hub for any PC's link: answers the session cookie and the CSRF value
/// (the first half of every browser-facing test here).
async fn login_through(addr: std::net::SocketAddr, uuid: &str, password: &str) -> (String, String) {
    let base = format!("/u/{uuid}/");
    let (status, head, _body) = http(
        addr,
        "POST",
        &format!("{base}api/login"),
        &[
            ("content-type", "application/json"),
            ("origin", &format!("http://127.0.0.1:{}", addr.port())),
        ],
        &format!("{{\"password\":\"{password}\",\"device\":\"joint\",\"remember\":false}}"),
    )
    .await;
    assert_eq!(status, 200, "login through the hub: {head}");
    let cookie = find_cookie(&head).expect("a session cookie");

    let (status, _head, body) = http(
        addr,
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
    (cookie, csrf)
}

/// The workbench WebSocket of one link — cookie and origin in place, HELLO not yet sent.
async fn browser_ws(addr: std::net::SocketAddr, uuid: &str, cookie: &str) -> Ws {
    let ws_url = format!("ws://{}/u/{}/ws", addr, uuid);
    let mut request = ws_url.as_str().into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Cookie", cookie.parse().unwrap());
    request.headers_mut().insert(
        "Origin",
        format!("http://127.0.0.1:{}", addr.port()).parse().unwrap(),
    );
    let (ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    ws
}

/// Login through the Hub, then ride one WebSocket: HELLO (with the CSRF from /api/session),
/// ATTACH-less INVOKE (the daemon answers "not attached"), and the WINDOWS push.
async fn browser_session(both: &Both) -> (Ws, Vec<Frame>) {
    let (cookie, csrf) = login_through(both.hub_addr, &both.uuid, PASSWORD).await;
    let mut ws = browser_ws(both.hub_addr, &both.uuid, &cookie).await;

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
async fn a_hub_saved_before_the_password_connects_when_it_lands() {
    // The set-password screen's order: the relay is saved first, the password after. The
    // hub loop parks in NoPassword until the password lands — setting it must wake the
    // tunnel (the admin and pair routes share this one handler).
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
    let hub_port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let app = ggs_remote_hub::router(hub)
            .into_make_service_with_connect_info::<std::net::SocketAddr>();
        let _ = axum::serve(listener, app).await;
    });

    daemon
        .hub
        .connect(Settings {
            url: format!("http://127.0.0.1:{hub_port}"),
            join_key: String::new(),
            fingerprint: String::new(),
        })
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if matches!(daemon.hub.snapshot(), Status::NoPassword) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "a relay saved without a password must sit in NoPassword"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    let response = ggs_remote::http::api::set_password(&daemon, PASSWORD).await;
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if daemon.hub.snapshot().online() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the password landing must wake the parked tunnel"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    task.abort();
    let _ = task.await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_relay_link_leads_the_status_links_when_online() {
    let both = start().await;
    let status = ggs_remote::http::admin::status_json(&both.daemon, true);
    let public = format!("http://127.0.0.1:{}/u/{}/", both.hub_addr.port(), both.uuid);
    assert_eq!(status["links"][0].as_str(), Some(public.as_str()));
    assert_eq!(status["link"].as_str(), Some(public.as_str()));
    let lan: Vec<&str> = status["lanLinks"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert!(
        !lan.is_empty(),
        "the LAN links stay addressable for the CA anchors"
    );
    assert!(!lan.contains(&public.as_str()));
    let all: Vec<&str> = status["links"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    // While the relay is online its link is the one QR shown (2026-10-12, the owner's
    // direction — a set server makes the LAN codes clutter); `lanLinks` above keeps the
    // direct addresses for the CA anchors.
    assert_eq!(all, vec![public.as_str()], "links is the relay link alone");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_admin_connect_body_takes_the_extension_camel_case() {
    // The extension's admin client posts `joinKey` (camelCase); the body struct's snake
    // spelling once ate it — a keyless Hub hid the loss, a keyed one refused the tunnel
    // with "join-key" no matter what the page sent.
    let both = start().await;
    let url = format!("http://127.0.0.1:{}", both.hub_addr.port());
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        "authorization",
        format!("Bearer {}", both.daemon.admin_token)
            .parse()
            .unwrap(),
    );
    let body =
        serde_json::from_value::<ggs_remote::http::admin::HubConnectBody>(serde_json::json!({
            "url": url,
            "joinKey": "server-secret"
        }))
        .unwrap();
    let response = ggs_remote::http::admin::hub_connect(
        axum::extract::State(both.daemon.clone()),
        headers.clone(),
        axum::Json(body),
    )
    .await;
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert_eq!(
        both.daemon.hub.current().map(|s| s.join_key),
        Some("server-secret".into())
    );

    let body =
        serde_json::from_value::<ggs_remote::http::admin::HubConnectBody>(serde_json::json!({
            "url": url,
            "join_key": "snake-secret"
        }))
        .unwrap();
    let response = ggs_remote::http::admin::hub_connect(
        axum::extract::State(both.daemon.clone()),
        headers,
        axum::Json(body),
    )
    .await;
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert_eq!(
        both.daemon.hub.current().map(|s| s.join_key),
        Some("snake-secret".into())
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_plain_http_hub_login_sets_a_cookie_the_browser_keeps() {
    // §7.6: the cookie's `Secure` follows the browser's scheme. A plain-HTTP Hub once got
    // a `Secure` cookie anyway — the login answered 200 while the browser silently dropped
    // it, so no session ever held (raw-socket tests never noticed; only browsers enforce).
    let both = start().await;
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
        &format!("{{\"password\":\"{PASSWORD}\",\"device\":\"cookie-test\",\"remember\":false}}"),
    )
    .await;
    assert_eq!(status, 200, "login through the hub: {head}");
    let cookie_line = head
        .lines()
        .find(|line| line.to_ascii_lowercase().starts_with("set-cookie:"))
        .expect("a Set-Cookie on login");
    assert!(cookie_line.contains("HttpOnly"), "{cookie_line}");
    assert!(
        cookie_line.contains(&format!("Path={base}")),
        "{cookie_line}"
    );
    assert!(
        !cookie_line.to_ascii_lowercase().contains("secure"),
        "a plain-HTTP browser drops a Secure cookie: {cookie_line}"
    );
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
                            .send(Message::Binary(Frame::empty(ty::T_PONG).encode().into()))
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

    let probe = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
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

// ==== The multi-PC joint suite (§20.12): one Hub, several real daemons ====

/// One Hub (kept by its `Arc` — the tests read its tunnel table) with a spawnable family of
/// real daemons under one temp home: every §20.12 row that needs two PCs, a join key, or a
/// device key carried across machines.
struct Joint {
    _dir: tempfile::TempDir,
    hub: Arc<ggs_remote_hub::state::Hub>,
    hub_addr: std::net::SocketAddr,
}

async fn joint(join_key: &str) -> Joint {
    let dir = tempfile::tempdir().unwrap();
    let hub = ggs_remote_hub::state::Hub::new(ggs_remote_hub::config::Config {
        join_key: join_key.to_owned(),
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let hub_addr = listener.local_addr().unwrap();
    let app = ggs_remote_hub::router(hub.clone())
        .into_make_service_with_connect_info::<std::net::SocketAddr>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Joint {
        _dir: dir,
        hub,
        hub_addr,
    }
}

impl Joint {
    /// One real daemon under its own home — listeners up, no password, no Hub settings yet.
    fn daemon(&self, name: &str) -> Arc<Daemon> {
        let paths = Paths::at(self._dir.path().join(name), self._dir.path().to_path_buf());
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
        daemon
    }

    /// Password set, tunnel up: answers this PC's uuid once it is Online.
    async fn online(&self, daemon: &Arc<Daemon>, password: &str, join_key: &str) -> String {
        daemon.auth.set_password(password).await.unwrap();
        daemon
            .hub
            .connect(Settings {
                url: format!("http://127.0.0.1:{}", self.hub_addr.port()),
                join_key: join_key.to_owned(),
                fingerprint: String::new(),
            })
            .unwrap();
        wait_online(daemon).await
    }
}

async fn wait_online(daemon: &Arc<Daemon>) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Status::Online { uuid, .. } = daemon.hub.snapshot() {
            return uuid;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the daemon never went Online: {:?}",
            daemon.hub.snapshot()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// One admin call on a daemon's loopback listener — the extension's own channel, Bearer and
/// all (the same wire the Remote Access page's buttons ride).
async fn admin(daemon: &Arc<Daemon>, path: &str, body: &str) -> (u16, String, String) {
    let mut port = 0;
    for _ in 0..200 {
        port = daemon.loopback_port.load(Ordering::Relaxed);
        if port != 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(port != 0, "the daemon's loopback listener never came up");
    http(
        std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        "POST",
        path,
        &[
            ("content-type", "application/json"),
            ("authorization", &format!("Bearer {}", daemon.admin_token)),
        ],
        body,
    )
    .await
}

/// Drain a browser socket until the server closes it; answers the close code.
async fn await_close(ws: &mut Ws) -> u16 {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let message = tokio::time::timeout_at(deadline, ws.next())
            .await
            .expect("a close within 5 s")
            .unwrap()
            .unwrap();
        if let Message::Close(frame) = message {
            return frame.map(|f| f.code).map(|c| c.into()).unwrap_or(0);
        }
    }
}

/// A fake GGS instance on the control channel — the asset source of a joint PC. Heartbeat
/// pings are answered on the way through every read.
struct FakeInstance {
    rx: RecvHalf,
    tx: SendHalf,
}

impl FakeInstance {
    async fn connect(daemon: &Arc<Daemon>, id: &str) -> FakeInstance {
        let endpoint = daemon.paths.control_endpoint();
        #[cfg(windows)]
        let name = {
            use interprocess::local_socket::{GenericNamespaced, ToNsName};
            endpoint.as_str().to_ns_name::<GenericNamespaced>().unwrap()
        };
        #[cfg(not(windows))]
        let name = {
            use interprocess::local_socket::{GenericFilePath, ToFsName};
            endpoint.as_str().to_fs_name::<GenericFilePath>().unwrap()
        };
        let stream = Stream::connect(name).await.unwrap();
        let (rx, tx) = stream.split();
        let mut fake = FakeInstance { rx, tx };
        fake.send(&FromInstance::Register {
            instance_id: id.into(),
            pid: std::process::id(),
            version: "0.1.10".into(),
            title: "repo".into(),
            folders: vec!["C:/repo".into()],
            visible: true,
            remote_host: false,
            launch: LaunchSpec::default(),
            sandboxed: false,
            control_token: String::new(),
        })
        .await;
        match fake.recv().await {
            ToInstance::Welcome { .. } => {}
            other => panic!("expected Welcome, got {other:?}"),
        }
        fake
    }

    async fn send(&mut self, message: &FromInstance) {
        self.tx
            .write_all(&control_msg::encode(message))
            .await
            .unwrap();
    }

    /// The next message that is not a heartbeat ping (pings answered on the way).
    async fn recv(&mut self) -> ToInstance {
        loop {
            let body = tokio::time::timeout(
                Duration::from_secs(5),
                control_msg::read_message(&mut self.rx),
            )
            .await
            .expect("a control message within 5 s")
            .unwrap();
            match control_msg::decode::<ToInstance>(&body).unwrap() {
                ToInstance::Ping { nonce } => self.send(&FromInstance::Pong { nonce }).await,
                other => return other,
            }
        }
    }

    /// `None` when nothing but heartbeats arrived within `ms` — asserting a tunnel was
    /// never asked.
    async fn quiet_for(&mut self, ms: u64) -> Option<ToInstance> {
        tokio::time::timeout(Duration::from_millis(ms), self.recv())
            .await
            .ok()
    }

    /// Answer the next FetchAsset with a fixed body, asserting the path it asked for.
    async fn serve_asset(&mut self, want_path: &str, content_type: &str, body: &str) {
        match self.recv().await {
            ToInstance::FetchAsset { req, path, .. } => {
                assert_eq!(path, want_path);
                self.send(&FromInstance::AssetReply {
                    req,
                    status: 200,
                    content_type: content_type.into(),
                    etag: String::new(),
                    body: body.as_bytes().to_vec(),
                    done: true,
                })
                .await;
            }
            other => panic!("expected FetchAsset for {want_path}, got {other:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_pcs_through_one_hub_never_touch_each_other() {
    // The M9 exit criterion: two PCs behind one Hub, served at once, neither hearing the
    // other. Each daemon keeps its own password and session store — a cookie minted on A's
    // link is just a random string to B (the Playwright row's rule, at the wire level).
    let j = joint("").await;
    let a = j.daemon("a");
    let uuid_a = j.online(&a, PASSWORD, "").await;
    let b = j.daemon("b");
    let uuid_b = j.online(&b, "plum-trellis-88", "").await;
    assert_ne!(uuid_a, uuid_b);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if j.hub.tunnel_count() == 2 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "both tunnels must be live together: {}",
            j.hub.tunnel_count()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    let (cookie_a, _csrf) = login_through(j.hub_addr, &uuid_a, PASSWORD).await;
    let (cookie_b, _csrf) = login_through(j.hub_addr, &uuid_b, "plum-trellis-88").await;

    // A's session on B's link, and B's on A's: both refused (401), both directions.
    let (status, _head, _body) = http(
        j.hub_addr,
        "GET",
        &format!("/u/{uuid_b}/api/session"),
        &[("cookie", &cookie_a)],
        "",
    )
    .await;
    assert_eq!(status, 401, "A's cookie must not open B's link");
    let (status, _head, _body) = http(
        j.hub_addr,
        "GET",
        &format!("/u/{uuid_a}/api/session"),
        &[("cookie", &cookie_b)],
        "",
    )
    .await;
    assert_eq!(status, 401, "B's cookie must not open A's link");
    // Each own link still answers its own cookie.
    let (status, _head, _body) = http(
        j.hub_addr,
        "GET",
        &format!("/u/{uuid_a}/api/session"),
        &[("cookie", &cookie_a)],
        "",
    )
    .await;
    assert_eq!(status, 200);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wrong_join_key_is_refused_until_the_right_one_is_saved() {
    // The Hub's join key end to end (§20.3): a wrong key answers T_REJECTED and the daemon
    // reports it; saving the right key through the page's one-setting update retries at
    // once — no reconnect ceremony, no waiting out the backoff.
    let j = joint("sesame").await;
    let a = j.daemon("a");
    a.auth.set_password(PASSWORD).await.unwrap();
    a.hub
        .connect(Settings {
            url: format!("http://127.0.0.1:{}", j.hub_addr.port()),
            join_key: "open".into(),
            fingerprint: String::new(),
        })
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if matches!(&a.hub.snapshot(), Status::Rejected(reason) if reason == "join-key") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the wrong join key must surface as Rejected(join-key): {:?}",
            a.hub.snapshot()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    a.hub.update(|s| s.join_key = "sesame".into()).unwrap();
    let uuid = wait_online(&a).await;
    let (cookie, _csrf) = login_through(j.hub_addr, &uuid, PASSWORD).await;
    let (status, _head, _body) = http(
        j.hub_addr,
        "GET",
        &format!("/u/{uuid}/api/session"),
        &[("cookie", &cookie)],
        "",
    )
    .await;
    assert_eq!(status, 200, "the link must serve after the key is fixed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_link_change_closes_the_old_link_at_once() {
    // §20.1's "更换链接": the button's confirm text promises the old link stops working
    // immediately. The running tunnel carries the OLD key — the moment it drops, the Hub
    // retires the old uuid and the daemon reconnects under the new one.
    let j = joint("").await;
    let a = j.daemon("a");
    let old_uuid = j.online(&a, PASSWORD, "").await;
    let (cookie, csrf) = login_through(j.hub_addr, &old_uuid, PASSWORD).await;
    let mut ws = browser_ws(j.hub_addr, &old_uuid, &cookie).await;
    ws.send(Message::Binary(
        Frame::msgpack(
            ty::HELLO,
            &serde_json::json!({ "proto": 1, "client": "web", "csrf": csrf }),
        )
        .encode()
        .into(),
    ))
    .await
    .unwrap();

    // "Change link" through the extension's admin channel.
    let (status, _head, body) = admin(&a, "/admin/hub/relink", "{}").await;
    assert_eq!(status, 200, "{body}");
    let new_uuid = serde_json::from_str::<serde_json::Value>(&body).unwrap()["uuid"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(new_uuid, old_uuid);

    // The open session closes with the old tunnel (the Hub's pc-offline close).
    let code = await_close(&mut ws).await;
    assert_ne!(code, 0, "the old link's sessions must close");
    // The daemon is back Online under the new uuid — same Hub, same password.
    assert_eq!(wait_online(&a).await, new_uuid);

    // The old link is retired: the not-online page, not a stale workbench.
    let mut retired = false;
    for _ in 0..100 {
        let (status, _head, body) =
            http(j.hub_addr, "GET", &format!("/u/{old_uuid}/login"), &[], "").await;
        if status == 503 && body.contains("not online") {
            retired = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(retired, "the old link must answer the not-online page");

    // And the new link serves a fresh login.
    let (_cookie, _csrf) = login_through(j.hub_addr, &new_uuid, PASSWORD).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_exported_key_carries_the_link_to_the_second_pc() {
    // §20.1's "换电脑": the device key sealed under the access password moves the link to a
    // new PC. The second connection with the same key replaces the first (§20.4): the old
    // PC hears T_REPLACED and stops retrying; the link itself — same uuid — now serves the
    // new PC's password.
    let j = joint("").await;
    let a = j.daemon("old");
    let uuid = j.online(&a, PASSWORD, "").await;

    let (status, _head, body) = admin(
        &a,
        "/admin/hub/export-key",
        &format!("{{\"password\":\"{PASSWORD}\"}}"),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let blob = serde_json::from_str::<serde_json::Value>(&body).unwrap()["data"]
        .as_str()
        .unwrap()
        .to_owned();

    // The second PC: its own access password, the imported key. A wrong password never
    // installs anything.
    let b = j.daemon("new");
    b.auth.set_password("vellum-cactus-5").await.unwrap();
    let (status, _head, _body) = admin(
        &b,
        "/admin/hub/import-key",
        &format!("{{\"password\":\"wrong\",\"data\":\"{blob}\"}}"),
    )
    .await;
    assert_eq!(status, 400, "a wrong export password must be refused");
    let (status, _head, body) = admin(
        &b,
        "/admin/hub/import-key",
        &format!("{{\"password\":\"{PASSWORD}\",\"data\":\"{blob}\"}}"),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let imported = serde_json::from_str::<serde_json::Value>(&body).unwrap()["uuid"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(imported, uuid, "the imported key must keep the same link");

    // B connects with the same Hub: same key, same uuid — the Hub replaces A's tunnel.
    b.hub
        .connect(Settings {
            url: format!("http://127.0.0.1:{}", j.hub_addr.port()),
            join_key: String::new(),
            fingerprint: String::new(),
        })
        .unwrap();
    assert_eq!(wait_online(&b).await, uuid);

    // A heard T_REPLACED: the status says so and the loop parks (no auto-retry, §20.4).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if a.hub.snapshot() == Status::Replaced {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the displaced PC must report Replaced: {:?}",
            a.hub.snapshot()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // The link now serves B: its password in, the old PC's refused.
    let (cookie, _csrf) = login_through(j.hub_addr, &uuid, "vellum-cactus-5").await;
    let (status, _head, _body) = http(
        j.hub_addr,
        "GET",
        &format!("/u/{uuid}/api/session"),
        &[("cookie", &cookie)],
        "",
    )
    .await;
    assert_eq!(status, 200);
    let (status, head, _body) = http(
        j.hub_addr,
        "POST",
        &format!("/u/{uuid}/api/login"),
        &[
            ("content-type", "application/json"),
            ("origin", &format!("http://127.0.0.1:{}", j.hub_addr.port())),
        ],
        &format!("{{\"password\":\"{PASSWORD}\",\"device\":\"joint\",\"remember\":false}}"),
    )
    .await;
    assert_eq!(status, 401, "the old PC's password is gone: {head}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_browser_session_resumes_when_the_tunnel_returns() {
    // §20.12's "隧道恢复后浏览器会话续上": the tunnel dies under a browser session — the
    // session parks (not retired), the missed WINDOWS lands in the resume ring, and the
    // browser that reconnects through the recovered tunnel resumes onto the same state.
    let j = joint("").await;
    let a = j.daemon("a");
    let uuid = j.online(&a, PASSWORD, "").await;
    let (cookie, csrf) = login_through(j.hub_addr, &uuid, PASSWORD).await;

    let mut ws = browser_ws(j.hub_addr, &uuid, &cookie).await;
    ws.send(Message::Binary(
        Frame::msgpack(
            ty::HELLO,
            &serde_json::json!({ "proto": 1, "client": "web", "csrf": csrf }),
        )
        .encode()
        .into(),
    ))
    .await
    .unwrap();
    let mut sid = None;
    let mut last_seq = 0u32;
    for _ in 0..12 {
        let message = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Message::Binary(bytes) = message else {
            continue;
        };
        for frame in Frame::decode_all(&bytes).unwrap_or_default() {
            if frame.ty == ty::HELLO_ACK {
                sid = frame.decode_msgpack::<HelloAck>().map(|ack| ack.sid);
            } else if frame.seq > last_seq {
                last_seq = frame.seq;
            }
        }
        if sid.is_some() && last_seq > 0 {
            break;
        }
    }
    let sid = sid.expect("a HELLO_ACK with a sid");
    assert!(last_seq > 0, "the initial WINDOWS push carries a seq");

    // The tunnel dies (a settings touch restarts it — the same path a join-key save takes).
    a.hub.update(|_| {}).unwrap();
    // The Hub closes the browser socket with the tunnel (4503 pc-offline).
    let code = await_close(&mut ws).await;
    assert_eq!(code, 4503, "the browser closes as the tunnel dies");
    // Back online on the same link — same device key, same uuid.
    assert_eq!(wait_online(&a).await, uuid);

    // While the browser is away, a window registers: the WINDOWS push must land in the
    // parked connection's ring (a brief settle lets the old session task park first).
    let _instance = FakeInstance::connect(&a, "ggs-live-1").await;
    tokio::time::sleep(Duration::from_millis(150)).await;

    // Resume: the same sid, everything after last_seq.
    let mut ws = browser_ws(j.hub_addr, &uuid, &cookie).await;
    ws.send(Message::Binary(
        Frame::msgpack(
            ty::HELLO,
            &serde_json::json!({
                "proto": 1, "client": "web", "csrf": csrf,
                "resume": { "sid": sid, "lastSeq": last_seq }
            }),
        )
        .encode()
        .into(),
    ))
    .await
    .unwrap();

    let mut resumed = None;
    let mut replayed = Vec::new();
    for _ in 0..12 {
        let message = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Message::Binary(bytes) = message else {
            continue;
        };
        for frame in Frame::decode_all(&bytes).unwrap_or_default() {
            if frame.ty == ty::HELLO_ACK {
                let ack = frame.decode_msgpack::<HelloAck>().expect("a HELLO_ACK");
                assert_eq!(ack.sid, sid, "the resumed session keeps its sid");
                resumed = Some(ack.resumed);
            } else if frame.ty == ty::WINDOWS {
                replayed.push(frame);
            }
        }
        if resumed == Some(true) && !replayed.is_empty() {
            break;
        }
    }
    assert_eq!(resumed, Some(true), "the session must resume, not restart");
    let missed: Vec<serde_json::Value> =
        replayed.iter().filter_map(|f| f.decode_msgpack()).collect();
    assert!(
        missed.iter().any(|w| w["instances"]
            .as_array()
            .is_some_and(|list| list.iter().any(|i| i["id"] == "ggs-live-1"))),
        "the WINDOWS registered while away must replay: {missed:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_shared_cache_answers_immutable_assets_across_pcs() {
    // §20.6's cross-PC cache: only the workbench's immutable build artifacts are shared —
    // every PC ships the same bytes, so the Hub may answer them for any tunnel without
    // waking it. A mutable page is never cached: every fetch rides its own tunnel.
    let j = joint("").await;
    let a = j.daemon("a");
    let uuid_a = j.online(&a, PASSWORD, "").await;
    let b = j.daemon("b");
    let uuid_b = j.online(&b, "quartz-lantern-3", "").await;
    let (cookie_a, _csrf) = login_through(j.hub_addr, &uuid_a, PASSWORD).await;
    let (cookie_b, _csrf) = login_through(j.hub_addr, &uuid_b, "quartz-lantern-3").await;
    let mut inst_a = FakeInstance::connect(&a, "ggs-a").await;
    let mut inst_b = FakeInstance::connect(&b, "ggs-b").await;

    // PC A serves one hashed (immutable) asset through its own link.
    let hashed = "/w/ggs-a/v/0.1.10/assets/remote-Ab12Cd34.js";
    let path = format!("/u/{uuid_a}{hashed}");
    let cookie = cookie_a.clone();
    let fetch =
        tokio::spawn(
            async move { http(j.hub_addr, "GET", &path, &[("cookie", &cookie)], "").await },
        );
    inst_a
        .serve_asset("assets/remote-Ab12Cd34.js", "text/javascript", "from-pc-a")
        .await;
    let (status, _head, body) = tokio::time::timeout(Duration::from_secs(2), fetch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, 200);
    assert_eq!(body, "from-pc-a");

    // The same asset under B's OWN instance name — a browser on B's link asks B's windows,
    // whatever their ids are. Every PC ships the same bytes for the same version and hashed
    // name, so the Hub's shared cache answers A's copy without waking B's tunnel.
    let path = format!("/u/{uuid_b}/w/ggs-b/v/0.1.10/assets/remote-Ab12Cd34.js");
    let cookie = cookie_b.clone();
    let fetch =
        tokio::spawn(
            async move { http(j.hub_addr, "GET", &path, &[("cookie", &cookie)], "").await },
        );
    let asked = inst_b.quiet_for(300).await;
    assert!(
        asked.is_none(),
        "the shared cache must answer without waking B's tunnel: {asked:?}"
    );
    let (status, _head, body) = tokio::time::timeout(Duration::from_secs(2), fetch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, 200);
    assert_eq!(
        body, "from-pc-a",
        "the immutable asset must arrive from the shared cache, byte-for-byte A's"
    );

    // A mutable page is never cached: each fetch reaches B's own instance and serves what
    // it answers now.
    let page = "/w/ggs-b/v/0.1.10/remote.html";
    let path = format!("/u/{uuid_b}{page}");
    let cookie = cookie_b.clone();
    let fetch =
        tokio::spawn(
            async move { http(j.hub_addr, "GET", &path, &[("cookie", &cookie)], "").await },
        );
    inst_b
        .serve_asset("remote.html", "text/html", "b-first")
        .await;
    let (status, _head, body) = tokio::time::timeout(Duration::from_secs(2), fetch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, 200);
    assert_eq!(body, "b-first");
    let path = format!("/u/{uuid_b}{page}");
    let cookie = cookie_b.clone();
    let fetch =
        tokio::spawn(
            async move { http(j.hub_addr, "GET", &path, &[("cookie", &cookie)], "").await },
        );
    inst_b
        .serve_asset("remote.html", "text/html", "b-second")
        .await;
    let (status, _head, body) = tokio::time::timeout(Duration::from_secs(2), fetch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, 200);
    assert_eq!(body, "b-second");
}
