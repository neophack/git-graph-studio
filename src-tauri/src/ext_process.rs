//! The process extension host's app half (module 12): the `#[tauri::command]` adapters
//! and the composition glue. The engine — spawning, the `ggs-ext/1` handshake, the
//! reader threads, crash isolation, the remembered status — lives in
//! `ggs_ext::process` (`ExtHost`); this module owns the app's one instance, installs
//! the engine's `HostHooks` off the `AppHandle` (the event emitter, the packaged node
//! host resources, the Remote Access frontend policy), and answers the nine commands.
//!
//! The app-side singleton (`host()`) is the composition root's choice, not the crate's:
//! several call sites reach the backends with no `AppHandle` to fetch Tauri-managed
//! state through (the folder-open paths, the provider bridge's restarts, the tests),
//! and `manage()` holds a clone of the same instance so the two always agree on what
//! is running.

use serde_json::{json, Value};

use ggs_ext::process::{self, ExtHost, HostHooks, ProcessInfo, HOST_STATE_EVENT};
use ggs_ext::routing as ext_routing;

use crate::cmd_ext;

/// The app's one `ExtHost` — see the module doc. Created once per process (every GGS
/// window spawns its own backends; a second window is a second process).
pub fn host() -> &'static ExtHost {
    static STATE: std::sync::OnceLock<ExtHost> = std::sync::OnceLock::new();
    STATE.get_or_init(ExtHost::default)
}

/// The Remote Access policy for which frontend answers a host request, registered by
/// the composition root (`lib.rs`) before any backend can start. Read when the hooks
/// are installed (the first attach), so the policy may be set before or after the
/// instance exists — only before the first attach matters.
static HOST_REQUEST_FRONTEND: std::sync::OnceLock<fn(&tauri::AppHandle, Option<String>) -> String> =
    std::sync::OnceLock::new();

pub fn set_host_request_frontend(resolve: fn(&tauri::AppHandle, Option<String>) -> String) {
    let _ = HOST_REQUEST_FRONTEND.set(resolve);
}

/// The frontend a call came from: the calling webview, and — for the Relay — the session
/// its `x-ggs-frontend` header names (see `ggs_ext::routing::frontend_of`).
fn caller(webview: &tauri::Webview, request: &tauri::ipc::Request<'_>) -> String {
    let header = request
        .headers()
        .get("x-ggs-frontend")
        .and_then(|value| value.to_str().ok());
    ext_routing::frontend_of(webview.label(), header)
}

/// Install the engine's hooks off `app`, once (idempotent in the engine): the emitter
/// every settle and host request crosses on, the packaged node-host resources, and the
/// frontend policy the composition root registered.
pub fn attach_app(app: &tauri::AppHandle) {
    use tauri::Manager;
    let emitter = app.clone();
    let policy_app = app.clone();
    // The policy is read through the captured handle at every request: the composition
    // root registers it before any backend can start, and unset the claim-or-main
    // shape stands.
    let frontend_of = move |claimed: Option<String>| -> String {
        match HOST_REQUEST_FRONTEND.get() {
            Some(resolve) => resolve(&policy_app, claimed),
            None => claimed.unwrap_or_else(|| "main".into()),
        }
    };
    let node_host_resources = app.path().resource_dir().ok().map(|resource_dir| {
        (
            resource_dir.join("vscode-shim.cjs"),
            resource_dir.join("node-host.cjs"),
        )
    });
    host().attach_hooks(HostHooks {
        emit: Box::new(move |event, payload| {
            use tauri::Emitter;
            emitter.emit(event, payload).is_ok()
        }),
        node_host_resources,
        frontend_of: Some(Box::new(frontend_of)),
    });
}

// ---------------------------------------------------------------------------
// The Tauri commands (thin: resolve the extensions directory, delegate to the engine)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ext_process_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, ExtHost>,
    ext_id: String,
) -> Result<ProcessInfo, String> {
    attach_app(&app);
    let dir = cmd_ext::extensions_dir(&app)?;
    let state = state.inner().clone();
    // The handshake waits for the backend's activation — that wait must stay off the main
    // thread, or every other command and event delivery queues behind it until the
    // handshake's own timeout fires.
    tauri::async_runtime::spawn_blocking(move || state.start(&dir, &ext_id))
        .await
        .map_err(|e| format!("start task: {e}"))?
}

#[tauri::command]
pub async fn ext_process_run(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    state: tauri::State<'_, ExtHost>,
    ext_id: String,
    command: String,
    args: Option<Value>,
) -> Result<Value, String> {
    attach_app(&app);
    let dir = cmd_ext::extensions_dir(&app)?;
    let state = state.inner().clone();
    let args = args.unwrap_or_else(|| json!([]));
    // The caller claims the requests its command makes (a quick pick it opens opens in it).
    let frontend = caller(&webview, &request);
    tauri::async_runtime::spawn_blocking(move || {
        let _call = ext_routing::call_begin(&ext_id, &frontend);
        state.run(&dir, &ext_id, &command, args)
    })
    .await
    .map_err(|e| format!("run task: {e}"))?
}

/// The workbench's answer to a real-Node host's `ggs.hostRequest` (`ext-host-request`
/// event): the result crosses back over the backend's stdin as the protocol response.
#[tauri::command]
pub fn ext_process_host_respond(
    state: tauri::State<'_, ExtHost>,
    ext_id: String,
    id: u64,
    ok: bool,
    result: Value,
) -> Result<(), String> {
    state.host_respond(&ext_id, id, ok, result)
}

/// The workbench's call into a real-Node host beyond `runCommand` (the frame vocabulary:
/// `docProvider.provide`, the tree plumbing, `deactivate`). The params carry the frame
/// call's `args` array; the host normalizes.
#[tauri::command]
pub async fn ext_process_invoke(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    state: tauri::State<'_, ExtHost>,
    ext_id: String,
    method: String,
    args: Option<Value>,
) -> Result<Value, String> {
    attach_app(&app);
    let dir = cmd_ext::extensions_dir(&app)?;
    let state = state.inner().clone();
    let args = args.unwrap_or_else(|| json!([]));
    // The caller claims the requests the call makes (webviews excepted: see routing).
    let frontend = caller(&webview, &request);
    tauri::async_runtime::spawn_blocking(move || {
        let _call = ext_routing::call_begin(&ext_id, &frontend);
        state.call(&dir, &ext_id, &method, json!({ "args": args }))
    })
    .await
    .map_err(|e| format!("invoke task: {e}"))?
}

/// The registrations `ext_id`'s running backend made (the routing journal, as
/// `{method, args}` in order): a frontend that attaches after the activation — a remote
/// page — replays them to show the commands, context keys and views the activation set.
#[tauri::command]
pub fn ext_process_registrations(ext_id: String) -> Vec<Value> {
    ext_routing::journal(&ext_id)
}

/// A remote frontend mounted (or unmounted) its own live page of a webview stream — its
/// own instance of a per-frontend webview (Git Graph, `ext_routing::per_frontend_webviews`):
/// the backend's webview traffic mirrors to exactly the frontends hosting one, addressed,
/// so each page is fed its own pushes while a copy's watchers carry nothing. The Relay's
/// session header names the frontend; the desktop never registers (it serves the request
/// itself), and a session that ends is swept by `remote_host_frontend_gone`.
#[tauri::command]
pub fn ext_webview_hosted(
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    ext_id: String,
    stream: String,
    hosted: bool,
) -> Result<(), String> {
    let frontend = caller(&webview, &request);
    if !ext_routing::is_session(&frontend) {
        return Ok(()); // only a remote session hosts a page beside the desktop's own
    }
    ext_routing::webview_hosted(&ext_id, &frontend, &stream, hosted);
    Ok(())
}

/// Push one host event into a backend (`ggs.hostEvent`): the same event objects a frame
/// gets as `__studioExtEvent` pushes — theme changes, configuration, webview messages,
/// watcher batches.
#[tauri::command]
pub fn ext_process_push_event(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    request: tauri::ipc::Request<'_>,
    state: tauri::State<'_, ExtHost>,
    ext_id: String,
    event: Value,
) -> Result<(), String> {
    // The desktop window's user closed a panel's tab: the pages showing its copy drop it.
    if let Some(panel_id) = ext_routing::panel_closed(&ext_id, &event) {
        use tauri::Emitter;
        let _ = app.emit(
            HOST_STATE_EVENT,
            json!({
                "extId": ext_id,
                "method": "webview.dispose",
                "args": [panel_id],
                "caller": Value::Null,
                "served": caller(&webview, &request),
            }),
        );
    }
    state.push_event(&ext_id, event)
}

/// The real Node runtime this app would serve `node` backends with, when one exists AND
/// `GGS_REAL_NODE` opts the real-Node host in (`None` otherwise: the bundled pretend
/// runtime serves them all, the default since 2026-09-25). The workbench decides from
/// this whether main-only packages run as real-Node hosts or as sandboxed frames; a
/// manifest-declared `node` backend hosts on ggs-node either way.
#[tauri::command]
pub fn ext_node_runtime() -> Result<Option<String>, String> {
    if !ggs_ext::real_node_allowed() {
        return Ok(None);
    }
    Ok(process::find_node_runtime().and_then(|path| path.into_os_string().into_string().ok()))
}

#[tauri::command]
pub fn ext_process_stop(
    state: tauri::State<'_, ExtHost>,
    ext_id: String,
) -> Result<(), String> {
    state.stop(&ext_id)
}

#[tauri::command]
pub fn ext_process_status(
    state: tauri::State<'_, ExtHost>,
) -> Result<Vec<ProcessInfo>, String> {
    Ok(state.status())
}
