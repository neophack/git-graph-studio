//! The registered PCs and their paired phones. One user per PC: every window of that PC
//! shares its id, its agent secret and its pairing epoch. The relay never holds a content
//! key — `auth` only lets a phone prove it scanned the PC's QR (an HMAC over a server
//! nonce), the frames themselves stay opaque ciphertext.
//!
//! Persistence is one JSON file written atomically (temp file + rename); a relay serves a
//! few thousand PCs at most, and every write is a registration, a pairing, a rekey or a
//! delete.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct User {
    pub id: String,
    /// hex, 32 bytes: what a window proves with `Authorization: Bearer <secret>`
    pub secret: String,
    /// hex, 32 bytes: what a phone proves with HMAC(auth, challenge); replaced on rekey
    pub auth: String,
    /// bumped by every rekey — a phone paired under an older epoch is kicked
    pub epoch: u64,
    /// Argon2id PHC string when the PC set an extra login password
    pub password: Option<String>,
    pub disabled: bool,
    pub created: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Device {
    pub id: String,
    pub user: String,
    /// hex, 32 bytes: SHA-256 of the token the phone holds
    pub token_hash: String,
    /// the epoch the device paired under — an older epoch means a rekeyed relay
    pub epoch: u64,
    pub name: String,
    pub created: u64,
    pub last_seen: u64,
}

#[derive(Debug, PartialEq)]
pub enum StoreError {
    Full,
    Conflict,
    NotFound,
    Io(String),
}

impl StoreError {
    pub fn message(&self) -> &'static str {
        match self {
            StoreError::Full => "user limit reached",
            StoreError::Conflict => "stale epoch — reload the identity and retry",
            StoreError::NotFound => "no such user or device",
            StoreError::Io(_) => "storage failure",
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Persisted {
    users: Vec<User>,
    devices: Vec<Device>,
}

pub struct Store {
    file: Option<PathBuf>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    users: HashMap<String, User>,
    devices: HashMap<String, Device>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::getrandom(&mut buf).expect("the OS random source");
    hex(&buf)
}

pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// `u` + 26 Crockford base32 symbols (130 bits) — a user id; `w`/`d` + 16 for windows
/// and devices (the phone page's URL path and the frame headers stay short).
pub fn new_id(prefix: char) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghjkmnpqrstvwxyz";
    let n = if prefix == 'u' { 26 } else { 16 };
    let mut bytes = [0u8; 26];
    getrandom::getrandom(&mut bytes[..n]).expect("the OS random source");
    let mut id = String::with_capacity(n + 2);
    id.push(prefix);
    id.push('_');
    for byte in &bytes[..n] {
        id.push(ALPHABET[(byte & 31) as usize] as char);
    }
    id
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex(&Sha256::digest(bytes))
}

/// Argon2id in Node's `password-hash` PHC form; the parameters are the crate defaults
/// (19 MiB, t=2, p=1) — the plan's "configurable Argon2 parameters" knob, when it is
/// ever needed, only relaxes verification of whatever PHC string is stored.
pub fn hash_password(password: &str) -> Result<String, StoreError> {
    let salt = SaltString::generate(&mut RandSource);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|_| StoreError::Io("password hashing failed".into()))
}

pub fn verify_password(record: &str, password: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(record) else { return false };
    Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok()
}

struct RandSource;
impl argon2::password_hash::rand_core::CryptoRng for RandSource {}
impl argon2::password_hash::rand_core::RngCore for RandSource {
    fn next_u32(&mut self) -> u32 {
        let mut bytes = [0u8; 4];
        getrandom::getrandom(&mut bytes).expect("the OS random source");
        u32::from_le_bytes(bytes)
    }
    fn next_u64(&mut self) -> u64 {
        let mut bytes = [0u8; 8];
        getrandom::getrandom(&mut bytes).expect("the OS random source");
        u64::from_le_bytes(bytes)
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        getrandom::getrandom(dest).expect("the OS random source");
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), argon2::password_hash::rand_core::Error> {
        self.fill_bytes(dest);
        Ok(())
    }
}

impl Store {
    /// Open the store under `dir` (created when missing), or an in-memory one for `None`.
    pub fn open(dir: Option<&Path>) -> io::Result<Store> {
        let Some(dir) = dir else {
            return Ok(Store { file: None, state: Mutex::new(State::default()) });
        };
        fs::create_dir_all(dir)?;
        let file = dir.join("users.json");
        let state = match fs::read(&file) {
            Ok(bytes) => {
                // The first cut of the file was a bare user array; it reads back empty-handed
                // here and registers again, so accept both shapes.
                let parsed: serde_json::Result<Persisted> = serde_json::from_slice(&bytes);
                match parsed {
                    Ok(p) => State {
                        users: p.users.into_iter().map(|u| (u.id.clone(), u)).collect(),
                        devices: p.devices.into_iter().map(|d| (d.id.clone(), d)).collect(),
                    },
                    Err(_) => {
                        let legacy: Vec<User> = serde_json::from_slice(&bytes).map_err(|e| {
                            io::Error::new(io::ErrorKind::InvalidData, format!("{}: {e}", file.display()))
                        })?;
                        State { users: legacy.into_iter().map(|u| (u.id.clone(), u)).collect(), devices: HashMap::new() }
                    }
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => State::default(),
            Err(e) => return Err(e),
        };
        Ok(Store { file: Some(file), state: Mutex::new(state) })
    }

    pub fn get(&self, id: &str) -> Option<User> {
        self.state.lock().unwrap().users.get(id).cloned()
    }

    pub fn user_count(&self) -> usize {
        self.state.lock().unwrap().users.len()
    }

    pub fn user_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.state.lock().unwrap().users.keys().cloned().collect();
        ids.sort();
        ids
    }

    pub fn create(&self, secret: &str, auth: &str, max_users: usize) -> Result<User, StoreError> {
        let mut state = self.state.lock().unwrap();
        if state.users.len() >= max_users {
            return Err(StoreError::Full);
        }
        let mut id = new_id('u');
        while state.users.contains_key(&id) {
            id = new_id('u');
        }
        let user = User {
            id: id.clone(),
            secret: secret.to_string(),
            auth: auth.to_string(),
            epoch: 1,
            password: None,
            disabled: false,
            created: now_ms(),
        };
        state.users.insert(id.clone(), user.clone());
        if let Err(e) = self.persist(&state) {
            state.users.remove(&id);
            return Err(StoreError::Io(e.to_string()));
        }
        Ok(user)
    }

    /// Replace the phone credential; the epoch moves on and every paired device is gone.
    pub fn rekey(&self, id: &str, auth: &str, expect_epoch: u64) -> Result<(User, Vec<Device>), StoreError> {
        let mut state = self.state.lock().unwrap();
        let Some(user) = state.users.get_mut(id) else { return Err(StoreError::NotFound) };
        if user.epoch != expect_epoch {
            return Err(StoreError::Conflict);
        }
        let before = user.clone();
        user.auth = auth.to_string();
        user.epoch += 1;
        let after = user.clone();
        let kicked: Vec<Device> = state.devices.values().filter(|d| d.user == id).cloned().collect();
        for device in &kicked {
            state.devices.remove(&device.id);
        }
        if let Err(e) = self.persist(&state) {
            // Roll the whole transaction back: the epoch must never move without the kick.
            state.users.insert(id.to_string(), before);
            for device in kicked {
                state.devices.insert(device.id.clone(), device);
            }
            return Err(StoreError::Io(e.to_string()));
        }
        Ok((after, kicked))
    }

    /// Replace the window credential (what a PC's windows prove with Bearer). The pairing
    /// material does not move — phones stay paired.
    pub fn rotate_secret(&self, id: &str, secret: &str) -> Result<User, StoreError> {
        let mut state = self.state.lock().unwrap();
        let Some(user) = state.users.get_mut(id) else { return Err(StoreError::NotFound) };
        let before = user.clone();
        user.secret = secret.to_string();
        let after = user.clone();
        if let Err(e) = self.persist(&state) {
            state.users.insert(id.to_string(), before);
            return Err(StoreError::Io(e.to_string()));
        }
        Ok(after)
    }

    pub fn set_password(&self, id: &str, phc: Option<String>) -> Result<User, StoreError> {        let mut state = self.state.lock().unwrap();
        let Some(user) = state.users.get_mut(id) else { return Err(StoreError::NotFound) };
        let before = user.clone();
        user.password = phc;
        let after = user.clone();
        if let Err(e) = self.persist(&state) {
            state.users.insert(id.to_string(), before);
            return Err(StoreError::Io(e.to_string()));
        }
        Ok(after)
    }

    pub fn set_disabled(&self, id: &str, disabled: bool) -> Result<bool, StoreError> {
        let mut state = self.state.lock().unwrap();
        let Some(user) = state.users.get_mut(id) else { return Err(StoreError::NotFound) };
        if user.disabled == disabled {
            return Ok(false);
        }
        user.disabled = disabled;
        let touched: Vec<Device> = state.devices.values().filter(|d| d.user == id).cloned().collect();
        if disabled {
            for device in &touched {
                state.devices.remove(&device.id);
            }
        }
        if let Err(e) = self.persist(&state) {
            let Some(user) = state.users.get_mut(id) else { return Err(StoreError::Io(e.to_string())) };
            user.disabled = !disabled;
            for device in touched {
                state.devices.insert(device.id.clone(), device);
            }
            return Err(StoreError::Io(e.to_string()));
        }
        Ok(true)
    }

    /// Register a phone under the current epoch. The token itself never touches the store.
    pub fn pair_device(&self, user_id: &str, name: &str, max_devices: usize) -> Result<(Device, String), StoreError> {
        let token = random_hex(32);
        let mut state = self.state.lock().unwrap();
        let Some(user) = state.users.get(user_id) else { return Err(StoreError::NotFound) };
        let epoch = user.epoch;
        let owned = state.devices.values().filter(|d| d.user == user_id).count();
        if owned >= max_devices {
            return Err(StoreError::Full);
        }
        let mut id = new_id('d');
        while state.devices.contains_key(&id) {
            id = new_id('d');
        }
        let device = Device {
            id: id.clone(),
            user: user_id.to_string(),
            token_hash: sha256_hex(token.as_bytes()),
            epoch,
            name: sanitize_name(name),
            created: now_ms(),
            last_seen: now_ms(),
        };
        state.devices.insert(id.clone(), device.clone());
        if let Err(e) = self.persist(&state) {
            state.devices.remove(&id);
            return Err(StoreError::Io(e.to_string()));
        }
        Ok((device, token))
    }

    /// Look a device token up; `None` when unknown, revoked or paired under an older epoch.
    pub fn device_by_token(&self, token: &str) -> Option<Device> {
        let hash = sha256_hex(token.as_bytes());
        let state = self.state.lock().unwrap();
        let device = state.devices.values().find(|d| d.token_hash == hash)?;
        let user = state.users.get(&device.user)?;
        (device.epoch == user.epoch && !user.disabled).then(|| device.clone())
    }

    pub fn devices_of(&self, user_id: &str) -> Vec<Device> {
        let state = self.state.lock().unwrap();
        let mut list: Vec<Device> =
            state.devices.values().filter(|d| d.user == user_id).cloned().collect();
        list.sort_by(|a, b| b.last_seen.cmp(&a.last_seen).then(a.id.cmp(&b.id)));
        list
    }

    pub fn touch_device(&self, device_id: &str) {
        let mut state = self.state.lock().unwrap();
        if let Some(device) = state.devices.get_mut(device_id) {
            device.last_seen = now_ms();
            // Last-seen is telemetry, not a credential: a failed persist is not worth
            // rolling back, and the next touch tries again.
            let _ = self.persist(&state);
        }
    }

    pub fn remove_device(&self, user_id: &str, device_id: &str) -> Result<Device, StoreError> {
        let mut state = self.state.lock().unwrap();
        let Some(device) = state.devices.get(device_id) else { return Err(StoreError::NotFound) };
        if device.user != user_id {
            return Err(StoreError::NotFound); // cross-user addresses read as absent
        }
        let removed = device.clone();
        state.devices.remove(device_id);
        if let Err(e) = self.persist(&state) {
            state.devices.insert(device_id.to_string(), removed.clone());
            return Err(StoreError::Io(e.to_string()));
        }
        Ok(removed)
    }

    /// Drop paired devices not seen for `min_ms`; returns how many went.
    pub fn gc_devices(&self, min_ms: u64) -> usize {
        let mut state = self.state.lock().unwrap();
        let cutoff = now_ms().saturating_sub(min_ms);
        let stale: Vec<String> = state
            .devices
            .values()
            .filter(|d| d.last_seen < cutoff)
            .map(|d| d.id.clone())
            .collect();
        if stale.is_empty() {
            return 0;
        }
        for id in &stale {
            state.devices.remove(id);
        }
        if self.persist(&state).is_err() {
            return 0; // the store stands; the next gc sweeps again
        }
        stale.len()
    }

    pub fn delete(&self, id: &str) -> Result<(), StoreError> {
        let mut state = self.state.lock().unwrap();
        let Some(removed) = state.users.remove(id) else { return Err(StoreError::NotFound) };
        let devices: Vec<Device> = state.devices.values().filter(|d| d.user == id).cloned().collect();
        for device in &devices {
            state.devices.remove(&device.id);
        }
        if let Err(e) = self.persist(&state) {
            state.users.insert(id.to_string(), removed);
            for device in devices {
                state.devices.insert(device.id.clone(), device);
            }
            return Err(StoreError::Io(e.to_string()));
        }
        Ok(())
    }

    fn persist(&self, state: &State) -> io::Result<()> {
        let Some(file) = &self.file else { return Ok(()) };
        let mut users: Vec<&User> = state.users.values().collect();
        users.sort_by(|a, b| a.id.cmp(&b.id));
        let mut devices: Vec<&Device> = state.devices.values().collect();
        devices.sort_by(|a, b| a.id.cmp(&b.id));
        let bytes = serde_json::to_vec_pretty(&Persisted {
            users: users.into_iter().cloned().collect(),
            devices: devices.into_iter().cloned().collect(),
        })?;
        let tmp = file.with_extension("json.tmp");
        fs::write(&tmp, bytes)?;
        restrict(&tmp);
        fs::rename(&tmp, file)
    }
}

fn sanitize_name(name: &str) -> String {
    let cleaned: String = name.chars().filter(|c| !c.is_control()).take(60).collect::<String>().trim().to_string();
    if cleaned.is_empty() { "phone".into() } else { cleaned }
}

/// The file holds every PC's credentials: owner-only where the OS has modes.
#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    #[test]
    fn create_rekey_delete_round_trip_through_the_file() {
        let dir = std::env::temp_dir().join(format!("crs-store-{}", now_ms()));
        let store = Store::open(Some(&dir)).unwrap();
        let user = store.create(KEY, KEY, 10).unwrap();
        assert!(user.id.starts_with("u_") && user.id.len() == 28);
        assert_eq!(user.epoch, 1);
        let (device, token) = store.pair_device(&user.id, "Pixel", 10).unwrap();
        assert_eq!(device.epoch, 1);
        assert!(store.device_by_token(&token).is_some());

        let (rekeyed, kicked) = store.rekey(&user.id, "ff", 1).unwrap();
        assert_eq!((rekeyed.epoch, rekeyed.auth.as_str()), (2, "ff"));
        assert_eq!(kicked.len(), 1);
        // The rekeyed relay knows neither the old token nor the new-user password:
        assert!(store.device_by_token(&token).is_none());

        let reopened = Store::open(Some(&dir)).unwrap();
        assert_eq!(reopened.get(&user.id), Some(rekeyed));
        assert_eq!(reopened.devices_of(&user.id), Vec::new());
        reopened.delete(&user.id).unwrap();
        assert_eq!(Store::open(Some(&dir)).unwrap().user_count(), 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_user_cap_holds() {
        let store = Store::open(None).unwrap();
        store.create(KEY, KEY, 1).unwrap();
        assert_eq!(store.create(KEY, KEY, 1), Err(StoreError::Full));
    }

    #[test]
    fn the_device_cap_and_revocation_hold() {
        let store = Store::open(None).unwrap();
        let user = store.create(KEY, KEY, 10).unwrap();
        let (a, ta) = store.pair_device(&user.id, "a", 1).unwrap();
        assert!(store.pair_device(&user.id, "b", 1).is_err());
        let removed = store.remove_device(&user.id, &a.id).unwrap();
        assert_eq!(removed.id, a.id);
        assert!(store.device_by_token(&ta).is_none());
        // Another user's device reads as absent, never as removable:
        let other = store.create(KEY, KEY, 10).unwrap();
        let (b, tb) = store.pair_device(&other.id, "b", 5).unwrap();
        assert_eq!(store.remove_device(&user.id, &b.id), Err(StoreError::NotFound));
        assert!(store.device_by_token(&tb).is_some());
    }

    #[test]
    fn a_stale_epoch_never_rekeys() {
        let store = Store::open(None).unwrap();
        let user = store.create(KEY, KEY, 10).unwrap();
        assert_eq!(store.rekey(&user.id, "ff", 7), Err(StoreError::Conflict));
        assert_eq!(store.get(&user.id).unwrap().epoch, 1);
    }

    #[test]
    fn passwords_hash_and_verify() {
        let phc = hash_password("hunter2!").unwrap();
        assert!(verify_password(&phc, "hunter2!"));
        assert!(!verify_password(&phc, "hunter3!"));
        let store = Store::open(None).unwrap();
        let user = store.create(KEY, KEY, 10).unwrap();
        let with_pw = store.set_password(&user.id, Some(phc.clone())).unwrap();
        assert_eq!(with_pw.password.as_deref(), Some(phc.as_str()));
        let cleared = store.set_password(&user.id, None).unwrap();
        assert!(cleared.password.is_none());
    }

    #[test]
    fn disabling_a_user_drops_its_devices() {
        let store = Store::open(None).unwrap();
        let user = store.create(KEY, KEY, 10).unwrap();
        let (_, token) = store.pair_device(&user.id, "a", 5).unwrap();
        assert!(store.set_disabled(&user.id, true).unwrap());
        assert!(store.device_by_token(&token).is_none());
        assert_eq!(store.devices_of(&user.id).len(), 0);
    }

    #[test]
    fn gc_drops_only_stale_devices() {
        let store = Store::open(None).unwrap();
        let user = store.create(KEY, KEY, 10).unwrap();
        let (device, token) = store.pair_device(&user.id, "old", 5).unwrap();
        {
            let mut state = store.state.lock().unwrap();
            state.devices.get_mut(&device.id).unwrap().last_seen = now_ms() - 91 * 24 * 3600 * 1000;
        }
        assert_eq!(store.gc_devices(90 * 24 * 3600 * 1000), 1);
        assert!(store.device_by_token(&token).is_none());
        let (_, fresh) = store.pair_device(&user.id, "new", 5).unwrap();
        assert_eq!(store.gc_devices(90 * 24 * 3600 * 1000), 0);
        assert!(store.device_by_token(&fresh).is_some());
    }

    #[test]
    fn ids_and_names_are_sanitized() {
        assert!(new_id('w').starts_with("w_"));
        assert_eq!(sanitize_name("  \u{1}x\u{7}"), "x");
        assert_eq!(sanitize_name("   "), "phone");
    }
}
