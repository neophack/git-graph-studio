//! ggs-remote-hub — the self-hosted, account-free relay (docs/ggs-remote-plan.md §20): no
//! database, no admin backend, nothing to back up. Each PC's daemon keeps an outbound tunnel
//! open and proves the uuid its public key derives to; the Hub forwards `/u/<uuid>/…` between
//! the browser and that tunnel. The daemon (a different crate) holds the matching half of
//! every message this one defines — field names are the contract, the vectors in
//! `../daemon/tests/vectors/` hold both to it.

pub mod cache;
pub mod config;
pub mod frame;
pub mod front;
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

/// The whole surface (§20.5): the browser entry, the PC tunnel, the operator's corners.
/// Everything else is 404 — the same shape an unknown path has. The `/u/<uuid>` and
/// `/u/<uuid>/` spellings are registered apart from the catch-all because `{*rest}` does
/// not match an empty rest: without them the canonical link (the trailing slash) fell out
/// of the router entirely.
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
        .route("/healthz", get(front::healthz))
        .route("/", get(front::landing))
        .with_state(hub)
}

/// Bind the main listener (TLS per config) and serve until stopped.
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
    let app = router(hub.clone()).into_make_service_with_connect_info::<SocketAddr>();

    if !config.metrics_listen.is_empty() {
        let metrics = Router::new()
            .route("/metrics", get(front::metrics))
            .with_state(hub.clone());
        if let Ok(bind) = config.metrics_listen.parse::<SocketAddr>() {
            if let Ok(listener) = tokio::net::TcpListener::bind(bind).await {
                crate::info!("metrics on http://{bind}/metrics");
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

    let listener = std::net::TcpListener::bind(addr)?;
    crate::info!("ggs-remote-hub on {}", listener.local_addr()?);
    match config.tls.mode {
        config::TlsMode::None => {
            let server = axum_server::from_tcp(listener);
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
            let server = axum_server::from_tcp_rustls(listener, tls);
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
