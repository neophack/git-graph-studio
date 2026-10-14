//! The local control channel's server (docs/ggs-remote-plan.md §7.8): GGS instances connect
//! over a named pipe (Windows, remote clients rejected) or a Unix domain socket under
//! `~/.ggs/remote/`, register, and then serve the daemon's asset, file and Relay requests.
//! A dropped connection unregisters the instance and sends its remote sessions back to the
//! window picker.

use interprocess::local_socket::tokio::{prelude::*, RecvHalf, SendHalf};
use interprocess::local_socket::ListenerOptions;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use crate::control_io::read_message;
use crate::control_msg::{decode, encode, FromInstance, ToInstance};
use crate::registry::{Registration, ReplyChunk};
use crate::state::Daemon;

/// Bind the control endpoint and accept instances until shutdown.
pub async fn serve(daemon: Arc<Daemon>) -> std::io::Result<()> {
    let endpoint = daemon.paths.control_endpoint();
    let listener = bind(&endpoint)?;
    crate::info!("control channel listening at {endpoint}");
    loop {
        let stream = match listener.accept().await {
            Ok(stream) => stream,
            Err(e) => {
                crate::warn!("control accept: {e}");
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
        };
        let daemon = daemon.clone();
        tokio::spawn(async move {
            let (rx, tx) = stream.split();
            if let Err(e) = serve_instance(daemon, rx, tx, false).await {
                crate::warn!("control connection ended: {e}");
            }
        });
    }
}

#[cfg(windows)]
fn bind(endpoint: &str) -> std::io::Result<interprocess::local_socket::tokio::Listener> {
    use interprocess::local_socket::{GenericNamespaced, ToNsName};
    let name = endpoint.to_ns_name::<GenericNamespaced>()?;
    ListenerOptions::new().name(name).create_tokio()
}

#[cfg(not(windows))]
fn bind(endpoint: &str) -> std::io::Result<interprocess::local_socket::tokio::Listener> {
    use interprocess::local_socket::{GenericFilePath, ToFsName};
    // The single-instance lock is held: a socket file left behind is a corpse, never a live
    // daemon's.
    let _ = std::fs::remove_file(endpoint);
    let name = endpoint.to_fs_name::<GenericFilePath>()?;
    let listener = ListenerOptions::new().name(name).create_tokio()?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(endpoint, std::fs::Permissions::from_mode(0o600));
    }
    Ok(listener)
}

pub(crate) async fn serve_instance(
    daemon: Arc<Daemon>,
    mut rx: RecvHalf,
    mut tx: SendHalf,
    sandbox_channel: bool,
) -> std::io::Result<()> {
    let first = tokio::time::timeout(Duration::from_secs(10), read_message(&mut rx))
        .await
        .map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::TimedOut, "no Register within 10 s")
        })??;
    let FromInstance::Register {
        instance_id,
        pid,
        version,
        title,
        folders,
        visible,
        remote_host,
        launch,
        control_token,
        ..
    } = decode::<FromInstance>(&first).map_err(std::io::Error::other)?
    else {
        return Err(std::io::Error::other(
            "the first control message must be Register",
        ));
    };
    // The sandbox endpoint serves instances the daemon itself spawned into a sandbox —
    // a Register is accepted only with an unconsumed one-shot token (§23). The main
    // endpoint ignores the field entirely: a sandboxed process cannot reach it (the
    // sandbox token cannot open the default DACL), so there is nothing to check.
    let sandboxed = sandbox_channel && crate::sandbox::take_token(&daemon, &control_token);
    if sandbox_channel && !sandboxed {
        return Err(std::io::Error::other(
            "a sandboxed instance must register with the token it was issued",
        ));
    }
    if instance_id.is_empty()
        || instance_id.len() > 64
        || !instance_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(std::io::Error::other("invalid instance id"));
    }
    // Field caps (audit F9): every one of these rides the WINDOWS frames to every
    // connected browser and, for folders, into recent.json — a hostile or buggy local
    // process on the control channel must not make either unbounded. 64 folders covers
    // a multi-root workspace with room to spare.
    if title.len() > 256
        || version.len() > 64
        || folders.len() > 64
        || folders.iter().any(|f| f.len() > 1024)
        || launch.program.len() > 1024
        || launch.args_prefix.len() > 16
        || launch.args_prefix.iter().any(|a| a.len() > 1024)
    {
        return Err(std::io::Error::other("register fields exceed their caps"));
    }
    if !launch.program.is_empty() {
        let mut config = daemon.config.lock().unwrap();
        if config.last_launch.as_ref() != Some(&launch) {
            config.last_launch = Some(launch.clone());
            let _ = config.save(&daemon.paths);
        }
    }
    let (ctl_tx, mut ctl_rx) = mpsc::unbounded_channel::<ToInstance>();
    let serial = daemon.registry.register(
        Registration {
            instance_id: instance_id.clone(),
            pid,
            version,
            title,
            folders: folders.clone(),
            visible,
            remote_host,
            launch,
            sandboxed,
        },
        ctl_tx.clone(),
    );
    crate::recent::note_folders(&daemon, &folders);
    crate::info!("instance {instance_id} registered (pid {pid})");
    let relay_url = format!(
        "ws://127.0.0.1:{}/relay",
        daemon
            .loopback_port
            .load(std::sync::atomic::Ordering::Relaxed)
    );
    let _ = ctl_tx.send(ToInstance::Welcome {
        daemon_version: env!("CARGO_PKG_VERSION").into(),
        relay_url,
    });

    let writer = tokio::spawn(async move {
        while let Some(message) = ctl_rx.recv().await {
            if tx.write_all(&encode(&message)).await.is_err() {
                break;
            }
        }
    });

    let result = read_loop(&daemon, &instance_id, &mut rx).await;
    writer.abort();
    if daemon.registry.unregister(&instance_id, serial).is_some() {
        crate::info!("instance {instance_id} left");
        crate::router::instance_gone(&daemon, &instance_id);
    }
    result
}

async fn read_loop(daemon: &Arc<Daemon>, id: &str, rx: &mut RecvHalf) -> std::io::Result<()> {
    loop {
        let body = read_message(rx).await?;
        let message = match decode::<FromInstance>(&body) {
            Ok(message) => message,
            Err(e) => {
                crate::warn!("{id}: {e}");
                continue;
            }
        };
        match message {
            FromInstance::Register { .. } => {}
            FromInstance::Update {
                title,
                folders,
                visible,
                summary,
            } => {
                // The same caps as Register (audit F9) — an oversized update is dropped,
                // the connection stays.
                if title.as_ref().is_some_and(|t| t.len() > 256)
                    || folders.as_ref().is_some_and(|f| f.len() > 64)
                    || folders
                        .as_ref()
                        .is_some_and(|f| f.iter().any(|path| path.len() > 1024))
                    || summary.as_ref().is_some_and(|s| s.tabs.len() > 256)
                    || summary
                        .as_ref()
                        .is_some_and(|s| s.tabs.iter().any(|t| t.path.len() > 1024))
                {
                    crate::warn!("{id}: an update exceeded its field caps");
                    continue;
                }
                daemon
                    .registry
                    .update(id, title, folders.clone(), visible, summary);
                if let Some(folders) = folders {
                    crate::recent::note_folders(daemon, &folders);
                }
            }
            FromInstance::Pong { nonce } => {
                let was = daemon.registry.with(id, |i| {
                    let before = i.info.state.clone();
                    i.control_beat.pong(nonce);
                    i.info.last_seen = crate::util::now_secs();
                    before
                });
                if was.as_deref() == Some("unresponsive") {
                    crate::lifecycle::refresh_states(daemon);
                }
            }
            FromInstance::CloseBlocked { dirty } => {
                if let Some(Some(waiter)) = daemon.registry.with(id, |i| i.close_waiter.take()) {
                    let _ = waiter.send(dirty);
                }
            }
            FromInstance::AssetReply {
                req,
                status,
                content_type,
                etag,
                body,
                done,
            } => daemon.registry.deliver(
                id,
                req,
                ReplyChunk {
                    status,
                    content_type,
                    etag,
                    name: String::new(),
                    total: 0,
                    body,
                    done,
                },
            ),
            FromInstance::FileReply {
                req,
                status,
                name,
                total,
                chunk,
                done,
            } => daemon.registry.deliver(
                id,
                req,
                ReplyChunk {
                    status,
                    content_type: String::new(),
                    etag: String::new(),
                    name,
                    total,
                    body: chunk,
                    done,
                },
            ),
            FromInstance::RelayReady => {}
            FromInstance::Bye => return Ok(()),
        }
    }
}
