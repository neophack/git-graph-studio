//! The app crate's integration suites, linked once (docs/ci-speed-plan.md P2): each of
//! these modules was its own test binary, and every one linked the whole lib — five
//! links of the same dependency graph per `cargo test` run, and the MSVC linker is not
//! fast. One binary, one link. Filter a suite with `cargo test --test it <module>::`
//! (e.g. `cargo test --test it node_runtime::`), and run the perf gate measured with
//! `cargo test --release --test it perf -- --nocapture`.
//!
//! The suites gate themselves on the features they need (`#![cfg]` at each module's
//! top): `node_runtime` and `vscode_shim_boa` need the `node-runtime` feature,
//! `remote_control_vectors` the `desktop` one; the rest compile under any feature set.
//! (The ggs-bash CLI suite moved to its own package at P2-8:
//! crates/ggs-bash/tests/cli.rs — one link of the shell, not of the whole app.)

mod node_runtime;
mod perf;
mod remote_control_vectors;
mod vscode_shim_boa;
