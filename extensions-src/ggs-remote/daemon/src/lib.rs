//! GGS Remote, the daemon (docs/ggs-remote-plan.md §7): a tray-resident process that serves a
//! PC's Git Graph Studio windows to a phone or another computer — one link, one password,
//! `ggs-remote/1` frames over a binary WebSocket. The library holds everything; `main.rs` is
//! the CLI and the tray loop around it, and the integration tests drive the library.

pub mod auth;
pub mod autostart;
pub mod cache;
pub mod client;
pub mod config;
pub mod control;
pub mod control_msg;
pub mod desk;
pub mod e2e;
pub mod http;
pub mod hub;
pub mod lifecycle;
pub mod log;
pub mod paths;
pub mod ratelimit;
pub mod recent;
pub mod registry;
pub mod relay_link;
pub mod router;
pub mod sandbox;
pub mod server;
pub mod session;
pub mod spawn;
pub mod state;
pub mod tls;
#[cfg(feature = "tray")]
pub mod tray;
pub mod util;
pub mod web;
pub mod ws;
