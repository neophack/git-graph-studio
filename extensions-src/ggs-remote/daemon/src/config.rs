//! `~/.ggs/remote/config.json` (docs/ggs-remote-plan.md §7.2): the listener, TLS mode and the
//! service switches. Unknown keys are ignored and missing ones take their defaults, so a
//! config written by an older daemon still loads.

use serde::{Deserialize, Serialize};

use crate::paths::{write_private, Paths};

pub const DEFAULT_PORT: u16 = 47615;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TlsMode {
    #[default]
    SelfSigned,
    Custom,
    None,
}

/// The sandbox's network level (module 19, docs/ggs-remote-plan.md §23): what a sandboxed
/// instance may talk to beyond its own loopback. `intranet` is the private ranges; hosts
/// whose sandbox tier cannot express CIDR rules degrade it to `off` (flagged in the
/// status JSON — `sandbox::plan`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SandboxNetwork {
    Off,
    Intranet,
    #[default]
    Internet,
}

impl SandboxNetwork {
    pub fn as_str(&self) -> &'static str {
        match self {
            SandboxNetwork::Off => "off",
            SandboxNetwork::Intranet => "intranet",
            SandboxNetwork::Internet => "internet",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SandboxConfig {
    /// Remote sessions drive sandboxed instances only when set (the picker hides
    /// desktop windows otherwise; SPAWN opens folders inside the sandbox root).
    pub enabled: bool,
    pub network: SandboxNetwork,
    /// The sandbox root; `<remote root>/sandbox` when unset.
    pub root: Option<String>,
}

impl Default for SandboxConfig {
    fn default() -> SandboxConfig {
        SandboxConfig {
            enabled: false,
            network: SandboxNetwork::Internet,
            root: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TlsConfig {
    pub mode: TlsMode,
    pub cert_path: Option<String>,
    pub key_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub port: u16,
    pub bind: String,
    pub tls: TlsConfig,
    pub mdns: bool,
    pub autostart: bool,
    /// Whether a window the remote side opens also shows on the desktop (§13).
    pub spawn_visible: bool,
    /// The window picker's "open a folder by typing its path" row (2026-10-12, the
    /// owner's direction: the feature stays but can be switched off).
    pub folder_input: bool,
    /// Daemon-spawned invisible instances quit after this many idle minutes (§7.10).
    pub idle_exit_minutes: u64,
    /// Trust `X-Forwarded-*` from loopback peers (a tunnel or reverse proxy ends TLS, §7.4).
    pub trust_proxy: bool,
    pub data_saver_default: bool,
    /// Remote access paused: the public listener answers nothing but a paused page.
    pub paused: bool,
    /// The GGS executable to launch when no instance ever registered (written by the
    /// extension on activation, §7.10).
    pub ggs_exe: Option<String>,
    /// The last launch spec an instance registered with — reused when none is running.
    pub last_launch: Option<crate::control_msg::LaunchSpec>,
    /// The GGS extension's install directory (written by `ggs-remote install`): once it has
    /// been gone for a day the extension was uninstalled, and the daemon retires (§14.2).
    pub extension_dir: Option<String>,
    pub extension_missing_since: Option<u64>,
    /// The security sandbox (§23): remote-opened instances run OS-sandboxed.
    pub sandbox: SandboxConfig,
}

impl Default for Config {
    fn default() -> Config {
        Config {
            port: DEFAULT_PORT,
            bind: "0.0.0.0".into(),
            tls: TlsConfig::default(),
            mdns: true,
            autostart: true,
            spawn_visible: false,
            folder_input: true,
            // Off: the PC runs the user's Git Graph Studio and a browser only watches it
            // (the replica, §22) — nothing should quit because nobody is watching.
            idle_exit_minutes: 0,
            trust_proxy: false,
            data_saver_default: false,
            paused: false,
            ggs_exe: None,
            last_launch: None,
            extension_dir: None,
            extension_missing_since: None,
            sandbox: SandboxConfig::default(),
        }
    }
}

impl Config {
    pub fn load_or_init(paths: &Paths) -> std::io::Result<Config> {
        match std::fs::read(paths.config()) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let config = Config::default();
                config.save(paths)?;
                Ok(config)
            }
            Err(e) => Err(e),
        }
    }

    pub fn save(&self, paths: &Paths) -> std::io::Result<()> {
        let json = serde_json::to_vec_pretty(self).unwrap_or_default();
        write_private(&paths.config(), &json)
    }

    /// HTTP without TLS is only allowed on loopback (§16 transport): a `none` mode with a
    /// public bind address is narrowed to 127.0.0.1.
    pub fn effective_bind(&self) -> String {
        if self.tls.mode == TlsMode::None && !is_loopback(&self.bind) {
            return "127.0.0.1".into();
        }
        self.bind.clone()
    }

    /// The LAN listener's port and protocol as an admin-config patch (the pair page's card;
    /// `ggs config` builds the same one): only what differs from now. `http` is the `none`
    /// mode — loopback only, see `effective_bind`; `https` keeps a mode that already is
    /// https (a custom certificate stays) and turns `none` into the self-signed CA.
    pub fn listener_patch(
        &self,
        port: Option<u16>,
        scheme: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        let mut patch = serde_json::Map::new();
        if let Some(port) = port {
            if port == 0 {
                return Err("port must be 1-65535".into());
            }
            if port != self.port {
                patch.insert("port".into(), port.into());
            }
        }
        if let Some(scheme) = scheme {
            let mode = match (scheme, self.tls.mode) {
                ("http", _) => TlsMode::None,
                ("https", TlsMode::None) => TlsMode::SelfSigned,
                ("https", mode) => mode,
                (other, _) => return Err(format!("protocol must be http or https, not {other}")),
            };
            if mode != self.tls.mode {
                let tls = TlsConfig {
                    mode,
                    ..self.tls.clone()
                };
                patch.insert(
                    "tls".into(),
                    serde_json::to_value(tls).map_err(|e| e.to_string())?,
                );
            }
        }
        Ok(serde_json::Value::Object(patch))
    }

    /// Apply a partial update from the admin API (`PUT /admin/config`); answers whether the
    /// listener must be rebound.
    pub fn apply_patch(&mut self, patch: &serde_json::Value) -> Result<bool, String> {
        let mut merged = serde_json::to_value(&*self).map_err(|e| e.to_string())?;
        let (Some(target), Some(source)) = (merged.as_object_mut(), patch.as_object()) else {
            return Err("config patch must be an object".into());
        };
        for (key, value) in source {
            if !target.contains_key(key) {
                return Err(format!("unknown config key: {key}"));
            }
            target.insert(key.clone(), value.clone());
        }
        let next: Config =
            serde_json::from_value(merged).map_err(|e| format!("invalid config: {e}"))?;
        if next.port == 0 {
            return Err("port must be 1-65535".into());
        }
        let rebind = next.port != self.port || next.bind != self.bind || next.tls != self.tls;
        *self = next;
        Ok(rebind)
    }
}

pub fn is_loopback(bind: &str) -> bool {
    bind == "localhost"
        || bind
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_fill_missing_keys() {
        let config: Config = serde_json::from_str(r#"{"port": 50000, "futureKey": 1}"#).unwrap();
        assert_eq!(config.port, 50000);
        assert_eq!(config.bind, "0.0.0.0");
        assert_eq!(config.idle_exit_minutes, 0);
    }

    #[test]
    fn plain_http_never_binds_publicly() {
        let mut config = Config::default();
        config.tls.mode = TlsMode::None;
        assert_eq!(config.effective_bind(), "127.0.0.1");
        config.bind = "127.0.0.1".into();
        assert_eq!(config.effective_bind(), "127.0.0.1");
    }

    #[test]
    fn listener_patch_carries_only_what_changes() {
        let mut config = Config::default();
        assert_eq!(
            config.listener_patch(Some(DEFAULT_PORT), Some("https")),
            Ok(serde_json::json!({}))
        );
        assert_eq!(
            config.listener_patch(Some(50000), None),
            Ok(serde_json::json!({ "port": 50000 }))
        );
        let http = config.listener_patch(None, Some("http")).unwrap();
        assert_eq!(http["tls"]["mode"], "none");
        assert!(config.listener_patch(Some(0), None).is_err());
        assert!(config.listener_patch(None, Some("ftp")).is_err());
        // https keeps a custom certificate; from plain http it is the self-signed CA.
        config.tls = TlsConfig {
            mode: TlsMode::Custom,
            cert_path: Some("c.pem".into()),
            key_path: Some("k.pem".into()),
        };
        assert_eq!(
            config.listener_patch(None, Some("https")),
            Ok(serde_json::json!({}))
        );
        let http = config.listener_patch(None, Some("http")).unwrap();
        assert_eq!(http["tls"]["certPath"], "c.pem");
        config.tls.mode = TlsMode::None;
        let https = config.listener_patch(None, Some("https")).unwrap();
        assert_eq!(https["tls"]["mode"], "self-signed");
        // The patch applies cleanly and rebinds.
        assert_eq!(config.apply_patch(&https), Ok(true));
    }

    #[test]
    fn patch_validates_and_reports_rebind() {
        let mut config = Config::default();
        assert_eq!(
            config.apply_patch(&serde_json::json!({ "spawnVisible": true })),
            Ok(false)
        );
        assert!(config.spawn_visible);
        assert_eq!(
            config.apply_patch(&serde_json::json!({ "folderInput": false })),
            Ok(false)
        );
        assert!(
            !config.folder_input,
            "the picker's folder row can be switched off"
        );
        assert_eq!(
            config.apply_patch(&serde_json::json!({ "port": 50001 })),
            Ok(true)
        );
        // The sandbox section (§23): a whole-object patch, validated by serde.
        assert_eq!(
            config.apply_patch(&serde_json::json!({
                "sandbox": { "enabled": true, "network": "intranet", "root": "D:/sb" }
            })),
            Ok(false)
        );
        assert!(config.sandbox.enabled);
        assert_eq!(
            config.sandbox.network,
            crate::config::SandboxNetwork::Intranet
        );
        assert_eq!(config.sandbox.root.as_deref(), Some("D:/sb"));
        assert!(config
            .apply_patch(&serde_json::json!({ "sandbox": { "network": "nope" } }))
            .is_err());
        // An old config without the key loads with the sandbox off.
        let legacy: Config = serde_json::from_str(r#"{"port": 50000}"#).unwrap();
        assert!(!legacy.sandbox.enabled);
        assert_eq!(
            legacy.sandbox.network,
            crate::config::SandboxNetwork::Internet
        );
        assert!(config
            .apply_patch(&serde_json::json!({ "nope": 1 }))
            .is_err());
        assert!(config
            .apply_patch(&serde_json::json!({ "port": 0 }))
            .is_err());
        assert_eq!(config.port, 50001);
    }
}
