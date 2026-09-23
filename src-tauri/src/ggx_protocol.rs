//! The `ggs-ext/1` wire protocol between the process extension host (`ext_process.rs`) and a
//! plugin's backend binary: newline-delimited JSON-RPC 2.0 over the process's stdin/stdout —
//! the same transport shape as the MCP server's stdio mode (module 16), so any language that
//! can write lines to stdout can be a plugin: Rust natively, TypeScript as a `deno compile`
//! binary, Python behind a declared interpreter.
//!
//! The host sends `initialize` and `runCommand` requests and a `shutdown` notification; the
//! plugin answers requests and may send `$/log` notifications. stderr is the plugin's own log
//! channel, captured (capped) by the host. The helpers here are deliberately dependency-light
//! so a plugin's backend (`plugins/ggs-ext-demo/src/main.rs`) can link them without pulling the
//! app in.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

/// The protocol version the host and the plugin agree on in the `initialize` handshake.
pub const PROTOCOL_VERSION: &str = "ggs-ext/1";

/// One line on the wire, either direction. The untagged variants are order-dependent: a
/// request (has `method` and `id`) matches first, a response (only `id`) second, a
/// notification (only `method`) last.
#[derive(Deserialize, Debug, PartialEq)]
#[serde(untagged)]
pub enum Wire {
    Request {
        id: u64,
        method: String,
        #[serde(default)]
        params: Value,
    },
    Response {
        id: u64,
        #[serde(default)]
        result: Option<Value>,
        #[serde(default)]
        error: Option<RpcError>,
    },
    Notification {
        method: String,
        #[serde(default)]
        params: Value,
    },
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

/// A request line, ready to write.
pub fn request(id: u64, method: &str, params: Value) -> String {
    line(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
}

/// A response line for `id`: `Ok` carries the result value, `Err` the message as an error.
pub fn response(id: u64, result: Result<Value, String>) -> String {
    let value = match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(message) => json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": 1, "message": message }
        }),
    };
    line(value)
}

/// A notification line (no id, never answered).
pub fn notification(method: &str, params: Value) -> String {
    line(json!({ "jsonrpc": "2.0", "method": method, "params": params }))
}

fn line(value: Value) -> String {
    format!("{value}\n")
}

/// The plugin side of the protocol: read stdin line by line, answer requests through
/// `handle`, pass notifications through, and return when stdin closes or the host says
/// `shutdown`. `handle` returns `Some(result)` for requests and `None` for notifications.
pub fn serve_plugin<F>(mut handle: F)
where
    F: FnMut(&str, &Value) -> Option<Result<Value, String>>,
{
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(wire) = serde_json::from_str::<Wire>(&line) else {
            continue; // a line we cannot parse is dropped, as the MCP server does
        };
        match wire {
            Wire::Request { id, method, params } => {
                if method == "shutdown" {
                    let _ = writeln!(out, "{}", response(id, Ok(Value::Null)));
                    let _ = out.flush();
                    break;
                }
                if let Some(result) = handle(&method, &params) {
                    let _ = writeln!(out, "{}", response(id, result));
                    let _ = out.flush();
                }
            }
            Wire::Notification { method, params } => {
                if method == "exit" {
                    break;
                }
                handle(&method, &params);
            }
            // The plugin makes no requests in ggs-ext/1, so it never sees a response.
            Wire::Response { .. } => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_line_parses_as_a_request_not_a_response() {
        // A request also syntactically matches the response variant (its `result` is an
        // optional field), so the variant order is what discriminates them.
        let wire: Wire =
            serde_json::from_str(&request(7, "runCommand", json!({ "command": "x" }))).unwrap();
        assert_eq!(
            wire,
            Wire::Request {
                id: 7,
                method: "runCommand".into(),
                params: json!({ "command": "x" })
            }
        );
    }

    #[test]
    fn responses_and_notifications_parse_by_their_fields() {
        let ok: Wire = serde_json::from_str(&response(3, Ok(json!("done")))).unwrap();
        assert_eq!(
            ok,
            Wire::Response {
                id: 3,
                result: Some(json!("done")),
                error: None
            }
        );
        let err: Wire = serde_json::from_str(&response(4, Err("nope".into()))).unwrap();
        assert_eq!(
            err,
            Wire::Response {
                id: 4,
                result: None,
                error: Some(RpcError {
                    code: 1,
                    message: "nope".into()
                })
            }
        );
        let note: Wire =
            serde_json::from_str(&notification("$/log", json!({ "message": "hi" }))).unwrap();
        assert_eq!(
            note,
            Wire::Notification {
                method: "$/log".into(),
                params: json!({ "message": "hi" })
            }
        );
    }

    #[test]
    fn every_builder_emits_one_jsonrpc_line() {
        for text in [
            request(1, "m", Value::Null),
            response(1, Ok(Value::Null)),
            notification("n", Value::Null),
        ] {
            assert!(text.ends_with('\n'));
            assert_eq!(text.matches('\n').count(), 1);
            // serde_json orders a Value's keys, so the member order is not the insertion
            // order — only the version member itself is asserted.
            assert!(text.contains("\"jsonrpc\":\"2.0\""));
        }
    }
}
