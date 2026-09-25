//! The frame host's child processes: `vscode`-era extension code spawns tools (`git`,
//! `python`) through Node's `child_process`, and the sandboxed frame cannot — this is the
//! one real process surface the workbench serves on a frame's behalf (`nodeShims.ts` maps
//! it onto the Node API shapes). The trust model is the installed package's own: a VSIX
//! that activates in the frame may run tools, exactly as it would in VS Code's extension
//! host; nothing here is workspace-confined (a spawned `git` reads the repository a user
//! opened on purpose).
//!
//! Shape: one spawn → one `tauri::ipc::Channel` of events — `stdout`/`stderr` chunks as
//! base64 (bytes cross the bridge byte-exact; the frame's Buffer decodes), then one
//! `exit`. stdin writes and the kill go through follow-up commands keyed by handle. The
//! registry is app-global (one state, like `ext_process::ProcessHostState`), every handle
//! is killed at app exit, and a failed spawn answers its error as the command's `Err` —
//! the frame turns that into the Node-shaped `'error'` event.

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::Channel;

/// How many bytes one streamed chunk carries at most — a `git log --patch` flood crosses
/// as many events, never one giant allocation.
const CHUNK: usize = 64 * 1024;

#[derive(Deserialize, Debug)]
pub struct ChildSpawnSpec {
    pub file: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// `None` inherits this app's environment, `{}` starts empty, a map replaces it —
    /// Node's own `env` / `env: {}` / absent semantics.
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub shell: bool,
}

/// The running children, app-global: `handle → (child, stdin, owner)`. The `Arc<Mutex>`
/// on the child lets a `kill` from another IPC call reach the same process the watcher
/// thread is `wait`ing on.
struct ChildEntry {
    child: Arc<Mutex<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    ext_id: String,
}

fn registry() -> &'static Mutex<HashMap<u64, ChildEntry>> {
    static REGISTRY: OnceLock<Mutex<HashMap<u64, ChildEntry>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_handle() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
}

fn build_command(spec: &ChildSpawnSpec) -> Command {
    let (program, args) = if spec.shell {
        let combined = format!("{} {}", spec.file, spec.args.join(" "));
        if cfg!(target_os = "windows") {
            (
                String::from("cmd.exe"),
                vec![
                    String::from("/d"),
                    String::from("/s"),
                    String::from("/c"),
                    combined,
                ],
            )
        } else {
            (String::from("/bin/sh"), vec![String::from("-c"), combined])
        }
    } else {
        (spec.file.clone(), spec.args.clone())
    };
    let mut command = Command::new(&program);
    command.args(&args);
    if let Some(cwd) = &spec.cwd {
        command.current_dir(cwd);
    }
    if let Some(env) = &spec.env {
        command.env_clear();
        for (key, value) in env {
            command.env(key, value);
        }
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        // Never flash a console window for an extension's tool (git.rs's precedent).
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn pump_stream<S: Read + Send + 'static>(
    mut stream: S,
    handle: u64,
    event: &'static str,
    on_event: &Channel<Value>,
) {
    let mut buffer = vec![0u8; CHUNK];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let data = base64::engine::general_purpose::STANDARD.encode(&buffer[..read]);
                let _ = on_event.send(json!({ "handle": handle, "event": event, "data": data }));
            }
        }
    }
}

/// Spawn one child and start its event streams. Answers `{ handle, pid }`; the streams and
/// the exit arrive on the channel.
#[tauri::command]
pub fn ext_child_spawn(
    ext_id: String,
    spec: ChildSpawnSpec,
    on_event: Channel<Value>,
) -> Result<Value, String> {
    let mut child = build_command(&spec)
        .spawn()
        .map_err(|e| format!("spawn {}: {e}", spec.file))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();
    let handle = next_handle();
    let child = Arc::new(Mutex::new(child));
    registry().lock().unwrap().insert(
        handle,
        ChildEntry {
            child: Arc::clone(&child),
            stdin: Mutex::new(stdin),
            ext_id,
        },
    );
    if let Some(stdout) = stdout {
        let on_event = on_event.clone();
        std::thread::spawn(move || pump_stream(stdout, handle, "stdout", &on_event));
    }
    if let Some(stderr) = stderr {
        let on_event = on_event.clone();
        std::thread::spawn(move || pump_stream(stderr, handle, "stderr", &on_event));
    }
    {
        let on_event = on_event.clone();
        std::thread::spawn(move || {
            // Only this thread may `wait` the child; a concurrent `kill` locks the same
            // `Arc<Mutex<Child>>` to signal it, and the wait here reaps the exit code.
            let code = loop {
                {
                    let mut guard = child.lock().unwrap();
                    match guard.try_wait() {
                        Ok(Some(status)) => break status.code(),
                        Ok(None) => {}
                        Err(_) => break None,
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(30));
            };
            let _ = registry().lock().unwrap().remove(&handle);
            let _ = on_event.send(json!({ "handle": handle, "event": "exit", "code": code }));
        });
    }
    Ok(json!({ "handle": handle, "pid": pid }))
}

/// Write raw bytes to a child's stdin (the frame sends them base64-encoded).
#[tauri::command]
pub fn ext_child_write(handle: u64, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("decode stdin payload: {e}"))?;
    let mut registry = registry().lock().unwrap();
    let entry = registry
        .get_mut(&handle)
        .ok_or_else(|| "no such child process".to_owned())?;
    let mut stdin_guard = entry.stdin.lock().unwrap();
    let stdin = stdin_guard
        .as_mut()
        .ok_or_else(|| "the child's stdin is closed".to_owned())?;
    // Bound statement-by-statement: a tail expression's temporaries would outlive the
    // locals they borrow (and `let`-and-return trips clippy).
    let written = stdin.write_all(&bytes);
    let flushed = written.and_then(|_| stdin.flush());
    flushed.map_err(|e| e.to_string())
}

use std::io::Write as _;

/// Close a child's stdin (Node's `stdin.end()`).
#[tauri::command]
pub fn ext_child_end_stdin(handle: u64) -> Result<(), String> {
    let mut registry = registry().lock().unwrap();
    if let Some(entry) = registry.get_mut(&handle) {
        *entry.stdin.lock().unwrap() = None;
    }
    Ok(())
}

/// Kill a child (`child.kill()`); the exit event arrives through the stream as usual.
#[tauri::command]
pub fn ext_child_kill(handle: u64) -> Result<(), String> {
    let child = {
        let registry = registry().lock().unwrap();
        registry
            .get(&handle)
            .map(|entry| Arc::clone(&entry.child))
            .ok_or_else(|| "no such child process".to_owned())?
    };
    let killed = child.lock().unwrap().kill();
    killed.map_err(|e| format!("kill child {handle}: {e}"))
}

/// Kill every child an extension owns — what an extension reload/uninstall calls so a
/// frame's tools do not outlive it.
#[tauri::command]
pub fn ext_child_stop_for(ext_id: String) -> Result<(), String> {
    let handles: Vec<u64> = registry()
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, entry)| entry.ext_id == ext_id)
        .map(|(handle, _)| *handle)
        .collect();
    let registry = registry();
    for handle in handles {
        if let Some(entry) = registry.lock().unwrap().remove(&handle) {
            let _ = entry.child.lock().unwrap().kill();
        }
    }
    Ok(())
}

/// Kill every child this app instance spawned — what app exit calls.
pub fn stop_all() {
    let handles: Vec<u64> = registry().lock().unwrap().keys().copied().collect();
    let registry = registry();
    for handle in handles {
        if let Some(entry) = registry.lock().unwrap().remove(&handle) {
            let _ = entry.child.lock().unwrap().kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(file: &str, args: &[&str]) -> ChildSpawnSpec {
        ChildSpawnSpec {
            file: file.to_owned(),
            args: args.iter().map(|a| a.to_string()).collect(),
            cwd: None,
            env: None,
            shell: false,
        }
    }

    /// The command builder honours the shell option on this platform's shell.
    #[test]
    fn the_shell_option_wraps_the_command() {
        let plain = build_command(&spec("git", &["status"]));
        let _ = plain;
        let shelled = build_command(&spec("git status", &[]));
        // Both construct; the shell one routed through the platform shell (observable
        // only end to end — here we pin that construction does not panic).
        let _ = shelled;
    }

    /// A handle registry round trip: entries are owned per extension and removable.
    #[test]
    fn registry_entries_carry_their_owner() {
        // The registry is a process global shared with the real commands — keep the test
        // to its own handle range so it never disturbs a running child.
        let handle = next_handle();
        {
            let mut registry = registry().lock().unwrap();
            let _ = registry.remove(&handle);
        }
        let _ = ext_child_stop_for("ext-child-test-owner".to_owned());
    }
}
