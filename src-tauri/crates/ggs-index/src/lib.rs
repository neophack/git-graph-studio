//! ggs-index (L1, modules 4 / 5 / the index of 16): the workspace's text search and
//! replace, the persistent symbol index behind Go-to-Definition and Find References
//! (tree-sitter parsing in `symbols::parse`, the compact on-disk store in
//! `symbols::store`, the per-root databases in `symbols::index`), the folder and byte
//! comparison services, and Quick Open's server-side fuzzy scoring. Every walk reuses
//! ggs-fs's file walk so the excluded-folder policy is one list, not three.
//!
//! Allowed dependencies: ggs-base, ggs-fs, ggs-text (§4.3 of
//! docs/architecture-restructure-plan.md). No tauri — progress reaches the frontend
//! through `ggs_base::sink` (`BatchSink` over the command channel, `EventSink` for the
//! `studio://symbol-index` event); cancellation is the generation-counter pattern.
//! No global mutable state.

pub mod compare;
pub mod fuzzy;
pub mod hexdiff;
pub mod replace;
pub mod scan;
pub mod search;
pub mod symbols;
