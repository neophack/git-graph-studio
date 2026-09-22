//! The reference `ggx/2` process plugin: a self-contained backend binary speaking `ggs-ext/1`
//! over stdin/stdout (`src/ggx_protocol.rs`). It backs the GGX Demo extension
//! `scripts/build-ggx-demo.mjs` packs — the format's worked example, the way VS Code ships a
//! sample extension: `initialize` declares its commands, `runCommand` answers them, and one of
//! them asks the host to open the package's web page. Not part of the app build: like
//! `scripts/build-ggx.mjs`, it exists so the package format has a complete, running reference
//! (and the process-host integration test a partner to talk to).

use git_graph_studio_lib::ggx_protocol::{self as proto, serve_plugin};
use serde_json::{json, Value};

fn main() {
    let pid = std::process::id();
    eprintln!("[ggs-ext-demo] backend starting (pid {pid})");
    // A line before the handshake, to prove the host's $/log channel works.
    println!(
        "{}",
        proto::notification("$/log", json!({ "message": format!("backend started (pid {pid})") }))
    );
    serve_plugin(|method, params| match method {
        "initialize" => Some(Ok(json!({
            "protocolVersion": proto::PROTOCOL_VERSION,
            "capabilities": { "commands": ["ggs.ext-demo.hello", "ggs.ext-demo.openPage"] }
        }))),
        "runCommand" => {
            let command = params.get("command").and_then(Value::as_str).unwrap_or_default();
            let args = params.get("args").cloned().unwrap_or_else(|| json!([]));
            match command {
                "ggs.ext-demo.hello" => Some(Ok(json!({
                    "greeting": format!(
                        "Hello, {}! — from the ggx/2 process backend (pid {pid})",
                        args.get(0).and_then(Value::as_str).unwrap_or("Git Graph Studio")
                    )
                }))),
                "ggs.ext-demo.openPage" => Some(Ok(json!({
                    // The host's page-open convention: a command result naming a page of the
                    // same extension opens it (extHost.ts's runProcessCommand).
                    "openPage": "main",
                    "params": { "openedBy": "command", "pid": pid }
                }))),
                other => Some(Err(format!("unknown command: {other}"))),
            }
        }
        other => Some(Err(format!("unsupported method: {other}"))),
    });
    eprintln!("[ggs-ext-demo] backend stopped");
}
