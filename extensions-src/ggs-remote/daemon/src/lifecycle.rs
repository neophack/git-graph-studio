//! Instance lifecycle (docs/ggs-remote-plan.md §7.8, §7.10, §13, R12/R20): the two-level
//! heartbeat and the `unresponsive` flag, SPAWN, the graceful / forced close, the restart,
//! and the idle exit of daemon-spawned invisible instances.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::control_msg::{LaunchSpec, ToInstance};
use crate::state::Daemon;
use crate::ws::frame::{ty, Frame};

pub const REGISTER_WAIT: Duration = Duration::from_secs(30);
pub const CLOSE_WAIT: Duration = Duration::from_secs(10);

/// One heartbeat round (called every few seconds): ping both levels when due, then recompute
/// the `unresponsive` flags.
pub fn heartbeat(daemon: &Arc<Daemon>, now: Instant) {
    let mut relay_pings = Vec::new();
    for (id, inst) in daemon.registry.instances.lock().unwrap().iter_mut() {
        if let Some(nonce) = inst.control_beat.tick(now) {
            let _ = inst.control.send(ToInstance::Ping { nonce });
        }
        // The UI-level beat runs only while a Relay is up (remote sessions attached).
        if let Some(relay) = &inst.relay {
            if let Some(nonce) = inst.relay_beat.tick(now) {
                relay_pings.push((id.clone(), relay.clone(), nonce));
            }
        }
    }
    for (_, relay, nonce) in relay_pings {
        let _ = relay.send(Frame::empty(ty::PING).with_stream(nonce as u32).encode());
    }
    refresh_states(daemon);
}

/// Recompute `ok` / `unresponsive` from both beats; a change pushes WINDOWS.
pub fn refresh_states(daemon: &Arc<Daemon>) {
    let now = Instant::now();
    let mut changed = false;
    for inst in daemon.registry.instances.lock().unwrap().values_mut() {
        let stuck = inst.control_beat.overdue(now)
            || (inst.relay.is_some() && inst.relay_beat.overdue(now));
        let state = if stuck { "unresponsive" } else { "ok" };
        if inst.info.state != state {
            inst.info.state = state.into();
            changed = true;
            crate::info!("instance {} is {state}", inst.info.id);
        }
    }
    if changed {
        daemon.registry.changed();
    }
}

/// SPAWN (R12): start a new instance and answer its id once it registered. With the
/// security sandbox enabled (§23) the instance starts inside the OS sandbox instead —
/// and a folder outside the sandbox root is refused here, before anything runs.
pub async fn spawn(
    daemon: &Arc<Daemon>,
    folder: Option<String>,
    visible: Option<bool>,
    via_remote: bool,
) -> Result<String, String> {
    let live = latest_launch(daemon);
    let config = daemon.config();
    let spec = crate::spawn::pick_spec(live, &config)
        .ok_or("no GGS installation is known yet — open Git Graph Studio on this PC once")?;
    let visible = visible.unwrap_or(config.spawn_visible);
    let waiter = daemon.registry.wait_for_registration(REGISTER_WAIT);
    // Only a remote session's spawn is sandboxed: the tray and the admin API act for the
    // user at the PC, whose windows are full-trust and simply not listed for remote
    // sessions while the sandbox is on.
    if config.sandbox.enabled && via_remote {
        let plan = crate::sandbox::plan(&config, &daemon.paths);
        crate::sandbox::ensure_listener(daemon);
        crate::sandbox::launch(daemon, &plan, &spec, folder.as_deref(), visible)?;
    } else {
        crate::spawn::launch(&spec, folder.as_deref(), visible)?;
    }
    waiter
        .await
        .ok_or_else(|| "the new window did not register within 30 s".to_owned())
}

fn latest_launch(daemon: &Arc<Daemon>) -> Option<LaunchSpec> {
    daemon
        .registry
        .instances
        .lock()
        .unwrap()
        .values()
        .max_by_key(|i| i.info.started_at)
        .map(|i| i.launch.clone())
}

pub enum CloseOutcome {
    Closed,
    Blocked(Vec<String>),
    Missing,
}

/// INSTANCE_CLOSE (R20): graceful `Quit` first; unsaved files block it unless `force`, which
/// kills the pid — only while the pid still owns the instance's control connection (the
/// registry entry exists). The residual race, stated honestly: the registry.exists +
/// pid_alive check and the kill are not atomic, and on Unix kill_pid spawns /bin/kill,
/// which widens the window — a pid reused inside it could be hit. No cheap cross-platform
/// start-identity check exists to close it, so the window stays.
pub async fn close(daemon: &Arc<Daemon>, instance: &str, force: bool) -> CloseOutcome {
    let Some(pid) = daemon.registry.with(instance, |i| i.pid) else {
        return CloseOutcome::Missing;
    };
    if force {
        kill_registered(daemon, instance, pid);
        return CloseOutcome::Closed;
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    daemon
        .registry
        .with(instance, |i| i.close_waiter = Some(tx));
    daemon.registry.send(
        instance,
        ToInstance::Quit {
            force: false,
            idle: false,
        },
    );
    match tokio::time::timeout(CLOSE_WAIT, rx).await {
        Ok(Ok(dirty)) if !dirty.is_empty() => CloseOutcome::Blocked(dirty),
        _ => CloseOutcome::Closed,
    }
}

fn kill_registered(daemon: &Arc<Daemon>, instance: &str, pid: u32) {
    if daemon.registry.exists(instance) && crate::util::pid_alive(pid) {
        crate::util::kill_pid(pid);
        crate::info!("instance {instance} (pid {pid}) terminated");
    }
}

/// INSTANCE_RESTART (R20): terminate, relaunch with the same launch spec and folders, and
/// answer the new instance's id once it registered. A sandboxed instance restarts
/// sandboxed, under the sandbox the config asks for now.
pub async fn restart(daemon: &Arc<Daemon>, instance: &str) -> Result<String, String> {
    let (pid, launch, folders, spawned, sandboxed) = daemon
        .registry
        .with(instance, |i| {
            (
                i.pid,
                i.launch.clone(),
                i.info.folders.clone(),
                i.info.spawned,
                i.info.sandboxed,
            )
        })
        .ok_or("that window is gone")?;
    kill_registered(daemon, instance, pid);
    let config = daemon.config();
    let spec = crate::spawn::pick_spec(Some(launch), &config)
        .ok_or("no launch command is known for that window")?;
    let waiter = daemon.registry.wait_for_registration(REGISTER_WAIT);
    if sandboxed && config.sandbox.enabled {
        let plan = crate::sandbox::plan(&config, &daemon.paths);
        crate::sandbox::ensure_listener(daemon);
        crate::sandbox::launch(
            daemon,
            &plan,
            &spec,
            folders.first().map(String::as_str),
            !spawned,
        )?;
    } else {
        crate::spawn::launch(&spec, folders.first().map(String::as_str), !spawned)?;
    }
    waiter
        .await
        .ok_or_else(|| "the restarted window did not register within 30 s".to_owned())
}

/// Daemon-spawned invisible instances quit after `idleExitMinutes` with no remote session,
/// no terminal and nothing unsaved (§7.10).
pub fn idle_exit(daemon: &Arc<Daemon>, now: Instant) {
    let minutes = daemon.config().idle_exit_minutes;
    if minutes == 0 {
        return;
    }
    let limit = Duration::from_secs(minutes * 60);
    for inst in daemon.registry.instances.lock().unwrap().values_mut() {
        let idle = inst.info.spawned
            && !inst.info.visible
            && inst.info.remote_sessions == 0
            && inst.info.busy.terminals == 0
            && inst.info.busy.dirty == 0;
        if !idle {
            inst.idle_since = None;
            continue;
        }
        let since = *inst.idle_since.get_or_insert(now);
        if now.duration_since(since) >= limit {
            inst.idle_since = None;
            let _ = inst.control.send(ToInstance::Quit {
                force: false,
                idle: true,
            });
            crate::info!("idle invisible instance {} asked to quit", inst.info.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Paths;
    use crate::registry::Registration;
    use crate::state::Daemon;
    use std::time::Instant;

    fn daemon_with_idle_minutes(minutes: u64) -> Arc<Daemon> {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
        paths.ensure().unwrap();
        let config = crate::config::Config {
            idle_exit_minutes: minutes,
            ..Default::default()
        };
        let daemon = Daemon::new(paths, config).unwrap();
        // The tempdir outlives the daemon through the test (the registry only holds paths).
        std::mem::forget(dir);
        daemon
    }

    fn register(
        daemon: &Daemon,
        id: &str,
        spawned: bool,
        remote_sessions: u32,
    ) -> tokio::sync::mpsc::UnboundedReceiver<ToInstance> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        daemon.registry.register(
            Registration {
                instance_id: id.into(),
                pid: std::process::id(),
                version: "0.1.10".into(),
                title: "repo".into(),
                folders: vec![],
                visible: !spawned,
                remote_host: spawned, // register() maps this onto the registry's spawned
                launch: Default::default(),
                sandboxed: false,
            },
            tx,
        );
        daemon
            .registry
            .instances
            .lock()
            .unwrap()
            .get_mut(id)
            .unwrap()
            .info
            .remote_sessions = remote_sessions;
        rx
    }

    /// §7.10: a daemon-spawned invisible instance with nothing going on is asked to quit
    /// once its idle minutes pass — and only then (the first tick merely arms the clock).
    /// A busy one (a remote session, a terminal, unsaved files) is never asked.
    #[tokio::test]
    async fn idle_invisible_instances_quit_after_their_minutes() {
        let daemon = daemon_with_idle_minutes(1);
        let mut idle = register(&daemon, "idle", true, 0);
        let mut attached = register(&daemon, "attached", true, 1);
        let start = Instant::now();

        // The first round arms the clock; nothing is asked yet.
        idle_exit(&daemon, start);
        assert!(idle.try_recv().is_err(), "not before the minutes pass");

        // A minute later the idle one is asked to quit; the attached one is not.
        idle_exit(&daemon, start + Duration::from_secs(61));
        assert!(matches!(
            idle.try_recv(),
            Ok(ToInstance::Quit {
                force: false,
                idle: true
            })
        ));
        assert!(attached.try_recv().is_err(), "a session keeps the instance");
    }

    /// `idle_exit_minutes = 0` (the default) turns the whole behaviour off.
    #[tokio::test]
    async fn zero_minutes_disables_the_idle_exit() {
        let daemon = daemon_with_idle_minutes(0);
        let mut idle = register(&daemon, "idle", true, 0);
        let start = Instant::now();
        idle_exit(&daemon, start + Duration::from_secs(10_000));
        assert!(idle.try_recv().is_err());
    }
}
