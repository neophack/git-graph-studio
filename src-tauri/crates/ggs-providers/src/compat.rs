//! The third-party compatibility relay (2026-10-23): a loopback HTTP relay the bridged
//! backend's `ANTHROPIC_BASE_URL` points at whenever a third-party provider is active.
//!
//! Why it exists: Claude Code 2.1.154+ injects its environment context as
//! `{"role": "system"}` entries in the middle of the Messages API's `messages[]` — a
//! role the public API never defined there. Anthropic's own gateway tolerates it; a
//! third-party one does not: a strict Anthropic-compatible endpoint answers
//! `messages[1].role must be either 'user' or 'assistant'`, and a NewAPI gateway in
//! front of a Qwen model forwards the role into the chat template, whose guard answers
//! `400 System message must be at the beginning.` Upstream closed the report as "not
//! planned" — the gateway side is expected to cope, and the bridge is that side here.
//!
//! What it does: every request body whose `messages[]` carries a `system` entry is
//! rewritten by [`fold_system_messages`] — the entry's text becomes a
//! `<system-reminder>` block inside the adjacent user turn (Claude Code's own convention
//! for user-role injections), everything else untouched; every other byte, header and
//! status crosses verbatim, and the answer streams back as it arrives (SSE included).
//! Routes are keyed by an unguessable token per upstream origin, so the listener is no
//! open relay for other local processes. One listener per app process, started on the
//! first route; it lives as long as the process — the backends it serves are stopped
//! with the app.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

/// The request head ceiling: a head larger than this is not Claude Code talking.
const MAX_HEAD_BYTES: usize = 64 * 1024;
/// The request body ceiling (a long conversation with images is megabytes, not more).
const MAX_BODY_BYTES: usize = 256 * 1024 * 1024;
/// How long a silent client may hold its connection thread before the read gives up.
const CLIENT_READ_TIMEOUT: Duration = Duration::from_secs(120);

struct Relay {
    port: u16,
    /// token → upstream base URL (no trailing slash).
    routes: Mutex<HashMap<String, String>>,
}

static RELAY: OnceLock<Result<Relay, String>> = OnceLock::new();

fn relay() -> Result<&'static Relay, String> {
    RELAY
        .get_or_init(|| {
            let listener = TcpListener::bind(("127.0.0.1", 0))
                .map_err(|e| format!("bind the provider relay: {e}"))?;
            let port = listener
                .local_addr()
                .map_err(|e| format!("provider relay address: {e}"))?
                .port();
            std::thread::Builder::new()
                .name("ggs-provider-relay".to_owned())
                .spawn(move || accept_loop(listener))
                .map_err(|e| format!("start the provider relay: {e}"))?;
            Ok(Relay {
                port,
                routes: Mutex::new(HashMap::new()),
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// The loopback base URL that relays to `upstream` (an `http(s)://` base URL, the
/// profile's `ANTHROPIC_BASE_URL`). The same upstream always answers the same route,
/// so a backend restart keeps a stable URL.
pub fn local_base_url(upstream: &str) -> Result<String, String> {
    let upstream = upstream.trim().trim_end_matches('/');
    if !(upstream.starts_with("https://") || upstream.starts_with("http://")) {
        return Err(format!("not an http(s) base URL: {upstream}"));
    }
    let relay = relay()?;
    let mut routes = relay.routes.lock().unwrap();
    let token = match routes.iter().find(|(_, base)| base.as_str() == upstream) {
        Some((token, _)) => token.clone(),
        None => {
            let mut bytes = [0u8; 16];
            getrandom::fill(&mut bytes).map_err(|e| format!("route token: {e}"))?;
            let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            routes.insert(token.clone(), upstream.to_owned());
            token
        }
    };
    Ok(format!("http://127.0.0.1:{}/r/{token}", relay.port))
}

fn accept_loop(listener: TcpListener) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        // A refused thread spawn drops this one connection, never the listener.
        let _ = std::thread::Builder::new()
            .name("ggs-provider-relay-conn".to_owned())
            .spawn(move || {
                if let Err(error) = serve(stream) {
                    eprintln!("[providers] relay: {error}");
                }
            });
    }
}

/// One parsed client request.
struct Incoming {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn read_request(reader: &mut BufReader<TcpStream>) -> Result<Option<Incoming>, String> {
    let mut head_bytes = 0usize;
    let mut line = String::new();
    let read_line = |reader: &mut BufReader<TcpStream>,
                     line: &mut String,
                     head_bytes: &mut usize|
     -> Result<usize, String> {
        line.clear();
        let n = reader
            .read_line(line)
            .map_err(|e| format!("read request: {e}"))?;
        *head_bytes += n;
        if *head_bytes > MAX_HEAD_BYTES {
            return Err("request head too large".to_owned());
        }
        Ok(n)
    };
    if read_line(reader, &mut line, &mut head_bytes)? == 0 {
        return Ok(None);
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let target = parts.next().unwrap_or_default().to_owned();
    if method.is_empty() || !target.starts_with('/') {
        return Err(format!("malformed request line: {}", line.trim_end()));
    }
    let mut headers = Vec::new();
    loop {
        if read_line(reader, &mut line, &mut head_bytes)? == 0 {
            return Err("connection closed inside the request head".to_owned());
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
        }
    }
    let header = |name: &str| {
        headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    if header("expect").is_some_and(|v| v.eq_ignore_ascii_case("100-continue")) {
        let stream = reader.get_mut();
        let _ = stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n");
    }
    let chunked =
        header("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    let body = if chunked {
        read_chunked(reader)?
    } else {
        let length: usize = header("content-length")
            .map(|v| v.parse().map_err(|_| format!("bad content-length: {v}")))
            .transpose()?
            .unwrap_or(0);
        if length > MAX_BODY_BYTES {
            return Err("request body too large".to_owned());
        }
        let mut body = vec![0u8; length];
        reader
            .read_exact(&mut body)
            .map_err(|e| format!("read request body: {e}"))?;
        body
    };
    Ok(Some(Incoming {
        method,
        target,
        headers,
        body,
    }))
}

fn read_chunked(reader: &mut BufReader<TcpStream>) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    let mut line = String::new();
    loop {
        line.clear();
        reader
            .read_line(&mut line)
            .map_err(|e| format!("read chunk size: {e}"))?;
        let size_text = line.trim().split(';').next().unwrap_or_default();
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| format!("bad chunk size: {}", line.trim()))?;
        if size == 0 {
            // Trailers, then the blank line.
            loop {
                line.clear();
                let n = reader
                    .read_line(&mut line)
                    .map_err(|e| format!("read chunk trailer: {e}"))?;
                if n == 0 || line.trim().is_empty() {
                    return Ok(body);
                }
            }
        }
        if body.len() + size > MAX_BODY_BYTES {
            return Err("request body too large".to_owned());
        }
        let start = body.len();
        body.resize(start + size, 0);
        reader
            .read_exact(&mut body[start..])
            .map_err(|e| format!("read chunk: {e}"))?;
        line.clear();
        reader
            .read_line(&mut line)
            .map_err(|e| format!("read chunk end: {e}"))?;
    }
}

/// Hop-by-hop and framing headers: never forwarded either way — the relay frames its
/// own legs. `accept-encoding` stays off the upstream leg so the answer arrives as the
/// identity bytes the client is then handed.
fn is_hop_header(name: &str) -> bool {
    matches!(
        name,
        "host"
            | "connection"
            | "keep-alive"
            | "proxy-connection"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "content-length"
            | "content-encoding"
            | "accept-encoding"
            | "expect"
    )
}

fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            // Every status is an answer to relay, not an error.
            .http_status_as_error(false)
            // A redirect is the client's to follow (a POST must not silently turn GET).
            .max_redirects(0)
            .timeout_connect(Some(Duration::from_secs(30)))
            // The streamed answer is open-ended: no global or body timeout.
            .accept_encoding(ureq::config::AutoHeaderValue::None)
            .user_agent(ureq::config::AutoHeaderValue::None)
            .build()
            .into()
    })
}

fn serve(stream: TcpStream) -> Result<(), String> {
    let _ = stream.set_read_timeout(Some(CLIENT_READ_TIMEOUT));
    let _ = stream.set_nodelay(true);
    let mut reader = BufReader::new(stream);
    let Some(request) = read_request(&mut reader)? else {
        return Ok(());
    };
    let mut client = reader.into_inner();
    let _ = client.set_read_timeout(None);

    let upstream_url = {
        let routes = relay()?.routes.lock().unwrap();
        request.target.strip_prefix("/r/").and_then(|rest| {
            let (token, tail) = rest.split_at(rest.find(['/', '?']).unwrap_or(rest.len()));
            routes.get(token).map(|base| format!("{base}{tail}"))
        })
    };
    let Some(upstream_url) = upstream_url else {
        return write_error(&mut client, 404, "unknown provider relay route");
    };

    let body = if request.body.is_empty() {
        request.body
    } else {
        fold_system_messages(&request.body).unwrap_or(request.body)
    };

    let mut builder = ureq::http::Request::builder()
        .method(request.method.as_str())
        .uri(upstream_url.as_str());
    for (name, value) in &request.headers {
        if !is_hop_header(name) {
            builder = builder.header(name.as_str(), value.as_str());
        }
    }
    let result = if body.is_empty() {
        builder
            .body(())
            .map_err(|e| e.to_string())
            .and_then(|req| agent().run(req).map_err(|e| e.to_string()))
    } else {
        builder
            .body(body)
            .map_err(|e| e.to_string())
            .and_then(|req| agent().run(req).map_err(|e| e.to_string()))
    };
    let response = match result {
        Ok(response) => response,
        Err(error) => {
            return write_error(
                &mut client,
                502,
                &format!("could not reach the provider at {upstream_url}: {error}"),
            )
        }
    };

    let status = response.status();
    let mut head = format!(
        "HTTP/1.1 {} {}\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("")
    );
    for (name, value) in response.headers() {
        if is_hop_header(name.as_str()) {
            continue;
        }
        if let Ok(value) = value.to_str() {
            head.push_str(&format!("{}: {value}\r\n", name.as_str()));
        }
    }
    head.push_str("Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
    client
        .write_all(head.as_bytes())
        .map_err(|e| format!("answer head: {e}"))?;

    // Stream as it arrives — every read is one chunk, flushed at once, so an SSE event
    // reaches Claude Code the moment the provider emits it.
    let mut reader = response.into_body().into_reader();
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        let n = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(error) => {
                // Drop the connection without the terminating chunk: the client sees a
                // truncated stream, never a complete-looking one.
                return Err(format!("upstream body: {error}"));
            }
        };
        client
            .write_all(format!("{n:x}\r\n").as_bytes())
            .and_then(|_| client.write_all(&buffer[..n]))
            .and_then(|_| client.write_all(b"\r\n"))
            .and_then(|_| client.flush())
            .map_err(|e| format!("client gone: {e}"))?;
    }
    client
        .write_all(b"0\r\n\r\n")
        .and_then(|_| client.flush())
        .map_err(|e| format!("answer end: {e}"))
}

/// A relay-side failure in the Messages API's own error shape, so Claude Code renders it
/// like any provider error.
fn write_error(client: &mut TcpStream, status: u16, message: &str) -> Result<(), String> {
    let body = json!({
        "type": "error",
        "error": { "type": "api_error", "message": format!("GGS provider relay: {message}") }
    })
    .to_string();
    let reason = match status {
        404 => "Not Found",
        _ => "Bad Gateway",
    };
    let answer = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    client
        .write_all(answer.as_bytes())
        .map_err(|e| format!("answer error: {e}"))
}

/* ---------- The rewrite ---------- */

fn role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

/// A `system` entry's content as `<system-reminder>` text blocks (a block's
/// `cache_control` rides along, so the request's cache breakpoints stay where Claude
/// Code put them).
fn reminder_blocks(message: &Value) -> Vec<Value> {
    let wrap = |text: &str| format!("<system-reminder>\n{text}\n</system-reminder>");
    match message.get("content") {
        Some(Value::String(text)) if !text.is_empty() => {
            vec![json!({ "type": "text", "text": wrap(text) })]
        }
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| {
                let text = block.get("text").and_then(Value::as_str)?;
                if text.is_empty() {
                    return None;
                }
                let mut out = json!({ "type": "text", "text": wrap(text) });
                if let Some(cache) = block.get("cache_control") {
                    out["cache_control"] = cache.clone();
                }
                Some(out)
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// A message's content as a block array (a string content becomes one text block).
fn content_blocks(message: &mut Value) -> &mut Vec<Value> {
    if let Some(Value::String(text)) = message.get("content") {
        let text = text.clone();
        message["content"] = if text.is_empty() {
            json!([])
        } else {
            json!([{ "type": "text", "text": text }])
        };
    }
    if !message.get("content").is_some_and(Value::is_array) {
        message["content"] = json!([]);
    }
    message["content"].as_array_mut().unwrap()
}

/// Joins reminder blocks into a user turn: after its `tool_result` blocks when it has
/// any (the Messages API requires them to lead the turn that answers a tool use),
/// before its own text otherwise.
fn merge_into_user(message: &mut Value, reminders: Vec<Value>, append: bool) {
    let blocks = content_blocks(message);
    let leads_with_results = blocks
        .iter()
        .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"));
    if append || leads_with_results {
        blocks.extend(reminders);
    } else {
        blocks.splice(0..0, reminders);
    }
}

/// The request body with every `messages[]` entry of role `system` folded into the
/// adjacent user turn as `<system-reminder>` blocks — `None` when there is nothing to
/// fold (the body is then forwarded byte for byte). A `system` entry joins the user turn
/// before it; one with none before it (the first entry, or one after an assistant turn)
/// joins the next user turn; one with no user turn on either side becomes a user turn
/// of its own.
pub fn fold_system_messages(body: &[u8]) -> Option<Vec<u8>> {
    // Cheap prefilter: no `"system"` string anywhere, nothing to parse.
    if !body.windows(8).any(|w| w == b"\"system\"") {
        return None;
    }
    let mut value: Value = serde_json::from_slice(body).ok()?;
    let messages = value.get_mut("messages")?.as_array_mut()?;
    if !messages.iter().any(|m| role(m) == Some("system")) {
        return None;
    }
    let mut folded: Vec<Value> = Vec::with_capacity(messages.len());
    let mut pending: Vec<Value> = Vec::new();
    for mut message in messages.drain(..) {
        if role(&message) == Some("system") {
            let reminders = reminder_blocks(&message);
            match folded.last_mut() {
                Some(previous) if role(previous) == Some("user") && pending.is_empty() => {
                    merge_into_user(previous, reminders, true);
                }
                _ => pending.extend(reminders),
            }
            continue;
        }
        if !pending.is_empty() {
            let reminders = std::mem::take(&mut pending);
            if role(&message) == Some("user") {
                merge_into_user(&mut message, reminders, false);
            } else {
                folded.push(json!({ "role": "user", "content": reminders }));
            }
        }
        folded.push(message);
    }
    if !pending.is_empty() {
        match folded.last_mut() {
            Some(last) if role(last) == Some("user") => merge_into_user(last, pending, true),
            _ => folded.push(json!({ "role": "user", "content": pending })),
        }
    }
    *messages = folded;
    serde_json::to_vec(&value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fold(body: Value) -> Option<Value> {
        fold_system_messages(body.to_string().as_bytes())
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }

    #[test]
    fn a_body_without_system_entries_is_left_byte_for_byte() {
        let body = json!({
            "model": "qwen", "system": [{ "type": "text", "text": "top" }],
            "messages": [{ "role": "user", "content": "hi" }]
        });
        assert!(fold(body).is_none());
        assert!(fold_system_messages(b"not json \"system\"").is_none());
    }

    /// The 2.1.154+ shape: the environment context right after the first user turn.
    #[test]
    fn a_system_entry_after_a_user_turn_joins_it() {
        let out = fold(json!({
            "system": [{ "type": "text", "text": "top" }],
            "messages": [
                { "role": "user", "content": "hello" },
                { "role": "system", "content": "cwd: /repo" },
                { "role": "assistant", "content": "hi" }
            ]
        }))
        .unwrap();
        assert_eq!(out["system"][0]["text"], "top");
        let messages = out["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"][0]["text"], "hello");
        assert_eq!(
            messages[0]["content"][1]["text"],
            "<system-reminder>\ncwd: /repo\n</system-reminder>"
        );
        assert_eq!(messages[1]["role"], "assistant");
    }

    /// Between a tool use and its result the reminder trails the results — they must
    /// lead the answering turn.
    #[test]
    fn a_system_entry_before_a_tool_result_turn_trails_the_results() {
        let out = fold(json!({
            "messages": [
                { "role": "user", "content": "run it" },
                { "role": "assistant", "content": [{ "type": "tool_use", "id": "t1", "name": "Bash", "input": {} }] },
                { "role": "system", "content": [{ "type": "text", "text": "ctx", "cache_control": { "type": "ephemeral" } }] },
                { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "ok" }] }
            ]
        }))
        .unwrap();
        let messages = out["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3);
        let last = messages[2]["content"].as_array().unwrap();
        assert_eq!(last[0]["type"], "tool_result");
        assert_eq!(
            last[1]["text"],
            "<system-reminder>\nctx\n</system-reminder>"
        );
        assert_eq!(last[1]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn a_leading_system_entry_leads_the_first_user_turn() {
        let out = fold(json!({
            "messages": [
                { "role": "system", "content": "ctx" },
                { "role": "user", "content": "hello" }
            ]
        }))
        .unwrap();
        let messages = out["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0]["content"][0]["text"],
            "<system-reminder>\nctx\n</system-reminder>"
        );
        assert_eq!(messages[0]["content"][1]["text"], "hello");
    }

    #[test]
    fn a_system_entry_with_no_user_turn_around_becomes_one() {
        let out = fold(json!({
            "messages": [
                { "role": "user", "content": "q" },
                { "role": "assistant", "content": "a" },
                { "role": "system", "content": "ctx" }
            ]
        }))
        .unwrap();
        let messages = out["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[2]["role"], "user");
        assert_eq!(
            messages[2]["content"][0]["text"],
            "<system-reminder>\nctx\n</system-reminder>"
        );
        assert!(messages.iter().all(|m| m["role"] != "system"));
    }

    /// End to end over real sockets: the relay folds the body on the way up, keeps the
    /// headers, and streams the provider's answer back.
    #[test]
    fn the_relay_folds_the_request_and_streams_the_answer() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = upstream.local_addr().unwrap().port();
        let seen = std::thread::spawn(move || {
            let (stream, _) = upstream.accept().unwrap();
            let mut reader = BufReader::new(stream);
            let request = read_request(&mut reader).unwrap().unwrap();
            let mut stream = reader.into_inner();
            let sse = "event: message_stop\ndata: {}\n\n";
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{sse}",
                sse.len()
            )
            .unwrap();
            request
        });

        let base = local_base_url(&format!("http://127.0.0.1:{port}/anthropic/")).unwrap();
        assert_eq!(
            base,
            local_base_url(&format!("http://127.0.0.1:{port}/anthropic")).unwrap()
        );
        let body = json!({
            "model": "qwen",
            "messages": [
                { "role": "user", "content": "hello" },
                { "role": "system", "content": "ctx" }
            ]
        })
        .to_string();
        let mut response = ureq::post(&format!("{base}/v1/messages?beta=true"))
            .header("x-api-key", "sk-test")
            .header("content-type", "application/json")
            .send(body.as_bytes())
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "text/event-stream"
        );
        let text = response.body_mut().read_to_string().unwrap();
        assert_eq!(text, "event: message_stop\ndata: {}\n\n");

        let request = seen.join().unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.target, "/anthropic/v1/messages?beta=true");
        assert!(request
            .headers
            .iter()
            .any(|(name, value)| name == "x-api-key" && value == "sk-test"));
        let sent: Value = serde_json::from_slice(&request.body).unwrap();
        let messages = sent["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0]["content"][1]["text"],
            "<system-reminder>\nctx\n</system-reminder>"
        );
    }

    #[test]
    fn an_unknown_route_answers_an_api_error() {
        let base = local_base_url("http://127.0.0.1:9").unwrap();
        let bogus = base.rsplit_once('/').unwrap().0.to_owned() + "/deadbeef";
        let mut response = ureq::get(&format!("{bogus}/v1/models"))
            .config()
            .http_status_as_error(false)
            .build()
            .call()
            .unwrap();
        assert_eq!(response.status().as_u16(), 404);
        let text = response.body_mut().read_to_string().unwrap();
        assert!(text.contains("unknown provider relay route"), "{text}");
    }
}
