//! The GGX Demo plugin's backend — the `ggx/2` package format's worked example, kept small
//! enough to read in one sitting and complete enough to copy from. Everything a command-style
//! process backend can do happens here once: the `initialize` handshake that declares the
//! command list, `runCommand` answers (JSON in, JSON out), state that survives between calls
//! (the process is warm), an error result (the failure path), `$/log` notifications (the
//! backend's log channel, shown in the Extensions view's backend status), and the `openPage`
//! result convention — the way a command surfaces UI (`ggs.ext-demo.hello` opens the Files
//! page with the package's own file inventory; a plain result carries no UI, so a command
//! that wants to be seen must open a page, notify or log).
//!
//! The protocol itself is `ggs-ext/1` (`src/ggx_protocol.rs` in the app's crate): one
//! newline-delimited JSON-RPC 2.0 line per message over stdin/stdout, one request answered at
//! a time. `serve_plugin` runs the loop; this file only decides what the messages mean. A
//! backend in any language looks exactly like this minus the Rust — write lines to stdout.
//!
//! The plugin's README.md is the authoring guide this code illustrates; read it first.

use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use git_graph_studio_lib::ggx_protocol::{self as proto, serve_plugin};
use serde_json::{json, Value};

/// Every command this backend answers, in `package.json`'s declared order — the same list the
/// `initialize` handshake returns as its capability, so the workbench palette (which reads
/// package.json) and the backend (which answers `runCommand`) can never drift apart.
const COMMANDS: [&str; 8] = [
    "ggs.ext-demo.openPage",
    "ggs.ext-demo.hello",
    "ggs.ext-demo.echo",
    "ggs.ext-demo.tick",
    "ggs.ext-demo.stats",
    "ggs.ext-demo.fail",
    "ggs.ext-demo.openParams",
    "ggs.ext-demo.fileDetails",
];

/// Milliseconds since the unix epoch — the timestamp format the demo's pages render with
/// `new Date(...)`; the backend deliberately carries no time-formatting dependency.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The package's own file inventory — what the Files page renders: every file under the
/// install root as `(relative path, size in bytes, last-modified time)`, sorted by path.
/// The `initialize` handshake names the root; a backend started some other way (no
/// handshake, e.g. run by hand) simply reports nothing. A package is a handful of files,
/// so the walk needs no depth bound.
fn file_inventory(root: Option<&Path>) -> Vec<Value> {
    let Some(root) = root else { return Vec::new() };
    let mut rows: Vec<(String, u64, u64)> = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|span| span.as_millis() as u64)
                .unwrap_or(0);
            rows.push((
                path.strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/"),
                meta.len(),
                modified_ms,
            ));
        }
    }
    rows.sort();
    rows.into_iter()
		.map(|(path, bytes, modified_ms)| json!({ "path": path, "bytes": bytes, "modifiedMs": modified_ms }))
		.collect()
}

/// A filesystem timestamp as milliseconds since the unix epoch, or null where the platform
/// (or the filesystem) does not record it — creation time is the usual gap on Linux.
fn time_ms(time: std::io::Result<SystemTime>) -> Value {
    time.ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|span| json!(span.as_millis() as u64))
        .unwrap_or(Value::Null)
}

/// The paths a context-menu command was handed, in order and without repeats. The workbench
/// passes VS Code's pair: the clicked path, then every selected path — the selection wins
/// when it is there (it includes the clicked one); the clicked path alone otherwise (the
/// palette passes nothing at all).
fn menu_paths(args: &Value) -> Vec<String> {
    let selected: Vec<String> = args
        .get(1)
        .and_then(Value::as_array)
        .map(|paths| {
            paths
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let mut paths = if selected.is_empty() {
        args.get(0)
            .and_then(Value::as_str)
            .map(|path| vec![path.to_owned()])
            .unwrap_or_default()
    } else {
        selected
    };
    let mut seen = std::collections::HashSet::new();
    paths.retain(|path| seen.insert(path.clone()));
    paths
}

/// One path's details for the Files page: what it is, its size, its timestamps and its
/// attributes — straight from the filesystem's metadata. A path that cannot be read reports
/// its error instead (it may have been deleted since the menu opened).
fn file_details(path: &str) -> Value {
    let target = Path::new(path);
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_owned());
    let base = json!({
        "path": path,
        "name": name,
        "folder": target.parent().map(|parent| parent.to_string_lossy().into_owned()),
    });
    let link = std::fs::symlink_metadata(target).map(|meta| meta.file_type().is_symlink());
    let meta = match std::fs::metadata(target) {
        Ok(meta) => meta,
        Err(error) => {
            let mut failed = base;
            failed["error"] = json!(error.to_string());
            return failed;
        }
    };
    let kind = if meta.is_dir() { "folder" } else { "file" };
    // A folder's size is its direct entries' count (the demo does not walk subtrees).
    let entries = if meta.is_dir() {
        std::fs::read_dir(target).ok().map(|dir| dir.count())
    } else {
        None
    };
    let mut details = base;
    details["kind"] = json!(kind);
    details["symlink"] = json!(link.unwrap_or(false));
    details["extension"] = json!(if meta.is_dir() {
        None
    } else {
        target
            .extension()
            .map(|ext| ext.to_string_lossy().into_owned())
    });
    details["bytes"] = json!(if meta.is_dir() {
        None
    } else {
        Some(meta.len())
    });
    details["entries"] = json!(entries);
    details["createdMs"] = time_ms(meta.created());
    details["modifiedMs"] = time_ms(meta.modified());
    details["accessedMs"] = time_ms(meta.accessed());
    details["readonly"] = json!(meta.permissions().readonly());
    details
}

fn main() {
    let pid = std::process::id();
    // Which app instance owns us: every backend a window spawns is told through this
    // environment variable, so a plugin with per-instance state can tell two concurrently
    // running windows apart (`ext_process.rs` sets it on spawn).
    let instance = std::env::var("GGS_INSTANCE_ID").unwrap_or_else(|_| "unknown".to_owned());
    eprintln!("[ggs-ext-demo] backend starting (pid {pid}, instance {instance})");
    // A notification before the handshake: `$/log` lines are the backend's log channel —
    // the host records them (capped) and the Extensions view shows them in the backend
    // status. stderr is the same idea, prefixed `stderr:` by the host.
    println!(
        "{}",
        proto::notification(
            "$/log",
            json!({ "message": format!("backend started (pid {pid}, instance {instance})") })
        )
    );

    // The state a warm backend keeps between calls — the whole point of a process backend:
    // `tick` proves the process survives from one command to the next.
    let started = Instant::now();
    let mut ticks: u64 = 0;
    // The install directory the `initialize` handshake hands over — the root the Files
    // page's inventory walks. None until the host speaks (or forever, run by hand).
    let mut install_root: Option<PathBuf> = None;

    serve_plugin(move |method, params| match method {
        // The handshake: the host sends `initialize` right after spawning (with the
        // extension's id and install path in `params`), and expects the protocol version
        // plus the command list back within ten seconds.
        "initialize" => {
            install_root = params
                .get("extensionPath")
                .and_then(Value::as_str)
                .map(PathBuf::from);
            println!(
                "{}",
                proto::notification(
                    "$/log",
                    json!({ "message": format!("serving {} commands for {}", COMMANDS.len(), params.get("extensionId").and_then(Value::as_str).unwrap_or("?")) })
                )
            );
            Some(Ok(json!({
                "protocolVersion": proto::PROTOCOL_VERSION,
                "capabilities": { "commands": COMMANDS }
            })))
        }
        // The one RPC verb: a command id plus its arguments (whatever the caller passed —
        // the palette sends an empty list, a page's `backend.run` sends what it likes).
        "runCommand" => {
            let command = params
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let args = params.get("args").cloned().unwrap_or_else(|| json!([]));
            match command {
                // The openPage convention: a result object naming one of the package's own
                // pages opens it in an editor tab, with `params` handed to the page's
                // context — a backend's way of surfacing UI, like a VS Code command that
                // shows a webview panel.
                "ggs.ext-demo.openPage" => Some(Ok(json!({
                    "openPage": "main",
                    "params": { "openedBy": "command", "pid": pid }
                }))),
                // The context-menu command: the workbench hands it the clicked file and the
                // whole Explorer selection (VS Code's `(uri, uris)` pair, as paths), and it
                // opens the Files page with each path's details — one file or many.
                "ggs.ext-demo.fileDetails" => {
                    let paths = menu_paths(&args);
                    if paths.is_empty() {
                        return Some(Err(
                            "ggs.ext-demo.fileDetails: run it from a file's context menu (Explorer or editor)".to_owned(),
                        ));
                    }
                    let details: Vec<Value> = paths.iter().map(|path| file_details(path)).collect();
                    // The tab is named after what it shows (the result's optional `title`).
                    let title = match details.as_slice() {
                        [one] => format!(
                            "File Details — {}",
                            one["name"].as_str().unwrap_or_default()
                        ),
                        many => format!("File Details — {} items", many.len()),
                    };
                    Some(Ok(json!({
                        "openPage": "files",
                        "title": title,
                        "params": { "details": details, "at": now_ms() }
                    })))
                }
                "ggs.ext-demo.openParams" => Some(Ok(json!({
                    "openPage": "params",
                    "params": { "openedBy": "command", "note": args.get(0).cloned().unwrap_or(json!("opened from the command palette")) }
                }))),
                // The greeting this command has always answered, delivered the visible way:
                // the page-open convention carrying live data. `hello` runs from the
                // palette and the context menus, where a plain result is discarded by the
                // host (only a page, a notification or a log is visible) — so it opens the
                // Files page, which renders the greeting plus the package's own file
                // inventory. From a page's `backend.run` the same result is simply the
                // answer, and the page decides what to do with it.
                "ggs.ext-demo.hello" => {
                    let name = args
                        .get(0)
                        .and_then(Value::as_str)
                        .unwrap_or("Git Graph Studio");
                    Some(Ok(json!({
                        "openPage": "files",
                        "params": {
                            "greeting": format!("Hello, {name}! — from the ggx/2 process backend (pid {pid})"),
                            "root": install_root.as_ref().and_then(|path| path.to_str()),
                            "files": file_inventory(install_root.as_deref())
                        }
                    })))
                }
                // Arbitrary JSON round-trips: the page sends an object, the backend sends
                // one back — the whole serialization story in one command.
                "ggs.ext-demo.echo" => Some(Ok(json!({
                    "echo": args.get(0).cloned().unwrap_or(Value::Null),
                    "at": now_ms()
                }))),
                // Warm state: each call increments and returns the counter.
                "ggs.ext-demo.tick" => {
                    ticks += 1;
                    Some(Ok(json!({ "count": ticks, "at": now_ms() })))
                }
                // Backend introspection: what the Extensions view's status line knows, and
                // a little more (uptime, the owning window, the commands served).
                "ggs.ext-demo.stats" => Some(Ok(json!({
                    "pid": pid,
                    "instanceId": instance,
                    "uptimeMs": started.elapsed().as_millis() as u64,
                    "ticks": ticks,
                    "commands": COMMANDS,
                    "protocolVersion": proto::PROTOCOL_VERSION
                }))),
                // The failure path: `Err` becomes a JSON-RPC error response, the host
                // surfaces its message verbatim (an error notification from the palette,
                // a rejected promise in a page's `backend.run`).
                "ggs.ext-demo.fail" => {
                    let message = args
                        .get(0)
                        .and_then(Value::as_str)
                        .unwrap_or("the demo fails on purpose");
                    println!(
                        "{}",
                        proto::notification(
                            "$/log",
                            json!({ "message": format!("failing on request: {message}") })
                        )
                    );
                    Some(Err(format!("ggs.ext-demo.fail: {message}")))
                }
                other => Some(Err(format!("unknown command: {other}"))),
            }
        }
        // `shutdown` (the host's goodbye before it kills the process) and `exit` are handled
        // by `serve_plugin` itself; anything else from the host is a protocol we do not know.
        other => Some(Err(format!("unsupported method: {other}"))),
    });
    eprintln!("[ggs-ext-demo] backend stopped");
}
