//! The JSON API (docs/ggs-remote-plan.md §7.3, §7.6): login / logout / session, the remote
//! password change, the device list, download tickets — and the loopback pair page's
//! password-gated calls (R19).

use axum::extract::{ConnectInfo, Path, Query, State};
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

/// Run the rate limiter around a password check; `Err` is the response to send.
pub async fn throttled_verify(
    daemon: &Arc<Daemon>,
    ip: std::net::IpAddr,
    password: &str,
) -> Result<(), Response> {
    let verdict = daemon.limiter.lock().unwrap().check(ip, Instant::now());
    match verdict {
        Verdict::Locked(wait) => {
            return Err(json_response(
                StatusCode::TOO_MANY_REQUESTS,
                serde_json::json!({ "error": "locked", "retryAfter": wait.as_secs().max(1) }),
            ))
        }
        Verdict::Delay(delay) => tokio::time::sleep(delay).await,
        Verdict::Allow => {}
    }
    if daemon.auth.verify(password).await {
        daemon.limiter.lock().unwrap().success(ip);
        Ok(())
    } else {
        let lock = daemon.limiter.lock().unwrap().failure(ip, Instant::now());
        crate::warn!("password check failed from {ip}");
        Err(match lock {
            Some(wait) => json_response(
                StatusCode::TOO_MANY_REQUESTS,
                serde_json::json!({ "error": "locked", "retryAfter": wait.as_secs() }),
            ),
            None => error(StatusCode::UNAUTHORIZED, "wrong-password"),
        })
    }
}

pub async fn login(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
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
    daemon.note_foreign(ip);
    if let Err(response) = throttled_verify(&daemon, ip, &body.password).await {
        return response;
    }
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let epoch = daemon.auth.epoch();
    let (token, session) =
        daemon
            .sessions
            .lock()
            .unwrap()
            .create(epoch, &body.device, ua, ip, body.remember);
    crate::info!("login from {ip} ({})", session.device);
    let base = base_path(&headers);
    let max_age = if body.remember {
        format!("; Max-Age={REMEMBER_SECS}")
    } else {
        String::new()
    };
    let cookie =
        format!("{COOKIE}={token}; HttpOnly; Secure; SameSite=Strict; Path={base}{max_age}");
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
    (
        StatusCode::OK,
        [(
            header::SET_COOKIE,
            format!("{COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path={base}; Max-Age=0"),
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
    if let Err(response) = throttled_verify(&daemon, ip, &body.current).await {
        return response;
    }
    set_password(&daemon, &body.password).await
}

pub async fn set_password(daemon: &Arc<Daemon>, password: &str) -> Response {
    match daemon.auth.set_password(password).await {
        Ok(_) => {
            daemon.credentials_changed("credentials-changed");
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
    if !daemon.registry.exists(&body.instance) || body.path.is_empty() {
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
            zip: body.zip,
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
    if let Err(response) = throttled_verify(&daemon, peer.ip(), &body.password).await {
        return response;
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
