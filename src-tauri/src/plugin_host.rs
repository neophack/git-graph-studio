//! The graph engine's typed facade over the process extension host (`ext_process.rs`):
//! `cmd_graph.rs`'s always-compiled wrapper functions call through here once the seam is cut
//! (this repository's Stage 5) instead of calling the engine directly, so their signatures and
//! every caller (`cmd_fs.rs`, `cmd_scm.rs`, `lib.rs`, `measure.rs`) need no change — only what
//! those wrappers do internally changes.
//!
//! No `AppHandle` is threaded through: [`ext_process::global`] is the same running-backends
//! handle the Tauri-managed `ProcessHostState` uses (see its doc comment), and
//! `cmd_ext::extensions_home_dir` needs none either (`~/.ggs/extensions`, resolved from the
//! user's home directory, plan Appendix B).
//!
//! The bundled-install race (plan §8.2: "requests made meanwhile wait, bounded, for that first
//! configuration"): `lib.rs`'s boot sequence calls [`note_install_started`] right before
//! spawning the auto-install thread and [`note_install_finished`] when it is done; a call that
//! lands while an install is in flight waits here, bounded, instead of failing outright with
//! "not installed" on a machine's very first launch.

use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

use crate::cmd_ext::{extensions_home_dir, GRAPH_PACKAGE_ID};
use crate::ext_process;

/// How long a call waits for an in-flight bundled install to finish. Mirrors `ext_process.rs`'s
/// own handshake timeout — the two bounds describe the same "backend not up yet" grace period
/// from two sides of the same race.
const INSTALL_WAIT: Duration = Duration::from_secs(10);

struct InstallGate {
    installing: Mutex<bool>,
    done: Condvar,
}

fn gate() -> &'static InstallGate {
    static GATE: OnceLock<InstallGate> = OnceLock::new();
    GATE.get_or_init(|| InstallGate { installing: Mutex::new(false), done: Condvar::new() })
}

/// Call right before spawning the boot-time auto-install of the bundled `git-graph-rs.ggx`
/// (`lib.rs`). A [`request`]/[`close_repos`]/[`hello`] call that lands before
/// [`note_install_finished`] waits instead of failing outright.
pub fn note_install_started() {
    *gate().installing.lock().unwrap() = true;
}

/// Call when that install (and its first backend spawn) has finished, success or failure —
/// wakes every call waiting in [`wait_for_install`].
pub fn note_install_finished() {
    *gate().installing.lock().unwrap() = false;
    gate().done.notify_all();
}

fn wait_for_install() {
    let guard = gate().installing.lock().unwrap();
    if !*guard {
        return;
    }
    let _ = gate().done.wait_timeout_while(guard, INSTALL_WAIT, |installing| *installing);
}

/// One message of the graph view, or a synthetic command from `cmd_fs.rs`/`cmd_scm.rs`/
/// `lib.rs` (`__revisionFile`, `__revisionFileBytes`, `__submoduleRoots`, `__scmChanges`, …) —
/// the single `ggx-rpc/1` `request` verb. `message` and `settings` are opaque to this layer:
/// exactly what the caller wants echoed to the backend's `cmd_graph::engine_impl` dispatch and
/// back.
pub fn request(repo_path: &str, message: Value, settings: Value) -> Result<Value, String> {
    wait_for_install();
    let exts_dir = extensions_home_dir()?;
    ext_process::global().call(
        &exts_dir,
        GRAPH_PACKAGE_ID,
        "request",
        json!({ "repo": repo_path, "message": message, "settings": settings }),
    )
}

/// `closeRepos`: drop every cached repository the backend holds open, and its other
/// process-lifetime caches (the Gerrit cache, the launch warm-up answers) — folder
/// close/switch/teardown calls this (`cmd_graph::close_engine_repos`). Not an error when the
/// backend is not running or not installed: there is nothing warm to close either way.
pub fn close_repos() -> Result<(), String> {
    let exts_dir = extensions_home_dir()?;
    match ext_process::global().call(&exts_dir, GRAPH_PACKAGE_ID, "closeRepos", Value::Null) {
        Ok(_) => Ok(()),
        Err(message) if message.contains("is not installed") || message.contains("declares no backend") => {
            Ok(())
        }
        Err(message) => Err(message),
    }
}

/// The backend's engine-version string, via the `hello` verb (idempotent — the graph
/// backend answers it at spawn and on any later call the same way). Used for
/// `graph_engine_version`'s "which engine is this" report.
pub fn hello() -> Result<Value, String> {
    wait_for_install();
    let exts_dir = extensions_home_dir()?;
    ext_process::global().call(&exts_dir, GRAPH_PACKAGE_ID, "hello", Value::Null)
}
