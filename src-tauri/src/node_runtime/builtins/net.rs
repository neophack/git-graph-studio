//! `net` over `std::net`, and the HTTP(S) client over ureq: the natives the prelude's
//! `net` / `http` / `https` / `fetch` are built on. Nothing here blocks the JS thread —
//! every listener has an accept thread, every socket a reader thread (data / end / error /
//! close) and a writer thread (writes in order, `end` a half-close after them), and every
//! client request its own thread; all of them report through [`Job::Native`] events,
//! which the prelude's `__ggsNativeEvent` routes to the object that owns the id. The one
//! bounded exception is the server close, which waits for the accept thread to drop the
//! listener (see [`close_server`]): a port that still accepts during the teardown answers
//! a reconnect with ECONNRESET where Node answers ECONNREFUSED.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use boa_engine::{Context, JsArgs, JsResult, JsValue};
use serde_json::{json, Value};

use super::support::*;
use crate::node_runtime::{with_state, Job, Pump};

/// One queued operation for a socket's writer thread.
enum WriteOp {
    Bytes(Vec<u8>),
    /// Half-close after everything queued before it (Node's `socket.end()`).
    End,
}

enum Entry {
    Listener {
        stop: Arc<AtomicBool>,
        local: SocketAddr,
        /// Fires once the accept thread has dropped the listener — the proof
        /// [`close_server`] waits for before answering the JS.
        closed: mpsc::Receiver<()>,
    },
    Socket {
        /// None until an outgoing connection is established.
        stream: Option<TcpStream>,
        writer: mpsc::Sender<WriteOp>,
    },
}

static TABLE: OnceLock<Mutex<HashMap<u64, Entry>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn table() -> &'static Mutex<HashMap<u64, Entry>> {
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

fn pump() -> Pump {
    with_state(|state| state.pump())
}

fn send(pump: &Pump, id: u64, event: &'static str, data: Value, bytes: Option<Vec<u8>>) {
    pump.send_job(Job::Native {
        id,
        event,
        data,
        bytes,
    });
}

/// Node's error code for an I/O failure (what `err.code` carries in Node).
fn code_of(error: &std::io::Error) -> &'static str {
    use std::io::ErrorKind::*;
    match error.kind() {
        AddrInUse => "EADDRINUSE",
        AddrNotAvailable => "EADDRNOTAVAIL",
        ConnectionRefused => "ECONNREFUSED",
        ConnectionReset => "ECONNRESET",
        ConnectionAborted => "ECONNABORTED",
        BrokenPipe => "EPIPE",
        TimedOut => "ETIMEDOUT",
        PermissionDenied => "EACCES",
        NotFound => "ENOTFOUND",
        InvalidInput => "EINVAL",
        _ => "EIO",
    }
}

fn error_json(error: &std::io::Error, syscall: &str) -> Value {
    json!({ "code": code_of(error), "message": format!("{syscall} {}: {error}", code_of(error)), "syscall": syscall })
}

fn family(addr: &SocketAddr) -> &'static str {
    if addr.is_ipv4() {
        "IPv4"
    } else {
        "IPv6"
    }
}

fn endpoints(stream: &TcpStream) -> Value {
    let local = stream.local_addr().ok();
    let remote = stream.peer_addr().ok();
    json!({
        "localAddress": local.map(|a| a.ip().to_string()),
        "localPort": local.map(|a| a.port()),
        "remoteAddress": remote.map(|a| a.ip().to_string()),
        "remotePort": remote.map(|a| a.port()),
        "remoteFamily": remote.as_ref().map(family),
    })
}

/// The reader loop of one socket: every chunk as `data`, the peer's half-close as `end`,
/// a failure as `error`, and always one final `close`.
fn read_loop(id: u64, mut stream: TcpStream, pump: Pump) {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut had_error = false;
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => {
                send(&pump, id, "end", Value::Null, None);
                break;
            }
            Ok(n) => send(&pump, id, "data", Value::Null, Some(buffer[..n].to_vec())),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                // A socket this side destroyed reads as an abort; that is not the peer's error.
                let destroyed = !table().lock().unwrap().contains_key(&id);
                if !destroyed {
                    had_error = true;
                    send(&pump, id, "error", error_json(&e, "read"), None);
                }
                break;
            }
        }
    }
    table().lock().unwrap().remove(&id);
    send(&pump, id, "close", json!({ "hadError": had_error }), None);
}

/// The writer loop: queued writes in order; `End` half-closes once they are out.
fn write_loop(id: u64, mut stream: TcpStream, ops: mpsc::Receiver<WriteOp>, pump: Pump) {
    for op in ops {
        match op {
            WriteOp::Bytes(bytes) => {
                if let Err(e) = stream.write_all(&bytes) {
                    if table().lock().unwrap().contains_key(&id) {
                        send(&pump, id, "error", error_json(&e, "write"), None);
                    }
                    break;
                }
            }
            WriteOp::End => {
                let _ = stream.flush();
                let _ = stream.shutdown(Shutdown::Write);
            }
        }
    }
}

/// The most sockets one runtime keeps open at once. Every socket costs two OS threads
/// here (Node multiplexes them on one loop), and a listener is reachable from the LAN —
/// Claude Remote's is. Without a ceiling a connection flood, or a client that reconnects
/// without closing, grew the thread count until the OS refused a spawn, which panicked
/// the accept thread and left the server deaf. Past the ceiling a new connection is
/// closed at once, which a client sees as a reset and retries.
const MAX_LIVE_SOCKETS: usize = 1024;

fn live_sockets() -> usize {
    table()
        .lock()
        .unwrap()
        .values()
        .filter(|entry| matches!(entry, Entry::Socket { .. }))
        .count()
}

/// Register an accepted or connected stream and start its reader and writer threads. A
/// thread the OS refuses fails this socket alone — the peer sees the connection close and
/// the JS side its `close` — instead of panicking the thread that called.
fn start_socket(id: u64, stream: TcpStream, ops: mpsc::Receiver<WriteOp>, pump: &Pump) {
    let _ = stream.set_nodelay(true);
    let started = match (stream.try_clone(), stream.try_clone()) {
        (Ok(reader), Ok(writer)) => {
            let read_pump = pump.clone();
            let reading = std::thread::Builder::new()
                .name(format!("ggs-net-read-{id}"))
                .spawn(move || read_loop(id, reader, read_pump));
            let write_pump = pump.clone();
            let writing = std::thread::Builder::new()
                .name(format!("ggs-net-write-{id}"))
                .spawn(move || write_loop(id, writer, ops, write_pump));
            reading.is_ok() && writing.is_ok()
        }
        _ => false,
    };
    if !started {
        let _ = stream.shutdown(Shutdown::Both);
        table().lock().unwrap().remove(&id);
        send(pump, id, "close", json!({ "hadError": true }), None);
        return;
    }
    if let Some(Entry::Socket { stream: slot, .. }) = table().lock().unwrap().get_mut(&id) {
        *slot = Some(stream);
    }
}

/// `__ggsNetListen(host, port)` → `{ id, address, port, family }`, bound synchronously (so
/// EADDRINUSE throws where the prelude turns it into the server's `error` event). Each
/// accepted connection arrives as the listener's `connection` event carrying the new
/// socket's id — always before that socket's first `data`.
pub(super) fn listen(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let host = opt_string_arg(args, 0, context).unwrap_or_else(|| "0.0.0.0".to_owned());
    let port = args.get_or_undefined(1).to_number(context).unwrap_or(0.0) as u16;
    let host = if host == "localhost" {
        "127.0.0.1".to_owned()
    } else {
        host
    };
    let listener = TcpListener::bind((host.as_str(), port)).map_err(|e| {
        let info = error_json(&e, "listen");
        error(format!(
            "{}|{}",
            info["code"].as_str().unwrap_or("EIO"),
            info["message"].as_str().unwrap_or_default()
        ))
    })?;
    let local = listener
        .local_addr()
        .map_err(|e| error(format!("EIO|listen: {e}")))?;
    let id = next_id();
    let stop = Arc::new(AtomicBool::new(false));
    let (dropped_tx, dropped_rx) = mpsc::channel::<()>();
    table().lock().unwrap().insert(
        id,
        Entry::Listener {
            stop: Arc::clone(&stop),
            local,
            closed: dropped_rx,
        },
    );
    let pump = pump();
    let accepting = std::thread::Builder::new().name(format!("ggs-net-accept-{id}"));
    let spawned = accepting.spawn(move || {
        for incoming in listener.incoming() {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            match incoming {
                Ok(stream) if live_sockets() >= MAX_LIVE_SOCKETS => {
                    // Over the ceiling (see `MAX_LIVE_SOCKETS`): refuse this one.
                    let _ = stream.shutdown(Shutdown::Both);
                }
                Ok(stream) => {
                    let socket_id = next_id();
                    let (writer, ops) = mpsc::channel();
                    table().lock().unwrap().insert(
                        socket_id,
                        Entry::Socket {
                            stream: None,
                            writer,
                        },
                    );
                    let mut data = endpoints(&stream);
                    data["socket"] = json!(socket_id);
                    send(&pump, id, "connection", data, None);
                    start_socket(socket_id, stream, ops, &pump);
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    // Transient accept failures (a peer resetting mid-handshake) are
                    // Node's to ignore too; the listener stays up.
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let _ = e;
                }
            }
        }
        // Drop the listener before the ack: `close_server`'s wait proves the port is
        // refusing connections once it returns, the way Node's close does.
        drop(listener);
        let _ = dropped_tx.send(());
    });
    if let Err(e) = spawned {
        table().lock().unwrap().remove(&id);
        return Err(error(format!("EAGAIN|listen: no thread for the listener: {e}")));
    }
    JsValue::from_json(
        &json!({ "id": id, "address": local.ip().to_string(), "port": local.port(), "family": family(&local) }),
        context,
    )
}

/// `__ggsNetCloseServer(id)`: stop accepting (the accept thread is woken by a throwaway
/// connection to itself); live sockets stay open, as in Node. The call then waits —
/// bounded, the wake round trip plus scheduling — for the accept thread to actually drop
/// the listener: Node's close leaves the port refusing connections before the server's
/// 'close' event, while a connect racing this teardown (the accept thread still holding
/// the listener) lands in its backlog and reads ECONNRESET instead of ECONNREFUSED —
/// the Linux CI failure of `sockets_http_and_fetch_work_end_to_end`.
pub(super) fn close_server(
    _: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let id = args.get_or_undefined(0).to_number(context).unwrap_or(0.0) as u64;
    let removed = table().lock().unwrap().remove(&id);
    if let Some(Entry::Listener {
        stop,
        local,
        closed,
    }) = removed
    {
        stop.store(true, Ordering::SeqCst);
        let wake = if local.ip().is_unspecified() {
            SocketAddr::new(
                if local.is_ipv4() {
                    std::net::Ipv4Addr::LOCALHOST.into()
                } else {
                    std::net::Ipv6Addr::LOCALHOST.into()
                },
                local.port(),
            )
        } else {
            local
        };
        let _ = TcpStream::connect_timeout(&wake, Duration::from_millis(500));
        // A timeout only means the accept thread was not scheduled in time; the drop
        // still lands on its own, exactly as before the wait existed.
        let _ = closed.recv_timeout(Duration::from_secs(2));
    }
    Ok(JsValue::undefined())
}

/// `__ggsNetConnect(host, port)` → socket id at once; `connect` (with the endpoints) or
/// `error` follows. Writes made before the connection lands queue in order.
/// GGS-patch: `dns.lookup`'s native half — the hostname resolves on this (worker) call
/// the way `connect` resolves, and the addresses cross as JSON for the prelude's dns
/// module to shape (`[{address, family}]`). ENOTFOUND crosses as a JSON error object so
/// the JS side can reject with Node's own error shape.
pub(super) fn dns_lookup(
    _: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let host = opt_string_arg(args, 0, context).unwrap_or_else(|| "localhost".to_owned());
    let host = host.trim().to_owned();
    let family_number = |addr: &SocketAddr| if addr.is_ipv4() { 4 } else { 6 };
    let resolved = (host.as_str(), 0u16)
        .to_socket_addrs()
        .map(|addrs| {
            let list: Vec<String> = addrs
                .map(|addr| format!("{{\"address\":\"{}\",\"family\":{}}}", addr.ip(), family_number(&addr)))
                .collect();
            format!("{{\"ok\":true,\"addrs\":[{}]}}", list.join(","))
        })
        .unwrap_or_else(|_| format!("{{\"ok\":false,\"code\":\"ENOTFOUND\",\"message\":\"getaddrinfo ENOTFOUND {host}\"}}"));
    Ok(JsValue::from(boa_engine::js_string!(resolved)))
}

pub(super) fn connect(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let host = opt_string_arg(args, 0, context).unwrap_or_else(|| "localhost".to_owned());
    let port = args.get_or_undefined(1).to_number(context).unwrap_or(0.0) as u16;
    let id = next_id();
    let (writer, ops) = mpsc::channel();
    table().lock().unwrap().insert(
        id,
        Entry::Socket {
            stream: None,
            writer,
        },
    );
    let pump = pump();
    std::thread::spawn(move || {
        let connected = (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::NotFound, e))
            .and_then(|addrs| {
                let mut last = std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("getaddrinfo ENOTFOUND {host}"),
                );
                for addr in addrs {
                    match TcpStream::connect_timeout(&addr, Duration::from_secs(30)) {
                        Ok(stream) => return Ok(stream),
                        Err(e) => last = e,
                    }
                }
                Err(last)
            });
        match connected {
            Ok(stream) => {
                if !table().lock().unwrap().contains_key(&id) {
                    return; // destroyed while connecting
                }
                send(&pump, id, "connect", endpoints(&stream), None);
                start_socket(id, stream, ops, &pump);
            }
            Err(e) => {
                table().lock().unwrap().remove(&id);
                send(&pump, id, "error", error_json(&e, "connect"), None);
                send(&pump, id, "close", json!({ "hadError": true }), None);
            }
        }
    });
    Ok(JsValue::from(id as f64))
}

/// `__ggsNetWrite(id, bytes)` → false when the socket is gone.
pub(super) fn write(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let id = args.get_or_undefined(0).to_number(context).unwrap_or(0.0) as u64;
    let bytes = bytes_arg(args.get_or_undefined(1), context).unwrap_or_default();
    let table = table().lock().unwrap();
    let sent = match table.get(&id) {
        Some(Entry::Socket { writer, .. }) => writer.send(WriteOp::Bytes(bytes)).is_ok(),
        _ => false,
    };
    Ok(JsValue::from(sent))
}

/// `__ggsNetEnd(id)`: half-close after the queued writes.
pub(super) fn end(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let id = args.get_or_undefined(0).to_number(context).unwrap_or(0.0) as u64;
    if let Some(Entry::Socket { writer, .. }) = table().lock().unwrap().get(&id) {
        let _ = writer.send(WriteOp::End);
    }
    Ok(JsValue::undefined())
}

/// `__ggsNetDestroy(id)`: tear the connection down now (the reader then reports `close`).
pub(super) fn destroy(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let id = args.get_or_undefined(0).to_number(context).unwrap_or(0.0) as u64;
    let removed = table().lock().unwrap().remove(&id);
    if let Some(Entry::Socket {
        stream: Some(stream),
        ..
    }) = removed
    {
        let _ = stream.shutdown(Shutdown::Both);
    }
    Ok(JsValue::undefined())
}

/// `__ggsNetSetNoDelay(id, flag)`.
pub(super) fn set_no_delay(
    _: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let id = args.get_or_undefined(0).to_number(context).unwrap_or(0.0) as u64;
    let flag = args.get_or_undefined(1).to_boolean();
    if let Some(Entry::Socket {
        stream: Some(stream),
        ..
    }) = table().lock().unwrap().get(&id)
    {
        let _ = stream.set_nodelay(flag);
    }
    Ok(JsValue::undefined())
}

/* ---------- the HTTP(S) client: fetch and http(s).request ride on this ---------- */

/// Cancellation flags of the client requests in flight, by id.
static REQUESTS: OnceLock<Mutex<HashMap<u64, Arc<AtomicBool>>>> = OnceLock::new();

fn requests() -> &'static Mutex<HashMap<u64, Arc<AtomicBool>>> {
    REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `__ggsHttpRequest({ method, url, headers: [[k, v]…], timeoutMs }, body?)` → request id.
/// Events: `response` `{ status, statusText, headers: [[k, v]…], url }`, then `data`
/// chunks as they stream, then `end` — or `error` `{ code, message }`. The system proxy
/// (`HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`) applies, as in Node's undici with
/// `NODE_USE_ENV_PROXY`; a 4xx/5xx is a response, never an error.
pub(super) fn http_request(
    _: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let spec = crate::node_runtime::json_of(context, args.get_or_undefined(0))
        .map_err(|e| error(format!("http request options: {e}")))?;
    let body = bytes_arg(args.get_or_undefined(1), context);
    let id = next_id();
    let cancelled = Arc::new(AtomicBool::new(false));
    requests()
        .lock()
        .unwrap()
        .insert(id, Arc::clone(&cancelled));
    let pump = pump();
    std::thread::spawn(move || {
        let outcome = run_http(id, &spec, body, &cancelled, &pump);
        requests().lock().unwrap().remove(&id);
        if cancelled.load(Ordering::SeqCst) {
            return;
        }
        match outcome {
            Ok(()) => send(&pump, id, "end", Value::Null, None),
            Err((code, message)) => send(
                &pump,
                id,
                "error",
                json!({ "code": code, "message": message }),
                None,
            ),
        }
    });
    Ok(JsValue::from(id as f64))
}

/// `__ggsHttpAbort(id)`: stop delivering a request's events (its thread winds down at
/// the next chunk).
pub(super) fn http_abort(
    _: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let id = args.get_or_undefined(0).to_number(context).unwrap_or(0.0) as u64;
    if let Some(flag) = requests().lock().unwrap().get(&id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(JsValue::undefined())
}

fn run_http(
    id: u64,
    spec: &Value,
    body: Option<Vec<u8>>,
    cancelled: &AtomicBool,
    pump: &Pump,
) -> Result<(), (String, String)> {
    let method = spec["method"].as_str().unwrap_or("GET").to_uppercase();
    let url = spec["url"].as_str().unwrap_or_default().to_owned();
    let timeout = spec["timeoutMs"]
        .as_u64()
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(timeout)
        .proxy(ureq::Proxy::try_from_env())
        .max_redirects(if spec["redirect"].as_str() == Some("manual") {
            0
        } else {
            10
        })
        .build()
        .into();
    let mut builder = ureq::http::Request::builder()
        .method(method.as_str())
        .uri(url.as_str());
    if let Some(headers) = spec["headers"].as_array() {
        for pair in headers {
            if let (Some(name), Some(value)) = (pair[0].as_str(), pair[1].as_str()) {
                // The transport's own framing headers are ureq's to write.
                let lower = name.to_ascii_lowercase();
                if lower == "content-length" || lower == "host" || lower == "connection" {
                    continue;
                }
                builder = builder.header(name, value);
            }
        }
    }
    let request = builder.body(body.unwrap_or_default()).map_err(|e| {
        (
            "ERR_INVALID_URL".to_owned(),
            format!("invalid request: {e}"),
        )
    })?;
    let response = agent.run(request).map_err(|e| {
        let code = match &e {
            ureq::Error::Timeout(_) => "ETIMEDOUT",
            ureq::Error::HostNotFound => "ENOTFOUND",
            ureq::Error::ConnectionFailed => "ECONNREFUSED",
            ureq::Error::Io(io) => code_of(io),
            _ => "ECONNRESET",
        };
        (code.to_owned(), format!("request to {url} failed: {e}"))
    })?;
    let status = response.status();
    let headers: Vec<Value> = response
        .headers()
        .iter()
        .map(|(name, value)| json!([name.as_str(), String::from_utf8_lossy(value.as_bytes())]))
        .collect();
    send(
        pump,
        id,
        "response",
        json!({
            "status": status.as_u16(),
            "statusText": status.canonical_reason().unwrap_or(""),
            "headers": headers,
            "url": url,
        }),
        None,
    );
    let mut reader = response.into_body().into_reader();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Ok(());
        }
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(n) => send(pump, id, "data", Value::Null, Some(buffer[..n].to_vec())),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err((code_of(&e).to_owned(), format!("read {url}: {e}"))),
        }
    }
}
