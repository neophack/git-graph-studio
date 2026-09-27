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
        let text = locale[key].as_str().unwrap_or_else(|| panic!("{key} is not a string"));
        assert!(
            text.chars().any(|c| c.is_ascii_digit()) && !text.contains("Unimplemented"),
            "the {key} locale shape must be a real timestamp: {text}"
        );
    }
    assert_eq!(answers[6].as_ref().unwrap()["unknown"], json!("nobody"));
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
    assert_eq!(buffer, &json!({ "whole": "hi!", "sliced": "i", "copied": " hi! ", "written": 3 }));
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
    let logical = answers[1].as_ref().expect("the logical assignment answered");
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

/// One hosted extension over the wire, the process host's side of it: requests go in,
/// every `ggs.hostRequest` the extension makes is recorded and answered by `answer`, and a
/// request's own response is waited for.
/// The canned host answer one test drives its runtime with.
type HostAnswer = Box<dyn Fn(&str, &Value) -> Value>;

struct HostedExtension {
    requests: std::sync::mpsc::Sender<String>,
    output: std::sync::mpsc::Receiver<String>,
    next_id: u64,
    host_requests: Vec<Value>,
    answer: HostAnswer,
    serve: Option<std::thread::JoinHandle<()>>,
}

impl HostedExtension {
    fn start(entry: PathBuf, answer: HostAnswer) -> Self {
        let (requests, requests_rx) = std::sync::mpsc::channel::<String>();
        let (output_tx, output) = std::sync::mpsc::channel::<String>();
        let serve = std::thread::spawn(move || {
            git_graph_studio_lib::node_runtime::serve_on(
                entry,
                ChannelReader::from(requests_rx),
                ChannelWriter(output_tx),
            );
        });
        HostedExtension {
            requests,
            output,
            next_id: 0,
            host_requests: Vec::new(),
            answer,
            serve: Some(serve),
        }
    }

    /// Send one request and serve host requests until its response crosses.
    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.requests
            .send(git_graph_studio_lib::ext_protocol::request(id, method, params))
            .unwrap();
        loop {
            let line = self
                .output
                .recv_timeout(std::time::Duration::from_secs(120))
                .unwrap_or_else(|_| panic!("the backend fell silent answering {method}"));
            if std::env::var("GGS_TRACE_WIRE").is_ok() {
                eprintln!("[wire] {}", line.chars().take(400).collect::<String>());
            }
            let Ok(wire) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if wire.get("method").and_then(Value::as_str) == Some("ggs.hostRequest") {
                let host_id = wire["id"].as_u64().unwrap_or_default();
                let inner = wire["params"]["method"].as_str().unwrap_or_default();
                let reply = (self.answer)(inner, &wire["params"]["args"]);
                self.host_requests.push(wire["params"].clone());
                self.requests
                    .send(git_graph_studio_lib::ext_protocol::response(host_id, Ok(reply)))
                    .unwrap();
                continue;
            }
            if wire["id"].as_u64() == Some(id) {
                return wire;
            }
        }
    }
}

impl Drop for HostedExtension {
    fn drop(&mut self) {
        let (closed, _) = std::sync::mpsc::channel();
        drop(std::mem::replace(&mut self.requests, closed));
        // A failed assertion must not wait on a runtime that may still be mid-request.
        if std::thread::panicking() {
            return;
        }
        if let Some(serve) = self.serve.take() {
            let _ = serve.join();
        }
    }
}

/// The installed extension directory whose name starts with `prefix`, when there is one.
fn installed_extension(prefix: &str) -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    std::fs::read_dir(PathBuf::from(home).join(".ggs/extensions"))
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(prefix))
        })
}

/// Prettier - Code formatter, its own Node `main` hosted by ggs-node: an ES-module entry
/// (`"type": "module"`) that imports its bundled `prettier` package dynamically — the
/// `exports` map's `import` condition, `index.mjs`, `createRequire(import.meta.url)`,
/// the language plugins as further dynamic `import()`s — registers its formatter during
/// activation, and formats a document through the host's `formatDocument.run` call.
#[test]
fn the_installed_prettier_extension_formats_under_ggs_node() {
    let Some(package) = installed_extension("esbenp.prettier-vscode") else {
        eprintln!("skipping: no installed prettier-vscode package");
        return;
    };
    let shim = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/studio/vscode-shim.cjs");
    if !shim.is_file() {
        eprintln!("skipping: no compiled vscode shim at {}", shim.display());
        return;
    }
    std::env::set_var("GGS_VSCODE_SHIM", &shim);
    let workspace = tempfile::tempdir().unwrap();
    let file = workspace.path().join("ugly.js");
    std::fs::write(&file, "const   a = {b:1,\n  c : [1,2 ,3]}\n").unwrap();

    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(package.join("package.json")).unwrap())
            .unwrap();
    // The configuration defaults the workbench hands every host (`prettier.enable` above
    // all - without it the activation declines to register anything).
    let mut defaults = serde_json::Map::new();
    let configuration = &manifest["contributes"]["configuration"];
    let sections = match configuration {
        Value::Array(list) => list.clone(),
        other => vec![other.clone()],
    };
    for section in sections {
        if let Some(properties) = section["properties"].as_object() {
            for (name, schema) in properties {
                if let Some(default) = schema.get("default") {
                    defaults.insert(name.clone(), default.clone());
                }
            }
        }
    }
    let env = json!({
        "settings": {},
        "defaults": defaults,
        "language": "en",
        "appVersion": "0.1.5-test",
        "themeKind": 2,
        "state": { "global": {}, "workspace": {} }
    });
    let answer = move |method: &str, _args: &Value| -> Value {
        match method {
            "host.env" => env.clone(),
            _ => Value::Null,
        }
    };
    let entry = package.join(manifest["main"].as_str().unwrap().trim_start_matches("./"));
    let mut host = HostedExtension::start(entry, Box::new(answer));
    let handshake = host.request(
        "initialize",
        json!({
            "protocolVersion": "ggs-ext/1",
            "extensionId": "esbenp.prettier-vscode",
            "extensionPath": package.display().to_string(),
            "workspaceFolders": [workspace.path().display().to_string()],
        }),
    );
    assert_eq!(
        handshake["result"]["protocolVersion"], "ggs-ext/1",
        "{handshake:?}"
    );

    // The activation registered its whole-document formatter for JavaScript.
    let formatter = host
        .host_requests
        .iter()
        .filter(|request| request["method"] == "languages.registerFormatting")
        .map(|request| &request["args"][0])
        .find(|registration| {
            registration["selectors"]
                .as_array()
                .is_some_and(|selectors| selectors.iter().any(|s| s["language"] == "javascript"))
        })
        .map(|registration| registration["id"].as_str().unwrap().to_owned())
        .unwrap_or_else(|| {
            let methods: Vec<&Value> = host.host_requests.iter().map(|r| &r["method"]).collect();
            panic!("no JavaScript formatter was registered; the host saw {methods:?}")
        });

    let formatted = host.request(
        "formatDocument.run",
        json!({ "args": [
            formatter,
            {
                "path": file.display().to_string(),
                "languageId": "javascript",
                "text": std::fs::read_to_string(&file).unwrap(),
            },
            { "tabSize": 2, "insertSpaces": true },
        ]}),
    );
    let edits = formatted["result"]
        .as_array()
        .unwrap_or_else(|| panic!("the formatter answered edits: {formatted:?}"));
    let new_text = edits
        .iter()
        .map(|edit| edit["newText"].as_str().unwrap_or_default())
        .collect::<String>();
    assert_eq!(new_text, "const a = { b: 1, c: [1, 2, 3] };\n", "{formatted:?}");
}

#[test]
#[ignore]
fn debug_prettier_steps() {
    let Some(package) = installed_extension("esbenp.prettier-vscode") else { return; };
    let prettier = package.join("node_modules/prettier/index.mjs").display().to_string().replace('\\', "/");
    let tmp = tempfile::tempdir().unwrap();
    let main = format!(r#"
import {{ pathToFileURL }} from 'url';
const steps = [];
ggs.onRequest(async () => {{
    let p;
    try {{ p = await import(pathToFileURL('{prettier}').href); steps.push('import ok ' + Object.keys(p).join(',')); }} catch (e) {{ steps.push('import: ' + e + ' ' + (e && e.stack)); return steps; }}
    const api = p.default?.version ? p.default : p;
    try {{ steps.push('version ' + api.version); }} catch (e) {{ steps.push('version: ' + e); }}
    try {{ const info = await api.getSupportInfo(); steps.push('support ' + info.languages.length); }} catch (e) {{ steps.push('support: ' + e + ' ' + (e && e.stack)); }}
    try {{ const out = await api.format('const   a = {{b:1}}', {{ parser: 'babel' }}); steps.push('format ' + JSON.stringify(out)); }} catch (e) {{ steps.push('format: ' + e + ' ' + (e && e.stack)); }}
    return steps;
}});
"#);
    let entry = make_package(tmp.path(), &[("package.json", r#"{"type":"module"}"#), ("main.js", &main)]).join("main.js");
    let answers = serve(entry, &[initialize(), run_command("x", json!([]))]);
    eprintln!("{:#?}", answers[1]);
}
