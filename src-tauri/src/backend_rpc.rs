//! The `ggx-rpc/1` wire protocol between the graph-engine host facade (`plugin_host.rs`) and
//! the `git-graph-backend` binary: newline-delimited JSON over stdin/stdout. Deliberately a
//! separate protocol from the general-purpose `ggs-ext/1` (`ggx_protocol.rs`): the graph view
//! fires bursts of concurrent reads on open (`graphHost.ts`: "Reads run concurrently... costs
//! one backend round trip, not their sum"), but `ggs-ext/1`'s reference plugin loop
//! (`serve_plugin`) answers one request at a time on a single thread — serializing that burst.
//! Here every `request` is dispatched onto its own thread as soon as it is read; `hello` and
//! `closeRepos` run inline on the reading thread (low-volume, and `closeRepos` should not race
//! a request that starts after it was read).
//!
//! Host -> backend: `hello` (handshake, `params` empty), `request` (one message of the view,
//! `params: {"repo","message","settings"}`), `closeRepos` (`params: {"repo"}` or empty for
//! all), `shutdown`. Backend -> host: `{"id","result"}` / `{"id","error"}` answers to those, plus
//! push events the host folds into the Git output channel and session log: `{"event":"log",
//! "line":"> git fetch [120ms]"}` and `{"event":"ready"}`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

/// The protocol version `plugin_host.rs` and `git-graph-backend` agree on in the `hello`
/// handshake.
pub const PROTOCOL_VERSION: &str = "ggx-rpc/1";

/// One line on the wire. The untagged variants are order-dependent: a request (has `method`
/// and `id`) matches first, a response (`id` plus an optional `result`/`error`) second, a push
/// event (`event`, no `id`) last.
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
    Event {
        event: String,
        #[serde(default)]
        line: Option<String>,
    },
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

/// A request line, ready to write.
pub fn request(id: u64, method: &str, params: Value) -> String {
    line(json!({ "id": id, "method": method, "params": params }))
}

/// A response line for `id`: `Ok` carries the result value, `Err` the message as an error.
pub fn response(id: u64, result: Result<Value, String>) -> String {
    let value = match result {
        Ok(result) => json!({ "id": id, "result": result }),
        Err(message) => json!({ "id": id, "error": { "code": 1, "message": message } }),
    };
    line(value)
}

/// The backend's git-command echo, folded into the host's Git output channel and session log.
pub fn log_event(text: &str) -> String {
    line(json!({ "event": "log", "line": text }))
}

/// The backend's one-time "I am up" push, sent once its warm-up (if any) is done.
pub fn ready_event() -> String {
    line(json!({ "event": "ready" }))
}

fn line(value: Value) -> String {
    format!("{value}\n")
}

/// The backend side: read `reader` line by line, dispatch `request` calls onto their own
/// thread (so a slow one never blocks the next), answer `hello`/`closeRepos` inline, and
/// return on `shutdown` or end of input — after every spawned thread has finished, so no
/// response is lost. `handle` is called for every method and must be safe to call from
/// multiple threads at once.
pub fn serve_backend<F>(handle: F)
where
    F: Fn(&str, &Value) -> Result<Value, String> + Send + Sync + 'static,
{
    serve_backend_on(
        std::io::BufReader::new(std::io::stdin()),
        std::io::stdout(),
        handle,
    );
}

/// The testable core of [`serve_backend`], over an arbitrary reader/writer pair.
pub fn serve_backend_on<R, W, F>(reader: R, writer: W, handle: F)
where
    R: BufRead,
    W: Write + Send + 'static,
    F: Fn(&str, &Value) -> Result<Value, String> + Send + Sync + 'static,
{
    let handle = Arc::new(handle);
    let out = Arc::new(Mutex::new(writer));
    let mut threads = Vec::new();
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(Wire::Request { id, method, params }) = serde_json::from_str::<Wire>(&line) else {
            continue; // a line we cannot parse as a request is dropped
        };
        if method == "shutdown" {
            write_line(&out, &response(id, Ok(Value::Null)));
            break;
        }
        if method == "request" {
            let handle = Arc::clone(&handle);
            let out = Arc::clone(&out);
            threads.push(std::thread::spawn(move || {
                let result = handle("request", &params);
                write_line(&out, &response(id, result));
            }));
            continue;
        }
        // hello / closeRepos: inline, on this thread.
        let result = handle(&method, &params);
        write_line(&out, &response(id, result));
    }
    for thread in threads {
        let _ = thread.join();
    }
}

fn write_line<W: Write>(out: &Arc<Mutex<W>>, text: &str) {
    let mut out = out.lock().unwrap();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::time::Duration;

    #[test]
    fn a_request_line_parses_as_a_request_not_a_response() {
        let wire: Wire =
            serde_json::from_str(&request(7, "request", json!({ "repo": "/r" }))).unwrap();
        assert_eq!(
            wire,
            Wire::Request {
                id: 7,
                method: "request".into(),
                params: json!({ "repo": "/r" })
            }
        );
    }

    #[test]
    fn responses_and_events_parse_by_their_fields() {
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
        let log: Wire = serde_json::from_str(&log_event("> git fetch [1ms]")).unwrap();
        assert_eq!(
            log,
            Wire::Event {
                event: "log".into(),
                line: Some("> git fetch [1ms]".into())
            }
        );
        let ready: Wire = serde_json::from_str(&ready_event()).unwrap();
        assert_eq!(
            ready,
            Wire::Event {
                event: "ready".into(),
                line: None
            }
        );
    }

    #[test]
    fn every_builder_emits_one_line() {
        for text in [
            request(1, "hello", Value::Null),
            response(1, Ok(Value::Null)),
            log_event("x"),
            ready_event(),
        ] {
            assert!(text.ends_with('\n'));
            assert_eq!(text.matches('\n').count(), 1);
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
        let buf = Arc::new(Mutex::new(Vec::new()));
        let writer = SharedBuf(Arc::clone(&buf));
        let input = format!(
            "{}{}",
            request(1, "request", json!({ "which": "slow" })),
            request(2, "request", json!({ "which": "fast" })),
        );
        serve_backend_on(Cursor::new(input.into_bytes()), writer, |method, params| {
            assert_eq!(method, "request");
            if params["which"] == "slow" {
                std::thread::sleep(Duration::from_millis(150));
            }
            Ok(params["which"].clone())
        });
        let output = String::from_utf8(buf.lock().unwrap().clone()).unwrap();
        let lines: Vec<&str> = output.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 2, "{lines:?}");
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(
            first["id"], 2,
            "the fast request should answer first: {lines:?}"
        );
    }

    #[test]
    fn hello_and_close_repos_run_without_a_request_method() {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let writer = SharedBuf(Arc::clone(&buf));
        let input = format!(
            "{}{}{}",
            request(1, "hello", Value::Null),
            request(2, "closeRepos", json!({ "repo": "/r" })),
            request(3, "shutdown", Value::Null),
        );
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_in_handler = Arc::clone(&seen);
        serve_backend_on(
            Cursor::new(input.into_bytes()),
            writer,
            move |method, _params| {
                seen_in_handler.lock().unwrap().push(method.to_owned());
                Ok(Value::Null)
            },
        );
        assert_eq!(
            *seen.lock().unwrap(),
            vec!["hello".to_owned(), "closeRepos".to_owned()]
        );
        let output = String::from_utf8(buf.lock().unwrap().clone()).unwrap();
        assert_eq!(output.lines().filter(|l| !l.trim().is_empty()).count(), 3);
    }
}
