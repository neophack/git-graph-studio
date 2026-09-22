//! The GGX Demo plugin's backend — the `ggx/2` package format's worked example, kept small
//! enough to read in one sitting and complete enough to copy from. Everything a command-style
//! process backend can do happens here once: the `initialize` handshake that declares the
//! command list, `runCommand` answers (JSON in, JSON out), state that survives between calls
//! (the process is warm), an error result (the failure path), `$/log` notifications (the
//! backend's log channel, shown in the Extensions view's backend status), and the `openPage`
//! result convention — the way a command surfaces UI.
//!
//! The protocol itself is `ggs-ext/1` (`src/ggx_protocol.rs` in the app's crate): one
//! newline-delimited JSON-RPC 2.0 line per message over stdin/stdout, one request answered at
//! a time. `serve_plugin` runs the loop; this file only decides what the messages mean. A
//! backend in any language looks exactly like this minus the Rust — write lines to stdout.
//!
//! The plugin's README.md is the authoring guide this code illustrates; read it first.

use std::time::{Instant, SystemTime, UNIX_EPOCH};

use git_graph_studio_lib::ggx_protocol::{self as proto, serve_plugin};
use serde_json::{json, Value};

/// Every command this backend answers, in `package.json`'s declared order — the same list the
/// `initialize` handshake returns as its capability, so the workbench palette (which reads
/// package.json) and the backend (which answers `runCommand`) can never drift apart.
const COMMANDS: [&str; 7] = [
	"ggs.ext-demo.openPage",
	"ggs.ext-demo.hello",
	"ggs.ext-demo.echo",
	"ggs.ext-demo.tick",
	"ggs.ext-demo.stats",
	"ggs.ext-demo.fail",
	"ggs.ext-demo.openParams",
];

/// Milliseconds since the unix epoch — the timestamp format the demo's pages render with
/// `new Date(...)`; the backend deliberately carries no time-formatting dependency.
fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|d| d.as_millis() as u64)
		.unwrap_or(0)
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
		proto::notification("$/log", json!({ "message": format!("backend started (pid {pid}, instance {instance})") }))
	);

	// The state a warm backend keeps between calls — the whole point of a process backend:
	// `tick` proves the process survives from one command to the next.
	let started = Instant::now();
	let mut ticks: u64 = 0;

	serve_plugin(move |method, params| match method {
		// The handshake: the host sends `initialize` right after spawning (with the
		// extension's id and install path in `params`), and expects the protocol version
		// plus the command list back within ten seconds.
		"initialize" => {
			println!(
				"{}",
				proto::notification("$/log", json!({ "message": format!("serving {} commands for {}", COMMANDS.len(), params.get("extensionId").and_then(Value::as_str).unwrap_or("?")) }))
			);
			Some(Ok(json!({
				"protocolVersion": proto::PROTOCOL_VERSION,
				"capabilities": { "commands": COMMANDS }
			})))
		}
		// The one RPC verb: a command id plus its arguments (whatever the caller passed —
		// the palette sends an empty list, a page's `backend.run` sends what it likes).
		"runCommand" => {
			let command = params.get("command").and_then(Value::as_str).unwrap_or_default();
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
				"ggs.ext-demo.openParams" => Some(Ok(json!({
					"openPage": "params",
					"params": { "openedBy": "command", "note": args.get(0).cloned().unwrap_or(json!("opened from the command palette")) }
				}))),
				// Arguments travel as a JSON array; the result is any JSON value.
				"ggs.ext-demo.hello" => Some(Ok(json!({
					"greeting": format!(
						"Hello, {}! — from the ggx/2 process backend (pid {pid})",
						args.get(0).and_then(Value::as_str).unwrap_or("Git Graph Studio")
					)
				}))),
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
					let message = args.get(0).and_then(Value::as_str).unwrap_or("the demo fails on purpose");
					println!("{}", proto::notification("$/log", json!({ "message": format!("failing on request: {message}") })));
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
