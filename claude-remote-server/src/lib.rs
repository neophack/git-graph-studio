//! The Claude Remote relay as a library: the binary (`main.rs`) is a thin CLI over it,
//! and the integration tests drive the same `App` over real sockets.

pub mod api;
pub mod config;
pub mod guard;
pub mod hub;
pub mod store;
