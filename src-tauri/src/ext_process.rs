//! The process extension host: the backend half of a `ggs/2` package whose manifest declares
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

use crate::cmd_ext;
use crate::ext_protocol::{self as proto, Wire};

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
        let manifest: cmd_ext::StudioManifest =
            std::fs::read_to_string(ext_dir.join("manifest.json"))
                .map_err(|e| format!("read {} manifest.json: {e}", ext_dir.display()))
                .and_then(|text| {
                    serde_json::from_str(&text).map_err(|e| format!("invalid manifest.json: {e}"))
                })?;
        let backend = manifest
            .backend
            .as_ref()
            .ok_or_else(|| format!("{ext_id} declares no backend"))?;
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
        // A `node` backend is the package's engine `.node` (the one engine binary the editor's
        // Node runtime also loads), served by the app-bundled engine host the manifest names:
        // the same ggs-ext/1 handshake, crash isolation and warm restarts, with the engine
        // loaded over its C ABI instead of linked into a package-owned executable.
        let (program, engine_node) = if backend.kind == "node" {
            let host = backend.host.clone().unwrap_or_default();
            let node =
                resolve_command(&ext_dir, backend.command_for(&cmd_ext::host_platform_key()))?;
            (resolve_engine_host(&host)?, Some(node))
        } else {
            (
                resolve_command(&ext_dir, backend.command_for(&cmd_ext::host_platform_key()))?,
                None,
            )
        };
        let mut command = Command::new(&program);
        command
            .args(&backend.args)
            .current_dir(&ext_dir)
            .env("GGS_INSTANCE_ID", instance_id())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(node) = engine_node.as_deref() {
            command.arg(node);
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

        let (tx, rx) = mpsc::channel();
        pending.lock().unwrap().insert(1, tx);
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
        let handshake_result = match rx.recv_timeout(HANDSHAKE_TIMEOUT) {
            Ok(Ok(value)) => value,
            Ok(Err(message)) => {
                let _ = drop_handle(&mut procs, ext_id);
                return Err(format!(
                    "{ext_id} failed its initialize handshake: {message}"
                ));
            }
            Err(_) => {
                let _ = drop_handle(&mut procs, ext_id);
                return Err(format!(
                    "{ext_id} did not answer initialize within {} s",
                    HANDSHAKE_TIMEOUT.as_secs()
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
}

impl ReaderState {
    fn serve(self, stdout: impl BufRead) {
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
                // The host makes the requests; a backend's stray one is logged, not answered
                // (there is no request path back into the plugin's stdin here).
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

/// The app-bundled engine host a `node` backend names (`git-graph-backend`): beside the app's
/// own binary first (the installer resources place the two together, and cargo's output
/// directory holds both during a build), one profile up second (a dev run executes from
/// `debug/` while `prepare.mjs` builds the host into `release/`), and exactly where
/// `GGS_ENGINE_HOST` says last — the dev and test override. Only a host that ships with the
/// app can ever run: the manifest names one, it never brings its own, so a package cannot
/// smuggle an executable through a `node` backend.
fn resolve_engine_host(name: &str) -> Result<PathBuf, String> {
    if name
        .split(['/', '\\'])
        .any(|segment| segment == ".." || segment.is_empty())
    {
        return Err(format!("engine host name may not be a path: {name}"));
    }
    let file_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("GGS_ENGINE_HOST") {
        candidates.push(PathBuf::from(dir).join(&file_name));
    }
    if let Ok(exe_dir) = std::env::current_exe()
        .map_err(|e| format!("could not locate the app binary: {e}"))
        .and_then(|exe| {
            exe.parent()
                .map(Path::to_owned)
                .ok_or_else(|| "no parent".to_owned())
        })
    {
        candidates.push(exe_dir.join(&file_name));
        candidates.push(exe_dir.join("..").join("release").join(&file_name));
    }
    candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .cloned()
        .ok_or_else(|| {
            format!(
                "engine host {name} not found (looked at {})",
                candidates
                    .iter()
                    .map(|c| c.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

#[cfg(test)]
mod engine_host_tests {
    use super::resolve_engine_host;

    /// A host name that is a path is refused outright — the field names an app-bundled
    /// binary, never a location.
    #[test]
    fn an_engine_host_name_may_not_be_a_path() {
        assert!(resolve_engine_host("../evil").is_err());
        assert!(resolve_engine_host("some/dir").is_err());
    }
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
        ReaderState {
            pending: Arc::clone(pending),
            log: Arc::new(Mutex::new(Vec::new())),
            procs: Arc::new(Mutex::new(HashMap::new())),
            history: Arc::new(Mutex::new(HashMap::new())),
            ext_id: "acme.demo".to_owned(),
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
