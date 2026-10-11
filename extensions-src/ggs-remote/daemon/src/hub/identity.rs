//! This PC's device identity (docs/ggs-remote-plan.md §20.1): an Ed25519 key pair whose
//! public half names the PC — the link's UUID derives from it (`ggs-remote-uuid/1`), the
//! tunnel signs the Hub's challenge with it (`ggs-hub-auth/1`). The seed sits at
//! `~/.ggs/remote/hub/device.key` (0600); the UUID derivation is byte-identical to the
//! Hub's (`identity.rs` there) and to `tests/vectors/hub-identity.json`.

use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};

use crate::paths::Paths;

pub const UUID_DOMAIN: &[u8] = b"ggs-remote-uuid/1";
pub const AUTH_DOMAIN: &[u8] = b"ggs-hub-auth/1";

/// `UUIDv8(SHA-256(domain ‖ key)[..16])`, hyphenated lowercase — the same bytes the Hub and
/// the shared vectors produce (no uuid crate: sixteen bytes, four dashes).
pub fn uuid_for(public_key: &[u8; 32]) -> String {
    let digest = Sha256::new()
        .chain_update(UUID_DOMAIN)
        .chain_update(public_key)
        .finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80; // version 8
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 9562 variant
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// The message this PC signs for a Hub: the domain, the Hub's nonce and the Hub's host — a
/// signature taken at one Hub is worthless at another.
pub fn auth_message(nonce: &[u8], host: &str) -> Vec<u8> {
    let mut message = Vec::with_capacity(AUTH_DOMAIN.len() + nonce.len() + host.len());
    message.extend_from_slice(AUTH_DOMAIN);
    message.extend_from_slice(nonce);
    message.extend_from_slice(host.as_bytes());
    message
}

/// Load the device key, creating it on first use. Answers the key and whether it was fresh.
pub fn load_or_create(paths: &Paths) -> std::io::Result<(SigningKey, bool)> {
    let path = paths.hub_device_key();
    if let Ok(bytes) = std::fs::read(&path) {
        if bytes.len() == 32 {
            return Ok((
                SigningKey::from_bytes(bytes.as_slice().try_into().unwrap()),
                false,
            ));
        }
    }
    let key = SigningKey::from_bytes(&crate::util::random_bytes::<32>());
    crate::paths::write_private(&path, &key.to_bytes())?;
    Ok((key, true))
}

/// Forget the key and make a new one: the "change link" button (§20.1) — a new UUID, the old
/// link 404s the moment the old tunnel dies.
pub fn rotate(paths: &Paths) -> std::io::Result<SigningKey> {
    let key = SigningKey::from_bytes(&crate::util::random_bytes::<32>());
    crate::paths::write_private(&paths.hub_device_key(), &key.to_bytes())?;
    Ok(key)
}

/// The export blob: the seed sealed under a key derived (Argon2id) from the access password
/// with XChaCha20-Poly1305 — `ggsr1` ‖ base64(nonce ‖ ciphertext). Importable on another PC
/// to keep the same link there (§20.1).
pub fn export_encrypted(paths: &Paths, password: &str) -> Result<String, String> {
    use base64::Engine;
    use chacha20poly1305::aead::{Aead, KeyInit, Payload};
    use chacha20poly1305::XChaCha20Poly1305;

    let (key, _) = load_or_create(paths).map_err(|e| e.to_string())?;
    let derived = derive_key(password)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&derived).expect("a 32-byte key");
    let nonce = crate::util::random_bytes::<24>();
    let sealed = cipher
        .encrypt(
            &nonce.into(),
            Payload {
                msg: &key.to_bytes(),
                aad: b"ggs-remote-device-key/1",
            },
        )
        .map_err(|_| "sealing the device key failed")?;
    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&sealed);
    Ok(format!(
        "ggsr1:{}",
        base64::engine::general_purpose::STANDARD.encode(blob)
    ))
}

/// The counterpart: verify the password, unseal, store as this PC's device key.
pub fn import_encrypted(paths: &Paths, password: &str, blob: &str) -> Result<String, String> {
    use base64::Engine;
    use chacha20poly1305::aead::{Aead, KeyInit, Payload};
    use chacha20poly1305::XChaCha20Poly1305;

    let Some(encoded) = blob.trim().strip_prefix("ggsr1:") else {
        return Err("not a GGS Remote device-key export".into());
    };
    let raw = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "the export blob is not valid base64")?;
    if raw.len() < 24 + 32 + 16 {
        return Err("the export blob is too short".into());
    }
    let (nonce, sealed) = raw.split_at(24);
    let derived = derive_key(password)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&derived).expect("a 32-byte key");
    let seed = cipher
        .decrypt(
            nonce.into(),
            Payload {
                msg: sealed,
                aad: b"ggs-remote-device-key/1",
            },
        )
        .map_err(|_| "wrong password".to_string())?;
    let seed: [u8; 32] = seed.as_slice().try_into().unwrap();
    let key = SigningKey::from_bytes(&seed);
    crate::paths::write_private(&paths.hub_device_key(), &seed).map_err(|e| e.to_string())?;
    Ok(uuid_for(&key.verifying_key().to_bytes()))
}

/// Argon2id (the same parameters the access password uses) → a 32-byte sealing key.
fn derive_key(password: &str) -> Result<[u8; 32], String> {
    let salt = b"ggs-remote-device-key-export/1";
    let mut key = [0u8; 32];
    argon2::Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| e.to_string())?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, Verifier};

    #[test]
    fn matches_the_shared_identity_vectors() {
        let raw = include_str!("../../tests/vectors/hub-identity.json");
        let vectors: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
        for v in vectors {
            let public: Vec<u8> = (0..64)
                .step_by(2)
                .map(|i| {
                    u8::from_str_radix(&v["publicKey"].as_str().unwrap()[i..i + 2], 16).unwrap()
                })
                .collect();
            assert_eq!(
                uuid_for(&public.try_into().unwrap()),
                v["uuid"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn signatures_bind_domain_nonce_and_host() {
        let signing = SigningKey::from_bytes(&[9u8; 32]);
        let nonce = [1u8; 32];
        let sig = signing.sign(&auth_message(&nonce, "remote.example.com"));
        let hub = ed25519_dalek::VerifyingKey::from(&signing);
        assert!(hub
            .verify(&auth_message(&nonce, "remote.example.com"), &sig)
            .is_ok());
        assert!(hub
            .verify(&auth_message(&nonce, "other.example.com"), &sig)
            .is_err());
    }

    #[test]
    fn export_and_import_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
        paths.ensure().unwrap();
        let (key, fresh) = load_or_create(&paths).unwrap();
        assert!(fresh);
        let uuid = uuid_for(&key.verifying_key().to_bytes());
        let blob = export_encrypted(&paths, "correct horse").unwrap();
        let back = import_encrypted(&paths, "correct horse", &blob).unwrap();
        assert_eq!(back, uuid);
        assert!(import_encrypted(&paths, "wrong", &blob).is_err());
        // A wrong prefix is refused outright.
        assert!(import_encrypted(&paths, "correct horse", "ggsr9:zz").is_err());
    }

    #[test]
    fn rotate_changes_the_link() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
        paths.ensure().unwrap();
        let (key, _) = load_or_create(&paths).unwrap();
        let before = uuid_for(&key.verifying_key().to_bytes());
        let next = rotate(&paths).unwrap();
        assert_ne!(before, uuid_for(&next.verifying_key().to_bytes()));
        let (key, _) = load_or_create(&paths).unwrap();
        assert_eq!(key.to_bytes(), next.to_bytes());
    }
}
