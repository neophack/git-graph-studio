//! The `ggs-ext/1` wire protocol between the process extension host (`ext_process.rs`) and a
//! plugin's backend binary: newline-delimited JSON-RPC 2.0 over the process's stdin/stdout —
//! the same transport shape as the MCP server's stdio mode (module 16), so any language that
//! can write lines to stdout can be a plugin: Rust natively, TypeScript as a `deno compile`
//! binary, Python behind a declared interpreter.
//!
//! The host sends `initialize` and `runCommand` requests and a `shutdown` notification; the
//! plugin answers requests and may send `$/log` notifications. stderr is the plugin's own log
//! channel, captured (capped) by the host. Requests are dispatched the moment they are read,
//! each onto its own thread — a backend that answers bursts of concurrent reads (the git-graph
//! engine's opening fan) is never serialized behind a slow one, and a command-style plugin is
//! free to ignore the freedom. The helpers here are deliberately dependency-light so a
//! plugin's backend (`plugins/ggs-ext-demo/src/main.rs`) can link them without pulling the
//! app in.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

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

/// The plugin side's push channel: an `Emitter` hands a handler a thread-safe way to write
/// notification lines (`$/log` and friends) while requests are being answered on other
/// threads — writing stdout directly from a handler would race the loop's own responses.
pub struct Emitter {
    out: Arc<Mutex<dyn Write + Send>>,
}

impl Emitter {
    /// Write one notification line. Best-effort: a broken pipe is swallowed (the loop is
    /// dying anyway, and a log line must never fail a request).
    pub fn notification(&self, method: &str, params: Value) {
        let mut out = self.out.lock().unwrap();
        let _ = out.write_all(notification(method, params).as_bytes());
        let _ = out.flush();
    }
}

/// The plugin side of the protocol: read stdin line by line, dispatch every request onto its
/// own thread (`handle` must be safe to call from multiple threads at once), pass
/// notifications through, and return when stdin closes or the host says `shutdown` — after
/// every spawned thread has finished, so no response is lost. `handle` returns `Some(result)`
/// for requests and `None` for notifications; the `Emitter` is for notifications a handler
/// sends from inside a request.
pub fn serve_plugin<F>(handle: F)
where
    F: Fn(&str, &Value, &Emitter) -> Option<Result<Value, String>> + Send + Sync + 'static,
{
    serve_plugin_on(
        std::io::BufReader::new(std::io::stdin()),
        std::io::stdout(),
        handle,
    );
}

/// The testable core of [`serve_plugin`], over an arbitrary reader/writer pair.
pub fn serve_plugin_on<R, W, F>(reader: R, writer: W, handle: F)
where
    R: BufRead,
    W: Write + Send + 'static,
    F: Fn(&str, &Value, &Emitter) -> Option<Result<Value, String>> + Send + Sync + 'static,
{
    let handle = Arc::new(handle);
    let out: Arc<Mutex<dyn Write + Send>> = Arc::new(Mutex::new(writer));
    let emitter = Emitter {
        out: Arc::clone(&out),
    };
    let mut threads = Vec::new();
    for line in reader.lines() {
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
                    write_response(&out, id, Ok(Value::Null));
                    break;
                }
                let handle = Arc::clone(&handle);
                let out = Arc::clone(&out);
                threads.push(std::thread::spawn(move || {
                    if let Some(result) = handle(
                        &method,
                        &params,
                        &Emitter {
                            out: Arc::clone(&out),
                        },
                    ) {
                        write_response(&out, id, result);
                    }
                }));
            }
            Wire::Notification { method, params } => {
                if method == "exit" {
                    break;
                }
                handle(&method, &params, &emitter);
            }
            // The plugin makes no requests in ggs-ext/1, so it never sees a response.
            Wire::Response { .. } => {}
        }
    }
    for thread in threads {
        let _ = thread.join();
    }
}

fn write_response(out: &Arc<Mutex<dyn Write + Send>>, id: u64, result: Result<Value, String>) {
    let mut out = out.lock().unwrap();
    let _ = out.write_all(response(id, result).as_bytes());
    let _ = out.flush();
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

    #[derive(Clone)]
    struct SharedBuf(Arc<Mutex<Vec<u8>>>);
    impl Write for SharedBuf {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn concurrent_requests_answer_out_of_order_when_one_is_slow() {
        // The graph engine's opening fan depends on this: a slow read must never serialize
        // the requests queued behind it.
        let buf = Arc::new(Mutex::new(Vec::new()));
        let input = format!(
            "{}{}",
            request(1, "runCommand", json!({ "command": "slow" })),
            request(2, "runCommand", json!({ "command": "fast" })),
        );
        serve_plugin_on(
            std::io::Cursor::new(input.into_bytes()),
            SharedBuf(Arc::clone(&buf)),
            |_method, params, _emitter| {
                if params["command"] == "slow" {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
                Some(Ok(params["command"].clone()))
            },
        );
        let output = String::from_utf8(buf.lock().unwrap().clone()).unwrap();
        let lines: Vec<&str> = output.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 2, "{lines:?}");
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(
            first["result"], "fast",
            "the fast request should answer first: {lines:?}"
        );
    }

    #[test]
    fn a_handler_can_push_notifications_while_requests_are_in_flight() {
        let buf = Arc::new(Mutex::new(Vec::new()));
        serve_plugin_on(
            std::io::Cursor::new(request(1, "runCommand", Value::Null).into_bytes()),
            SharedBuf(Arc::clone(&buf)),
            |_method, _params, emitter| {
                emitter.notification("$/log", json!({ "message": "working" }));
                Some(Ok(Value::Null))
            },
        );
        let output = String::from_utf8(buf.lock().unwrap().clone()).unwrap();
        let lines: Vec<&str> = output.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines[0].contains("$/log"), "{lines:?}");
    }
}
