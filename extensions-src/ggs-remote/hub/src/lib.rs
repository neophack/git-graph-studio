//! ggs-remote-hub — the self-hosted, account-free relay (docs/ggs-remote-plan.md §20): no
//! database, no admin backend, nothing to back up. Each PC's daemon keeps an outbound tunnel
//! open and proves the uuid its public key derives to; the Hub forwards `/u/<uuid>/…` between
//! the browser and that tunnel. The daemon (a different crate) holds the matching half of
//! every message this one defines — field names are the contract, the vectors in
//! `../daemon/tests/vectors/` hold both to it.

pub mod audit;
pub mod blocklist;
pub mod cache;
pub mod config;
pub mod frame;
pub mod front;
pub mod gate;
pub mod http_proxy;
pub mod identity;
pub mod msg;
pub mod state;
pub mod tunnel;
pub mod util;
pub mod ws_bridge;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::routing::get;
use axum::Router;

use crate::config::Config;
use crate::state::Hub;

/// The routes behind the gate (§20.5): the browser entry and the PC tunnel. Nothing else —
/// a path that falls out of this router is not a `/u/<uuid>/…` request and never reaches
/// it: the [`gate`] wraps this stack and answers such requests with silence (the connection
/// closes without a byte, as if the port was not open). The `/u/<uuid>` and `/u/<uuid>/`
/// spellings are registered apart from the catch-all because `{*rest}` does not match an
/// empty rest: without them the canonical link (the trailing slash) fell out of the router
/// entirely.
pub fn router(hub: Arc<Hub>) -> Router {
    Router::new()
        .route(
            "/u/{uuid}",
            get(front::entry_root)
                .post(front::entry_root)
                .put(front::entry_root)
                .delete(front::entry_root)
                .patch(front::entry_root)
                .head(front::entry_root),
        )
        .route(
            "/u/{uuid}/",
            get(front::entry_root)
                .post(front::entry_root)
                .put(front::entry_root)
                .delete(front::entry_root)
                .patch(front::entry_root)
                .head(front::entry_root),
        )
        .route(
            "/u/{uuid}/{*rest}",
            get(front::entry)
                .post(front::entry)
                .put(front::entry)
                .delete(front::entry)
                .patch(front::entry)
                .head(front::entry),
        )
        .route("/tunnel", get(tunnel::tunnel_handler))
        .with_state(hub)
}

/// The public serving stack (§20.5): the router behind the silence gate — `/u/<uuid>/…`
/// (and the PCs' `/tunnel` WebSocket handshakes) is everything this port ever answers;
/// every other request closes the connection without a byte. `serve` runs this, and the
/// tunnel suite runs the same stack, so the tested Hub is the shipped one.
pub fn gated(hub: Arc<Hub>) -> gate::GateListener {
    gate::GateListener::new(router_with_ceiling(hub))
}

/// Bind the main listener (TLS per config) and serve until stopped.
/// The request-work ceiling: generous for a personal relay, fatal to a flood.
static REQUESTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1024);

/// The router with the ceiling applied (audit M-2, 2026-10-13): a bound on request work
/// in flight — slowloris headers are killed by the header-read timeout, and this keeps a
/// flood of otherwise-valid requests from holding unbounded memory at once. Above the
/// ceiling a request waits, it is never dropped silently.
fn router_with_ceiling(hub: Arc<Hub>) -> Router {
    router(hub).layer(axum::middleware::from_fn(
        |request: axum::extract::Request, next: axum::middleware::Next| async move {
            let _permit = REQUESTS.acquire().await;
            if _permit.is_err() {
                return Err(axum::http::StatusCode::SERVICE_UNAVAILABLE);
            }
            let _permit = _permit.expect("checked above");
            Ok::<_, axum::http::StatusCode>(next.run(request).await)
        },
    ))
}

pub async fn serve(
    config: Config,
    shutdown: tokio::sync::oneshot::Receiver<()>,
) -> std::io::Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let hub = Hub::new(config.clone());
    let addr: SocketAddr = config
        .listen
        .parse()
        .unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], 8443)));
    let app = gated(hub.clone());

    // The operator's kill switch refreshes (§20.6): edit the blocklist, and within half a
    // minute the listed PCs are off the air and cannot handshake back in. Nothing to do
    // when no blocklist is configured.
    if hub.blocklist.enabled() {
        let refresher = hub.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                tick.tick().await;
                refresher.enforce_blocklist();
            }
        });
    }

    if !config.metrics_listen.is_empty() {
        // The operator's corners (§20.5) — the public port stays silent outside the links,
        // so liveness and metrics live on this deliberately bound listener only.
        let metrics = Router::new()
            .route("/metrics", get(front::metrics))
            .route("/healthz", get(front::healthz))
            .with_state(hub.clone());
        if let Ok(bind) = config.metrics_listen.parse::<SocketAddr>() {
            if let Ok(listener) = tokio::net::TcpListener::bind(bind).await {
                crate::info!("metrics and healthz on http://{bind}/");
                tokio::spawn(async move {
                    let app = metrics.into_make_service();
                    if let Err(e) = axum::serve(listener, app).await {
                        crate::warn!("metrics listener stopped: {e}");
                    }
                });
            } else {
                crate::warn!("cannot bind metrics on {}", config.metrics_listen);
            }
        }
    }

    // The empty join_key is the documented open relay (§20.6) — on a public bind it deserves
    // a loud line in the log, not a silent default (audit M-1, 2026-10-13).
    if config.join_key.is_empty() && !addr.ip().is_loopback() {
        crate::warn!(
            "join_key is empty and the listener is public: ANY GGS Remote can join this relay — set join_key in the config"
        );
    }

    let listener = std::net::TcpListener::bind(addr)?;
    crate::info!("ggs-remote-hub on {}", listener.local_addr()?);
    match config.tls.mode {
        config::TlsMode::None => {
            let mut server = axum_server::from_tcp(listener);
            server
                .http_builder()
                .http1()
                .header_read_timeout(std::time::Duration::from_secs(30));
            let handle = axum_server::Handle::new();
            let served = server.handle(handle.clone()).serve(app);
            tokio::select! {
                result = served => result?,
                _ = shutdown => handle.graceful_shutdown(Some(std::time::Duration::from_secs(3))),
            }
        }
        mode => {
            let (Some(cert), Some(key)) = (config.tls.cert.clone(), config.tls.key.clone()) else {
                return Err(std::io::Error::other("tls mode needs cert and key"));
            };
            let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key)
                .await
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            let _ = mode;
            let mut server = axum_server::from_tcp_rustls(listener, tls);
            server
                .http_builder()
                .http1()
                .header_read_timeout(std::time::Duration::from_secs(30));
            let handle = axum_server::Handle::new();
            let served = server.handle(handle.clone()).serve(app);
            tokio::select! {
                result = served => result?,
                _ = shutdown => handle.graceful_shutdown(Some(std::time::Duration::from_secs(3))),
            }
        }
    }
    Ok(())
}
