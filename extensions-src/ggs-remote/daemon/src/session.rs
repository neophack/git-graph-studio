//! Browser sessions (docs/ggs-remote-plan.md §7.6): a 256-bit random cookie token of which
//! only the SHA-256 is kept, stamped with the credential epoch it was issued under. Sessions
//! persist in `sessions.json`, so a daemon restart signs nobody out.

use serde::{Deserialize, Serialize};
use std::net::IpAddr;

use crate::paths::{write_private, Paths};
use crate::util::{b64, b64_decode, hex, now_secs, random_bytes, sha256};

/// A remembered session lives 30 days from issue; an unremembered one 12 hours from its last
/// use (sliding).
pub const REMEMBER_SECS: u64 = 30 * 24 * 3600;
pub const SLIDING_SECS: u64 = 12 * 3600;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// hex(SHA-256(token)) — doubles as the device id the device list shows.
    pub token_hash: String,
    pub epoch: u64,
    pub device: String,
    pub ua: String,
    pub ip: String,
    pub created: u64,
    pub last_seen: u64,
    pub remember: bool,
    /// The WS HELLO's CSRF value (base64url of 16 random bytes).
    pub csrf: String,
}

impl Session {
    pub fn expires(&self) -> u64 {
        if self.remember {
            self.created + REMEMBER_SECS
        } else {
            self.last_seen + SLIDING_SECS
        }
    }

    pub fn valid_at(&self, epoch: u64, now: u64) -> bool {
        self.epoch == epoch && now < self.expires()
    }

    pub fn id(&self) -> &str {
        &self.token_hash[..16]
    }
}

/// What the device list shows (never the token hash in full).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub device: String,
    pub ip: String,
    pub created: u64,
    pub last_seen: u64,
    pub current: bool,
}

pub struct Sessions {
    list: Vec<Session>,
    path: std::path::PathBuf,
}

pub fn hash_token(token: &str) -> Option<String> {
    let raw = b64_decode(token)?;
    if raw.len() != 32 {
        return None;
    }
    Some(hex(&sha256(&raw)))
}

/// A readable device name from a User-Agent ("iPhone Safari", "Windows Edge").
pub fn device_from_ua(ua: &str) -> String {
    let os = if ua.contains("iPhone") {
        "iPhone"
    } else if ua.contains("iPad") {
        "iPad"
    } else if ua.contains("Android") {
        "Android"
    } else if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("Mac OS X") || ua.contains("Macintosh") {
        "Mac"
    } else if ua.contains("Linux") {
        "Linux"
    } else {
        "Browser"
    };
    let browser = if ua.contains("SamsungBrowser") {
        "Samsung Internet"
    } else if ua.contains("Edg/") {
        "Edge"
    } else if ua.contains("Firefox/") || ua.contains("FxiOS") {
        "Firefox"
    } else if ua.contains("Chrome/") || ua.contains("CriOS") {
        "Chrome"
    } else if ua.contains("Safari/") {
        "Safari"
    } else {
        ""
    };
    if browser.is_empty() {
        os.to_owned()
    } else {
        format!("{os} {browser}")
    }
}

impl Sessions {
    pub fn load(paths: &Paths) -> Sessions {
        let list = std::fs::read(paths.sessions())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Sessions {
            list,
            path: paths.sessions(),
        }
    }

    fn save(&self) {
        if let Ok(json) = serde_json::to_vec(&self.list) {
            if let Err(e) = write_private(&self.path, &json) {
                crate::warn!("sessions.json: {e}");
            }
        }
    }

    /// Issue a session; answers the cookie token (the only time it exists in clear).
    pub fn create(
        &mut self,
        epoch: u64,
        device: &str,
        ua: &str,
        ip: IpAddr,
        remember: bool,
    ) -> (String, Session) {
        let raw = random_bytes::<32>();
        let token = b64(&raw);
        let now = now_secs();
        let session = Session {
            token_hash: hex(&sha256(&raw)),
            epoch,
            device: if device.trim().is_empty() {
                device_from_ua(ua)
            } else {
                device.trim().chars().take(64).collect()
            },
            ua: ua.chars().take(256).collect(),
            ip: ip.to_string(),
            created: now,
            last_seen: now,
            remember,
            csrf: b64(&random_bytes::<16>()),
        };
        self.list.push(session.clone());
        self.save();
        (token, session)
    }

    /// Look a cookie token up; a valid session's `last_seen` slides forward (persisted at most
    /// once a minute, the write is not worth more).
    pub fn touch(&mut self, token: &str, epoch: u64) -> Option<Session> {
        let hash = hash_token(token)?;
        let now = now_secs();
        let session = self.list.iter_mut().find(|s| s.token_hash == hash)?;
        if !session.valid_at(epoch, now) {
            return None;
        }
        let stale = now.saturating_sub(session.last_seen) >= 60;
        session.last_seen = now;
        let found = session.clone();
        if stale {
            self.save();
        }
        Some(found)
    }

    /// Still valid? (the 60 s re-check of a live connection, §7.7)
    pub fn still_valid(&self, token_hash: &str, epoch: u64) -> bool {
        let now = now_secs();
        self.list
            .iter()
            .any(|s| s.token_hash == token_hash && s.valid_at(epoch, now))
    }

    pub fn by_hash(&self, token_hash: &str) -> Option<&Session> {
        self.list.iter().find(|s| s.token_hash == token_hash)
    }

    pub fn remove_by_hash(&mut self, token_hash: &str) -> bool {
        let before = self.list.len();
        self.list.retain(|s| s.token_hash != token_hash);
        let removed = self.list.len() != before;
        if removed {
            self.save();
        }
        removed
    }

    /// Remove by the short device id the device list shows; answers the full hash removed.
    pub fn remove_by_id(&mut self, id: &str) -> Option<String> {
        let hash = self.list.iter().find(|s| s.id() == id)?.token_hash.clone();
        self.remove_by_hash(&hash);
        Some(hash)
    }

    pub fn clear(&mut self) {
        self.list.clear();
        self.save();
    }

    /// Drop expired and stale-epoch sessions.
    pub fn prune(&mut self, epoch: u64) {
        let now = now_secs();
        let before = self.list.len();
        self.list.retain(|s| s.valid_at(epoch, now));
        if self.list.len() != before {
            self.save();
        }
    }

    pub fn devices(&self, epoch: u64, current: Option<&str>) -> Vec<DeviceView> {
        let now = now_secs();
        self.list
            .iter()
            .filter(|s| s.valid_at(epoch, now))
            .map(|s| DeviceView {
                id: s.id().to_owned(),
                device: s.device.clone(),
                ip: s.ip.clone(),
                created: s.created,
                last_seen: s.last_seen,
                current: current == Some(s.token_hash.as_str()),
            })
            .collect()
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }

    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Sessions, Paths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
        paths.ensure().unwrap();
        (dir, Sessions::load(&paths), paths)
    }

    #[test]
    fn create_touch_and_epoch() {
        let (_dir, mut sessions, paths) = store();
        let ip: IpAddr = "192.168.1.5".parse().unwrap();
        let (token, session) = sessions.create(
            3,
            "",
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1",
            ip,
            false,
        );
        assert_eq!(session.device, "iPhone Safari");
        assert!(sessions.touch(&token, 3).is_some());
        // A stale epoch (password changed) or a forged token finds nothing.
        assert!(sessions.touch(&token, 4).is_none());
        assert!(sessions.touch("forged", 3).is_none());
        // Persisted: a fresh load knows the session.
        let reloaded = Sessions::load(&paths);
        assert_eq!(reloaded.len(), 1);
        assert!(reloaded.still_valid(&session.token_hash, 3));
    }

    #[test]
    fn device_removal_and_listing() {
        let (_dir, mut sessions, _paths) = store();
        let ip: IpAddr = "10.0.0.2".parse().unwrap();
        let (_, a) = sessions.create(1, "Laptop", "", ip, true);
        let (_, b) = sessions.create(
            1,
            "",
            "Mozilla/5.0 (Windows NT 10.0) Chrome/120 Edg/120",
            ip,
            true,
        );
        let devices = sessions.devices(1, Some(&a.token_hash));
        assert_eq!(devices.len(), 2);
        assert!(devices.iter().any(|d| d.current && d.device == "Laptop"));
        assert!(devices.iter().any(|d| d.device == "Windows Edge"));
        assert_eq!(
            sessions.remove_by_id(b.id()).as_deref(),
            Some(b.token_hash.as_str())
        );
        assert_eq!(sessions.devices(1, None).len(), 1);
    }

    #[test]
    fn expiry_rules() {
        let mut s = Session {
            token_hash: "0".repeat(64),
            epoch: 1,
            device: String::new(),
            ua: String::new(),
            ip: String::new(),
            created: 1000,
            last_seen: 5000,
            remember: false,
            csrf: String::new(),
        };
        assert_eq!(s.expires(), 5000 + SLIDING_SECS);
        s.remember = true;
        assert_eq!(s.expires(), 1000 + REMEMBER_SECS);
        assert!(!s.valid_at(2, 2000));
    }
}
