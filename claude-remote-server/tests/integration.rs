//! End-to-end relay tests over real sockets: the same `App` the binary serves, bound to a
//! loopback port, driven by a hand-rolled HTTP client and tokio-tungstenite — a simulated
//! PC window and a simulated phone walking the full pairing → subscription → frame path.

use claude_remote_server::api::App;
use claude_remote_server::config::{Config, Registration};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

fn test_config() -> Config {
    Config {
        data_dir: None,
        registration: Registration::Open,
        max_windows: 4,
        max_devices: 4,
        queue_frames: 256,
        ..Config::default()
    }
}

async fn start(config: Config) -> (App, String, watch::Sender<bool>) {
    let (stop_tx, stop_rx) = watch::channel(false);
    let app = App::new(config);
    let addr = app.clone().serve("127.0.0.1:0".parse().unwrap(), stop_rx).await.unwrap();
    (app, format!("http://{addr}"), stop_tx)
}

/* ---------- a minimal HTTP/1.1 client (no extra dependencies) ---------- */


/// [`http`] before the tuple grew its header half.
async fn http(method: &str, url: &str, headers: &[(&str, &str)], body: &str) -> (u16, String) {
    let (status, body, _) = http_with_headers(method, url, headers, body).await;
    (status, body)
}

async fn http_with_headers(method: &str, url: &str, headers: &[(&str, &str)], body: &str) -> (u16, String, String) {
    let url = url.strip_prefix("http://").unwrap_or(url);
    let (host, path) = url.split_once('/').unwrap();
    let mut request = format!("{method} /{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    if !body.is_empty() {
        request.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len()));
    }
    request.push_str("\r\n");
    request.push_str(body);
    let mut stream = TcpStream::connect(host).await.expect("connect");
    stream.write_all(request.as_bytes()).await.expect("write");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.expect("read");
    let text = String::from_utf8_lossy(&raw).to_string();
    let status: u16 = text.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let head = text.split("

").next().unwrap_or("").to_lowercase();
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    (status, body, head)
}

/* ---------- the simulated PC and phone ---------- */

struct Pc {
    user_id: String,
    agent_secret: String,
    auth_hex: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn register_pc(base: &str) -> Pc {
    let auth_bytes: [u8; 32] = std::array::from_fn(|i| i as u8 + 7);
    let auth_hex = hex(&auth_bytes);
    let (status, body) =
        http("POST", &format!("{base}/api/v1/register"), &[], &format!(r#"{{"auth":"{auth_hex}"}}"#)).await;
    assert_eq!(status, 201, "{body}");
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    Pc {
        user_id: parsed["user_id"].as_str().unwrap().to_string(),
        agent_secret: parsed["agent_secret"].as_str().unwrap().to_string(),
        auth_hex,
    }
}

async fn pair_phone(base: &str, pc: &Pc, password: Option<&str>, name: &str) -> (String, String) {
    let (status, body) =
        http("POST", &format!("{base}/api/v1/pair/challenge"), &[], &format!(r#"{{"user_id":"{}"}}"#, pc.user_id)).await;
    assert_eq!(status, 200, "{body}");
    let challenge: serde_json::Value = serde_json::from_str(&body).unwrap();
    let nonce = challenge["nonce"].as_str().unwrap();
    let epoch = challenge["epoch"].as_u64().unwrap();
    let mut mac = Hmac::<Sha256>::new_from_slice(&unhex(&pc.auth_hex)).unwrap();
    mac.update(format!("crr1/pair|{nonce}|{}|{epoch}", pc.user_id).as_bytes());
    let proof = hex(&mac.finalize().into_bytes());
    let password = password.map(|p| format!(r#","password":"{p}""#)).unwrap_or_default();
    let request = format!(
        r#"{{"user_id":"{}","nonce":"{nonce}","epoch":{epoch},"proof":"{proof}","device_name":"{name}"{password}}}"#,
        pc.user_id
    );
    let (status, body) = http("POST", &format!("{base}/api/v1/pair"), &[], &request).await;
    assert_eq!(status, 201, "{status} {body}");
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    (parsed["device_id"].as_str().unwrap().to_string(), parsed["device_token"].as_str().unwrap().to_string())
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).unwrap())
        .collect()
}

const WINDOW: &str = "w_0123456789abcdef";

async fn agent_ws(base: &str, pc: &Pc, window: &str) -> WebSocketStream<MaybeTlsStream<TcpStream>> {
    let url = format!("{}/ws/agent?window={window}", base.replace("http", "ws"));
    let mut request = url.into_client_request().unwrap();
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", pc.agent_secret).parse().unwrap(),
    );
    let (stream, _) = connect_async(request).await.expect("the agent websocket");
    stream
}

async fn phone_ws(base: &str, token: &str) -> WebSocketStream<MaybeTlsStream<TcpStream>> {
    let url = format!("{}/ws/device", base.replace("http", "ws"));
    let mut request: Request<()> = url.into_client_request().unwrap();
    request.headers_mut().insert("Authorization", format!("Bearer {token}").parse().unwrap());
    let (stream, _) = connect_async(request).await.expect("the phone websocket");
    stream
}

/// Read messages until one matches `want` (applied to the JSON), or fail.
async fn expect_json<S>(socket: &mut WebSocketStream<MaybeTlsStream<TcpStream>>, want: S)
where
    S: Fn(&serde_json::Value) -> bool,
{
    for _ in 0..50 {
        let message = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
            .await
            .expect("a message in time")
            .expect("the socket is open")
            .expect("a good message");
        match message {
            Message::Text(text) => {
                let value: serde_json::Value = serde_json::from_str(text.as_str()).unwrap();
                if want(&value) {
                    return;
                }
            }
            Message::Close(frame) => panic!("closed while waiting: {frame:?}"),
            _ => {}
        }
    }
    panic!("the expected message never arrived");
}

async fn next_close(socket: &mut WebSocketStream<MaybeTlsStream<TcpStream>>) -> Option<u16> {
    loop {
        let message = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
            .await
            .expect("a close in time")
            .expect("the socket is open")
            .expect("a good message");
        if let Message::Close(frame) = message {
            return frame.map(|f| f.code.into());
        }
    }
}

fn frame(from: &str, to: &str, seq: u64, ct: &str) -> String {
    serde_json::json!({ "v": 1, "kind": "frame", "from": from, "to": to, "seq": seq, "ct": ct }).to_string()
}

/* ---------- the flows ---------- */

#[tokio::test]
async fn pairing_then_frames_both_ways_over_websockets() {
    let (_app, base, _stop) = start(test_config()).await;
    let pc = register_pc(&base).await;
    let (device_id, device_token) = pair_phone(&base, &pc, None, "Pixel").await;

    let mut agent = agent_ws(&base, &pc, WINDOW).await;
    expect_json(&mut agent, |v| v["kind"] == "hello" && v["you"] == WINDOW).await;

    // The window publishes its sealed metadata; the phone's landing view carries it.
    agent
        .send(Message::text(
            r#"{"v":1,"kind":"window.meta","ct":"bWV0YQ","host":"ggs"}"#.to_string(),
        ))
        .await
        .unwrap();

    let mut phone = phone_ws(&base, &device_token).await;
    expect_json(&mut phone, |v| v["kind"] == "hello" && v["you"] == device_id.as_str()).await;
    expect_json(&mut phone, |v| v["kind"] == "windows" && v["list"][0]["meta_ct"] == "bWV0YQ").await;

    // Phone → window: a frame banks into the ring and reaches the agent socket.
    phone
        .send(Message::text(frame(&device_id, WINDOW, 1, "cGhvbmUtZnJhbWU"))).await
        .unwrap();
    expect_json(&mut agent, |v| v["kind"] == "frame" && v["ct"] == "cGhvbmUtZnJhbWU").await;

    // Window → phone: a frame routes live.
    agent
        .send(Message::text(frame(WINDOW, &device_id, 1, "YWdlbnQtZnJhbWU"))).await
        .unwrap();
    expect_json(&mut phone, |v| v["kind"] == "frame" && v["ct"] == "YWdlbnQtZnJhbWU").await;

    // Window → every member (broadcast) skips the sender, reaches the phone.
    agent.send(Message::text(frame(WINDOW, "*", 2, "YnJvYWRjYXN0"))).await.unwrap();
    expect_json(&mut phone, |v| v["kind"] == "frame" && v["to"] == "*").await;
}

#[tokio::test]
async fn the_long_poll_transport_matches_the_websocket_one() {
    let (_app, base, _stop) = start(test_config()).await;
    let pc = register_pc(&base).await;
    let (device_id, device_token) = pair_phone(&base, &pc, None, "Pixel").await;
    let auth = format!("Bearer {}", pc.agent_secret);

    // A phone listens over WS; one window speaks over WS, the other over long-poll: the
    // same ring, the same cursors, either transport on either side.
    let mut phone = phone_ws(&base, &device_token).await;
    expect_json(&mut phone, |v| v["kind"] == "hello").await;
    let mut window_ws = agent_ws(&base, &pc, "w_0000000000000010").await;
    expect_json(&mut window_ws, |v| v["kind"] == "hello").await;

    // The polling window's own frames go out through POST /agent/send…
    let (status, body) = http(
        "POST",
        &format!("{base}/api/v1/agent/send"),
        &[("Authorization", &auth)],
        &format!(
            r#"{{"window":"{WINDOW}","frames":[{}]}}"#,
            frame(WINDOW, &device_id, 1, "cG9sbC1mcmFtZQ")
        ),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    expect_json(&mut phone, |v| v["kind"] == "frame" && v["ct"] == "cG9sbC1mcmFtZQ").await;

    // …and a WS window's broadcast banks into the polling window's ring. The polling
    // window attaches with a first empty poll (its ring exists from then on).
    let (status, body) = http(
        "GET",
        &format!("{base}/api/v1/agent/poll?window={WINDOW}&wait=0"),
        &[("Authorization", &auth)],
        "",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    window_ws
        .send(Message::text(frame("w_0000000000000010", "*", 3, "YnJvYWRjYXN0"))).await
        .unwrap();
    // Reading from the ring's start (cursor=0) replays what banked; a poll with no
    // cursor is a fresh consumer that only sees arrivals from now on.
    let (status, body) = http(
        "GET",
        &format!("{base}/api/v1/agent/poll?window={WINDOW}&cursor=0&wait=0"),
        &[("Authorization", &auth)],
        "",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let poll: serde_json::Value = serde_json::from_str(&body).unwrap();
    let frames = poll["frames"].as_array().unwrap();
    assert!(frames.iter().any(|f| f["ct"] == "YnJvYWRjYXN0"), "{poll}");
    let cursor = poll["cursor"].as_u64().unwrap();

    // A poll at that cursor finds nothing new; a frame parked for `wait` seconds wakes it.
    let base_clone = base.clone();
    let secret = pc.agent_secret.clone();
    let parked = tokio::spawn(async move {
        let (status, body) = http(
            "GET",
            &format!("{base_clone}/api/v1/agent/poll?window={WINDOW}&cursor={cursor}&wait=8"),
            &[("Authorization", &format!("Bearer {secret}"))],
            "",
        )
        .await;
        assert_eq!(status, 200, "{body}");
        serde_json::from_str::<serde_json::Value>(&body).unwrap()
    });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    window_ws
        .send(Message::text(frame("w_0000000000000010", WINDOW, 4, "d2FrZQ"))).await
        .unwrap();
    let woken = tokio::time::timeout(std::time::Duration::from_secs(6), parked).await.unwrap().unwrap();
    assert_eq!(woken["frames"].as_array().unwrap().len(), 1);
    assert_eq!(woken["frames"][0]["ct"], "d2FrZQ");
}

#[tokio::test]
async fn a_rekey_kicks_phones_and_moves_the_epoch_under_the_windows() {
    let (_app, base, _stop) = start(test_config()).await;
    let pc = register_pc(&base).await;
    let (device_id, device_token) = pair_phone(&base, &pc, None, "Pixel").await;

    let mut agent = agent_ws(&base, &pc, WINDOW).await;
    expect_json(&mut agent, |v| v["kind"] == "hello").await;
    let mut phone = phone_ws(&base, &device_token).await;
    expect_json(&mut phone, |v| v["kind"] == "hello").await;

    let auth = format!("Bearer {}", pc.agent_secret);
    let new_auth = hex(&[9u8; 32]);
    let (status, body) = http(
        "PUT",
        &format!("{base}/api/v1/me/pairing"),
        &[("Authorization", &auth)],
        &format!(r#"{{"auth":"{new_auth}","expect_epoch":1}}"#),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(serde_json::from_str::<serde_json::Value>(&body).unwrap()["epoch"], 2);

    // The phone is told `rekeyed` and closed; the window is told the epoch moved.
    expect_json(&mut phone, |v| v["kind"] == "kick" && v["reason"] == "rekeyed").await;
    let closed = next_close(&mut phone).await;
    assert_eq!(closed, Some(4401));
    expect_json(&mut agent, |v| v["kind"] == "epoch_changed" && v["epoch"] == 2).await;

    // The old device token is dead; the old QR's auth no longer proves anything.
    let (status, body) = http(
        "POST",
        &format!("{base}/api/v1/login"),
        &[],
        &format!(r#"{{"device_token":"{device_token}"}}"#),
    )
    .await;
    assert_eq!(status, 401, "{body}");
    let (status, body) = http(
        "POST",
        &format!("{base}/api/v1/pair/challenge"),
        &[],
        &format!(r#"{{"user_id":"{}"}}"#, pc.user_id),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let nonce = serde_json::from_str::<serde_json::Value>(&body).unwrap()["nonce"].as_str().unwrap().to_string();
    // A proof under the OLD key fails:
    let mut mac = Hmac::<Sha256>::new_from_slice(&unhex(&pc.auth_hex)).unwrap();
    mac.update(format!("crr1/pair|{nonce}|{}|2", pc.user_id).as_bytes());
    let stale_proof = hex(&mac.finalize().into_bytes());
    let (status, body) = http(
        "POST",
        &format!("{base}/api/v1/pair"),
        &[],
        &format!(r#"{{"user_id":"{}","nonce":"{nonce}","epoch":2,"proof":"{stale_proof}"}}"#, pc.user_id),
    )
    .await;
    assert_eq!(status, 401, "{body}");
    let _ = device_id;
}

#[tokio::test]
async fn one_pcs_frames_never_reach_another_pc() {
    let (_app, base, _stop) = start(test_config()).await;
    let a = register_pc(&base).await;
    let b = register_pc(&base).await;
    let (_, a_token) = pair_phone(&base, &a, None, "A phone").await;

    // B's window comes online; A's phone tries to address it by the same id shape.
    let mut agent_b = agent_ws(&base, &b, WINDOW).await;
    expect_json(&mut agent_b, |v| v["kind"] == "hello").await;
    let mut phone_a = phone_ws(&base, &a_token).await;
    expect_json(&mut phone_a, |v| v["kind"] == "hello").await;
    phone_a
        .send(Message::text(frame("d_000000000000001", WINDOW, 1, "Y3Jvc3M")))
        .await
        .unwrap();
    let closed = next_close(&mut phone_a).await;
    assert_eq!(closed, Some(4400)); // cross-user addressing closes the connection
}

#[tokio::test]
async fn the_login_password_gates_pairing_and_device_login() {
    let (_app, base, _stop) = start(test_config()).await;
    let pc = register_pc(&base).await;
    let auth = format!("Bearer {}", pc.agent_secret);

    let (status, body) = http(
        "PUT",
        &format!("{base}/api/v1/me/password"),
        &[("Authorization", &auth)],
        r#"{"password":"hunter22!"}"#,
    )
    .await;
    assert_eq!(status, 200, "{body}");

    let (status, body) = http(
        "POST",
        &format!("{base}/api/v1/pair/challenge"),
        &[],
        &format!(r#"{{"user_id":"{}"}}"#, pc.user_id),
    )
    .await;
    let challenge: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(status, 200);
    assert_eq!(challenge["password_required"], true);

    let nonce = challenge["nonce"].as_str().unwrap();
    let epoch = challenge["epoch"].as_u64().unwrap();
    let mut mac = Hmac::<Sha256>::new_from_slice(&unhex(&pc.auth_hex)).unwrap();
    mac.update(format!("crr1/pair|{nonce}|{}|{epoch}", pc.user_id).as_bytes());
    let proof = hex(&mac.finalize().into_bytes());
    for wrong in ["", "hunter21!"] {
        let (status, body) = http(
            "POST",
            &format!("{base}/api/v1/pair"),
            &[],
            &format!(
                r#"{{"user_id":"{}","nonce":"{nonce}","epoch":{epoch},"proof":"{proof}","password":"{wrong}"}}"#,
                pc.user_id
            ),
        )
        .await;
        assert_eq!(status, 401, "{body}");
    }
    // A nonce is single-use: the challenge must be taken again for the real attempt.
    let (device_id, device_token, _nonce) = pair_phone_password(&base, &pc, "hunter22!").await;

    let (status, body) = http(
        "POST",
        &format!("{base}/api/v1/login"),
        &[],
        &format!(r#"{{"device_token":"{device_token}","password":"wrong"}}"#),
    )
    .await;
    assert_eq!(status, 401, "{body}");
    let (status, body) = http(
        "POST",
        &format!("{base}/api/v1/login"),
        &[],
        &format!(r#"{{"device_token":"{device_token}","password":"hunter22!"}}"#),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let _ = device_id;
}

async fn pair_phone_password(base: &str, pc: &Pc, password: &str) -> (String, String, String) {
    let (_, body) = http("POST", &format!("{base}/api/v1/pair/challenge"), &[], &format!(r#"{{"user_id":"{}"}}"#, pc.user_id)).await;
    let challenge: serde_json::Value = serde_json::from_str(&body).unwrap();
    let nonce = challenge["nonce"].as_str().unwrap();
    let epoch = challenge["epoch"].as_u64().unwrap();
    let mut mac = Hmac::<Sha256>::new_from_slice(&unhex(&pc.auth_hex)).unwrap();
    mac.update(format!("crr1/pair|{nonce}|{}|{epoch}", pc.user_id).as_bytes());
    let proof = hex(&mac.finalize().into_bytes());
    let (status, body) = http(
        "POST",
        &format!("{base}/api/v1/pair"),
        &[],
        &format!(
            r#"{{"user_id":"{}","nonce":"{nonce}","epoch":{epoch},"proof":"{proof}","password":"{password}","device_name":"pw"}}"#,
            pc.user_id
        ),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    (
        parsed["device_id"].as_str().unwrap().to_string(),
        parsed["device_token"].as_str().unwrap().to_string(),
        nonce.to_string(),
    )
}

#[tokio::test]
async fn registration_modes_hold() {
    // Token mode: no token configured is a startup error; wrong tokens are refused.
    let mut config = test_config();
    config.registration = Registration::Token;
    assert!(config.validate().is_err());
    config.invite = Some("s3cret".to_string());
    let (_app, base, _stop) = start(config).await;
    // The token gate answers before any body shape is revealed:
    let (status, _) = http("POST", &format!("{base}/api/v1/register"), &[], r#"{"auth":"0011"}"#).await;
    assert_eq!(status, 401);
    let (status, _) = http(
        "POST",
        &format!("{base}/api/v1/register"),
        &[],
        r#"{"auth":"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"}"#,
    )
    .await;
    assert_eq!(status, 401);
    // The right token with a malformed auth is a 400:
    let (status, _) = http("POST", &format!("{base}/api/v1/register"), &[], r#"{"token":"s3cret","auth":"0011"}"#).await;
    assert_eq!(status, 400);
    let (status, body) = http(
        "POST",
        &format!("{base}/api/v1/register"),
        &[],
        r#"{"token":"s3cret","auth":"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"}"#,
    )
    .await;
    assert_eq!(status, 201, "{body}");

    let mut config = test_config();
    config.registration = Registration::Closed;
    let (_app, base, _stop) = start(config).await;
    let (status, body) = http(
        "POST",
        &format!("{base}/api/v1/register"),
        &[],
        r#"{"auth":"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"}"#,
    )
    .await;
    assert_eq!(status, 403, "{body}");
}

#[tokio::test]
async fn a_flooding_phone_is_disconnected_and_a_revoked_device_is_gone() {
    let mut config = test_config();
    config.queue_frames = 8;
    let (_app, base, _stop) = start(config).await;
    let pc = register_pc(&base).await;
    let (device_id, device_token) = pair_phone(&base, &pc, None, "Pixel").await;
    let auth = format!("Bearer {}", pc.agent_secret);

    let mut agent = agent_ws(&base, &pc, WINDOW).await;
    expect_json(&mut agent, |v| v["kind"] == "hello").await;
    let mut phone = phone_ws(&base, &device_token).await;
    expect_json(&mut phone, |v| v["kind"] == "hello").await;

    // The phone never reads while the window floods it: the bounded queue overflows and
    // the relay closes the phone's connection (the plan's memory bound).
    for seq in 1..=40u64 {
        agent
            .send(Message::text(frame(WINDOW, &device_id, seq, "ZGVhZGJlZWY")))
            .await
            .unwrap();
    }
    let closed = next_close(&mut phone).await;
    assert_eq!(closed, Some(4413));

    // The PC lists its devices and revokes the pairing.
    let (status, body) = http("GET", &format!("{base}/api/v1/me/devices"), &[("Authorization", &auth)], "").await;
    assert_eq!(status, 200, "{body}");
    let devices: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(devices["devices"].as_array().unwrap().len(), 1);
    let (status, body) = http(
        "DELETE",
        &format!("{base}/api/v1/me/devices/{device_id}"),
        &[("Authorization", &auth)],
        "",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = http(
        "POST",
        &format!("{base}/api/v1/login"),
        &[],
        &format!(r#"{{"device_token":"{device_token}"}}"#),
    )
    .await;
    assert_eq!(status, 401, "{body}");
}

#[tokio::test]
async fn the_phone_page_and_healthz_serve() {
    let (_app, base, _stop) = start(test_config()).await;
    let pc = register_pc(&base).await;
    let (status, body) = http("GET", &format!("{base}/c/{}", pc.user_id), &[], "").await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("<!doctype html>") || body.contains("<html"), "{body}");
    let (status, _) = http("GET", &format!("{base}/c/not-a-user"), &[], "").await;
    assert_eq!(status, 404);
    let (status, body) = http("GET", &format!("{base}/healthz"), &[], "").await;
    assert_eq!(status, 200, "{body}");
    let health: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(health["users"], 1);
}

#[tokio::test]
async fn the_real_binary_serves_healthz() {
    let exe = env!("CARGO_BIN_EXE_claude-remote-server");
    // Find a free port, then hand it to the binary (it has no port-0 report on stdout
    // beyond the resolved address line, which we parse).
    let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);
    let mut child = std::process::Command::new(exe)
        .args(["serve", "--memory", "--registration", "open", "--listen", &format!("127.0.0.1:{port}")])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("the relay binary starts");
    // Wait for the startup line.
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.contains("listening on") {
                let _ = tx.send(line);
                return;
            }
        }
    });
    let line = tokio::time::timeout(std::time::Duration::from_secs(15), rx).await.expect("a startup line").unwrap();
    assert!(line.contains("127.0.0.1"), "{line}");
    let base = format!("http://127.0.0.1:{port}");
    let (status, body) = http("GET", &format!("{base}/healthz"), &[], "").await;
    assert_eq!(status, 200, "{body}");
    let _ = child.kill();
    let _ = child.wait();
}

#[tokio::test]
async fn the_pc_side_reads_its_windows_and_the_password_flag() {
    let (_app, base, _stop) = start(test_config()).await;
    let pc = register_pc(&base).await;
    let auth = format!("Bearer {}", pc.agent_secret);

    // Two windows online with sealed metadata, one phone paired.
    let mut window_a = agent_ws(&base, &pc, "w_0123456789abcdef").await;
    expect_json(&mut window_a, |v| v["kind"] == "hello").await;
    window_a
        .send(Message::text(
            r#"{"v":1,"kind":"window.meta","ct":"d2luZG93LWE","host":"ggs"}"#.to_string(),
        ))
        .await
        .unwrap();
    let mut window_b = agent_ws(&base, &pc, "w_ffffffffffffffff").await;
    expect_json(&mut window_b, |v| v["kind"] == "hello").await;

    let (status, body) = http("GET", &format!("{base}/api/v1/me/windows"), &[("Authorization", &auth)], "").await;
    assert_eq!(status, 200, "{body}");
    let answer: serde_json::Value = serde_json::from_str(&body).unwrap();
    let windows = answer["windows"].as_array().unwrap();
    assert_eq!(windows.len(), 2, "{answer}");
    assert!(windows.iter().any(|w| w["meta_ct"] == serde_json::json!("d2luZG93LWE")), "{answer}");
    assert!(windows.iter().all(|w| w["online"] == serde_json::json!(true)), "{answer}");

    // The password flag rides the devices read.
    let (status, body) = http("GET", &format!("{base}/api/v1/me/devices"), &[("Authorization", &auth)], "").await;
    assert_eq!(status, 200, "{body}");
    let devices: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(devices["password_set"], serde_json::json!(false));
    let (status, body) = http(
        "PUT",
        &format!("{base}/api/v1/me/password"),
        &[("Authorization", &auth)],
        r#"{"password":"hunter22!"}"#,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let (_, body) = http("GET", &format!("{base}/api/v1/me/devices"), &[("Authorization", &auth)], "").await;
    let devices: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(devices["password_set"], serde_json::json!(true));
}

#[tokio::test]
async fn a_stale_device_token_stops_at_the_verify_probe_and_the_lockout_names_its_wait() {
    let (_app, base, _stop) = start(test_config()).await;
    let pc = register_pc(&base).await;
    let (_, live_token) = pair_phone(&base, &pc, None, "Pixel").await;

    // The verify probe: a live token answers its identity; the liveness gate the phone
    // checks before its WebSocket (the browser never shows a handshake failure's status,
    // so a dead token otherwise reconnect-loops into the lockout).
    let (status, body) = http(
        "POST",
        &format!("{base}/api/v1/device/verify"),
        &[],
        &format!(r#"{{"device_token":"{live_token}"}}"#),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let answer: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(answer["user_id"], serde_json::json!(pc.user_id));
    assert_eq!(answer["epoch"], serde_json::json!(1));

    // Ten unknown-token probes from one address lock it; the eleventh answers 429 with
    // the remaining window as Retry-After — a client that honors it stops hammering.
    let att = "9.9.9.9";
    for _ in 0..10 {
        let (status, _) = http(
            "POST",
            &format!("{base}/api/v1/device/verify"),
            &[("X-Forwarded-For", att)],
            r#"{"device_token":"deadbeef"}"#,
        )
        .await;
        assert_eq!(status, 401);
    }
    let (status, body, headers) = http_with_headers(
        "POST",
        &format!("{base}/api/v1/device/verify"),
        &[("X-Forwarded-For", att)],
        r#"{"device_token":"deadbeef"}"#,
    )
    .await;
    assert_eq!(status, 429, "{body}");
    assert!(headers.contains("retry-after"), "the lockout names its wait: {headers}");
    // Another address is untouched — the lockout is per-client, never the relay's.
    let (status, _) = http(
        "POST",
        &format!("{base}/api/v1/device/verify"),
        &[("X-Forwarded-For", "10.0.0.7")],
        &format!(r#"{{"device_token":"{live_token}"}}"#),
    )
    .await;
    assert_eq!(status, 200);
}
