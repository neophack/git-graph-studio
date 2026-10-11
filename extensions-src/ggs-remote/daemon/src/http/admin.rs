//! The local admin API (docs/ggs-remote-plan.md §7.11): loopback only, `Authorization:
//! Bearer <admin.token>`. The GGS extension page and the CLI's `forward_to_running` speak it.

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use super::{error, json_response};
use crate::state::Daemon;
use crate::util::ct_eq;

fn authorized(daemon: &Daemon, headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|t| ct_eq(t.trim().as_bytes(), daemon.admin_token.as_bytes()))
}

macro_rules! admin_only {
    ($daemon:expr, $headers:expr) => {
        if !authorized(&$daemon, &$headers) {
            return error(StatusCode::UNAUTHORIZED, "admin-token");
        }
    };
}

/// The status object; addresses, links and the QR-able data only when `open` (R19: the pair
/// page and the extension page show them after the password unlock).
pub fn status_json(daemon: &Daemon, open: bool) -> serde_json::Value {
    let config = daemon.config();
    let port = daemon.public_port.load(Ordering::Relaxed);
    let scheme = if config.tls.mode == crate::config::TlsMode::None {
        "http"
    } else {
        "https"
    };
    let addresses = crate::tls::lan_addresses();
    let links: Vec<String> = addresses
        .iter()
        .map(|a| crate::tls::link_for(scheme, a, port))
        .chain(crate::tls::hostname_local().map(|h| crate::tls::link_for(scheme, &h, port)))
        .collect();
    let epoch = daemon.auth.epoch();
    let devices = daemon.sessions.lock().unwrap().devices(epoch, None);
    let last_foreign = daemon.last_foreign.load(Ordering::Relaxed);
    let mut status = serde_json::json!({
        "running": true,
        "version": env!("CARGO_PKG_VERSION"),
        "paused": config.paused,
        "listening": daemon.listening.load(Ordering::Relaxed),
        "passwordSet": daemon.auth.is_set(),
        "port": port,
        "bind": config.bind,
        "tls": { "mode": config.tls.mode, "caFingerprint": daemon.ca_fingerprint.lock().unwrap().clone() },
        "sessions": daemon.live_conn_count(),
        "devices": devices.len(),
        "instances": daemon.registry.snapshot().len(),
        "lastForeignAccess": if last_foreign == 0 { serde_json::Value::Null } else { last_foreign.into() },
        "rss": crate::util::rss_bytes(),
        "uptimeSecs": daemon.started.elapsed().as_secs(),
        "unlocked": open,
        "config": config,
        "hub": daemon.hub.snapshot().as_json(),
    });
    if open {
        status["addresses"] = serde_json::json!(addresses);
        let mut all = links.clone();
        if let crate::hub::Status::Online { public_base, .. } = daemon.hub.snapshot() {
            all.push(public_base);
        }
        status["links"] = serde_json::json!(all);
        status["link"] = links.first().cloned().into();
    }
    status
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct UnlockQuery {
    unlock: String,
}

pub async fn status(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    Query(q): Query<UnlockQuery>,
) -> Response {
    admin_only!(daemon, headers);
    let open = !q.unlock.is_empty() && daemon.tickets.lock().unwrap().check_unlock(&q.unlock);
    json_response(StatusCode::OK, status_json(&daemon, open))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct PasswordBody {
    password: String,
}

/// Set or change the password locally: no current password needed (§7.6).
pub async fn password(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    Json(body): Json<PasswordBody>,
) -> Response {
    admin_only!(daemon, headers);
    super::api::set_password(&daemon, &body.password).await
}

pub async fn pause(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    admin_only!(daemon, headers);
    set_paused(&daemon, true);
    json_response(
        StatusCode::OK,
        serde_json::json!({ "ok": true, "paused": true }),
    )
}

pub async fn resume(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    admin_only!(daemon, headers);
    set_paused(&daemon, false);
    json_response(
        StatusCode::OK,
        serde_json::json!({ "ok": true, "paused": false }),
    )
}

pub fn set_paused(daemon: &Arc<Daemon>, paused: bool) {
    {
        let mut config = daemon.config.lock().unwrap();
        config.paused = paused;
        let _ = config.save(&daemon.paths);
    }
    if paused {
        let _ = daemon.kicks.send(crate::state::Kick {
            token_hash: None,
            code: 4503,
            reason: "paused".into(),
        });
    }
    crate::info!(
        "remote access {}",
        if paused { "paused" } else { "resumed" }
    );
    daemon.update_tray();
}

pub async fn devices(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    admin_only!(daemon, headers);
    let epoch = daemon.auth.epoch();
    let list = daemon.sessions.lock().unwrap().devices(epoch, None);
    json_response(StatusCode::OK, serde_json::json!({ "devices": list }))
}

pub async fn remove_device(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    admin_only!(daemon, headers);
    let hash = daemon.sessions.lock().unwrap().remove_by_id(&id);
    match hash {
        Some(hash) => {
            daemon.revoke(&hash);
            json_response(StatusCode::OK, serde_json::json!({ "ok": true }))
        }
        None => error(StatusCode::NOT_FOUND, "no-such-device"),
    }
}

/// "Sign out all devices": the password stays, the epoch moves (§7.6).
pub async fn signout_all(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    admin_only!(daemon, headers);
    match daemon.auth.bump_epoch() {
        Ok(_) => {
            daemon.credentials_changed("revoked");
            json_response(StatusCode::OK, serde_json::json!({ "ok": true }))
        }
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

pub async fn qr(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    admin_only!(daemon, headers);
    let unlocked = q
        .get("unlock")
        .is_some_and(|u| daemon.tickets.lock().unwrap().check_unlock(u));
    if !unlocked {
        return error(StatusCode::FORBIDDEN, "locked");
    }
    super::api::qr_response(q.get("text").map(String::as_str).unwrap_or(""))
}

pub async fn config(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    Json(patch): Json<serde_json::Value>,
) -> Response {
    admin_only!(daemon, headers);
    let result = {
        let mut config = daemon.config.lock().unwrap();
        let mut next = config.clone();
        match next.apply_patch(&patch) {
            Ok(rebind) => {
                if let Err(e) = next.save(&daemon.paths) {
                    Err(e.to_string())
                } else {
                    let autostart_changed = next.autostart != config.autostart;
                    *config = next.clone();
                    Ok((rebind, autostart_changed, next))
                }
            }
            Err(e) => Err(e),
        }
    };
    match result {
        Ok((rebind, autostart_changed, next)) => {
            if autostart_changed {
                if let Err(e) = crate::autostart::apply(next.autostart) {
                    crate::warn!("autostart: {e}");
                }
            }
            if rebind {
                daemon.rebind.notify_one();
            }
            json_response(
                StatusCode::OK,
                serde_json::json!({ "ok": true, "rebind": rebind, "config": next }),
            )
        }
        Err(e) => error(StatusCode::BAD_REQUEST, &e),
    }
}

pub async fn pair_ticket(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    admin_only!(daemon, headers);
    let ticket = daemon.tickets.lock().unwrap().issue_pair();
    let port = daemon.loopback_port.load(Ordering::Relaxed);
    json_response(
        StatusCode::OK,
        serde_json::json!({ "ticket": ticket, "url": format!("http://127.0.0.1:{port}/pair?t={ticket}") }),
    )
}

pub async fn unlock(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    Json(body): Json<PasswordBody>,
) -> Response {
    admin_only!(daemon, headers);
    if !daemon.auth.is_set() {
        return error(StatusCode::CONFLICT, "no-password");
    }
    let local: std::net::IpAddr = [127, 0, 0, 1].into();
    if let Err(response) = super::api::throttled_verify(&daemon, local, &body.password).await {
        return response;
    }
    let token = daemon.tickets.lock().unwrap().issue_unlock();
    json_response(StatusCode::OK, serde_json::json!({ "unlock": token }))
}

pub async fn shutdown(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    admin_only!(daemon, headers);
    crate::info!("shutdown requested over the admin API");
    daemon.shutdown.notify_waiters();
    daemon.shutdown.notify_one();
    json_response(StatusCode::OK, serde_json::json!({ "ok": true }))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct HubConnectBody {
    url: String,
    #[serde(default)]
    join_key: String,
    #[serde(default)]
    fingerprint: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct HubKeyBody {
    password: String,
    #[serde(default)]
    data: String,
}

/// The Hub tunnel's state and settings (§20.10): what the extension page shows.
pub async fn hub_status(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    admin_only!(daemon, headers);
    let status = daemon.hub.snapshot();
    let mut value = status.as_json();
    value["settings"] = match daemon.hub.current() {
        Some(settings) => serde_json::to_value(settings).unwrap_or(serde_json::Value::Null),
        None => serde_json::Value::Null,
    };
    value["uuid"] = match crate::hub::identity::load_or_create(&daemon.paths) {
        Ok((key, _)) => crate::hub::identity::uuid_for(&key.verifying_key().to_bytes()).into(),
        Err(_) => serde_json::Value::Null,
    };
    json_response(StatusCode::OK, value)
}

/// Point this PC at a relay: the URL (the pasteable connect string works too) and, when the
/// server has one, its join key.
pub async fn hub_connect(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    Json(body): Json<HubConnectBody>,
) -> Response {
    admin_only!(daemon, headers);
    let settings = if body.join_key.is_empty() && body.fingerprint.is_empty() {
        // A whole connect string in the url field: take what it spells.
        match crate::hub::parse_connect_string(&body.url) {
            Ok(settings) => settings,
            Err(e) => return error(StatusCode::BAD_REQUEST, &e),
        }
    } else {
        crate::hub::Settings {
            url: body.url,
            join_key: body.join_key,
            fingerprint: body.fingerprint,
        }
    };
    match daemon.hub.connect(settings) {
        Ok(()) => json_response(StatusCode::OK, daemon.hub.snapshot().as_json()),
        Err(e) => error(StatusCode::BAD_REQUEST, &e),
    }
}

/// Forget the relay; the device key stays, so reconnecting keeps the same link.
pub async fn hub_disconnect(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    admin_only!(daemon, headers);
    match daemon.hub.disconnect() {
        Ok(()) => json_response(StatusCode::OK, daemon.hub.snapshot().as_json()),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

/// Change this PC's link: a new device key, a new UUID — the old one 404s the moment the
/// old tunnel dies (§20.1).
pub async fn hub_relink(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    admin_only!(daemon, headers);
    match crate::hub::identity::rotate(&daemon.paths) {
        Ok(key) => {
            daemon.hub.restart.notify_one();
            let uuid = crate::hub::identity::uuid_for(&key.verifying_key().to_bytes());
            json_response(StatusCode::OK, serde_json::json!({ "uuid": uuid }))
        }
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// The device key sealed under the access password — carry the link to a new PC (§20.1).
pub async fn hub_export_key(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    Json(body): Json<HubKeyBody>,
) -> Response {
    admin_only!(daemon, headers);
    match crate::hub::identity::export_encrypted(&daemon.paths, &body.password) {
        Ok(blob) => json_response(StatusCode::OK, serde_json::json!({ "data": blob })),
        Err(e) => error(StatusCode::BAD_REQUEST, &e),
    }
}

/// Install a previously exported key (the same link on a new PC).
pub async fn hub_import_key(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    Json(body): Json<HubKeyBody>,
) -> Response {
    admin_only!(daemon, headers);
    match crate::hub::identity::import_encrypted(&daemon.paths, &body.password, &body.data) {
        Ok(uuid) => {
            daemon.hub.restart.notify_one();
            json_response(StatusCode::OK, serde_json::json!({ "uuid": uuid }))
        }
        Err(e) => error(StatusCode::BAD_REQUEST, &e),
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct SpawnBody {
    folder: Option<String>,
    visible: Option<bool>,
}

/// Start a GGS window (the tray's "Open Git Graph Studio" and the CLI).
pub async fn spawn(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    Json(body): Json<SpawnBody>,
) -> Response {
    admin_only!(daemon, headers);
    match crate::lifecycle::spawn(&daemon, body.folder, body.visible.or(Some(true))).await {
        Ok(id) => json_response(StatusCode::OK, serde_json::json!({ "instance": id })),
        Err(e) => error(StatusCode::BAD_GATEWAY, &e),
    }
}
