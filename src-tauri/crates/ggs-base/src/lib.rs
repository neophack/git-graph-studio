//! ggs-base (L0): the shared foundation of every crate — the one place that computes the
//! `~/.ggs` layout (`paths`), the small filesystem helpers every domain reuses (`fsx`),
//! JSONC stripping (`jsonc`), repository-root discovery (`workspace`), the
//! cancellation-generation pattern (`cancel`) and the event/batch sink traits (`sink`)
//! that let domain crates push to a frontend without naming tauri.
//!
//! Allowed dependencies: serde, serde_json, memchr — nothing else (no thread pools, no
//! network, no platform registry). No global mutable state lives in this crate.
//!
//! Module map: the base layer beneath every numbered module
//! (docs/architecture-restructure-plan.md §4.2).

pub mod cancel;
pub mod fsx;
pub mod jsonc;
pub mod paths;
pub mod sink;
pub mod workspace;
