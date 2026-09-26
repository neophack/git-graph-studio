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
        let Some(id) = wire.get("id").and_then(Value::as_u64) else {
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
            ("package.json", r#"{"name":"provider","publisher":"acme","version":"1.0.0","main":"main.js"}"#),
            ("main.js", r#"
const vscode = require('vscode');
vscode.workspace.registerTextDocumentContentProvider('ggsfix', {
    provideTextDocumentContent(uri) { return 'CONTENT:' + uri.path; }
});
"#),
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
            run_command("nobody", json!([])),
        ],
    );
    assert_eq!(answers.len(), 6, "{answers:?}");
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
    assert_eq!(answers[5].as_ref().unwrap()["unknown"], json!("nobody"));
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

/// The whole chain as the app drives it: install a VSIX declaring the ggs-node backend,
/// let the process host spawn the bundled sidecar, shake hands, run a command, stop.
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
    zip.write_all(
        format!(
            r#"{{"name":"js-demo","publisher":"acme","version":"1.0.0","main":"out/main.js","ggs":{{"format":"ggs/2","id":"{ID}","version":"1.0.0","pages":{{"view":{{"page":"web/view.html"}}}},"activitybar":{{"command":"acme.js-demo.view","page":"view"}},"backend":{{"kind":"node","command":"out/main.js"}}}}}}"#
        )
        .as_bytes(),
    )
    .unwrap();
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
    // The host declared the backend; the launcher convention survives it untouched.
    assert_eq!(
        started.commands,
        vec!["acme.js-demo.view".to_owned()],
        "{started:?}"
    );
    let _ = info;

    // The manifest's launcher outranks every handler — the one command convention every
    // host speaks, runtime parity included.
    let opened = state
        .run(&exts, ID, "acme.js-demo.view", json!([{ "repo": "/r" }]))
        .unwrap();
    assert_eq!(
        opened,
        json!({ "openPage": "view", "params": { "repo": "/r" } })
    );

    // The package's own handler answers what the launcher does not declare.
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
    let answer = answers[2].as_ref().unwrap()["answer"]
        .as_str()
        .unwrap_or("");
    assert!(
        answer.contains(version),
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
    if (command === 'buffer') {
        const bytes = new Uint8Array([104, 105, 33]).buffer;
        return { whole: Buffer.from(bytes).toString(), sliced: Buffer.from(bytes, 1, 1).toString() };
    }
    if (command === 'child') {
        return new Promise((resolve) => {
            const events = [];
            const child = cp.spawn('git', ['--version']);
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
        ],
    )
    .join("main.js");
    let answers = serve(
        entry,
        &[
            initialize(),
            run_command("fs", json!([])),
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
    let buffer = answers[2].as_ref().expect("buffer answered");
    assert_eq!(buffer, &json!({ "whole": "hi!", "sliced": "i" }));
    let child = answers[3].as_ref().expect("child answered");
    assert_eq!(
        child,
        &json!(["data:git version", "exit:0"]),
        "stdout crosses before the exit"
    );
    let undefined = answers[4]
        .as_ref()
        .expect("a result with undefined members answers");
    assert_eq!(undefined, &json!({ "kept": 1, "list": [null, 2] }));
}
