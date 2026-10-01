//! The pretend Node runtime's integration test: a VSIX-shaped package whose entry is plain
//! JavaScript is served over a real `ggs-ext/1` loop — the `initialize` handshake, the
//! launcher convention, `runCommand` through a `ggs.onRequest` handler and through
//! `module.exports.dispatch`, `fs`/timers/promises answering from the runtime's builtins —
//! and a `require('*.node')` crosses the C-ABI JSON dispatch of a real dynamic library
//! is refused with its reason. The last test drives the whole chain through the process
//! host exactly as the app does: install → spawn the bundled `ggs-node` sidecar →
//! handshake → command → stop.

#![cfg(feature = "node-runtime")]

// The N-API host's exported surface must be in this image for the /EXPORT directives
// to resolve; this suite never loads an addon itself, so this test holds the reference
// the linker needs (a const cannot — it folds away).
#[test]
#[cfg(feature = "node-runtime")]
fn the_napi_surface_links() {
    git_graph_studio_lib::node_runtime::link_napi_host();
}

use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use git_graph_studio_lib::ext_process::ProcessHostState;
use serde_json::{json, Value};

const ID: &str = "acme.js-demo";

/// A writer the test reads responses back from (the same shape `ext_protocol.rs`'s tests use).
#[derive(Clone, Default)]
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

/// A scratch package directory: `files` maps package-relative paths to contents.
fn make_package(tmp: &Path, files: &[(&str, &str)]) -> PathBuf {
    let package = tmp.join("pkg");
    for (relative, contents) in files {
        let path = package.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }
    package
}

/// The request lines, released one at a time: line `next` becomes readable only once
/// response `next - 1` has crossed the shared output. The wire permits pipelining —
/// `serve_plugin_on` answers each request on its own thread — but the app's own discipline
/// is sequential (`ext_process` waits out the `initialize` handshake before its first
/// command), and these tests pin that discipline: a pipelined `runCommand` could otherwise
/// reach the runtime before `initialize` had declared the launcher.
struct OrderedRequests {
    lines: Vec<String>,
    next: usize,
    output: SharedBuf,
}

impl OrderedRequests {
    fn responses_crossed(&self) -> usize {
        self.output
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|b| **b == b'\n')
            .count()
    }
}

impl Read for OrderedRequests {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let available = self.fill_buf()?;
        let take = available.len().min(buf.len());
        buf[..take].copy_from_slice(&available[..take]);
        self.consume(take);
        Ok(take)
    }
}

impl BufRead for OrderedRequests {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        while self.next < self.lines.len() && self.responses_crossed() < self.next {
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        if self.next >= self.lines.len() {
            return Ok(&[]);
        }
        Ok(self.lines[self.next].as_bytes())
    }

    fn consume(&mut self, amt: usize) {
        if amt > 0 {
            self.next += 1;
        }
    }
}

/// Serve one package's entry over the protocol with the given request lines, and answer
/// with the parsed `result` values of every response (logs skipped).
fn serve(entry: PathBuf, requests: &[Value]) -> Vec<Result<Value, String>> {
    let lines: Vec<String> = requests
        .iter()
        .enumerate()
        .map(|(id, request)| {
            format!(
                "{}\n",
                git_graph_studio_lib::ext_protocol::request(
                    id as u64 + 1,
                    request["method"].as_str().unwrap(),
                    request["params"].clone(),
                )
            )
        })
        .collect();
    let output = SharedBuf::default();
    let reader = OrderedRequests {
        lines,
        next: 0,
        output: output.clone(),
    };
    git_graph_studio_lib::node_runtime::serve_on(entry, reader, output.clone());
    let text = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();
    // Requests are answered on their own threads, so responses cross in any order: index
    // them by id.
    let mut answers = vec![None; requests.len()];
    for line in text.lines() {
        let Ok(wire) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if wire.get("method").and_then(Value::as_str) == Some("ggs.hostRequest") {
            // A frame program's host asks (host.env at activation): answer null — enough
            // for the shim to proceed — and keep the responses out of the answers table
            // (their ids live in the host-request id space, above the request ids).
            let host_id = wire["id"].as_u64().unwrap_or_default();
            let mut output = output.0.lock().unwrap();
            use std::io::Write as _;
            let _ = writeln!(
                output,
                "{}",
                git_graph_studio_lib::ext_protocol::response(host_id, Ok(Value::Null))
            );
            continue;
        }
        let Some(id) = wire.get("id").and_then(Value::as_u64) else {
            if std::env::var("GGS_TEST_LOGS").is_ok() {
                eprintln!("[log] {}", wire);
            }
            continue; // a `$/log` notification
        };
        let error = wire["error"]["message"].as_str().map(str::to_owned);
        answers[(id - 1) as usize] = Some(match error {
            Some(message) => Err(message),
            None => Ok(wire.get("result").cloned().unwrap_or(Value::Null)),
        });
    }
    answers
        .into_iter()
        .map(|answer| answer.expect("every request answered"))
        .collect()
}

fn initialize() -> Value {
    json!({ "method": "initialize", "params": {
        "protocolVersion": "ggs-ext/1",
        "extensionId": ID,
        "extensionPath": "/nowhere",
        "workspaceFolders": [],
    }})
}

fn run_command(command: &str, args: Value) -> Value {
    json!({ "method": "runCommand", "params": { "command": command, "args": args } })
}

#[test]
fn an_extensionless_main_activates_as_a_frame_program() {
    // VSIX `main` is frequently extension-less (`./out/extension`) — Node and VS Code
    // resolve it with the JavaScript extensions. The bare path failed the frame-program
    // detection's first file read and the package fell back to the non-frame route (no
    // `vscode` shim), so the class of extensions shipping that shape never activated.
    //
    // The shim file the frame program evaluates (the dev layout prepare writes); a
    // checkout without a built shim skips this suite.
    let shim = std::env::var("GGS_VSCODE_SHIM")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("../target/studio/vscode-shim.cjs"));
    if !shim.is_file() {
        eprintln!("skipping: no vscode-shim.cjs built");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[
            (
                "package.json",
                r#"{"name":"bare","publisher":"acme","version":"1.0.0","main":"./out/extension"}"#,
            ),
            (
                "out/extension.js",
                r#"
const vscode = require('vscode');
module.exports.activate = function () {
    vscode.commands.registerCommand('bare.probe', () => 'FRAME');
};
"#,
            ),
        ],
    )
    .join("out/extension"); // the manifest's bare main, exactly as the host receives it

    let (requests_tx, requests_rx) = std::sync::mpsc::channel::<String>();
    let (output_tx, output_rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        git_graph_studio_lib::node_runtime::serve_on(
            entry,
            ChannelReader::from(requests_rx),
            ChannelWriter(output_tx),
        );
    });
    let read_line = || -> String {
        match output_rx.recv_timeout(std::time::Duration::from_secs(60)) {
            Ok(line) => line,
            Err(_) => panic!("the backend fell silent (activation never finished)"),
        }
    };

    let mut next_id = 1u64;
    requests_tx
        .send(git_graph_studio_lib::ext_protocol::request(
            next_id,
            "initialize",
            json!({
                "protocolVersion": "ggs-ext/1",
                "extensionId": "acme.bare",
                "extensionPath": tmp.path().join("pkg").display().to_string(),
                "workspaceFolders": [],
            }),
        ))
        .unwrap();

    // Answers to the activation's own host asks (host.env and friends) keep the frame
    // program running; the handshake's reply is what the loop waits for.
    let handshake;
    loop {
        let line = read_line();
        let Ok(wire) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if wire.get("method").and_then(Value::as_str) == Some("ggs.hostRequest") {
            let id = wire["id"].as_u64().unwrap_or_default();
            let inner = wire["params"]["method"].as_str().unwrap_or_default();
            let answer = if inner == "host.env" {
                json!({ "settings": {}, "language": "en", "state": { "global": {}, "workspace": {} } })
            } else {
                Value::Null
            };
            requests_tx
                .send(git_graph_studio_lib::ext_protocol::response(id, Ok(answer)))
                .unwrap();
            continue;
        }
        if wire["id"].as_u64() == Some(next_id) {
            handshake = wire;
            break;
        }
    }
    assert_eq!(handshake["result"]["protocolVersion"], "ggs-ext/1");

    // The first command orders behind the queued activation (FIFO): its answer is the
    // activation's settlement — and the registered command's handler answering proves
    // the bare main took the frame-program route (the vscode shim came up).
    next_id += 1;
    requests_tx
        .send(git_graph_studio_lib::ext_protocol::request(
            next_id,
            "runCommand",
            json!({ "command": "bare.probe", "args": [] }),
        ))
        .unwrap();
    let answer;
    loop {
        let line = read_line();
        let Ok(wire) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if wire.get("method").and_then(Value::as_str) == Some("ggs.hostRequest") {
            let id = wire["id"].as_u64().unwrap_or_default();
            requests_tx
                .send(git_graph_studio_lib::ext_protocol::response(
                    id,
                    Ok(Value::Null),
                ))
                .unwrap();
            continue;
        }
        if wire["id"].as_u64() == Some(next_id) {
            answer = wire;
            break;
        }
    }
    assert_eq!(
        answer["result"], "FRAME",
        "the extensionless main activated as a frame program: {answer:?}"
    );
}

#[test]
fn a_frame_programs_command_arguments_keep_their_undefined_across_the_json_wire() {
    // The host's `executeCommand` reaches a backend command through JSON at both hops
    // (the invoke, the ggs-ext/1 line), and JSON has no undefined: the placeholder
    // arguments a caller passes (`executeCommand('id', sessionId, undefined, …)` —
    // claude-remote's claudeChatRun, and claude-code's own `void 0` slots) landed as
    // null, and a handler that branches on `viewColumn !== void 0` then took the wrong
    // branch and threw `cannot convert 'null' or 'undefined' to object` in Boa — a
    // phone-started new conversation could never open its tab. The dispatch hands the
    // handler the undefined the caller passed (top level only: a null inside an object
    // is data and stays null).
    //
    // The shim file the bootstrap evaluates for a frame program (the dev layout prepare
    // writes); a checkout without a built shim skips this suite.
    let shim = std::env::var("GGS_VSCODE_SHIM")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("../target/studio/vscode-shim.cjs"));
    if !shim.is_file() {
        eprintln!("skipping: no vscode-shim.cjs built");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[
            (
                "package.json",
                r#"{"name":"args","publisher":"acme","version":"1.0.0","main":"main.js"}"#,
            ),
            (
                "main.js",
                r#"
const vscode = require('vscode');
module.exports.activate = function () {
    vscode.commands.registerCommand('args.probe', function (a, b, c) {
        return JSON.stringify({
            a: a === undefined ? 'undef' : a === null ? 'null' : String(a),
            b: b === undefined ? 'undef' : b === null ? 'null' : String(b),
            inner: c && c.x === null ? 'null-kept' : 'other',
            arity: arguments.length
        });
    });
};
"#,
            ),
        ],
    )
    .join("main.js");

    let (requests_tx, requests_rx) = std::sync::mpsc::channel::<String>();
    let (output_tx, output_rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        git_graph_studio_lib::node_runtime::serve_on(
            entry,
            ChannelReader::from(requests_rx),
            ChannelWriter(output_tx),
        );
    });
    let read_line = || -> String {
        match output_rx.recv_timeout(std::time::Duration::from_secs(60)) {
            Ok(line) => line,
            Err(_) => panic!("the backend fell silent (activation never finished)"),
        }
    };

    let mut next_id = 1u64;
    requests_tx
        .send(git_graph_studio_lib::ext_protocol::request(
            next_id,
            "initialize",
            json!({
                "protocolVersion": "ggs-ext/1",
                "extensionId": "acme.args",
                "extensionPath": tmp.path().join("pkg").display().to_string(),
                "workspaceFolders": [],
            }),
        ))
        .unwrap();
    // The claude-vscode.editor.open shape the host sends: a real value, a placeholder,
    // and an options object carrying a null of its own. The loop answers the activation's
    // own host asks, then takes the handshake.
    let handshake;
    loop {
        let line = read_line();
        let Ok(wire) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if wire.get("method").and_then(Value::as_str) == Some("ggs.hostRequest") {
            let id = wire["id"].as_u64().unwrap_or_default();
            let inner = wire["params"]["method"].as_str().unwrap_or_default();
            let answer = if inner == "host.env" {
                json!({ "settings": {}, "language": "en", "state": { "global": {}, "workspace": {} } })
            } else {
                Value::Null
            };
            requests_tx
                .send(git_graph_studio_lib::ext_protocol::response(id, Ok(answer)))
                .unwrap();
            continue;
        }
        if wire["id"].as_u64() == Some(next_id) {
            handshake = wire;
            break;
        }
    }
    assert_eq!(handshake["result"]["protocolVersion"], "ggs-ext/1");

    next_id += 1;
    requests_tx
        .send(git_graph_studio_lib::ext_protocol::request(
            next_id,
            "runCommand",
            json!({ "command": "args.probe", "args": ["s1", null, { "x": null }] }),
        ))
        .unwrap();
    let answer;
    loop {
        let line = read_line();
        let Ok(wire) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if wire.get("method").and_then(Value::as_str) == Some("ggs.hostRequest") {
            let id = wire["id"].as_u64().unwrap_or_default();
            requests_tx
                .send(git_graph_studio_lib::ext_protocol::response(
                    id,
                    Ok(Value::Null),
                ))
                .unwrap();
            continue;
        }
        if wire["id"].as_u64() == Some(next_id) {
            answer = wire;
            break;
        }
    }
    let seen: Value = serde_json::from_str(
        answer["result"].as_str().expect("the handler answered a string"),
    )
    .expect("the handler answered JSON");
    assert_eq!(seen["a"], "s1", "the real argument arrives as it was");
    assert_eq!(
        seen["b"], "undef",
        "the wire's null arrives as the undefined the caller passed"
    );
    assert_eq!(
        seen["inner"], "null-kept",
        "a null inside an argument object is data, untouched"
    );
    assert_eq!(seen["arity"], 3, "no argument was dropped or added");
}

#[test]
fn a_module_that_throws_is_removed_from_the_require_cache() {
    // Node's loader: a module that throws mid-evaluation is NOT cached — the standard
    // `try { require('dep') } catch {}` availability probe must be able to retry, and a
    // retry must throw again instead of answering the pre-evaluation partial exports.
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[
            (
                "package.json",
                r#"{"name":"probe","publisher":"acme","version":"1.0.0","main":"main.js"}"#,
            ),
            (
                "main.js",
                r#"
let first = 'no-throw';
try { require('./flaky'); } catch (e) { first = 'threw'; }
let second;
try {
    const m = require('./flaky');
    second = 'cached:' + JSON.stringify(m);
} catch (e) { second = 'threw'; }
module.exports = { dispatch: (command) => (command === 'probe' ? { first, second } : null) };
"#,
            ),
            ("package2.json", r#"{}"#),
            (
                "flaky/package.json",
                r#"{"name":"flaky","main":"index.js"}"#,
            ),
            (
                "flaky/index.js",
                "exports.started = true; throw new Error('boom');",
            ),
        ],
    )
    .join("main.js");

    let answers = serve(entry, &[initialize(), run_command("probe", json!([]))]);
    let result = answers[1].clone().expect("the probe answers");
    assert_eq!(result["first"], "threw", "the first require throws");
    assert_eq!(
        result["second"], "threw",
        "the retry throws again instead of answering the cached partial exports"
    );
}

#[test]
fn a_frame_program_serves_its_content_provider_at_the_hosts_provide_call() {
    // The shim file the bootstrap evaluates for a frame program (the dev layout prepare
    // writes); a CI checkout without a built shim skips this suite.
    let shim = std::env::var("GGS_VSCODE_SHIM")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("../target/studio/vscode-shim.cjs"));
    if !shim.is_file() {
        eprintln!("skipping: no vscode-shim.cjs built");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[
            (
                "package.json",
                r#"{"name":"provider","publisher":"acme","version":"1.0.0","main":"main.js"}"#,
            ),
            (
                "main.js",
                r#"
const vscode = require('vscode');
vscode.workspace.registerTextDocumentContentProvider('ggsfix', {
    provideTextDocumentContent(uri) { return 'CONTENT:' + uri.path; }
});
"#,
            ),
        ],
    )
    .join("main.js");

    let (requests_tx, requests_rx) = std::sync::mpsc::channel::<String>();
    let (output_tx, output_rx) = std::sync::mpsc::channel::<String>();
    let serve = std::thread::spawn(move || {
        git_graph_studio_lib::node_runtime::serve_on(
            entry,
            ChannelReader::from(requests_rx),
            ChannelWriter(output_tx),
        );
    });

    let mut next_id = 1u64;
    requests_tx
        .send(git_graph_studio_lib::ext_protocol::request(
            next_id,
            "initialize",
            json!({
                "protocolVersion": "ggs-ext/1",
                "extensionId": "acme.provider",
                "extensionPath": tmp.path().join("pkg").display().to_string(),
                "workspaceFolders": [],
            }),
        ))
        .unwrap();

    let answer_host_request = |inner: &str| -> Value {
        match inner {
            "host.env" => json!({
                "settings": {},
                "language": "en",
                "appVersion": "0.1.5-test",
                "themeKind": 2,
                "state": { "global": {}, "workspace": {} }
            }),
            _ => Value::Null,
        }
    };
    let read_line = || -> String {
        let raw = match output_rx.recv_timeout(std::time::Duration::from_secs(60)) {
            Ok(line) => line,
            Err(_) => panic!("the backend fell silent (activation never finished)"),
        };
        eprintln!("[wire-in] {}", raw.trim());
        raw
    };

    // 1. The handshake: the bootstrap installs the shim, the entry registers the provider,
    //    and activation settles.
    let handshake;
    loop {
        let line = read_line();
        let Ok(wire) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if wire.get("method").and_then(Value::as_str) == Some("ggs.hostRequest") {
            let id = wire["id"].as_u64().unwrap_or_default();
            let inner = wire["params"]["method"].as_str().unwrap_or_default();
            requests_tx
                .send(git_graph_studio_lib::ext_protocol::response(
                    id,
                    Ok(answer_host_request(inner)),
                ))
                .unwrap();
            continue;
        }
        if wire["id"].as_u64() == Some(next_id) {
            handshake = wire;
            break;
        }
    }
    assert_eq!(
        handshake["result"]["protocolVersion"], "ggs-ext/1",
        "{handshake:?}"
    );

    // 2. The host's provide call: the registered provider's text crosses whole.
    next_id += 1;
    let requested = next_id;
    requests_tx
        .send(git_graph_studio_lib::ext_protocol::request(
            requested,
            "docProvider.provide",
            json!({ "args": [{ "scheme": "ggsfix", "path": "x", "fsPath": "x" }] }),
        ))
        .unwrap();
    let answered;
    loop {
        let line = read_line();
        let Ok(wire) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if wire.get("method").and_then(Value::as_str) == Some("ggs.hostRequest") {
            let id = wire["id"].as_u64().unwrap_or_default();
            requests_tx
                .send(git_graph_studio_lib::ext_protocol::response(
                    id,
                    Ok(Value::Null),
                ))
                .unwrap();
            continue;
        }
        if wire["id"].as_u64() == Some(requested) {
            answered = Some(wire);
            break;
        }
    }
    let answer = answered.unwrap();
    assert_eq!(
        answer["result"],
        json!("CONTENT:x"),
        "the provider's text crosses whole"
    );
    // EOF by hangup, not by the reader's 60 s idle timeout.
    drop(requests_tx);
    let _ = serve.join();
}

/// A package reading its own provider-scheme document (claude-code's chat opening a tool
/// output: `openTextDocument` then `showTextDocument` on its `_claude_vscode_fs_readonly`
/// Uri) never crosses the host bridge for the text. The ggs-node bridge parks the one JS
/// thread inside every host request until its answer crosses back, and the workbench's
/// answer for `docProvider.read` is a `docProvider.provide` call back into this same
/// process - a request that can only run on the parked thread (the `vscode.diff`
/// reentry deadlock class). The local read breaks the circle: the text comes from this
/// side's own registration, and the tab open rides `workspace.openContentTab` with the
/// text in its arguments, which the host answers without calling back.
#[test]
fn an_own_scheme_read_opens_the_content_tab_without_the_host_round_trip() {
    // The shim file the bootstrap evaluates for a frame program (the dev layout prepare
    // writes); a CI checkout without a built shim skips this suite.
    let shim = std::env::var("GGS_VSCODE_SHIM")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("../target/studio/vscode-shim.cjs"));
    if !shim.is_file() {
        eprintln!("skipping: no vscode-shim.cjs built");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[
            (
                "package.json",
                r#"{"name":"chatview","publisher":"acme","version":"1.0.0","main":"main.js"}"#,
            ),
            (
                "main.js",
                r#"
const vscode = require('vscode');
vscode.workspace.registerTextDocumentContentProvider('chatout', {
    provideTextDocumentContent(uri) { return 'the tool output\n'; }
});
vscode.commands.registerCommand('chat.openOutput', async () => {
    const uri = vscode.Uri.from({ scheme: 'chatout', path: '/temp/readonly/Bash tool output (ab12cd)' });
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
    return doc.getText();
});
"#,
            ),
        ],
    )
    .join("main.js");

    let (requests_tx, requests_rx) = std::sync::mpsc::channel::<String>();
    let (output_tx, output_rx) = std::sync::mpsc::channel::<String>();
    let serve = std::thread::spawn(move || {
        git_graph_studio_lib::node_runtime::serve_on(
            entry,
            ChannelReader::from(requests_rx),
            ChannelWriter(output_tx),
        );
    });

    let mut next_id = 1u64;
    requests_tx
        .send(git_graph_studio_lib::ext_protocol::request(
            next_id,
            "initialize",
            json!({
                "protocolVersion": "ggs-ext/1",
                "extensionId": "acme.chatview",
                "extensionPath": tmp.path().join("pkg").display().to_string(),
                "workspaceFolders": [],
            }),
        ))
        .unwrap();

    let mut opened_tab: Option<Value> = None;
    let read_line = || -> String {
        let raw = match output_rx.recv_timeout(std::time::Duration::from_secs(60)) {
            Ok(line) => line,
            Err(_) => panic!("the backend fell silent (the flow never finished)"),
        };
        eprintln!("[wire-in] {}", raw.trim());
        raw
    };
    // Every `ggs.hostRequest` the flow crosses is answered here - and `docProvider.read`
    // never may be among them: the workbench's answer for it is a call back into this
    // same parked JS thread.
    let answer_host_request = |wire: &Value,
                               opened_tab: &mut Option<Value>|
     -> Result<Value, String> {
        let inner = wire["params"]["method"].as_str().unwrap_or_default();
        assert_ne!(
                inner, "docProvider.read",
                "an own-scheme read must be answered by this side's own registration, not the host round-trip whose answer reenters the parked JS thread"
            );
        match inner {
            "host.env" => Ok(json!({
                "settings": {},
                "language": "en",
                "appVersion": "0.1.5-test",
                "themeKind": 2,
                "state": { "global": {}, "workspace": {} }
            })),
            "workspace.openContentTab" => {
                *opened_tab = Some(wire["params"]["args"].clone());
                Ok(Value::Null)
            }
            _ => Ok(Value::Null),
        }
    };

    // 1. The handshake: the bootstrap installs the shim, the entry registers the provider
    //    and the command, and activation settles.
    loop {
        let line = read_line();
        let Ok(wire) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if wire.get("method").and_then(Value::as_str) == Some("ggs.hostRequest") {
            let id = wire["id"].as_u64().unwrap_or_default();
            let answer = answer_host_request(&wire, &mut opened_tab);
            requests_tx
                .send(git_graph_studio_lib::ext_protocol::response(id, answer))
                .unwrap();
            continue;
        }
        if wire["id"].as_u64() == Some(next_id) {
            assert_eq!(wire["result"]["protocolVersion"], "ggs-ext/1", "{wire:?}");
            break;
        }
    }

    // 2. The click's flow: the command opens the package's own provider scheme and shows
    //    it - locally read, and the tab request carries the text and the beside
    //    placement in its arguments.
    next_id += 1;
    let clicked = next_id;
    requests_tx
        .send(git_graph_studio_lib::ext_protocol::request(
            clicked,
            "runCommand",
            json!({ "command": "chat.openOutput", "args": [] }),
        ))
        .unwrap();
    let command_answer = loop {
        let line = read_line();
        let Ok(wire) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if wire.get("method").and_then(Value::as_str) == Some("ggs.hostRequest") {
            let id = wire["id"].as_u64().unwrap_or_default();
            let answer = answer_host_request(&wire, &mut opened_tab);
            requests_tx
                .send(git_graph_studio_lib::ext_protocol::response(id, answer))
                .unwrap();
            continue;
        }
        if wire["id"].as_u64() == Some(clicked) {
            break wire["error"]["message"]
                .as_str()
                .map(str::to_owned)
                .map(Err)
                .unwrap_or(Ok(wire.get("result").cloned().unwrap_or(Value::Null)));
        }
    };
    assert_eq!(
        command_answer,
        Ok(json!("the tool output\n")),
        "the document was read from this side's own registration"
    );
    assert_eq!(
        opened_tab,
        Some(json!([
            "Bash tool output (ab12cd)",
            "/temp/readonly/Bash tool output (ab12cd)",
            "the tool output\n",
            "beside"
        ])),
        "the content tab carries the provider's text and the beside placement"
    );
    // EOF by hangup, not by the reader's 60 s idle timeout.
    drop(requests_tx);
    let _ = serve.join();
}

/// The handshake no longer waits out a frame program's activation (a multi-megabyte
/// bundle's parse-and-compile is seconds on the interpreter): `initialize` answers the
/// moment the protocol loop can, the activation runs as the next job on the same JS
/// thread, and every request that arrives meanwhile orders behind it. The entry's
/// activation here parks on a `commands.execute` host request the test holds — the
/// handshake must cross while the activation is parked (it cannot settle before the held
/// answer), a command sent during the park stays unanswered, and it answers the moment
/// the release lets the activation register its handler.
#[test]
fn the_handshake_answers_before_the_frame_programs_activation_settles() {
    // The shim file the activation job evaluates for a frame program (the dev layout
    // prepare writes); a CI checkout without a built shim skips this suite.
    let shim = std::env::var("GGS_VSCODE_SHIM")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("../target/studio/vscode-shim.cjs"));
    if !shim.is_file() {
        eprintln!("skipping: no vscode-shim.cjs built");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[
            (
                "package.json",
                r#"{"name":"hold","publisher":"acme","version":"1.0.0","main":"main.js"}"#,
            ),
            (
                "main.js",
                r#"
const vscode = require('vscode');
module.exports.activate = function () {
    return vscode.commands.executeCommand('probe.hold').then(() => {
        vscode.commands.registerCommand('probe.ready', () => 'READY');
    });
};
"#,
            ),
        ],
    )
    .join("main.js");

    let (requests_tx, requests_rx) = std::sync::mpsc::channel::<String>();
    let (output_tx, output_rx) = std::sync::mpsc::channel::<String>();
    let serve = std::thread::spawn(move || {
        git_graph_studio_lib::node_runtime::serve_on(
            entry,
            ChannelReader::from(requests_rx),
            ChannelWriter(output_tx),
        );
    });

    let mut next_id = 1u64;
    requests_tx
        .send(git_graph_studio_lib::ext_protocol::request(
            next_id,
            "initialize",
            json!({
                "protocolVersion": "ggs-ext/1",
                "extensionId": "acme.hold",
                "extensionPath": tmp.path().join("pkg").display().to_string(),
                "workspaceFolders": [],
            }),
        ))
        .unwrap();

    let read_line = || -> String {
        match output_rx.recv_timeout(std::time::Duration::from_secs(60)) {
            Ok(line) => line,
            Err(_) => panic!("the backend fell silent (the held activation never finished)"),
        }
    };

    // Phase 1 — the handshake crosses BEFORE the activation can settle: the entry's
    // activation is parked on the probe.hold request this test holds unanswered until
    // phase 4, so a handshake-blocking activation could never have answered here.
    let handshake;
    loop {
        let line = read_line();
        let Ok(wire) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if wire.get("method").and_then(Value::as_str) == Some("ggs.hostRequest") {
            let id = wire["id"].as_u64().unwrap_or_default();
            let answer = match wire["params"]["method"].as_str().unwrap_or_default() {
                "host.env" => json!({
                    "settings": {},
                    "language": "en",
                    "state": { "global": {}, "workspace": {} }
                }),
                _ => Value::Null,
            };
            requests_tx
                .send(git_graph_studio_lib::ext_protocol::response(id, Ok(answer)))
                .unwrap();
            continue;
        }
        if wire["id"].as_u64() == Some(next_id) {
            handshake = wire;
            break;
        }
    }
    assert_eq!(
        handshake["result"]["protocolVersion"], "ggs-ext/1",
        "the handshake answered while the activation was still parked: {handshake:?}"
    );

    // Phase 2 — the parked activation announces itself: the probe.hold host request
    // arrives (the activation job runs), and this test is what holds it.
    let held;
    loop {
        let line = read_line();
        let Ok(wire) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if wire.get("method").and_then(Value::as_str) == Some("ggs.hostRequest") {
            let id = wire["id"].as_u64().unwrap_or_default();
            let inner = wire["params"]["method"].as_str().unwrap_or_default();
            if inner == "commands.execute"
                && wire["params"]["args"][0].as_str() == Some("probe.hold")
            {
                held = id;
                break;
            }
            requests_tx
                .send(git_graph_studio_lib::ext_protocol::response(
                    id,
                    Ok(Value::Null),
                ))
                .unwrap();
            continue;
        }
    }

    // A command dispatched during the park: it queues behind the activation job and must
    // not answer until the release registers its handler.
    next_id += 1;
    let ready_id = next_id;
    requests_tx
        .send(git_graph_studio_lib::ext_protocol::request(
            ready_id,
            "runCommand",
            json!({ "command": "probe.ready", "args": [] }),
        ))
        .unwrap();
    // Silence while parked is the expected outcome; any line that does cross must not be
    // the queued command's answer.
    if let Ok(line) = output_rx.recv_timeout(std::time::Duration::from_millis(500)) {
        let wire: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        assert_ne!(
            wire["id"].as_u64(),
            Some(ready_id),
            "the command answered before the activation settled: {wire:?}"
        );
    }

    // The release: the activation settles, registers probe.ready, and the queued command
    // answers through it.
    requests_tx
        .send(git_graph_studio_lib::ext_protocol::response(
            held,
            Ok(Value::Null),
        ))
        .unwrap();
    let answered;
    loop {
        let line = read_line();
        let Ok(wire) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if wire.get("method").and_then(Value::as_str) == Some("ggs.hostRequest") {
            let id = wire["id"].as_u64().unwrap_or_default();
            requests_tx
                .send(git_graph_studio_lib::ext_protocol::response(
                    id,
                    Ok(Value::Null),
                ))
                .unwrap();
            continue;
        }
        if wire["id"].as_u64() == Some(ready_id) {
            answered = wire;
            break;
        }
    }
    assert_eq!(
        answered["result"],
        json!("READY"),
        "the queued command ran through the handler the release registered"
    );
    // EOF by hangup, not by the reader's 60 s idle timeout.
    drop(requests_tx);
    let _ = serve.join();
}

#[test]
fn a_package_main_answers_commands_through_ggs_on_request() {
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[
            (
                "main.js",
                r#"
const fs = require('fs');
const path = require('path');
ggs.onRequest((command, args) => {
    if (command === 'ping') return { pong: true, args };
    if (command === 'readSelf') {
        return { text: fs.readFileSync(path.join(__dirname, 'data.txt'), 'utf8') };
    }
    if (command === 'timer') {
        return new Promise((resolve) => setTimeout(() => resolve({ ticked: true }), 10));
    }
    if (command === 'async') return Promise.resolve({ later: true });
    if (command === 'dateLocale') {
        // Boa leaves Date's toLocale* family unimplemented; the prelude replaces each with
        // the shape of its non-locale sibling. A package formatting timestamps (git-graph-rs's
        // commit search) must get a string, never the native `Function Unimplemented` throw.
        return {
            full: new Date(1790394575000).toLocaleString(),
            date: new Date(1790394575000).toLocaleDateString(),
            time: new Date(1790394575000).toLocaleTimeString()
        };
    }
    return { unknown: command };
});
"#,
            ),
            ("data.txt", "from the package's own file"),
        ],
    )
    .join("main.js");

    let answers = serve(
        entry,
        &[
            initialize(),
            run_command("ping", json!([7])),
            run_command("readSelf", json!([])),
            run_command("timer", json!([])),
            run_command("async", json!([])),
            run_command("dateLocale", json!([])),
            run_command("nobody", json!([])),
        ],
    );
    assert_eq!(answers.len(), 7, "{answers:?}");
    let handshake = answers[0].as_ref().unwrap();
    assert_eq!(handshake["protocolVersion"], "ggs-ext/1");
    assert_eq!(handshake["capabilities"]["commands"], json!([]));
    assert_eq!(answers[1].as_ref().unwrap()["pong"], json!(true));
    assert_eq!(answers[1].as_ref().unwrap()["args"], json!([7]));
    assert_eq!(
        answers[2].as_ref().unwrap()["text"],
        json!("from the package's own file")
    );
    // A promise settled by a timer: the runtime pumped microtasks and timers to answer.
    assert_eq!(answers[3].as_ref().unwrap()["ticked"], json!(true));
    assert_eq!(answers[4].as_ref().unwrap()["later"], json!(true));
    let locale = answers[5].as_ref().unwrap();
    for key in ["full", "date", "time"] {
        let text = locale[key]
            .as_str()
            .unwrap_or_else(|| panic!("{key} is not a string"));
        assert!(
            text.chars().any(|c| c.is_ascii_digit()) && !text.contains("Unimplemented"),
            "the {key} locale shape must be a real timestamp: {text}"
        );
    }
    assert_eq!(answers[6].as_ref().unwrap()["unknown"], json!("nobody"));
}

#[test]
fn os_network_interfaces_list_the_lans_addresses() {
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[(
            "main.js",
            r#"
const os = require('os');
const groups = os.networkInterfaces();
const flat = [];
for (const name of Object.keys(groups)) for (const entry of groups[name]) flat.push(entry);
ggs.onRequest((command) => {
    if (command !== 'report') return { unknown: command };
    return {
        groups: Object.keys(groups).length,
        records: flat.length,
        // Node's field set on every record (the pairing QR reads address/family/internal).
        everyRecordNodeShaped: flat.every((e) =>
            typeof e.address === 'string' &&
            (e.family === 'IPv4' || e.family === 'IPv6') &&
            typeof e.netmask === 'string' &&
            typeof e.internal === 'boolean' &&
            typeof e.cidr === 'string' && e.cidr.includes('/')),
        hasLoopback: flat.some((e) => e.internal === true && (e.address === '127.0.0.1' || e.address === '::1'))
    };
});
"#,
        )],
    )
    .join("main.js");

    let answers = serve(entry, &[initialize(), run_command("report", json!([]))]);
    assert_eq!(answers.len(), 2, "{answers:?}");
    let report = answers[1].as_ref().unwrap();
    assert!(
        report["groups"].as_u64().unwrap_or(0) >= 1,
        "at least one interface group: {report}"
    );
    assert_eq!(report["everyRecordNodeShaped"], json!(true), "{report}");
    assert_eq!(
        report["hasLoopback"],
        json!(true),
        "loopback present and marked internal: {report}"
    );
}

#[test]
fn an_entry_dispatch_export_answers_without_a_registered_handler() {
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[(
            "main.js",
            "module.exports.dispatch = (command, message) => ({ command, message });",
        )],
    )
    .join("main.js");
    let answers = serve(
        entry,
        &[initialize(), run_command("hello", json!([{ "x": 1 }]))],
    );
    assert_eq!(answers.len(), 2, "{answers:?}");
    assert_eq!(
        answers[1].as_ref().unwrap(),
        &json!({ "command": "hello", "message": { "x": 1 } })
    );
}

#[test]
fn a_manifest_launcher_answers_open_page_through_the_runtime() {
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[
            ("main.js", "ggs.onRequest(() => ({ never: true }));"),
            (
                "manifest.json",
                r#"{"activitybar":{"command":"acme.js-demo.view","page":"view"}}"#,
            ),
        ],
    )
    .join("main.js");
    let answers = serve(
        entry,
        &[
            initialize(),
            run_command("acme.js-demo.view", json!([{ "repo": "/somewhere" }])),
        ],
    );
    assert_eq!(answers.len(), 2, "{answers:?}");
    let handshake = answers[0].as_ref().unwrap();
    assert_eq!(
        handshake["capabilities"]["commands"],
        json!(["acme.js-demo.view"])
    );
    assert_eq!(
        answers[1].as_ref().unwrap(),
        &json!({ "openPage": "view", "params": { "repo": "/somewhere" } })
    );
}

/// The whole chain as the app drives it: install a VSIX whose JS entry and native binary
/// derive a backend, let the process host spawn the bundled sidecar, shake hands, run a command, stop.
#[test]
fn the_process_host_runs_a_ggs_node_backend_end_to_end() {
    // The host the `node` backend resolves beside the app's binary: cargo built this test
    // binary alongside the sidecar (`required-features` are satisfied under --all-features).
    let sidecar = PathBuf::from(env!("CARGO_BIN_EXE_ggs-node"));
    std::env::set_var("GGS_ENGINE_HOST", sidecar.parent().unwrap());

    let tmp = tempfile::tempdir().unwrap();
    let exts = tmp.path().join("extensions");
    std::fs::create_dir_all(&exts).unwrap();
    let vsix = tmp.path().join("js-demo.vsix");
    let file = std::fs::File::create(&vsix).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    zip.start_file("extension/package.json", options).unwrap();
    zip.write_all(br#"{"name":"js-demo","publisher":"acme","version":"1.0.0","main":"out/main.js","native":{"win32-x64-msvc":"engine.node"},"contributes":{"commands":[{"command":"acme.js-demo.view","title":"View"}]}}"#).unwrap();
    zip.start_file("extension/engine.node", options).unwrap();
    zip.write_all(b"engine-node-fixture").unwrap();
    zip.start_file("extension/out/main.js", options).unwrap();
    zip.write_all(
        br#"
const fs = require('fs');
const path = require('path');
ggs.onRequest((command, args) => {
    if (command === 'acme.js-demo.view') return { opened: true, params: args[0] };
    if (command === 'readSelf') {
        return { text: fs.readFileSync(path.join(__dirname, 'note.txt'), 'utf8') };
    }
    return { unknown: command };
});
"#,
    )
    .unwrap();
    zip.start_file("extension/out/note.txt", options).unwrap();
    zip.write_all(b"served by the pretend runtime").unwrap();
    zip.start_file("extension/web/view.html", options).unwrap();
    zip.write_all(b"<html><body></body></html>").unwrap();
    zip.finish().unwrap();
    let info = git_graph_studio_lib::cmd_ext::install_from_vsix_into(&exts, &vsix, false).unwrap();

    let state = ProcessHostState::default();
    let started = state.start(&exts, ID).unwrap();
    assert_eq!(started.protocol_version, "ggs-ext/1");
    // No special manifest fields any more: the backend's command list comes from the
    // package's standard `contributes.commands`.
    assert_eq!(
        started.commands,
        vec!["acme.js-demo.view".to_owned()],
        "{started:?}"
    );
    let _ = info;

    // The package's own handler answers its declared commands.
    let read = state.run(&exts, ID, "readSelf", json!([])).unwrap();
    assert_eq!(read["text"], json!("served by the pretend runtime"));

    state.stop(ID).unwrap();
}

/// The engine `.node` of the git-graph-rs layout: the submodule's own prebuilt first, then
/// an installed package's. `None` when neither is on the machine (the test skips).
fn engine_node() -> Option<PathBuf> {
    let submodule = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../vscode-git-graph-rs/native/win32-x64-msvc/git-graph.node");
    if cfg!(windows) && submodule.is_file() {
        return Some(submodule);
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let platform = if cfg!(windows) {
        "win32-x64-msvc"
    } else if cfg!(target_os = "macos") {
        "darwin-arm64"
    } else {
        "linux-x64-gnu"
    };
    std::fs::read_dir(PathBuf::from(home).join(".ggs/extensions"))
        .ok()?
        .flatten()
        .map(|entry| {
            entry
                .path()
                .join("native")
                .join(platform)
                .join("git-graph.node")
        })
        .find(|candidate| candidate.is_file())
}

/// A NAPI addon under ggs-node: the package's JS requires the engine `.node` by absolute
/// path (git-graph-rs's own `loadAddon` shape), the addon registers against the N-API
/// host, and its async exports settle through the threadsafe-function drain while the
/// runtime answers `runCommand` — a sync export, an async one, and an in-band rejection.
#[test]
fn a_napi_addon_loads_and_answers_under_ggs_node() {
    let Some(engine) = engine_node() else {
        eprintln!("skipping: no git-graph engine .node on this machine");
        return;
    };
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let tmp = tempfile::tempdir().unwrap();
    let main = format!(
        r#"
const addon = require({engine});
ggs.onRequest((command) => {{
    if (command === 'version') return {{ version: addon.engineVersion() }};
    if (command === 'open') return addon.openRepository({repo}).then((root) => ({{ root }}));
    if (command === 'request') {{
        // The dev fixture's generic dispatch surface; a marketplace engine build carries
        // named exports only, and the async settle is `open`'s and `reject`'s to prove.
        if (typeof addon.request !== 'function') return {{ skipped: true }};
        return addon.request('', JSON.stringify({{ method: 'engineVersion', params: {{}} }}))
            .then((answer) => ({{ answer }}));
    }}
    if (command === 'reject') {{
        return addon.openRepository({missing}).then(
            () => ({{ rejected: false }}),
            (error) => ({{ rejected: true, message: String(error && error.message) }}));
    }}
    return null;
}});
"#,
        engine = serde_json::to_string(&engine.to_string_lossy()).unwrap(),
        repo = serde_json::to_string(&repo.to_string_lossy()).unwrap(),
        missing = serde_json::to_string(&tmp.path().join("not-a-repo").to_string_lossy()).unwrap(),
    );
    let entry = make_package(tmp.path(), &[("main.js", &main)]).join("main.js");
    let answers = serve(
        entry,
        &[
            initialize(),
            run_command("version", json!([])),
            run_command("request", json!([])),
            run_command("open", json!([])),
            run_command("reject", json!([])),
        ],
    );
    assert_eq!(answers.len(), 5, "{answers:?}");
    let version = answers[1].as_ref().unwrap()["version"]
        .as_str()
        .unwrap_or("");
    assert!(
        version.starts_with("1."),
        "the sync export answered: {answers:?}"
    );
    let answer = answers[2].as_ref().unwrap();
    assert!(
        answer.get("skipped").is_some()
            || answer["answer"]
                .as_str()
                .is_some_and(|text| text.contains(version)),
        "the async request settled: {answers:?}"
    );
    let root = answers[3].as_ref().unwrap()["root"].as_str().unwrap_or("");
    assert!(
        !root.is_empty(),
        "openRepository resolved the repository root: {answers:?}"
    );
    assert_eq!(
        answers[4].as_ref().unwrap()["rejected"],
        json!(true),
        "a non-repository rejects the promise: {answers:?}"
    );
}

/* ---------- the installed git-graph-rs extension, activated under ggs-node ---------- */

/// A reader the test feeds lines into (requests in, and the answers to the backend's own
/// `ggs.hostRequest`s) - blocking, line-granular.
struct ChannelReader {
    lines: std::sync::mpsc::Receiver<String>,
    buffer: Vec<u8>,
    position: usize,
}

impl ChannelReader {
    fn from(lines: std::sync::mpsc::Receiver<String>) -> Self {
        ChannelReader {
            lines,
            buffer: Vec::new(),
            position: 0,
        }
    }
}

impl std::io::Read for ChannelReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        use std::io::BufRead as _;
        let available = self.fill_buf()?;
        let take = available.len().min(out.len());
        out[..take].copy_from_slice(&available[..take]);
        self.consume(take);
        Ok(take)
    }
}

impl std::io::BufRead for ChannelReader {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        while self.position >= self.buffer.len() {
            match self.lines.recv_timeout(std::time::Duration::from_secs(60)) {
                Ok(line) => {
                    self.buffer = format!("{line}\n").into_bytes();
                    self.position = 0;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::WouldBlock,
                        "no more lines within 60 s",
                    ));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    self.buffer = Vec::new();
                    self.position = 0;
                    break;
                }
            }
        }
        Ok(&self.buffer[self.position..])
    }

    fn consume(&mut self, amount: usize) {
        self.position += amount;
    }
}

/// A writer that forwards every line to the test's channel.
struct ChannelWriter(std::sync::mpsc::Sender<String>);

impl std::io::Write for ChannelWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let text = String::from_utf8_lossy(bytes).into_owned();
        let _ = self.0.send(text);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The whole extension over the wire, the way the process host drives it: the `initialize`
/// handshake runs the frame-program bootstrap (the vscode shim installs, the entry
/// `require`s `vscode`, its `activate` settles), every `ggs.hostRequest` the activation
/// makes is answered, and a command registered by the activated extension answers -
/// `git-graph-rs.version`, whose CommandManager is constructed at the very end of
/// `activate`. The engine `.node` loads inside that activation (`require` of
/// `native/<platform>/git-graph.node` through this process's N-API host).
#[test]
fn the_installed_git_graph_extension_activates_under_ggs_node() {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap();
    let package = std::fs::read_dir(PathBuf::from(&home).join(".ggs/extensions"))
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("neophack.git-graph-rs"))
                && path.join("out/extension.js").is_file()
                && path.join("manifest.json").is_file()
        });
    let Some(package) = package else {
        eprintln!("skipping: no installed git-graph-rs package");
        return;
    };
    let shim = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/studio/vscode-shim.cjs");
    if !shim.is_file() {
        eprintln!("skipping: no compiled vscode shim at {}", shim.display());
        return;
    }
    std::env::set_var("GGS_VSCODE_SHIM", &shim);
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");

    let (requests_tx, requests_rx) = std::sync::mpsc::channel::<String>();
    let (output_tx, output_rx) = std::sync::mpsc::channel::<String>();
    let entry = package.join("out/extension.js");
    let serve = std::thread::spawn(move || {
        git_graph_studio_lib::node_runtime::serve_on(
            entry,
            ChannelReader::from(requests_rx),
            ChannelWriter(output_tx),
        );
    });

    let mut next_id = 1u64;
    requests_tx
        .send(git_graph_studio_lib::ext_protocol::request(
            next_id,
            "initialize",
            json!({
                "protocolVersion": "ggs-ext/1",
                "extensionId": "neophack.git-graph-rs",
                "extensionPath": package.display().to_string(),
                "workspaceFolders": [repo.display().to_string()],
            }),
        ))
        .unwrap();

    // The answers a workbench would give, minimal but shape-true. `host.env` feeds the
    // shim's context; everything else (window.*, workspace.*) answers null.
    let answer_host_request = |inner: &str| -> Value {
        match inner {
            "host.env" => json!({
                "settings": {},
                "language": "en",
                "appVersion": "0.1.5-test",
                "themeKind": 2,
                "state": { "global": {}, "workspace": {} }
            }),
            _ => Value::Null,
        }
    };
    let mut version_message = String::new();
    let read_line = || -> String {
        match output_rx.recv_timeout(std::time::Duration::from_secs(60)) {
            Ok(line) => {
                if std::env::var("GGS_TRACE_WIRE").is_ok() {
                    eprintln!("[wire] {line}");
                }
                line
            }
            Err(_) => panic!("the backend fell silent (activation never finished)"),
        }
    };

    // 1. The handshake - inside it, the whole frame-program bootstrap runs.
    let handshake;
    loop {
        let line = read_line();
        let Ok(wire) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if wire.get("method").and_then(Value::as_str) == Some("ggs.hostRequest") {
            let id = wire["id"].as_u64().unwrap_or_default();
            let inner = wire["params"]["method"].as_str().unwrap_or_default();
            requests_tx
                .send(git_graph_studio_lib::ext_protocol::response(
                    id,
                    Ok(answer_host_request(inner)),
                ))
                .unwrap();
            continue;
        }
        if wire["id"].as_u64() == Some(next_id) {
            handshake = wire;
            break;
        }
    }
    assert_eq!(
        handshake["result"]["protocolVersion"], "ggs-ext/1",
        "{handshake:?}"
    );

    // 2. A command the activated extension registered - the CommandManager whose
    //    construction closes `activate`. Its answer proves the whole program ran.
    next_id += 1;
    let requested = next_id;
    requests_tx
        .send(git_graph_studio_lib::ext_protocol::request(
            requested,
            "runCommand",
            json!({ "command": "git-graph-rs.version", "args": [] }),
        ))
        .unwrap();
    let mut answered = None;
    loop {
        // The extension's command wrapper does not return the handler's promise: the
        // command answers at once and the message follows once `version()`'s own async
        // reads settle, so the loop serves host requests until both have crossed.
        if answered.is_some() && !version_message.is_empty() {
            break;
        }
        let line = read_line();
        let Ok(wire) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if wire.get("method").and_then(Value::as_str) == Some("ggs.hostRequest") {
            let id = wire["id"].as_u64().unwrap_or_default();
            let inner = wire["params"]["method"].as_str().unwrap_or_default();
            if inner == "notify" || inner.starts_with("window.show") {
                // The version command's information message (`notify`, args [level, text,
                // items]) - the text names the version.
                let at = if inner == "notify" { 1 } else { 0 };
                if let Some(text) = wire["params"]["args"][at].as_str() {
                    version_message = text.to_owned();
                }
            }
            requests_tx
                .send(git_graph_studio_lib::ext_protocol::response(
                    id,
                    Ok(answer_host_request(inner)),
                ))
                .unwrap();
            continue;
        }
        if wire["id"].as_u64() == Some(requested) {
            answered = Some(wire);
        }
    }
    let answered = answered.expect("the version command answered");
    assert!(
        answered.get("result").is_some(),
        "the activated extension answered git-graph-rs.version: {answered:?}"
    );
    assert!(
        !version_message.is_empty(),
        "the version message crossed as a host request"
    );
    eprintln!("version message: {version_message}");
    // The message is the activated program's own: its version line and the git it found
    // through a real child process (an empty version meant the pipe output was lost).
    assert!(
        version_message.contains("Git Graph RS:") && version_message.contains("Git: 2."),
        "{version_message}"
    );

    drop(requests_tx);
    let _ = serve.join();
}

/// The Node surfaces a real extension leans on, each one a bug git-graph-rs hit under
/// ggs-node: the callback `fs` API with Stats objects and `error.code`, fd reads and read
/// streams, `Buffer.from(ArrayBuffer)`, a child's stdout crossing before its exit (the
/// pipe data used to be dropped, reading `git --version` as empty), and a command result
/// carrying `undefined` members (Boa's own to_json panicked the JS thread on them).
#[test]
fn the_node_surfaces_extensions_use_behave_like_node() {
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[
            (
                "main.js",
                r#"
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const data = path.join(__dirname, 'data.txt');
ggs.onRequest(async (command) => {
    if (command === 'fs') {
        const stat = fs.statSync(data);
        const viaCallback = await new Promise((resolve) => fs.readFile(data, 'utf8', (error, text) => resolve(error ? 'ERR' : text)));
        const missing = await new Promise((resolve) => fs.stat(path.join(__dirname, 'nope'), (error) => resolve(error && error.code)));
        const rejected = await fs.promises.readFile(path.join(__dirname, 'nope')).catch((error) => error.code);
        const fd = fs.openSync(data);
        const head = Buffer.alloc(4);
        const read = fs.readSync(fd, head, 0, 4, 5);
        fs.closeSync(fd);
        const streamed = await new Promise((resolve) => {
            const chunks = [];
            fs.createReadStream(data, { highWaterMark: 3 }).on('data', (chunk) => chunks.push(chunk.toString())).on('end', () => resolve(chunks));
        });
        const realpath = await new Promise((resolve) => fs.realpath.native(data, (error, resolved) => resolve(!error && typeof resolved === 'string')));
        return { isFile: stat.isFile(), isDirectory: stat.isDirectory(), size: stat.size, viaCallback, missing, rejected, read, head: head.toString(), streamed, realpath };
    }
    if (command === 'transcript') {
        // claude-code's transcript probe (Yx0) and hardened append, verbatim in shape:
        // bigint lstat, open with O_* bits, the handle's stat identity, readline over the
        // handle's read stream, then an O_WRONLY|O_APPEND positional write.
        const c = fs.constants;
        const file = path.join(__dirname, 'session.jsonl');
        const before = await fs.promises.lstat(file, { bigint: true });
        const handle = await fs.promises.open(file, c.O_RDONLY | (c.O_NOFOLLOW ?? 0));
        const own = await handle.stat({ bigint: true });
        const lines = [];
        let verdict = 'none';
        const rl = require('readline').createInterface({ input: handle.createReadStream() });
        for await (const line of rl) {
            lines.push(line);
            if (line.includes('"type":"user"')) { verdict = 'has'; rl.close(); break; }
        }
        await handle.close();
        const appender = await fs.promises.open(file, c.O_WRONLY | c.O_APPEND);
        const size = (await appender.stat()).size;
        const { bytesWritten } = await appender.write(Buffer.from('{"type":"x"}\n'), 0, 13, size);
        await appender.close();
        const missing = await fs.promises.open(path.join(__dirname, 'nope'), c.O_RDONLY).catch((error) => error.code);
        // The bundler's lowered `using`: the helper resolves Symbol.dispose (or its registry
        // fallback) on an object literal written with the well-known symbol.
        const disposeKey = Symbol.dispose || Symbol.for('Symbol.dispose');
        const span = { [Symbol.dispose]() {} };
        const disposable = typeof span[disposeKey] === 'function' && typeof Symbol.asyncDispose === 'symbol';
        // readFile with no encoding answers a Buffer; the parser walks its bytes.
        const bytes = await fs.promises.readFile(file);
        const firstLine = bytes.toString('utf-8', 0, bytes.indexOf(10)).trim();
        // claude-code's atomic settings writer: readlink of a plain file (EINVAL), an
        // exclusive staged temp (EEXIST on a second 'wx'), handle chmod, rename over.
        const target = path.join(__dirname, 'settings.json');
        fs.writeFileSync(target, '{}');
        const notLink = await fs.promises.readlink(target).catch((error) => error.code);
        const staged = target + '.tmp.1';
        const temp = await fs.promises.open(staged, 'wx', 0o644);
        await temp.writeFile('{"model":"sonnet"}', { encoding: 'utf8' });
        await temp.chmod(0o644);
        await temp.sync();
        await temp.close();
        const exclusive = await fs.promises.writeFile(staged, 'x', { flag: 'wx' }).catch((error) => error.code);
        await fs.promises.rename(staged, target);
        const settings = JSON.parse(fs.readFileSync(target, 'utf8'));
        return {
            bigint: typeof before.size === 'bigint' && typeof own.ino === 'bigint',
            sameFile: own.dev === before.dev && own.ino === before.ino && own.isFile(),
            verdict,
            lines: lines.length,
            bytesWritten,
            tail: fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).pop(),
            missing,
            quiet: fs.statSync(path.join(__dirname, 'nope'), { throwIfNoEntry: false }) === undefined,
            disposable,
            isBuffer: Buffer.isBuffer(bytes),
            firstLine,
            notLink,
            exclusive,
            model: settings.model,
            staged: fs.existsSync(staged)
        };
    }
    if (command === 'buffer') {
        const bytes = new Uint8Array([104, 105, 33]).buffer;
        const copied = Buffer.alloc(5);
        const written = Buffer.from('hi!').copy(copied, 1);
        return { whole: Buffer.from(bytes).toString(), sliced: Buffer.from(bytes, 1, 1).toString(), copied: copied.toString(), written };
    }
    if (command === 'child') {
        return new Promise((resolve) => {
            const events = [];
            const child = cp.spawn('git', ['--version']);
            child.stderr.resume();
            child.stdout.on('data', (chunk) => events.push('data:' + String(chunk).trim().slice(0, 11)));
            child.on('exit', (code) => events.push('exit:' + code));
            child.on('close', () => resolve(events));
        });
    }
    if (command === 'undefined') return { kept: 1, dropped: undefined, list: [undefined, 2] };
    return null;
});
"#,
            ),
            ("data.txt", "hello world"),
            (
                "session.jsonl",
                "{\"type\":\"summary\"}\r\n{\"type\":\"user\",\"n\":1}\n{\"type\":\"assistant\"}\n",
            ),
        ],
    )
    .join("main.js");
    let answers = serve(
        entry,
        &[
            initialize(),
            run_command("fs", json!([])),
            run_command("transcript", json!([])),
            run_command("buffer", json!([])),
            run_command("child", json!([])),
            run_command("undefined", json!([])),
        ],
    );
    let fs = answers[1].as_ref().expect("fs answered");
    assert_eq!(fs["isFile"], json!(true), "{fs}");
    assert_eq!(fs["isDirectory"], json!(false), "{fs}");
    assert_eq!(fs["size"], json!(11), "{fs}");
    assert_eq!(fs["viaCallback"], json!("hello world"), "{fs}");
    assert_eq!(fs["missing"], json!("ENOENT"), "{fs}");
    assert_eq!(fs["rejected"], json!("ENOENT"), "{fs}");
    assert_eq!(fs["read"], json!(4), "{fs}");
    assert_eq!(fs["head"], json!(" wor"), "{fs}");
    assert_eq!(fs["streamed"], json!(["hel", "lo ", "wor", "ld"]), "{fs}");
    assert_eq!(fs["realpath"], json!(true), "{fs}");
    let transcript = answers[2].as_ref().expect("transcript probe answered");
    assert_eq!(
        transcript,
        &json!({
            "bigint": true,
            "sameFile": true,
            "verdict": "has",
            "lines": 2,
            "bytesWritten": 13,
            "tail": "{\"type\":\"x\"}",
            "missing": "ENOENT",
            "quiet": true,
            "disposable": true,
            "isBuffer": true,
            "firstLine": "{\"type\":\"summary\"}",
            "notLink": "EINVAL",
            "exclusive": "EEXIST",
            "model": "sonnet",
            "staged": false
        }),
        "claude-code's transcript probe reads a session the way node.exe does"
    );
    let buffer = answers[3].as_ref().expect("buffer answered");
    assert_eq!(
        buffer,
        &json!({ "whole": "hi!", "sliced": "i", "copied": " hi! ", "written": 3 })
    );
    let child = answers[4].as_ref().expect("child answered");
    assert_eq!(
        child,
        &json!(["data:git version", "exit:0"]),
        "stdout crosses before the exit"
    );
    let undefined = answers[5]
        .as_ref()
        .expect("a result with undefined members answers");
    assert_eq!(undefined, &json!({ "kept": 1, "list": [null, 2] }));
}

/// ES modules load the way node.exe loads them: a `"type": "module"` entry with named and
/// default builtin imports (`node:` prefixed and bare), a CommonJS dependency imported
/// with its named exports, a package `exports` map answering `import` and `require` from
/// their own conditions, a `#` subpath import, a dynamic `import()` of a relative `.mjs`,
/// `import.meta.url`, top-level `await`, `createRequire`, and `require` of an ES module
/// answering its namespace.
#[test]
fn es_modules_load_the_way_node_loads_them() {
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[
            (
                "package.json",
                r##"{ "type": "module", "imports": { "#util": "./lib/util.mjs" } }"##,
            ),
            (
                "main.js",
                r#"
import path, { join } from 'node:path';
import { EventEmitter } from 'events';
import assert from 'assert';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import cjs, { answer } from './lib/cjs.cjs';
import dual from 'dual';
import { twice } from '#util';
import data from './data.json';
const waited = await new Promise((resolve) => setTimeout(() => resolve('tla'), 5));
const require = createRequire(import.meta.url);
const viaRequire = require('dual');
const esmViaRequire = require('./lib/util.mjs');
assert.ok(new EventEmitter());
ggs.onRequest(async (command) => {
    if (command !== 'esm') return null;
    const lazy = await import('./lib/lazy.mjs');
    return {
        joined: join('a', 'b') === path.join('a', 'b'),
        cjs: cjs.answer === answer && answer === 42,
        importCondition: dual,
        requireCondition: viaRequire.which,
        subpathImport: twice(4),
        json: data.name,
        tla: waited,
        lazy: lazy.default,
        metaUrl: import.meta.url.startsWith('file://') && fileURLToPath(import.meta.url).endsWith('main.js'),
        metaDirname: typeof import.meta.dirname === 'string',
        requireEsm: esmViaRequire.twice(5),
    };
});
"#,
            ),
            ("lib/cjs.cjs", "exports.answer = 42;"),
            ("lib/util.mjs", "export const twice = (n) => n * 2;"),
            ("lib/lazy.mjs", "export default 'lazy-loaded';"),
            ("data.json", r#"{ "name": "json-module" }"#),
            (
                "node_modules/dual/package.json",
                r#"{ "name": "dual", "exports": { ".": { "import": "./esm.mjs", "require": "./cjs.js" } } }"#,
            ),
            ("node_modules/dual/esm.mjs", "export default 'import';"),
            ("node_modules/dual/cjs.js", "exports.which = 'require';"),
        ],
    )
    .join("main.js");
    let answers = serve(entry, &[initialize(), run_command("esm", json!([]))]);
    let esm = answers[1].as_ref().expect("the ES-module entry answered");
    assert_eq!(
        esm,
        &json!({
            "joined": true,
            "cjs": true,
            "importCondition": "import",
            "requireCondition": "require",
            "subpathImport": 8,
            "json": "json-module",
            "tla": "tla",
            "lazy": "lazy-loaded",
            "metaUrl": true,
            "metaDirname": true,
            "requireEsm": 10,
        })
    );
}

/// The two compile semantics the claude-code bundle leans on, driven through the real
/// runtime (the prelude's compiler, the natives, the protocol loop): a class
/// constructor with default parameters instantiating cleanly, and a short-circuit
/// logical assignment on a non-lexical binding keeping its value across calls (the
/// esbuild helper shape — the vendored Boa fixes both).
#[test]
fn the_claude_code_bundle_semantics_run_under_the_runtime() {
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[(
            "main.js",
            r#"
var cache;
function remember($, value) {
    var holder = cache ??= new WeakMap;
    holder.set($);
    holder.set($, value);
    return holder.get($);
}
class Workspace { constructor(a = 1, b = 2) { this.a = a; this.b = b; } }
ggs.onRequest((command) => {
    if (command === 'logical') {
        remember({}, 'first');
        // The second call takes the ??= short circuit: the map already exists, and the
        // assignment must still yield it (the stale-locator bug made this undefined).
        return { second: remember({}, 'second') };
    }
    if (command === 'ctor') {
        const built = new Workspace(7, 8);
        return { a: built.a, b: built.b };
    }
    return null;
});
"#,
        )],
    )
    .join("main.js");
    let answers = serve(
        entry,
        &[
            initialize(),
            run_command("logical", json!([])),
            run_command("ctor", json!([])),
        ],
    );
    let logical = answers[1]
        .as_ref()
        .expect("the logical assignment answered");
    assert_eq!(logical, &json!({ "second": "second" }), "{logical}");
    let ctor = answers[2].as_ref().expect("the constructor answered");
    assert_eq!(ctor, &json!({ "a": 7, "b": 8 }), "{ctor}");
}

/// The core-library surfaces common npm packages lean on, beyond the ones the git-graph-rs
/// extension already pinned: the pre-class `EventEmitter.call(this)` + `util.inherits`
/// subclassing, `stream` piping through a Transform, `string_decoder` holding back a split
/// multi-byte character, the web globals (TextEncoder/TextDecoder, AbortController,
/// structuredClone, URL), `assert`, `path.posix`, a `url` path round trip and `readline`
/// over a stream.
#[test]
fn the_core_library_surfaces_common_packages_use_behave_like_node() {
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[(
            "main.js",
            r#"
const EventEmitter = require('events');
const util = require('util');
const { Readable, Transform, PassThrough, pipeline } = require('stream');
const { StringDecoder } = require('string_decoder');
const assert = require('assert');
const path = require('path');
const url = require('url');
const readline = require('readline');
function Legacy() { EventEmitter.call(this); }
util.inherits(Legacy, EventEmitter);
ggs.onRequest(async (command) => {
    if (command !== 'core') return null;
    const legacy = new Legacy();
    let heard = null;
    legacy.on('ping', (value) => { heard = value; });
    legacy.emit('ping', 'pong');
    const upper = new Transform({ transform(chunk, _enc, cb) { cb(null, String(chunk).toUpperCase()); } });
    const sink = new PassThrough();
    const collected = [];
    sink.on('data', (chunk) => collected.push(String(chunk)));
    await new Promise((resolve, reject) => pipeline(Readable.from(['ab', 'cd']), upper, sink, (error) => (error ? reject(error) : resolve())));
    const euro = Buffer.from('€');
    const decoder = new StringDecoder('utf8');
    const decoded = decoder.write(euro.subarray(0, 1)) + '|' + decoder.write(euro.subarray(1)) + decoder.end();
    const controller = new AbortController();
    let aborted = false;
    controller.signal.addEventListener('abort', () => { aborted = true; });
    controller.abort();
    const cloned = structuredClone({ at: new Map([['k', 1]]) });
    let assertion = null;
    try { assert.strictEqual(1, 2); } catch (error) { assertion = error.code; }
    const lines = [];
    const input = new PassThrough();
    const rl = readline.createInterface({ input });
    rl.on('line', (line) => lines.push(line));
    input.write('one\ntw');
    input.end('o\n');
    await new Promise((resolve) => rl.once('close', resolve));
    const file = path.join(__dirname, 'a b', 'c#d.txt');
    return {
        legacy: heard,
        superCtor: Legacy.super_ === EventEmitter,
        piped: collected.join(''),
        decoded,
        textCodec: new TextDecoder().decode(new TextEncoder().encode('héllo')),
        aborted: aborted && controller.signal.aborted,
        cloned: cloned.at instanceof Map && cloned.at.get('k') === 1,
        assertion,
        posixJoin: path.posix.join('a', 'b', '../c'),
        roundTrip: url.fileURLToPath(url.pathToFileURL(file)) === file,
        encoded: url.pathToFileURL(file).href.includes('a%20b/c%23d.txt'),
        globalUrl: new URL('../x/./y.mjs', 'file:///root/a/b.mjs').href,
        lines,
    };
});
"#,
        )],
    )
    .join("main.js");
    let answers = serve(entry, &[initialize(), run_command("core", json!([]))]);
    let core = answers[1].as_ref().expect("the core surfaces answered");
    assert_eq!(
        core,
        &json!({
            "legacy": "pong",
            "superCtor": true,
            "piped": "ABCD",
            "decoded": "|€",
            "textCodec": "héllo",
            "aborted": true,
            "cloned": true,
            "assertion": "ERR_ASSERTION",
            "posixJoin": "a/c",
            "roundTrip": true,
            "encoded": true,
            "globalUrl": "file:///root/x/y.mjs",
            "lines": ["one", "two"],
        })
    );
}

/// Real sockets under the runtime (builtins/net.rs + the prelude's net / http / fetch):
/// an http server on an ephemeral port answers a keep-alive `http.request`, a chunked
/// POST, a streamed `fetch` and a `net` client; an `Upgrade` request reaches the server's
/// `upgrade` listener with the raw socket, which then speaks both ways — the handshake
/// shape a WebSocket server (claude-code's IDE link, `ws`) builds on.
#[test]
fn sockets_http_and_fetch_work_end_to_end() {
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[(
            "main.js",
            r#"
const http = require('http');
const net = require('net');
ggs.onRequest(async (command) => {
    if (command !== 'net') return null;
    const server = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            if (req.url === '/stream') {
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.write('one,');
                setTimeout(() => res.end('two'), 20);
                return;
            }
            res.setHeader('x-echo-method', req.method);
            res.end(JSON.stringify({ url: req.url, body, te: req.headers['transfer-encoding'] ?? null }));
        });
    });
    server.on('upgrade', (req, socket, head) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: probe\r\nConnection: Upgrade\r\n\r\n');
        if (head.length) socket.write('head:' + head.toString());
        socket.on('data', (chunk) => socket.write('echo:' + chunk.toString()));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    // 1. http.request, twice (the server keeps the connection alive between them).
    const get = (path) => new Promise((resolve, reject) => {
        http.get(`${base}${path}`, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, header: res.headers['x-echo-method'], text }));
        }).on('error', reject);
    });
    const first = await get('/a?x=1');
    const second = await get('/b');

    // 2. A POST with a body, through the client's own framing.
    const posted = await new Promise((resolve, reject) => {
        const req = http.request(`${base}/post`, { method: 'POST', headers: { 'content-type': 'text/plain' } }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve(JSON.parse(text)));
        });
        req.on('error', reject);
        req.write('hello ');
        req.end('world');
    });

    // 3. fetch, the body read as a stream and as text.
    const streamed = await fetch(`${base}/stream`);
    const reader = streamed.body.getReader();
    let streamedText = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        streamedText += Buffer.from(value).toString();
    }
    const fetched = await (await fetch(`${base}/f`, { method: 'PUT', body: 'payload' })).json();

    // 4. A raw client socket speaking an Upgrade, then both ways over the same socket.
    const upgraded = await new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        let text = '';
        socket.on('error', reject);
        socket.on('connect', () => socket.write('GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: probe\r\n\r\nearly'));
        socket.on('data', (chunk) => {
            text += chunk.toString();
            if (text.includes('head:early') && !text.includes('echo:')) socket.write('ping');
            if (text.includes('echo:ping')) {
                socket.end();
                resolve(text);
            }
        });
    });

    // 5. A refused connection is an error event, not a hang.
    const refused = await new Promise((resolve) => {
        const probe = net.createServer();
        probe.listen(0, '127.0.0.1', () => {
            const dead = probe.address().port;
            probe.close(() => {
                const socket = net.connect(dead, '127.0.0.1');
                socket.on('error', (error) => resolve(error.code));
            });
        });
    });

    await new Promise((resolve) => server.close(resolve));
    return {
        first, second, posted,
        streamedText, streamedStatus: streamed.status, fetched,
        upgraded: upgraded.startsWith('HTTP/1.1 101') && upgraded.includes('head:early') && upgraded.includes('echo:ping'),
        refused,
        listening: server.listening
    };
});
"#,
        )],
    )
    .join("main.js");

    let answers = serve(entry, &[initialize(), run_command("net", json!([]))]);
    let result = answers[1].as_ref().expect("the net command answers");
    assert_eq!(result["first"]["status"], json!(200), "{result}");
    assert_eq!(result["first"]["header"], json!("GET"));
    assert_eq!(
        serde_json::from_str::<Value>(result["first"]["text"].as_str().unwrap()).unwrap()["url"],
        json!("/a?x=1")
    );
    assert_eq!(result["second"]["status"], json!(200));
    assert_eq!(result["posted"]["body"], json!("hello world"), "{result}");
    assert_eq!(result["posted"]["url"], json!("/post"));
    assert_eq!(result["streamedStatus"], json!(200));
    assert_eq!(result["streamedText"], json!("one,two"));
    assert_eq!(result["fetched"]["body"], json!("payload"));
    assert_eq!(result["upgraded"], json!(true), "{result}");
    assert_eq!(result["refused"], json!("ECONNREFUSED"));
    assert_eq!(result["listening"], json!(false));
}

/// The prelude's Buffer against Node: the numeric read/write family (what `ws` frames
/// WebSocket traffic with), view-returning `slice`, base64url both ways (PKCE / JWT),
/// utf16le, string `indexOf`, case-insensitive encodings, `write`, and Node's bounds
/// error — every expected value below was produced by Node 24 running this same function.
#[test]
fn buffer_behaves_like_node() {
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[(
            "main.js",
            r#"
function bufferCase() {
    const b = Buffer.alloc(16);
    b.writeUInt16BE(0xABCD, 0);
    b.writeUInt32LE(0xDEADBEEF, 2);
    b.writeInt8(-2, 6);
    b.writeDoubleBE(1.5, 7);
    const wide = Buffer.alloc(8);
    wide.writeBigUInt64BE(2n ** 40n + 5n, 0);
    const v = Buffer.alloc(6);
    v.writeUIntBE(0x123456789A, 0, 5);
    const view = Buffer.from('hello world');
    view.slice(0, 5).fill('J');
    const u16 = Buffer.from('hé', 'utf16le');
    const crypto = require('crypto');
    return {
        hex: b.toString('hex'),
        r16: b.readUInt16BE(0), r32: b.readUInt32LE(2), r8: b.readInt8(6), rd: b.readDoubleBE(7),
        big: String(wide.readBigUInt64BE(0)), uint: v.readUIntBE(0, 5), intLE: Buffer.from([0xff, 0xff]).readIntLE(0, 2),
        view: view.toString(),
        b64url: Buffer.from([0xfb, 0xff, 0xfe]).toString('base64url'),
        b64urlBack: Buffer.from('-__-', 'base64url').toString('hex'),
        u16: u16.toString('hex'), u16back: u16.toString('utf16le'),
        indexOf: Buffer.from('abc\r\n\r\nxyz').indexOf('\r\n\r\n'),
        includes: Buffer.from('abcdef').includes(Buffer.from('cd')),
        upper: Buffer.from('hi', 'UTF8').toString('HEX'),
        cmp: Buffer.compare(Buffer.from('a'), Buffer.from('b')),
        pkce: crypto.createHash('sha256').update('verifier').digest('base64url'),
        write: (() => { const w = Buffer.alloc(4); return w.write('xyz', 1) + ':' + w.toString('hex'); })(),
        range: (() => { try { Buffer.alloc(2).readUInt32BE(0); return 'no throw'; } catch (e) { return e.code; } })()
    };
}
ggs.onRequest((command) => (command === 'buffer' ? bufferCase() : null));
"#,
        )],
    )
    .join("main.js");
    let answers = serve(entry, &[initialize(), run_command("buffer", json!([]))]);
    let expected: Value = serde_json::from_str(r#"{"hex":"abcdefbeaddefe3ff800000000000000","r16":43981,"r32":3735928559,"r8":-2,"rd":1.5,"big":"1099511627781","uint":78187493530,"intLE":-1,"view":"JJJJJ world","b64url":"-__-","b64urlBack":"fbfffe","u16":"6800e900","u16back":"hé","indexOf":3,"includes":true,"upper":"6869","cmp":-1,"pkce":"iMnq5o6zALKXGivsnlom_0F5_WYda32GHkxlV7mq7hQ","write":"3:0078797a","range":"ERR_BUFFER_OUT_OF_BOUNDS"}"#).unwrap();
    assert_eq!(answers[1].as_ref().unwrap(), &expected);
}

/// The Claude Remote extension's whole sealed wire rides the crypto shim: PBKDF2-SHA256
/// key derivation (checked against a published RFC test vector) and an AES-256-GCM
/// seal/open round trip with AAD, whose tag tampering and AAD substitution must both fail.
#[test]
fn crypto_pbkdf2_and_aes_gcm_behave_like_node() {
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[(
            "main.js",
            r#"
function cryptoCase() {
    const crypto = require('crypto');
    // the published PBKDF2-HMAC-SHA256 vector (password/salt, c=1, 32 bytes)
    const vector = crypto.pbkdf2Sync('password', Buffer.from('salt', 'utf8'), 1, 32, 'sha256').toString('hex');
    // the extension's own chain: 150k rounds over the pairing code, then a sealed envelope
    const key = crypto.pbkdf2Sync('ABCD-EFGH-JKMN-PQRS-TVWX-YZ01', Buffer.from('c2FsdA', 'base64url'), 150000, 32, 'sha256');
    const iv = Buffer.from('000102030405060708090a0b', 'hex');
    const aad = Buffer.from('cr2:req:abcdef123456', 'utf8');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const sealed = Buffer.concat([cipher.update(Buffer.from('{"m":"hello"}', 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    const open = (openAad, openTag) => {
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
        d.setAAD(openAad);
        d.setAuthTag(openTag);
        return Buffer.concat([d.update(sealed), d.final()]).toString('utf8');
    };
    const flipped = Buffer.from(tag);
    flipped[0] = flipped[0] ^ 1;
    let tampered = 'no throw';
    try { open(aad, flipped); } catch (e) { tampered = 'threw'; }
    let wrongAad = 'no throw';
    try { open(Buffer.from('cr2:res:someone-else', 'utf8'), tag); } catch (e) { wrongAad = 'threw'; }
    return {
        vector,
        keyLen: key.length,
        opened: open(aad, tag),
        tampered,
        wrongAad,
        tagLen: tag.length,
        sealedEveryTime: (() => {
            const c2 = crypto.createCipheriv('aes-256-gcm', key, iv);
            c2.setAAD(aad);
            return Buffer.concat([c2.update(Buffer.from('{"m":"hello"}', 'utf8')), c2.final()]).toString('hex') === sealed.toString('hex');
        })()
    };
}
ggs.onRequest((command) => (command === 'crypto' ? cryptoCase() : null));
"#,
        )],
    )
    .join("main.js");
    let answers = serve(entry, &[initialize(), run_command("crypto", json!([]))]);
    let expected: Value = serde_json::from_str(
        r#"{"vector":"120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b","keyLen":32,"opened":"{\"m\":\"hello\"}","tampered":"threw","wrongAad":"threw","tagLen":16,"sealedEveryTime":true}"#,
    )
    .unwrap();
    assert_eq!(answers[1].as_ref().unwrap(), &expected);
}

/// `child_process` with Node's shapes: `spawn` answers a ChildProcess whose stdin is a
/// Writable (`.on("error")` included) and whose stdout is a Readable a `readline`
/// reads line by line; `spawn` / `exit` / `close` arrive in Node's order; a missing
/// program is an async ENOENT `error`, never a throw; `execFile` is asynchronous and
/// `util.promisify(execFile)` resolves `{ stdout, stderr }`; `execFileSync` throws on a
/// failed exit; and `Error.captureStackTrace` / `err.stack` carry real frames.
#[test]
fn child_processes_and_error_stacks_behave_like_node() {
    let tmp = tempfile::tempdir().unwrap();
    let entry = make_package(
        tmp.path(),
        &[(
            "main.js",
            r#"
const cp = require('child_process');
const readline = require('readline');
const util = require('util');
const node = process.platform === 'win32';
// A tiny line-echo program that exists on every OS: the platform shell.
const echoLines = node
    ? ['cmd.exe', ['/d', '/s', '/c', 'more']]
    : ['/bin/sh', ['-c', 'cat']];
ggs.onRequest(async (command) => {
    if (command !== 'cp') return null;
    const events = [];
    const child = cp.spawn(echoLines[0], echoLines[1]);
    child.on('spawn', () => events.push('spawn'));
    child.stdin.on('error', () => events.push('stdin-error'));
    const lines = [];
    const rl = readline.createInterface({ input: child.stdout });
    // Windows' `more` ends with a blank line (real Node reads the same); only content counts.
    rl.on('line', (line) => { if (line.trim()) lines.push(line.trim()); });
    const closed = new Promise((resolve) => child.on('close', (code) => { events.push('close'); resolve(code); }));
    child.on('exit', () => events.push('exit'));
    child.stdin.write('alpha\n');
    child.stdin.end('beta\n');
    const code = await closed;

    const missing = await new Promise((resolve) => {
        const ghost = cp.spawn('ggs-no-such-program-xyz', []);
        ghost.stdout.on('data', () => undefined);
        ghost.on('error', (error) => resolve(error.code));
    });

    let order = 'sync';
    const done = new Promise((resolve) => {
        const returned = cp.execFile(echoLines[0], node ? ['/d', '/s', '/c', 'echo exec-ok'] : ['-c', 'echo exec-ok'], (error, stdout) => resolve({ error, stdout: stdout.trim(), order, isChild: returned instanceof cp.ChildProcess }));
        order = 'async';
    });
    const execFile = await done;
    const promised = await util.promisify(cp.execFile)(echoLines[0], node ? ['/d', '/s', '/c', 'echo p-ok'] : ['-c', 'echo p-ok']);
    let syncThrow = null;
    try {
        cp.execFileSync(echoLines[0], node ? ['/d', '/s', '/c', 'exit 3'] : ['-c', 'exit 3']);
    } catch (error) {
        syncThrow = error.status;
    }

    class MyError extends Error {
        constructor(message) {
            super(message);
            this.name = 'MyError';
            Error.captureStackTrace(this, MyError);
        }
    }
    function thrower() { throw new MyError('boom'); }
    let captured = '';
    try { thrower(); } catch (error) { captured = error.stack; }
    let engine = '';
    try { null.x(); } catch (error) { engine = error.stack; }
    const plain = new Error('plain').stack;
    return {
        lines, code, events, missing, execFile: { ...execFile, error: execFile.error && String(execFile.error) },
        promised: promised.stdout.trim(), syncThrow,
        captured: captured.split('\n').slice(0, 2),
        engineHasFrames: /\n    at /.test(engine),
        engineHead: engine.split('\n')[0],
        plainHead: plain.split('\n')[0],
        plainHasFrames: /\n    at /.test(plain),
        limit: Error.stackTraceLimit
    };
});
"#,
        )],
    )
    .join("main.js");
    let answers = serve(entry, &[initialize(), run_command("cp", json!([]))]);
    let result = answers[1].as_ref().expect("the cp command answers");
    assert_eq!(result["lines"], json!(["alpha", "beta"]), "{result}");
    assert_eq!(result["code"], json!(0));
    assert_eq!(
        result["events"],
        json!(["spawn", "exit", "close"]),
        "{result}"
    );
    assert_eq!(result["missing"], json!("ENOENT"));
    assert_eq!(result["execFile"]["order"], json!("async"), "{result}");
    assert_eq!(result["execFile"]["stdout"], json!("exec-ok"));
    assert_eq!(result["execFile"]["isChild"], json!(true));
    assert_eq!(result["execFile"]["error"], Value::Null);
    assert_eq!(result["promised"], json!("p-ok"));
    assert_eq!(result["syncThrow"], json!(3));
    // captureStackTrace: the header uses the current name; the frames start at the
    // caller of the constructor (`thrower`), the constructor itself left out.
    assert_eq!(result["captured"][0], json!("MyError: boom"), "{result}");
    assert!(
        result["captured"][1]
            .as_str()
            .unwrap()
            .contains("at thrower"),
        "{result}"
    );
    assert_eq!(result["engineHasFrames"], json!(true), "{result}");
    assert!(
        result["engineHead"]
            .as_str()
            .unwrap()
            .starts_with("TypeError"),
        "{result}"
    );
    assert_eq!(result["plainHead"], json!("Error: plain"));
    assert_eq!(result["plainHasFrames"], json!(true), "{result}");
    assert_eq!(result["limit"], json!(10));
}
