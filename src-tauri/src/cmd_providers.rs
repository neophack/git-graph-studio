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
//!   `ANTHROPIC_API_KEY` (the decrypted key), `ANTHROPIC_MODEL` /
//!   `ANTHROPIC_SMALL_FAST_MODEL` and the tier-alias remap
//!   `ANTHROPIC_DEFAULT_{OPUS,FABLE,SONNET,HAIKU}_MODEL` (the flagship tiers take the
//!   main model, the everyday tiers the small one — so a tier pick never sends a
//!   `claude-*` id to a provider that serves none) — the same takeover the claude-code
//!   sandbox probe proves end to end against a local stand-in server.
//!
//! Switching provider (or editing the active profile) never restarts the bridged
//! backend: the switch's whole effect is a rewrite of the redirected Claude settings'
//! `env` map, which Claude Code applies at every session start — a new chat runs on the
//! new provider, a conversation in flight keeps its own — and of the settings' top-level
//! `model` pin, which would otherwise outrank that env (a `/model` tier pick persists
//! there, and its `claude-*` id would be shown and sent on an endpoint that serves
//! none). [`provider_change`] is the gate every store-writing command runs to decide
//! that rewrite (and the push the windows' switcher chips re-read on).
//!
//! Coupling is one-directional: this module may stop and start the bridged backends,
//! but the spawn path never names this store — [`backend_env`] is registered onto
//! `ext_process`'s spawn-env sources by the composition root (`lib.rs`'s `run`), the
//! only place the two modules meet.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};

/// The extension whose backend the active provider configures. The marketplace id
/// (`ext_gallery.rs`'s `FEATURED` names it too); the frontend learns it from
/// `provider_list`'s `bridgedExtIds` and names no id itself.
pub const CLAUDE_CODE_EXT_ID: &str = "Anthropic.claude-code";

/// Every extension id whose backend runs under the provider bridge.
pub const BRIDGED_EXT_IDS: &[&str] = &[CLAUDE_CODE_EXT_ID];

/// The Tauri event pushed when the store visibly changed (a switch, an edit, a delete)
/// — the frontend's switchers re-read on it, so a switch in one window updates the chip
/// in another.
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
    /// Suggested model ids — the form's model fields offer them as a pick list (the
    /// gateway's live `/v1/models` catalogue joins them); the text stays free, the
    /// lists move faster than apps.
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
            // 2026-09: the lineup is V4 — deepseek-flash (the default, V4.1, vision)
            // and deepseek-v4-pro (the heavyweight, no vision); the old
            // deepseek-chat / deepseek-reasoner aliases still resolve (both to
            // V4 Flash), so configs saved on them keep working.
            models: vec![
                "deepseek-v4-pro",
                "deepseek-flash",
                "deepseek-chat",
                "deepseek-reasoner",
            ],
        },
        ProviderPreset {
            id: "glm".to_owned(),
            label: "Zhipu GLM".to_owned(),
            official: false,
            base_url: Some("https://open.bigmodel.cn/api/anthropic"),
            // 2026-09: every Coding Plan tier serves GLM-5.3 and GLM-5.3-Flash; the
            // older ids still resolve (glm-5.2/-5.1 forward to 5.3, glm-5-turbo and
            // glm-4.7 to 5.3-Flash), so configs saved on them keep working.
            models: vec!["glm-5.3", "glm-5.3-flash", "glm-4.7", "glm-4.6"],
        },
        ProviderPreset {
            id: "kimi".to_owned(),
            label: "Moonshot Kimi".to_owned(),
            official: false,
            base_url: Some("https://api.moonshot.cn/anthropic"),
            // 2026-09: kimi-k3 is the flagship (1M context, vision) and
            // kimi-k2.7-code-highspeed the fast coding tier; kimi-k2.5 (and every
            // moonshot-v1 variant) was retired 2026-08-31 — kimi-k2 still resolves,
            // so configs saved on it keep working.
            models: vec![
                "kimi-k3",
                "kimi-k2.7-code-highspeed",
                "kimi-k2.6",
                "kimi-k2",
            ],
        },
        ProviderPreset {
            id: "newapi".to_owned(),
            label: "NewAPI Gateway".to_owned(),
            official: false,
            // A NewAPI / OneAPI deployment has no fixed origin — the user's own gateway.
            base_url: None,
            models: vec![],
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
    let mut store = ProviderStore {
        version: 1,
        active_id: Some("official".to_owned()),
        profiles: Vec::new(),
    };
    for preset in presets() {
        // The gateway and custom presets have no fixed shape to seed — the Add flow
        // creates their profiles once the user names an endpoint.
        if preset.id == "custom" || preset.id == "newapi" {
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
    // A test build never resolves the developer's real `~/.ggs`: a lib-level test that
    // drives a whole folder flow (lib.rs's open/reopen suite) reaches the Claude
    // integration writes without pinning TEST_HOME, and its `current_exe` is the test
    // binary — the `mcpServers.ggs` registration the app's bridge reads must never
    // become that garbage (it once did, and Claude's /mcp listed nothing because the
    // entry pointed at a deleted scratch folder).
    #[cfg(test)]
    {
        let pinned = TEST_HOME.lock().unwrap().clone();
        match pinned {
            Some(dir) => Ok(dir),
            None => {
                Ok(std::env::temp_dir()
                    .join(format!("ggs-provider-test-home-{}", std::process::id())))
            }
        }
    }
    #[cfg(not(test))]
    {
        let extensions = crate::cmd_ext::extensions_home_dir()?;
        extensions
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "no ~/.ggs home directory".to_owned())
    }
}

fn store_path(home: &Path) -> PathBuf {
    home.join("ai-providers.json")
}

fn read_store(home: &Path) -> Result<ProviderStore, String> {
    match std::fs::read_to_string(store_path(home)) {
        Ok(text) => {
            serde_json::from_str(&text).map_err(|e| format!("invalid ai-providers.json: {e}"))
        }
        Err(_) => Ok(seeded_store()),
    }
}

fn write_store(home: &Path, store: &ProviderStore) -> Result<(), String> {
    let path = store_path(home);
    let text =
        serde_json::to_string_pretty(store).map_err(|e| format!("serialize providers: {e}"))?;
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
            Payload {
                msg: secret.as_bytes(),
                aad: KEY_AAD,
            },
        )
        .map_err(|_| "seal the API key".to_owned())?;
    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&sealed);
    Ok(BASE64.encode(blob))
}

/// The `seal` inverse: any tampering, any other master key, any other purpose fails.
fn unseal(home: &Path, sealed: &str) -> Result<String, String> {
    let key = master_key(home)?;
    let blob = BASE64
        .decode(sealed)
        .map_err(|e| format!("a sealed key is not valid base64: {e}"))?;
    if blob.len() < 12 + 16 {
        return Err("a sealed key is too short to open".to_owned());
    }
    let (nonce, body) = blob.split_at(12);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let plain = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: body,
                aad: KEY_AAD,
            },
        )
        .map_err(|_| {
            "the stored API key does not open under this install's master key".to_owned()
        })?;
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
fn normalize_profile(
    input: &ProviderInput,
    presets: &[ProviderPreset],
) -> Result<ProviderProfile, String> {
    let id = input.id.trim().to_owned();
    if id.is_empty() || id.contains(['/', '\\', ':']) || id.contains("..") {
        return Err(format!("invalid provider id {id:?}"));
    }
    let preset = presets
        .iter()
        .find(|preset| preset.id == input.preset)
        .ok_or_else(|| format!("unknown preset {:?}", input.preset))?;
    let label = clean_option(&Some(input.label.clone())).unwrap_or_else(|| preset.label.clone());
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
        return Err(format!(
            "the base URL must start with https:// (or http:// for a local server): {base_url}"
        ));
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
fn apply_save(home: &Path, store: &mut ProviderStore, input: &ProviderInput) -> Result<(), String> {
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
                    profile.api_key_hint = Some(
                        trimmed
                            .chars()
                            .rev()
                            .take(4)
                            .collect::<Vec<_>>()
                            .into_iter()
                            .rev()
                            .collect(),
                    );
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
/// The active profile's provider environment: endpoint, decrypted key and model ids —
/// the values `claude_provider_settings` writes into the redirected Claude settings.
/// A key that does not open (a copied store from another install) is skipped, never
/// fatal: the endpoint still applies and the extension's own login remains the
/// fallback. Decryption happens here and only here; the values exist to be written
/// into Claude's own config file and are never returned over IPC.
pub fn provider_env_vars(active: &ProviderProfile, home: &Path) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = Vec::new();
    if active.preset == "official" {
        return env;
    }
    if let Some(base_url) = active.base_url.as_deref().filter(|url| !url.is_empty()) {
        env.push(("ANTHROPIC_BASE_URL".to_owned(), base_url.to_owned()));
    }
    if let Some(sealed) = active.api_key_enc.as_deref() {
        if let Ok(key) = unseal(home, sealed) {
            env.push(("ANTHROPIC_AUTH_TOKEN".to_owned(), key.clone()));
            env.push(("ANTHROPIC_API_KEY".to_owned(), key));
        }
    }
    if let Some(model) = active.model.as_deref().filter(|m| !m.is_empty()) {
        env.push(("ANTHROPIC_MODEL".to_owned(), model.to_owned()));
        // Claude Code's tier aliases resolve through these: without the remap a tier
        // pick in /model sends a `claude-*` id to the provider's endpoint and the
        // model display names Claude models the provider does not serve. The flagship
        // tiers (opus, fable) take the profile's main model, the everyday tiers its
        // small model (GLM: opus and fable → glm-5.3, sonnet and haiku →
        // glm-5.3-flash) — falling back to the main model when the profile configures
        // no small one.
        let everyday = active
            .small_model
            .as_deref()
            .filter(|m| !m.is_empty())
            .unwrap_or(model);
        env.push(("ANTHROPIC_DEFAULT_OPUS_MODEL".to_owned(), model.to_owned()));
        env.push(("ANTHROPIC_DEFAULT_FABLE_MODEL".to_owned(), model.to_owned()));
        env.push((
            "ANTHROPIC_DEFAULT_SONNET_MODEL".to_owned(),
            everyday.to_owned(),
        ));
        env.push((
            "ANTHROPIC_DEFAULT_HAIKU_MODEL".to_owned(),
            everyday.to_owned(),
        ));
    }
    if let Some(model) = active.small_model.as_deref().filter(|m| !m.is_empty()) {
        env.push(("ANTHROPIC_SMALL_FAST_MODEL".to_owned(), model.to_owned()));
    }
    env
}

/// The spawn environment a bridged extension's backend runs with. Pure over the home,
/// so the exact bytes a backend sees are testable. Only the state redirect rides the
/// process environment: the provider's endpoint and key live in the redirected Claude
/// settings (`claude_provider_settings`), which Claude Code applies at every session
/// start — so switching a provider never requires restarting the backend, and the two
/// sources can never disagree mid-flight.
pub fn backend_env_for(ext_id: &str, home: &Path) -> Vec<(String, String)> {
    if !BRIDGED_EXT_IDS.contains(&ext_id) {
        return Vec::new();
    }
    vec![(
        "CLAUDE_CONFIG_DIR".to_owned(),
        home.join("claude").to_string_lossy().into_owned(),
    )]
}

/* ---------- The gateway probes (NewAPI / OneAPI / any Anthropic-compatible origin) ---------- */

/// The gateway probes' ceiling: a test or a model listing that takes longer than this
/// is an answer the user cannot wait for anyway.
const GATEWAY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

fn gateway_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(GATEWAY_TIMEOUT))
        .build()
        .into()
}

/// A provider input's base URL as the gateway probes ask it: trimmed, slash-normalized,
/// http(s). The same normalization a save applies, so probing an unsaved form field and
/// probing the stored profile behave identically.
fn gateway_base_url(base_url: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.starts_with("https://") || base.starts_with("http://") {
        Ok(base.to_owned())
    } else {
        Err(format!(
            "the base URL must start with https:// (or http:// for a local server): {base}"
        ))
    }
}

/// The gateway's model catalogue (`GET {base}/v1/models` with the key) — what NewAPI /
/// OneAPI and every OpenAI-compatible origin answer with `{ "data": [ { "id": … } ] }`.
/// The ids come back in the gateway's own order, deduplicated.
pub fn fetch_gateway_models(base_url: &str, api_key: &str) -> Result<Vec<String>, String> {
    let url = format!("{}/v1/models", gateway_base_url(base_url)?);
    let key = api_key.trim();
    let result = gateway_agent()
        .get(&url)
        .header("Authorization", &format!("Bearer {key}"))
        .header("x-api-key", key)
        .header("Accept", "application/json")
        .call();
    // ureq answers a non-2xx as an Err(status): the same diagnosis the probe renders.
    let mut response = match result {
        Ok(response) => response,
        Err(ureq::Error::StatusCode(status)) => return Err(gateway_status_message(status, &url)),
        Err(e) => return Err(format!("could not reach {url}: {e}")),
    };
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("read the model catalogue: {e}"))?;
    if !(200..300).contains(&status) {
        return Err(gateway_status_message(status, &url));
    }
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("the model catalogue is not valid JSON: {e}"))?;
    let entries = parsed
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            "the model catalogue has no \"data\" array — is this an OpenAI-compatible gateway?"
                .to_owned()
        })?;
    let mut models: Vec<String> = Vec::new();
    for entry in entries {
        if let Some(id) = entry.get("id").and_then(serde_json::Value::as_str) {
            if !id.is_empty() && !models.iter().any(|known| known == id) {
                models.push(id.to_owned());
            }
        }
    }
    Ok(models)
}

/// A gateway probe's answer: reachability, the HTTP status, the round-trip time and a
/// user-readable diagnosis (the UI renders `message` verbatim).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionReport {
    pub ok: bool,
    pub status: u16,
    pub ms: u64,
    pub message: String,
}

/// A non-2xx from the gateway as the diagnosis the test connection renders.
fn gateway_status_message(status: u16, url: &str) -> String {
    match status {
        401 | 403 => format!("the gateway rejected the API key (HTTP {status})"),
        404 => format!(
            "nothing answers /v1/messages at {url} — the base URL may need the provider's \
             Anthropic suffix (e.g. /anthropic)"
        ),
        429 => "the gateway rate-limited the probe (HTTP 429) — the key works, but is throttled"
            .to_owned(),
        other => format!("the gateway answered HTTP {other}"),
    }
}

/// One Anthropic-compatible probe: a 1-token `/v1/messages` round trip. Any HTTP answer
/// is a diagnosis (401 — key rejected, 404 — wrong base URL, …); only a transport
/// failure is an `Err`. NewAPI gateways route by model id, so the form's model rides
/// along (a wrong one still proves reachability — the gateway answers, just unhappy).
pub fn test_gateway_connection(
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<ConnectionReport, String> {
    let url = format!("{}/v1/messages", gateway_base_url(base_url)?);
    let key = api_key.trim();
    let body = serde_json::json!({
        "model": if model.trim().is_empty() { "claude-3-5-haiku-20241022" } else { model.trim() },
        "max_tokens": 1,
        "messages": [{ "role": "user", "content": "ping" }]
    });
    let started = std::time::Instant::now();
    let body_text =
        serde_json::to_string(&body).map_err(|e| format!("serialize the probe: {e}"))?;
    let sent = gateway_agent()
        .post(&url)
        .header("x-api-key", key)
        .header("Authorization", &format!("Bearer {key}"))
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .send(body_text.as_bytes());
    let ms = started.elapsed().as_millis() as u64;
    match sent {
        Ok(mut response) => {
            let status = response.status().as_u16();
            let _ = response.body_mut().read_to_string();
            let (ok, message) = if (200..300).contains(&status) {
                (true, format!("reachable — the gateway answered in {ms} ms"))
            } else {
                (false, gateway_status_message(status, &url))
            };
            Ok(ConnectionReport {
                ok,
                status,
                ms,
                message,
            })
        }
        Err(ureq::Error::StatusCode(status)) => {
            let (ok, message) = if (200..300).contains(&status) {
                (true, format!("reachable — the gateway answered in {ms} ms"))
            } else {
                (false, gateway_status_message(status, &url))
            };
            Ok(ConnectionReport {
                ok,
                status,
                ms,
                message,
            })
        }
        Err(e) => Err(format!("could not reach {url}: {e}")),
    }
}

/* ---------- The cc-switch import ---------- */

/// One provider configuration found on this machine's cc-switch (or live Claude)
/// configuration — what the scan answers. No secret crosses this: `hasKey` stands in
/// for the key the import seals backend-side.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CcSwitchCandidate {
    pub id: String,
    pub label: String,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub has_key: bool,
    /// The configuration cc-switch (or Claude Code itself) currently points at.
    pub current: bool,
    /// Where it was found: `cc-switch` or `claude`.
    pub source: String,
}

/// One candidate as the import consumes it: the public scan plus the key itself, which
/// exists only in this process (the scan command's answer strips it).
struct CcSwitchEntry {
    candidate: CcSwitchCandidate,
    api_key: Option<String>,
}

fn ccswitch_config_path(home: &Path) -> PathBuf {
    home.join(".cc-switch").join("config.json")
}

fn claude_settings_path(home: &Path) -> PathBuf {
    home.join(".claude").join("settings.json")
}

/// A label as a profile id: ASCII word characters survive, the rest folds to `-`; a
/// slug that comes out empty (a CJK-only label) becomes the numbered fallback.
fn slugify(label: &str, fallback: &str) -> String {
    let slug: String = label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-').to_owned();
    if slug.is_empty() {
        fallback.to_owned()
    } else {
        slug
    }
}

/// One provider-shaped JSON entry as cc-switch's config carries it (the tolerant read:
/// `name`/`label`, the env map under `settingsConfig.env` / `env` / `config.env`).
fn ccswitch_entry_object(
    entry: &serde_json::Value,
    id_hint: Option<&str>,
    source: &str,
) -> Option<CcSwitchEntry> {
    let env = entry
        .pointer("/settingsConfig/env")
        .or_else(|| entry.get("env"))
        .or_else(|| entry.pointer("/config/env"))?
        .as_object()?;
    let text = |key: &str| {
        env.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let base_url = text("ANTHROPIC_BASE_URL");
    let api_key = text("ANTHROPIC_AUTH_TOKEN").or_else(|| text("ANTHROPIC_API_KEY"));
    let model = text("ANTHROPIC_MODEL").or_else(|| {
        entry
            .get("model")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    });
    // A provider entry with neither an endpoint nor a key configures nothing this
    // bridge could run — the official service needs no import either.
    if base_url.is_none() && api_key.is_none() {
        return None;
    }
    let label = entry
        .get("name")
        .or_else(|| entry.get("label"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| id_hint.unwrap_or("imported"))
        .to_owned();
    let id = slugify(&label, id_hint.unwrap_or("ccswitch"));
    let current = entry
        .get("current")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    Some(CcSwitchEntry {
        candidate: CcSwitchCandidate {
            id,
            label,
            base_url,
            model,
            has_key: api_key.is_some(),
            current,
            source: source.to_owned(),
        },
        api_key,
    })
}

/// cc-switch's own configuration file: the provider list under `claude.providers` — a
/// JSON array (one shape) or an id→entry map (the other) — plus `claude.current` naming
/// the active one (by its raw key, which is not the slug the profile id becomes).
/// Tolerant on purpose: the community CLIs and the desktop releases disagree on the
/// shapes, and an unreadable future format imports nothing rather than half of something.
fn scan_ccswitch_config(json: &serde_json::Value) -> Vec<CcSwitchEntry> {
    let mut entries: Vec<CcSwitchEntry> = Vec::new();
    let claude = json.get("claude").unwrap_or(json);
    let current = claude
        .get("current")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let providers = claude.get("providers");
    let shaped: Vec<(Option<String>, CcSwitchEntry)> = match providers {
        Some(serde_json::Value::Array(list)) => list
            .iter()
            .filter_map(|entry| ccswitch_entry_object(entry, None, "cc-switch").map(|e| (None, e)))
            .collect(),
        Some(serde_json::Value::Object(map)) => map
            .iter()
            .filter_map(|(id, entry)| {
                ccswitch_entry_object(entry, Some(id), "cc-switch")
                    .map(|e| (Some(id.to_owned()), e))
            })
            .collect(),
        _ => Vec::new(),
    };
    for (raw_id, mut entry) in shaped {
        if !entry.candidate.current {
            entry.candidate.current = raw_id.is_some() && current.as_deref() == raw_id.as_deref();
        }
        entries.push(entry);
    }
    entries
}

/// The live Claude configuration (`~/.claude/settings.json`'s `env` map) as one
/// candidate: whatever cc-switch last switched to, or a hand-set environment — the
/// configuration this machine's Claude Code actually runs on right now, so it is
/// current by definition.
fn scan_claude_settings(json: &serde_json::Value) -> Option<CcSwitchEntry> {
    let mut entry = ccswitch_entry_object(json, Some("current"), "claude")?;
    entry.candidate.current = true;
    Some(entry)
}

/// Everything importable on this machine, keys included (the command's answer strips
/// them): cc-switch's list first, then the live Claude configuration, deduplicated by
/// endpoint+key so the provider cc-switch currently points at does not import twice —
/// and its current flag folds into the kept entry.
fn scan_ccswitch_entries(home: &Path) -> Vec<CcSwitchEntry> {
    let mut entries: Vec<CcSwitchEntry> = Vec::new();
    for (path, scan) in [
        (
            ccswitch_config_path(home),
            scan_ccswitch_config as fn(&serde_json::Value) -> Vec<CcSwitchEntry>,
        ),
        (claude_settings_path(home), |json: &serde_json::Value| {
            scan_claude_settings(json).into_iter().collect()
        }),
    ] {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue; // not installed, or the file went away between scan and import
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue; // a half-written foreign file imports nothing, never errors out
        };
        for entry in scan(&json) {
            // Same endpoint and same key is the same provider, whatever either tool
            // named it; a different key on one endpoint is a second account and stays.
            if let Some(known) = entries.iter_mut().find(|known| {
                known.candidate.base_url == entry.candidate.base_url
                    && known.api_key == entry.api_key
            }) {
                known.candidate.current |= entry.candidate.current;
                continue;
            }
            entries.push(entry);
        }
    }
    entries
}

/// The scan the UI sees: ids made unique (a duplicate label gains a numeric suffix),
/// keys stripped.
fn scan_ccswitch_candidates(home: &Path) -> Vec<CcSwitchCandidate> {
    let mut candidates: Vec<CcSwitchCandidate> = Vec::new();
    let mut taken: Vec<String> = Vec::new();
    for mut entry in scan_ccswitch_entries(home) {
        let mut id = entry.candidate.id.clone();
        let mut suffix = 2;
        while taken.contains(&id) {
            id = format!("{}-{}", entry.candidate.id, suffix);
            suffix += 1;
        }
        entry.candidate.id = id.clone();
        taken.push(id);
        candidates.push(entry.candidate);
    }
    candidates
}

/// Import the named candidates into the store (keys sealed here, never crossing back),
/// returning how many landed and the id of the currently-marked one, if any. Unknown
/// names are skipped; an existing profile of the same id is replaced.
fn import_ccswitch_entries(
    home: &Path,
    store: &mut ProviderStore,
    names: &[String],
) -> Result<(usize, Option<String>), String> {
    let mut imported = 0usize;
    let mut activate: Option<String> = None;
    for entry in scan_ccswitch_entries(home) {
        if !names.contains(&entry.candidate.id) {
            continue;
        }
        let input = ProviderInput {
            id: entry.candidate.id.clone(),
            preset: "custom".to_owned(),
            label: entry.candidate.label.clone(),
            base_url: entry.candidate.base_url.clone(),
            model: entry.candidate.model.clone(),
            small_model: None,
            api_key: entry.api_key,
        };
        apply_save(home, store, &input)?;
        if entry.candidate.current {
            activate = Some(entry.candidate.id.clone());
        }
        imported += 1;
    }
    Ok((imported, activate))
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
    let mut env = backend_env_for(ext_id, &home);
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

/* ---------- The provider → Claude settings application ---------- */

/// The active profile's provider environment — the settings writer's source. The same
/// resolution [`apply_claude_provider_env`] performs, exposed so the store-writing
/// commands can tell a settings-reaching change (endpoint, key, model, the active id)
/// from a cosmetic one (a label) — exactly what a switch gates on.
fn active_provider_env(store: &ProviderStore, home: &Path) -> Vec<(String, String)> {
    store
        .active_id
        .as_deref()
        .and_then(|id| store.profiles.iter().find(|profile| profile.id == id))
        .map(|active| provider_env_vars(active, home))
        .unwrap_or_default()
}

/// What a store-writing command's tail must run, decided by comparing the store before
/// and after the mutation: `env_changed` rewrites the redirected Claude settings (the
/// next session picks the new provider up; a conversation in flight is never touched),
/// `store_changed` pushes the event the windows' switcher chips re-read on.
///
/// The env comparison is over the *provider environment*, never the spawn environment:
/// the spawn env is the constant config redirect now, and gating a switch on it made
/// every switch a silent no-op — the settings kept the previous provider and new chats
/// never moved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProviderChange {
    /// The active provider's environment (endpoint, key, models) changed: rewrite
    /// Claude's redirected settings.
    pub env_changed: bool,
    /// The store visibly changed (the active id, a label): the windows re-read.
    pub store_changed: bool,
}

/// [`ProviderChange`] for one store mutation: the active profile's provider env decides
/// the settings write, the whole store decides the push.
pub fn provider_change(
    before: &ProviderStore,
    after: &ProviderStore,
    home: &Path,
) -> ProviderChange {
    ProviderChange {
        env_changed: active_provider_env(before, home) != active_provider_env(after, home),
        store_changed: before != after,
    }
}

/// The provider environment keys this bridge owns in Claude's settings — everything a
/// third-party endpoint needs, and everything that must be *absent* for the official
/// service (a stale endpoint here would shadow the user's login).
pub const PROVIDER_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

/// Claude's redirected settings with the active provider's environment applied — the
/// composition core of a provider switch. Claude Code applies the settings' `env` map
/// at every session start (the mechanism cc-switch uses), so writing it makes the next
/// chat run on the new provider without restarting anything; a running conversation is
/// never touched. The user's own env keys and every other setting are preserved
/// verbatim; switching to the official profile removes exactly this bridge's keys (a
/// stale endpoint here would shadow the official login). The top-level `model` pin
/// follows the active provider under the same takeover: Claude Code's own `/model`
/// pick persists there and outranks the env map for what a session shows and sends,
/// so while the active profile pins a model the pin carries it (a `claude-*` tier id
/// left there would be displayed and sent on an endpoint that serves none), and a pin
/// naming an id the official service cannot serve is cleared — a `claude-*` id or a
/// bare tier alias (`sonnet[1m]`, …) is the user's own and survives verbatim. An
/// unchanged file answers None; an unparseable one fails rather than being replaced.
pub fn claude_provider_settings(
    existing: Option<&str>,
    env: &[(String, String)],
) -> Result<Option<String>, String> {
    let mut settings: serde_json::Value = match existing {
        Some(text) if text.trim().is_empty() => serde_json::json!({}),
        Some(text) => serde_json::from_str(text).map_err(|e| {
            format!("the existing Claude settings are not valid JSON — not overwriting them: {e}")
        })?,
        None => serde_json::json!({}),
    };
    if !settings.is_object() {
        return Err(
            "the existing Claude settings are not a JSON object — not overwriting them".to_owned(),
        );
    }
    let object = settings.as_object_mut().expect("checked above");
    let map = object.entry("env").or_insert_with(|| serde_json::json!({}));
    if !map.is_object() {
        return Err("the existing env entry is not a JSON object — not overwriting it".to_owned());
    }
    let env_map = map.as_object_mut().expect("checked above");
    // This bridge's keys are replaced wholesale — set what the active profile carries,
    // remove the rest, so a previous provider never leaks through.
    for key in PROVIDER_ENV_KEYS {
        env_map.remove(*key);
    }
    for (key, value) in env {
        env_map.insert(key.clone(), serde_json::Value::String(value.clone()));
    }
    if env_map.is_empty() {
        object.remove("env");
    }
    // The `/model` pin takeover the doc comment promises. `split('[')` first: the
    // tier picker pins carry a context-window suffix (`sonnet[1m]`), the alias it
    // names is what Claude's own service actually serves.
    let pinned_model = env
        .iter()
        .find(|(key, _)| key == "ANTHROPIC_MODEL")
        .map(|(_, value)| value.clone());
    match pinned_model {
        Some(model) => {
            object.insert("model".to_owned(), serde_json::Value::String(model));
        }
        None => {
            if let Some(pin) = object.get("model").and_then(|value| value.as_str()) {
                let base = pin.split('[').next().unwrap_or(pin);
                let claude_owned = pin.starts_with("claude")
                    || matches!(base, "default" | "opus" | "fable" | "sonnet" | "haiku" | "opusplan");
                if !claude_owned {
                    object.remove("model");
                }
            }
        }
    }
    let text = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("serialize the Claude settings: {e}"))?
        + "\n";
    if Some(text.as_str()) == existing {
        return Ok(None);
    }
    Ok(Some(text))
}

/// Apply the active provider to Claude's redirected settings — what a switch, a save
/// of the active profile, an import or the boot pass all run through. Never restarts
/// the backend: the next Claude session picks the change up from its own config read,
/// and a conversation in flight keeps its provider. Errors are logged, never thrown
/// into the command's answer — a failed write is diagnosable, not fatal.
pub fn apply_claude_provider_env() {
    let result = apply_claude_provider_env_inner();
    if let Err(error) = result {
        eprintln!("[providers] claude provider env: {error}");
        crate::cmd_ext::log_extensions(&format!("claude provider env: {error}"));
    }
}

/// [`apply_claude_provider_env`]'s IO body. The settings file lands 0600 when it
/// carries a key (the same at-rest posture the sealed store has — the plaintext here
/// is Claude Code's own configuration format, exactly what cc-switch writes).
fn apply_claude_provider_env_inner() -> Result<(), String> {
    let home = ggs_home()?;
    let store = read_store(&home)?;
    let env = active_provider_env(&store, &home);
    let dir = home.join("claude");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = dir.join("settings.json");
    let existing = std::fs::read_to_string(&path).ok();
    if let Some(text) = claude_provider_settings(existing.as_deref(), &env)? {
        std::fs::write(&path, &text).map_err(|e| format!("write {}: {e}", path.display()))?;
        // The plaintext key is Claude Code's own configuration format here (exactly
        // what cc-switch writes); the file gets the sealed store's at-rest posture.
        if !env.is_empty() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                    .map_err(|e| format!("restrict {}: {e}", path.display()))?;
            }
        }
    }
    Ok(())
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
/// a value seals it. Saving the *active* profile rewrites the redirected Claude settings
/// when the change reaches its environment (endpoint, model or key) — the next chat runs
/// on it, a conversation in flight keeps its provider.
#[tauri::command]
pub fn provider_save(
    app: tauri::AppHandle,
    profile: ProviderInput,
) -> Result<ProviderList, String> {
    let _guard = STORE_LOCK.lock().unwrap();
    let home = ggs_home()?;
    let mut store = read_store(&home)?;
    let before = store.clone();
    apply_save(&home, &mut store, &profile)?;
    write_store(&home, &store)?;
    drop(_guard);
    let answer = list_answer(&store);
    let change = provider_change(&before, &store, &home);
    if change.env_changed {
        apply_claude_provider_env();
    }
    if change.store_changed {
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
    let before = store.clone();
    remove_profile(&mut store, &id)?;
    write_store(&home, &store)?;
    drop(_guard);
    let answer = list_answer(&store);
    let change = provider_change(&before, &store, &home);
    if change.env_changed {
        apply_claude_provider_env();
    }
    if change.store_changed {
        let _ = tauri::Emitter::emit(&app, PROVIDERS_EVENT, ());
    }
    Ok(answer)
}

/// Make one profile the provider the bridged backend runs under. Never restarts the
/// backend: the switch rewrites the redirected Claude settings' env map, which Claude
/// Code applies at every session start — a new chat runs on the new provider, a
/// conversation in flight keeps its own. The official profile is always present, so
/// switching back is one click.
#[tauri::command]
pub fn provider_activate(app: tauri::AppHandle, id: String) -> Result<ProviderList, String> {
    let _guard = STORE_LOCK.lock().unwrap();
    let home = ggs_home()?;
    let mut store = read_store(&home)?;
    let before = store.clone();
    set_active(&mut store, &id)?;
    write_store(&home, &store)?;
    drop(_guard);
    let answer = list_answer(&store);
    let change = provider_change(&before, &store, &home);
    if change.env_changed {
        apply_claude_provider_env();
    }
    if change.store_changed {
        let _ = tauri::Emitter::emit(&app, PROVIDERS_EVENT, ());
    }
    Ok(answer)
}

/* ---------- The gateway and import commands ---------- */

/// The key the probes run with: what the form holds (a typed key), else the named
/// profile's stored one, decrypted here and never returned — an edit of an existing
/// provider probes with the key it already has.
fn probe_key(
    home: &Path,
    store: &ProviderStore,
    api_key: &str,
    profile_id: Option<&str>,
) -> String {
    let typed = api_key.trim();
    if !typed.is_empty() {
        return typed.to_owned();
    }
    let Some(id) = profile_id else {
        return String::new();
    };
    store
        .profiles
        .iter()
        .find(|profile| profile.id == id)
        .and_then(|profile| profile.api_key_enc.as_deref())
        .and_then(|sealed| unseal(home, sealed).ok())
        .unwrap_or_default()
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
    let home = crate::cmd_ext::extensions_home_dir()?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "no user home directory".to_owned())?;
    Ok(scan_ccswitch_candidates(&home))
}

/// Import the named candidates, sealing their keys into the store. A candidate marked
/// current (what cc-switch points at) is activated — the one deliberate opinion of the
/// import, so the bridge takes over the configuration the machine already runs on.
#[tauri::command]
pub fn provider_import_ccswitch(
    app: tauri::AppHandle,
    names: Vec<String>,
) -> Result<ProviderList, String> {
    let _guard = STORE_LOCK.lock().unwrap();
    let home = ggs_home()?;
    let mut store = read_store(&home)?;
    let before = store.clone();
    let (imported, activate) = import_ccswitch_entries(&home, &mut store, &names)?;
    if imported == 0 {
        return Err("none of the named configurations was found to import".to_owned());
    }
    if let Some(id) = activate {
        set_active(&mut store, &id)?;
    }
    write_store(&home, &store)?;
    drop(_guard);
    let answer = list_answer(&store);
    let change = provider_change(&before, &store, &home);
    if change.env_changed {
        apply_claude_provider_env();
    }
    if change.store_changed {
        let _ = tauri::Emitter::emit(&app, PROVIDERS_EVENT, ());
    }
    Ok(answer)
}

/* ---------- The GGS analysis MCP inside Claude (module 16 served to the extension) ---------- */

/// The MCP server name Claude's `/mcp` lists the analysis bridge under.
pub const CLAUDE_MCP_SERVER_NAME: &str = "ggs";

/// Claude's redirected global config (`~/.ggs/claude/.claude.json`) with (or without)
/// the GGS analysis server under the user-scope `mcpServers` — the composition core.
/// This file is the one place Claude Code reads user-level MCP servers from
/// (`claude mcp add --scope user` writes here; its settings schema has no
/// `mcpServers` key, which is why the first cut of this bridge — writing
/// `settings.json` — never reached `/mcp`). The same file carries Claude's own login
/// and state keys, so the merge preserves every entry this app did not write and an
/// unparseable file fails rather than being replaced. `existing` is the file's
/// current text (None when absent); the answer is the new text to write, or None
/// when the file already says the right thing (a no-op apply must not touch Claude's
/// own mtime-ordered state).
pub fn claude_mcp_global_config(
    existing: Option<&str>,
    folders: &[String],
    command: &str,
) -> Result<Option<String>, String> {
    let mut config: serde_json::Value = match existing {
        Some(text) if text.trim().is_empty() => serde_json::json!({}),
        Some(text) => serde_json::from_str(text).map_err(|e| {
            format!("the existing Claude global config is not valid JSON — not overwriting it: {e}")
        })?,
        None => serde_json::json!({}),
    };
    if !config.is_object() {
        return Err(
            "the existing Claude global config is not a JSON object — not overwriting it"
                .to_owned(),
        );
    }
    let servers = config
        .as_object_mut()
        .expect("checked above")
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() {
        return Err(
            "the existing mcpServers entry is not a JSON object — not overwriting it".to_owned(),
        );
    }
    // The entry `claude mcp add --scope user` would write — an explicit stdio type,
    // the shape Claude Code's own reader is documented against.
    let wanted = folders.first().map(|folder| {
        serde_json::json!({
            "type": "stdio",
            "command": command,
            "args": ["--mcp", folder],
            "env": {},
        })
    });
    let map = servers.as_object_mut().expect("checked above");
    match wanted {
        Some(entry) => match map.get(CLAUDE_MCP_SERVER_NAME) {
            Some(current) if *current == entry => return Ok(None),
            _ => {
                map.insert(CLAUDE_MCP_SERVER_NAME.to_owned(), entry);
            }
        },
        None => {
            if map.remove(CLAUDE_MCP_SERVER_NAME).is_none() {
                return Ok(None);
            }
        }
    }
    let mut out = config;
    {
        let map = out
            .get_mut("mcpServers")
            .and_then(serde_json::Value::as_object_mut)
            .expect("checked above");
        if map.is_empty() {
            out.as_object_mut()
                .expect("checked above")
                .remove("mcpServers");
        }
    }
    Ok(Some(
        serde_json::to_string_pretty(&out)
            .map_err(|e| format!("serialize the Claude global config: {e}"))?
            + "\n",
    ))
}

/// Claude's redirected settings with the GGS server's settings-side state: the
/// `mcp__ggs` auto-allow rule — every tool the server serves is a read-only,
/// repository-confined analysis read, and the zero-configuration promise is that a
/// session never has to prompt for one — plus the retirement of the `mcpServers.ggs`
/// entry an earlier cut of this bridge wrote here (the settings schema has no
/// `mcpServers` key; Claude Code never read it). `enabled` follows the open folder.
/// Everything else is preserved verbatim; the answer is None when the file already
/// agrees, and an unparseable or wrongly-shaped file fails rather than being
/// replaced.
pub fn claude_mcp_settings(
    existing: Option<&str>,
    enabled: bool,
) -> Result<Option<String>, String> {
    let mut settings: serde_json::Value = match existing {
        Some(text) if text.trim().is_empty() => serde_json::json!({}),
        Some(text) => serde_json::from_str(text).map_err(|e| {
            format!("the existing Claude settings are not valid JSON — not overwriting them: {e}")
        })?,
        None => serde_json::json!({}),
    };
    if !settings.is_object() {
        return Err(
            "the existing Claude settings are not a JSON object — not overwriting them".to_owned(),
        );
    }
    let rule = format!("mcp__{CLAUDE_MCP_SERVER_NAME}");
    let mut changed = false;

    // The retired registration: our entry goes, whatever a hand put beside it stays,
    // and an emptied map goes with it.
    if let Some(map) = settings
        .get_mut("mcpServers")
        .and_then(serde_json::Value::as_object_mut)
    {
        changed |= map.remove(CLAUDE_MCP_SERVER_NAME).is_some();
        if map.is_empty() {
            settings
                .as_object_mut()
                .expect("checked above")
                .remove("mcpServers");
        }
    }

    let permissions = settings
        .as_object_mut()
        .expect("checked above")
        .entry("permissions")
        .or_insert_with(|| serde_json::json!({}));
    if !permissions.is_object() {
        return Err(
            "the existing permissions entry is not a JSON object — not overwriting it".to_owned(),
        );
    }
    let allow = permissions
        .as_object_mut()
        .expect("checked above")
        .entry("allow")
        .or_insert_with(|| serde_json::json!([]));
    if !allow.is_array() {
        return Err(
            "the existing permissions.allow entry is not an array — not overwriting it".to_owned(),
        );
    }
    let list = allow.as_array_mut().expect("checked above");
    let present = list.iter().any(|item| item.as_str() == Some(rule.as_str()));
    match (enabled, present) {
        (true, false) => {
            list.push(serde_json::json!(rule));
            changed = true;
        }
        (false, true) => {
            list.retain(|item| item.as_str() != Some(rule.as_str()));
            changed = true;
        }
        _ => {}
    }
    if !changed {
        return Ok(None);
    }
    // An unregister leaves no scaffolding behind in Claude's own file.
    if let Some(map) = settings
        .get_mut("permissions")
        .and_then(serde_json::Value::as_object_mut)
    {
        if map
            .get("allow")
            .and_then(serde_json::Value::as_array)
            .is_some_and(Vec::is_empty)
        {
            map.remove("allow");
        }
        if map.is_empty() {
            settings
                .as_object_mut()
                .expect("checked above")
                .remove("permissions");
        }
    }
    Ok(Some(
        serde_json::to_string_pretty(&settings)
            .map_err(|e| format!("serialize the Claude settings: {e}"))?
            + "\n",
    ))
}

/// Keep Claude's redirected configuration current with everything this bridge owns:
/// the MCP server registration (the analysis server for the open folder, in the
/// global config's user-scope `mcpServers` — the one place Claude Code reads
/// user-level servers from) with its settings-side auto-allow rule, and the active
/// provider's environment. Written at boot and on every folder open/close beside
/// `notify_workspace` (the composition root's wiring), so every new Claude session
/// lists `ggs` under `/mcp` and runs on the chosen provider — no setup, no restart.
/// The global config also carries Claude's own login state: the merge moves only
/// this app's own entries and preserves every other key verbatim.
pub fn apply_claude_integration(folders: &[String]) {
    let result = apply_claude_integration_inner(folders, std::env::current_exe().ok().as_deref());
    if let Err(error) = result {
        // The bridge must never keep a folder open or close from succeeding; the
        // extension host log is where a missing registration is diagnosable.
        eprintln!("[providers] claude integration: {error}");
        crate::cmd_ext::log_extensions(&format!("claude integration: {error}"));
    }
}

/// [`apply_claude_mcp`]'s injectable core (the executable path is a test seam). Two
/// files: the registration into the redirected global config (the user-scope
/// `mcpServers` — the only place Claude Code reads user-level servers from, and a
/// file it rewrites itself while carrying its login state, so the write preserves
/// every other key and lands 0600 like Claude keeps it), then the settings pass
/// (the `mcp__ggs` auto-allow rule, plus the retirement of the entry the first cut
/// of this bridge mistakenly wrote there).
fn apply_claude_mcp_inner(folders: &[String], command: Option<&Path>) -> Result<(), String> {
    let home = ggs_home()?;
    let dir = home.join("claude");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let command = command
        .map(Path::to_string_lossy)
        .map(|c| c.into_owned())
        .ok_or_else(|| "the app's own executable path is unknown".to_owned())?;

    let global_path = dir.join(".claude.json");
    let existing = std::fs::read_to_string(&global_path).ok();
    if let Some(text) = claude_mcp_global_config(existing.as_deref(), folders, &command)? {
        std::fs::write(&global_path, &text)
            .map_err(|e| format!("write {}: {e}", global_path.display()))?;
        // Claude keeps its account and login state in this file; an entry this app
        // creates gets the same at-rest posture Claude's own writer leaves.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&global_path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("restrict {}: {e}", global_path.display()))?;
        }
    }

    let settings_path = dir.join("settings.json");
    let existing = std::fs::read_to_string(&settings_path).ok();
    if let Some(text) = claude_mcp_settings(existing.as_deref(), !folders.is_empty())? {
        std::fs::write(&settings_path, &text)
            .map_err(|e| format!("write {}: {e}", settings_path.display()))?;
    }
    Ok(())
}

/// [`apply_claude_integration`]'s injectable core (the executable path is a test seam):
/// the MCP registration first, then the active provider's environment — two passes over
/// one file, each a no-op when the file already agrees.
fn apply_claude_integration_inner(
    folders: &[String],
    command: Option<&Path>,
) -> Result<(), String> {
    apply_claude_mcp_inner(folders, command)?;
    apply_claude_provider_env_inner()
}

/// What the MCP Server page reports about the automatic Claude integration.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeMcpStatus {
    pub registered: bool,
    pub folder: Option<String>,
    pub command: Option<String>,
}

#[tauri::command]
pub fn claude_mcp_status() -> Result<ClaudeMcpStatus, String> {
    let home = ggs_home()?;
    // What Claude Code actually loads: the registration lives in the redirected
    // global config's user-scope `mcpServers`.
    let path = home.join("claude").join(".claude.json");
    let server = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| {
            json.pointer(&format!("/mcpServers/{CLAUDE_MCP_SERVER_NAME}"))
                .cloned()
        });
    let text_in = |pointer: &str| {
        server
            .as_ref()
            .and_then(|entry| entry.pointer(pointer))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    let command = text_in("/command");
    // The repository rides the args as the value after `--mcp`.
    let folder = server
        .as_ref()
        .and_then(|entry| entry.pointer("/args"))
        .and_then(serde_json::Value::as_array)
        .and_then(|args| {
            args.iter()
                .zip(args.iter().skip(1))
                .find(|(flag, _)| flag.as_str() == Some("--mcp"))
                .and_then(|(_, value)| value.as_str())
                .map(str::to_owned)
        });
    Ok(ClaudeMcpStatus {
        registered: command.is_some(),
        folder,
        command,
    })
}

/* ---------- The tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Serializes every TEST_HOME manipulation (pins and unpins alike): cargo runs a
    /// module's tests in parallel, and a home swap must never interleave with another
    /// test's resolution. Not reentrant — never nest two guards.
    static TEST_SERIAL: Mutex<()> = Mutex::new(());

    /// One test's isolated `~/.ggs`: pinned for the guard's lifetime, restored (and the
    /// temp directory cleaned) on drop. Keep the guard in its own binding — a shadowed
    /// guard unpins immediately and the test would touch the developer's real home.
    struct ProviderHome {
        _serial: std::sync::MutexGuard<'static, ()>,
        /// Held (not read) for the guard's lifetime: dropping it cleans the temp dir.
        _dir: tempfile::TempDir,
        previous: Option<PathBuf>,
    }

    impl ProviderHome {
        fn pin() -> Self {
            let serial = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
            let previous = TEST_HOME.lock().unwrap().clone();
            let dir = tempfile::tempdir().unwrap();
            *TEST_HOME.lock().unwrap() = Some(dir.path().to_path_buf());
            ProviderHome {
                _serial: serial,
                _dir: dir,
                previous,
            }
        }
    }

    impl Drop for ProviderHome {
        fn drop(&mut self) {
            *TEST_HOME.lock().unwrap() = self.previous.take();
        }
    }

    /// The leak this module once had: a lib-level test that drives a whole folder flow
    /// reaches the Claude integration writes without ever pinning a home, so
    /// `ggs_home()` resolved the developer's real `~/.ggs` — and stamped the test
    /// binary plus a scratch folder into `mcpServers.ggs`, leaving Claude's `/mcp`
    /// with a server that cannot start. Unpinned, the home must be the throwaway.
    #[test]
    fn an_unpinned_test_resolves_a_throwaway_home_not_the_developer_one() {
        struct Unpinned {
            _serial: std::sync::MutexGuard<'static, ()>,
            previous: Option<PathBuf>,
        }
        impl Drop for Unpinned {
            fn drop(&mut self) {
                *TEST_HOME.lock().unwrap() = self.previous.take();
            }
        }
        let serial = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let previous = TEST_HOME.lock().unwrap().clone();
        *TEST_HOME.lock().unwrap() = None;
        let _unpinned = Unpinned {
            _serial: serial,
            previous,
        };
        let home = ggs_home().unwrap();
        assert!(
            home.to_string_lossy().contains("ggs-provider-test-home-"),
            "an unpinned test must land in the throwaway home, got {}",
            home.display()
        );
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
        drop(guard_a);

        // A different install's master key does not open it (sequential, never a
        // nested pin — the homes' serializing lock is not reentrant).
        let guard_b = ProviderHome::pin();
        let home_b = ggs_home().unwrap();
        assert!(unseal(&home_b, &sealed).is_err());
        drop(guard_b);
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
        let env = backend_env_for(CLAUDE_CODE_EXT_ID, &home);
        let map = env_map(&env);
        assert_eq!(map.len(), 1, "official adds no endpoint vars: {env:?}");
        let dir = map["CLAUDE_CONFIG_DIR"];
        assert_eq!(dir, home.join("claude").to_str().unwrap());
        // And nothing at all for an extension the bridge does not serve.
        assert!(backend_env_for("some.other.ext", &home).is_empty());
    }

    /// The active third-party profile's provider environment carries the endpoint, the
    /// decrypted key and the model ids — the values the switch writes into Claude's
    /// settings (the takeover the sandbox probe proves against a local server).
    #[test]
    fn a_third_party_provider_carries_endpoint_key_and_models() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        let mut store = third_party_store();
        store.profiles[1].api_key_enc = Some(seal(&home, "sk-live-key").unwrap());
        store.profiles[1].api_key_hint = Some("-key".to_owned());
        let active = store.profiles[1].clone();
        let env = provider_env_vars(&active, &home);
        let map = env_map(&env);
        assert_eq!(
            map["ANTHROPIC_BASE_URL"],
            "https://api.deepseek.com/anthropic"
        );
        assert_eq!(map["ANTHROPIC_AUTH_TOKEN"], "sk-live-key");
        assert_eq!(map["ANTHROPIC_API_KEY"], "sk-live-key");
        assert_eq!(map["ANTHROPIC_MODEL"], "deepseek-chat");
        assert_eq!(map["ANTHROPIC_SMALL_FAST_MODEL"], "deepseek-chat");
        assert_eq!(map["ANTHROPIC_DEFAULT_OPUS_MODEL"], "deepseek-chat");
        assert_eq!(map["ANTHROPIC_DEFAULT_FABLE_MODEL"], "deepseek-chat");
        assert_eq!(map["ANTHROPIC_DEFAULT_SONNET_MODEL"], "deepseek-chat");
        assert_eq!(map["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "deepseek-chat");
        assert_eq!(map.len(), 9, "{env:?}");
        // The official profile carries none of them — its keys must leave the settings
        // so the user's own login is never shadowed.
        assert!(provider_env_vars(&official_profile(), &home).is_empty());
        // And the spawn environment stays the config redirect alone (one source of
        // provider truth: the settings file).
        let spawn = backend_env_for(CLAUDE_CODE_EXT_ID, &home);
        assert_eq!(env_map(&spawn).len(), 1, "{spawn:?}");
    }

    /// The tier-alias remap: Claude Code's /model picker resolves opus / fable /
    /// sonnet / haiku through `ANTHROPIC_DEFAULT_*_MODEL`, and without the remap a
    /// tier pick sends a `claude-*` id to the provider's endpoint — the display then
    /// names Claude models the provider does not serve. The flagship tiers (opus,
    /// fable) take the main model, the everyday tiers the small one (GLM: opus and
    /// fable → glm-5.3, sonnet and haiku → glm-5.3-flash); a profile with no small
    /// model falls the everyday tiers back to the main one.
    #[test]
    fn the_tier_aliases_remap_to_the_providers_own_models() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        let store = seeded_store();
        let glm = store
            .profiles
            .iter()
            .find(|p| p.id == "glm")
            .unwrap()
            .clone();
        let glm_env = provider_env_vars(&glm, &home);
        let map = env_map(&glm_env);
        assert_eq!(map["ANTHROPIC_DEFAULT_OPUS_MODEL"], "glm-5.3");
        assert_eq!(map["ANTHROPIC_DEFAULT_FABLE_MODEL"], "glm-5.3");
        assert_eq!(map["ANTHROPIC_DEFAULT_SONNET_MODEL"], "glm-5.3-flash");
        assert_eq!(map["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "glm-5.3-flash");
        assert!(
            !map.values().any(|value| value.starts_with("claude-")),
            "no tier resolves to a Claude model id: {map:?}"
        );

        // No small model configured: every tier falls back to the main one.
        let mut no_small = glm.clone();
        no_small.small_model = None;
        let no_small_env = provider_env_vars(&no_small, &home);
        let map = env_map(&no_small_env);
        assert_eq!(map["ANTHROPIC_DEFAULT_FABLE_MODEL"], "glm-5.3");
        assert_eq!(map["ANTHROPIC_DEFAULT_SONNET_MODEL"], "glm-5.3");
        assert_eq!(map["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "glm-5.3");

        // No model configured at all: nothing to remap to, so no tier keys.
        let mut bare = glm.clone();
        bare.model = None;
        bare.small_model = None;
        let bare_env = provider_env_vars(&bare, &home);
        assert!(
            !bare_env
                .iter()
                .any(|(key, _)| key.starts_with("ANTHROPIC_DEFAULT")),
            "{bare_env:?}"
        );
    }

    /// A key sealed under another install's master key is skipped, not fatal: the
    /// endpoint vars still apply, the key vars are absent.
    #[test]
    fn a_key_from_another_install_is_skipped_not_fatal() {
        let guard_a = ProviderHome::pin();
        let sealed_elsewhere = seal(&ggs_home().unwrap(), "sk-elsewhere").unwrap();
        drop(guard_a);

        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        let mut profile = deepseek_profile();
        profile.api_key_enc = Some(sealed_elsewhere);
        let env = provider_env_vars(&profile, &home);
        let map = env_map(&env);
        assert_eq!(
            map.get("ANTHROPIC_BASE_URL").copied(),
            Some("https://api.deepseek.com/anthropic")
        );
        assert!(!map.contains_key("ANTHROPIC_AUTH_TOKEN"));
        assert!(!map.contains_key("ANTHROPIC_API_KEY"));
    }

    /// The switch's write path: a third-party profile lands its env in Claude's
    /// settings, the official one removes exactly this bridge's keys (a stale endpoint
    /// would shadow the login), the user's own env keys survive, an unchanged file is
    /// a no-op, and an unparseable one is failed on. The top-level `model` pin rides
    /// the same takeover: the active profile's model while third-party, cleared back
    /// to nothing when official — the user's own `claude-*` / tier-alias pin survives.
    #[test]
    fn claude_provider_settings_merges_clears_and_preserves() {
        let third_party = vec![
            (
                "ANTHROPIC_BASE_URL".to_owned(),
                "https://api.deepseek.com/anthropic".to_owned(),
            ),
            ("ANTHROPIC_AUTH_TOKEN".to_owned(), "sk-live".to_owned()),
            ("ANTHROPIC_MODEL".to_owned(), "deepseek-chat".to_owned()),
        ];
        let written = claude_provider_settings(
            Some(r#"{"model": "claude-fable-5-1[1m]", "env": {"MY_VAR": "keep-me", "ANTHROPIC_BASE_URL": "https://stale", "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5", "ANTHROPIC_DEFAULT_FABLE_MODEL": "claude-fable-5-1"}}"#),
            &third_party,
        )
        .unwrap()
        .unwrap();
        let json: serde_json::Value = serde_json::from_str(&written).unwrap();
        // The `/model` pin a tier pick left behind is rewritten onto the active
        // provider's model — it outranks the env for what the chat shows and sends,
        // so `claude-fable-5-1[1m]` would have been displayed and sent on DeepSeek.
        assert_eq!(
            json.pointer("/model").and_then(|v| v.as_str()),
            Some("deepseek-chat"),
            "{json}"
        );
        assert_eq!(
            json.pointer("/env/MY_VAR").and_then(|v| v.as_str()),
            Some("keep-me")
        );
        // A tier key another tool left behind is replaced wholesale with this bridge's
        // set (the hand-made env here carries none), never merged beside it.
        assert!(
            json.pointer("/env/ANTHROPIC_DEFAULT_SONNET_MODEL")
                .is_none(),
            "{json}"
        );
        assert!(
            json.pointer("/env/ANTHROPIC_DEFAULT_FABLE_MODEL").is_none(),
            "{json}"
        );
        assert_eq!(
            json.pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(|v| v.as_str()),
            Some("https://api.deepseek.com/anthropic")
        );
        assert_eq!(
            json.pointer("/env/ANTHROPIC_AUTH_TOKEN")
                .and_then(|v| v.as_str()),
            Some("sk-live")
        );

        // Applying the same env again is a no-op; switching to official clears only
        // this bridge's keys.
        assert_eq!(
            claude_provider_settings(Some(&written), &third_party).unwrap(),
            None
        );
        let cleared = claude_provider_settings(Some(&written), &[])
            .unwrap()
            .unwrap();
        let json: serde_json::Value = serde_json::from_str(&cleared).unwrap();
        assert_eq!(
            json.pointer("/env/MY_VAR").and_then(|v| v.as_str()),
            Some("keep-me")
        );
        assert!(json.pointer("/env/ANTHROPIC_BASE_URL").is_none());
        // Back on the official service the pin this bridge wrote is cleared with the
        // env keys — a stale `deepseek-chat` would shadow the login the same way.
        assert!(json.pointer("/model").is_none(), "{json}");

        // The user's own pins are never touched on official: a `claude-*` id from the
        // tier list, and a bare tier alias with its context suffix — fable included,
        // the newest tier, whose bare alias is only recognized as Claude's own because
        // the takeover's alias table names it. (The answer can differ from a
        // hand-written input's whitespace alone — compare the JSON.)
        for pin in ["claude-fable-5-1[1m]", "fable[1m]", "sonnet[1m]"] {
            let existing = format!(r#"{{"model": "{pin}"}}"#);
            let answer = claude_provider_settings(Some(&existing), &[]).unwrap();
            let text = answer.as_deref().unwrap_or(&existing);
            let json: serde_json::Value = serde_json::from_str(text).unwrap();
            assert_eq!(json.pointer("/model").and_then(|v| v.as_str()), Some(pin));
        }
        // A gateway profile that pins no model leaves the pin alone too — the id the
        // user pinned is routing metadata for the gateway itself.
        let gateway = vec![(
            "ANTHROPIC_BASE_URL".to_owned(),
            "https://gw.example.com".to_owned(),
        )];
        let routed = claude_provider_settings(Some(r#"{"model": "claude-sonnet-4-5"}"#), &gateway)
            .unwrap()
            .unwrap();
        let json: serde_json::Value = serde_json::from_str(&routed).unwrap();
        assert_eq!(
            json.pointer("/model").and_then(|v| v.as_str()),
            Some("claude-sonnet-4-5"),
            "{json}"
        );

        assert!(claude_provider_settings(Some("{not json"), &third_party).is_err());
    }

    /// The switch's IO: activate writes the third-party env into the redirected
    /// settings (0600 — it carries the plaintext key, Claude Code's own configuration
    /// format), and switching back to official clears the keys again.
    #[test]
    fn the_provider_switch_writes_and_clears_the_settings_env() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        let mut store = third_party_store();
        store.profiles[1].api_key_enc = Some(seal(&home, "sk-live-key").unwrap());
        let path = home.join("claude").join("settings.json");

        let active = store.profiles[1].clone();
        let env = provider_env_vars(&active, &home);
        let text = claude_provider_settings(None, &env).unwrap().unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &text).unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            json.pointer("/env/ANTHROPIC_AUTH_TOKEN")
                .and_then(|v| v.as_str()),
            Some("sk-live-key")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    /// The switch's gate: a real switch reports the settings env changed (the tail that
    /// rewrites Claude's redirected settings) and the store visibly changed (the push the
    /// windows' chips re-read); a label-only edit is cosmetic; the no-op re-activate is
    /// neither. The gate compares the active profile's provider env — never the spawn
    /// env, which is the constant config redirect and once made every switch a silent
    /// no-op (the settings kept the previous provider, new chats never moved).
    #[test]
    fn the_switch_gate_fires_on_provider_env_changes_only() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        let mut store = third_party_store();
        store.active_id = Some("official".to_owned());
        store.profiles[1].api_key_enc = Some(seal(&home, "sk-live-key").unwrap());

        // official → deepseek: both the settings env and the store changed.
        let before = store.clone();
        set_active(&mut store, "deepseek").unwrap();
        let change = provider_change(&before, &store, &home);
        assert!(change.env_changed && change.store_changed);

        // The no-op re-activate: neither.
        let before = store.clone();
        set_active(&mut store, "deepseek").unwrap();
        assert_eq!(
            provider_change(&before, &store, &home),
            ProviderChange {
                env_changed: false,
                store_changed: false
            }
        );

        // A label-only edit of the active profile: the chips' list re-reads, the
        // settings do not.
        let before = store.clone();
        store.profiles[1].label = "DeepSeek (team)".to_owned();
        let change = provider_change(&before, &store, &home);
        assert!(!change.env_changed && change.store_changed);

        // deepseek → official: the env changes again — this bridge's keys must leave
        // the settings or the stale endpoint would shadow the login.
        let before = store.clone();
        set_active(&mut store, "official").unwrap();
        assert!(provider_change(&before, &store, &home).env_changed);
    }

    /// The tail the gate drives, end to end: switch the store, write it, run the apply
    /// the gate asks for — and the redirected Claude settings carry the new provider for
    /// the next session (exactly the path that was dead while the gate compared the
    /// constant spawn env: the chip said GLM, the chat still ran where it always had).
    #[test]
    fn a_switched_store_lands_in_the_claude_settings_for_the_next_session() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        let mut store = third_party_store();
        store.active_id = Some("official".to_owned());
        store.profiles[1].api_key_enc = Some(seal(&home, "sk-live-key").unwrap());
        // A `/model` pin from an official-era session: Claude Code persists the tier
        // pick into the settings' top level, where it outranks the env this switch is
        // about to write — the takeover must rewrite it onto the provider's model.
        let claude_dir = home.join("claude");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(
            claude_dir.join("settings.json"),
            r#"{"model": "claude-fable-5-1[1m]"}"#,
        )
        .unwrap();
        let before = store.clone();
        set_active(&mut store, "deepseek").unwrap();
        write_store(&home, &store).unwrap();
        if provider_change(&before, &store, &home).env_changed {
            apply_claude_provider_env();
        }
        let json: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(home.join("claude").join("settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            json.pointer("/model").and_then(|v| v.as_str()),
            Some("deepseek-chat"),
            "{json}"
        );
        assert_eq!(
            json.pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(|v| v.as_str()),
            Some("https://api.deepseek.com/anthropic")
        );
        assert_eq!(
            json.pointer("/env/ANTHROPIC_AUTH_TOKEN")
                .and_then(|v| v.as_str()),
            Some("sk-live-key")
        );
        assert_eq!(
            json.pointer("/env/ANTHROPIC_MODEL")
                .and_then(|v| v.as_str()),
            Some("deepseek-chat")
        );
        assert_eq!(
            json.pointer("/env/ANTHROPIC_DEFAULT_OPUS_MODEL")
                .and_then(|v| v.as_str()),
            Some("deepseek-chat")
        );
        assert_eq!(
            json.pointer("/env/ANTHROPIC_DEFAULT_FABLE_MODEL")
                .and_then(|v| v.as_str()),
            Some("deepseek-chat")
        );
        assert_eq!(
            json.pointer("/env/ANTHROPIC_DEFAULT_HAIKU_MODEL")
                .and_then(|v| v.as_str()),
            Some("deepseek-chat")
        );
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
        let saved = store
            .profiles
            .iter()
            .find(|p| p.id == "deepseek")
            .unwrap()
            .clone();
        assert_eq!(saved.api_key_hint.as_deref(), Some("-key"));
        // The trailing slash is normalized at save.
        assert_eq!(
            saved.base_url.as_deref(),
            Some("https://api.deepseek.com/anthropic")
        );

        // Absent apiKey keeps the sealed key through a label-only edit.
        let mut relabel = input.clone();
        relabel.api_key = None;
        relabel.label = "DeepSeek (team)".to_owned();
        let mut store2 = store.clone();
        apply_save(&home, &mut store2, &relabel).unwrap();
        assert_eq!(
            store2
                .profiles
                .iter()
                .find(|p| p.id == "deepseek")
                .unwrap()
                .api_key_enc,
            saved.api_key_enc
        );

        // Empty apiKey clears it.
        let mut cleared = relabel.clone();
        cleared.api_key = Some(String::new());
        apply_save(&home, &mut store2, &cleared).unwrap();
        assert!(store2
            .profiles
            .iter()
            .find(|p| p.id == "deepseek")
            .unwrap()
            .api_key_enc
            .is_none());

        write_store(&home, &store).unwrap();
        let text = std::fs::read_to_string(store_path(&home)).unwrap();
        assert!(
            !text.contains("sk-first-key"),
            "the plaintext key must never land in the file"
        );
        assert!(
            text.contains("apiKeyEnc"),
            "the sealed key rides its own field: {text}"
        );
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
        assert!(
            profile.base_url.is_none() && profile.model.is_none() && profile.api_key_enc.is_none()
        );

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

    /// The IPC boundary never carries a secret: a store whose profiles hold sealed
    /// keys answers `hasKey` flags and hints, and the serialized answer contains
    /// neither the plaintext nor the ciphertext.
    #[test]
    fn the_list_answer_never_carries_a_key_in_any_form() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        let mut store = third_party_store();
        store.profiles[1].api_key_enc = Some(seal(&home, "sk-live-key").unwrap());
        let answer = list_answer(&store);
        let json = serde_json::to_string(&answer).unwrap();
        assert!(
            !json.contains("sk-live-key"),
            "the plaintext leaked: {json}"
        );
        assert!(
            !json.contains("apiKeyEnc") && !json.contains("api_key_enc"),
            "the ciphertext leaked: {json}"
        );
        let deepseek = answer.profiles.iter().find(|p| p.id == "deepseek").unwrap();
        assert!(deepseek.has_key, "the UI still needs to know a key exists");
    }

    /// An unknown preset is rejected — the preset is the profile's shape, and an
    /// unknown shape has no validation rules to apply.
    #[test]
    fn an_unknown_preset_is_rejected() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        let mut store = seeded_store();
        let input = ProviderInput {
            id: "x".to_owned(),
            preset: "no-such-preset".to_owned(),
            label: "X".to_owned(),
            base_url: Some("https://ok.example".to_owned()),
            model: None,
            small_model: None,
            api_key: None,
        };
        assert!(apply_save(&home, &mut store, &input).is_err());
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
        // The seeded GLM profile rides the preset's current model head — the pick list
        // a fresh install offers is the provider's present lineup, not history.
        let glm = store
            .profiles
            .iter()
            .find(|p| p.id == "glm")
            .expect("the glm profile is seeded");
        assert_eq!(glm.model.as_deref(), Some("glm-5.3"));
        assert_eq!(glm.small_model.as_deref(), Some("glm-5.3-flash"));
        // The other seeded third-party profiles ride their preset's current head too
        // (the 2026-09 lineups) — the tier remap then points every provider's flagship
        // tier at its flagship model and the everyday tiers at its fast one.
        let deepseek = store
            .profiles
            .iter()
            .find(|p| p.id == "deepseek")
            .expect("the deepseek profile is seeded");
        assert_eq!(deepseek.model.as_deref(), Some("deepseek-v4-pro"));
        assert_eq!(deepseek.small_model.as_deref(), Some("deepseek-flash"));
        let kimi = store
            .profiles
            .iter()
            .find(|p| p.id == "kimi")
            .expect("the kimi profile is seeded");
        assert_eq!(kimi.model.as_deref(), Some("kimi-k3"));
        assert_eq!(
            kimi.small_model.as_deref(),
            Some("kimi-k2.7-code-highspeed")
        );
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

    /* ---------- The gateway probes ---------- */

    /// One loopback HTTP answer for the gateway probes: the server reads until the
    /// request goes quiet, replies with the canned bytes, and hands back what it saw.
    fn serve(response: String) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_millis(300)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => request.extend_from_slice(&chunk[..n]),
                }
            }
            let _ = stream.write_all(response.as_bytes());
            String::from_utf8_lossy(&request).into_owned()
        });
        (url, handle)
    }

    fn http_response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// The model catalogue comes off the gateway with the key, ids deduplicated in the
    /// gateway's order; a rejection is a readable error, not an empty list.
    #[test]
    fn fetch_gateway_models_reads_the_catalogue_with_the_key() {
        let (url, server) = serve(http_response(
            "200 OK",
            r#"{"data":[{"id":"glm-4.6"},{"id":"claude-sonnet-4-5"},{"id":"glm-4.6"}]}"#,
        ));
        let models = fetch_gateway_models(&url, "sk-gw-key").unwrap();
        let request = server.join().unwrap();
        assert_eq!(models, vec!["glm-4.6", "claude-sonnet-4-5"]);
        assert!(request.contains("GET /v1/models"), "{request}");
        // ureq spells its header names lowercase; the value's case is the scheme's own.
        let lowered = request.to_lowercase();
        assert!(
            lowered.contains("authorization: bearer sk-gw-key"),
            "{request}"
        );

        let (url, server) = serve(http_response("401 Unauthorized", r#"{"error":"bad key"}"#));
        let error = fetch_gateway_models(&url, "sk-wrong").unwrap_err();
        server.join().unwrap();
        assert!(error.contains("rejected"), "{error}");
    }

    /// The probe maps outcomes: a 200 is reachable, a 401 is a key diagnosis with the
    /// round-trip time still reported, and a dead endpoint is an error.
    #[test]
    fn the_connection_probe_diagnoses_reachability_and_rejection() {
        let (url, server) = serve(http_response(
            "200 OK",
            r#"{"content":[{"type":"text","text":"hi"}]}"#,
        ));
        let report = test_gateway_connection(&url, "sk-live", "glm-4.6").unwrap();
        let request = server.join().unwrap();
        assert!(report.ok && report.status == 200 && report.message.contains("reachable"));
        assert!(request.contains("POST /v1/messages"), "{request}");
        assert!(
            request.contains("anthropic-version: 2023-06-01"),
            "{request}"
        );
        assert!(request.contains(r#""model":"glm-4.6""#), "{request}");

        let (url, server) = serve(http_response(
            "401 Unauthorized",
            r#"{"error":{"type":"authentication_error"}}"#,
        ));
        let report = test_gateway_connection(&url, "sk-wrong", "").unwrap();
        server.join().unwrap();
        assert!(!report.ok && report.status == 401);
        assert!(report.message.contains("rejected"), "{}", report.message);

        // A port nobody listens on: the transport failure is the error half.
        let error = test_gateway_connection("http://127.0.0.1:1", "k", "m").unwrap_err();
        assert!(error.contains("could not reach"), "{error}");
    }

    /// A base URL without its scheme is refused before any request is made.
    #[test]
    fn the_gateway_probes_validate_the_base_url_shape() {
        assert!(fetch_gateway_models("my-gateway.example", "k").is_err());
        assert!(test_gateway_connection("ftp://nope", "k", "m").is_err());
    }

    /* ---------- The cc-switch import ---------- */

    fn write_ccswitch_fixtures(home: &Path) {
        std::fs::create_dir_all(home.join(".cc-switch")).unwrap();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        // The map shape (id → entry) with `claude.current` naming the active one.
        std::fs::write(
            ccswitch_config_path(home),
            r#"{
  "claude": {
    "current": "deepseek-official",
    "providers": {
      "deepseek-official": {
        "name": "DeepSeek 官方",
        "settingsConfig": { "env": {
          "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
          "ANTHROPIC_AUTH_TOKEN": "sk-cc-deepseek"
        }}
      },
      "newapi-gw": {
        "name": "My NewAPI",
        "env": {
          "ANTHROPIC_BASE_URL": "https://gw.example.com",
          "ANTHROPIC_AUTH_TOKEN": "sk-cc-gw",
          "ANTHROPIC_MODEL": "glm-4.6"
        }
      },
      "empty-entry": { "name": "sign-in only", "env": {} }
    }
  }
}"#,
        )
        .unwrap();
        // The live configuration: what the machine's Claude Code runs on right now —
        // the same provider cc-switch's `current` names (how a switched machine looks).
        std::fs::write(
            claude_settings_path(home),
            r#"{"env": {"ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic", "ANTHROPIC_AUTH_TOKEN": "sk-cc-deepseek"}}"#,
        )
        .unwrap();
    }

    /// The scan reads cc-switch's list and the live Claude configuration, strips the
    /// keys, marks what is current, and folds the duplicate (the live config being the
    /// same NewAPI gateway cc-switch points at).
    #[test]
    fn the_scan_answers_candidates_without_keys_and_marks_the_current_one() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        write_ccswitch_fixtures(&home);
        let candidates = scan_ccswitch_candidates(&home);
        let json = serde_json::to_string(&candidates).unwrap();
        assert!(!json.contains("sk-cc-"), "a key leaked in the scan: {json}");

        assert_eq!(candidates.len(), 2, "{candidates:?}");
        let deepseek = candidates
            .iter()
            .find(|c| c.label == "DeepSeek 官方")
            .unwrap();
        assert!(
            deepseek.has_key && deepseek.current && deepseek.source == "cc-switch",
            "current names it in cc-switch AND the live config folds into it: {candidates:?}"
        );
        let gateway = candidates.iter().find(|c| c.label == "My NewAPI").unwrap();
        assert_eq!(gateway.model.as_deref(), Some("glm-4.6"));
        assert!(!gateway.current);
        assert!(
            candidates.iter().all(|c| c.label != "sign-in only"),
            "an env-less entry configures nothing"
        );
    }

    /// Neither configuration present: an empty answer, never an error.
    #[test]
    fn the_scan_answers_empty_without_any_configuration() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        assert!(scan_ccswitch_candidates(&home).is_empty());
    }

    /// The import seals the candidates' keys into the store, replaces same-id profiles
    /// forward-only, and activates the one cc-switch points at — so the bridge takes
    /// over exactly the configuration the machine already runs on.
    #[test]
    fn the_import_seals_keys_and_activates_the_current_configuration() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        write_ccswitch_fixtures(&home);
        let mut store = seeded_store();

        let candidates = scan_ccswitch_candidates(&home);
        let names: Vec<String> = candidates.iter().map(|c| c.id.clone()).collect();
        let (imported, activate) = import_ccswitch_entries(&home, &mut store, &names).unwrap();
        assert_eq!(imported, 2, "{candidates:?}");
        assert_eq!(
            activate.as_deref(),
            Some(candidates.iter().find(|c| c.current).unwrap().id.as_str())
        );
        set_active(&mut store, &activate.unwrap()).unwrap();

        let profile = store
            .profiles
            .iter()
            .find(|p| p.label == "DeepSeek 官方")
            .expect("the imported profile is in the store");
        let sealed = profile.api_key_enc.as_deref().expect("the key was sealed");
        assert_eq!(unseal(&home, sealed).unwrap(), "sk-cc-deepseek");
        // The imported current one drives the provider environment now (the settings
        // writer's source); the spawn environment stays the config redirect alone.
        let env = provider_env_vars(profile, &home);
        let map = env_map(&env);
        assert_eq!(
            map["ANTHROPIC_BASE_URL"],
            "https://api.deepseek.com/anthropic"
        );
        assert_eq!(map["ANTHROPIC_AUTH_TOKEN"], "sk-cc-deepseek");
        assert_eq!(
            env_map(&backend_env_for(CLAUDE_CODE_EXT_ID, &home)).len(),
            1
        );

        // Unknown names are skipped, an empty import answers zero.
        let (imported, _) =
            import_ccswitch_entries(&home, &mut store, &["no-such".to_owned()]).unwrap();
        assert_eq!(imported, 0);
    }

    /* ---------- The Claude MCP registration ---------- */

    const COMMAND: &str = "/opt/ggs/ggs";

    /// The registration composes into whatever else Claude's global config carries:
    /// its own state keys (login, account) and other MCP servers survive untouched.
    #[test]
    fn the_registration_composes_into_the_claude_global_config() {
        let existing = r#"{
  "userID": "u-123",
  "oauthAccount": { "emailAddress": "dev@example.com" },
  "mcpServers": { "other": { "command": "other-srv" } }
}"#;
        let text = claude_mcp_global_config(Some(existing), &["/repo".to_owned()], COMMAND)
            .unwrap()
            .unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            json.pointer("/userID").and_then(|v| v.as_str()),
            Some("u-123")
        );
        assert_eq!(
            json.pointer("/oauthAccount/emailAddress")
                .and_then(|v| v.as_str()),
            Some("dev@example.com")
        );
        assert_eq!(
            json.pointer("/mcpServers/other/command")
                .and_then(|v| v.as_str()),
            Some("other-srv")
        );
        // The entry `claude mcp add --scope user` would write — stdio typed.
        assert_eq!(
            json.pointer("/mcpServers/ggs/type")
                .and_then(|v| v.as_str()),
            Some("stdio")
        );
        assert_eq!(
            json.pointer("/mcpServers/ggs/command")
                .and_then(|v| v.as_str()),
            Some(COMMAND)
        );
        assert_eq!(
            json.pointer("/mcpServers/ggs/args/0")
                .and_then(|v| v.as_str()),
            Some("--mcp")
        );
        assert_eq!(
            json.pointer("/mcpServers/ggs/args/1")
                .and_then(|v| v.as_str()),
            Some("/repo")
        );
        assert_eq!(
            json.pointer("/mcpServers/ggs/env")
                .and_then(|v| v.as_object()),
            Some(&serde_json::Map::new())
        );
    }

    /// Applying the same registration twice is a no-op (None — Claude's own file is
    /// not rewritten), and a folder change or a moved executable replaces our entry,
    /// still leaving the rest of the file alone.
    #[test]
    fn re_applying_the_same_registration_is_a_no_op_and_a_change_replaces_it() {
        let first = claude_mcp_global_config(None, &["/repo".to_owned()], COMMAND)
            .unwrap()
            .unwrap();
        assert_eq!(
            claude_mcp_global_config(Some(&first), &["/repo".to_owned()], COMMAND).unwrap(),
            None
        );
        // A different folder, a different binary: rewritten.
        let second = claude_mcp_global_config(Some(&first), &["/other".to_owned()], COMMAND)
            .unwrap()
            .unwrap();
        assert_ne!(first, second);
        let json: serde_json::Value = serde_json::from_str(&second).unwrap();
        assert_eq!(
            json.pointer("/mcpServers/ggs/args/1")
                .and_then(|v| v.as_str()),
            Some("/other")
        );
        let third =
            claude_mcp_global_config(Some(&second), &["/other".to_owned()], "/new/place/ggs")
                .unwrap()
                .unwrap();
        let json: serde_json::Value = serde_json::from_str(&third).unwrap();
        assert_eq!(
            json.pointer("/mcpServers/ggs/command")
                .and_then(|v| v.as_str()),
            Some("/new/place/ggs")
        );
    }

    /// With no folder open the GGS entry goes away — a repo-scoped server makes no
    /// sense without a repository — and other servers survive; when ours was the only
    /// one, the empty mcpServers map goes with it. A file that never had our entry is
    /// a no-op (None), not a rewrite.
    #[test]
    fn closing_the_folder_unregisters_the_server_and_cleans_up() {
        // Ours plus another server: ours goes, theirs stays.
        let ours_and_other = claude_mcp_global_config(
            Some(r#"{"mcpServers":{"other":{"command":"x"}}}"#),
            &["/repo".to_owned()],
            COMMAND,
        )
        .unwrap()
        .unwrap();
        let cleaned = claude_mcp_global_config(Some(&ours_and_other), &[], COMMAND)
            .unwrap()
            .unwrap();
        let json: serde_json::Value = serde_json::from_str(&cleaned).unwrap();
        assert!(json.pointer("/mcpServers/ggs").is_none());
        assert!(json.pointer("/mcpServers/other").is_some());

        // Ours was the only server: the empty mcpServers map goes with it.
        let alone = claude_mcp_global_config(None, &["/repo".to_owned()], COMMAND)
            .unwrap()
            .unwrap();
        let cleaned = claude_mcp_global_config(Some(&alone), &[], COMMAND)
            .unwrap()
            .unwrap();
        let json: serde_json::Value = serde_json::from_str(&cleaned).unwrap();
        assert!(json.get("mcpServers").is_none(), "{json}");

        // Nothing of ours in the file at all: still a no-op.
        assert_eq!(
            claude_mcp_global_config(Some("{}"), &[], COMMAND).unwrap(),
            None
        );
    }

    /// A configuration file we cannot parse is failed on, never replaced — it is
    /// Claude's own configuration, and a registration is not worth destroying state
    /// over. Both halves of the apply carry the posture.
    #[test]
    fn an_unparseable_configuration_file_is_failed_on_not_replaced() {
        assert!(
            claude_mcp_global_config(Some("{not json"), &["/repo".to_owned()], COMMAND).is_err()
        );
        assert!(claude_mcp_global_config(Some("[1,2]"), &["/repo".to_owned()], COMMAND).is_err());
        assert!(claude_mcp_settings(Some("{not json"), true).is_err());
        assert!(claude_mcp_settings(Some("[1,2]"), true).is_err());
        assert!(claude_mcp_settings(Some(r#"{"permissions":"nope"}"#), true).is_err());
        assert!(claude_mcp_settings(Some(r#"{"permissions":{"allow":"nope"}}"#), true).is_err());
    }

    /// The settings-side pass: an open folder adds the `mcp__ggs` auto-allow rule
    /// beside the user's own rules (a session never prompts for an analysis read),
    /// closing the folder takes it back out, and the `mcpServers.ggs` entry the first
    /// cut of this bridge mistakenly wrote into settings.json — a key whose schema
    /// Claude Code never read — is retired wherever it is found.
    #[test]
    fn the_settings_pass_allows_the_tools_and_retires_the_old_entry() {
        let stale = r#"{
  "env": { "ANTHROPIC_BASE_URL": "https://gw.example.com" },
  "mcpServers": { "ggs": { "command": "x" }, "other": { "command": "y" } },
  "permissions": { "allow": ["Bash(ls:*)"], "deny": ["Read(.env)"] }
}"#;
        let text = claude_mcp_settings(Some(stale), true).unwrap().unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            json.pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(|v| v.as_str()),
            Some("https://gw.example.com")
        );
        assert!(json.pointer("/mcpServers/ggs").is_none(), "{json}");
        assert!(json.pointer("/mcpServers/other").is_some());
        assert_eq!(
            json.pointer("/permissions/deny/0").and_then(|v| v.as_str()),
            Some("Read(.env)")
        );
        let allow: Vec<&str> = json
            .pointer("/permissions/allow")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(allow.contains(&"Bash(ls:*)"));
        assert!(allow.contains(&"mcp__ggs"));

        // The agreeing file is a no-op; closing the folder takes our rule with it,
        // the user's own rules and no empty scaffolding staying behind.
        assert_eq!(claude_mcp_settings(Some(&text), true).unwrap(), None);
        let closed = claude_mcp_settings(Some(&text), false).unwrap().unwrap();
        let json: serde_json::Value = serde_json::from_str(&closed).unwrap();
        let allow: Vec<&str> = json
            .pointer("/permissions/allow")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(!allow.contains(&"mcp__ggs"));
        assert_eq!(allow, ["Bash(ls:*)"]);

        // A fresh install (no settings at all) carries the rule alone, and a closed
        // folder with nothing of ours anywhere writes nothing.
        let fresh = claude_mcp_settings(None, true).unwrap().unwrap();
        let json: serde_json::Value = serde_json::from_str(&fresh).unwrap();
        assert_eq!(
            json.pointer("/permissions/allow/0")
                .and_then(|v| v.as_str()),
            Some("mcp__ggs")
        );
        assert_eq!(claude_mcp_settings(Some("{}"), false).unwrap(), None);
    }

    /// The IO path end to end against the pinned home: boot writes the registration
    /// into the redirected global config (where Claude Code actually reads it —
    /// Claude's own state keys surviving the merge, the file kept 0600) plus the
    /// settings-side auto-allow rule, an open-folder change updates it, close removes
    /// both again, and the status command reads back what Claude will see.
    #[test]
    fn the_apply_status_round_trip_tracks_the_open_folder() {
        let _guard = ProviderHome::pin();
        let home = ggs_home().unwrap();
        let exe = home.join("app").join("ggs");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        let command = exe.to_str().unwrap();

        apply_claude_mcp_inner(&["/repo".to_owned()], Some(Path::new(command))).unwrap();
        let status = claude_mcp_status().unwrap();
        assert!(status.registered);
        assert_eq!(status.folder.as_deref(), Some("/repo"));
        assert_eq!(status.command.as_deref(), Some(command));

        // The registration is in the global config — the user-scope mcpServers — and
        // the file keeps Claude's at-rest posture.
        let global_path = home.join("claude").join(".claude.json");
        let config: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&global_path).unwrap()).unwrap();
        assert_eq!(
            config
                .pointer("/mcpServers/ggs/command")
                .and_then(|v| v.as_str()),
            Some(command)
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&global_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        // A settings.json from the first cut (the entry Claude never read) migrates
        // away, leaving the auto-allow rule behind beside the user's own rules.
        let settings_path = home.join("claude").join("settings.json");
        std::fs::write(
            &settings_path,
            r#"{"mcpServers":{"ggs":{"command":"old"}},"permissions":{"allow":["Bash(ls:*)"]}}"#,
        )
        .unwrap();
        apply_claude_mcp_inner(&["/repo".to_owned()], Some(Path::new(command))).unwrap();
        let settings: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
        assert!(settings.pointer("/mcpServers").is_none(), "{settings}");
        let allow: Vec<&str> = settings
            .pointer("/permissions/allow")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(allow, ["Bash(ls:*)", "mcp__ggs"]);

        apply_claude_mcp_inner(&["/two".to_owned()], Some(Path::new(command))).unwrap();
        assert_eq!(claude_mcp_status().unwrap().folder.as_deref(), Some("/two"));

        apply_claude_mcp_inner(&[], Some(Path::new(command))).unwrap();
        let status = claude_mcp_status().unwrap();
        assert!(!status.registered && status.folder.is_none() && status.command.is_none());
        let config: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&global_path).unwrap()).unwrap();
        assert!(config.get("mcpServers").is_none());
        let settings: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
        assert_eq!(
            settings
                .pointer("/permissions/allow/0")
                .and_then(|v| v.as_str()),
            Some("Bash(ls:*)")
        );
    }
}
