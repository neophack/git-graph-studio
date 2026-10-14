//! ggs-base (L0, module 0 — shared foundation of every crate): the one place that
//! computes the `~/.ggs` layout (`paths`), the small filesystem helpers every domain
//! reuses (`fsx`), JSONC stripping, the settings store, the workspace-roots type, the
//! cancellation-generation pattern and the event/batch sink traits.
//!
//! Allowed dependencies: serde, serde_json, memchr — nothing else (no threads, no
//! network, no registry). No global mutable state lives in this crate.
//!
//! P2-1 lands the crate skeleton; P2-2 moves the code in
//! (docs/architecture-restructure-plan.md §4.2).
