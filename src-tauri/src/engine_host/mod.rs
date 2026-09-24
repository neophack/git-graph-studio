//! The generic engine-node host: the app-bundled sidecar that serves **any** VSIX declaring
//! an engine `.node` (`backend: { "kind": "node", … }`) over its C ABI.
//!
//! Nothing of any plugin's protocol lives here — that is the design. One crossing, both
//! ways: a page's `backend.run(command, [message, settings])` becomes the engine call
//! `{method: command, params: message}` (the message's own `repo` field names the
//! repository), and the engine's JSON answer crosses back untouched; the package's own
//! page bridge shapes either end for its view. What stays host-side is only what is true of
//! every such package: the load of the `.node` ([`engine`]), the lifecycle (an engine's
//! warm repository handles are dropped when the workspace changes), and the one generic
//! command convention — the manifest's activity-bar launcher answers `{openPage, params}`
//! for the page it names, the same result convention every backend speaks.
//!
//! Writes are not the host's to make: the engine contract is read-only, and a package that
//! needs git writes serves them from its own code (its `.node`, or a process backend).
//! An unimplemented command answers as an error the page can show — never a silent hole.

use serde_json::{json, Value};

use crate::ext_protocol::{self as proto, serve_plugin, Emitter};

mod engine;

/// The binary's entry: `src/bin/git_graph_backend.rs` is a one-line shell over this.
pub fn run() {
    // Parity with `ggs-ext/1`'s convention (`ext_process.rs`): a backend that keeps
    // per-instance state can tell two concurrently running windows apart. This host keeps
    // none, but the variable is read so a future one can.
    let instance = std::env::var("GGS_INSTANCE_ID").unwrap_or_default();
    eprintln!(
        "[git-graph-backend] starting (pid {}, instance {instance})",
        std::process::id()
    );
    serve_plugin(handle);
    eprintln!("[git-graph-backend] stopped");
}

fn handle(method: &str, params: &Value, _emitter: &Emitter) -> Option<Result<Value, String>> {
    match method {
        // The start handshake carries the app's open folders; the engine's warm handles of
        // the previous workspace are dropped here, and each request opens what it names.
        "initialize" => {
            let _ = engine::engine().and_then(|e| e.request("", "closeAll", Value::Null));
            Some(Ok(json!({
                "protocolVersion": proto::PROTOCOL_VERSION,
                "capabilities": { "commands": launcher_commands() }
            })))
        }
        // The app's report of its open folders (boot, folder open/switch/close) — a
        // notification, never answered.
        "workspaceChanged" => {
            let _ = engine::engine().and_then(|e| e.request("", "closeAll", Value::Null));
            None
        }
        // The one RPC verb: a manifest command from the palette or a menu answers first
        // (the launcher convention); the addon's own single dispatch export crosses
        // positionally exactly as its JS surface spells it; everything else is one message
        // of the package's own protocol, sent by its page as
        // `backend.run(command, [message, settings])` and forwarded to the engine verbatim.
        "runCommand" => {
            let command = params
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let args = params
                .get("args")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if let Some(page) = launcher_page(command) {
                let params = args
                    .first()
                    .cloned()
                    .filter(|v| !v.is_null())
                    .unwrap_or(json!({}));
                return Some(Ok(json!({ "openPage": page, "params": params })));
            }
            // `request(repo, requestJson)`: the frame host's native-module proxy forwards
            // the export's own positional shape, and the answer document crosses back as
            // the RPC result untouched — its in-band `{"error": …}` stays in the answer,
            // the caller's failure branch to read (the same contract `dispatch::request`
            // answers every front end with).
            if command == "request"
                && args.len() == 2
                && args[0].is_string()
                && args[1].is_string()
            {
                let forwarded = engine::engine()
                    .and_then(|engine| {
                        engine.request_raw(
                            args[0].as_str().unwrap_or_default(),
                            args[1].as_str().unwrap_or_default(),
                        )
                    });
                return Some(forwarded);
            }
            Some(Ok(engine_message(command, &args)))
        }
        other => Some(Err(format!("unsupported method: {other}"))),
    }
}

/// One package-protocol message through to the engine: the command is the method, the
/// message is the parameters, its `repo` field names the repository, and the engine's
/// answer rides back as the RPC result. A failure — the repository cannot be opened, the
/// method is not one the engine serves — is the message-shaped error the page shows.
fn engine_message(command: &str, args: &[Value]) -> Value {
    let Ok(engine) = engine::engine() else {
        return error_answer(command, "the engine is not available");
    };
    let message = args.first().cloned().unwrap_or(Value::Null);
    let repo = message
        .get("repo")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    match engine.request(&repo, command, message) {
        Ok(answer) => answer,
        Err(error) => error_answer(command, &error),
    }
}

/// The message-shaped failure: both `error` and `errors`, the way the wire answers, so a
/// page's failure branch is one shape whatever went wrong.
fn error_answer(command: &str, message: &str) -> Value {
    json!({ "command": command, "error": message, "errors": [message] })
}

/* ---------- The manifest's own launcher (the one command convention every host speaks) ---------- */

/// The activity-bar launcher the package's manifest declares, read from the installed
/// package beside its engine `.node`: `(command, page)` — a click on the launcher runs the
/// command, and the host answers `openPage` for the page the manifest names. A package
/// without a launcher (or whose manifest cannot be read) simply has no launcher command.
fn launcher() -> Option<(String, String)> {
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(engine::package_root()?.join("manifest.json")).ok()?,
    )
    .ok()?;
    let launcher = manifest.get("activitybar")?;
    Some((
        launcher.get("command")?.as_str()?.to_owned(),
        launcher.get("page")?.as_str()?.to_owned(),
    ))
}

fn launcher_commands() -> Vec<String> {
    launcher()
        .map(|(command, _)| vec![command])
        .unwrap_or_default()
}

fn launcher_page(command: &str) -> Option<String> {
    launcher().and_then(|(declared, page)| (declared == command).then_some(page))
}
