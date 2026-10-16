//! Frame routing between browser connections and instance Relays (docs/ggs-remote-plan.md
//! §7.8): `ATTACH` binds a connection to an instance (asking the instance for a Relay when it
//! has none), browser frames go to that Relay with the `session` field set to the
//! connection's number, and Relay frames come back to the connection the field names. The
//! payloads are never parsed here.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::control_msg::ToInstance;
use crate::registry::{RELAY_LINGER, RELAY_TOKEN_TTL};
use crate::state::Daemon;
use crate::util::token;
use crate::ws::conn::Conn;
use crate::ws::frame::{ty, Frame};
use crate::ws::msg::{code, Attached, Notice};

/// How long an ATTACH waits for the instance's Relay to connect.
pub const RELAY_WAIT: Duration = Duration::from_secs(20);

pub enum AttachError {
    NoInstance,
    RelayTimeout,
}

/// Bind a connection to an instance and make sure its Relay is up; answers the ATTACHED body.
pub async fn attach(
    daemon: &Arc<Daemon>,
    conn: &Arc<Conn>,
    instance: &str,
) -> Result<Attached, AttachError> {
    if let Some(previous) = conn.instance() {
        if previous != instance {
            detach(daemon, conn);
        }
    }
    let version = daemon
        .registry
        .version_of(instance)
        .ok_or(AttachError::NoInstance)?;
    conn.set_instance(Some(instance.to_owned()));
    refresh_session_counts(daemon);
    let mut ready = ensure_relay(daemon, instance).ok_or(AttachError::NoInstance)?;
    if !*ready.borrow() {
        let waited = tokio::time::timeout(RELAY_WAIT, ready.wait_for(|up| *up)).await;
        if !matches!(waited, Ok(Ok(_))) {
            conn.set_instance(None);
            refresh_session_counts(daemon);
            return Err(AttachError::RelayTimeout);
        }
    }
    let base = conn.base_path.trim_end_matches('/');
    let tok = daemon.resource_token(&conn.token_hash, instance);
    Ok(Attached {
        instance: instance.to_owned(),
        version: version.clone(),
        asset_base: format!("{base}/w/{instance}/v/{version}/"),
        ggs_base: format!("{base}/w/{instance}/ggs/{tok}/"),
        frontend_id: format!("remote/{}", conn.id),
    })
}

/// Ask the instance for a Relay unless one is connected (or already requested); answers the
/// readiness watch.
fn ensure_relay(
    daemon: &Arc<Daemon>,
    instance: &str,
) -> Option<tokio::sync::watch::Receiver<bool>> {
    let mut request = None;
    let ready = daemon.registry.with(instance, |inst| {
        inst.relay_idle_since = None;
        let pending = inst
            .relay_token
            .as_ref()
            .is_some_and(|(_, at)| at.elapsed() < RELAY_TOKEN_TTL);
        if inst.relay.is_none() && !pending {
            let t = token(32);
            inst.relay_token = Some((t.clone(), Instant::now()));
            request = Some(t);
        }
        inst.relay_ready.subscribe()
    })?;
    if let Some(t) = request {
        daemon
            .registry
            .send(instance, ToInstance::EnsureRelay { token: t });
    }
    Some(ready)
}

/// Unbind a connection: the Relay drops the session's subscriptions and channels.
pub fn detach(daemon: &Arc<Daemon>, conn: &Arc<Conn>) {
    let Some(instance) = conn.instance() else {
        return;
    };
    conn.set_instance(None);
    send_to_relay(
        daemon,
        &instance,
        Frame::empty(ty::SESSION_END).with_session(conn.id),
    );
    refresh_session_counts(daemon);
}

/// A browser frame for the attached instance's Relay.
pub fn to_relay(daemon: &Arc<Daemon>, conn: &Arc<Conn>, frame: Frame) {
    let Some(instance) = conn.instance() else {
        if frame.ty == ty::INVOKE {
            conn.push(error_result(frame.stream, "not attached to a window"));
        }
        return;
    };
    let stream = frame.stream;
    let invoke = frame.ty == ty::INVOKE;
    if !send_to_relay(daemon, &instance, frame.with_session(conn.id)) && invoke {
        conn.push(error_result(stream, "the window's relay is not connected"));
    }
}

fn send_to_relay(daemon: &Arc<Daemon>, instance: &str, frame: Frame) -> bool {
    let bytes = frame.encode();
    daemon
        .registry
        .with(instance, |inst| {
            inst.relay
                .as_ref()
                .is_some_and(|relay| relay.send(bytes).is_ok())
        })
        .unwrap_or(false)
}

/// A frame from an instance's Relay: back to the connection its session names.
pub fn from_relay(daemon: &Arc<Daemon>, instance: &str, frame: Frame) {
    if frame.ty == ty::PONG && frame.session == 0 {
        let nonce = frame.stream as u64;
        daemon
            .registry
            .with(instance, |inst| inst.relay_beat.pong(nonce));
        return;
    }
    let Some(conn) = daemon.conn(frame.session) else {
        return;
    };
    if conn.instance().as_deref() != Some(instance) {
        return;
    }
    conn.push(frame);
}

/// An `RESULT` with the ERROR bit and a `{message}` body.
pub fn error_result(stream: u32, message: &str) -> Frame {
    let mut frame =
        Frame::json(ty::RESULT, &serde_json::json!({ "message": message })).with_stream(stream);
    frame.flags |= crate::ws::frame::flag::ERROR;
    frame
}

/// The Relay connected.
pub fn relay_up(
    daemon: &Arc<Daemon>,
    instance: &str,
    sender: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
) {
    daemon.registry.with(instance, |inst| {
        inst.relay = Some(sender);
        inst.relay_token = None;
        inst.relay_beat.reset();
        inst.relay_ready.send_replace(true);
    });
    crate::info!("relay connected for {instance}");
}

/// The Relay disconnected: tell the attached sessions and ask for a new one if any remain.
pub fn relay_down(daemon: &Arc<Daemon>, instance: &str) {
    let had = daemon
        .registry
        .with(instance, |inst| {
            inst.relay_ready.send_replace(false);
            inst.relay.take().is_some()
        })
        .unwrap_or(false);
    if !had {
        return;
    }
    let attached = attached_conns(daemon, instance);
    for conn in &attached {
        conn.push(Frame::msgpack(
            ty::NOTICE,
            &Notice {
                instance: Some(instance.to_owned()),
                ..Notice::kind("relay-restarted")
            },
        ));
    }
    if !attached.is_empty() {
        ensure_relay(daemon, instance);
    }
    crate::info!("relay disconnected for {instance}");
}

pub fn attached_conns(daemon: &Arc<Daemon>, instance: &str) -> Vec<Arc<Conn>> {
    daemon
        .conns
        .lock()
        .unwrap()
        .values()
        .filter(|c| c.instance().as_deref() == Some(instance))
        .cloned()
        .collect()
}

/// The instance is gone: every attached connection goes back to the window picker (4410 as
/// a NOTICE + CLOSE frame pair the browser acts on; the socket itself stays — the picker
/// reuses it).
pub fn instance_gone(daemon: &Arc<Daemon>, instance: &str) {
    for conn in attached_conns(daemon, instance) {
        conn.set_instance(None);
        conn.push(Frame::msgpack(
            ty::NOTICE,
            &Notice {
                instance: Some(instance.to_owned()),
                ..Notice::kind("instance-exited")
            },
        ));
        conn.close(code::INSTANCE_GONE, "instance-exited");
    }
    refresh_session_counts(daemon);
}

/// A connection's state is dropped for good (resume window passed, logout, kick).
pub fn end_conn(daemon: &Arc<Daemon>, conn: &Arc<Conn>) {
    detach(daemon, conn);
    daemon.conns.lock().unwrap().remove(&conn.id);
    daemon.update_tray();
}

pub fn refresh_session_counts(daemon: &Arc<Daemon>) {
    let mut counts: HashMap<String, u32> = HashMap::new();
    for conn in daemon.conns.lock().unwrap().values() {
        if let Some(inst) = conn.instance() {
            *counts.entry(inst).or_default() += 1;
        }
    }
    // What each instance held before the change (§17.4): the Sessions push rides on the
    // delta, so an attach or detach tells the instance exactly once — its close button
    // asks this count before deciding between hiding for the remotes and exiting.
    let before: HashMap<String, u32> = daemon
        .registry
        .instances
        .lock()
        .unwrap()
        .iter()
        .map(|(id, inst)| (id.clone(), inst.info.remote_sessions))
        .collect();
    daemon.registry.set_session_counts(&counts);
    let now = Instant::now();
    for (id, inst) in daemon.registry.instances.lock().unwrap().iter_mut() {
        if counts.get(id).copied().unwrap_or(0) == 0 {
            if inst.relay.is_some() && inst.relay_idle_since.is_none() {
                inst.relay_idle_since = Some(now);
            }
        } else {
            inst.relay_idle_since = None;
            inst.idle_since = None;
        }
    }
    // The delta runs over both maps: a count that DROPPED TO ZERO lives only in `before`
    // (the detach case) — the PC's close button must see the gate close too.
    let mut ids: Vec<String> = counts.keys().cloned().collect();
    for id in before.keys() {
        if !counts.contains_key(id) {
            ids.push(id.clone());
        }
    }
    for id in &ids {
        let count = counts.get(id).copied().unwrap_or(0);
        if before.get(id).copied().unwrap_or(0) != count {
            let _ = daemon.registry.send(id, ToInstance::Sessions { count });
            crate::info!("instance {id} now serves {count} remote session(s)");
        }
    }
}

/// Housekeeping: Relays that outlived their last session by a minute are dropped.
pub fn drop_idle_relays(daemon: &Arc<Daemon>, now: Instant) {
    let mut drop_ids = Vec::new();
    for (id, inst) in daemon.registry.instances.lock().unwrap().iter_mut() {
        if inst
            .relay_idle_since
            .is_some_and(|since| now.duration_since(since) >= RELAY_LINGER)
        {
            inst.relay_idle_since = None;
            drop_ids.push(id.clone());
        }
    }
    for id in drop_ids {
        daemon.registry.send(&id, ToInstance::DropRelay);
        crate::info!("relay of {id} idle: dropped");
    }
}
