//! The access password (docs/ggs-remote-plan.md §7.6): one Argon2id hash in `auth.json`, and
//! the credential epoch every session is stamped with. Changing the password bumps the epoch,
//! which invalidates every session at once (R9); "sign out everywhere" bumps it alone.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use crate::paths::{write_private, Paths};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AuthFile {
    pub hash: String,
    pub epoch: u64,
    pub updated_at: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    TooShort,
    TooCommon,
    WrongPassword,
    NotSet,
    Io(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::TooShort => f.write_str("the password needs at least 8 characters"),
            AuthError::TooCommon => f.write_str("this password is too common"),
            AuthError::WrongPassword => f.write_str("wrong password"),
            AuthError::NotSet => f.write_str("no access password is set yet"),
            AuthError::Io(e) => write!(f, "could not save the password: {e}"),
        }
    }
}

pub struct Auth {
    file: Mutex<AuthFile>,
    path: std::path::PathBuf,
}

/// OWASP's Argon2id baseline: 19 MiB, two passes, one lane (§4.1).
fn hasher() -> Argon2<'static> {
    Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(19_456, 2, 1, None).expect("valid argon2 parameters"),
    )
}

pub fn hash_password(password: &str) -> String {
    let salt =
        SaltString::encode_b64(&crate::util::random_bytes::<16>()).expect("16-byte salt encodes");
    hasher()
        .hash_password(password.as_bytes(), &salt)
        .expect("argon2 hashing cannot fail with valid parameters")
        .to_string()
}

pub fn verify_hash(hash: &str, password: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| {
            hasher()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        })
        .unwrap_or(false)
}

/// The strength rule (§7.6): at least 8 characters, not a well-known password, not one
/// repeated character or a plain run of digits.
pub fn check_strength(password: &str) -> Result<(), AuthError> {
    if password.chars().count() < 8 {
        return Err(AuthError::TooShort);
    }
    let lower = password.to_lowercase();
    let first = lower.chars().next().unwrap_or(' ');
    if lower.chars().all(|c| c == first) {
        return Err(AuthError::TooCommon);
    }
    if is_sequential(&lower) || COMMON.contains(&lower.as_str()) {
        return Err(AuthError::TooCommon);
    }
    Ok(())
}

fn is_sequential(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.windows(2).all(|w| w[1] == w[0].wrapping_add(1))
        || bytes.windows(2).all(|w| w[1].wrapping_add(1) == w[0])
}

/// The most common leaked passwords of 8+ characters (a curated head of the public lists).
const COMMON: &[&str] = &[
    "password",
    "password1",
    "password12",
    "password123",
    "passw0rd",
    "p@ssw0rd",
    "p@ssword",
    "iloveyou",
    "12345678",
    "123456789",
    "1234567890",
    "87654321",
    "11111111",
    "00000000",
    "88888888",
    "66666666",
    "qwertyui",
    "qwertyuiop",
    "qwerty123",
    "qwerty12",
    "1q2w3e4r",
    "1q2w3e4r5t",
    "1qaz2wsx",
    "zaq12wsx",
    "asdfghjk",
    "asdfghjkl",
    "zxcvbnm1",
    "abcd1234",
    "abc12345",
    "abcdefgh",
    "a1b2c3d4",
    "aa123456",
    "sunshine",
    "princess",
    "football",
    "baseball",
    "superman",
    "starwars",
    "whatever",
    "trustno1",
    "welcome1",
    "welcome123",
    "admin123",
    "administrator",
    "letmein1",
    "changeme",
    "computer",
    "internet",
    "michelle",
    "jennifer",
    "1234qwer",
    "q1w2e3r4",
    "q1w2e3r4t5",
    "woaini1314",
    "5201314520",
    "woaini520",
    "dragon12",
    "monkey12",
    "master12",
    "shadow12",
    "football1",
    "baseball1",
    "mustang1",
    "jordan23",
    "liverpool",
    "chelsea1",
    "arsenal1",
    "pokemon1",
    "minecraft",
    "fuckyou1",
    "killer12",
    "hello123",
    "qazwsxedc",
    "1qazxsw2",
    "zxcvbnm123",
    "asd12345",
    "qwe12345",
    "123qweasd",
    "123123123",
    "12341234",
    "11223344",
    "12121212",
    "13141314",
    "147258369",
    "159357456",
    "741852963",
    "987654321",
    "123654789",
    "gitgraph",
    "gitgraphstudio",
    "ggsremote",
    "remote123",
    "github123",
];

impl Auth {
    pub fn load(paths: &Paths) -> Auth {
        let file = std::fs::read(paths.auth())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Auth {
            file: Mutex::new(file),
            path: paths.auth(),
        }
    }

    pub fn is_set(&self) -> bool {
        !self.file.lock().unwrap().hash.is_empty()
    }

    pub fn epoch(&self) -> u64 {
        self.file.lock().unwrap().epoch
    }

    /// Check a password against the stored hash. Argon2 is ~50 ms of CPU, so it runs on the
    /// blocking pool — the current-thread runtime must never stall on it.
    pub async fn verify(&self, password: &str) -> bool {
        let hash = self.file.lock().unwrap().hash.clone();
        if hash.is_empty() {
            return false;
        }
        let password = password.to_owned();
        tokio::task::spawn_blocking(move || verify_hash(&hash, &password))
            .await
            .unwrap_or(false)
    }

    /// Set or change the password: strength check, new hash, epoch + 1, atomic write. The
    /// caller (the daemon state) then clears the sessions and kicks every connection.
    pub async fn set_password(&self, password: &str) -> Result<u64, AuthError> {
        check_strength(password)?;
        let owned = password.to_owned();
        let hash = tokio::task::spawn_blocking(move || hash_password(&owned))
            .await
            .map_err(|e| AuthError::Io(e.to_string()))?;
        self.store(|file| file.hash = hash)
    }

    /// Bump the epoch alone ("sign out all devices", §7.6).
    pub fn bump_epoch(&self) -> Result<u64, AuthError> {
        self.store(|_| {})
    }

    fn store(&self, change: impl FnOnce(&mut AuthFile)) -> Result<u64, AuthError> {
        let mut file = self.file.lock().unwrap();
        let mut next = file.clone();
        change(&mut next);
        next.epoch += 1;
        next.updated_at = crate::util::now_secs();
        let json = serde_json::to_vec_pretty(&next).map_err(|e| AuthError::Io(e.to_string()))?;
        write_private(&self.path, &json).map_err(|e| AuthError::Io(e.to_string()))?;
        *file = next;
        Ok(file.epoch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_and_verify() {
        let hash = hash_password("correct horse battery");
        assert!(hash.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"));
        assert!(verify_hash(&hash, "correct horse battery"));
        assert!(!verify_hash(&hash, "correct horse battery!"));
        assert!(!verify_hash("not a hash", "x"));
    }

    #[test]
    fn strength_rules() {
        assert_eq!(check_strength("short"), Err(AuthError::TooShort));
        assert_eq!(check_strength("password"), Err(AuthError::TooCommon));
        assert_eq!(check_strength("PassWord1"), Err(AuthError::TooCommon));
        assert_eq!(check_strength("aaaaaaaaaa"), Err(AuthError::TooCommon));
        assert_eq!(check_strength("23456789"), Err(AuthError::TooCommon));
        assert_eq!(check_strength("hgfedcba"), Err(AuthError::TooCommon));
        assert!(check_strength("tangerine-kayak-42").is_ok());
    }

    #[tokio::test]
    async fn set_password_bumps_the_epoch_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
        paths.ensure().unwrap();
        let auth = Auth::load(&paths);
        assert!(!auth.is_set());
        assert!(!auth.verify("anything at all").await);
        assert_eq!(auth.set_password("tangerine-kayak-42").await, Ok(1));
        assert!(auth.verify("tangerine-kayak-42").await);
        assert_eq!(auth.bump_epoch(), Ok(2));
        let reloaded = Auth::load(&paths);
        assert_eq!(reloaded.epoch(), 2);
        assert!(reloaded.verify("tangerine-kayak-42").await);
        assert_eq!(
            reloaded.set_password("1234").await,
            Err(AuthError::TooShort)
        );
        assert_eq!(reloaded.epoch(), 2);
    }
}
