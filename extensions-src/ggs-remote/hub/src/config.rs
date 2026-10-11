//! `hub.toml` (docs/ggs-remote-plan.md §20.8): the listener, the public URL the links spell,
//! TLS, the server password and the limits. Unknown keys are ignored; missing ones take their
//! defaults, so a config written by an older Hub still loads.

use serde::{Deserialize, Serialize};

pub const DEFAULT_ASSET_CACHE_MB: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TlsMode {
    /// PEM files on disk.
    Files,
    /// No TLS here — a front proxy (the deploy/ Caddyfile) terminates it.
    #[default]
    None,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TlsConfig {
    pub mode: TlsMode,
    pub cert: Option<String>,
    pub key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub listen: String,
    /// What the links spell, e.g. `https://remote.example.com` — the challenge's host binds
    /// to its name and `T_READY.publicBase` is built from it. Empty: derived from each
    /// tunnel's `Host` header (fine for one-name deployments).
    pub public_url: String,
    pub tls: TlsConfig,
    /// The server password (§20.6): empty = any GGS Remote may connect.
    pub join_key: String,
    pub max_tunnels: usize,
    pub sessions_per_tunnel: usize,
    /// Per-tunnel daily byte budget; 0 = unlimited.
    pub bytes_per_day_per_tunnel: u64,
    /// The cross-PC cache for the workbench's immutable assets (§20.6), in MB.
    pub asset_cache_mb: usize,
    /// Trust `X-Forwarded-For` from loopback peers (a front proxy ends TLS, §20.8).
    pub trust_proxy: bool,
    /// `/tunnel` handshakes one IP may start per minute (§20.6); 0 = unlimited — for load
    /// tests and private deployments whose whole fleet shares one address.
    pub handshake_rate: u32,
    /// Serve a landing page (no PC information) at `/`.
    pub landing_page: bool,
    /// A second listener for `/metrics` (Prometheus text); empty = off.
    pub metrics_listen: String,
}

impl Default for Config {
    fn default() -> Config {
        Config {
            listen: "0.0.0.0:8443".into(),
            public_url: String::new(),
            tls: TlsConfig::default(),
            join_key: String::new(),
            max_tunnels: 200,
            sessions_per_tunnel: 8,
            bytes_per_day_per_tunnel: 0,
            asset_cache_mb: DEFAULT_ASSET_CACHE_MB,
            trust_proxy: false,
            handshake_rate: 10,
            landing_page: false,
            metrics_listen: String::new(),
        }
    }
}

#[derive(Debug)]
pub enum LoadError {
    Io(std::io::Error),
    Parse(String),
    NeedsCert,
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoadError::Io(e) => write!(f, "{e}"),
            LoadError::Parse(e) => write!(f, "invalid hub.toml: {e}"),
            LoadError::NeedsCert => write!(
                f,
                "tls mode \"files\" needs cert and key (or use \"none\" behind a front proxy)"
            ),
        }
    }
}

impl Config {
    pub fn load(path: &str) -> Result<Config, LoadError> {
        let raw = std::fs::read_to_string(path).map_err(LoadError::Io)?;
        let mut config: Config =
            toml::from_str(&raw).map_err(|e| LoadError::Parse(e.to_string()))?;
        config.validate()?;
        Ok(config)
    }

    pub fn example() -> String {
        format!(
            "# ggs-remote-hub — one file, nothing else to back up (docs/ggs-remote-plan.md §20.8)\n\
             listen = \"{listen}\"\n\
             # The name the https://…/u/<uuid>/ links spell. Empty: taken from each tunnel's Host.\n\
             public_url = \"\"\n\
             \n\
             [tls]\n\
             # \"files\": cert/key below. \"none\": a front proxy (see deploy/Caddyfile) ends TLS.\n\
             mode = \"none\"\n\
             cert = \"\"\n\
             key = \"\"\n\
             \n\
             # The server password. Empty: any GGS Remote can connect — set one on the public\n\
             # internet unless you mean to run a communal relay.\n\
             join_key = \"\"\n\
             max_tunnels = {max_tunnels}\n\
             sessions_per_tunnel = {sessions}\n\
             bytes_per_day_per_tunnel = 0\n\
             asset_cache_mb = {cache}\n\
             trust_proxy = false\n\
             # /tunnel handshakes one IP may start per minute; 0 = unlimited (load tests).\n\
             handshake_rate = {handshake_rate}\n\
             landing_page = false\n\
             metrics_listen = \"\"\n",
            listen = Config::default().listen,
            max_tunnels = Config::default().max_tunnels,
            sessions = Config::default().sessions_per_tunnel,
            cache = DEFAULT_ASSET_CACHE_MB,
            handshake_rate = Config::default().handshake_rate,
        )
    }

    fn validate(&mut self) -> Result<(), LoadError> {
        if self.tls.mode == TlsMode::Files && (self.tls.cert.is_none() || self.tls.key.is_none()) {
            return Err(LoadError::NeedsCert);
        }
        if self.max_tunnels == 0 {
            self.max_tunnels = Config::default().max_tunnels;
        }
        if self.sessions_per_tunnel == 0 {
            self.sessions_per_tunnel = Config::default().sessions_per_tunnel;
        }
        if self.asset_cache_mb == 0 {
            self.asset_cache_mb = DEFAULT_ASSET_CACHE_MB;
        }
        Ok(())
    }

    /// The scheme + host the links spell: the configured public URL, or the name a tunnel's
    /// own request arrived on.
    pub fn public_origin(&self, host: Option<&str>) -> String {
        let trimmed = self.public_url.trim_end_matches('/');
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
        let scheme = if self.tls.mode == TlsMode::None {
            "http"
        } else {
            "https"
        };
        match host {
            Some(host) => format!("{scheme}://{host}"),
            None => scheme.to_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_fill_missing_keys() {
        let config: Config = toml::from_str("listen = \"0.0.0.0:9443\"\n").unwrap();
        assert_eq!(config.listen, "0.0.0.0:9443");
        assert_eq!(config.max_tunnels, 200);
        assert_eq!(config.tls.mode, TlsMode::None);
        assert_eq!(
            config.public_origin(Some("r.example.com")),
            "http://r.example.com"
        );
    }

    #[test]
    fn files_mode_needs_both_halves() {
        let mut config =
            toml::from_str::<Config>("[tls]\nmode = \"files\"\ncert = \"/srv/c.pem\"\n").unwrap();
        assert!(matches!(config.validate(), Err(LoadError::NeedsCert)));
        let mut config = toml::from_str::<Config>(
            "[tls]\nmode = \"files\"\ncert = \"/srv/c.pem\"\nkey = \"/srv/k.pem\"\n",
        )
        .unwrap();
        config.validate().unwrap();
        assert_eq!(config.public_origin(None), "https");
    }

    #[test]
    fn public_url_wins_and_loses_its_slash() {
        let config = Config {
            public_url: "https://remote.example.com/".into(),
            ..Config::default()
        };
        assert_eq!(config.public_origin(None), "https://remote.example.com");
    }
}
