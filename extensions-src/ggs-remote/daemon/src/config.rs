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
    fn patch_validates_and_reports_rebind() {
        let mut config = Config::default();
        assert_eq!(
            config.apply_patch(&serde_json::json!({ "spawnVisible": true })),
            Ok(false)
        );
        assert!(config.spawn_visible);
        assert_eq!(
            config.apply_patch(&serde_json::json!({ "port": 50001 })),
            Ok(true)
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
