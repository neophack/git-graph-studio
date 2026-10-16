//! §18.1's test-only observation surface (docs/remote-client-plan.md, L2): one command
//! the lifecycle probe reads the invariants' ground truth through — the extension
//! backends' PIDs and start counts (I1), every installed package's registration journal
//! (the live webview panels and views among it, I3/I4), the frontends the router has
//! served, and the main window's creation and page-load counters (I9: a hidden window
//! must never be rebuilt or reloaded). The window counters live here because windows and
//! page loads belong to the app process, not to any command domain.
//!
//! The command refuses unless `GGS_TEST_HOOKS=1`, so a production build never answers it
//! — the registration itself stays on the compile-time `generate_handler!` list (the
//! macro is static), which `scripts/check-ipc.mjs` therefore lists as test-only.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};

static MAIN_WINDOW_CREATES: AtomicU32 = AtomicU32::new(0);
static MAIN_PAGE_LOADS: AtomicU32 = AtomicU32::new(0);

/// Whether this run exposes the test-only commands (§18.1: `GGS_TEST_HOOKS=1`).
pub fn test_hooks() -> bool {
    std::env::var("GGS_TEST_HOOKS").as_deref() == Ok("1")
}

/// The main window's document finished loading once more (lib.rs's page-load hook).
pub fn note_main_page_load() {
    MAIN_PAGE_LOADS.fetch_add(1, Ordering::Relaxed);
}

/// The main window was built — at boot or by `ensure_main_window` (§17's invariant is
/// that the second never happens while the instance lives; the counter is the proof).
pub fn note_main_window_created() {
    MAIN_WINDOW_CREATES.fetch_add(1, Ordering::Relaxed);
}

/// The §18.1 snapshot. See the module doc for what crosses; a refusal (`Err`) when the
/// test hooks are off is the production behavior — the probe treats it as fatal.
#[tauri::command]
pub fn remote_debug_snapshot(
    app: tauri::AppHandle,
    state: tauri::State<'_, ggs_ext::process::ExtHost>,
) -> Result<Value, String> {
    if !test_hooks() {
        return Err("remote_debug_snapshot: GGS_TEST_HOOKS is not 1".into());
    }
    let backends: Vec<Value> = state
        .status()
        .into_iter()
        .map(|info| {
            json!({
                "extId": info.extension_id,
                "pid": info.pid,
                "startCount": info.start_count,
                "commands": info.commands,
                "lastError": info.last_error,
            })
        })
        .collect();
    let dir = crate::cmd_ext::extensions_dir(&app)?;
    let mut registrations = serde_json::Map::new();
    for info in ggs_ext::store::list_installed(&dir)? {
        registrations.insert(
            info.id.clone(),
            Value::Array(ggs_ext::routing::journal(&info.id)),
        );
    }
    Ok(json!({
        "backends": backends,
        "registrations": registrations,
        "frontends": ggs_ext::routing::frontends(),
        "main": {
            "created": MAIN_WINDOW_CREATES.load(Ordering::Relaxed),
            "pageLoads": MAIN_PAGE_LOADS.load(Ordering::Relaxed),
            "visible": crate::remote_host::main_visible(&app),
            "minimized": crate::remote_host::main_minimized(&app),
        },
        "sessions": crate::remote_host::session_count(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_counters_count() {
        // Other tests in this binary touch the same globals: read deltas, not absolutes.
        let creates = MAIN_WINDOW_CREATES.load(Ordering::Relaxed);
        let loads = MAIN_PAGE_LOADS.load(Ordering::Relaxed);
        note_main_window_created();
        note_main_page_load();
        note_main_page_load();
        assert_eq!(MAIN_WINDOW_CREATES.load(Ordering::Relaxed), creates + 1);
        assert_eq!(MAIN_PAGE_LOADS.load(Ordering::Relaxed), loads + 2);
    }

    #[test]
    fn frontends_list_the_desktop_and_every_served_session() {
        // The router's own state: a remote session's call names it, and the list is
        // sticky for the process's lifetime; the desktop window always leads it.
        let _guard = ggs_ext::routing::call_begin("ext fronts", "remote/7");
        let frontends = ggs_ext::routing::frontends();
        assert_eq!(frontends.first().map(String::as_str), Some("main"));
        assert!(frontends.contains(&"remote/7".to_owned()));
    }
}
