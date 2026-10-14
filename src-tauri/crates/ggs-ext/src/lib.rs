//! ggs-ext (L1, module 12's engine): the extension store — `.vsix` packages installed
//! under an explicit store directory (`~/.ggs/extensions/{id}-{version}/`, resolved by
//! the app), their runtime `manifest.json` and the backend the install derives from the
//! package itself (`resolve_node_binaries`), the `ggs://` page-serving core with the
//! boot-script composition, the workspace-confined `ext_fs` and the pages' byte services,
//! the frame's code preload, the extension logs, and the Node environment facts.
//!
//! Allowed dependencies: ggs-base, ggs-proto, ggs-git, ggs-testkit (dev; plan §4.3 of
//! docs/architecture-restructure-plan.md). No tauri — the `#[tauri::command]` adapters,
//! the store-directory resolution (the app-data migration, the resource roots, the test
//! pin) and the `HostHooks` installation stay in the app's `cmd_ext.rs` /
//! `ext_process.rs`. Global mutable state: `process::SPAWN_ENV_SOURCES` and
//! `routing`'s routes/journal tables are process-unique (one extension host per
//! process — every app instance constructs its own `ExtHost`); `child`'s registry is
//! the one process-wide child table.
//!
//! Every engine function takes its store directory (or extensions home) explicitly —
//! `ExtStore::at(dir)` is a directory argument, not a singleton (the plan's P3-9).

pub mod child;
pub mod fsapi;
pub mod gallery;
pub mod loadcode;
pub mod log;
pub mod nodeenv;
pub mod page;
pub mod process;
pub mod routing;
pub mod store;
pub mod vsix;

// The test suites that moved with the engine, kept at the crate root so their original
// `use super::*` keeps meaning "the store's whole surface".
#[cfg(test)]
mod ext_asset_tests;
#[cfg(test)]
mod install_tests;
#[cfg(test)]
mod vsix_tests;
/// The git-returning scratch helpers for the byte services' tests — the same extension
/// ggs-git's own tests carry (its testkit_ext); duplicated here because the helpers
/// cannot live in ggs-testkit (a dev-dependency cycle would build two copies of a
/// domain crate).
#[cfg(test)]
pub(crate) mod test_git;

pub use fsapi::{
    confine_to_roots, ext_fs_core, ext_page_file_chunk_core, ext_page_revision_bytes_core,
    ExtFsEntry, ExtPageBytes,
};
pub use loadcode::{load_code_from, ExtCodeBundle};
pub use log::{append_bounded_log, append_host_log, host_log_path, log_extensions};
pub use nodeenv::{node_env, ExtNodeEnv};
pub use page::{compose_page, content_type, ext_not_found, serve_ext_asset_from};
pub use store::{
    bundled_offer, bundled_packages_in, bundled_vsix_packages_in, find_installed,
    host_platform_key, install_from_vsix_into, install_missing_bundled_in, installed_dir,
    list_installed, process_backed_ids, refresh_bundled_installs_in, repair_exec_bits,
    uninstall, BackendDecl, BUNDLED_FORMAT, BundledPackage, ExtInfo, ExtStoragePaths,
    StudioExtMeta, StudioManifest,
};
pub use vsix::{compare_versions, read_vsix_manifest, resolve_node_binaries, safe_join, VsixManifest};

pub use process::{
    add_spawn_env_source, find_node_host_script, find_node_runtime, instance_id, ExtHost,
    HostHooks, ProcessInfo, BACKEND_STATE_EVENT, HOST_REQUEST_EVENT, HOST_STATE_EVENT,
};

/// The real-Node host opt-in (`GGS_REAL_NODE=1`): it decides whether a plain VSIX with
/// the packers' engine layout derives its `.node` itself as the backend (a real Node
/// runtime loads it as the NAPI addon it is) — the install-time half of the policy the
/// app's `ext_process` applies when it spawns. The environment is the policy's single
/// source; this read is pure, no process knowledge.
pub fn real_node_allowed() -> bool {
    std::env::var("GGS_REAL_NODE")
        .map(|value| !value.is_empty() && value != "0")
        .unwrap_or(false)
}
