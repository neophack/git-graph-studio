//! The AI provider bridge (module 12): the model providers a bridged extension's backend
//! runs under — today the claude-code extension, which speaks Anthropic's protocol and
//! therefore runs unchanged against every Anthropic-compatible endpoint (DeepSeek, Zhipu
//! GLM, Moonshot Kimi, any custom gateway). A profile names the endpoint, the model ids
//! and the API key; the app stores everything under `~/.ggs/ai-providers.json` — never
//! inside Claude Code's own `~/.claude` — and seals the key at rest with AES-256-GCM
//! under a per-install master key (`~/.ggs/keys/ai-providers.key`, 0600). The key is
//! decrypted only when the bridged backend is spawned, as environment the backend and
//! its CLI children inherit:
//!
//! - `CLAUDE_CONFIG_DIR` always points at `~/.ggs/claude`, so the extension's own state
//!   (login, session history, `settings.json`) never touches `~/.claude`;
//! - the active third-party profile adds `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` /
//!   `ANTHROPIC_API_KEY` (the decrypted key) and `ANTHROPIC_MODEL` /
//!   `ANTHROPIC_SMALL_FAST_MODEL` — the same takeover the claude-code sandbox probe
//!   proves end to end against a local stand-in server.
//!
//! Switching provider (or editing the active profile) restarts the bridged backend, the
//! same deliberate restart the Extensions view's button performs — a running backend
//! keeps the environment it was spawned with.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::ext_process;

/// The extension whose backend the active provider configures. The marketplace id
/// (`ext_gallery.rs`'s `FEATURED` names it too); the frontend learns it from
/// `provider_list`'s `bridgedExtIds` and names no id itself.
pub const CLAUDE_CODE_EXT_ID: &str = "Anthropic.claude-code";

/// Every extension id whose backend runs under the provider bridge.
pub const BRIDGED_EXT_IDS: &[&str] = &[CLAUDE_CODE_EXT_ID];

/// The Tauri event pushed when the active provider (or a profile's endpoint) changed and
/// the bridged backend was restarted — the frontend's switchers re-read on it, so a
/// switch in one window updates the chip in another.
pub const PROVIDERS_EVENT: &str = "providers-changed";

/// What the key cipher binds into every sealed blob (defence in depth: a sealed key from
/// another store or purpose fails to open even under the same master key).
const KEY_AAD: &[u8] = b"ggs.ai-providers";

/// One store write at a time: the read-modify-write commands all cross this lock.
static STORE_LOCK: Mutex<()> = Mutex::new(());

/* ---------- The store ---------- */

/// A provider profile as it lives on disk. `api_key_enc` is the AES-256-GCM sealed key
/// (`base64(nonce ‖ ciphertext ‖ tag)`) — the plaintext exists only in the spawn-time
/// environment, never in the file and never over IPC.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    pub id: String,
    /// The built-in shape the profile was created from (`official`, `deepseek`, …): what
    /// the UI pre-fills and what marks a profile "the official service, no endpoint".
    pub preset: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub small_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key_enc: Option<String>,
    /// The last four characters of the key, so the UI can show `••••abcd` without
    /// unsealing anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key_hint: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStore {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_id: Option<String>,
    #[serde(default)]
    pub profiles: Vec<ProviderProfile>,
}

/// What `provider_save` takes from the frontend. `api_key` is the one secret-bearing
/// field: `None` keeps the stored key, `Some("")` clears it, `Some(key)` seals it.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    pub id: String,
    pub preset: String,
    pub label: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub small_model: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
}

/// One built-in shape the Add flow offers. The label is the English fallback; the UI
/// labels the built-ins through its own i18n tables by preset id.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreset {
    pub id: String,
    pub label: String,
    pub official: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<&'static str>,
    /// Suggested model ids; the field stays free text (the lists move faster than apps).
    #[serde(default)]
    pub models: Vec<&'static str>,
}

/// The Anthropic-compatible endpoints the bridge knows out of the box.
pub fn presets() -> Vec<ProviderPreset> {
    vec![
        ProviderPreset {
            id: "official".to_owned(),
            label: "Official Claude".to_owned(),
            official: true,
            base_url: None,
            models: vec![],
        },
        ProviderPreset {
            id: "deepseek".to_owned(),
            label: "DeepSeek".to_owned(),
            official: false,
            base_url: Some("https://api.deepseek.com/anthropic"),
            models: vec!["deepseek-chat", "deepseek-reasoner"],
        },
        ProviderPreset {
            id: "glm".to_owned(),
            label: "Zhipu GLM".to_owned(),
            official: false,
            base_url: Some("https://open.bigmodel.cn/api/anthropic"),
            models: vec!["glm-4.6", "glm-4.5", "glm-4.5-air"],
        },
        ProviderPreset {
            id: "kimi".to_owned(),
            label: "Moonshot Kimi".to_owned(),
            official: false,
            base_url: Some("https://api.moonshot.cn/anthropic"),
            models: vec!["kimi-k2", "kimi-k2-turbo"],
        },
        ProviderPreset {
            id: "custom".to_owned(),
            label: "Custom (Anthropic-compatible)".to_owned(),
            official: false,
            base_url: None,
            models: vec![],
        },
    ]
}

/// The store a fresh install starts from: the official service active, the built-in
/// third-party shapes already listed (a switch is then one paste of a key away). Seeded
/// in memory — the file first appears when something is saved.
fn seeded_store() -> ProviderStore {
    let mut store = ProviderStore { version: 1, active_id: Some("official".to_owned()), profiles: Vec::new() };
    for preset in presets() {
        if preset.id == "custom" {
            continue;
        }
        store.profiles.push(ProviderProfile {
            id: preset.id.clone(),
            preset: preset.id.clone(),
            label: preset.label.clone(),
            base_url: preset.base_url.map(str::to_owned),
            model: preset.models.first().map(|m| m.to_string()),
            small_model: preset.models.get(1).map(|m| m.to_string()),
            api_key_enc: None,
            api_key_hint: None,
        });
    }
    store
}

/* ---------- The home: ~/.ggs ---------- */

/// Tests pin the store to an isolated directory (`ProviderHome::pin`), the same
/// isolation `cmd_ext`'s extension store has: no test reads or writes the developer's
/// real `~/.ggs`.
#[cfg(test)]
static TEST_HOME: Mutex<Option<PathBuf>> = Mutex::new(None);

/// The `~/.ggs` root every provider file lives under (`ai-providers.json`, `keys/`,
/// and the `claude/` config dir the bridge points the backend at).
fn ggs_home() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(dir) = TEST_HOME.lock().unwrap().clone() {
        return Ok(dir);
    }
    let extensions = crate::cmd_ext::extensions_home_dir()?;
    extensions
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "no ~/.ggs home directory".to_owned())
}

fn store_path(home: &Path) -> PathBuf {
    home.join("ai-providers.json")
}

fn read_store(home: &Path) -> Result<ProviderStore, String> {
    match std::fs::read_to_string(store_path(home)) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("invalid ai-providers.json: {e}")),
        Err(_) => Ok(seeded_store()),
    }
}

fn write_store(home: &Path, store: &ProviderStore) -> Result<(), String> {
    let path = store_path(home);
    let text = serde_json::to_string_pretty(store).map_err(|e| format!("serialize providers: {e}"))?;
    std::fs::write(&path, text + "\n").map_err(|e| format!("write {}: {e}", path.display()))
}

/* ---------- The key sealing ---------- */

/// The per-install master key, created on first use: 32 random bytes at
/// `~/.ggs/keys/ai-providers.key`, readable by the user alone (0600 on unix).
fn master_key(home: &Path) -> Result<[u8; 32], String> {
    let path = home.join("keys").join("ai-providers.key");
    if let Ok(bytes) = std::fs::read(&path) {
        let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice()) else {
            return Err(format!("{} is not a 32-byte master key", path.display()));
        };
        return Ok(key);
    }
    std::fs::create_dir_all(path.parent().expect("keys/ has a parent"))
        .map_err(|e| format!("create the keys directory: {e}"))?;
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).map_err(|e| format!("generate a master key: {e}"))?;
    std::fs::write(&path, key).map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("restrict {}: {e}", path.display()))?;
    }
    Ok(key)
}

/// Encrypt a secret: a fresh 12-byte nonce per seal, AES-256-GCM over key material with
/// the bridge's name as additional authenticated data, `base64(nonce ‖ ciphertext ‖ tag)`
/// as the stored form.
fn seal(home: &Path, secret: &str) -> Result<String, String> {
    let key = master_key(home)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let mut nonce = [0u8; 12];
    getrandom::getrandom(&mut nonce).map_err(|e| format!("generate a nonce: {e}"))?;
    let sealed = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload { msg: secret.as_bytes(), aad: KEY_AAD },
        )
        .map_err(|_| "seal the API key".to_owned())?;
    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&sealed);
    Ok(BASE64.encode(blob))
}

/// The `seal` inverse: any tampering, any other master key, any other purpose fails.
fn unseal(home: &Path, sealed: &str) -> Result<String, String> {
    let key = master_key(home)?;
    let blob = BASE64.decode(sealed).map_err(|e| format!("a sealed key is not valid base64: {e}"))?;
    if blob.len() < 12 + 16 {
        return Err("a sealed key is too short to open".to_owned());
    }
    let (nonce, body) = blob.split_at(12);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let plain = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload { msg: body, aad: KEY_AAD },
        )
        .map_err(|_| "the stored API key does not open under this install's master key".to_owned())?;
    String::from_utf8(plain).map_err(|_| "the stored API key is not valid UTF-8".to_owned())
}

/* ---------- The profile edits (pure, the commands' core) ---------- */

fn clean_option(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// Validate and normalize one save. The official profile is endpoint-less by
/// construction; every other profile needs an http(s) base URL.
fn normalize_profile(input: &ProviderInput, presets: &[ProviderPreset]) -> Result<ProviderProfile, String> {
    let id = input.id.trim().to_owned();
    if id.is_empty() || id.contains(['/', '\\', ':']) || id.contains("..") {
        return Err(format!("invalid provider id {id:?}"));
    }
    let preset = presets
        .iter()
        .find(|preset| preset.id == input.preset)
        .ok_or_else(|| format!("unknown preset {:?}", input.preset))?;
    let label = clean_option(&Some(input.label.clone()))
        .unwrap_or_else(|| preset.label.clone());
    if preset.official {
        return Ok(ProviderProfile {
            id,
            preset: preset.id.clone(),
            label,
            base_url: None,
            model: None,
            small_model: None,
            api_key_enc: None,
            api_key_hint: None,
        });
    }
    let base_url = clean_option(&input.base_url).ok_or_else(|| {
        format!("{label} needs the provider's base URL (its Anthropic-compatible endpoint)")
    })?;
    if !base_url.starts_with("https://") && !base_url.starts_with("http://") {
        return Err(format!("the base URL must start with https:// (or http:// for a local server): {base_url}"));
    }
    let base_url = base_url.trim_end_matches('/').to_owned();
    Ok(ProviderProfile {
        id,
        preset: preset.id.clone(),
        label,
        base_url: Some(base_url),
        model: clean_option(&input.model),
        small_model: clean_option(&input.small_model),
        api_key_enc: None,
        api_key_hint: None,
    })
}

/// Apply one save onto the store: normalize the fields, then the key — absent keeps the
/// stored one (and its hint), empty clears it, anything else seals the new value. The
/// key never rides through the normalized profile.
fn apply_save(
    home: &Path,
    store: &mut ProviderStore,
    input: &ProviderInput,
) -> Result<(), String> {
    let mut profile = normalize_profile(input, &presets())?;
    let existing = store.profiles.iter().find(|p| p.id == profile.id);
    if profile.preset == "official" {
        profile.api_key_enc = None;
        profile.api_key_hint = None;
    } else {
        match input.api_key.as_deref() {
            None | Some("") => {
                // Absent keeps the stored key; empty clears it. A custom profile (no
                // stored key yet) may stay keyless — the endpoint may not need one.
                if input.api_key.is_none() {
                    profile.api_key_enc = existing.and_then(|p| p.api_key_enc.clone());
                    profile.api_key_hint = existing.and_then(|p| p.api_key_hint.clone());
                }
            }
            Some(key) => {
                let trimmed = key.trim();
                if !trimmed.is_empty() {
                    profile.api_key_enc = Some(seal(home, trimmed)?);
                    profile.api_key_hint = Some(trimmed.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect());
                }
            }
        }
    }
    match store.profiles.iter_mut().find(|p| p.id == profile.id) {
        Some(slot) => *slot = profile,
        None => store.profiles.push(profile),
    }
    Ok(())
}

/* ---------- The spawn-time environment ---------- */

/// The environment a bridged extension's backend is spawned with. Pure over the store
/// and the home, so the exact bytes a backend sees are testable. The decrypted key
/// exists only inside this vector's lifetime — the command's answer never carries it.
pub fn backend_env_for(ext_id: &str, store: &ProviderStore, home: &Path) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = Vec::new();
    if !BRIDGED_EXT_IDS.contains(&ext_id) {
        return env;
    }
    // Always: the extension's own state lives under ~/.ggs/claude, never ~/.claude.
    env.push((
        "CLAUDE_CONFIG_DIR".to_owned(),
        home.join("claude").to_string_lossy().into_owned(),
    ));
    let Some(active) = store
        .active_id
        .as_deref()
        .and_then(|id| store.profiles.iter().find(|p| p.id == id))
    else {
        return env;
    };
    if active.preset == "official" {
        return env;
    }
    if let Some(base_url) = active.base_url.as_deref().filter(|url| !url.is_empty()) {
        env.push(("ANTHROPIC_BASE_URL".to_owned(), base_url.to_owned()));
    }
    if let Some(sealed) = active.api_key_enc.as_deref() {
        // A key that does not open (a copied store from another install) must not take
        // the backend down with it: the endpoint vars still apply, and the extension's
        // own login remains the fallback.
        if let Ok(key) = unseal(home, sealed) {
            env.push(("ANTHROPIC_AUTH_TOKEN".to_owned(), key.clone()));
            env.push(("ANTHROPIC_API_KEY".to_owned(), key));
        }
    }
    if let Some(model) = active.model.as_deref().filter(|m| !m.is_empty()) {
        env.push(("ANTHROPIC_MODEL".to_owned(), model.to_owned()));
    }
    if let Some(model) = active.small_model.as_deref().filter(|m| !m.is_empty()) {
        env.push(("ANTHROPIC_SMALL_FAST_MODEL".to_owned(), model.to_owned()));
    }
    env
}

/// [`backend_env_for`] as `ext_process` calls it at spawn time. A store that cannot be
/// read reads as "the official service": a broken provider file must never keep a
/// backend from starting. An explicit `CLAUDE_CONFIG_DIR` in the app's own environment
/// wins over the bridge's `~/.ggs/claude` — the escape hatch the claude-code sandbox
/// probe's hermetic config dir (and a developer's own setup) rides on.
pub fn backend_env(ext_id: &str) -> Vec<(String, String)> {
    let Ok(home) = ggs_home() else {
        return Vec::new();
    };
    let store = read_store(&home).unwrap_or_default();
    let mut env = backend_env_for(ext_id, &store, &home);
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

/* ---------- The backend restart ---------- */

/// Stop and start again every bridged backend that is running — the Extensions view's
/// deliberate restart, driven by a provider change. The start's handshake waits out a
/// node activation, so it runs off the command's thread.
fn restart_bridged_backends(app: &tauri::AppHandle) {
    let host = ext_process::global();
    host.attach_app(app.clone());
    for ext_id in BRIDGED_EXT_IDS.iter().copied() {
        let running = host
            .status()
            .iter()
            .any(|info| info.extension_id == ext_id && info.pid != 0);
        if !running {
            continue;
        }
        if host.stop(ext_id).is_err() {
            continue;
        }
        let Ok(dir) = crate::cmd_ext::extensions_dir(app) else {
            continue;
        };
        let ext_id = ext_id.to_owned();
        std::thread::spawn(move || {
            if let Err(error) = host.start(&dir, &ext_id) {
                crate::cmd_ext::log_extensions(&format!(
                    "provider switch: {ext_id} backend did not come back: {error}"
                ));
            }
        });
    }
}

/* ---------- The IPC answer ---------- */

/// A profile as the UI sees it: every field but the key (a `hasKey` flag and the last
/// four characters stand in for it — the ciphertext never needs to cross).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub id: String,
    pub preset: String,
    pub label: String,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub small_model: Option<String>,
    pub has_key: bool,
    pub key_hint: Option<String>,
}

impl From<&ProviderProfile> for ProviderView {
    fn from(profile: &ProviderProfile) -> Self {
        ProviderView {
            id: profile.id.clone(),
            preset: profile.preset.clone(),
            label: profile.label.clone(),
            base_url: profile.base_url.clone(),
            model: profile.model.clone(),
            small_model: profile.small_model.clone(),
            has_key: profile.api_key_enc.is_some(),
            key_hint: profile.api_key_hint.clone(),
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderList {
    pub active_id: Option<String>,
    pub profiles: Vec<ProviderView>,
    pub presets: Vec<ProviderPreset>,
    /// The extension ids whose backends run under the active provider: the UI's
    /// switcher affordances key on this, so the frontend names no extension id.
    pub bridged_ext_ids: Vec<String>,
}

fn list_answer(store: &ProviderStore) -> ProviderList {
    ProviderList {
        active_id: store.active_id.clone(),
        profiles: store.profiles.iter().map(ProviderView::from).collect(),
        presets: presets(),
        bridged_ext_ids: BRIDGED_EXT_IDS.iter().map(|id| id.to_string()).collect(),
    }
}

/// The store for the UI: profiles (keys masked), the built-in presets, and the bridged
/// extension ids. A missing file answers the seeded store, not an error.
#[tauri::command]
pub fn provider_list() -> Result<ProviderList, String> {
    let _guard = STORE_LOCK.lock().unwrap();
    let home = ggs_home()?;
    let store = read_store(&home)?;
    Ok(list_answer(&store))
}

/// Create or update one profile. `apiKey` absent keeps the stored key, empty clears it,
/// a value seals it. Saving the *active* profile restarts the bridged backend when the
/// change reaches its environment (endpoint, model or key).
#[tauri::command]
pub fn provider_save(
    app: tauri::AppHandle,
    profile: ProviderInput,
) -> Result<ProviderList, String> {
    let _guard = STORE_LOCK.lock().unwrap();
    let home = ggs_home()?;
    let mut store = read_store(&home)?;
    let before = backend_env_for(CLAUDE_CODE_EXT_ID, &store, &home);
    apply_save(&home, &mut store, &profile)?;
    write_store(&home, &store)?;
    drop(_guard);
    let after = backend_env_for(CLAUDE_CODE_EXT_ID, &store, &home);
    let answer = list_answer(&store);
    if before != after {
        restart_bridged_backends(&app);
        let _ = tauri::Emitter::emit(&app, PROVIDERS_EVENT, ());
    }
    Ok(answer)
}

/// Remove one profile: the command's pure core (unknown ids error). Removing the
/// active one falls back to the official service, so the bridge never runs provider-less.
fn remove_profile(store: &mut ProviderStore, id: &str) -> Result<(), String> {
    let removed = store.profiles.len();
    store.profiles.retain(|profile| profile.id != id);
    if store.profiles.len() == removed {
        return Err(format!("no provider {id:?} to delete"));
    }
    if store.active_id.as_deref() == Some(id) {
        store.active_id = store
            .profiles
            .iter()
            .find(|profile| profile.preset == "official")
            .map(|profile| profile.id.clone());
    }
    Ok(())
}

/// Make one profile the active one: the command's pure core (unknown ids error;
/// re-activating the active one is a no-op that writes nothing).
fn set_active(store: &mut ProviderStore, id: &str) -> Result<(), String> {
    if !store.profiles.iter().any(|profile| profile.id == id) {
        return Err(format!("no provider {id:?} to activate"));
    }
    if store.active_id.as_deref() != Some(id) {
        store.active_id = Some(id.to_owned());
    }
    Ok(())
}

/// Remove one profile. Removing the active one falls back to the official service.
#[tauri::command]
pub fn provider_delete(app: tauri::AppHandle, id: String) -> Result<ProviderList, String> {
    let _guard = STORE_LOCK.lock().unwrap();
    let home = ggs_home()?;
    let mut store = read_store(&home)?;
    let before = backend_env_for(CLAUDE_CODE_EXT_ID, &store, &home);
    remove_profile(&mut store, &id)?;
    write_store(&home, &store)?;
    drop(_guard);
    let after = backend_env_for(CLAUDE_CODE_EXT_ID, &store, &home);
    let answer = list_answer(&store);
    if before != after {
        restart_bridged_backends(&app);
        let _ = tauri::Emitter::emit(&app, PROVIDERS_EVENT, ());
    }
    Ok(answer)
}

/// Make one profile the provider the bridged backend runs under, restarting the backend
/// (the running process keeps the environment it was spawned with). The official
/// profile is always present, so switching back is one click.
#[tauri::command]
pub fn provider_activate(app: tauri::AppHandle, id: String) -> Result<ProviderList, String> {
    let _guard = STORE_LOCK.lock().unwrap();
    let home = ggs_home()?;
    let mut store = read_store(&home)?;
    let before = backend_env_for(CLAUDE_CODE_EXT_ID, &store, &home);
    set_active(&mut store, &id)?;
    write_store(&home, &store)?;
    drop(_guard);
    let after = backend_env_for(CLAUDE_CODE_EXT_ID, &store, &home);
    let answer = list_answer(&store);
    if before != after {
        restart_bridged_backends(&app);
        let _ = tauri::Emitter::emit(&app, PROVIDERS_EVENT, ());
    }
    Ok(answer)
}

/* ---------- The tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// One test's isolated `~/.ggs`: pinned for the guard's lifetime, restored (and the
    /// temp directory cleaned) on drop. Keep the guard in its own binding — a shadowed
    /// guard unpins immediately and the test would touch the developer's real home.
    struct ProviderHome {
        /// Held (not read) for the guard's lifetime: dropping it cleans the temp dir.
        _dir: tempfile::TempDir,
        previous: Option<PathBuf>,
    }

    impl ProviderHome {
        fn pin() -> Self {
            let previous = TEST_HOME.lock().unwrap().clone();
            let dir = tempfile::tempdir().unwrap();
            *TEST_HOME.lock().unwrap() = Some(dir.path().to_path_buf());
            ProviderHome { _dir: dir, previous }
        }
    }

    impl Drop for ProviderHome {
        fn drop(&mut self) {
            *TEST_HOME.lock().unwrap() = self.previous.take();
        }
    }

    fn official_profile() -> ProviderProfile {
        ProviderProfile {
            id: "official".to_owned(),
            preset: "official".to_owned(),
            label: "Official Claude".to_owned(),
            base_url: None,
            model: None,
            small_model: None,
            api_key_enc: None,
            api_key_hint: None,
        }
    }

    fn deepseek_profile() -> ProviderProfile {
        ProviderProfile {
            id: "deepseek".to_owned(),
            preset: "deepseek".to_owned(),
            label: "DeepSeek".to_owned(),
            base_url: Some("https://api.deepseek.com/anthropic".to_owned()),
            model: Some("deepseek-chat".to_owned()),
            small_model: Some("deepseek-chat".to_owned()),
            api_key_enc: None,
            api_key_hint: None,
        }
    }

    fn third_party_store() -> ProviderStore {
        ProviderStore {
            version: 1,
            active_id: Some("deepseek".to_owned()),
            profiles: vec![official_profile(), deepseek_profile()],
        }
    }

    fn env_map(env: &[(String, String)]) -> std::collections::HashMap<&str, &str> {
        env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
    }

    /// Sealing round-trips, seals to fresh ciphertext every time, and a blob from
    /// another install's master key does not open.
    #[test]
    fn sealing_round_trips_and_binds_to_its_home() {
        let guard_a = ProviderHome::pin();
        let home_a = ggs_home().unwrap();
        let sealed = seal(&home_a, "sk-secret-1234").unwrap();
        assert!(!sealed.contains("sk-secret-1234"));
        assert_eq!(unseal(&home_a, &sealed).unwrap(), "sk-secret-1234");
        // A different nonce per seal — the same secret seals to different bytes.
        assert_ne!(sealed, seal(&home_a, "sk-secret-1234").unwrap());

        let guard_b = ProviderHome::pin();
        let home_b = ggs_home().unwrap();
        assert!(unseal(&home_b, &sealed).is_err());
        drop(guard_b);
        drop(guard_a);
    }

    /// The master key file lands once, 32 bytes, and user-readable only (unix).
    #[test]
    fn the_master_key_is_created_once_user_readable_only() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        let key = master_key(&home).unwrap();
        let path = home.join("keys").join("ai-providers.key");
        assert_eq!(std::fs::read(&path).unwrap().len(), 32);
        assert_eq!(master_key(&home).unwrap(), key);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    /// A bridged backend always gets `CLAUDE_CONFIG_DIR` under ~/.ggs — the official
    /// service is not "no environment", it is "the extension's state stays under ggs".
    #[test]
    fn the_official_provider_points_claude_state_at_the_ggs_home() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        let mut store = third_party_store();
        store.active_id = Some("official".to_owned());
        let env = backend_env_for(CLAUDE_CODE_EXT_ID, &store, &home);
        let map = env_map(&env);
        assert_eq!(map.len(), 1, "official adds no endpoint vars: {env:?}");
        let dir = map["CLAUDE_CONFIG_DIR"];
        assert_eq!(dir, home.join("claude").to_str().unwrap());
        // And nothing at all for an extension the bridge does not serve.
        assert!(backend_env_for("some.other.ext", &store, &home).is_empty());
    }

    /// The active third-party profile carries the endpoint, the decrypted key and the
    /// model ids — the takeover the sandbox probe proves against a local server.
    #[test]
    fn a_third_party_provider_carries_endpoint_key_and_models() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        let mut store = third_party_store();
        store.profiles[1].api_key_enc = Some(seal(&home, "sk-live-key").unwrap());
        store.profiles[1].api_key_hint = Some("-key".to_owned());
        let env = backend_env_for(CLAUDE_CODE_EXT_ID, &store, &home);
        let map = env_map(&env);
        assert_eq!(map["CLAUDE_CONFIG_DIR"], home.join("claude").to_str().unwrap());
        assert_eq!(map["ANTHROPIC_BASE_URL"], "https://api.deepseek.com/anthropic");
        assert_eq!(map["ANTHROPIC_AUTH_TOKEN"], "sk-live-key");
        assert_eq!(map["ANTHROPIC_API_KEY"], "sk-live-key");
        assert_eq!(map["ANTHROPIC_MODEL"], "deepseek-chat");
        assert_eq!(map["ANTHROPIC_SMALL_FAST_MODEL"], "deepseek-chat");
        assert_eq!(map.len(), 6, "{env:?}");
        // No active provider (an empty store): the config dir alone.
        let mut empty = store.clone();
        empty.active_id = None;
        assert_eq!(backend_env_for(CLAUDE_CODE_EXT_ID, &empty, &home).len(), 1);
    }

    /// A key sealed under another install's master key does not take the backend down:
    /// the endpoint vars still apply, the key vars are skipped.
    #[test]
    fn a_key_from_another_install_is_skipped_not_fatal() {
        let guard_a = ProviderHome::pin();
        let sealed_elsewhere = seal(&ggs_home().unwrap(), "sk-elsewhere").unwrap();
        drop(guard_a);

        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        let mut store = third_party_store();
        store.profiles[1].api_key_enc = Some(sealed_elsewhere);
        let env = backend_env_for(CLAUDE_CODE_EXT_ID, &store, &home);
        let map = env_map(&env);
        assert_eq!(
            map.get("ANTHROPIC_BASE_URL").copied(),
            Some("https://api.deepseek.com/anthropic")
        );
        assert!(!map.contains_key("ANTHROPIC_AUTH_TOKEN"));
        assert!(!map.contains_key("ANTHROPIC_API_KEY"));
    }

    /// Saving keeps, replaces and clears the stored key as `apiKey` says, and the store
    /// file never contains the plaintext.
    #[test]
    fn save_keeps_replaces_and_clears_keys_without_plaintext_on_disk() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();

        let mut store = seeded_store();
        let input = ProviderInput {
            id: "deepseek".to_owned(),
            preset: "deepseek".to_owned(),
            label: "DeepSeek".to_owned(),
            base_url: Some("https://api.deepseek.com/anthropic/".to_owned()),
            model: Some("deepseek-chat".to_owned()),
            small_model: None,
            api_key: Some("sk-first-key".to_owned()),
        };
        apply_save(&home, &mut store, &input).unwrap();
        let saved = store.profiles.iter().find(|p| p.id == "deepseek").unwrap().clone();
        assert_eq!(saved.api_key_hint.as_deref(), Some("-key"));
        // The trailing slash is normalized at save.
        assert_eq!(saved.base_url.as_deref(), Some("https://api.deepseek.com/anthropic"));

        // Absent apiKey keeps the sealed key through a label-only edit.
        let mut relabel = input.clone();
        relabel.api_key = None;
        relabel.label = "DeepSeek (team)".to_owned();
        let mut store2 = store.clone();
        apply_save(&home, &mut store2, &relabel).unwrap();
        assert_eq!(
            store2.profiles.iter().find(|p| p.id == "deepseek").unwrap().api_key_enc,
            saved.api_key_enc
        );

        // Empty apiKey clears it.
        let mut cleared = relabel.clone();
        cleared.api_key = Some(String::new());
        apply_save(&home, &mut store2, &cleared).unwrap();
        assert!(store2.profiles.iter().find(|p| p.id == "deepseek").unwrap().api_key_enc.is_none());

        write_store(&home, &store).unwrap();
        let text = std::fs::read_to_string(store_path(&home)).unwrap();
        assert!(!text.contains("sk-first-key"), "the plaintext key must never land in the file");
        assert!(text.contains("apiKeyEnc"), "the sealed key rides its own field: {text}");
    }

    /// Validation: the official profile is endpoint-less whatever was typed; a
    /// third-party profile needs an http(s) URL; ids stay slug-like.
    #[test]
    fn profiles_validate_their_shape() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        let mut store = seeded_store();
        let official = ProviderInput {
            id: "official".to_owned(),
            preset: "official".to_owned(),
            label: "Official".to_owned(),
            base_url: Some("https://evil.example".to_owned()),
            model: Some("x".to_owned()),
            small_model: Some("y".to_owned()),
            api_key: Some("k".to_owned()),
        };
        apply_save(&home, &mut store, &official).unwrap();
        let profile = store.profiles.iter().find(|p| p.id == "official").unwrap();
        assert!(profile.base_url.is_none() && profile.model.is_none() && profile.api_key_enc.is_none());

        let mut bad_url = official.clone();
        bad_url.id = "custom1".to_owned();
        bad_url.preset = "custom".to_owned();
        bad_url.base_url = Some("ftp://nope".to_owned());
        assert!(apply_save(&home, &mut store, &bad_url).is_err());
        bad_url.base_url = None;
        assert!(apply_save(&home, &mut store, &bad_url).is_err());

        let mut bad_id = bad_url.clone();
        bad_id.id = "../escape".to_owned();
        bad_id.base_url = Some("https://ok.example".to_owned());
        assert!(apply_save(&home, &mut store, &bad_id).is_err());
    }

    /// The seeded store lists the official service as active with the built-in
    /// third-party shapes beside it, and a missing file reads as seeded.
    #[test]
    fn a_missing_store_reads_as_the_seeded_default() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        let store = read_store(&home).unwrap();
        assert_eq!(store.active_id.as_deref(), Some("official"));
        assert!(store.profiles.iter().any(|p| p.id == "deepseek"));
        assert!(store.profiles.iter().any(|p| p.id == "glm"));
        assert!(store.profiles.iter().all(|p| p.preset != "custom"));
        // The frontend never learns a ciphertext: the list answer masks the key.
        let answer = list_answer(&store);
        assert!(answer.profiles.iter().all(|p| !p.has_key));
        assert_eq!(answer.bridged_ext_ids, vec!["Anthropic.claude-code"]);
    }

    /// An explicit `CLAUDE_CONFIG_DIR` in the app's own environment overrides the
    /// bridge's `~/.ggs/claude` — the claude-code sandbox probe's hermetic config dir
    /// rides on this (its `tauri dev` launch exports one).
    #[test]
    fn an_explicit_config_dir_in_the_app_env_wins() {
        let _guard = ProviderHome::pin();
        std::env::set_var("CLAUDE_CONFIG_DIR", "/tmp/probe-claude-config");
        let env = backend_env(CLAUDE_CODE_EXT_ID);
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let map = env_map(&env);
        assert_eq!(map["CLAUDE_CONFIG_DIR"], "/tmp/probe-claude-config");
    }

    /// Deleting the active profile falls back to the official service — the bridge
    /// never runs provider-less; deleting an unknown one errors.
    #[test]
    fn deleting_the_active_profile_falls_back_to_official() {
        let mut store = third_party_store();
        assert_eq!(store.active_id.as_deref(), Some("deepseek"));
        remove_profile(&mut store, "deepseek").unwrap();
        assert_eq!(store.active_id.as_deref(), Some("official"));
        assert!(store.profiles.iter().all(|p| p.id != "deepseek"));

        // A non-active deletion leaves the active id standing.
        let mut store = third_party_store();
        store.active_id = Some("official".to_owned());
        remove_profile(&mut store, "deepseek").unwrap();
        assert_eq!(store.active_id.as_deref(), Some("official"));

        assert!(remove_profile(&mut store, "no-such-id").is_err());
    }

    /// Activating an unknown profile errors; re-activating the active one changes
    /// nothing (the command's no-write no-restart case).
    #[test]
    fn activating_an_unknown_profile_errors_and_the_active_one_is_a_no_op() {
        let mut store = third_party_store();
        assert!(set_active(&mut store, "no-such-id").is_err());
        set_active(&mut store, "deepseek").unwrap();
        let untouched = store.clone();
        set_active(&mut store, "deepseek").unwrap();
        assert_eq!(store, untouched);
    }

    /// The whole path: a save seals the key, the store file is written, a fresh read
    /// hands back the same profile, and its key unseals to the original secret.
    #[test]
    fn a_save_round_trips_through_the_file_and_unseals_to_the_original() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        let mut store = seeded_store();
        let input = ProviderInput {
            id: "glm".to_owned(),
            preset: "glm".to_owned(),
            label: "智谱 GLM".to_owned(),
            base_url: Some("https://open.bigmodel.cn/api/anthropic".to_owned()),
            model: Some("glm-4.6".to_owned()),
            small_model: Some("glm-4.5-air".to_owned()),
            api_key: Some("密钥-secret-Δ".to_owned()),
        };
        apply_save(&home, &mut store, &input).unwrap();
        write_store(&home, &store).unwrap();

        let read_back = read_store(&home).unwrap();
        let profile = read_back.profiles.iter().find(|p| p.id == "glm").unwrap();
        assert_eq!(profile.label, "智谱 GLM");
        assert_eq!(profile.model.as_deref(), Some("glm-4.6"));
        let sealed = profile.api_key_enc.as_deref().expect("the key was sealed");
        assert!(!sealed.contains("secret"));
        assert_eq!(unseal(&home, sealed).unwrap(), "密钥-secret-Δ");
        // The multibyte tail survives the hint's char arithmetic.
        assert_eq!(profile.api_key_hint.as_deref(), Some("et-Δ"));
    }
}
