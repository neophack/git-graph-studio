//! The JSON API (docs/ggs-remote-plan.md §7.3, §7.6): login / logout / session, the remote
//! password change, the device list, download tickets — and the loopback pair page's
//! password-gated calls (R19).

use axum::extract::{ConnectInfo, Extension, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use super::{
    base_path, client_ip, cookie_token, error, json_request_ok, json_response, session_of,
    token_hash_of, COOKIE,
};
use crate::ratelimit::Verdict;
use crate::session::{REMEMBER_SECS, SLIDING_SECS};
use crate::state::{Daemon, DownloadTicket};

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct LoginBody {
    password: String,
    device: String,
    remember: bool,
}

/// The ceiling on Argon2 verifications in flight at once (audit F3, 2026-10-13): each
/// hash holds ~19 MiB and a core; unbounded concurrent junk logins (which all pass the
/// check-then-fail limiter's first window) once bought ~4 GB of RSS on the LAN. Two per
/// core is far above any honest login's need.
fn verify_permits() -> &'static tokio::sync::Semaphore {
    static PERMITS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    PERMITS.get_or_init(|| {
        tokio::sync::Semaphore::new(2 * std::thread::available_parallelism().map_or(2, |n| n.get()))
    })
}

/// Run the rate limiter around a password check; `Err` is the response to send. `origin`
/// is the address the LOG names when the request rode the Hub tunnel (the `OriginIp`
/// extension) — the limiter itself keeps keying on `ip`, the shared tunnel bucket.
pub async fn throttled_verify(
    daemon: &Arc<Daemon>,
    ip: std::net::IpAddr,
    origin: Option<std::net::IpAddr>,
    password: &str,
) -> Result<(), Box<Response>> {
    // Boxed: `Response` alone is past clippy's `result_large_err` ceiling (1.99), and the
    // wrapper is on every login path — one indirection, no copies.
    let verdict = daemon.limiter.lock().unwrap().check(ip, Instant::now());
    match verdict {
        Verdict::Locked(wait) => {
            return Err(Box::new(json_response(
                StatusCode::TOO_MANY_REQUESTS,
                serde_json::json!({ "error": "locked", "retryAfter": wait.as_secs().max(1) }),
            )))
        }
        Verdict::Delay(delay) => tokio::time::sleep(delay).await,
        Verdict::Allow => {}
    }
    let _permit = verify_permits().acquire().await.map_err(|_| {
        Box::new(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "the daemon is stopping",
        ))
    })?;
    if daemon.auth.verify(password).await {
        daemon.limiter.lock().unwrap().success(ip);
        Ok(())
    } else {
        let lock = daemon.limiter.lock().unwrap().failure(ip, Instant::now());
        crate::warn!("password check failed from {}", origin.unwrap_or(ip));
        Err(Box::new(match lock {
            Some(wait) => json_response(
                StatusCode::TOO_MANY_REQUESTS,
                serde_json::json!({ "error": "locked", "retryAfter": wait.as_secs() }),
            ),
            None => error(StatusCode::UNAUTHORIZED, "wrong-password"),
        }))
    }
}

/// The session cookie's `Secure` follows the scheme the browser actually spoke: a
/// Hub-fronted request carries the Hub's `x-forwarded-proto` (the Hub never forwards a
/// browser's own copy — only its stamp), and a direct request follows this daemon's TLS
/// mode. Unconditional `Secure` once made a plain-HTTP Hub's login return success while
/// the browser silently dropped every cookie (§7.6; forging the header only strips
/// `Secure` from the forger's own cookie, never anyone else's).
fn cookie_secure(daemon: &Daemon, headers: &HeaderMap) -> bool {
    if let Some(proto) = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
    {
        return proto.eq_ignore_ascii_case("https");
    }
    daemon.config().tls.mode != crate::config::TlsMode::None
}

pub async fn login(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    origin: Option<Extension<crate::http::OriginIp>>,
    headers: HeaderMap,
    body: Option<Json<LoginBody>>,
) -> Response {
    if !json_request_ok(&headers) {
        return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "json-required");
    }
    let Some(Json(body)) = body else {
        return error(StatusCode::BAD_REQUEST, "bad-request");
    };
    let ip = client_ip(&daemon, peer, &headers);
    // The tunnel's extension names the browser behind the Hub; the limiter still keys on
    // `ip` (the shared bucket), but the log line says who actually knocked.
    let origin = origin.map(|Extension(crate::http::OriginIp(ip))| ip);
    daemon.note_foreign(origin.unwrap_or(ip));
    if let Err(response) = throttled_verify(&daemon, ip, origin, &body.password).await {
        return *response;
    }
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let epoch = daemon.auth.epoch();
    let seen_from = origin.unwrap_or(ip);
    let (token, session) =
        daemon
            .sessions
            .lock()
            .unwrap()
            .create(epoch, &body.device, ua, seen_from, body.remember);
    crate::info!("login from {seen_from} ({})", session.device);
    let base = base_path(&headers);
    let max_age = if body.remember {
        format!("; Max-Age={REMEMBER_SECS}")
    } else {
        String::new()
    };
    let secure = if cookie_secure(&daemon, &headers) {
        "; Secure"
    } else {
        ""
    };
    let cookie =
        format!("{COOKIE}={token}; HttpOnly{secure}; SameSite=Strict; Path={base}{max_age}");
    (
        StatusCode::OK,
        [
            (header::SET_COOKIE, cookie),
            (header::CACHE_CONTROL, "no-store".into()),
        ],
        Json(serde_json::json!({ "ok": true, "device": session.device })),
    )
        .into_response()
}

pub async fn logout(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    if !json_request_ok(&headers) {
        return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "json-required");
    }
    if let Some(hash) = token_hash_of(&headers) {
        daemon.revoke(&hash);
    }
    let base = base_path(&headers);
    let secure = if cookie_secure(&daemon, &headers) {
        "; Secure"
    } else {
        ""
    };
    (
        StatusCode::OK,
        [(
            header::SET_COOKIE,
            format!("{COOKIE}=; HttpOnly{secure}; SameSite=Strict; Path={base}; Max-Age=0"),
        )],
        Json(serde_json::json!({ "ok": true })),
    )
        .into_response()
}

pub async fn session(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    let Some(session) = session_of(&daemon, &headers) else {
        return error(StatusCode::UNAUTHORIZED, "no-session");
    };
    json_response(
        StatusCode::OK,
        serde_json::json!({
            "device": session.device,
            "expires": session.expires(),
            "csrf": session.csrf,
            "remember": session.remember,
            "slidingSecs": SLIDING_SECS,
            "basePath": base_path(&headers),
            "dataSaverDefault": daemon.config().data_saver_default,
            "spawnVisible": daemon.config().spawn_visible,
            "folderInput": daemon.config().folder_input,
            // The sandbox (§23): with it on, the picker opens folders inside the sandbox
            // root only, so the typed-path row hides and the hint explains where files live.
            "sandbox": {
                "enabled": daemon.config().sandbox.enabled,
                "root": crate::sandbox::effective_root(&daemon.config(), &daemon.paths)
                    .to_string_lossy()
                    .into_owned(),
            },
        }),
    )
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct PasswordBody {
    current: String,
    password: String,
}

/// The remote password change (§7.6): the current password is required; success ends every
/// session — this one included — with 4401 `credentials-changed`.
pub async fn change_password(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    origin: Option<Extension<crate::http::OriginIp>>,
    headers: HeaderMap,
    body: Option<Json<PasswordBody>>,
) -> Response {
    if !json_request_ok(&headers) {
        return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "json-required");
    }
    if session_of(&daemon, &headers).is_none() {
        return error(StatusCode::UNAUTHORIZED, "no-session");
    }
    let Some(Json(body)) = body else {
        return error(StatusCode::BAD_REQUEST, "bad-request");
    };
    let ip = client_ip(&daemon, peer, &headers);
    let origin = origin.map(|Extension(crate::http::OriginIp(ip))| ip);
    if let Err(response) = throttled_verify(&daemon, ip, origin, &body.current).await {
        return *response;
    }
    set_password(&daemon, &body.password).await
}

pub async fn set_password(daemon: &Arc<Daemon>, password: &str) -> Response {
    match daemon.auth.set_password(password).await {
        Ok(_) => {
            daemon.credentials_changed("credentials-changed");
            // A Hub configured while no password existed sits in NoPassword, parked on the
            // restart notify — the password landing is what lets it connect (§20.4).
            daemon.hub.restart.notify_one();
            json_response(StatusCode::OK, serde_json::json!({ "ok": true }))
        }
        Err(e @ (crate::auth::AuthError::TooShort | crate::auth::AuthError::TooCommon)) => {
            json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": "weak-password", "message": e.to_string() }),
            )
        }
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

pub async fn devices(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    let Some(session) = session_of(&daemon, &headers) else {
        return error(StatusCode::UNAUTHORIZED, "no-session");
    };
    let epoch = daemon.auth.epoch();
    let list = daemon
        .sessions
        .lock()
        .unwrap()
        .devices(epoch, Some(&session.token_hash));
    json_response(StatusCode::OK, serde_json::json!({ "devices": list }))
}

pub async fn remove_device(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if session_of(&daemon, &headers).is_none() {
        return error(StatusCode::UNAUTHORIZED, "no-session");
    }
    if headers
        .get("sec-fetch-site")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == "cross-site")
    {
        return error(StatusCode::FORBIDDEN, "cross-site");
    }
    let hash = daemon.sessions.lock().unwrap().remove_by_id(&id);
    match hash {
        Some(hash) => {
            daemon.revoke(&hash);
            json_response(StatusCode::OK, serde_json::json!({ "ok": true }))
        }
        None => error(StatusCode::NOT_FOUND, "no-such-device"),
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct TicketBody {
    instance: String,
    path: String,
    zip: bool,
    /// The multi-select pack (§6.7): two or more paths, one zipped download. `path` stays
    /// the single-path form's field.
    paths: Vec<String>,
}

/// A one-time download URL (§7.8): the browser navigates to it, so it must not depend on a
/// header the navigation cannot carry.
pub async fn download_ticket(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    body: Option<Json<TicketBody>>,
) -> Response {
    if !json_request_ok(&headers) {
        return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "json-required");
    }
    let Some(session) = session_of(&daemon, &headers) else {
        return error(StatusCode::UNAUTHORIZED, "no-session");
    };
    let Some(Json(body)) = body else {
        return error(StatusCode::BAD_REQUEST, "bad-request");
    };
    // The multi form needs its two paths; the single form needs its one. A multi body caps
    // its paths the way a body field ever gets capped here (a bounded request, not an
    // unbounded walk handed to the instance). A multi ticket IS a zip whatever the body
    // said: the browser's downloadMany posts `paths` with no `zip` field (§6.7), and the
    // instance packs `zip_trees` unconditionally for two or more paths — the ticket must
    // say so, or the answer goes out as application/octet-stream.
    let multi = body.paths.len() >= 2 && body.paths.len() <= 1000;
    if !daemon.registry.exists(&body.instance) || (body.path.is_empty() && !multi) {
        return error(StatusCode::NOT_FOUND, "no-such-window");
    }
    let ticket = daemon
        .tickets
        .lock()
        .unwrap()
        .issue_download(DownloadTicket {
            token_hash: session.token_hash,
            instance: body.instance.clone(),
            path: body.path,
            zip: body.zip || multi,
            paths: if multi { body.paths } else { Vec::new() },
        });
    let base = base_path(&headers);
    json_response(
        StatusCode::OK,
        serde_json::json!({ "url": format!("{base}w/{}/download?t={ticket}", body.instance) }),
    )
}

// ---- the loopback pair page (R19) ----

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct PairUnlock {
    ticket: String,
    password: String,
}

fn ticket_ok(daemon: &Daemon, ticket: &str) -> bool {
    daemon.tickets.lock().unwrap().check_pair(ticket)
}

fn unlocked(daemon: &Daemon, token: Option<&String>) -> bool {
    token.is_some_and(|t| daemon.tickets.lock().unwrap().check_unlock(t))
}

pub async fn pair_unlock(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Option<Json<PairUnlock>>,
) -> Response {
    let Some(Json(body)) = body else {
        return error(StatusCode::BAD_REQUEST, "bad-request");
    };
    if !json_request_ok(&headers) || !ticket_ok(&daemon, &body.ticket) {
        return error(StatusCode::FORBIDDEN, "ticket");
    }
    if !daemon.auth.is_set() {
        return error(StatusCode::CONFLICT, "no-password");
    }
    if let Err(response) = throttled_verify(&daemon, peer.ip(), None, &body.password).await {
        return *response;
    }
    let unlock = daemon.tickets.lock().unwrap().issue_unlock();
    json_response(StatusCode::OK, serde_json::json!({ "unlock": unlock }))
}

/// What the pair page shows; addresses and links only once unlocked.
pub async fn pair_state(
    State(daemon): State<Arc<Daemon>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(ticket) = query.get("t") else {
        return error(StatusCode::FORBIDDEN, "ticket");
    };
    if !ticket_ok(&daemon, ticket) {
        return error(StatusCode::FORBIDDEN, "ticket");
    }
    let open = unlocked(&daemon, query.get("u"));
    json_response(
        StatusCode::OK,
        crate::http::admin::status_json(&daemon, open),
    )
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct PairPassword {
    ticket: String,
    unlock: String,
    password: String,
}

/// Set the password from the pair page: the very first one needs only the ticket (it is
/// local and nothing is protected yet); a change needs an unlock token.
pub async fn pair_password(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    body: Option<Json<PairPassword>>,
) -> Response {
    let Some(Json(body)) = body else {
        return error(StatusCode::BAD_REQUEST, "bad-request");
    };
    if !json_request_ok(&headers) || !ticket_ok(&daemon, &body.ticket) {
        return error(StatusCode::FORBIDDEN, "ticket");
    }
    let first = !daemon.auth.is_set();
    if !first && !unlocked(&daemon, Some(&body.unlock)) {
        return error(StatusCode::FORBIDDEN, "locked");
    }
    let response = set_password(&daemon, &body.password).await;
    if response.status() == StatusCode::OK {
        // Setting the password counts as unlocking (§7.6).
        let unlock = daemon.tickets.lock().unwrap().issue_unlock();
        return json_response(
            StatusCode::OK,
            serde_json::json!({ "ok": true, "unlock": unlock }),
        );
    }
    response
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct PairHub {
    ticket: String,
    url: String,
    #[serde(default, alias = "joinKey")]
    join_key: String,
}

/// Point this PC at a relay from the pair page: its set-password and unlock screens carry
/// the server fields (2026-10-12), so a server may land before any password exists — it
/// parks in NoPassword and connects the moment one does (§20.4). The one-time pair ticket
/// is the local proof, the same one that authorizes setting the very password.
pub async fn pair_hub_connect(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    body: Option<Json<PairHub>>,
) -> Response {
    let Some(Json(body)) = body else {
        return error(StatusCode::BAD_REQUEST, "bad-request");
    };
    if !json_request_ok(&headers) || !ticket_ok(&daemon, &body.ticket) {
        return error(StatusCode::FORBIDDEN, "ticket");
    }
    let settings = match super::admin::hub_settings(&body.url, &body.join_key, "") {
        Ok(settings) => settings,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    match daemon.hub.connect(settings) {
        Ok(()) => json_response(
            StatusCode::OK,
            super::admin::hub_state_settled(&daemon).await.as_json(),
        ),
        Err(e) => error(StatusCode::BAD_REQUEST, &e),
    }
}

/// Forget the relay from the pair page; the device key stays (§20.10).
pub async fn pair_hub_disconnect(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    body: Option<Json<PairHub>>,
) -> Response {
    let Some(Json(body)) = body else {
        return error(StatusCode::BAD_REQUEST, "bad-request");
    };
    if !json_request_ok(&headers) || !ticket_ok(&daemon, &body.ticket) {
        return error(StatusCode::FORBIDDEN, "ticket");
    }
    match daemon.hub.disconnect() {
        Ok(()) => json_response(StatusCode::OK, daemon.hub.snapshot().as_json()),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

pub async fn pair_qr(
    State(daemon): State<Arc<Daemon>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let ticket_valid = query.get("t").is_some_and(|t| ticket_ok(&daemon, t));
    if !ticket_valid || !unlocked(&daemon, query.get("u")) {
        return error(StatusCode::FORBIDDEN, "locked");
    }
    qr_response(query.get("text").map(String::as_str).unwrap_or(""))
}

pub fn qr_response(text: &str) -> Response {
    if text.is_empty() || text.len() > 512 {
        return error(StatusCode::BAD_REQUEST, "text");
    }
    match crate::tls::qr_svg(text) {
        Some(svg) => (
            [
                (header::CONTENT_TYPE, "image/svg+xml"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            svg,
        )
            .into_response(),
        None => error(StatusCode::BAD_REQUEST, "text"),
    }
}

/// Whether the request carries a cookie at all (used by pages to choose login vs picker).
pub fn has_cookie(headers: &HeaderMap) -> bool {
    cookie_token(headers).is_some()
}

#[cfg(test)]
mod cookie_secure_tests {
    use super::{cookie_secure, Daemon, HeaderMap};
    use crate::config::{Config, TlsConfig, TlsMode};
    use crate::paths::Paths;

    fn daemon_with(mode: TlsMode) -> (tempfile::TempDir, std::sync::Arc<Daemon>) {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
        paths.ensure().unwrap();
        let config = Config {
            port: 0,
            bind: "127.0.0.1".into(),
            tls: TlsConfig {
                mode,
                ..Default::default()
            },
            ..Default::default()
        };
        (dir, Daemon::new(paths, config).unwrap())
    }

    fn proto(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", value.parse().unwrap());
        headers
    }

    #[test]
    fn secure_follows_the_scheme_the_browser_spoke() {
        // Direct against a plain-HTTP listener: no Secure, or the browser drops the cookie.
        let (_dir, plain) = daemon_with(TlsMode::None);
        assert!(!cookie_secure(&plain, &HeaderMap::new()));
        // Direct against TLS: Secure, the hardening holds.
        let (_dir, tls) = daemon_with(TlsMode::SelfSigned);
        assert!(cookie_secure(&tls, &HeaderMap::new()));
        let (_dir, tls) = daemon_with(TlsMode::Custom);
        assert!(cookie_secure(&tls, &HeaderMap::new()));
        // A Hub's stamp decides for tunneled requests, whatever the local listener is.
        assert!(!cookie_secure(&plain, &proto("http")));
        assert!(cookie_secure(&plain, &proto("https")));
        assert!(cookie_secure(&tls, &proto("HTTPS")));
        assert!(!cookie_secure(&tls, &proto("http")));
    }
}
