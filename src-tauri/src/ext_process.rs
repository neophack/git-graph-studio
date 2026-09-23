//! The process extension host: the backend half of a `ggx/2` package whose manifest declares
//! `backend: { "kind": "process", "command": "bin/main" }`. The backend binary speaks one of
//! two line-JSON protocols, picked by the manifest's `backend.protocol`
//! ([`cmd_ext::GgxBackend::protocol_or_default`]): `ggs-ext/1` (`ggx_protocol.rs`, the
//! default — one request answered at a time, for command-style plugins any language can write)
//! or `ggx-rpc/1` (`backend_rpc.rs` — a request per thread, for the git-graph engine backend,
//! which answers bursts of concurrent reads). The process-lifecycle plumbing below (spawn,
//! crash isolation, the pending-call map, status/history) is shared between both; only the
//! handshake method, the outbound request envelope and the reply parsing differ, branched on
//! [`ProcKind`].
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

use crate::cmd_ext;
use crate::ggx_protocol::{self as proto, Wire};

/// How long `initialize` may take before the backend is declared unresponsive and killed.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Lines of stderr and `$/log` kept per process, for the status view and crash reports.
const LOG_CAP: usize = 200;

/// A pending call's reply channel (the result of one JSON-RPC request), by request id.
type PendingMap = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>;

/// The running backends, one per extension id, managed by the app (`lib.rs`). `Clone` is cheap
/// (both fields are `Arc`s) and deliberate: [`global`] and the Tauri-managed instance
/// (`lib.rs`'s `.manage(ext_process::global().clone())`) are two handles onto the same running
/// processes, so `plugin_host.rs` (no `AppHandle` to fetch Tauri-managed state through) and the
/// Extensions view's `ext_process_*` commands (which do have one) agree on what is running.
#[derive(Default, Clone)]
pub struct ProcessHostState {
    /// Shared with the reader threads, which forget a handle when its process dies. An `Arc`
    /// (not a bare `Mutex`) because `State` must stay `Send + Sync` while threads hold a copy.
    procs: Arc<Mutex<HashMap<String, ProcHandle>>>,
    /// The folders the app last reported open (`notify_workspace`): carried into every
    /// backend's start handshake, so a lazily-started backend still learns its workspace.
    workspace: Arc<Mutex<Vec<String>>>,
    /// What survives a backend's death: how often it came up, and why it is not running now.
    /// The status surface reads it so a dead backend can say more than "absent".
    history: Arc<Mutex<HashMap<String, ProcHistory>>>,
}

/// The process-wide handle onto the running backends — see the struct doc. Mirrors
/// `git-graph-core`'s own `RepoManager::global()` pattern: a lazily-initialized singleton
/// reachable without threading an `AppHandle` through every caller.
pub fn global() -> &'static ProcessHostState {
    static STATE: OnceLock<ProcessHostState> = OnceLock::new();
    STATE.get_or_init(ProcessHostState::default)
}

struct ProcHandle {
    child: Child,
    stdin: Mutex<Option<ChildStdin>>,
    pending: PendingMap,
    next_id: AtomicU64,
    /// The commands the backend declared in its `initialize` handshake (`ggs-ext/1` only;
    /// empty for a `ggx-rpc/1` backend, which has no command-list concept).
    commands: Vec<String>,
    log: Arc<Mutex<Vec<String>>>,
    kind: ProcKind,
}

/// Which of the two backend protocols a running handle speaks — see the module doc.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ProcKind {
    GgsExt1,
    GgxRpc1,
}

impl ProcKind {
    fn from_protocol(protocol: &str) -> Self {
        if protocol == crate::backend_rpc::PROTOCOL_VERSION {
            ProcKind::GgxRpc1
        } else {
            ProcKind::GgsExt1
        }
    }

    fn protocol_version(self) -> &'static str {
        match self {
            ProcKind::GgsExt1 => proto::PROTOCOL_VERSION,
            ProcKind::GgxRpc1 => crate::backend_rpc::PROTOCOL_VERSION,
        }
    }

    /// The handshake method the host sends first: `initialize` (`ggs-ext/1`) or `hello`
    /// (`ggx-rpc/1`).
    fn handshake_method(self) -> &'static str {
        match self {
            ProcKind::GgsExt1 => "initialize",
            ProcKind::GgxRpc1 => "hello",
        }
    }
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
fn instance_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| format!("ggs-{}", std::process::id()))
}

impl ProcHandle {
    fn info(&self, ext_id: &str, history: Option<&ProcHistory>) -> ProcessInfo {
        ProcessInfo {
            extension_id: ext_id.to_owned(),
            pid: self.child.id(),
            commands: self.commands.clone(),
            protocol_version: self.kind.protocol_version().to_owned(),
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

impl ProcessHostState {
    /// Spawn `ext_id`'s backend and complete the `initialize` handshake. Idempotent: a
    /// backend that is already running is returned as-is. The map lock is held across the
    /// handshake (at most `HANDSHAKE_TIMEOUT`), so a concurrent `run` of the same extension
    /// waits for its own backend rather than spawning a second one. Failures are remembered
    /// in the history (the status surface shows them) and returned.
    pub fn start(&self, exts_dir: &Path, ext_id: &str) -> Result<ProcessInfo, String> {
        match self.start_inner(exts_dir, ext_id) {
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
        let ext_dir = cmd_ext::installed_dir(exts_dir, ext_id)?;
        let manifest: cmd_ext::GgxManifest = std::fs::read_to_string(ext_dir.join("manifest.json"))
            .map_err(|e| format!("read {} manifest.json: {e}", ext_dir.display()))
            .and_then(|text| {
                serde_json::from_str(&text).map_err(|e| format!("invalid manifest.json: {e}"))
            })?;
        let backend = manifest
            .backend
            .as_ref()
            .ok_or_else(|| format!("{ext_id} declares no backend"))?;
        if backend.kind != "process" {
            return Err(format!(
                "{ext_id} declares backend kind {}; this app speaks process",
                backend.kind
            ));
        }
        let kind = ProcKind::from_protocol(backend.protocol_or_default());
        let program =
            resolve_command(&ext_dir, backend.command_for(&cmd_ext::host_platform_key()))?;
        let mut command = Command::new(&program);
        command
            .args(&backend.args)
            .current_dir(&ext_dir)
            .env("GGS_INSTANCE_ID", instance_id())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
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

        // The stdout reader: resolves responses, records notifications, and — on EOF — fails
        // everything waiting on the backend, forgets the handle and reaps the child. The
        // pending map is drained before the map is touched, so a process that dies during its
        // handshake unblocks `start` even while `start` still holds the map lock.
        let reader = ReaderState {
            pending: Arc::clone(&pending),
            log: Arc::clone(&log),
            procs: Arc::clone(&self.procs),
            history: Arc::clone(&self.history),
            ext_id: ext_id.to_owned(),
            kind,
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
            kind,
        };
        procs.insert(ext_id.to_owned(), handle);

        let (tx, rx) = mpsc::channel();
        pending.lock().unwrap().insert(1, tx);
        let workspace_folders = self
            .workspace
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let handshake_line = match kind {
            ProcKind::GgsExt1 => proto::request(
                1,
                kind.handshake_method(),
                json!({
                    "protocolVersion": kind.protocol_version(),
                    "extensionId": ext_id,
                    "extensionPath": ext_dir,
                    "workspaceFolders": workspace_folders,
                }),
            ),
            ProcKind::GgxRpc1 => crate::backend_rpc::request(
                1,
                kind.handshake_method(),
                json!({ "extensionId": ext_id, "extensionPath": ext_dir, "workspaceFolders": workspace_folders }),
            ),
        };
        if let Err(e) = write_line(&procs, ext_id, &handshake_line) {
            let _ = drop_handle(&mut procs, ext_id);
            return Err(e);
        }
        let handshake_result = match rx.recv_timeout(HANDSHAKE_TIMEOUT) {
            Ok(Ok(value)) => value,
            Ok(Err(message)) => {
                let _ = drop_handle(&mut procs, ext_id);
                return Err(format!(
                    "{ext_id} failed its {} handshake: {message}",
                    kind.handshake_method()
                ));
            }
            Err(_) => {
                let _ = drop_handle(&mut procs, ext_id);
                return Err(format!(
                    "{ext_id} did not answer {} within {} s",
                    kind.handshake_method(),
                    HANDSHAKE_TIMEOUT.as_secs()
                ));
            }
        };
        // `ggs-ext/1`'s `initialize` answers a command list; `ggx-rpc/1`'s `hello` has no
        // command-list concept (the graph engine backend answers one `request` verb).
        let commands: Vec<String> = match kind {
            ProcKind::GgsExt1 => handshake_result
                .pointer("/capabilities/commands")
                .and_then(Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            ProcKind::GgxRpc1 => Vec::new(),
        };
        let info = {
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
    /// `stop` (or the process dying) fails the call. `ggs-ext/1`'s single RPC verb.
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

    /// One opaque message for a `ggx-rpc/1` backend (the graph engine protocol: `{repo,
    /// message, settings}` answered by the backend's own dispatch) — the page RPC
    /// `backend.message` reaches this, so a plugin's pages speak their own backend's protocol
    /// through the host without the host interpreting a word of it.
    pub fn message(
        &self,
        exts_dir: &Path,
        ext_id: &str,
        message: Value,
        settings: Value,
    ) -> Result<Value, String> {
        self.call(
            exts_dir,
            ext_id,
            "request",
            json!({ "repo": "", "message": message, "settings": settings }),
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
            let line = match handle.kind {
                ProcKind::GgsExt1 => proto::request(id, "workspaceChanged", params.clone()),
                ProcKind::GgxRpc1 => {
                    crate::backend_rpc::request(id, "workspaceChanged", params.clone())
                }
            };
            let _ = write_line(&procs, ext_id, &line);
        }
    }

    /// The general call: any method, any params, against either protocol — starting the
    /// backend first if it is not running. `ggs-ext/1`'s `run` is `call(.., "runCommand", ..)`;
    /// `message` is `call(.., "request", ..)` for the `ggx-rpc/1` plugins.
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
            let line = match handle.kind {
                ProcKind::GgsExt1 => proto::request(id, method, params),
                ProcKind::GgxRpc1 => crate::backend_rpc::request(id, method, params),
            };
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
    pub fn start_all_installed(&self, exts_dir: &Path) -> Vec<Result<ProcessInfo, String>> {
        cmd_ext::process_backed_ids(exts_dir)
            .into_iter()
            .map(|ext_id| self.start(exts_dir, &ext_id))
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
    kind: ProcKind,
}

impl ReaderState {
    fn serve(self, stdout: impl BufRead) {
        match self.kind {
            ProcKind::GgsExt1 => self.serve_ggs_ext1(stdout),
            ProcKind::GgxRpc1 => self.serve_ggx_rpc1(stdout),
        }
        self.cleanup();
    }

    fn serve_ggs_ext1(&self, stdout: impl BufRead) {
        for line in stdout.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(wire) = serde_json::from_str::<Wire>(&line) else {
                push_log(&self.log, format!("unparsable line: {line}"));
                continue;
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
                    push_log(&self.log, format!("[{method}] {message}"));
                }
                // The host makes the requests in ggs-ext/1; a plugin's stray one is logged,
                // not answered (there is no request path back into the plugin's stdin here).
                Wire::Request { method, .. } => {
                    push_log(&self.log, format!("unexpected request: {method}"));
                }
            }
        }
    }

    fn serve_ggx_rpc1(&self, stdout: impl BufRead) {
        use crate::backend_rpc::Wire as RpcWire;
        for line in stdout.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(wire) = serde_json::from_str::<RpcWire>(&line) else {
                push_log(&self.log, format!("unparsable line: {line}"));
                continue;
            };
            match wire {
                RpcWire::Response { id, result, error } => {
                    self.resolve(id, result, error.map(|e| e.message))
                }
                // The backend's push events: git's command echo and its one-time "up" signal —
                // both fold into the same log the Extensions status view and crash reports read.
                RpcWire::Event { event, line } => {
                    push_log(&self.log, format!("[{event}] {}", line.unwrap_or_default()));
                }
                // The host makes the requests in ggx-rpc/1 too; a stray one from the backend is
                // logged, not answered.
                RpcWire::Request { method, .. } => {
                    push_log(
                        &self.log,
                        format!("unexpected request from backend: {method}"),
                    );
                }
            }
        }
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
    /// and reap the child. A handle still in the map means the process died on its own (a
    /// deliberate stop removes the handle first): that crash is the remembered reason it is
    /// not running.
    fn cleanup(&self) {
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err("the backend process exited".to_owned()));
        }
        if let Some(mut handle) = self.procs.lock().unwrap().remove(&self.ext_id) {
            push_log(&handle.log, "backend exited".to_owned());
            if let Some(history) = self.history.lock().unwrap().get_mut(&self.ext_id) {
                history.last_error = Some("the backend exited".to_owned());
            }
            let _ = handle.child.kill();
            let _ = handle.child.wait();
        }
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
        let goodbye = match handle.kind {
            ProcKind::GgsExt1 => proto::notification("shutdown", Value::Null),
            // ggx-rpc/1's `shutdown` is a request the backend answers before exiting its own
            // read loop (`backend_rpc::serve_backend`); nothing here waits for that answer.
            ProcKind::GgxRpc1 => crate::backend_rpc::request(0, "shutdown", Value::Null),
        };
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
/// relative confined to the package directory, like every other path out of a package.
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
    if !resolved.is_file() {
        return Err(format!(
            "backend command {command} not found (looked at {})",
            resolved.display()
        ));
    }
    Ok(resolved)
}

// ---------------------------------------------------------------------------
// The Tauri commands (thin: resolve the extensions directory, delegate to the core above)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ext_process_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProcessHostState>,
    ext_id: String,
) -> Result<ProcessInfo, String> {
    state.start(&cmd_ext::extensions_dir(&app)?, &ext_id)
}

#[tauri::command]
pub fn ext_process_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProcessHostState>,
    ext_id: String,
    command: String,
    args: Option<Value>,
) -> Result<Value, String> {
    state.run(
        &cmd_ext::extensions_dir(&app)?,
        &ext_id,
        &command,
        args.unwrap_or_else(|| json!([])),
    )
}

/// One opaque message for a `ggx-rpc/1` package's backend — the page RPC `backend.message`
/// reaches this, the host forwarding without interpreting the protocol.
#[tauri::command]
pub fn ext_process_message(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProcessHostState>,
    ext_id: String,
    message: Value,
    settings: Option<Value>,
) -> Result<Value, String> {
    state.message(
        &cmd_ext::extensions_dir(&app)?,
        &ext_id,
        message,
        settings.unwrap_or(Value::Null),
    )
}

#[tauri::command]
pub fn ext_process_stop(
    state: tauri::State<'_, ProcessHostState>,
    ext_id: String,
) -> Result<(), String> {
    state.stop(&ext_id)
}

#[tauri::command]
pub fn ext_process_status(
    state: tauri::State<'_, ProcessHostState>,
) -> Result<Vec<ProcessInfo>, String> {
    Ok(state.status())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    fn make_reader(pending: &PendingMap) -> ReaderState {
        make_reader_kind(pending, ProcKind::GgsExt1)
    }

    fn make_reader_kind(pending: &PendingMap, kind: ProcKind) -> ReaderState {
        ReaderState {
            pending: Arc::clone(pending),
            log: Arc::new(Mutex::new(Vec::new())),
            procs: Arc::new(Mutex::new(HashMap::new())),
            history: Arc::new(Mutex::new(HashMap::new())),
            ext_id: "acme.demo".to_owned(),
            kind,
        }
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

    #[test]
    fn ggx_rpc1_responses_resolve_their_pending_calls_too() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::channel();
        pending.lock().unwrap().insert(9, tx);
        make_reader_kind(&pending, ProcKind::GgxRpc1).serve(Cursor::new(
            crate::backend_rpc::response(9, Ok(json!({ "commits": [] }))),
        ));
        assert_eq!(rx.recv().unwrap().unwrap(), json!({ "commits": [] }));
    }

    #[test]
    fn ggx_rpc1_push_events_are_logged_not_dropped_as_unparsable() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let reader = make_reader_kind(&pending, ProcKind::GgxRpc1);
        let log = Arc::clone(&reader.log);
        reader.serve(Cursor::new(format!(
            "{}{}",
            crate::backend_rpc::log_event("> git fetch [12ms]"),
            crate::backend_rpc::ready_event(),
        )));
        let lines = log.lock().unwrap().clone();
        assert!(lines.iter().any(|l| l.contains("git fetch")), "{lines:?}");
        assert!(lines.iter().any(|l| l == "[ready] "), "{lines:?}");
    }

    #[test]
    fn a_backend_protocol_picks_the_matching_kind() {
        assert_eq!(ProcKind::from_protocol("ggs-ext/1"), ProcKind::GgsExt1);
        assert_eq!(ProcKind::from_protocol("ggx-rpc/1"), ProcKind::GgxRpc1);
        // An unrecognized value degrades to the command-style default rather than failing to
        // spawn at all.
        assert_eq!(ProcKind::from_protocol("something-else"), ProcKind::GgsExt1);
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
