//! The process extension host: the backend half of a package whose manifest declares
//! `backend: { "kind": "process", "command": "bin/main" }`. Every backend speaks the one
//! wire protocol, `ggs-ext/1` (`ext_protocol.rs`) — newline-delimited JSON-RPC 2.0, every
//! request dispatched onto its own thread on the plugin side, so a command-style plugin and
//! a concurrent engine (the git-graph backend's opening fan of reads) plug in through the
//! same handshake, the same envelope and the same reader. A manifest that still names a
//! retired protocol fails `start` with an upgrade hint rather than a hung handshake.
//!
//! When it runs: eagerly — the boot pass starts every installed package that declares a
//! backend (`start_all_installed`), and an install starts its backend at once — and lazily as
//! the fallback, the first execution of a declared command or a page's `backend.run` request
//! starting one that is not up. It is then kept resident.
//!
//! A crash never takes the app with it: the reader thread fails only that extension's pending
//! calls, forgets the handle and reaps the child, and the next command starts the backend
//! again. `stop` is what uninstall and reload call; it kills the process outright (a
//! `shutdown` notification is sent first, best-effort, as a courtesy log marker).
//!
//! Multiple app instances are independent by construction: each launch owns its
//! `ProcessHostState` (each GGS window spawns its own backends), and every child is told which
//! instance owns it through `GGS_INSTANCE_ID`, so a plugin that keeps per-instance state can
//! disambiguate two concurrently running windows.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use ggs_proto::{self as proto, Wire};

use crate::routing as ext_routing;
use crate::store::{BackendDecl, StudioManifest};

/// The Tauri event a backend's `ggs.hostRequest` crosses to the workbench on: the payload
/// carries `{extId, id, method, args}`; the workbench serves it through the same `serve`
/// path a frame's RPC takes and answers via [`ext_process_host_respond`].
pub const HOST_REQUEST_EVENT: &str = "ext-host-request";

/// The Tauri event a state-carrying host request is mirrored on (`{extId, method, args,
/// served, caller}`): every frontend but the one that served it applies the registration
/// without answering — a remote page keeps the same commands, context keys and status bar
/// items the desktop window got from the backend — and a webview panel's life (create,
/// title, reveal, dispose) reaches the pages that show its copy (see `ext_routing`).
/// `caller` is the frontend whose call was in flight, if any: the page that asked.
pub const HOST_STATE_EVENT: &str = "ext-host-state";

/// The Tauri event a backend's start settles on (`{extId, running, pid?, startCount?,
/// error?}`): up with its pid, or failed with the reason. The Extensions view refreshes
/// its status lines on it — a view opened during the boot pass would otherwise keep
/// showing "not running" after the backend comes up (the refresh raced the start).
pub const BACKEND_STATE_EVENT: &str = "ext-backend-state";

/// The app's surfaces the engine reaches for: installed once at attach time (the app
/// resolves them off its `AppHandle` — the tauri half stays in the app's adapter), and
/// read by the reader threads. `None` (a pure test reader, a headless start) means the
/// in-band fallbacks: host requests fail in band, settles are emitted nowhere.
pub struct HostHooks {
    /// Emit one named event to every frontend. Returns `false` when no listener can
    /// receive it — the reader then answers the host request in band instead of leaving
    /// it to time out.
    pub emit: Emitter,
    /// The packaged `vscode-shim.cjs` and `node-host.cjs` (the bundle's resource
    /// directory), when the app knows them — `GGS_VSCODE_SHIM` / `GGS_NODE_HOST_SCRIPT`
    /// for a `node` backend's spawn.
    pub node_host_resources: Option<(PathBuf, PathBuf)>,
    /// The frontend a host request is addressed to (`"main"`, one remote session
    /// `"remote/<n>"`, or `"remote"` — the remote side at large), given the frontend
    /// `ext_routing` says claims it (the webview's owner, the caller in flight) — the
    /// composition root's Remote Access policy. Unset, a claim is honoured and the rest
    /// goes to `"main"`.
    pub frontend_of: Option<FrontendResolver>,
}

/// The emitter half of [`HostHooks`]: one named event, one payload, `false` when
/// undeliverable.
pub type Emitter = Box<dyn Fn(&str, Value) -> bool + Send + Sync>;

/// The policy half of [`HostHooks`]: the frontend a claimed host request is addressed to.
pub type FrontendResolver = Box<dyn Fn(Option<String>) -> String + Send + Sync>;

fn host_request_frontend(hooks: &HostHooks, claimed: Option<String>) -> String {
    match &hooks.frontend_of {
        Some(resolve) => resolve(claimed),
        None => claimed.unwrap_or_else(|| "main".into()),
    }
}

/// How long `initialize` may take before the backend is declared unresponsive and killed.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// The same for a `node` backend: its activation — on ggs-node a multi-megabyte bundle's
/// parse-and-compile — runs as a job after the handshake (ggs-node answers `initialize`
/// the moment the protocol loop can; the real-Node host's handshake still settles only
/// after the whole `activate`, VS Code's own no-deadline shape), so this deadline guards
/// the greeting itself, not the activation behind it. Claude Code's bundle on a cold first
/// start after an install once overran the 10 s a bare process binary gets.
const NODE_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(90);
/// Lines of stderr and `$/log` kept per process, for the status view and crash reports.
const LOG_CAP: usize = 200;

/// A pending call's reply channel (the result of one JSON-RPC request), by request id.
type PendingMap = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>;

/// The running backends, one per extension id. `Clone` is cheap (every field is an `Arc`)
/// and deliberate: the app's composition root creates ONE instance, `manage()`s a clone for
/// the `ext_process_*` commands, and keeps its own handle for the no-`AppHandle` paths
/// (folder opens, the provider bridge's restarts) — two handles onto the same running
/// processes. The crate keeps no singleton of its own.
#[derive(Default, Clone)]
pub struct ExtHost {
    /// Shared with the reader threads, which forget a handle when its process dies. An `Arc`
    /// (not a bare `Mutex`) because `State` must stay `Send + Sync` while threads hold a copy.
    procs: Arc<Mutex<HashMap<String, ProcHandle>>>,
    /// The folders the app last reported open (`notify_workspace`): carried into every
    /// backend's start handshake, so a lazily-started backend still learns its workspace.
    workspace: Arc<Mutex<Vec<String>>>,
    /// What survives a backend's death: how often it came up, and why it is not running now.
    /// The status surface reads it so a dead backend can say more than "absent".
    history: Arc<Mutex<HashMap<String, ProcHistory>>>,
    /// The app's surfaces the reader threads forward `ggs.hostRequest`s through (a real-Node
    /// extension host asks the workbench for settings, commands, webviews the way a frame
    /// does). `None` until the app attaches them — pure test readers and headless starts
    /// run without them.
    hooks: Arc<Mutex<Option<Arc<HostHooks>>>>,
}

/// The spawn-time environment sources: every backend start asks each registered source
/// for the extra environment an extension id runs with. The composition root (`lib.rs`)
/// wires the AI provider bridge's source here, so this module never names the provider
/// store — the coupling stays one-directional (providers may stop and start backends
/// through [`ProcessHostState`]; the spawn path itself is provider-agnostic).
type SpawnEnvSource = fn(&str) -> Vec<(String, String)>;

static SPAWN_ENV_SOURCES: Mutex<Vec<SpawnEnvSource>> = Mutex::new(Vec::new());

/// Register a spawn-time environment source. Called at the head of the app's `run`,
/// before any backend can start; sources answer in registration order.
pub fn add_spawn_env_source(source: SpawnEnvSource) {
    SPAWN_ENV_SOURCES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .push(source);
}

/// The extra environment every registered source asks for `ext_id`.
fn spawn_env(ext_id: &str) -> Vec<(String, String)> {
    let sources = SPAWN_ENV_SOURCES.lock().unwrap_or_else(|p| p.into_inner());
    sources.iter().flat_map(|source| source(ext_id)).collect()
}

impl ExtHost {
    /// Attach the app's surfaces (the event emitter, the packaged host resources, the
    /// frontend policy) the reader threads forward `ggs.hostRequest`s through.
    /// Idempotent: the first attach wins (they all belong to the same app instance).
    pub fn attach_hooks(&self, hooks: HostHooks) {
        let mut slot = self.hooks.lock().unwrap();
        if slot.is_none() {
            *slot = Some(Arc::new(hooks));
        }
    }
}

struct ProcHandle {
    child: Child,
    stdin: Mutex<Option<ChildStdin>>,
    pending: PendingMap,
    next_id: AtomicU64,
    /// The commands the backend declared in its `initialize` handshake.
    commands: Vec<String>,
    log: Arc<Mutex<Vec<String>>>,
}

/// A backend's remembered state between runs (see `ProcessHostState::history`).
#[derive(Default, Clone)]
struct ProcHistory {
    start_count: u32,
    last_error: Option<String>,
}

/// What the frontend sees of a running backend.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub extension_id: String,
    /// The backend's pid; `0` on an entry whose backend is not running (its history still is).
    pub pid: u32,
    pub commands: Vec<String>,
    pub protocol_version: String,
    /// How many times this backend has come up (restarts included) since the app launched.
    pub start_count: u32,
    /// Why the backend is not running, when it last failed or died; `None` while it runs.
    pub last_error: Option<String>,
}

/// The id every backend this app instance spawns is given as `GGS_INSTANCE_ID`. Two
/// concurrently running GGS windows each start their own backend set; a plugin that writes
/// per-instance state (a lock file, a port) tells them apart on this.
pub fn instance_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| format!("ggs-{}", std::process::id()))
}

impl ProcHandle {
    fn info(&self, ext_id: &str, history: Option<&ProcHistory>) -> ProcessInfo {
        ProcessInfo {
            extension_id: ext_id.to_owned(),
            pid: self.child.id(),
            commands: self.commands.clone(),
            protocol_version: proto::PROTOCOL_VERSION.to_owned(),
            start_count: history.map_or(0, |h| h.start_count),
            last_error: None,
        }
    }
}

fn push_log(log: &Mutex<Vec<String>>, line: String) {
    let mut log = log.lock().unwrap();
    log.push(line);
    if log.len() > LOG_CAP {
        let excess = log.len() - LOG_CAP;
        log.drain(..excess);
    }
}

impl ExtHost {
    /// Spawn `ext_id`'s backend and complete the `initialize` handshake. Idempotent: a
    /// backend that is already running is returned as-is. The map lock is held across the
    /// handshake (at most `HANDSHAKE_TIMEOUT`), so a concurrent `run` of the same extension
    /// waits for its own backend rather than spawning a second one. Failures are remembered
    /// in the history (the status surface shows them) and returned.
    pub fn start(&self, exts_dir: &Path, ext_id: &str) -> Result<ProcessInfo, String> {
        let settled = self.start_inner(exts_dir, ext_id);
        // The settle is announced wherever a listener waits on it (the Extensions view's
        // status lines); a headless start with no app attached emits nothing.
        let event = match &settled {
            Ok(info) => json!({
                "extId": ext_id,
                "running": true,
                "pid": info.pid,
                "startCount": info.start_count,
            }),
            Err(message) => json!({ "extId": ext_id, "running": false, "error": message }),
        };
        if let Some(hooks) = self.hooks.lock().unwrap().clone() {
            (hooks.emit)(BACKEND_STATE_EVENT, event);
        }
        match settled {
            Ok(info) => Ok(info),
            Err(message) => {
                self.record(ext_id, |history| history.last_error = Some(message.clone()));
                Err(message)
            }
        }
    }

    fn start_inner(&self, exts_dir: &Path, ext_id: &str) -> Result<ProcessInfo, String> {
        let mut procs = self.procs.lock().unwrap();
        if let Some(handle) = procs.get(ext_id) {
            return Ok(handle.info(ext_id, self.history.lock().unwrap().get(ext_id)));
        }
        let ext_dir = crate::store::installed_dir(exts_dir, ext_id)?;
        // An install unpacked before the extractor kept the archive's exec bits carries a
        // native CLI nobody can spawn (claude-code's `claude` at 0644); the start path is
        // the one hook every installed backend crosses at every boot — repair it here.
        crate::store::repair_exec_bits(&ext_dir);
        // The runtime manifest exists only for packages installed with the `ggs` key; a
        // plain VS Code extension (a marketplace `main` package) has none — its whole
        // contract is package.json. Both are startable here when a real Node runtime can
        // host them; a manifest that is present but unreadable is still an error.
        let manifest: Option<StudioManifest> =
            match std::fs::read_to_string(ext_dir.join("manifest.json")) {
                Ok(text) => Some(
                    serde_json::from_str(&text)
                        .map_err(|e| format!("invalid manifest.json: {e}"))?,
                ),
                Err(_) => None,
            };
        // A package with only a `main` (no `ggs` backend at all) still gets VS Code's shape
        // when a real Node runtime is here to serve it: one extension-host process per
        // package, the manifest's `main` its entry. Without a Node runtime the synthesized
        // backend reports the historical error and the frame host owns the package instead.
        let backend = match manifest.as_ref().and_then(|m| m.backend.as_ref()) {
            Some(backend) => backend.clone(),
            None => synthesize_extension_host_backend(&ext_dir)?,
        };
        if backend.kind != "process" && backend.kind != "node" {
            return Err(format!(
                "{ext_id} declares backend kind {}; this app speaks process and node",
                backend.kind
            ));
        }
        // One wire protocol. A manifest still naming a retired one fails here, with the
        // remedy, instead of hanging a handshake the backend will never answer.
        if let Some(protocol) = backend.protocol.as_deref() {
            if protocol != proto::PROTOCOL_VERSION {
                return Err(format!(
                    "{ext_id} declares backend protocol {protocol}; this app speaks {} — \
                     upgrade or reinstall the package",
                    proto::PROTOCOL_VERSION
                ));
            }
        }
        // A `node` backend runs on one of two hosts. The default is the app-bundled
        // pretend Node runtime (`ggs-node`, Boa): every `node` backend hosts there — the
        // app never depends on, or spawns, a system Node. Only `GGS_REAL_NODE=1` opts a
        // machine's own runtime in as the extension host (`node node-host.cjs
        // <extension-dir> <entry>`, VS Code's own shape, where the package's `.node` NAPI
        // addons behave natively). (The manifest's retired `host:` field named the deleted
        // C-ABI engine hosts; it reads as `ggs-node` now.)
        let (program, extra_args, pretend_entry) = if backend.kind == "node" {
            let entry =
                resolve_command(&ext_dir, backend.command_for(&crate::store::host_platform_key()))?;
            match if crate::real_node_allowed() {
                (find_node_runtime(), find_node_host_script())
            } else {
                (None, None)
            } {
                // The directory carries package.json (contributes, version); the entry
                // overrides its `main` — a derived backend whose command IS the engine
                // `.node` hosts that one binary instead of the manifest's main.
                (Some(node), Some(script)) => (node, vec![script, ext_dir.clone(), entry], false),
                (_, _) => (ggs_base::sidecar::resolve_host("ggs-node")?, vec![entry], true),
            }
        } else {
            (
                resolve_command(&ext_dir, backend.command_for(&crate::store::host_platform_key()))?,
                Vec::new(),
                false,
            )
        };
        let mut command = Command::new(&program);
        command
            .current_dir(&ext_dir)
            .env("GGS_INSTANCE_ID", instance_id())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // The registered spawn-time environment sources (`add_spawn_env_source`): a
        // bridged extension's backend runs under its provider — its own state
        // redirected under ~/.ggs, a third-party profile's endpoint and decrypted key
        // in the environment the backend (and its CLI children, by inheritance) run
        // with. No source registered (the tests, the headless runs) means no extras.
        for (key, value) in spawn_env(ext_id) {
            command.env(key, value);
        }
        if backend.kind == "node" {
            // The packaged layout puts the shim bundle and the real-Node host script in the
            // bundle's resource directory (macOS `Contents/Resources/`, Linux share/, the
            // install root on Windows) — never beside the sidecar, which is what the
            // finders inside ggs-node probe (they cover the dev target layouts). The app
            // knows its resource directory, so it names the packaged copies here; a
            // frame-program activation without its shim dies with "no vscode shim ships
            // with this host" and every backend command lands on "no handler registered".
            if let Some(hooks) = self.hooks.lock().unwrap_or_else(|p| p.into_inner()).clone() {
                if let Some((shim, host_script)) = &hooks.node_host_resources {
                    if shim.is_file() {
                        command.env("GGS_VSCODE_SHIM", shim);
                    }
                    if host_script.is_file() {
                        command.env("GGS_NODE_HOST_SCRIPT", host_script);
                    }
                }
            }
        }
        if pretend_entry {
            // The manifest's own spawn arguments are the pretend runtime's contract; a
            // real-Node host takes none of them.
            command.args(&backend.args);
        }
        for argument in &extra_args {
            command.arg(argument);
        }
        #[cfg(windows)]
        {
            // Never flash a console window for a plugin's backend (git.rs's precedent).
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("spawn {} for {ext_id}: {e}", program.display()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "the backend closed its stdin at spawn".to_string())?;
        let stdout = child.stdout.take().expect("stdout is piped above");
        let stderr = child.stderr.take().expect("stderr is piped above");

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

        // The handshake's reply channel is registered BEFORE the reader thread exists:
        // a backend that dies instantly must be failed by the reader's EOF drain as
        // "the process exited", not stranded in a map the drain already passed — the
        // start would then wait out the full handshake timeout reporting a bogus
        // "did not answer initialize".
        let (handshake_tx, handshake_rx) = mpsc::channel();
        pending.lock().unwrap().insert(1, handshake_tx.clone());

        // The stdout reader: resolves responses, records notifications, forwards a real-Node
        // host's `ggs.hostRequest`s into the workbench, and — on EOF — fails everything
        // waiting on the backend, forgets the handle and reaps the child. The pending map is
        // drained before the map is touched, so a process that dies during its handshake
        // unblocks `start` even while `start` still holds the map lock. The pid rides along
        // so the EOF cleanup only ever reaps the process this reader served.
        let reader = ReaderState {
            pending: Arc::clone(&pending),
            log: Arc::clone(&log),
            procs: Arc::clone(&self.procs),
            history: Arc::clone(&self.history),
            ext_id: ext_id.to_owned(),
            pid: child.id(),
            hooks: self.hooks.lock().unwrap().clone(),
        };
        std::thread::spawn(move || reader.serve(BufReader::new(stdout)));
        let stderr_log = Arc::clone(&log);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                push_log(&stderr_log, format!("stderr: {line}"));
            }
        });

        let handle = ProcHandle {
            child,
            stdin: Mutex::new(Some(stdin)),
            pending: Arc::clone(&pending),
            next_id: AtomicU64::new(1),
            commands: Vec::new(),
            log: Arc::clone(&log),
        };
        procs.insert(ext_id.to_owned(), handle);
        // A fresh process: the previous one's registrations and webviews died with it.
        ext_routing::reset(ext_id);

        let (_tx, rx) = (handshake_tx, handshake_rx);
        let workspace_folders = self
            .workspace
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let handshake_line = proto::request(
            1,
            "initialize",
            json!({
                "protocolVersion": proto::PROTOCOL_VERSION,
                "extensionId": ext_id,
                "extensionPath": ext_dir,
                "workspaceFolders": workspace_folders,
            }),
        );
        if let Err(e) = write_line(&procs, ext_id, &handshake_line) {
            let _ = drop_handle(&mut procs, ext_id);
            return Err(e);
        }
        // The map lock is released across the handshake wait: a real-Node host asks the
        // workbench for its activation facts (`host.env`) mid-handshake, and the workbench's
        // answer writes through the same map — holding the lock here would deadlock the
        // handshake against its own first request until this very timeout fired.
        drop(procs);
        let handshake_timeout = if backend.kind == "node" {
            NODE_HANDSHAKE_TIMEOUT
        } else {
            HANDSHAKE_TIMEOUT
        };
        let handshake_result = match rx.recv_timeout(handshake_timeout) {
            Ok(Ok(value)) => value,
            Ok(Err(message)) => {
                let _ = drop_handle(&mut self.procs.lock().unwrap(), ext_id);
                return Err(format!(
                    "{ext_id} failed its initialize handshake: {message}"
                ));
            }
            Err(_) => {
                let _ = drop_handle(&mut self.procs.lock().unwrap(), ext_id);
                return Err(format!(
                    "{ext_id} did not answer initialize within {} s",
                    handshake_timeout.as_secs()
                ));
            }
        };
        // `initialize` answers a command list — the surface the Extensions view reports.
        let commands: Vec<String> = handshake_result
            .pointer("/capabilities/commands")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let info = {
            // Re-lock after the wait: a concurrent start took the lock for its own
            // idempotency check during the gap and saw this handle already inserted.
            let mut procs = self.procs.lock().unwrap();
            let handle = procs
                .get_mut(ext_id)
                .expect("inserted above and only the reader removes, after draining pending");
            handle.commands = commands.clone();
            // The backend is up: this start succeeded, and no error stands.
            let mut history = self.history.lock().unwrap();
            let entry = history.entry(ext_id.to_owned()).or_default();
            entry.start_count += 1;
            entry.last_error = None;
            let snapshot = entry.clone();
            handle.info(ext_id, Some(&snapshot))
        };
        Ok(info)
    }

    /// Run one of the extension's commands in its backend, starting the backend first if it
    /// is not running (lazy activation). No timeout: a command may be a long operation, and
    /// `stop` (or the process dying) fails the call. The single RPC verb — a palette command
    /// and a page's `backend.run` both arrive here.
    pub fn run(
        &self,
        exts_dir: &Path,
        ext_id: &str,
        command: &str,
        args: Value,
    ) -> Result<Value, String> {
        self.call(
            exts_dir,
            ext_id,
            "runCommand",
            json!({ "command": command, "args": args }),
        )
    }

    /// The app's report of its open folders: remembered for every later start's handshake
    /// (a lazily-started backend learns the workspace it boots into) and pushed to every
    /// backend already running, as a fire-and-forget `workspaceChanged` request — a backend
    /// that keeps per-workspace state (a warm repository handle) acts on it; one that does
    /// not know the method answers into its status log only. No backend is started for it.
    pub fn notify_workspace(&self, folders: &[String]) {
        *self.workspace.lock().unwrap_or_else(|p| p.into_inner()) = folders.to_vec();
        let procs = self.procs.lock().unwrap();
        let params = json!({ "folders": folders });
        for (ext_id, handle) in procs.iter() {
            // No pending entry: the response finds no waiter and is dropped — the report is
            // delivery, not a round trip.
            let id = handle.next_id.fetch_add(1, Ordering::Relaxed);
            let line = proto::request(id, "workspaceChanged", params.clone());
            let _ = write_line(&procs, ext_id, &line);
        }
    }

    /// The general call: any method, any params — starting the backend first if it is not
    /// running. `run` is `call(.., "runCommand", ..)`.
    pub fn call(
        &self,
        exts_dir: &Path,
        ext_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        if !self.procs.lock().unwrap().contains_key(ext_id) {
            self.start(exts_dir, ext_id)?;
        }
        let (tx, rx) = mpsc::channel();
        {
            let procs = self.procs.lock().unwrap();
            let handle = procs
                .get(ext_id)
                .ok_or_else(|| format!("{ext_id} backend stopped before its call ran"))?;
            let id = handle.next_id.fetch_add(1, Ordering::Relaxed);
            handle.pending.lock().unwrap().insert(id, tx);
            let line = proto::request(id, method, params);
            write_line(&procs, ext_id, &line)?;
            // The lock is dropped before the wait: a `stop` on another thread must be able
            // to reach the handle while this call is outstanding.
        }
        rx.recv()
            .map_err(|_| format!("{ext_id} backend exited while answering {method}"))?
    }

    /// Kill the extension's backend and fail its pending calls. An error when nothing runs.
    /// A deliberate stop is not an error state: the history keeps its start count and clears
    /// the last error, so the status surface never blames a clean stop.
    pub fn stop(&self, ext_id: &str) -> Result<(), String> {
        let mut procs = self.procs.lock().unwrap();
        let stopped = drop_handle(&mut procs, ext_id);
        if stopped.is_ok() {
            self.record(ext_id, |history| history.last_error = None);
        }
        stopped
    }

    /// Kill every running backend — what app exit calls, so no backend outlives its window
    /// (each app instance owns only its own; another window's backends are not ours to stop).
    pub fn stop_all(&self) {
        let mut procs = self.procs.lock().unwrap();
        let ids: Vec<String> = procs.keys().cloned().collect();
        for id in &ids {
            if drop_handle(&mut procs, id).is_ok() {
                self.record(id, |history| history.last_error = None);
            }
        }
    }

    /// Start the backend of every installed package that declares one — the boot pass's
    /// "detect and run": what is installed comes up with the app, without waiting for a
    /// command. One package's failure is remembered in its status, not the others' problem.
    /// A `node` backend is deferred: its program's activation `hostRequest`s need the
    /// workbench listening, and its activation belongs to the workbench's policy (the
    /// eager pass in the frontend starts it the moment the window is up).
    pub fn start_all_installed(&self, exts_dir: &Path) -> Vec<Result<ProcessInfo, String>> {
        crate::store::list_installed(exts_dir)
            .unwrap_or_default()
            .into_iter()
            .filter(|ext| {
                ext.capabilities.as_ref().is_some_and(|g| {
                    g.backend
                        .as_ref()
                        .is_some_and(|b| b.kind == "process" || b.kind == "node")
                })
            })
            .filter(|ext| {
                ext.capabilities
                    .as_ref()
                    .and_then(|g| g.backend.as_ref())
                    .is_none_or(|backend| !deferred_to_the_workbench(backend))
            })
            .map(|ext| self.start(exts_dir, &ext.id))
            .collect()
    }

    /// The backends this app instance knows: every running one, plus the remembered dead
    /// (pid `0`) with why they are not running.
    pub fn status(&self) -> Vec<ProcessInfo> {
        let procs = self.procs.lock().unwrap();
        let history = self.history.lock().unwrap();
        let mut out: Vec<ProcessInfo> = procs
            .iter()
            .map(|(ext_id, handle)| handle.info(ext_id, history.get(ext_id)))
            .collect();
        let running: std::collections::HashSet<&String> = procs.keys().collect();
        out.extend(
            history
                .iter()
                .filter(|(ext_id, _)| !running.contains(ext_id))
                .map(|(ext_id, h)| ProcessInfo {
                    extension_id: ext_id.clone(),
                    pid: 0,
                    commands: Vec::new(),
                    // A dead entry's protocol is not remembered (only pid/counts/error are); the
                    // default reads as "not running" either way since pid is 0.
                    protocol_version: proto::PROTOCOL_VERSION.to_owned(),
                    start_count: h.start_count,
                    last_error: h.last_error.clone(),
                }),
        );
        out
    }

    /// The workbench's answer to one of its forwarded `ggs.hostRequest`s: the reply
    /// crosses back over the backend's stdin as the protocol response.
    pub fn host_respond(&self, ext_id: &str, id: u64, ok: bool, result: Value) -> Result<(), String> {
        let procs = self.procs.lock().unwrap();
        let reply = if ok {
            proto::response(id, Ok(result))
        } else {
            let message = result
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| result.to_string());
            proto::response(id, Err(message))
        };
        write_line(&procs, ext_id, &reply)
    }

    /// Push one host event into a backend as a `ggs.hostEvent` notification — the same
    /// event objects a frame gets: theme changes, configuration, webview messages,
    /// watcher batches.
    pub fn push_event(&self, ext_id: &str, event: Value) -> Result<(), String> {
        let procs = self.procs.lock().unwrap();
        let line = proto::notification("ggs.hostEvent", event);
        write_line(&procs, ext_id, &line)
    }

    /// Apply `edit` to `ext_id`'s history entry, creating it first if this is its first mark.
    fn record(&self, ext_id: &str, edit: impl FnOnce(&mut ProcHistory)) {
        edit(
            self.history
                .lock()
                .unwrap()
                .entry(ext_id.to_owned())
                .or_default(),
        );
    }
}

/// One backend's reader thread state: everything the EOF path needs to clean up.
struct ReaderState {
    pending: PendingMap,
    log: Arc<Mutex<Vec<String>>>,
    procs: Arc<Mutex<HashMap<String, ProcHandle>>>,
    history: Arc<Mutex<HashMap<String, ProcHistory>>>,
    ext_id: String,
    /// The pid of the process this reader serves: the EOF cleanup may only reap the handle
    /// when it is still THIS process — after a stop+start (a provider switch's restart, the
    /// Extensions view's restart) the map can already hold the fresh process, and an
    /// unguarded remove+kill here would reap the restarted backend mid-handshake.
    pid: u32,
    /// Forwarding channel for a real-Node host's `ggs.hostRequest`s (`None` in the pure
    /// test readers, which get the in-band error instead).
    hooks: Option<Arc<HostHooks>>,
}

impl ReaderState {
    fn serve(self, stdout: impl BufRead) {
        for line in stdout.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let wire = match serde_json::from_str::<Wire>(&line) {
                Ok(wire) => wire,
                Err(error) => {
                    // A dropped line is a lost request or answer: say so where a developer
                    // looks, not only in the in-memory log.
                    let head: String = line.chars().take(200).collect();
                    eprintln!(
                        "[ext] {}: unparsable backend line ({error}): {head}",
                        self.ext_id
                    );
                    push_log(&self.log, format!("unparsable line: {line}"));
                    continue;
                }
            };
            match wire {
                Wire::Response { id, result, error } => {
                    self.resolve(id, result, error.map(|e| e.message))
                }
                Wire::Notification { method, params } => {
                    let message = params
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("`message` missing");
                    // The backend's own log channel (`$/log`: its console, the shim's caught
                    // activation and command errors) — echoed to the app's stderr so a
                    // failing extension is diagnosable without a status view.
                    eprintln!("[ext] {} [{method}] {message}", self.ext_id);
                    push_log(&self.log, format!("[{method}] {message}"));
                    // The same line into the extension host log, the sink a developer
                    // actually reads: an activation that fails after the handshake (a
                    // missing shim, a dead addon) reports only through here — the packaged
                    // app has no stderr to look at. Levels pass through; the backend logs
                    // sparingly (its errors and warnings), so no threshold applies.
                    if method == "$/log" || method == "ggs.log" {
                        let level = params
                            .get("level")
                            .and_then(Value::as_str)
                            .unwrap_or("info");
                        crate::log::append_host_log(vec![format!(
                            "[{level}] [{}] {message}",
                            self.ext_id
                        )])
                        .unwrap_or(());
                    }
                }
                // The one request a backend may make: `ggs.hostRequest`, the real-Node
                // extension host's way of reaching the workbench services a frame reaches
                // by postMessage (settings, mementos, webviews, command registration).
                // Forwarded verbatim; the workbench answers through
                // [`ext_process_host_respond`], written straight to this stdin.
                Wire::Request { id, method, params } if method == "ggs.hostRequest" => {
                    match &self.hooks {
                        Some(hooks) => {
                            let host_method = params
                                .get("method")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            let args = params.get("args").cloned().unwrap_or_else(|| json!([]));
                            // The frontend that answers: the desktop window for a webview,
                            // else the caller in flight (ext_routing), else policy.
                            let claimed = ext_routing::preferred(&self.ext_id, host_method);
                            let frontend = host_request_frontend(hooks, claimed);
                            let caller = ext_routing::caller(&self.ext_id);
                            match ext_routing::routed(&self.ext_id, host_method, &args) {
                                ext_routing::Mirrored::No => {}
                                ext_routing::Mirrored::Everyone => {
                                    // The other frontends mirror the registration (a context
                                    // key, a command, a status bar item) without answering it,
                                    // and follow a webview panel's life with their copy of it.
                                    let _ = (hooks.emit)(
                                        HOST_STATE_EVENT,
                                        json!({
                                            "extId": self.ext_id,
                                            "method": host_method,
                                            "args": args,
                                            "caller": caller,
                                            "served": frontend,
                                        }),
                                    );
                                }
                                ext_routing::Mirrored::Frontends(targets) => {
                                    // Webview traffic (a per-frontend webview's page, §8.6:
                                    // the phone runs its own Git Graph, 2026-10-18), addressed
                                    // to each frontend hosting a live page of the stream —
                                    // their own instance consumes it; everyone else (a copy's
                                    // watchers above all) never carries it on their link.
                                    // The serving frontend reads the request itself.
                                    for target in targets {
                                        if target == frontend {
                                            continue;
                                        }
                                        let _ = (hooks.emit)(
                                            HOST_STATE_EVENT,
                                            json!({
                                                "extId": self.ext_id,
                                                "method": host_method,
                                                "args": args,
                                                "caller": caller,
                                                "served": frontend,
                                                "frontend": target,
                                            }),
                                        );
                                    }
                                }
                            }
                            let payload = json!({
                                "extId": self.ext_id,
                                "id": id,
                                "method": host_method,
                                "args": args,
                                "frontend": frontend,
                            });
                            if !(hooks.emit)(HOST_REQUEST_EVENT, payload) {
                                // The workbench never sees it: answer in band so the host's
                                // request fails now instead of timing out.
                                eprintln!(
                                    "[ext] {}: host request {id} not delivered",
                                    self.ext_id
                                );
                                let reply = proto::response(
                                    id,
                                    Err("the workbench did not receive the request".to_owned()),
                                );
                                let _ =
                                    write_line(&self.procs.lock().unwrap(), &self.ext_id, &reply);
                            }
                        }
                        None => {
                            // No workbench is attached (a headless start): fail the request
                            // in band so the host's promise rejects instead of hanging.
                            let reply =
                                proto::response(id, Err("the app has no host attached".into()));
                            let _ = write_line(&self.procs.lock().unwrap(), &self.ext_id, &reply);
                        }
                    }
                }
                // The host makes every other request; a backend's stray one is logged.
                Wire::Request { method, .. } => {
                    push_log(&self.log, format!("unexpected request: {method}"));
                }
            }
        }
        self.cleanup();
    }

    fn resolve(&self, id: u64, result: Option<Value>, error: Option<String>) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(match error {
                Some(message) => Err(message),
                None => Ok(result.unwrap_or(Value::Null)),
            });
        }
    }

    /// EOF: the backend is gone. Fail everything waiting on it first — a `start` still in its
    /// handshake unblocks through the pending map, not the handle map — then forget the handle
    /// and reap the child, but only if the map still holds THIS reader's process: a deliberate
    /// stop removes the handle first, and a stop+start pair (a provider switch, the Extensions
    /// view's restart) may already have installed the fresh process under the same id — killing
    /// that one here would reap the restarted backend out from under its handshake. A handle
    /// still in the map AND still this process means it died on its own: that crash is the
    /// remembered reason it is not running.
    fn cleanup(&self) {
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err("the backend process exited".to_owned()));
        }
        let mut procs = self.procs.lock().unwrap();
        let still_mine = procs
            .get(&self.ext_id)
            .is_some_and(|handle| handle.child.id() == self.pid);
        if !still_mine {
            return;
        }
        if let Some(mut handle) = procs.remove(&self.ext_id) {
            let _ = handle.child.kill();
            let reason = handle
                .child
                .wait()
                .map(|status| exit_reason(&status))
                .unwrap_or_else(|_| "the backend exited".to_owned());
            push_log(&handle.log, reason.clone());
            if let Some(history) = self.history.lock().unwrap().get_mut(&self.ext_id) {
                history.last_error = Some(reason);
            }
        }
    }
}

/// The backend's exit as a readable reason for the status surface and the log. A fastfail
/// (`0xC0000409`) is what Rust's `rust_oom` abort raises: on this product's machines that
/// has been the machine's commit memory running out under a long claude-code session
/// (2026-10-04's ggs-node crash), which deserves more than a bare "exited" — the session
/// state itself survives (the conversation lives in the CLI's own store), and the backend
/// restarts on its next use.
fn exit_reason(status: &std::process::ExitStatus) -> String {
    // The Windows codes are unsigned; `ExitStatus::code()` reads them as i32.
    const FASTFAIL: i32 = 0xC0000409u32 as i32;
    const ACCESS_VIOLATION: i32 = 0xC0000005u32 as i32;
    const STACK_OVERFLOW: i32 = 0xC00000FDu32 as i32;
    // ggs-node's own exit when a package's native addon calls `napi_fatal_error`.
    const ADDON_FATAL: i32 = 134;
    match status.code() {
        Some(0) => "the backend exited cleanly".to_owned(),
        Some(FASTFAIL) => {
            "the backend died on a fatal abort (0xC0000409) — the machine running out of \
             commit memory, or a fault the runtime could not contain (the backend log's \
             last stderr lines name it); it restarts on its next use"
                .to_owned()
        }
        Some(ADDON_FATAL) => {
            "the backend stopped on a native addon's fatal error (napi_fatal_error) — the \
             backend log carries the addon's message; it restarts on its next use"
                .to_owned()
        }
        Some(ACCESS_VIOLATION) => {
            "the backend died on an access violation (0xC0000005) — a crash inside native \
             code, such as a package's .node addon"
                .to_owned()
        }
        Some(STACK_OVERFLOW) => "the backend died on a stack overflow (0xC00000FD)".to_owned(),
        Some(code) => format!("the backend exited with code {code:#x}"),
        None => "the backend exited without a code (terminated)".to_owned(),
    }
}

/// Write one protocol line to a backend's stdin; the map lock need not be held by the caller,
/// only the handle found through it.
fn write_line(procs: &HashMap<String, ProcHandle>, ext_id: &str, line: &str) -> Result<(), String> {
    let handle = procs
        .get(ext_id)
        .ok_or_else(|| format!("{ext_id} backend is not running"))?;
    let mut guard = handle.stdin.lock().unwrap();
    let stdin = guard
        .as_mut()
        .ok_or_else(|| format!("{ext_id} backend's stdin is closed"))?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("write to {ext_id} backend: {e}"))
}

/// Kill a handle's process and fail its pending calls; an error when nothing runs. Called
/// with the map lock held (by `stop` and the handshake failure paths).
fn drop_handle(procs: &mut HashMap<String, ProcHandle>, ext_id: &str) -> Result<(), String> {
    let Some(mut handle) = procs.remove(ext_id) else {
        return Err(format!("{ext_id} has no running backend"));
    };
    // Best-effort goodbye; the kill below is the real guarantee.
    if let Some(mut stdin) = handle.stdin.lock().unwrap().take() {
        let goodbye = proto::notification("shutdown", Value::Null);
        let _ = stdin.write_all(goodbye.as_bytes());
        let _ = stdin.flush();
    }
    for (_, tx) in handle.pending.lock().unwrap().drain() {
        let _ = tx.send(Err("the backend was stopped".to_owned()));
    }
    handle
        .child
        .kill()
        .map_err(|e| format!("kill {ext_id} backend: {e}"))?;
    let _ = handle.child.wait();
    Ok(())
}

/// The backend command of a package: absolute as-is (how the tests point at a helper binary),
/// relative confined to the package directory, like every other path out of a package. A
/// JavaScript entry may be written extensionlessly (a manifest `main` of `out/extension`),
/// so the exact path falls back to the `.js` and `.cjs` spellings Node itself would try.
fn resolve_command(ext_dir: &Path, command: &str) -> Result<PathBuf, String> {
    let as_path = Path::new(command);
    if !as_path.is_absolute() && command.split(['/', '\\']).any(|segment| segment == "..") {
        return Err(format!(
            "backend command may not climb out of the package: {command}"
        ));
    }
    let resolved = if as_path.is_absolute() {
        as_path.to_path_buf()
    } else {
        ext_dir.join(as_path)
    };
    if resolved.is_file() {
        return Ok(resolved);
    }
    for extension in [".js", ".cjs"] {
        let with_extension = PathBuf::from(format!("{}{extension}", resolved.display()));
        if with_extension.is_file() {
            return Ok(with_extension);
        }
    }
    Err(format!(
        "backend command {command} not found (looked at {})",
        resolved.display()
    ))
}

/// The real Node runtime a `node` backend runs on when one exists: `GGS_NODE_EXE` first,
/// then a `node` beside the app (a drop-in the packager or the user may place), then the
/// `PATH`. Only consulted under `GGS_REAL_NODE`; `None` (or the gate itself) means every
/// `node` backend runs on the bundled pretend runtime — the shape that needs nothing from
/// the machine.
pub fn find_node_runtime() -> Option<PathBuf> {
    if let Ok(named) = std::env::var("GGS_NODE_EXE") {
        let path = PathBuf::from(named);
        if path.is_file() {
            return Some(path);
        }
    }
    let exe_name = if cfg!(windows) { "node.exe" } else { "node" };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let beside = dir.join(exe_name);
            if beside.is_file() {
                return Some(beside);
            }
            let drop_in = dir.join("node").join(exe_name);
            if drop_in.is_file() {
                return Some(drop_in);
            }
        }
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(exe_name))
        .find(|candidate| candidate.is_file())
}

/// The real-Node extension host bundle (`node-host.cjs`, built by `prepare.mjs`): beside
/// the app (the installer resources place it there), one profile up second (a dev run
/// executes from `debug/` while `prepare.mjs` writes the bundle into `release/`'s
/// siblings), the dev target layout third (`target/studio/node-host.cjs`), the resource
/// copy fourth, `GGS_NODE_HOST_SCRIPT` last — the dev and test override.
pub fn find_node_host_script() -> Option<PathBuf> {
    if let Ok(named) = std::env::var("GGS_NODE_HOST_SCRIPT") {
        let path = PathBuf::from(named);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("node-host.cjs"));
            candidates.push(dir.join("..").join("release").join("node-host.cjs"));
            // The dev target layout: `target/studio/cargo/debug` is two levels under
            // `target/studio`, where `prepare.mjs` writes the bundle and its resource copy.
            candidates.push(dir.join("..").join("..").join("node-host.cjs"));
            candidates.push(
                dir.join("..")
                    .join("..")
                    .join("bundled")
                    .join("app-resources")
                    .join("node-host.cjs"),
            );
        }
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

/// Whether this backend starts with the workbench instead of at the boot pass. A `node`
/// backend is an extension program (on ggs-node its `initialize` installs the frame
/// program and activates it; on the real-Node host the same): its activation's
/// `ggs.hostRequest`s need the workbench listening, and its activation belongs to the
/// workbench's policy — so the boot pass leaves it to the frontend's eager pass, which
/// starts it the moment the window is up. `process` backends (no vscode program) start at
/// boot as always.
fn deferred_to_the_workbench(backend: &BackendDecl) -> bool {
    backend.kind == "node"
}

/// The backend a main-only package (a plain VS Code extension with no `ggs` key) gets
/// when the real-Node extension host is opted in (`GGS_REAL_NODE`): the manifest's `main`
/// as a `node` entry — one extension-host process per package, exactly VS Code's shape.
/// Under the default (ggs-node everywhere) a main-only package gets no backend at all:
/// the sandboxed frame host owns it, as it always did before a system Node existed.
fn synthesize_extension_host_backend(ext_dir: &Path) -> Result<BackendDecl, String> {
    let allowed = crate::real_node_allowed();
    synthesize_extension_host_backend_with(
        ext_dir,
        allowed && find_node_runtime().is_some(),
        allowed && find_node_host_script().is_some(),
    )
}

/// [`synthesize_extension_host_backend`]'s pure core, the runtime halves injectable.
fn synthesize_extension_host_backend_with(
    ext_dir: &Path,
    node: bool,
    script: bool,
) -> Result<BackendDecl, String> {
    if !node || !script {
        return Err("declares no backend".to_owned());
    }
    let package = std::fs::read_to_string(ext_dir.join("package.json"))
        .map_err(|e| format!("read {} package.json: {e}", ext_dir.display()))
        .and_then(|text| {
            serde_json::from_str::<Value>(&text).map_err(|e| format!("invalid package.json: {e}"))
        })?;
    let main = package
        .get("main")
        .and_then(Value::as_str)
        .unwrap_or("index.js");
    Ok(BackendDecl {
        kind: "node".to_owned(),
        command: main.to_owned(),
        args: Vec::new(),

        protocol: None,
        binaries: None,
    })
}

#[cfg(test)]
mod engine_host_tests {
    use super::{deferred_to_the_workbench, synthesize_extension_host_backend_with};
    use crate::store::BackendDecl;

    fn node_backend() -> BackendDecl {
        BackendDecl {
            kind: "node".to_owned(),
            command: "out/main.js".to_owned(),
            args: Vec::new(),
            protocol: None,
            binaries: None,
        }
    }

    /// A `node` backend is an extension program, so it starts with the workbench — on
    /// ggs-node (the default) its `initialize` answers at once and the activation runs as
    /// the next job, speaking to the workbench from behind it, exactly as the real-Node
    /// host's settled handshake does — never at the boot pass, before the
    /// `host.env` listener exists. A process backend (no vscode program) boots as always.
    #[test]
    fn a_node_backend_starts_with_the_workbench_on_either_host() {
        assert!(deferred_to_the_workbench(&node_backend()));
        let mut process = node_backend();
        process.kind = "process".to_owned();
        assert!(!deferred_to_the_workbench(&process));
    }

    /// A main-only package gets no synthesized backend unless the real-Node host is opted
    /// in (its error is the honest "declares no backend"; the sandboxed frame host owns
    /// the package). With the host, the manifest's `main` becomes a default-host `node`
    /// backend.
    #[test]
    fn a_main_only_package_synthesizes_an_extension_host_backend_only_with_a_real_node() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("package.json"),
            br#"{"main":"./out/extension.js"}"#,
        )
        .unwrap();
        let without = synthesize_extension_host_backend_with(tmp.path(), false, false).unwrap_err();
        assert_eq!(without, "declares no backend");
        let backend = synthesize_extension_host_backend_with(tmp.path(), true, true).unwrap();
        assert_eq!(backend.kind, "node");
        assert_eq!(backend.command, "./out/extension.js");
        // A package without a `main` falls to Node's own default entry.
        std::fs::write(tmp.path().join("package.json"), br#"{"name":"x"}"#).unwrap();
        let fallback = synthesize_extension_host_backend_with(tmp.path(), true, true).unwrap();
        assert_eq!(fallback.command, "index.js");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    /// An `ExitStatus` whose `code()` reads as `raw_code`: Windows takes the exit code
    /// verbatim (unsigned; `code()` reads it back as i32). A Unix wait status carries a
    /// one-byte exit code in its second byte — the fastfail, access-violation and
    /// stack-overflow codes past that byte exist only on a Windows backend.
    #[cfg(windows)]
    fn exit_status(raw_code: u32) -> std::process::ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(raw_code)
    }

    #[cfg(unix)]
    fn exit_status(raw_code: u32) -> std::process::ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(((raw_code & 0xFF) as i32) << 8)
    }

    /// The status surface reads a dead backend's reason from here: a fastfail must not
    /// read as a bare "exited" — on this product's machines it is the machine's commit
    /// memory running out under a long session.
    #[test]
    fn an_exit_code_reads_as_its_reason() {
        assert!(exit_reason(&exit_status(0)).contains("cleanly"));
        assert!(exit_reason(&exit_status(1)).contains("0x1"));
        assert!(exit_reason(&exit_status(134)).contains("napi_fatal_error"));
        #[cfg(windows)]
        {
            assert!(exit_reason(&exit_status(0xC0000409)).contains("0xC0000409"));
            assert!(exit_reason(&exit_status(0xC0000409)).contains("commit memory"));
            assert!(exit_reason(&exit_status(0xC0000005)).contains("access violation"));
            assert!(exit_reason(&exit_status(0xC00000FD)).contains("stack overflow"));
            assert!(exit_reason(&exit_status(0xFFFFFFFF)).contains("0xffffffff"));
        }
    }

    fn make_reader(pending: &PendingMap) -> ReaderState {
        ReaderState {
            pending: Arc::clone(pending),
            log: Arc::new(Mutex::new(Vec::new())),
            procs: Arc::new(Mutex::new(HashMap::new())),
            history: Arc::new(Mutex::new(HashMap::new())),
            ext_id: "acme.demo".to_owned(),
            pid: 0,
            hooks: None,
        }
    }

    /// A real-Node host's `ggs.hostRequest` with no workbench attached fails in band (the
    /// host's promise rejects) instead of hanging — and never kills the reader.
    #[test]
    fn a_host_request_without_an_attached_app_fails_in_band() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let reader = make_reader(&pending);
        // The procs map holds no handle, so the in-band reply has nowhere to go and is
        // dropped — the assertion is that `serve` survives the request line at all.
        reader.serve(Cursor::new(proto::request(
            9,
            "ggs.hostRequest",
            json!({ "method": "host.env", "args": [] }),
        )));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn responses_resolve_their_pending_calls() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::channel();
        pending.lock().unwrap().insert(5, tx);
        make_reader(&pending).serve(Cursor::new(proto::response(5, Ok(json!("done")))));
        assert_eq!(rx.recv().unwrap().unwrap(), json!("done"));

        // An error response surfaces its message, not its code.
        let (tx, rx) = mpsc::channel();
        pending.lock().unwrap().insert(6, tx);
        make_reader(&pending).serve(Cursor::new(proto::response(
            6,
            Err("unknown command".into()),
        )));
        assert_eq!(rx.recv().unwrap().unwrap_err(), "unknown command");
    }

    #[test]
    fn stdout_closing_fails_every_pending_call() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::channel();
        pending.lock().unwrap().insert(1, tx);
        make_reader(&pending).serve(Cursor::new(""));
        assert_eq!(
            rx.recv().unwrap().unwrap_err(),
            "the backend process exited"
        );
    }

    /// The restart race: a backend's reader reaches its EOF cleanup only after a stop+start
    /// already installed the FRESH process under the same extension id. The cleanup must fail
    /// its own pending calls but leave the fresh handle in the map — removing and killing it
    /// reaped the restarted backend mid-handshake (a provider switch then left the sidebar on
    /// the old provider's page, the very bug the restart was fixing). Only the reader whose
    /// pid still matches the mapped handle reaps it.
    #[test]
    fn an_eof_cleanup_reaps_only_its_own_process() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let procs: Arc<Mutex<HashMap<String, ProcHandle>>> = Arc::new(Mutex::new(HashMap::new()));
        // A stand-in child: the freshly restarted backend sitting in the handle map. `--list`
        // makes the test binary exit at once — only the pid matters here.
        let child = Command::new(std::env::current_exe().unwrap())
            .arg("--list")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let fresh_pid = child.id();
        procs.lock().unwrap().insert(
            "acme.demo".to_owned(),
            ProcHandle {
                child,
                stdin: Mutex::new(None),
                pending: Arc::clone(&pending),
                next_id: AtomicU64::new(1),
                commands: Vec::new(),
                log: Arc::new(Mutex::new(Vec::new())),
            },
        );

        // The OLD process's reader: its pid no longer matches the mapped handle — it must
        // not remove or kill the fresh one.
        let mut stale = make_reader(&pending);
        stale.procs = Arc::clone(&procs);
        stale.pid = fresh_pid + 1;
        stale.cleanup();
        assert!(
            procs.lock().unwrap().contains_key("acme.demo"),
            "the old reader's cleanup reaped the restarted backend"
        );

        // The fresh process's own reader still reaps it on EOF.
        let mut own = make_reader(&pending);
        own.procs = Arc::clone(&procs);
        own.pid = fresh_pid;
        own.cleanup();
        assert!(procs.lock().unwrap().is_empty());
    }

    /// A backend log notification is logged, not dropped as unparsable.
    #[test]
    fn a_backend_log_notification_is_logged_not_dropped_as_unparsable() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let reader = make_reader(&pending);
        let log = Arc::clone(&reader.log);
        reader.serve(Cursor::new(proto::notification(
            "$/log",
            json!({ "message": "> git fetch [12ms]" }),
        )));
        let lines = log.lock().unwrap().clone();
        assert!(lines.iter().any(|l| l.contains("git fetch")), "{lines:?}");
    }

    /// A registered spawn-env source answers the spawn environment per extension id —
    /// the composition-root seam the provider bridge wires (`lib.rs`), unknown ids
    /// answered with nothing.
    #[test]
    fn a_registered_spawn_env_source_reaches_the_spawn_environment() {
        fn source(ext_id: &str) -> Vec<(String, String)> {
            if ext_id == "acme.probe" {
                vec![("PROBE_VAR".to_owned(), "on".to_owned())]
            } else {
                Vec::new()
            }
        }
        add_spawn_env_source(source);
        assert_eq!(
            spawn_env("acme.probe"),
            vec![("PROBE_VAR".to_owned(), "on".to_owned())]
        );
        assert!(spawn_env("acme.other").is_empty());
    }

    #[test]
    fn the_backend_command_is_confined_to_the_package() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("main"), b"#!").unwrap();
        assert!(resolve_command(tmp.path(), "main").is_ok());
        assert!(resolve_command(tmp.path(), "nested/tool").is_err()); // not present
        assert!(resolve_command(tmp.path(), "../escape").is_err());
        // An absolute path is allowed as-is: it is how the tests point at a helper binary.
        let absolute = tmp.path().join("main");
        assert!(resolve_command(tmp.path(), absolute.to_str().unwrap()).is_ok());
    }
}
