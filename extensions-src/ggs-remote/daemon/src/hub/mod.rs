//! The daemon's Hub client (docs/ggs-remote-plan.md §20): an outbound tunnel to a self-hosted
//! relay — no account, no registration; this PC's Ed25519 key is the identity, the UUID its
//! link spells derives from it. `link.rs` keeps the tunnel; `session.rs` serves whatever the
//! Hub forwards (browser WebSockets and whole HTTP requests) through the daemon's own router
//! — the same code the LAN listener uses (§20.2 note 4).

pub mod identity;
pub mod link;
pub mod msg;
pub mod session;

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{watch, Notify};

use crate::paths::Paths;

/// `~/.ggs/remote/hub/hub.json` (§20.10): which relay, with which server password, pinned to
/// which certificate. Absent = the LAN-only daemon of §7.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub url: String,
    pub join_key: String,
    /// A SHA-256 hex pin for Hubs whose certificate is self-signed (`fp=` in the string).
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Unconfigured,
    /// A password must exist on this PC before it exposes anything through a Hub (§20.3).
    NoPassword,
    Connecting(String),
    /// Online: the uuid and the `https://<host>/u/<uuid>/` base the links spell.
    Online {
        uuid: String,
        public_base: String,
    },
    /// The Hub refused the tunnel; the string is its reason.
    Rejected(String),
    /// Another copy of this PC's key connected to the same Hub: stop retrying (§20.4).
    Replaced,
}

impl Status {
    pub fn as_json(&self) -> serde_json::Value {
        match self {
            Status::Unconfigured => serde_json::json!({ "state": "unconfigured" }),
            Status::NoPassword => serde_json::json!({ "state": "no-password" }),
            Status::Connecting(url) => {
                serde_json::json!({ "state": "connecting", "url": url })
            }
            Status::Online { uuid, public_base } => {
                serde_json::json!({ "state": "online", "uuid": uuid, "publicBase": public_base })
            }
            Status::Rejected(reason) => {
                serde_json::json!({ "state": "rejected", "reason": reason })
            }
            Status::Replaced => serde_json::json!({ "state": "replaced" }),
        }
    }

    pub fn online(&self) -> bool {
        matches!(self, Status::Online { .. })
    }
}

/// Parse the pasteable connect string (§20.3): `ggsr1:https://remote.example.com#joinkey;fp=<hex>`
/// — or a bare URL. Answers the settings it spells.
pub fn parse_connect_string(text: &str) -> Result<Settings, String> {
    let text = text.trim();
    let body = text.strip_prefix("ggsr1:").unwrap_or(text);
    let (base, rest) = body.split_once('#').unwrap_or((body, ""));
    let base = base.trim().trim_end_matches('/');
    // A bare `remote.example.com[:port]` means https; a scheme must be one we speak.
    let base = if base.contains("://") {
        let scheme = base.split("://").next().unwrap_or_default();
        if !matches!(scheme, "ws" | "wss" | "http" | "https") {
            return Err(format!("not a server address: {text}"));
        }
        base.to_owned()
    } else {
        if base.is_empty() || base.contains(' ') {
            return Err(format!("not a server address: {text}"));
        }
        format!("https://{base}")
    };
    let mut settings = Settings {
        url: base,
        join_key: String::new(),
        fingerprint: String::new(),
    };
    for part in rest.split(';').filter(|p| !p.is_empty()) {
        if let Some(fp) = part.strip_prefix("fp=") {
            let fp = fp.trim().to_ascii_lowercase();
            let ok = fp.len() == 64 && fp.chars().all(|c| c.is_ascii_hexdigit());
            if !ok {
                return Err("fp= must be a SHA-256 hex fingerprint".into());
            }
            settings.fingerprint = fp;
        } else {
            // The join key may contain anything but ';' and '#'.
            settings.join_key = part.to_owned();
        }
    }
    Ok(settings)
}

/// The daemon-side half: settings on disk, a status every surface reads, and a generation
/// counter that invalidates a running tunnel when the settings change under it.
pub struct HubClient {
    paths: Paths,
    settings: Mutex<Option<Settings>>,
    pub status: watch::Sender<Status>,
    pub restart: Notify,
    generation: AtomicU64,
}

impl HubClient {
    pub fn new(paths: Paths) -> HubClient {
        let settings = std::fs::read(paths.hub_config())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
            .filter(|s| !s.url.is_empty());
        HubClient {
            paths,
            settings: Mutex::new(settings),
            status: watch::channel(Status::Unconfigured).0,
            restart: Notify::new(),
            generation: AtomicU64::new(1),
        }
    }

    pub fn current(&self) -> Option<Settings> {
        self.settings.lock().unwrap().clone()
    }

    pub fn snapshot(&self) -> Status {
        self.status.borrow().clone()
    }

    fn set(&self, status: Status) {
        self.status.send_if_modified(|live| {
            if *live != status {
                *live = status;
                true
            } else {
                false
            }
        });
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    /// Point at a relay (or repoint): persist, invalidate the running tunnel, wake the loop.
    pub fn connect(&self, settings: Settings) -> Result<(), String> {
        parse_connect_string(&settings.url)?; // the URL must at least parse
        std::fs::create_dir_all(self.paths.hub_dir()).map_err(|e| e.to_string())?;
        crate::paths::write_private(
            &self.paths.hub_config(),
            serde_json::to_vec_pretty(&settings)
                .unwrap_or_default()
                .as_slice(),
        )
        .map_err(|e| e.to_string())?;
        *self.settings.lock().unwrap() = Some(settings);
        self.generation.fetch_add(1, Ordering::Relaxed);
        self.restart.notify_one();
        Ok(())
    }

    /// Forget the relay (the device key stays, so reconnecting keeps the same link).
    pub fn disconnect(&self) -> Result<(), String> {
        let _ = std::fs::remove_file(self.paths.hub_config());
        *self.settings.lock().unwrap() = None;
        self.set(Status::Unconfigured);
        self.generation.fetch_add(1, Ordering::Relaxed);
        self.restart.notify_one();
        Ok(())
    }

    /// One setting changed (the join key, say) without a full connect round.
    pub fn update<F: FnOnce(&mut Settings)>(&self, edit: F) -> Result<(), String> {
        let mut current = self.settings.lock().unwrap();
        if let Some(settings) = current.as_mut() {
            edit(settings);
        }
        if let Some(settings) = current.as_ref() {
            crate::paths::write_private(
                &self.paths.hub_config(),
                serde_json::to_vec_pretty(settings)
                    .unwrap_or_default()
                    .as_slice(),
            )
            .map_err(|e| e.to_string())?;
        }
        drop(current);
        self.generation.fetch_add(1, Ordering::Relaxed);
        self.restart.notify_one();
        Ok(())
    }

    /// The background loop's wakeups (§20.4): a settings change, or the backoff timer.
    pub async fn run(self: Arc<Self>, daemon: Arc<crate::state::Daemon>) {
        let mut backoff = 1u64;
        loop {
            let Some(settings) = self.current() else {
                self.set(Status::Unconfigured);
                self.restart.notified().await;
                backoff = 1;
                continue;
            };
            if !daemon.auth.is_set() {
                self.set(Status::NoPassword);
                self.restart.notified().await;
                continue;
            }
            self.set(Status::Connecting(settings.url.clone()));
            let generation = self.generation();
            match link::serve(daemon.clone(), self.clone(), &settings, generation).await {
                link::End::Replaced => {
                    self.set(Status::Replaced);
                    self.restart.notified().await; // no auto-retry: the user must look (§20.4)
                }
                link::End::Rejected(reason) => {
                    self.set(Status::Rejected(reason));
                    let wait = backoff.min(60);
                    backoff = (backoff * 2).min(60);
                    tokio::select! {
                        _ = self.restart.notified() => {}
                        _ = tokio::time::sleep(std::time::Duration::from_secs(wait)) => {}
                    }
                }
                link::End::Dropped { was_online } => {
                    backoff = if was_online { 1 } else { (backoff * 2).min(60) };
                    // ±20% jitter so a fleet of PCs does not stampede a restarting Hub.
                    let wait = backoff as f64 * (0.8 + 0.4 * rand_unit());
                    tokio::select! {
                        _ = self.restart.notified() => {}
                        _ = tokio::time::sleep(std::time::Duration::from_secs_f64(wait.max(0.5))) => {}
                    }
                }
                link::End::Stopped => {
                    // Settings changed under the tunnel: loop straight around.
                    backoff = 1;
                }
            }
        }
    }
}

/// A deterministic-enough jitter source without a rand crate: the clock's nanos.
fn rand_unit() -> f64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos % 1000) as f64 / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_strings_parse() {
        let fp = "ab".repeat(32);
        let settings =
            parse_connect_string(&format!("ggsr1:https://remote.example.com#sesame;fp={fp}"))
                .unwrap();
        assert_eq!(settings.url, "https://remote.example.com");
        assert_eq!(settings.join_key, "sesame");
        assert_eq!(settings.fingerprint, fp);

        let settings = parse_connect_string("https://remote.example.com/").unwrap();
        assert_eq!(settings.url, "https://remote.example.com");
        assert_eq!(settings.join_key, "");

        let settings = parse_connect_string("remote.example.com:8443").unwrap();
        assert_eq!(settings.url, "https://remote.example.com:8443");

        assert!(parse_connect_string("ggsr1:").is_err());
        assert!(parse_connect_string("ggsr1:https://x#k;fp=short").is_err());
        let bad = parse_connect_string("ftp://nope");
        assert!(bad.is_err());
    }

    #[test]
    fn settings_round_trip_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
        paths.ensure().unwrap();
        let client = HubClient::new(paths.clone());
        assert_eq!(client.snapshot(), Status::Unconfigured);
        client
            .connect(Settings {
                url: "https://remote.example.com".into(),
                join_key: "sesame".into(),
                fingerprint: String::new(),
            })
            .unwrap();
        let reloaded = HubClient::new(paths.clone());
        assert_eq!(
            reloaded.current(),
            Some(Settings {
                url: "https://remote.example.com".into(),
                join_key: "sesame".into(),
                fingerprint: String::new(),
            })
        );
        reloaded.disconnect().unwrap();
        assert!(reloaded.current().is_none());
        assert!(HubClient::new(paths).current().is_none());
    }

    #[test]
    fn a_bad_url_is_refused_before_it_touches_disk() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
        paths.ensure().unwrap();
        let client = HubClient::new(paths.clone());
        assert!(client
            .connect(Settings {
                url: "not a url".into(),
                join_key: String::new(),
                fingerprint: String::new(),
            })
            .is_err());
        assert!(client.current().is_none());
        assert!(!paths.hub_config().exists());
    }
}
