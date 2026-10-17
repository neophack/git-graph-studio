//! The daemon's async half (docs/ggs-remote-plan.md §7.1): the loopback listener (Relay,
//! pair page, admin API) on a random 127.0.0.1 port recorded in `loopback.json`, the control
//! channel, the public HTTPS listener (rebound when the port, bind address or TLS mode
//! changes), and the housekeeping tick — heartbeats, idle Relays, expired resume windows,
//! idle invisible instances, and the certificate re-issue when the LAN addresses change.

use axum_server::tls_rustls::RustlsConfig;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::config::TlsMode;
use crate::state::{Daemon, TrayState};

pub const TICK: Duration = Duration::from_secs(5);

/// Run until shutdown is requested.
pub async fn run(daemon: Arc<Daemon>) -> std::io::Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let loopback = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let loopback_port = loopback.local_addr()?.port();
    daemon.loopback_port.store(loopback_port, Ordering::Relaxed);
    *daemon.relay_url_base.lock().unwrap() = format!("ws://127.0.0.1:{loopback_port}/relay");
    crate::paths::write_private(
        &daemon.paths.loopback(),
        serde_json::json!({ "port": loopback_port, "pid": std::process::id() })
            .to_string()
            .as_bytes(),
    )?;
    crate::info!("loopback listener on 127.0.0.1:{loopback_port}");
    let app = crate::http::loopback_router(daemon.clone())
        .into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move {
        if let Err(e) = axum::serve(loopback, app).await {
            crate::warn!("loopback listener stopped: {e}");
        }
    });

    {
        let daemon = daemon.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::control::serve(daemon).await {
                crate::warn!("control channel failed: {e}");
            }
        });
    }

    // The sandbox control endpoint (§23): up at boot when the sandbox is on, and lazily
    // by the first sandboxed spawn if it is switched on later.
    if daemon.config().sandbox.enabled {
        crate::sandbox::ensure_listener(&daemon);
    }

    tokio::spawn(public_listener(daemon.clone()));
    tokio::spawn(windows_broadcaster(daemon.clone()));
    tokio::spawn(housekeeping(daemon.clone()));
    {
        let daemon = daemon.clone();
        tokio::spawn(async move {
            daemon.hub.clone().run(daemon).await;
        });
    }

    daemon.shutdown.notified().await;
    crate::info!("shutting down");
    let _ = std::fs::remove_file(daemon.paths.loopback());
    let _ = daemon.kicks.send(crate::state::Kick {
        token_hash: None,
        code: 1001,
        reason: "server-stopping".into(),
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    daemon.stopped.store(true, Ordering::Relaxed);
    Ok(())
}

/// The public listener, rebound on demand; a bind failure (port taken) shows on the tray and
/// is retried every 30 s — the port never moves on its own, the link must stay (R8).
async fn public_listener(daemon: Arc<Daemon>) {
    loop {
        let config = daemon.config();
        let bind = config.effective_bind();
        let addr: SocketAddr = match format!("{bind}:{}", config.port).parse() {
            Ok(addr) => addr,
            Err(_) => SocketAddr::from(([0, 0, 0, 0], config.port)),
        };
        let listener = match std::net::TcpListener::bind(addr) {
            Ok(l) => l,
            Err(e) => {
                let message = if e.kind() == std::io::ErrorKind::AddrInUse {
                    format!(
                        "port {} is already in use (another program, or another user's GGS Remote)",
                        config.port
                    )
                } else {
                    format!("cannot listen on {addr}: {e}")
                };
                crate::warn!("{message}");
                daemon.listening.store(false, Ordering::Relaxed);
                daemon.tray.send_replace(TrayState::Error(message));
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(30)) => {}
                    _ = daemon.rebind.notified() => {}
                }
                continue;
            }
        };
        let _ = listener.set_nonblocking(true);
        let port = listener
            .local_addr()
            .map(|a| a.port())
            .unwrap_or(config.port);
        daemon.public_port.store(port, Ordering::Relaxed);
        let handle = axum_server::Handle::new();
        let app = crate::http::public_router(daemon.clone())
            .into_make_service_with_connect_info::<SocketAddr>();
        let served = match config.tls.mode {
            TlsMode::None => {
                let server = axum_server::from_tcp(listener).handle(handle.clone());
                started(&daemon, addr, "http");
                tokio::spawn(async move { server.serve(app).await })
            }
            mode => {
                let tls = match load_tls(&daemon, mode).await {
                    Ok(tls) => tls,
                    Err(e) => {
                        crate::warn!("TLS setup failed: {e}");
                        daemon
                            .tray
                            .send_replace(TrayState::Error(format!("TLS: {e}")));
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(30)) => {}
                            _ = daemon.rebind.notified() => {}
                        }
                        continue;
                    }
                };
                let server =
                    axum_server::from_tcp_rustls(listener, tls.clone()).handle(handle.clone());
                started(&daemon, addr, "https");
                let reloader = tokio::spawn(cert_reloader(daemon.clone(), tls, mode));
                tokio::spawn(async move {
                    let result = server.serve(app).await;
                    reloader.abort();
                    result
                })
            }
        };
        daemon.rebind.notified().await;
        crate::info!("rebinding the public listener");
        handle.graceful_shutdown(Some(Duration::from_secs(2)));
        let _ = served.await;
        daemon.listening.store(false, Ordering::Relaxed);
    }
}

fn started(daemon: &Arc<Daemon>, addr: SocketAddr, scheme: &str) {
    crate::info!("public listener on {scheme}://{addr}");
    daemon.listening.store(true, Ordering::Relaxed);
    daemon.tray.send_replace(TrayState::Listening);
    daemon.update_tray();
}

async fn load_tls(daemon: &Arc<Daemon>, mode: TlsMode) -> Result<RustlsConfig, String> {
    match mode {
        TlsMode::Custom => {
            let config = daemon.config();
            let (Some(cert), Some(key)) = (config.tls.cert_path, config.tls.key_path) else {
                return Err("custom TLS needs certPath and keyPath".into());
            };
            RustlsConfig::from_pem_file(cert, key)
                .await
                .map_err(|e| e.to_string())
        }
        _ => {
            let paths = daemon.paths.clone();
            tokio::task::spawn_blocking(move || crate::tls::ensure_server_cert(&paths))
                .await
                .map_err(|e| e.to_string())??;
            *daemon.ca_fingerprint.lock().unwrap() = crate::tls::ca_fingerprint(&daemon.paths);
            let (chain, key) = crate::tls::server_pems(&daemon.paths)?;
            RustlsConfig::from_pem(chain, key)
                .await
                .map_err(|e| e.to_string())
        }
    }
}

/// Every 60 s: re-issue the self-signed server certificate when the LAN addresses changed
/// (or expiry nears) and hot-swap it without dropping connections (§7.5).
async fn cert_reloader(daemon: Arc<Daemon>, tls: RustlsConfig, mode: TlsMode) {
    if mode != TlsMode::SelfSigned {
        return;
    }
    let mut every = tokio::time::interval(Duration::from_secs(60));
    every.tick().await;
    loop {
        every.tick().await;
        let paths = daemon.paths.clone();
        let reissued =
            tokio::task::spawn_blocking(move || crate::tls::ensure_server_cert(&paths)).await;
        if let Ok(Ok(true)) = reissued {
            if let Ok((chain, key)) = crate::tls::server_pems(&daemon.paths) {
                match tls.reload_from_pem(chain, key).await {
                    Ok(()) => crate::info!("server certificate reloaded"),
                    Err(e) => crate::warn!("certificate reload failed: {e}"),
                }
            }
        }
    }
}

async fn housekeeping(daemon: Arc<Daemon>) {
    let mut tick = tokio::time::interval(TICK);
    let mut rounds: u64 = 0;
    loop {
        tick.tick().await;
        rounds += 1;
        let now = Instant::now();
        crate::lifecycle::heartbeat(&daemon, now);
        crate::router::drop_idle_relays(&daemon, now);
        let expired: Vec<_> = daemon
            .conns
            .lock()
            .unwrap()
            .values()
            .filter(|c| c.expired(now))
            .cloned()
            .collect();
        for conn in expired {
            crate::router::end_conn(&daemon, &conn);
        }
        // Signed out, password changed or expired: an offline connection never resumes.
        let dead: Vec<_> = daemon
            .conns
            .lock()
            .unwrap()
            .values()
            .filter(|c| !c.is_live() && !daemon.session_valid(&c.token_hash))
            .cloned()
            .collect();
        for conn in dead {
            crate::router::end_conn(&daemon, &conn);
        }
        crate::lifecycle::idle_exit(&daemon, now);
        if rounds.is_multiple_of(720) {
            retire_if_uninstalled(&daemon);
        }
        if rounds.is_multiple_of(12) {
            daemon.limiter.lock().unwrap().prune(now);
            let epoch = daemon.auth.epoch();
            daemon.sessions.lock().unwrap().prune(epoch);
            // The ggs:// resource tokens follow their sessions out (2026-10-16): a token
            // outlived only by the table entry that forgot it — sessions expire on their
            // own every day, and a tray daemon meant to run for months once kept every
            // dead entry forever.
            daemon
                .resource_tokens
                .lock()
                .unwrap()
                .retain(|_, (hash, _)| daemon.session_valid(hash));
            #[cfg(all(target_os = "linux", target_env = "gnu"))]
            {
                // Hand freed heap back to the OS while idle (§7.9 memory measures).
                extern "C" {
                    fn malloc_trim(pad: usize) -> i32;
                }
                if rounds.is_multiple_of(60) {
                    // SAFETY: glibc's malloc_trim has no preconditions.
                    unsafe {
                        malloc_trim(0);
                    }
                }
            }
        }
        daemon.update_tray();
    }
}

/// The GGS extension was uninstalled (its directory gone for a day): remove the login start
/// and exit, keeping the password and the certificates for a later reinstall (§14.2).
fn retire_if_uninstalled(daemon: &Arc<Daemon>) {
    let now = crate::util::now_secs();
    let retire = {
        let mut config = daemon.config.lock().unwrap();
        let Some(dir) = config.extension_dir.clone() else {
            return;
        };
        if std::path::Path::new(&dir).exists() {
            if config.extension_missing_since.take().is_some() {
                let _ = config.save(&daemon.paths);
            }
            false
        } else {
            let since = *config.extension_missing_since.get_or_insert(now);
            let _ = config.save(&daemon.paths);
            now.saturating_sub(since) >= 24 * 3600
        }
    };
    if retire {
        crate::info!("the GGS Remote extension is gone: removing the login start and exiting");
        let _ = crate::autostart::apply(false);
        daemon.shutdown.notify_one();
    }
}

/// Every registry change becomes a WINDOWS frame on every browser connection — offline ones
/// included, so a resume replays what changed while the phone was away (§6.5).
async fn windows_broadcaster(daemon: Arc<Daemon>) {
    let mut generation = daemon.registry.generation.subscribe();
    while generation.changed().await.is_ok() {
        // Coalesce a burst (a summary update per keystroke-save) into one push.
        tokio::time::sleep(Duration::from_millis(50)).await;
        generation.mark_unchanged();
        let frame = crate::ws::windows_frame(&daemon);
        let conns: Vec<_> = daemon.conns.lock().unwrap().values().cloned().collect();
        for conn in conns {
            conn.push(frame.clone());
        }
    }
}
