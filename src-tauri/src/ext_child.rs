//! The frame host's child processes — the command adapters (module 12). The engine
//! (the registry, the spawn, the stream pumps) lives in `ggs_ext::child`; this half
//! wraps the app's IPC channel into the engine's event sink and keeps the six
//! `#[tauri::command]`s the frame's `nodeShims.ts` speaks to.

use serde_json::Value;
use tauri::ipc::Channel;

use ggs_ext::child::{self, ChildSpawnSpec};

/// Spawn one child and start its event streams. Answers `{ handle, pid }`; the streams
/// and the exit arrive on the channel.
#[tauri::command]
pub fn ext_child_spawn(
    ext_id: String,
    spec: ChildSpawnSpec,
    on_event: Channel<Value>,
) -> Result<Value, String> {
    child::spawn_child(&spec, &ext_id, Box::new(move |event| {
        let _ = on_event.send(event);
    }))
}

/// Write raw bytes to a child's stdin (the frame sends them base64-encoded).
#[tauri::command]
pub fn ext_child_write(handle: u64, data: String) -> Result<(), String> {
    child::child_write(handle, &data)
}

/// Close a child's stdin (Node's `stdin.end()`).
#[tauri::command]
pub fn ext_child_end_stdin(handle: u64) -> Result<(), String> {
    child::child_end_stdin(handle)
}

/// Kill a child (`child.kill()`); the exit event arrives through the stream as usual.
#[tauri::command]
pub fn ext_child_kill(handle: u64) -> Result<(), String> {
    child::child_kill(handle)
}

/// The Node runtime a frame's `child_process.fork` may run a package's own server with
/// (`node <server> --stdio`): the ungated lookup — forking an extension's language server
/// is the package's own runtime story, not the app's backend-host gate, and `None` is the
/// honest answer the frame turns into Node's fork `'error'` event.
#[tauri::command]
pub fn ext_node_runtime_path() -> Result<Option<String>, String> {
    Ok(ggs_ext::process::find_node_runtime().map(|path| path.to_string_lossy().into_owned()))
}

/// Kill every child an extension owns — what an extension reload/uninstall calls so a
/// frame's tools do not outlive it.
#[tauri::command]
pub fn ext_child_stop_for(ext_id: String) -> Result<(), String> {
    child::stop_for(&ext_id)
}
