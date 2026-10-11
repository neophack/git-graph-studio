//! Device identity (docs/ggs-remote-plan.md §20.1, §20.6): a PC is its Ed25519 public key.
//! Its link's UUID is derived from the key — `UUIDv8(SHA-256("ggs-remote-uuid/1" ‖ key)[..16])`
//! — so the Hub stores no mapping, and a tunnel proves the UUID is its own by signing a
//! one-time challenge bound to the Hub's host name. The daemon carries the same derivation;
//! `tests/vectors/hub-identity.json` (in the daemon crate) holds both to it.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

pub const UUID_DOMAIN: &[u8] = b"ggs-remote-uuid/1";
pub const AUTH_DOMAIN: &[u8] = b"ggs-hub-auth/1";

pub fn uuid_for(public_key: &[u8; 32]) -> String {
    let digest = Sha256::new()
        .chain_update(UUID_DOMAIN)
        .chain_update(public_key)
        .finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    // The same bits the vectors' independent generator sets (RFC 9562): version 8, variant 10.
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).hyphenated().to_string()
}

/// The exact text a link path must spell (§20.1): lowercase, hyphenated, version 8, RFC 9562
/// variant — anything else is "not online", without telling why.
pub fn valid_uuid(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, c) in b.iter().enumerate() {
        let ok = match i {
            8 | 13 | 18 | 23 => *c == b'-',
            14 => *c == b'8',
            19 => matches!(c, b'8' | b'9' | b'a' | b'b'),
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        };
        if !ok {
            return false;
        }
    }
    true
}

/// The message a tunnel signs: the domain, the Hub's nonce and the Hub's host (a signature
/// made for one Hub is useless at another).
pub fn auth_message(nonce: &[u8], host: &str) -> Vec<u8> {
    let mut message = Vec::with_capacity(AUTH_DOMAIN.len() + nonce.len() + host.len());
    message.extend_from_slice(AUTH_DOMAIN);
    message.extend_from_slice(nonce);
    message.extend_from_slice(host.as_bytes());
    message
}

pub fn verify(public_key: &[u8; 32], nonce: &[u8], host: &str, signature: &[u8]) -> bool {
    let Ok(key) = VerifyingKey::from_bytes(public_key) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(signature) else {
        return false;
    };
    key.verify(&auth_message(nonce, host), &signature).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn uuids_are_v8_and_stable() {
        let key = SigningKey::from_bytes(&[7u8; 32])
            .verifying_key()
            .to_bytes();
        let a = uuid_for(&key);
        assert_eq!(a, uuid_for(&key));
        assert!(valid_uuid(&a), "{a}");
        assert_eq!(&a[14..15], "8");
        let other = SigningKey::from_bytes(&[8u8; 32])
            .verifying_key()
            .to_bytes();
        assert_ne!(a, uuid_for(&other));
    }

    #[test]
    fn rejects_other_spellings() {
        assert!(valid_uuid("3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3"));
        assert!(!valid_uuid("3F9C2A6E-8B1D-8C7A-9E45-2D6F0B8A71C3"));
        assert!(!valid_uuid("3f9c2a6e-8b1d-4c7a-9e45-2d6f0b8a71c3"));
        assert!(!valid_uuid("3f9c2a6e8b1d8c7a9e452d6f0b8a71c3"));
        assert!(!valid_uuid("3f9c2a6e-8b1d-8c7a-1e45-2d6f0b8a71c3"));
        assert!(!valid_uuid("../../etc"));
    }

    #[test]
    fn signatures_bind_the_nonce_and_the_host() {
        let signing = SigningKey::from_bytes(&[3u8; 32]);
        let public = signing.verifying_key().to_bytes();
        let nonce = [9u8; 32];
        let signature = signing
            .sign(&auth_message(&nonce, "remote.example.com"))
            .to_bytes();
        assert!(verify(&public, &nonce, "remote.example.com", &signature));
        assert!(!verify(&public, &nonce, "evil.example.com", &signature));
        assert!(!verify(
            &public,
            &[0u8; 32],
            "remote.example.com",
            &signature
        ));
        let stranger = SigningKey::from_bytes(&[4u8; 32])
            .verifying_key()
            .to_bytes();
        assert!(!verify(&stranger, &nonce, "remote.example.com", &signature));
    }

    #[test]
    fn matches_the_shared_identity_vectors() {
        let raw = include_str!("../../daemon/tests/vectors/hub-identity.json");
        let vectors: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
        for v in vectors {
            let seed: Vec<u8> = (0..64)
                .step_by(2)
                .map(|i| u8::from_str_radix(&v["seed"].as_str().unwrap()[i..i + 2], 16).unwrap())
                .collect();
            let key = SigningKey::from_bytes(&seed.try_into().unwrap())
                .verifying_key()
                .to_bytes();
            assert_eq!(uuid_for(&key), v["uuid"].as_str().unwrap());
        }
    }
}
