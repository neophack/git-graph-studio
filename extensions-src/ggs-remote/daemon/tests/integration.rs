//! End-to-end: a real daemon on loopback ports (hermetic `~/.ggs/remote`, plain HTTP), a fake
//! GGS instance on the control channel, a fake Relay on the loopback WebSocket and a fake
//! browser — the plan's §17.1 http / ws / registry / relay suites in one file, sharing one
//! daemon per test.

use futures_util::{SinkExt, StreamExt};
use interprocess::local_socket::tokio::{prelude::*, RecvHalf, SendHalf, Stream};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use ggs_remote::config::{Config, TlsMode};
use ggs_remote::control_msg::{self, FromInstance, LaunchSpec, ToInstance};
use ggs_remote::paths::Paths;
use ggs_remote::state::Daemon;
use ggs_remote::ws::frame::{flag, ty, Enc, Frame};

const PASSWORD: &str = "tangerine-kayak-42";

struct Harness {
    _dir: tempfile::TempDir,
    daemon: Arc<Daemon>,
    public: u16,
    loopback: u16,
}

async fn start() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
    let config = Config {
        port: 0,
        bind: "127.0.0.1".into(),
        tls: ggs_remote::config::TlsConfig {
            mode: TlsMode::None,
            ..Default::default()
        },
        ..Default::default()
    };
    config
        .save(&{
            paths.ensure().unwrap();
            paths.clone()
        })
        .unwrap();
    let daemon = Daemon::new(paths, config).unwrap();
    let run = daemon.clone();
    tokio::spawn(async move { ggs_remote::server::run(run).await });
    for _ in 0..200 {
        if daemon.listening.load(Ordering::Relaxed)
            && daemon.loopback_port.load(Ordering::Relaxed) != 0
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let public = daemon.public_port.load(Ordering::Relaxed);
    let loopback = daemon.loopback_port.load(Ordering::Relaxed);
    assert!(public != 0 && loopback != 0, "daemon did not come up");
    Harness {
        _dir: dir,
        daemon,
        public,
        loopback,
    }
}

struct HttpResponse {
    status: u16,
    headers: String,
    body: String,
}

async fn http(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> HttpResponse {
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let body = body.unwrap_or("");
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
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
    HttpResponse {
        status,
        headers: head.to_owned(),
        body,
    }
}

fn dechunk(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    while let Some((size, after)) = rest.split_once("\r\n") {
        let Ok(n) = usize::from_str_radix(size.trim(), 16) else {
            break;
        };
        if n == 0 || after.len() < n {
            break;
        }
        out.push_str(&after[..n]);
        rest = after[n..].trim_start_matches("\r\n");
    }
    out
}

async fn admin(h: &Harness, method: &str, path: &str, body: &str) -> HttpResponse {
    let auth = format!("Bearer {}", h.daemon.admin_token);
    http(
        h.loopback,
        method,
        path,
        &[
            ("Authorization", &auth),
            ("Content-Type", "application/json"),
        ],
        Some(body),
    )
    .await
}

async fn set_password(h: &Harness) {
    let response = admin(
        h,
        "POST",
        "/admin/password",
        &format!(r#"{{"password":"{PASSWORD}"}}"#),
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.body);
}

/// Log in; answers the cookie header value and the session's CSRF token.
async fn login(h: &Harness) -> (String, String) {
    let response = http(
        h.public,
        "POST",
        "/api/login",
        &[("Content-Type", "application/json")],
        Some(&format!(r#"{{"password":"{PASSWORD}","device":"test"}}"#)),
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.body);
    let cookie_line = response
        .headers
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("set-cookie:"))
        .unwrap()
        .to_owned();
    assert!(
        cookie_line.contains("HttpOnly")
            && cookie_line.contains("SameSite=Strict")
            && cookie_line.contains("Path=/")
    );
    let cookie = cookie_line
        .split_once(':')
        .unwrap()
        .1
        .trim()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let session = http(
        h.public,
        "GET",
        "/api/session",
        &[("Cookie", &cookie)],
        None,
    )
    .await;
    let csrf = serde_json::from_str::<serde_json::Value>(&session.body).unwrap()["csrf"]
        .as_str()
        .unwrap()
        .to_owned();
    (cookie, csrf)
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn browser(h: &Harness, cookie: &str, csrf: &str) -> Ws {
    let mut request = format!("ws://127.0.0.1:{}/ws", h.public)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Cookie", cookie.parse().unwrap());
    request.headers_mut().insert(
        "Origin",
        format!("http://127.0.0.1:{}", h.public).parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let hello = serde_json::json!({ "proto": 1, "client": "test", "csrf": csrf, "caps": { "deflate": false } });
    send(&mut ws, Frame::msgpack(ty::HELLO, &hello)).await;
    let ack = next_of(&mut ws, ty::HELLO_ACK).await;
    let ack: serde_json::Value = ack.decode_msgpack().unwrap();
    assert_eq!(ack["resumed"], false);
    ws
}

async fn send(ws: &mut Ws, frame: Frame) {
    ws.send(Message::Binary(frame.encode().into()))
        .await
        .unwrap();
}

/// The next frame of the given type (others are skipped), within 5 s.
async fn next_of(ws: &mut Ws, want: u8) -> Frame {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let message = tokio::time::timeout_at(deadline, ws.next())
            .await
            .unwrap_or_else(|_| panic!("no frame of type {want:#x} within 5 s"))
            .expect("socket open")
            .expect("socket ok");
        if let Message::Binary(bytes) = message {
            for mut frame in Frame::decode_all(&bytes).unwrap() {
                frame.decompress().unwrap();
                if frame.ty == want {
                    return frame;
                }
            }
        }
    }
}

/// The first WINDOWS frame whose recent list leads with `needle` (skips the interim pushes).
async fn windows_until(ws: &mut Ws, needle: &str) -> serde_json::Value {
    loop {
        let frame = next_of(ws, ty::WINDOWS).await;
        let body: serde_json::Value = frame.decode_msgpack().unwrap();
        let first = body["recentFolders"].as_array().and_then(|l| l.first());
        if first.and_then(|v| v.as_str()) == Some(needle) {
            return body["recentFolders"].clone();
        }
    }
}

/// A fake GGS instance on the control channel.
struct FakeInstance {
    rx: RecvHalf,
    tx: SendHalf,
}

impl FakeInstance {
    async fn connect(h: &Harness, id: &str) -> FakeInstance {
        Self::connect_with_pid(h, id, std::process::id()).await
    }

    /// Register with a full identity: the pid restart terminates and the launch spec it
    /// relaunches with, plus the folders the new instance reopens.
    async fn connect_spec(
        h: &Harness,
        id: &str,
        pid: u32,
        launch: LaunchSpec,
        folders: Vec<String>,
    ) -> FakeInstance {
        Self::connect_full(h, id, pid, launch, folders).await
    }

    /// Register under someone else's pid — the force-close test must kill that pid, not the
    /// test process itself.
    async fn connect_with_pid(h: &Harness, id: &str, pid: u32) -> FakeInstance {
        Self::connect_full(h, id, pid, LaunchSpec::default(), vec!["C:/repo".into()]).await
    }

    async fn connect_full(
        h: &Harness,
        id: &str,
        pid: u32,
        launch: LaunchSpec,
        folders: Vec<String>,
    ) -> FakeInstance {
        let endpoint = h.daemon.paths.control_endpoint();
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
            pid,
            version: "0.1.10".into(),
            title: "repo".into(),
            folders,
            visible: true,
            remote_host: false,
            launch,
            sandboxed: false,
            control_token: String::new(),
        })
        .await;
        match fake.recv().await {
            ToInstance::Welcome { relay_url, .. } => assert!(relay_url.ends_with("/relay")),
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

    /// Like `recv`, but `None` on timeout instead of a panic (asserting silence).
    async fn recv_within(&mut self, ms: u64) -> Option<ToInstance> {
        tokio::time::timeout(Duration::from_millis(ms), self.recv_pings_only())
            .await
            .ok()
    }

    async fn recv_pings_only(&mut self) -> ToInstance {
        loop {
            let body = control_msg::read_message(&mut self.rx).await.unwrap();
            match control_msg::decode::<ToInstance>(&body).unwrap() {
                ToInstance::Ping { nonce } => self.send(&FromInstance::Pong { nonce }).await,
                other => return other,
            }
        }
    }

    /// The next message that is not a heartbeat ping (answered on the way).
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
}

async fn relay(h: &Harness, token: &str) -> Ws {
    let url = format!("ws://127.0.0.1:{}/relay?t={token}", h.loopback);
    let (ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    ws
}

#[tokio::test]
async fn no_password_means_a_notice_and_admin_sets_it() {
    let h = start().await;
    let page = http(h.public, "GET", "/login", &[], None).await;
    assert_eq!(page.status, 503);
    let unauthorized = http(
        h.loopback,
        "POST",
        "/admin/password",
        &[("Content-Type", "application/json")],
        Some("{}"),
    )
    .await;
    assert_eq!(unauthorized.status, 401);
    let weak = admin(&h, "POST", "/admin/password", r#"{"password":"password"}"#).await;
    assert_eq!(weak.status, 400);
    set_password(&h).await;
    let page = http(h.public, "GET", "/login", &[], None).await;
    assert_eq!(page.status, 200);
    assert!(page.body.contains("static/login.js"));
    assert!(page
        .headers
        .to_ascii_lowercase()
        .contains("content-security-policy"));
}

#[tokio::test]
async fn login_rate_limit_and_routes_need_a_session() {
    let h = start().await;
    set_password(&h).await;
    let windows = http(h.public, "GET", "/windows", &[], None).await;
    assert_eq!(windows.status, 302);
    let asset = http(h.public, "GET", "/w/x/v/1/remote.html", &[], None).await;
    assert_eq!(asset.status, 401);
    let form = http(
        h.public,
        "POST",
        "/api/login",
        &[("Content-Type", "application/x-www-form-urlencoded")],
        Some("password=x"),
    )
    .await;
    assert_eq!(form.status, 415);
    for attempt in 1..=5 {
        let wrong = http(
            h.public,
            "POST",
            "/api/login",
            &[("Content-Type", "application/json")],
            Some(r#"{"password":"nope-nope-nope"}"#),
        )
        .await;
        let expect = if attempt < 5 { 401 } else { 429 };
        assert_eq!(wrong.status, expect, "attempt {attempt}");
    }
    let locked = http(
        h.public,
        "POST",
        "/api/login",
        &[("Content-Type", "application/json")],
        Some(&format!(r#"{{"password":"{PASSWORD}"}}"#)),
    )
    .await;
    assert_eq!(
        locked.status, 429,
        "the right password is refused while locked"
    );
}

#[tokio::test]
async fn websocket_checks_origin_and_csrf() {
    let h = start().await;
    set_password(&h).await;
    let (cookie, csrf) = login(&h).await;

    let mut request = format!("ws://127.0.0.1:{}/ws", h.public)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Cookie", cookie.parse().unwrap());
    request
        .headers_mut()
        .insert("Origin", "http://evil.example".parse().unwrap());
    assert!(tokio_tungstenite::connect_async(request).await.is_err());

    let mut request = format!("ws://127.0.0.1:{}/ws", h.public)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Cookie", cookie.parse().unwrap());
    request.headers_mut().insert(
        "Origin",
        format!("http://127.0.0.1:{}", h.public).parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    send(
        &mut ws,
        Frame::msgpack(
            ty::HELLO,
            &serde_json::json!({ "proto": 1, "csrf": "forged" }),
        ),
    )
    .await;
    let close = next_of(&mut ws, ty::CLOSE).await;
    let close: serde_json::Value = close.decode_msgpack().unwrap();
    assert_eq!(close["code"], 4403);

    let mut ws = browser(&h, &cookie, &csrf).await;
    let windows = next_of(&mut ws, ty::WINDOWS).await;
    let windows: serde_json::Value = windows.decode_msgpack().unwrap();
    assert_eq!(windows["instances"], serde_json::json!([]));
}

#[tokio::test]
async fn password_change_kicks_every_socket_within_a_second() {
    let h = start().await;
    set_password(&h).await;
    let (cookie, csrf) = login(&h).await;
    let mut ws = browser(&h, &cookie, &csrf).await;
    let response = admin(
        &h,
        "POST",
        "/admin/password",
        r#"{"password":"another-kayak-77"}"#,
    )
    .await;
    assert_eq!(response.status, 200);
    // The clock starts when the change COMMITS (its response lands): the Argon2 hashing
    // of the new password is machine speed, the kick fan-out is what the second buys.
    let kicked_at = std::time::Instant::now();
    let close = next_of(&mut ws, ty::CLOSE).await;
    let close: serde_json::Value = close.decode_msgpack().unwrap();
    assert_eq!(close["code"], 4401);
    assert_eq!(close["reason"], "credentials-changed");
    assert!(kicked_at.elapsed() < Duration::from_secs(1));
    let session = http(
        h.public,
        "GET",
        "/api/session",
        &[("Cookie", &cookie)],
        None,
    )
    .await;
    assert_eq!(session.status, 401, "the old cookie is dead");
}

#[tokio::test]
async fn attach_invoke_assets_and_instance_exit() {
    let h = start().await;
    set_password(&h).await;
    let (cookie, csrf) = login(&h).await;
    let mut ws = browser(&h, &cookie, &csrf).await;
    let _ = next_of(&mut ws, ty::WINDOWS).await;

    let mut instance = FakeInstance::connect(&h, "ggs-test-1").await;
    let windows = next_of(&mut ws, ty::WINDOWS).await;
    let windows: serde_json::Value = windows.decode_msgpack().unwrap();
    assert_eq!(windows["instances"][0]["id"], "ggs-test-1");

    // ATTACH → the instance is asked for a Relay → the Relay connects → ATTACHED.
    send(
        &mut ws,
        Frame::msgpack(ty::ATTACH, &serde_json::json!({ "instance": "ggs-test-1" })),
    )
    .await;
    let token = match instance.recv().await {
        ToInstance::EnsureRelay { token } => token,
        other => panic!("expected EnsureRelay, got {other:?}"),
    };
    let mut relay_ws = relay(&h, &token).await;
    let attached = next_of(&mut ws, ty::ATTACHED).await;
    let attached: serde_json::Value = attached.decode_msgpack().unwrap();
    assert_eq!(attached["assetBase"], "/w/ggs-test-1/v/0.1.10/");
    let ggs_base = attached["ggsBase"].as_str().unwrap().to_owned();
    // The token was one-time: a second Relay with it is refused.
    let url = format!("ws://127.0.0.1:{}/relay?t={token}", h.loopback);
    assert!(tokio_tungstenite::connect_async(url).await.is_err());

    // INVOKE → Relay (session stamped) → RESULT back to the browser (session cleared).
    send(
        &mut ws,
        Frame::new(
            ty::INVOKE,
            Enc::Json,
            br#"{"c":"list_dir","a":{}}"#.to_vec(),
        )
        .with_stream(7),
    )
    .await;
    let invoke = next_of(&mut relay_ws, ty::INVOKE).await;
    assert_eq!(invoke.stream, 7);
    assert_ne!(invoke.session, 0);
    assert_eq!(invoke.payload, br#"{"c":"list_dir","a":{}}"#);
    send(
        &mut relay_ws,
        Frame::new(ty::RESULT, Enc::Json, b"[\"a.rs\"]".to_vec())
            .with_stream(7)
            .with_session(invoke.session),
    )
    .await;
    let result = next_of(&mut ws, ty::RESULT).await;
    assert_eq!(result.stream, 7);
    assert_eq!(result.session, 0);
    assert_eq!(result.payload, b"[\"a.rs\"]");
    assert!(!result.has(flag::ERROR));

    // An asset: the daemon asks the instance over the control channel.
    let fetch = tokio::spawn({
        let cookie = cookie.clone();
        let port = h.public;
        async move {
            http(
                port,
                "GET",
                "/w/ggs-test-1/v/0.1.10/remote.html",
                &[("Cookie", &cookie)],
                None,
            )
            .await
        }
    });
    match instance.recv().await {
        ToInstance::FetchAsset { req, kind, path } => {
            assert_eq!(kind, control_msg::AssetKind::App);
            assert_eq!(path, "remote.html");
            instance
                .send(&FromInstance::AssetReply {
                    req,
                    status: 200,
                    content_type: "text/html".into(),
                    etag: String::new(),
                    body: b"<html>remote</html>".to_vec(),
                    done: true,
                })
                .await;
        }
        other => panic!("expected FetchAsset, got {other:?}"),
    }
    let page = fetch.await.unwrap();
    assert_eq!(page.status, 200);
    assert_eq!(page.body, "<html>remote</html>");
    // Not cached: the shell names this build's hashed scripts, and a rebuild under the same
    // version (a reinstalled 0.1.10) must reach the browser — the second request asks the
    // instance again and serves what it answers now.
    let again = tokio::spawn({
        let cookie = cookie.clone();
        let port = h.public;
        async move {
            http(
                port,
                "GET",
                "/w/ggs-test-1/v/0.1.10/remote.html",
                &[("Cookie", &cookie)],
                None,
            )
            .await
        }
    });
    match instance.recv().await {
        ToInstance::FetchAsset { req, path, .. } => {
            assert_eq!(path, "remote.html");
            instance
                .send(&FromInstance::AssetReply {
                    req,
                    status: 200,
                    content_type: "text/html".into(),
                    etag: String::new(),
                    body: b"<html>rebuilt</html>".to_vec(),
                    done: true,
                })
                .await;
        }
        other => panic!("expected FetchAsset, got {other:?}"),
    }
    assert_eq!(again.await.unwrap().body, "<html>rebuilt</html>");
    // A content-hashed asset is cached: its name changes whenever its bytes do, so the
    // second request never reaches the instance.
    let hashed = "/w/ggs-test-1/v/0.1.10/assets/remote-Ab12Cd34.js";
    let first = tokio::spawn({
        let cookie = cookie.clone();
        let port = h.public;
        async move { http(port, "GET", hashed, &[("Cookie", &cookie)], None).await }
    });
    match instance.recv().await {
        ToInstance::FetchAsset { req, path, .. } => {
            assert_eq!(path, "assets/remote-Ab12Cd34.js");
            instance
                .send(&FromInstance::AssetReply {
                    req,
                    status: 200,
                    content_type: "text/javascript".into(),
                    etag: String::new(),
                    body: b"export {}".to_vec(),
                    done: true,
                })
                .await;
        }
        other => panic!("expected FetchAsset, got {other:?}"),
    }
    assert_eq!(first.await.unwrap().body, "export {}");
    let cached = http(h.public, "GET", hashed, &[("Cookie", &cookie)], None).await;
    assert_eq!(cached.body, "export {}");
    let traversal = http(
        h.public,
        "GET",
        "/w/ggs-test-1/v/0.1.10/..%2F..%2Fauth.json",
        &[("Cookie", &cookie)],
        None,
    )
    .await;
    assert_eq!(traversal.status, 404);
    let stale = http(
        h.public,
        "GET",
        "/w/ggs-test-1/v/0.0.1/remote.html",
        &[("Cookie", &cookie)],
        None,
    )
    .await;
    assert_eq!(stale.status, 409);

    // A package file under the resource token: no cookie needed, CORS open.
    let ext = tokio::spawn({
        let port = h.public;
        let path = format!("{ggs_base}pkg-1.0.0/index.html");
        async move { http(port, "GET", &path, &[], None).await }
    });
    match instance.recv().await {
        ToInstance::FetchAsset { req, kind, path } => {
            assert_eq!(kind, control_msg::AssetKind::Ext);
            assert_eq!(path, "pkg-1.0.0/index.html");
            instance
                .send(&FromInstance::AssetReply {
                    req,
                    status: 200,
                    content_type: "text/html".into(),
                    etag: String::new(),
                    body: b"<script src=\"ggs://localhost/pkg-1.0.0/a.js\"></script>".to_vec(),
                    done: true,
                })
                .await;
        }
        other => panic!("expected FetchAsset, got {other:?}"),
    }
    let ext = ext.await.unwrap();
    assert_eq!(ext.status, 200);
    assert!(ext
        .headers
        .to_ascii_lowercase()
        .contains("access-control-allow-origin: *"));
    assert!(ext.body.contains(&format!("{ggs_base}pkg-1.0.0/a.js")));
    let forged = http(
        h.public,
        "GET",
        "/w/ggs-test-1/ggs/forged/pkg-1.0.0/index.html",
        &[],
        None,
    )
    .await;
    assert_eq!(forged.status, 404);

    // Close with unsaved files: the instance answers CloseBlocked, the browser gets a notice.
    send(
        &mut ws,
        Frame::msgpack(
            ty::INSTANCE_CLOSE,
            &serde_json::json!({ "instance": "ggs-test-1", "force": false }),
        ),
    )
    .await;
    match instance.recv().await {
        ToInstance::Quit { force, idle } => assert!(!force && !idle),
        other => panic!("expected Quit, got {other:?}"),
    }
    instance
        .send(&FromInstance::CloseBlocked {
            dirty: vec!["C:/repo/a.rs".into()],
        })
        .await;
    let notice = next_of(&mut ws, ty::NOTICE).await;
    let notice: serde_json::Value = notice.decode_msgpack().unwrap();
    assert_eq!(notice["kind"], "close-blocked");
    assert_eq!(notice["dirty"][0], "C:/repo/a.rs");

    // The instance leaves: the attached browser is sent back to the picker (4410).
    drop(instance);
    let close = next_of(&mut ws, ty::CLOSE).await;
    let close: serde_json::Value = close.decode_msgpack().unwrap();
    assert_eq!(close["code"], 4410);
    let _ = relay_ws.close(None).await;
}

#[tokio::test]
async fn resume_replays_missed_frames() {
    let h = start().await;
    set_password(&h).await;
    let (cookie, csrf) = login(&h).await;
    let mut ws = browser(&h, &cookie, &csrf).await;
    let _ = next_of(&mut ws, ty::WINDOWS).await;
    // Find the resume id from a fresh connection's HELLO_ACK.
    let mut request = format!("ws://127.0.0.1:{}/ws", h.public)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Cookie", cookie.parse().unwrap());
    request.headers_mut().insert(
        "Origin",
        format!("http://127.0.0.1:{}", h.public).parse().unwrap(),
    );
    let (mut second, _) = tokio_tungstenite::connect_async(request.clone())
        .await
        .unwrap();
    send(
        &mut second,
        Frame::msgpack(ty::HELLO, &serde_json::json!({ "proto": 1, "csrf": csrf })),
    )
    .await;
    let ack: serde_json::Value = next_of(&mut second, ty::HELLO_ACK)
        .await
        .decode_msgpack()
        .unwrap();
    let sid = ack["sid"].as_str().unwrap().to_owned();
    let windows = next_of(&mut second, ty::WINDOWS).await;
    drop(second);
    tokio::time::sleep(Duration::from_millis(200)).await;
    // While offline, a registry change queues a WINDOWS frame for the dropped connection.
    let _instance = FakeInstance::connect(&h, "ggs-test-2").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (mut third, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    send(
        &mut third,
        Frame::msgpack(
            ty::HELLO,
            &serde_json::json!({ "proto": 1, "csrf": csrf, "resume": { "sid": sid, "lastSeq": windows.seq } }),
        ),
    )
    .await;
    let ack: serde_json::Value = next_of(&mut third, ty::HELLO_ACK)
        .await
        .decode_msgpack()
        .unwrap();
    assert_eq!(ack["resumed"], true);
    let replayed: serde_json::Value = next_of(&mut third, ty::WINDOWS)
        .await
        .decode_msgpack()
        .unwrap();
    assert_eq!(replayed["instances"][0]["id"], "ggs-test-2");
}

/// The recent-paths list (2026-10-12): a window registering with folders notes them, the
/// WINDOWS frame carries them most-recent-first, a folder seen again moves to the front,
/// and the list persists as `recent.json` under the daemon's root.
#[tokio::test]
async fn windows_carries_the_recent_folder_history() {
    let h = start().await;
    set_password(&h).await;
    let (cookie, csrf) = login(&h).await;
    let mut ws = browser(&h, &cookie, &csrf).await;

    let _a = FakeInstance::connect_spec(
        &h,
        "ggs-a",
        std::process::id(),
        LaunchSpec::default(),
        vec!["C:/alpha".into(), "C:/beta".into()],
    )
    .await;
    let recent = windows_until(&mut ws, "C:/alpha").await;
    assert_eq!(
        recent,
        serde_json::json!(["C:/alpha", "C:/beta"]),
        "a multi-folder window keeps its order, the primary folder firstmost"
    );

    // A second window, then the first folder seen again through an Update: it moves to the
    // front without duplicating.
    let mut b = FakeInstance::connect_spec(
        &h,
        "ggs-b",
        std::process::id(),
        LaunchSpec::default(),
        vec!["C:/gamma".into()],
    )
    .await;
    let recent = windows_until(&mut ws, "C:/gamma").await;
    assert_eq!(
        recent,
        serde_json::json!(["C:/gamma", "C:/alpha", "C:/beta"])
    );
    b.send(&FromInstance::Update {
        title: None,
        folders: Some(vec!["C:/alpha".into()]),
        visible: None,
        summary: None,
    })
    .await;
    let recent = windows_until(&mut ws, "C:/alpha").await;
    assert_eq!(
        recent,
        serde_json::json!(["C:/alpha", "C:/gamma", "C:/beta"]),
        "an Update's folders move to the front, deduped"
    );

    // And the list is on disk, in the shape a fresh daemon loads.
    assert_eq!(
        ggs_remote::recent::Recent::load(&h.daemon.paths).list(),
        ["C:/alpha", "C:/gamma", "C:/beta"]
    );
}

/// The page language (2026-10-12): `lang.js` carries the app's `~/.ggs/settings.json`
/// language to every page — `zh-cn`/`en` when the file spells one, the empty fallback
/// (the browser's language) when it does not — and it loads before the guard (a page
/// that is paused or passwordless still needs its strings).
#[tokio::test]
async fn lang_js_follows_the_app_settings() {
    let h = start().await;
    let bare = http(h.public, "GET", "/lang.js", &[], None).await;
    assert_eq!(bare.status, 200, "{}", bare.body);
    assert_eq!(bare.body, "window.ggsLang = \"\";\n");
    std::fs::write(h.daemon.paths.settings(), r#"{ "locale": "zh-cn" }"#).unwrap();
    let zh = http(h.public, "GET", "/lang.js", &[], None).await;
    assert_eq!(zh.status, 200);
    assert_eq!(zh.body, "window.ggsLang = \"zh-cn\";\n");
    std::fs::write(h.daemon.paths.settings(), r#"{ "locale": "en" }"#).unwrap();
    let en = http(h.public, "GET", "/lang.js", &[], None).await;
    assert_eq!(en.body, "window.ggsLang = \"en\";\n");
    // The older spelling answers too, and the loopback pair page sees the same script.
    std::fs::write(
        h.daemon.paths.settings(),
        r#"{ "displayLanguage": "zh-cn" }"#,
    )
    .unwrap();
    let pair = http(h.loopback, "GET", "/lang.js", &[], None).await;
    assert_eq!(pair.status, 200);
    assert_eq!(pair.body, "window.ggsLang = \"zh-cn\";\n");
}

/// The window picker's folder-input row is a setting (2026-10-12): on by default, and the
/// session the picker loads carries the state (the admin patch route itself is covered by
/// config.rs's unit tests — this harness runs on the ephemeral port 0, which any patch
/// would refuse).
#[tokio::test]
async fn session_carries_the_folder_input_switch() {
    let h = start().await;
    set_password(&h).await;
    let (cookie, _csrf) = login(&h).await;
    let session = http(
        h.public,
        "GET",
        "/api/session",
        &[("Cookie", &cookie)],
        None,
    )
    .await;
    assert_eq!(session.status, 200);
    assert!(
        session.body.contains("\"folderInput\":true"),
        "{}",
        session.body
    );
    h.daemon.config.lock().unwrap().folder_input = false;
    let session = http(
        h.public,
        "GET",
        "/api/session",
        &[("Cookie", &cookie)],
        None,
    )
    .await;
    assert!(
        session.body.contains("\"folderInput\":false"),
        "{}",
        session.body
    );
}

/// §7.8's one-time download, end to end: the ticket is minted for the session that asked
/// and the instance it names, the navigation needs no cookie (the ticket is the
/// credential), the file streams from the instance's chunks, and the ticket dies with its
/// first use. An instance's 404 crosses as a 404 — the browser's "file not found".
#[tokio::test]
async fn a_download_ticket_streams_the_file_once() {
    let h = start().await;
    set_password(&h).await;
    let (cookie, _csrf) = login(&h).await;
    let mut instance = FakeInstance::connect(&h, "ggs-38740").await;

    let minted = http(
        h.public,
        "POST",
        "/api/download-ticket",
        &[("Cookie", &cookie), ("Content-Type", "application/json")],
        Some(r#"{"instance":"ggs-38740","path":"C:/repo/笔记.txt","zip":false}"#),
    )
    .await;
    assert_eq!(minted.status, 200, "{}", minted.body);
    let url = serde_json::from_str::<serde_json::Value>(&minted.body).unwrap()["url"]
        .as_str()
        .unwrap()
        .to_owned();
    // The token is random; only the prefix is stable on the LAN (base `/`).
    let (prefix, _token) = url.split_once("t=").unwrap();
    assert_eq!(prefix, "/w/ggs-38740/download?");

    let get = tokio::spawn({
        let port = h.public;
        let url = url.clone();
        async move { http(port, "GET", &url, &[], None).await }
    });
    match instance.recv().await {
        ToInstance::FetchFile { req, path, zip } => {
            assert_eq!(path, "C:/repo/笔记.txt");
            assert!(!zip);
            instance
                .send(&FromInstance::FileReply {
                    req,
                    status: 200,
                    name: "笔记.txt".into(),
                    total: 6,
                    chunk: b"hello\n".to_vec(),
                    done: false,
                })
                .await;
            instance
                .send(&FromInstance::FileReply {
                    req,
                    status: 200,
                    name: "笔记.txt".into(),
                    total: 6,
                    chunk: Vec::new(),
                    done: true,
                })
                .await;
        }
        other => panic!("expected FetchFile, got {other:?}"),
    }
    let file = get.await.unwrap();
    assert_eq!(file.status, 200, "{}", file.body);
    assert_eq!(file.body, "hello\n");
    assert!(file
        .headers
        .contains("content-type: application/octet-stream"));
    // RFC 5987: the ASCII fallback and the UTF-8 `filename*` for the Chinese name.
    assert!(file.headers.contains("filename=\"__.txt\""));
    assert!(
        file.headers
            .contains("filename*=UTF-8''%E7%AC%94%E8%AE%B0.txt"),
        "{}",
        file.headers
    );

    // The ticket is one-time: the same URL again is a plain 404, without asking the
    // instance anything.
    let again = http(h.public, "GET", &url, &[], None).await;
    assert_eq!(again.status, 404);
    assert!(instance.recv_within(200).await.is_none());

    // A refused instance answer crosses as its status: the browser shows the 404 as a
    // failed download ("file not found").
    let minted = http(
        h.public,
        "POST",
        "/api/download-ticket",
        &[("Cookie", &cookie), ("Content-Type", "application/json")],
        Some(r#"{"instance":"ggs-38740","path":"C:/repo/gone.md","zip":false}"#),
    )
    .await;
    assert_eq!(minted.status, 200, "{}", minted.body);
    let url = serde_json::from_str::<serde_json::Value>(&minted.body).unwrap()["url"]
        .as_str()
        .unwrap()
        .to_owned();
    let get = tokio::spawn({
        let port = h.public;
        async move { http(port, "GET", &url, &[], None).await }
    });
    match instance.recv().await {
        ToInstance::FetchFile { req, path, .. } => {
            assert_eq!(path, "C:/repo/gone.md");
            instance
                .send(&FromInstance::FileReply {
                    req,
                    status: 404,
                    name: String::new(),
                    total: 0,
                    chunk: Vec::new(),
                    done: true,
                })
                .await;
        }
        other => panic!("expected FetchFile, got {other:?}"),
    }
    assert_eq!(get.await.unwrap().status, 404);

    // A folder zip answers its headers before the tree is packed (2026-10-13): an empty
    // first chunk opens the download — the browser's bar appears at once, however long
    // the build takes — and the archive's bytes follow once the instance has them.
    let minted = http(
        h.public,
        "POST",
        "/api/download-ticket",
        &[("Cookie", &cookie), ("Content-Type", "application/json")],
        Some(r#"{"instance":"ggs-38740","path":"C:/big/repo","zip":true}"#),
    )
    .await;
    assert_eq!(minted.status, 200, "{}", minted.body);
    let url = serde_json::from_str::<serde_json::Value>(&minted.body).unwrap()["url"]
        .as_str()
        .unwrap()
        .to_owned();
    let get = tokio::spawn({
        let port = h.public;
        async move { http(port, "GET", &url, &[], None).await }
    });
    match instance.recv().await {
        ToInstance::FetchFile { req, path, zip } => {
            assert_eq!(path, "C:/big/repo");
            assert!(zip);
            instance
                .send(&FromInstance::FileReply {
                    req,
                    status: 200,
                    name: "repo.zip".into(),
                    total: 0,
                    chunk: Vec::new(),
                    done: false,
                })
                .await;
            // The pack takes its time — the daemon must hold the stream open, not time
            // the download out.
            tokio::time::sleep(Duration::from_millis(300)).await;
            instance
                .send(&FromInstance::FileReply {
                    req,
                    status: 200,
                    name: "repo.zip".into(),
                    total: 0,
                    chunk: b"PK\x03\x04archive".to_vec(),
                    done: false,
                })
                .await;
            instance
                .send(&FromInstance::FileReply {
                    req,
                    status: 200,
                    name: "repo.zip".into(),
                    total: 0,
                    chunk: Vec::new(),
                    done: true,
                })
                .await;
        }
        other => panic!("expected FetchFile, got {other:?}"),
    }
    let zip = get.await.unwrap();
    assert_eq!(zip.status, 200, "{}", zip.body);
    assert_eq!(zip.body, "PK\x03\x04archive");
    assert!(zip.headers.contains("content-type: application/zip"));
    assert!(zip.headers.contains("filename=\"repo.zip\""));

    // A build that dies after its headers crossed aborts the body: the browser sees an
    // interrupted download, never a truncated archive marked complete.
    let minted = http(
        h.public,
        "POST",
        "/api/download-ticket",
        &[("Cookie", &cookie), ("Content-Type", "application/json")],
        Some(r#"{"instance":"ggs-38740","path":"C:/big/repo","zip":true}"#),
    )
    .await;
    assert_eq!(minted.status, 200, "{}", minted.body);
    let url = serde_json::from_str::<serde_json::Value>(&minted.body).unwrap()["url"]
        .as_str()
        .unwrap()
        .to_owned();
    let get = tokio::spawn({
        let port = h.public;
        async move { http(port, "GET", &url, &[], None).await }
    });
    match instance.recv().await {
        ToInstance::FetchFile { req, .. } => {
            instance
                .send(&FromInstance::FileReply {
                    req,
                    status: 200,
                    name: "repo.zip".into(),
                    total: 0,
                    chunk: Vec::new(),
                    done: false,
                })
                .await;
            // The build dies mid-pack — seconds into it in the real flow, so the headers
            // have long crossed (the browser's download bar is up). Back-to-back chunks
            // would race hyper's own flush instead: the abort can land before the head ever
            // leaves the socket, and the connection dies with zero bytes (seen on Linux).
            tokio::time::sleep(Duration::from_millis(300)).await;
            instance
                .send(&FromInstance::FileReply {
                    req,
                    status: 500,
                    name: String::new(),
                    total: 0,
                    chunk: Vec::new(),
                    done: true,
                })
                .await;
        }
        other => panic!("expected FetchFile, got {other:?}"),
    }
    let aborted = get.await.unwrap();
    assert_eq!(aborted.status, 200);
    assert_eq!(aborted.body, "", "the truncated archive must not land");
}

/// §17.1's pair-unlock row: the QR and the links stay behind the pair page's password
/// unlock — a wrong password is refused and repetition locks the door (the same per-IP
/// limiter as login), the right one unlocks, and anything but a live unlock token is
/// refused.
#[tokio::test]
async fn pair_unlock_guards_the_qr_behind_the_password() {
    let h = start().await;
    set_password(&h).await;

    // A pair ticket from the admin API is what the local pair page rides on.
    let issued = admin(&h, "POST", "/admin/pair-ticket", "{}").await;
    assert_eq!(issued.status, 200, "{}", issued.body);
    let issued: serde_json::Value = serde_json::from_str(&issued.body).unwrap();
    let ticket = issued["ticket"].as_str().unwrap().to_owned();

    // Locked: the state answers but stays closed, and the QR is refused.
    let state = http(
        h.loopback,
        "GET",
        &format!("/pair/state?t={ticket}"),
        &[],
        None,
    )
    .await;
    assert_eq!(state.status, 200);
    assert!(state.body.contains("\"unlocked\":false"), "{}", state.body);
    assert!(!state.body.contains("\"links\""));
    let qr = http(
        h.loopback,
        "GET",
        &format!("/pair/qr?t={ticket}&text=https://lan-link/"),
        &[],
        None,
    )
    .await;
    assert_eq!(qr.status, 403);

    // One wrong password is a plain refusal (the limiter stays clean for the real one).
    let wrong = http(
        h.loopback,
        "POST",
        "/pair/unlock",
        &[("Content-Type", "application/json")],
        Some(&format!(
            "{{\"ticket\":\"{ticket}\",\"password\":\"nope-nope\"}}"
        )),
    )
    .await;
    assert_eq!(wrong.status, 401, "{}", wrong.body);

    // The right password unlocks.
    let ok = http(
        h.loopback,
        "POST",
        "/pair/unlock",
        &[("Content-Type", "application/json")],
        Some(&format!(
            "{{\"ticket\":\"{ticket}\",\"password\":\"{PASSWORD}\"}}"
        )),
    )
    .await;
    assert_eq!(ok.status, 200, "{}", ok.body);
    let unlock = serde_json::from_str::<serde_json::Value>(&ok.body).unwrap()["unlock"]
        .as_str()
        .unwrap()
        .to_owned();

    // Unlocked: the state opens (links appear), and the QR renders as an SVG.
    let open = http(
        h.loopback,
        "GET",
        &format!("/pair/state?t={ticket}&u={unlock}"),
        &[],
        None,
    )
    .await;
    assert_eq!(open.status, 200);
    assert!(open.body.contains("\"unlocked\":true"), "{}", open.body);
    let qr = http(
        h.loopback,
        "GET",
        &format!("/pair/qr?t={ticket}&u={unlock}&text=https://lan-link/"),
        &[],
        None,
    )
    .await;
    assert_eq!(qr.status, 200, "{}", qr.body);
    assert!(qr.body.contains("<svg"), "{}", qr.body);

    // A forged unlock is worth nothing.
    let forged = http(
        h.loopback,
        "GET",
        &format!("/pair/qr?t={ticket}&u=forged&text=https://lan-link/"),
        &[],
        None,
    )
    .await;
    assert_eq!(forged.status, 403);

    // Repetition locks the door (the limiter this IP now carries).
    let mut saw_429 = false;
    for _ in 0..6 {
        let wrong = http(
            h.loopback,
            "POST",
            "/pair/unlock",
            &[("Content-Type", "application/json")],
            Some(&format!(
                "{{\"ticket\":\"{ticket}\",\"password\":\"nope-nope\"}}"
            )),
        )
        .await;
        if wrong.status == 429 {
            saw_429 = true;
            break;
        }
    }
    assert!(saw_429, "repeated wrong unlocks must lock the door");
}

/// The pair page's relay card (2026-10-12): the tray's set-password screen carries the
/// server fields, so a server may be saved before any password exists — it parks in
/// NoPassword, the pair state carries the saved settings for the form to prefill, and the
/// password landing through the same page wakes the parked tunnel.
#[tokio::test]
async fn the_pair_page_sets_the_relay_server_before_the_password() {
    let h = start().await;

    let issued = admin(&h, "POST", "/admin/pair-ticket", "{}").await;
    assert_eq!(issued.status, 200, "{}", issued.body);
    let issued: serde_json::Value = serde_json::from_str(&issued.body).unwrap();
    let ticket = issued["ticket"].as_str().unwrap().to_owned();

    // No server yet: the pair state's hub is unconfigured and carries a null settings.
    let state = http(
        h.loopback,
        "GET",
        &format!("/pair/state?t={ticket}"),
        &[],
        None,
    )
    .await;
    assert_eq!(state.status, 200);
    assert!(
        state.body.contains("\"state\":\"unconfigured\""),
        "{}",
        state.body
    );
    assert!(state.body.contains("\"settings\":null"), "{}", state.body);

    // A forged ticket changes nothing; neither does an unparsable address.
    let denied = http(
        h.loopback,
        "POST",
        "/pair/hub/connect",
        &[("Content-Type", "application/json")],
        Some(r#"{"ticket":"forged","url":"http://127.0.0.1:9"}"#),
    )
    .await;
    assert_eq!(denied.status, 403, "{}", denied.body);
    let bad = http(
        h.loopback,
        "POST",
        "/pair/hub/connect",
        &[("Content-Type", "application/json")],
        Some(&format!(r#"{{"ticket":"{ticket}","url":"not a server"}}"#)),
    )
    .await;
    assert_eq!(bad.status, 400, "{}", bad.body);

    // Saving the server parks it: no password exists, so the tunnel waits in NoPassword.
    let saved = http(
        h.loopback,
        "POST",
        "/pair/hub/connect",
        &[("Content-Type", "application/json")],
        Some(&format!(
            r#"{{"ticket":"{ticket}","url":"http://127.0.0.1:9","joinKey":"lan-secret"}}"#
        )),
    )
    .await;
    assert_eq!(saved.status, 200, "{}", saved.body);
    assert!(
        saved.body.contains("\"state\":\"no-password\""),
        "{}",
        saved.body
    );
    assert_eq!(
        h.daemon.hub.current().map(|s| s.join_key),
        Some("lan-secret".into())
    );

    // The state now carries the settings — the form prefills what it saved.
    let state = http(
        h.loopback,
        "GET",
        &format!("/pair/state?t={ticket}"),
        &[],
        None,
    )
    .await;
    assert!(
        state.body.contains("\"url\":\"http://127.0.0.1:9\""),
        "{}",
        state.body
    );

    // The password landing through the same page wakes the parked tunnel: it leaves
    // NoPassword and dials the (unreachable, deliberately) saved server.
    let set = http(
        h.loopback,
        "POST",
        "/pair/password",
        &[("Content-Type", "application/json")],
        Some(&format!(
            r#"{{"ticket":"{ticket}","password":"{PASSWORD}"}}"#
        )),
    )
    .await;
    assert_eq!(set.status, 200, "{}", set.body);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let state = h.daemon.hub.snapshot();
        if !matches!(
            state,
            ggs_remote::hub::Status::NoPassword | ggs_remote::hub::Status::Unconfigured
        ) {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the password landing must wake the parked tunnel (still {state:?})"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // Disconnect forgets it again, key and all.
    let off = http(
        h.loopback,
        "POST",
        "/pair/hub/disconnect",
        &[("Content-Type", "application/json")],
        Some(&format!(r#"{{"ticket":"{ticket}"}}"#)),
    )
    .await;
    assert_eq!(off.status, 200, "{}", off.body);
    assert!(
        off.body.contains("\"state\":\"unconfigured\""),
        "{}",
        off.body
    );
    assert!(h.daemon.hub.current().is_none());
}

/// §7.8's two-level heartbeat: an instance that stops answering is flagged `unresponsive`
/// in the WINDOWS push, and answering again heals it (§19: the flag is a notice, not a
/// kill; recovery removes it). The flag's recompute runs on the daemon's own cadence — the
/// test drives `refresh_states` with a fabricated overdue beat, which is the same state the
/// real tick computes from two missed pings (the counting itself is unit-tested in
/// `registry::tests`).
#[tokio::test]
async fn an_unanswering_instance_is_flagged_and_heals() {
    let h = start().await;
    set_password(&h).await;
    let (cookie, csrf) = login(&h).await;
    let mut ws = browser(&h, &cookie, &csrf).await;

    let mut instance = FakeInstance::connect(&h, "ggs-stuck").await;
    let _ = next_of(&mut ws, ty::WINDOWS).await; // the registration push
    let _ = &mut instance;

    // Fabricate the state two missed pings leave behind, then recompute.
    {
        let mut instances = h.daemon.registry.instances.lock().unwrap();
        let inst = instances.get_mut("ggs-stuck").unwrap();
        inst.control_beat.misses = ggs_remote::registry::MISSES_TO_FLAG;
        inst.control_beat.sent =
            Some(std::time::Instant::now() - ggs_remote::registry::PONG_DEADLINE * 2);
    }
    ggs_remote::lifecycle::refresh_states(&h.daemon);
    let windows = next_of(&mut ws, ty::WINDOWS).await;
    let windows: serde_json::Value = windows.decode_msgpack().unwrap();
    assert_eq!(windows["instances"][0]["state"], "unresponsive");

    // The beat comes back: the same recompute clears the flag and pushes again.
    {
        let mut instances = h.daemon.registry.instances.lock().unwrap();
        let inst = instances.get_mut("ggs-stuck").unwrap();
        inst.control_beat.misses = 0;
        inst.control_beat.sent = None;
    }
    ggs_remote::lifecycle::refresh_states(&h.daemon);
    let windows = next_of(&mut ws, ty::WINDOWS).await;
    let windows: serde_json::Value = windows.decode_msgpack().unwrap();
    assert_eq!(windows["instances"][0]["state"], "ok");
}

/// §7.8 / R20's close flow: a graceful close with unsaved files is blocked and lists them;
/// `force` kills the registered pid (never the test's own — the fake registers a disposable
/// child) and nothing but the registry's exit path follows.
#[tokio::test]
async fn a_close_with_unsaved_files_blocks_until_forced() {
    let h = start().await;
    set_password(&h).await;
    let (cookie, csrf) = login(&h).await;
    let mut ws = browser(&h, &cookie, &csrf).await;

    // A disposable process to be the instance's pid — force kills THAT, not this test.
    let mut dummy = if cfg!(windows) {
        std::process::Command::new("ping")
            .args(["-n", "120", "127.0.0.1"])
            .spawn()
            .unwrap()
    } else {
        std::process::Command::new("sleep")
            .arg("120")
            .spawn()
            .unwrap()
    };
    let mut instance = FakeInstance::connect_with_pid(&h, "ggs-close", dummy.id()).await;
    let _ = next_of(&mut ws, ty::WINDOWS).await;

    // A remote session is attached (the user closing the window they are using).
    send(
        &mut ws,
        Frame::msgpack(ty::ATTACH, &serde_json::json!({ "instance": "ggs-close" })),
    )
    .await;
    let token = match instance.recv().await {
        ToInstance::EnsureRelay { token } => token,
        other => panic!("expected EnsureRelay, got {other:?}"),
    };
    let relay_ws = relay(&h, &token).await;
    let _ = next_of(&mut ws, ty::ATTACHED).await;

    // Graceful close → Quit → the instance answers with its dirty list → close-blocked.
    send(
        &mut ws,
        Frame::msgpack(
            ty::INSTANCE_CLOSE,
            &serde_json::json!({ "instance": "ggs-close", "force": false }),
        ),
    )
    .await;
    match instance.recv().await {
        ToInstance::Quit {
            force: false,
            idle: false,
        } => {}
        other => panic!("expected a graceful Quit, got {other:?}"),
    }
    instance
        .send(&FromInstance::CloseBlocked {
            dirty: vec!["src/a.rs".into(), "src/b.rs".into()],
        })
        .await;
    let notice = next_of(&mut ws, ty::NOTICE).await;
    let notice: serde_json::Value = notice.decode_msgpack().unwrap();
    assert_eq!(notice["kind"], "close-blocked");
    let dirty: Vec<&str> = notice["dirty"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(dirty, vec!["src/a.rs", "src/b.rs"]);

    // Force: the registered pid dies, the instance is never asked anything, and the
    // registry unwinds when its control socket goes.
    send(
        &mut ws,
        Frame::msgpack(
            ty::INSTANCE_CLOSE,
            &serde_json::json!({ "instance": "ggs-close", "force": true }),
        ),
    )
    .await;
    let mut exited = false;
    for _ in 0..50 {
        if dummy.try_wait().unwrap().is_some() {
            exited = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(exited, "force must kill the registered pid");
    assert!(
        instance.recv_within(1500).await.is_none(),
        "a forced close asks the instance nothing"
    );
    drop(instance); // the control socket closes → Unregister → the browser hears 4410
    drop(relay_ws);
    let close = next_of(&mut ws, ty::CLOSE).await;
    let close: serde_json::Value = close.decode_msgpack().unwrap_or_default();
    assert_eq!(close["code"], 4410);
}

/// §17.1's INSTANCE_RESTART row: terminate, relaunch with the same launch spec and folders,
/// answer the new instance's id once it registers. The relaunched "instance" is this very
/// test binary running its ignored child role below (the launch spec the fake registers
/// names it), so the whole daemon-side orchestration runs for real.
#[tokio::test]
async fn a_restart_kills_relaunches_and_waits_for_the_registration() {
    let h = start().await;
    set_password(&h).await;
    let (cookie, csrf) = login(&h).await;
    let mut ws = browser(&h, &cookie, &csrf).await;

    // A disposable pid to terminate, and a launch spec that relaunches this test binary in
    // its child role (registered as the instance's own spec — restart reuses exactly it).
    let mut dummy = if cfg!(windows) {
        std::process::Command::new("ping")
            .args(["-n", "120", "127.0.0.1"])
            .spawn()
            .unwrap()
    } else {
        std::process::Command::new("sleep")
            .arg("120")
            .spawn()
            .unwrap()
    };
    let child_spec = LaunchSpec {
        program: std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        args_prefix: vec![
            "--exact".into(),
            "restart_child_role".into(),
            "--ignored".into(),
        ],
    };
    let folder = h._dir.path().join("repo").to_string_lossy().into_owned();
    std::fs::create_dir_all(&folder).unwrap();
    let instance =
        FakeInstance::connect_spec(&h, "ggs-restart", dummy.id(), child_spec, vec![folder]).await;
    let _ = next_of(&mut ws, ty::WINDOWS).await;

    // The child derives the daemon's control endpoint from GGS_REMOTE_HOME, which launch()
    // inherits from this process.
    std::env::set_var("GGS_REMOTE_HOME", h._dir.path().join("remote"));

    send(
        &mut ws,
        Frame::msgpack(
            ty::INSTANCE_RESTART,
            &serde_json::json!({ "instance": "ggs-restart" }),
        ),
    )
    .await;
    // The registered pid is terminated...
    let mut exited = false;
    for _ in 0..50 {
        if dummy.try_wait().unwrap().is_some() {
            exited = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(exited, "restart must terminate the registered pid");
    // ...the relaunch registers within the wait, and the browser hears the SPAWNED answer.
    let spawned = next_of(&mut ws, ty::SPAWNED).await;
    let spawned: serde_json::Value = spawned.decode_msgpack().unwrap();
    assert_eq!(spawned["instance"], "ggs-restarted");
    // The registry now lists the new instance (the WINDOWS push carried it).
    let windows = next_of(&mut ws, ty::WINDOWS).await;
    let windows: serde_json::Value = windows.decode_msgpack().unwrap();
    let listed = windows["instances"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(listed.contains(&"ggs-restarted"), "{listed:?}");

    // The killed instance's own connection unwinding takes it off the list.
    std::env::remove_var("GGS_REMOTE_HOME");
    drop(instance);
    let mut gone = false;
    for _ in 0..50 {
        let windows = next_of(&mut ws, ty::WINDOWS).await;
        let windows: serde_json::Value = windows.decode_msgpack().unwrap();
        let listed = windows["instances"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        if !listed.contains(&"ggs-restart") {
            gone = true;
            break;
        }
    }
    assert!(gone, "the replaced instance must leave the registry");
}

/// The restart test's relaunched instance: register on the daemon's control channel and hold
/// it briefly. Only meaningful as a spawned child (GGS_REMOTE_HOME names the daemon's home);
/// a plain `--ignored` run without it simply returns.
#[tokio::test]
#[ignore = "spawned by a_restart_kills_relaunches_and_waits_for_the_registration"]
async fn restart_child_role() {
    if std::env::var_os("GGS_REMOTE_HOME").is_none() {
        return; // a plain --ignored run, not the restart test's child
    }
    let paths = ggs_remote::paths::Paths::resolve().unwrap();
    let endpoint = paths.control_endpoint();
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
    let stream = match interprocess::local_socket::tokio::Stream::connect(name).await {
        Ok(stream) => stream,
        Err(_) => return,
    };
    let (mut rx, mut tx) = stream.split();
    tx.write_all(&control_msg::encode(&FromInstance::Register {
        instance_id: "ggs-restarted".into(),
        pid: std::process::id(),
        version: "0.1.10".into(),
        title: "repo".into(),
        folders: vec![],
        visible: true,
        remote_host: false,
        launch: LaunchSpec::default(),
        sandboxed: false,
        control_token: String::new(),
    }))
    .await
    .unwrap();
    // Hold the registration until the daemon no longer wants it (or a bounded while).
    let _ = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let body = match control_msg::read_message(&mut rx).await {
                Ok(body) => body,
                Err(_) => break,
            };
            match control_msg::decode::<ToInstance>(&body).unwrap() {
                ToInstance::Ping { nonce } => {
                    tx.write_all(&control_msg::encode(&FromInstance::Pong { nonce }))
                        .await
                        .unwrap();
                }
                ToInstance::Quit { .. } => break,
                _ => {}
            }
        }
    })
    .await;
}

/* ---------- The security sandbox (§24) ---------- */

/// The sandbox control endpoint is token-gated: a Register without a valid one-shot
/// token is refused the Welcome, one with it registers (and marks the instance
/// sandboxed — which `windows_frame` then lists while a desktop window is hidden).
#[tokio::test]
async fn the_sandbox_endpoint_registers_only_with_a_one_shot_token() {
    let harness = start().await;
    let daemon = harness.daemon.clone();
    daemon.config.lock().unwrap().sandbox.enabled = true;
    ggs_remote::sandbox::ensure_listener(&daemon);
    tokio::time::sleep(Duration::from_millis(200)).await;

    let endpoint = ggs_remote::sandbox::control_endpoint(&daemon.paths);
    let connect = || async {
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
        Stream::connect(name).await.unwrap()
    };

    // No token: the connection closes without a Welcome.
    {
        let stream = connect().await;
        let (mut rx, mut tx) = stream.split();
        tx.write_all(&control_msg::encode(&FromInstance::Register {
            instance_id: "impostor".into(),
            pid: 4242,
            version: "0.1.10".into(),
            title: "no token".into(),
            folders: vec![],
            visible: true,
            remote_host: false,
            launch: LaunchSpec::default(),
            sandboxed: true,
            control_token: String::new(),
        }))
        .await
        .unwrap();
        let first = control_msg::read_message(&mut rx).await;
        assert!(
            first.is_err(),
            "a tokenless Register is dropped, not welcomed: {first:?}"
        );
    }

    // A desktop window registers over the main endpoint (no token, as ever).
    let desktop = FakeInstance::connect_spec(
        &harness,
        "desktop",
        std::process::id(),
        LaunchSpec {
            program: "ggs".into(),
            args_prefix: vec![],
        },
        vec!["C:/somewhere".into()],
    )
    .await;

    // With the daemon-issued token: the Welcome arrives. The connection stays open —
    // a dropped control connection unregisters the instance, and the WINDOWS check
    // below wants it registered.
    let token = ggs_remote::sandbox::issue_token(&daemon);
    let sbx = connect().await;
    let (mut sbx_rx, mut sbx_tx) = sbx.split();
    {
        sbx_tx
            .write_all(&control_msg::encode(&FromInstance::Register {
                instance_id: "sbx-1".into(),
                pid: std::process::id(),
                version: "0.1.10".into(),
                title: "sandboxed".into(),
                folders: vec!["C:/sb/repo".into()],
                visible: true,
                remote_host: false,
                launch: LaunchSpec::default(),
                sandboxed: true,
                control_token: token.clone(),
            }))
            .await
            .unwrap();
        match control_msg::decode::<ToInstance>(
            &control_msg::read_message(&mut sbx_rx).await.unwrap(),
        )
        .unwrap()
        {
            ToInstance::Welcome { .. } => {}
            other => panic!("expected Welcome, got {other:?}"),
        }
    }
    // The token is one-shot: replaying it on a fresh connection is refused.
    {
        let stream = connect().await;
        let (mut rx, mut tx) = stream.split();
        tx.write_all(&control_msg::encode(&FromInstance::Register {
            instance_id: "replay".into(),
            pid: std::process::id(),
            version: "0.1.10".into(),
            title: "replayed token".into(),
            folders: vec![],
            visible: true,
            remote_host: false,
            launch: LaunchSpec::default(),
            sandboxed: true,
            control_token: token,
        }))
        .await
        .unwrap();
        assert!(
            control_msg::read_message(&mut rx).await.is_err(),
            "a consumed token buys no second registration"
        );
    }

    // With the sandbox on, WINDOWS lists the sandboxed instance only.
    let frame = ggs_remote::ws::socket::windows_frame(&daemon);
    let windows: ggs_remote::ws::msg::Windows = frame.decode_msgpack().unwrap();
    let ids: Vec<&str> = windows.instances.iter().map(|i| i.id.as_str()).collect();
    assert!(
        ids.contains(&"sbx-1"),
        "the sandboxed instance is listed: {ids:?}"
    );
    assert!(
        !ids.contains(&"desktop"),
        "the desktop window is hidden: {ids:?}"
    );
    for info in &windows.instances {
        assert!(info.sandboxed, "everything listed carries the sandbox flag");
    }
    let _ = (desktop, sbx_rx, sbx_tx);
}

/// The sandbox boundary covers close and restart too (audit F1, 2026-10-13): a remote
/// session must not force-kill or relaunch a desktop window just because ATTACH alone is
/// guarded. Both answer as though the window were gone, and the registration survives.
#[tokio::test]
async fn the_sandbox_hides_desktop_windows_from_close_and_restart_too() {
    let harness = start().await;
    let daemon = harness.daemon.clone();
    daemon.config.lock().unwrap().sandbox.enabled = true;
    set_password(&harness).await;

    let mut desktop = FakeInstance::connect_spec(
        &harness,
        "desktop",
        std::process::id(),
        LaunchSpec {
            program: "ggs".into(),
            args_prefix: vec![],
        },
        vec!["C:/somewhere".into()],
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let (cookie, csrf) = login(&harness).await;
    let mut ws = browser(&harness, &cookie, &csrf).await;
    let _ = next_of(&mut ws, ty::WINDOWS).await;
    send(
        &mut ws,
        Frame::msgpack(
            ty::INSTANCE_CLOSE,
            &ggs_remote::ws::msg::InstanceClose {
                instance: "desktop".into(),
                force: true,
            },
        ),
    )
    .await;
    send(
        &mut ws,
        Frame::msgpack(
            ty::INSTANCE_RESTART,
            &ggs_remote::ws::msg::InstanceRestart {
                instance: "desktop".into(),
            },
        ),
    )
    .await;

    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        daemon.registry.exists("desktop"),
        "the guarded close/restart never reached the desktop window"
    );
    // And the instance still answers — the force-kill never happened: its control
    // connection delivers the daemon's next message within a bounded wait.
    daemon
        .registry
        .send("desktop", ToInstance::Ping { nonce: 7 });
    let delivered = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let body = control_msg::read_message(&mut desktop.rx).await.unwrap();
            if let ToInstance::Ping { nonce: 7 } = control_msg::decode(&body).unwrap() {
                break;
            }
        }
    })
    .await;
    assert!(delivered.is_ok(), "the desktop window still answers pings");
}

/// The real sandbox runtime, end to end, on this machine (ignored in CI: it needs the
/// host's sandbox — Windows 11 24H2+/AppContainer, bubblewrap, or Seatbelt — and
/// exercises `sandbox::launch`'s whole path). Run locally with
/// `cargo test --test integration sandbox_launches -- --ignored`.
#[tokio::test]
#[ignore]
async fn sandbox_launch_runs_a_command_under_the_real_runtime() {
    let harness = start().await;
    let daemon = harness.daemon.clone();
    let mut config = daemon.config.lock().unwrap();
    config.sandbox.enabled = true;
    config.sandbox.network = ggs_remote::config::SandboxNetwork::Off;
    let plan = ggs_remote::sandbox::plan(&config, &daemon.paths);
    drop(config);
    ggs_remote::sandbox::ensure_listener(&daemon);
    // A stand-in "GGS": a program that exits at once. The launch must be accepted by
    // the runtime, and the sandbox root must come into being.
    let spec = LaunchSpec {
        program: if cfg!(windows) {
            r"c:\Windows\System32\cmd.exe".into()
        } else {
            "/bin/true".into()
        },
        args_prefix: if cfg!(windows) {
            vec!["/C".into(), "exit".into(), "0".into()]
        } else {
            vec![]
        },
    };
    ggs_remote::sandbox::launch(&daemon, &plan, &spec, None, false)
        .expect("the sandbox runtime accepts the launch");
    assert!(plan.root.join("home").is_dir(), "the relocated home exists");
    assert!(plan.root.join("workspace").is_dir());
}
