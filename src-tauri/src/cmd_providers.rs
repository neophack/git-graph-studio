//! The AI provider bridge's app half (module 12): the eleven `#[tauri::command]`s and
//! the "restart the bridged backend" wiring. The engine — the sealed provider store
//! under `~/.ggs/ai-providers.json`, the presets, the per-window choice, the spawn
//! environment, the gateway probes, the cc-switch import, the usage curve and the
//! Claude MCP integration writes — lives in the `ggs-providers` crate; the
//! composition root (`lib.rs`'s `run`) is the only place the store and the spawn path
//! meet ([`backend_env`] registers onto the spawn-env sources).
//!
//! Switching provider (or editing the active profile) restarts the running bridged
//! backend: the extension process applied its environment at its own start and would
//! keep answering with the provider it booted under. The settled start attempt —
//! success or failure — is announced as [`BACKEND_RESTARTED_EVENT`], on which the
//! extension host re-resolves the extension's settled webview views.

use std::path::Path;

use ggs_providers::{
    apply_save, effective_choice, fetch_gateway_models, ggs_home,
    import_ccswitch_entries, list_answer, probe_key, provider_change, read_store,
    remove_profile, scan_ccswitch_candidates, set_active, set_instance_choice,
    test_gateway_connection, usage_answer, write_store, ClaudeMcpStatus, CcSwitchCandidate,
    ConnectionReport, ProviderInput, ProviderList, ProviderUsageHour, BRIDGED_EXT_IDS,
    PROVIDERS_EVENT, STORE_LOCK,
};

/// The withdrawal pass over Claude's redirected settings, logged where a developer
/// looks: the crate answers the result, the app owns the log sinks.
fn withdraw_claude_provider_env() {
    if let Err(error) = ggs_providers::withdraw_claude_provider_env() {
        eprintln!("[providers] claude provider env withdrawal: {error}");
        ggs_ext::log_extensions(&format!("claude provider env withdrawal: {error}"));
    }
}

/// The spawn-time environment source the composition root registers onto
/// `ggs_ext::process`'s sources (`lib.rs`'s `run`): the bridged backend's provider
/// environment. An explicit `CLAUDE_CONFIG_DIR` in the app's own environment wins (the
/// sandbox probe's hermetic config dir rides on it).
pub fn backend_env(ext_id: &str) -> Vec<(String, String)> {
    let Ok(home) = ggs_home() else {
        return Vec::new();
    };
    let instance = read_store(&home)
        .ok()
        .and_then(|store| effective_choice(&store));
    let mut env = ggs_providers::backend_env_for(ext_id, &home, instance.as_deref());
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        let dir = Path::new(&dir).to_string_lossy().into_owned();
        for (key, value) in env.iter_mut() {
            if key == "CLAUDE_CONFIG_DIR" {
                *value = dir.clone();
            }
        }
    }
    env
}

#[tauri::command]
pub fn providers_shell_refresh(app: tauri::AppHandle) -> Result<(), String> {
    withdraw_claude_provider_env();
    restart_bridged_backends(&app);
    Ok(())
}

/// The Tauri event pushed when a provider switch restarted a bridged backend (payload:
/// the extension id). The extension host hears it and re-resolves that extension's
/// settled webview views — their pages were set by the old process and would otherwise
/// keep showing what it rendered (the login page of the provider it booted under). The
/// event fires on a failed restart too: the old process is dead either way, and the
/// re-resolve it triggers is the frontend's self-healing path — the resolve crosses as a
/// backend request, which lazy-starts the fresh process on the new spawn environment.
pub const BACKEND_RESTARTED_EVENT: &str = "ext-backend-restarted";

/// The bridged backends a restart pass touches: the ones actually running. A backend
/// that is not (not installed, or stopped — `pid` 0 is the remembered history of a dead
/// one) needs nothing; its next start spawns with the window's current provider
/// environment on its own. Pure over the host's status answer, so the selection policy
/// is testable.
fn bridged_running(status: &[ggs_ext::process::ProcessInfo]) -> Vec<String> {
    status
        .iter()
        .filter(|info| info.pid != 0 && BRIDGED_EXT_IDS.contains(&info.extension_id.as_str()))
        .map(|info| info.extension_id.clone())
        .collect()
}

/// Restart the bridged backends after this window's provider environment changed — the
/// second half of a switch. The running extension process applied its environment at
/// its own start, so it keeps answering with the provider it booted under (the chat's
/// login state included); the fresh process spawns with the window's current choice
/// and comes up on the new provider. The start runs on its own
/// thread (the activation handshake takes its time; the command's answer must not wait
/// it out) and its completion is announced as [`BACKEND_RESTARTED_EVENT`] — on failure
/// too: the old process is dead either way, and the re-resolve the event triggers
/// lazy-starts the fresh one (the frontend's only recovery from a dead backend whose
/// views are still marked resolved).
fn restart_bridged_backends(app: &tauri::AppHandle) {
    let host = crate::ext_process::host();
    crate::ext_process::attach_app(app);
    for ext_id in bridged_running(&host.status()) {
        // The frame host's children the extension spawned go with it — the same cleanup
        // the Extensions view's restart runs.
        let _ = crate::ext_child::ext_child_stop_for(ext_id.clone());
        if host.stop(&ext_id).is_err() {
            continue;
        }
        let Ok(dir) = crate::cmd_ext::extensions_dir(app) else {
            continue;
        };
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(error) = host.start(&dir, &ext_id) {
                ggs_ext::log_extensions(&format!(
                    "provider switch: {ext_id} backend did not come back: {error}"
                ));
            }
            let _ = tauri::Emitter::emit(&app, BACKEND_RESTARTED_EVENT, ext_id.clone());
        });
    }
}

/// The composition-root call (every folder open, close, switch): the MCP registration
/// and the provider-keys withdrawal over the redirected Claude state, each a no-op
/// when the files already agree. The bridge must never keep a folder open or close
/// from succeeding; the extension store's log is where a missing registration is
/// diagnosable.
pub fn apply_claude_integration(folders: &[String]) {
    let result = ggs_providers::apply_claude_integration(folders, std::env::current_exe().ok().as_deref());
    if let Err(error) = result {
        eprintln!("[providers] claude integration: {error}");
        ggs_ext::log_extensions(&format!("claude integration: {error}"));
    }
}

#[tauri::command]
pub fn provider_list() -> Result<ProviderList, String> {
    let _guard = STORE_LOCK.lock().unwrap();
    let home = ggs_home()?;
    let store = read_store(&home)?;
    let active = effective_choice(&store);
    Ok(list_answer(&store, active.as_deref()))
}

/// Create or update one profile. `apiKey` absent keeps the stored key, empty clears it,
/// a value seals it. Saving the profile THIS window runs under restarts the running
/// bridged backend when the change reaches its environment (endpoint, model or key) —
/// the fresh process spawns with the new provider environment. A window running
/// another provider is not restarted: the change never reaches its environment.
#[tauri::command]
pub fn provider_save(app: tauri::AppHandle, profile: ProviderInput) -> Result<ProviderList, String> {
    let _guard = STORE_LOCK.lock().unwrap();
    let home = ggs_home()?;
    let mut store = read_store(&home)?;
    let before = store.clone();
    let choice_before = effective_choice(&store);
    apply_save(&home, &mut store, &profile)?;
    write_store(&home, &store)?;
    drop(_guard);
    let choice = effective_choice(&store);
    let answer = list_answer(&store, choice.as_deref());
    let change = provider_change(
        &before,
        &store,
        &home,
        choice_before.as_deref(),
        choice.as_deref(),
    );
    if change.env_changed {
        withdraw_claude_provider_env();
        restart_bridged_backends(&app);
    }
    if change.store_changed {
        let _ = tauri::Emitter::emit(&app, PROVIDERS_EVENT, ());
    }
    Ok(answer)
}

/// Remove one profile. Removing the active one falls back to the official service.
#[tauri::command]
pub fn provider_delete(app: tauri::AppHandle, id: String) -> Result<ProviderList, String> {
    let _guard = STORE_LOCK.lock().unwrap();
    let home = ggs_home()?;
    let mut store = read_store(&home)?;
    let before = store.clone();
    let choice_before = effective_choice(&store);
    remove_profile(&mut store, &id)?;
    write_store(&home, &store)?;
    drop(_guard);
    // A window whose own choice was deleted falls back to the store's default
    // (official) — the environment it runs under changed, so it restarts.
    let choice = effective_choice(&store);
    let answer = list_answer(&store, choice.as_deref());
    let change = provider_change(
        &before,
        &store,
        &home,
        choice_before.as_deref(),
        choice.as_deref(),
    );
    if change.env_changed {
        withdraw_claude_provider_env();
        restart_bridged_backends(&app);
    }
    if change.store_changed {
        let _ = tauri::Emitter::emit(&app, PROVIDERS_EVENT, ());
    }
    Ok(answer)
}

/// Make one profile the provider THIS window's bridged backend runs under (2026-10-13,
/// the owner's direction: the choice is per window). One pick writes two things — the
/// window's own choice (process memory, so another window's later switch never drags
/// it) and the store's `active_id` on disk (the default a NEW window boots with). The
/// switch restarts this window's running bridged backend on top: the fresh process
/// spawns with the new provider's environment, so the sidebar's chat follows the
/// switch at once (the running process would keep the provider — and the login page —
/// it booted under). The official profile is always present, so switching back is one
/// click. Other windows are never touched: their backends are not this process's to
/// restart, and their own choices stand.
#[tauri::command]
pub fn provider_activate(app: tauri::AppHandle, id: String) -> Result<ProviderList, String> {
    let _guard = STORE_LOCK.lock().unwrap();
    let home = ggs_home()?;
    let mut store = read_store(&home)?;
    let before = store.clone();
    let choice_before = effective_choice(&store);
    set_active(&mut store, &id)?;
    set_instance_choice(&id);
    write_store(&home, &store)?;
    drop(_guard);
    let answer = list_answer(&store, Some(&id));
    let change = provider_change(&before, &store, &home, choice_before.as_deref(), Some(&id));
    if change.env_changed {
        withdraw_claude_provider_env();
        restart_bridged_backends(&app);
    }
    if change.store_changed {
        let _ = tauri::Emitter::emit(&app, PROVIDERS_EVENT, ());
    }
    Ok(answer)
}

/// A gateway's model catalogue for the form's suggestions (NewAPI / OneAPI and every
/// OpenAI-compatible origin). An empty `apiKey` falls back to the named profile's
/// stored key.
#[tauri::command]
pub fn provider_fetch_models(
    base_url: String,
    api_key: String,
    profile_id: Option<String>,
) -> Result<Vec<String>, String> {
    let home = ggs_home()?;
    let store = read_store(&home)?;
    let key = probe_key(&home, &store, &api_key, profile_id.as_deref());
    fetch_gateway_models(&base_url, &key)
}

/// The one-shot connectivity probe the form's Test Connection renders. An empty
/// `apiKey` falls back to the named profile's stored key.
#[tauri::command]
pub fn provider_test_connection(
    base_url: String,
    api_key: String,
    model: String,
    profile_id: Option<String>,
) -> Result<ConnectionReport, String> {
    let home = ggs_home()?;
    let store = read_store(&home)?;
    let key = probe_key(&home, &store, &api_key, profile_id.as_deref());
    test_gateway_connection(&base_url, &key, &model)
}

/// What a cc-switch (or live Claude) configuration on this machine would contribute —
/// the import preview, keys stripped. Missing files answer an empty list, never an
/// error: the app may run where neither cc-switch nor Claude Code exists.
#[tauri::command]
pub fn provider_ccswitch_scan() -> Result<Vec<CcSwitchCandidate>, String> {
    let home = ggs_home()?;
    Ok(scan_ccswitch_candidates(&home))
}

/// Import the named candidates, sealing their keys into the store. A candidate marked
/// current (what cc-switch points at) is activated — the one deliberate opinion of the
/// import, so the bridge takes over the configuration the machine already runs on:
/// this window's choice and the new-window default move together.
#[tauri::command]
pub fn provider_import_ccswitch(
    app: tauri::AppHandle,
    names: Vec<String>,
) -> Result<ProviderList, String> {
    let _guard = STORE_LOCK.lock().unwrap();
    let home = ggs_home()?;
    let mut store = read_store(&home)?;
    let before = store.clone();
    let choice_before = effective_choice(&store);
    let (imported, activate) = import_ccswitch_entries(&home, &mut store, &names)?;
    if imported == 0 {
        return Err("none of the named configurations was found to import".to_owned());
    }
    if let Some(id) = activate {
        set_active(&mut store, &id)?;
        set_instance_choice(&id);
    }
    write_store(&home, &store)?;
    drop(_guard);
    let choice = effective_choice(&store);
    let answer = list_answer(&store, choice.as_deref());
    let change = provider_change(
        &before,
        &store,
        &home,
        choice_before.as_deref(),
        choice.as_deref(),
    );
    if change.env_changed {
        withdraw_claude_provider_env();
        restart_bridged_backends(&app);
    }
    if change.store_changed {
        let _ = tauri::Emitter::emit(&app, PROVIDERS_EVENT, ());
    }
    Ok(answer)
}

#[tauri::command]
pub fn provider_usage() -> Result<Vec<ProviderUsageHour>, String> {
    let home = ggs_home()?;
    Ok(usage_answer(&home, std::time::SystemTime::now()))
}

#[tauri::command]
pub fn claude_mcp_status() -> Result<ClaudeMcpStatus, String> {
    let home = ggs_home()?;
    Ok(ggs_providers::claude_mcp_status(&home))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ggs_providers::CLAUDE_CODE_EXT_ID;

    /// A restart pass touches exactly the running bridged backends: a dead one
    /// (`pid` 0 — remembered history, nothing to restart; its next start reads the
    /// rewritten settings) and another extension's backend are never the bridge's to
    /// stop. The stuck-login-page fix rides this selection: only a live claude-code
    /// process carries the provider it must be rid of.
    #[test]
    fn a_restart_pass_touches_only_running_bridged_backends() {
        let info = |id: &str, pid: u32| ggs_ext::process::ProcessInfo {
            extension_id: id.to_owned(),
            pid,
            commands: Vec::new(),
            protocol_version: "ggs-ext/1".to_owned(),
            start_count: 1,
            last_error: None,
        };
        assert_eq!(
            bridged_running(&[info(CLAUDE_CODE_EXT_ID, 42)]),
            vec![CLAUDE_CODE_EXT_ID.to_owned()]
        );
        assert!(bridged_running(&[info(CLAUDE_CODE_EXT_ID, 0)]).is_empty());
        assert!(bridged_running(&[info("acme.other", 7)]).is_empty());
        assert!(bridged_running(&[]).is_empty());
    }
}
