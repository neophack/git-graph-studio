//! The relay's HTTP and WebSocket surface (plan §3.4). Everything a phone or window sends
//! beyond the pairing handshake is an opaque encrypted frame; these handlers only check
//! membership, shape and rate.

use crate::config::{Config, Registration};
use crate::guard::{Guard, Kind};
use crate::hub::{self, Frame, Hub, Limits, RateCounter};
use crate::store::{self, hex, now_ms, Store, StoreError, User};
use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket};
use axum::extract::{DefaultBodyLimit, Path, Query, State, WebSocketUpgrade};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch};

#[derive(Clone)]
pub struct App {
    store: Arc<Store>,
    hub: Arc<Hub>,
    guard: Arc<Guard>,
    config: Arc<Config>,
    pairings: Arc<Mutex<HashMap<String, PendingNonce>>>,
}

struct PendingNonce {
    user: String,
    epoch: u64,
    expires: u64,
}

// Single-use and per-user; generous because the phone may sit on the password card
// for a while between taking the challenge and posting the pair (a nonce is 128 random
// bits — a long life costs nothing).
const NONCE_TTL_MS: u64 = 300_000;
const MAX_PENDING_NONCES: usize = 10_000;
const MAX_PAIR_BODY: usize = 16 * 1024;
const MAX_SEND_FRAMES: usize = 64;
const MAX_NAME: usize = 60;
/// The longest a long-poll may park before answering (a proxy's 60 s timeout is close).
const MAX_POLL_WAIT: Duration = Duration::from_secs(50);

impl App {
    pub fn new(config: Config) -> App {
        let store = Store::open(config.data_dir.as_deref()).expect("the data directory opens");
        App {
            store: Arc::new(store),
            hub: Arc::new(Hub::new(Limits {
                max_windows: config.max_windows,
                queue_frames: config.queue_frames,
                queue_bytes: config.queue_bytes,
            })),
            guard: Arc::new(Guard::default()),
            config: Arc::new(config),
            pairings: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn router(&self) -> Router {
        Router::new()
            .route("/healthz", get(healthz))
            .route("/api/v1/register", get(forbidden).post(register))
            .route("/api/v1/pair/challenge", get(forbidden).post(pair_challenge))
            .route("/api/v1/pair", get(forbidden).post(pair))
            .route("/api/v1/login", get(forbidden).post(login))
            .route("/api/v1/device/verify", get(forbidden).post(device_verify))
            .route("/api/v1/me/devices", get(me_devices))
            .route("/api/v1/me/windows", get(me_windows))
            .route("/api/v1/me/devices/{id}", get(forbidden).delete(me_device_delete))
            .route("/api/v1/me/pairing", get(forbidden).put(me_pairing))
            .route("/api/v1/me/password", get(forbidden).put(me_password_put).delete(me_password_delete))
            .route("/api/v1/me/rotate-agent-secret", get(forbidden).post(me_rotate))
            .route("/api/v1/me", get(forbidden).delete(me_delete))
            .route("/ws/agent", get(ws_agent))
            .route("/api/v1/agent/poll", get(agent_poll))
            .route("/api/v1/agent/send", get(forbidden).post(agent_send))
            .route("/ws/device", get(ws_device))
            .route("/c/{user_id}", get(phone_page))
            .route("/", get(landing))
            .route("/app.js", get(asset_app_js))
            .route("/app.css", get(asset_app_css))
            .route("/crypto.js", get(asset_crypto_js))
            .route("/sjcl.js", get(asset_sjcl_js))
            .route("/icon.svg", get(asset_icon))
            .route("/manifest.webmanifest", get(asset_manifest))
            .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
            .with_state(self.clone())
    }

    /// Bind and serve until `shutdown` fires; returns the bound address (tests bind port 0).
    pub async fn serve(
        self,
        listen: SocketAddr,
        shutdown: watch::Receiver<bool>,
    ) -> std::io::Result<SocketAddr> {
        let listener = TcpListener::bind(listen).await?;
        let addr = listener.local_addr()?;
        let router = self.router();
        let mut shutdown = shutdown;
        let server = axum::serve(listener, router).with_graceful_shutdown(async move {
            let _ = shutdown.wait_for(|stop| *stop).await;
        });
        tokio::spawn(async move {
            let _ = server.await;
        });
        Ok(addr)
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn hub(&self) -> &Hub {
        &self.hub
    }

    /// Register a PC directly (tests and the `--registration open` path share it).
    pub fn register_for_test(&self, auth_hex: &str) -> Result<(User, String), StoreError> {
        let secret = random_hex_32();
        let user = self.store.create(&secret, auth_hex, self.config.max_users)?;
        Ok((user, secret))
    }
}

/* ---------- small plumbing ---------- */

fn api_json(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn ok(body: Value) -> Response {
    api_json(StatusCode::OK, body)
}

fn err(status: StatusCode, message: &str) -> Response {
    api_json(status, json!({ "error": message }))
}

/// The lockout answer: 429 with the lockout's remaining time as `Retry-After` (seconds)
/// and in the body, so a client that honors it backs off exactly as long as needed —
/// a phone blind-retrying a dead WebSocket handshake otherwise keeps the bucket locked
/// forever (the browser never shows it the status, only "Unexpected response code: 429").
fn err_locked(app: &App, headers: &HeaderMap) -> Response {
    let remaining = app
        .guard
        .locked_remaining(client_ip(headers), Kind::Auth)
        .unwrap_or(Duration::from_secs(1));
    let secs = remaining.as_secs().max(1);
    let mut response = api_json(
        StatusCode::TOO_MANY_REQUESTS,
        json!({ "error": "locked — too many attempts", "retry_after_ms": remaining.as_millis() as u64 }),
    );
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, header::HeaderValue::from_str(&secs.to_string()).expect("seconds"));
    response
}

async fn forbidden() -> Response {
    err(StatusCode::METHOD_NOT_ALLOWED, "wrong method")
}

fn client_ip(headers: &HeaderMap) -> std::net::IpAddr {
    // Behind the reverse proxy the plan assumes (Caddy/nginx), the peer address is the
    // proxy's; X-Forwarded-For's first entry is then the client.
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or_else(|| "0.0.0.0".parse().unwrap())
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let rest = value.strip_prefix("Bearer ")?;
    let token = rest.trim();
    (!token.is_empty()).then(|| token.to_string())
}

/// The credential of a connection that cannot carry headers (a browser's or undici's
/// WebSocket): the same Bearer token, as the `token` query parameter.
fn bearer_or_token(headers: &HeaderMap, token: Option<&str>) -> Option<String> {
    bearer(headers).or_else(|| token.filter(|t| !t.is_empty()).map(str::to_string))
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.is_empty() || text.len() % 2 != 0 || text.len() > 128 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}

fn constant_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x == y)
}

fn random_hex_32() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("the OS random source");
    hex(&bytes)
}

/// The PC a bearer agent secret belongs to; `Err` carries the ready 401 answer.
fn agent_user(app: &App, headers: &HeaderMap) -> Result<User, Box<Response>> {
    let Some(secret) = bearer(headers) else {
        return Err(Box::new(err(StatusCode::UNAUTHORIZED, "auth")));
    };
    for id in app.store.user_ids() {
        if let Some(user) = app.store.get(&id) {
            if constant_eq(&user.secret, &secret) && !user.disabled {
                return Ok(user);
            }
        }
    }
    Err(Box::new(err(StatusCode::UNAUTHORIZED, "auth")))
}

fn pair_proof(auth_hex: &str, nonce: &str, user_id: &str, epoch: u64) -> Option<String> {
    let key = unhex(auth_hex)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).ok()?;
    mac.update(format!("crr1/pair|{nonce}|{user_id}|{epoch}").as_bytes());
    Some(hex(&mac.finalize().into_bytes()))
}

/// Re-run the header-shaped auth over a token that arrived as a query parameter.
fn fake_headers_with_bearer(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Ok(value) = header::HeaderValue::from_str(&format!("Bearer {token}")) {
        headers.insert(header::AUTHORIZATION, value);
    }
    headers
}

fn close_message(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame { code, reason: Utf8Bytes::from(reason.to_string()) }))
}

/* ---------- registration and pairing ---------- */

async fn register(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, "bad json");
    };
    if app.guard.locked(client_ip(&headers), Kind::Register) {
        return err(StatusCode::TOO_MANY_REQUESTS, "locked");
    }
    match app.config.registration {
        Registration::Closed => return err(StatusCode::FORBIDDEN, "registration closed"),
        Registration::Token => {
            let Some(want) = app.config.invite.as_deref() else {
                return err(StatusCode::FORBIDDEN, "registration is token-gated but no token is configured");
            };
            let got = body.get("token").and_then(Value::as_str).unwrap_or("");
            if !constant_eq(got, want) {
                app.guard.hit(client_ip(&headers), Kind::Register);
                return err(StatusCode::UNAUTHORIZED, "bad registration token");
            }
        }
        Registration::Open => {}
    }
    let auth = body.get("auth").and_then(Value::as_str).unwrap_or("");
    match unhex(auth) {
        Some(key) if key.len() == 32 => {}
        _ => return err(StatusCode::BAD_REQUEST, "auth must be 32 bytes of hex (HKDF(k_auth))"),
    }
    let secret = random_hex_32();
    match app.store.create(&secret, auth, app.config.max_users) {
        Ok(user) => api_json(
            StatusCode::CREATED,
            json!({ "user_id": user.id, "agent_secret": secret, "epoch": user.epoch }),
        ),
        Err(StoreError::Full) => err(StatusCode::FORBIDDEN, "user limit reached"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.message()),
    }
}

async fn pair_challenge(State(app): State<App>, body: Bytes) -> Response {
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, "bad json");
    };
    let user_id = body.get("user_id").and_then(Value::as_str).unwrap_or("");
    let Some(user) = app.store.get(user_id) else {
        // An unknown id answers as unknown: the QR of a deleted PC should not read as live.
        return err(StatusCode::NOT_FOUND, "no such user");
    };
    if user.disabled {
        return err(StatusCode::FORBIDDEN, "disabled");
    }
    let mut nonce_bytes = [0u8; 16];
    getrandom::getrandom(&mut nonce_bytes).expect("the OS random source");
    let nonce = hex(&nonce_bytes);
    {
        let mut pairings = app.pairings.lock().unwrap();
        let now = now_ms();
        if pairings.len() > MAX_PENDING_NONCES {
            pairings.retain(|_, p| p.expires > now);
        }
        pairings.insert(
            nonce.clone(),
            PendingNonce { user: user.id.clone(), epoch: user.epoch, expires: now + NONCE_TTL_MS },
        );
    }
    ok(json!({ "nonce": nonce, "epoch": user.epoch, "password_required": user.password.is_some() }))
}

async fn pair(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Response {
    if app.guard.locked(client_ip(&headers), Kind::Auth) {
        return err_locked(&app, &headers);
    }
    if body.len() > MAX_PAIR_BODY {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "body too large");
    }
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, "bad json");
    };
    let user_id = body.get("user_id").and_then(Value::as_str).unwrap_or("");
    let nonce = body.get("nonce").and_then(Value::as_str).unwrap_or("");
    let proof = body.get("proof").and_then(Value::as_str).unwrap_or("");
    let epoch = body.get("epoch").and_then(Value::as_u64).unwrap_or(0);
    let password = body.get("password").and_then(Value::as_str).unwrap_or("");
    let device_name = body.get("device_name").and_then(Value::as_str).unwrap_or("phone");
    if device_name.len() > MAX_NAME {
        return err(StatusCode::BAD_REQUEST, "device name too long");
    }
    // The plain pairing (the link's fragment carries the auth credential itself, hex):
    // no challenge round trip and no browser crypto — the form the phone uses while the
    // frames cross unencrypted. Same epoch, password and lockout rules as the proof form.
    let secret = body.get("secret").and_then(Value::as_str).unwrap_or("");
    if !secret.is_empty() {
        let Some(user) = app.store.get(user_id) else {
            app.guard.hit(client_ip(&headers), Kind::Auth);
            return err(StatusCode::NOT_FOUND, "no such user");
        };
        if user.disabled {
            return err(StatusCode::FORBIDDEN, "disabled");
        }
        if user.epoch != epoch {
            return err(StatusCode::CONFLICT, "rekeyed — scan the new QR");
        }
        if !constant_eq(&secret.to_ascii_lowercase(), &user.auth.to_ascii_lowercase()) {
            app.guard.hit(client_ip(&headers), Kind::Auth);
            return err(StatusCode::UNAUTHORIZED, "bad proof");
        }
        return finish_pair(&app, &headers, &user, password, device_name);
    }
    // Single-use whichever way the proof lands:
    let pending = app.pairings.lock().unwrap().remove(nonce);
    let Some(pending) = pending.filter(|p| p.expires >= now_ms() && p.user == user_id) else {
        app.guard.hit(client_ip(&headers), Kind::Auth);
        return err(StatusCode::UNAUTHORIZED, "unknown or expired challenge");
    };
    let Some(user) = app.store.get(user_id) else {
        return err(StatusCode::NOT_FOUND, "no such user");
    };
    if user.epoch != epoch || pending.epoch != user.epoch {
        return err(StatusCode::CONFLICT, "rekeyed — scan the new QR");
    }
    let Some(want) = pair_proof(&user.auth, nonce, user_id, epoch) else {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "stored credential is malformed");
    };
    if !constant_eq(proof, &want) {
        app.guard.hit(client_ip(&headers), Kind::Auth);
        return err(StatusCode::UNAUTHORIZED, "bad proof");
    }
    finish_pair(&app, &headers, &user, password, device_name)
}

/// The shared tail of both pairing forms: the login-password gate, then the device.
fn finish_pair(app: &App, headers: &HeaderMap, user: &User, password: &str, device_name: &str) -> Response {
    if let Some(record) = &user.password {
        if !store::verify_password(record, password) {
            app.guard.hit(client_ip(headers), Kind::Auth);
            return err(StatusCode::UNAUTHORIZED, "bad password");
        }
    }
    match app.store.pair_device(&user.id, device_name, app.config.max_devices) {
        Ok((device, token)) => api_json(
            StatusCode::CREATED,
            json!({ "device_id": device.id, "device_token": token, "epoch": user.epoch }),
        ),
        Err(StoreError::Full) => err(StatusCode::FORBIDDEN, "device limit reached"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.message()),
    }
}

/// A stored device token's liveness: 200 when it still pairs this PC, 401 when it is
/// gone (the relay's data was reset, or the phone was revoked). The token IS the
/// credential — the login password gates pairing and interactive login, not a
/// remembered device's reconnect — so the phone can probe this before every WebSocket
/// and stop dead instead of hammering the handshake into the lockout.
async fn device_verify(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Response {
    if app.guard.locked(client_ip(&headers), Kind::Auth) {
        return err_locked(&app, &headers);
    }
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, "bad json");
    };
    let token = body
        .get("device_token")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| bearer(&headers));
    let Some(token) = token else {
        return err(StatusCode::BAD_REQUEST, "device_token is required");
    };
    match app.store.device_by_token(&token) {
        Some(device) => {
            let user = app.store.get(&device.user);
            app.store.touch_device(&device.id);
            ok(json!({
                "ok": true,
                "user_id": device.user,
                "device_id": device.id,
                "epoch": user.as_ref().map(|u| u.epoch).unwrap_or(0),
            }))
        }
        None => {
            app.guard.hit(client_ip(&headers), Kind::Auth);
            err(StatusCode::UNAUTHORIZED, "unknown device token")
        }
    }
}

async fn login(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Response {
    if app.guard.locked(client_ip(&headers), Kind::Auth) {
        return err_locked(&app, &headers);
    }
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, "bad json");
    };
    let token = body.get("device_token").and_then(Value::as_str).unwrap_or("");
    let password = body.get("password").and_then(Value::as_str).unwrap_or("");
    let Some(device) = app.store.device_by_token(token) else {
        app.guard.hit(client_ip(&headers), Kind::Auth);
        return err(StatusCode::UNAUTHORIZED, "unknown device token");
    };
    let Some(user) = app.store.get(&device.user) else {
        return err(StatusCode::UNAUTHORIZED, "unknown device token");
    };
    if let Some(record) = &user.password {
        if !store::verify_password(record, password) {
            app.guard.hit(client_ip(&headers), Kind::Auth);
            return err(StatusCode::UNAUTHORIZED, "bad password");
        }
    }
    app.store.touch_device(&device.id);
    ok(json!({ "ok": true, "user_id": user.id, "device_id": device.id, "epoch": user.epoch }))
}

/* ---------- the PC's management surface (Bearer agent secret) ---------- */

async fn me_devices(State(app): State<App>, headers: HeaderMap) -> Response {
    let Ok(user) = agent_user(&app, &headers) else {
        return err(StatusCode::UNAUTHORIZED, "auth");
    };
    let devices: Vec<Value> = app
        .store
        .devices_of(&user.id)
        .into_iter()
        .map(|d| {
            json!({
                "id": d.id, "name": d.name, "created": d.created, "last_seen": d.last_seen,
                "online": app.hub.device_is_online(&user.id, &d.id),
            })
        })
        .collect();
    // The login-password flag rides the same read: the panel shows the gate's state
    // without minting a pairing nonce to learn it.
    ok(json!({ "devices": devices, "password_set": user.password.is_some() }))
}

/// This PC's online windows, as the relay routes them — the same sealed-metadata list a
/// phone's landing view carries, answered to the PC's own windows (the panel shows the
/// machine's windows, not just this one).
async fn me_windows(State(app): State<App>, headers: HeaderMap) -> Response {
    let Ok(user) = agent_user(&app, &headers) else {
        return err(StatusCode::UNAUTHORIZED, "auth");
    };
    ok(json!({ "windows": app.hub.windows_of(&user.id) }))
}

async fn me_device_delete(State(app): State<App>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let Ok(user) = agent_user(&app, &headers) else {
        return err(StatusCode::UNAUTHORIZED, "auth");
    };
    match app.store.remove_device(&user.id, &id) {
        Ok(device) => {
            app.hub.kick_device(&user.id, &device.id, "revoked");
            ok(json!({ "ok": true }))
        }
        Err(StoreError::NotFound) => err(StatusCode::NOT_FOUND, "no such device"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.message()),
    }
}

async fn me_pairing(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(user) = agent_user(&app, &headers) else {
        return err(StatusCode::UNAUTHORIZED, "auth");
    };
    if body.len() > MAX_PAIR_BODY {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "body too large");
    }
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, "bad json");
    };
    let auth = body.get("auth").and_then(Value::as_str).unwrap_or("");
    let expect = body.get("expect_epoch").and_then(Value::as_u64).unwrap_or(0);
    match unhex(auth) {
        Some(key) if key.len() == 32 => {}
        _ => return err(StatusCode::BAD_REQUEST, "auth must be 32 bytes of hex"),
    }
    match app.store.rekey(&user.id, auth, expect) {
        Ok((after, _)) => {
            // Every phone is kicked with its reason and every window of the PC is told the
            // epoch moved — the rekeying window already knows; the others reload the
            // shared identity and re-derive their keys.
            app.hub.kick_devices(&user.id, "rekeyed");
            app.hub.notify_epoch(&user.id, after.epoch);
            ok(json!({ "ok": true, "epoch": after.epoch }))
        }
        Err(StoreError::Conflict) => err(StatusCode::CONFLICT, "stale epoch"),
        Err(StoreError::NotFound) => err(StatusCode::NOT_FOUND, "no such user"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.message()),
    }
}

async fn me_password_put(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(user) = agent_user(&app, &headers) else {
        return err(StatusCode::UNAUTHORIZED, "auth");
    };
    if body.len() > MAX_PAIR_BODY {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "body too large");
    }
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, "bad json");
    };
    let password = body.get("password").and_then(Value::as_str).unwrap_or("");
    if password.len() < 8 || password.len() > 200 {
        return err(StatusCode::BAD_REQUEST, "password must be 8-200 characters");
    }
    match store::hash_password(password).and_then(|phc| app.store.set_password(&user.id, Some(phc)).map(|_| ())) {
        Ok(()) => ok(json!({ "ok": true })),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.message()),
    }
}

async fn me_password_delete(State(app): State<App>, headers: HeaderMap) -> Response {
    let Ok(user) = agent_user(&app, &headers) else {
        return err(StatusCode::UNAUTHORIZED, "auth");
    };
    match app.store.set_password(&user.id, None) {
        Ok(_) => ok(json!({ "ok": true })),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.message()),
    }
}

async fn me_rotate(State(app): State<App>, headers: HeaderMap) -> Response {
    let Ok(user) = agent_user(&app, &headers) else {
        return err(StatusCode::UNAUTHORIZED, "auth");
    };
    let secret = random_hex_32();
    // rotate-agent-secret keeps the pairing material; only the window credential moves.
    match app.store.rotate_secret(&user.id, &secret) {
        Ok(_) => ok(json!({ "agent_secret": secret })),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.message()),
    }
}

async fn me_delete(State(app): State<App>, headers: HeaderMap) -> Response {
    let Ok(user) = agent_user(&app, &headers) else {
        return err(StatusCode::UNAUTHORIZED, "auth");
    };
    match app.store.delete(&user.id) {
        Ok(()) => {
            app.hub.kick_devices(&user.id, "deleted");
            ok(json!({ "ok": true }))
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.message()),
    }
}

/* ---------- health and pages ---------- */

async fn healthz(State(app): State<App>) -> Response {
    let (windows, devices) = app.hub.online_counts();
    ok(json!({ "ok": true, "users": app.store.user_count(), "windows": windows, "devices": devices }))
}

fn page(body: &'static str, content_type: &'static str, csp: bool) -> Response {
    let mut response = Response::new(Bytes::from_static(body.as_bytes()).into());
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, header::HeaderValue::from_static(content_type));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    if csp {
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            header::HeaderValue::from_static(
                "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            ),
        );
    }
    response
}

async fn phone_page(Path(user_id): Path<String>) -> Response {
    if !user_id.starts_with("u_") {
        return err(StatusCode::NOT_FOUND, "no such user");
    }
    page(include_str!("../web/index.html"), "text/html; charset=utf-8", true)
}

async fn landing() -> Response {
    page(
        "<!doctype html><meta charset=\"utf-8\"><title>claude-remote-server</title>\
         <p>This is a Claude Remote relay. Scan a PC's QR code, or open its /c/&lt;user id&gt; link.</p>",
        "text/html; charset=utf-8",
        true,
    )
}

async fn asset_app_js() -> Response {
    page(include_str!("../web/app.js"), "application/javascript; charset=utf-8", false)
}
async fn asset_app_css() -> Response {
    page(include_str!("../web/app.css"), "text/css; charset=utf-8", false)
}
async fn asset_crypto_js() -> Response {
    page(include_str!("../web/crypto.js"), "application/javascript; charset=utf-8", false)
}
async fn asset_sjcl_js() -> Response {
    page(include_str!("../web/sjcl.js"), "application/javascript; charset=utf-8", false)
}
async fn asset_icon() -> Response {
    page(include_str!("../web/icon.svg"), "image/svg+xml", false)
}
async fn asset_manifest() -> Response {
    page(include_str!("../web/manifest.webmanifest"), "application/manifest+json", false)
}

/* ---------- the agent (window) transport ---------- */

#[derive(serde::Deserialize)]
struct AgentParams {
    window: Option<String>,
    cursor: Option<u64>,
    token: Option<String>,
}

async fn ws_agent(
    State(app): State<App>,
    Query(params): Query<AgentParams>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let token = match bearer_or_token(&headers, params.token.as_deref()) {
        Some(token) => token,
        None => return err(StatusCode::UNAUTHORIZED, "auth"),
    };
    let Ok(user) = agent_user(&app, &fake_headers_with_bearer(&token)) else {
        return err(StatusCode::UNAUTHORIZED, "auth");
    };
    let Some(window) = params.window.as_deref().and_then(hub::window_id) else {
        return err(StatusCode::BAD_REQUEST, "window must be w_ + 16 chars");
    };
    let cap = app.config.max_frame + 4096;
    ws.max_message_size(cap)
        .max_frame_size(cap)
        .on_upgrade(move |socket| async move {
            agent_socket(app, user, window, params.cursor, socket).await;
        })
}

/// One connected window over WebSocket: drain the window's ring by cursor, and route what
/// the window sends. A newer connection for the same window id cancels this one.
async fn agent_socket(app: App, user: User, window: String, cursor: Option<u64>, socket: WebSocket) {
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    let mut watch_rx = match app.hub.window_attach(&user, &window, cancel_tx) {
        Ok(rx) => rx,
        Err(_) => return,
    };
    // A reconnecting window resumes from its own cursor; a fresh one reads only the new.
    let mut last = cursor.unwrap_or_else(|| app.hub.window_last_cursor(&user.id, &window));
    let mut rate = RateCounter::default();
    let epoch = app.store.get(&user.id).map(|u| u.epoch).unwrap_or(0);
    let (mut sink, mut source) = socket.split();
    let hello = json!({ "v": 1, "kind": "hello", "you": window, "user": user.id, "epoch": epoch }).to_string();
    if sink.send(Message::text(hello)).await.is_err() {
        app.hub.window_detach(&user.id, &window);
        return;
    }
    let mut cancel = std::pin::pin!(cancel_rx);
    loop {
        let before = *watch_rx.borrow();
        let items = app.hub.window_drain(&user.id, &window, last, 64);
        let mut highest = last;
        for (cursor, frame) in &items {
            highest = *cursor;
            if sink.send(Message::text(frame.to_string())).await.is_err() {
                app.hub.window_detach(&user.id, &window);
                return;
            }
        }
        last = highest;
        let now = *watch_rx.borrow_and_update();
        if now != before || items.len() == 64 {
            continue; // the ring moved while draining, or the batch was full
        }
        tokio::select! {
            changed = watch_rx.changed() => {
                if changed.is_err() {
                    break;
                }
            }
            message = source.next() => {
                let Some(Ok(message)) = message else { break };
                let text = match message {
                    Message::Text(text) => text,
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    let _ = sink.send(close_message(hub::CLOSE_PROTOCOL, "not json")).await;
                    break;
                };
                if let Err((code, reason)) = handle_agent_message(&app, &user, &window, &value, &mut rate) {
                    let _ = sink.send(close_message(code, reason)).await;
                    break;
                }
            }
            _ = cancel.as_mut() => {
                let _ = sink.send(close_message(hub::CLOSE_AUTH, "replaced by a newer connection")).await;
                break;
            }
        }
    }
    app.hub.window_detach(&user.id, &window);
}

/// One agent message: a frame to route, or the window's sealed metadata to publish.
/// `Err` carries the WS close code and reason.
fn handle_agent_message(
    app: &App,
    user: &User,
    window: &str,
    value: &Value,
    rate: &mut RateCounter,
) -> Result<(), (u16, &'static str)> {
    match value.get("kind").and_then(Value::as_str) {
        Some("window.meta") => {
            let Some(ct) = value.get("ct").and_then(Value::as_str) else {
                return Err((hub::CLOSE_PROTOCOL, "window.meta needs a ct"));
            };
            if ct.len() > 1_572_864 {
                return Err((hub::CLOSE_PROTOCOL, "window.meta ct too large"));
            }
            let host = value
                .get("host")
                .and_then(Value::as_str)
                .map(|h| h.chars().take(24).collect::<String>());
            app.hub.window_meta(&user.id, window, Some(ct.to_string()), host);
            Ok(())
        }
        Some("frame") => {
            let Some(frame) = Frame::parse(value) else {
                return Err((hub::CLOSE_PROTOCOL, "malformed frame"));
            };
            if frame.from != window {
                return Err((hub::CLOSE_PROTOCOL, "from must be this window's id"));
            }
            if rate.hit() {
                return Err((hub::CLOSE_RATE, "frame rate exceeded"));
            }
            app.hub.route(user, frame).map(|_| ()).map_err(|e| (e.close_code(), e.message()))
        }
        _ => Ok(()), // unknown kinds are the protocol's headroom, not errors
    }
}

#[derive(serde::Deserialize)]
struct PollParams {
    window: Option<String>,
    cursor: Option<u64>,
    wait: Option<u64>,
}

/// The ggs-node fallback: no WebSocket client, so a window long-polls frames and POSTs
/// its own. `poll` and `ws` read the same ring with the same cursors, so a client may
/// switch between them freely.
async fn agent_poll(State(app): State<App>, Query(params): Query<PollParams>, headers: HeaderMap) -> Response {
    let Ok(user) = agent_user(&app, &headers) else {
        return err(StatusCode::UNAUTHORIZED, "auth");
    };
    let Some(window) = params.window.as_deref().and_then(hub::window_id) else {
        return err(StatusCode::BAD_REQUEST, "window must be w_ + 16 chars");
    };
    let mut watch_rx = match app.hub.window_poll_attach(&user, &window) {
        Ok(rx) => rx,
        Err(e) => return err(StatusCode::CONFLICT, e.message()),
    };
    // A first poll (no cursor) reads only what arrives after it — like a fresh socket.
    let mut last = match params.cursor {
        Some(cursor) => cursor,
        None => *watch_rx.borrow_and_update(),
    };
    let wait = Duration::from_secs(params.wait.unwrap_or(25)).min(MAX_POLL_WAIT);
    let mut items = app.hub.window_drain(&user.id, &window, last, 256);
    if items.is_empty() && wait > Duration::ZERO {
        let deadline = tokio::time::Instant::now() + wait;
        let _ = tokio::time::timeout_at(deadline, watch_rx.changed()).await;
        let _ = watch_rx.borrow_and_update();
        items = app.hub.window_drain(&user.id, &window, last, 256);
    }
    if let Some((cursor, _)) = items.last() {
        last = *cursor;
    }
    let epoch = app.store.get(&user.id).map(|u| u.epoch).unwrap_or(0);
    ok(json!({
        "v": 1,
        "frames": items.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>(),
        "cursor": last,
        "epoch": epoch,
        "user": user.id,
    }))
}

async fn agent_send(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(user) = agent_user(&app, &headers) else {
        return err(StatusCode::UNAUTHORIZED, "auth");
    };
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, "bad json");
    };
    let Some(window) = body.get("window").and_then(Value::as_str).and_then(hub::window_id) else {
        return err(StatusCode::BAD_REQUEST, "window must be w_ + 16 chars");
    };
    let Some(frames) = body.get("frames").and_then(Value::as_array) else {
        return err(StatusCode::BAD_REQUEST, "frames must be an array");
    };
    if frames.len() > MAX_SEND_FRAMES {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "too many frames in one send");
    }
    let mut rate = RateCounter::default();
    for raw in frames {
        match handle_agent_message(&app, &user, &window, raw, &mut rate) {
            Ok(()) => {}
            Err((_, reason)) => return err(StatusCode::BAD_REQUEST, reason),
        }
    }
    ok(json!({ "ok": true, "accepted": frames.len(), "cursor": app.hub.window_last_cursor(&user.id, &window) }))
}

/* ---------- the phone transport ---------- */

#[derive(serde::Deserialize)]
struct DeviceParams {
    token: Option<String>,
}

async fn ws_device(
    State(app): State<App>,
    Query(params): Query<DeviceParams>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(token) = bearer_or_token(&headers, params.token.as_deref()) else {
        return err(StatusCode::UNAUTHORIZED, "auth");
    };
    if app.guard.locked(client_ip(&headers), Kind::Auth) {
        return err_locked(&app, &headers);
    }
    let Some(device) = app.store.device_by_token(&token) else {
        app.guard.hit(client_ip(&headers), Kind::Auth);
        return err(StatusCode::UNAUTHORIZED, "unknown device token");
    };
    let Some(user) = app.store.get(&device.user) else {
        return err(StatusCode::UNAUTHORIZED, "unknown device token");
    };
    if user.disabled {
        return err(StatusCode::FORBIDDEN, "disabled");
    }
    app.store.touch_device(&device.id);
    ws.on_upgrade(move |socket| async move {
        device_loop(app, user, device, socket).await;
    })
}

async fn device_loop(app: App, user: User, device: store::Device, socket: WebSocket) {
    let (mut sink, mut source) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(app.config.queue_frames.max(16));
    let kill = app.hub.device_attach(&device, tx);
    let epoch = app.store.get(&user.id).map(|u| u.epoch).unwrap_or(0);
    let hello = json!({ "v": 1, "kind": "hello", "you": device.id, "user": user.id, "epoch": epoch }).to_string();
    if sink.send(Message::text(hello)).await.is_err() {
        app.hub.device_detach(&user.id, &device.id);
        return;
    }
    let mut rate = RateCounter::default();
    loop {
        tokio::select! {
            push = rx.recv() => {
                match push {
                    Some(text) => {
                        let kick = text.contains("\"kind\":\"kick\"");
                        let overflowed = text.contains("\"kind\":\"overflow\"");
                        if sink.send(Message::text(text)).await.is_err() {
                            break;
                        }
                        if kick || overflowed {
                            let code = if kick { hub::CLOSE_AUTH } else { hub::CLOSE_OVERFLOW };
                            let reason = if kick { "kicked" } else { "overflow" };
                            let _ = sink.send(close_message(code, reason)).await;
                            break;
                        }
                    }
                    None => {
                        // The hub dropped its sender (a kick already drained, or shutdown).
                        let _ = sink.send(close_message(hub::CLOSE_AUTH, "kicked")).await;
                        break;
                    }
                }
            }
            _ = kill.notified() => {
                // The phone's queue overflowed: the plan's rule is to disconnect and let
                // the phone resync itself on reconnect.
                let _ = sink.send(close_message(hub::CLOSE_OVERFLOW, "overflow")).await;
                break;
            }
            message = source.next() => {
                let Some(Ok(message)) = message else { break };
                let text = match message {
                    Message::Text(text) => text,
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    let _ = sink.send(close_message(hub::CLOSE_PROTOCOL, "not json")).await;
                    break;
                };
                match value.get("kind").and_then(Value::as_str) {
                    Some("windows") => {
                        let list = app.hub.windows_of(&user.id);
                        let _ = sink.send(Message::text(format!(r#"{{"v":1,"kind":"windows","list":{list}}}"#))).await;
                    }
                    Some("frame") => {
                        let verdict = Frame::parse(&value)
                            .filter(|frame| frame.from == device.id && !rate.hit())
                            .and_then(|frame| app.hub.route(&user, frame).map(|_| ()).ok());
                        if verdict.is_none() {
                            let _ = sink.send(close_message(hub::CLOSE_PROTOCOL, "bad frame")).await;
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    app.hub.device_detach(&user.id, &device.id);
}
