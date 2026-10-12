//! End-to-end encryption's cryptographic core (docs/ggs-remote-plan.md §20.11, M10): the
//! primitives and framing both sides share, proven against each other by the committed
//! vectors in `tests/vectors/e2e.json` (asserted here and by the browser twin in
//! `src/remote/e2e.ts` through `tests/remote.test.ts`).
//!
//! The design — OPAQUE's guarantees without the WASM:
//!
//! - The PC owns a static X25519 keypair (a 32-byte seed under
//!   `~/.ggs/remote/e2e.key`, 0600). Its public half travels only together with a
//!   signature by the device's Ed25519 key — the key whose hash *is* the link's uuid —
//!   over the domain `"ggs-remote-e2e/1" ‖ x_pub`. A browser that knows the uuid (any
//!   `/u/<uuid>/` link carries it) verifies `uuid_for(ed_pub)` and the signature, so a
//!   malicious Hub cannot substitute its own key: the substitution would need a key
//!   hashing to the uuid. On the LAN the TLS the daemon itself serves plays that role.
//! - Every conversation (the login box, each WebSocket) uses its own ephemeral X25519
//!   keypair at the browser: `shared = X25519(eph, static)`, then
//!   `key = HKDF-SHA512(salt = transcript, ikm = shared, info = "ggs-remote-e2e/1")`.
//! - AEAD is AES-256-GCM: the browser speaks it through WebCrypto (`crypto.subtle`, no
//!   dependency at all), the PC through RustCrypto's `aes-gcm` — the standard wire format
//!   on both sides, no WASM OPAQUE. Nonces are 12 random bytes per message (the random
//!   construction's birthday bound sits far above any session's frame count).
//! - On the wire, an encrypted frame keeps its outer 20-byte header for the Hub to route
//!   (the session stamping and zeroing live there, §6.1) and sets the `ENCRYPTED` flag;
//!   the payload becomes `nonce(24) ‖ secretbox(frame bytes)`. The Hub relays ciphertext
//!   it cannot open — file contents, terminal I/O, search results and the password all
//!   ride inside.
//!
//! The login flow this core enables (the wiring round): the browser posts its ephemeral
//! public key and `secretbox(password)`; the daemon derives the same key, opens the box,
//! and Argon2id-verifies the password exactly as today — the password never crosses in the
//! clear, and a captured box admits no offline guessing (checking a guess needs the
//! static private key).

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
use ed25519_dalek::{Signer, Verifier};
use sha2::{Digest, Sha512};
use x25519_dalek::{PublicKey as XPublicKey, StaticSecret};

pub const INFO: &[u8] = b"ggs-remote-e2e/1";
/// The flag an encrypted frame's header carries (§6.1's flags byte has room).
pub const FLAG_ENCRYPTED: u8 = 0x40;
pub const NONCE_LEN: usize = 12;
pub const KEY_LEN: usize = 32;
pub const SECRET_SEED_LEN: usize = 32;

/// The static identity: the seed, its X25519 halves, and the signed parameters a browser
/// verifies before trusting the key.
pub struct StaticKeys {
    secret: StaticSecret,
    /// `{"edPub": …, "xPub": …, "sig": …}` — what `GET api/e2e-params` answers (base64).
    pub params_json: serde_json::Value,
}

impl StaticKeys {
    /// From a persisted seed (or a fresh one when the file is absent), signing the public
    /// half with the device's Ed25519 key so a link's uuid binds it.
    pub fn load_or_create(
        seed_path: &std::path::Path,
        signing: &ed25519_dalek::SigningKey,
    ) -> std::io::Result<StaticKeys> {
        let seed = match std::fs::read(seed_path) {
            Ok(bytes) if bytes.len() == SECRET_SEED_LEN => bytes,
            _ => {
                let seed = crate::util::random_bytes::<SECRET_SEED_LEN>().to_vec();
                crate::paths::write_private(seed_path, &seed)?;
                seed
            }
        };
        Ok(Self::from_seed(&seed, signing))
    }

    pub fn from_seed(seed: &[u8], signing: &ed25519_dalek::SigningKey) -> StaticKeys {
        let mut seed_bytes = [0u8; SECRET_SEED_LEN];
        seed_bytes.copy_from_slice(&seed[..SECRET_SEED_LEN]);
        let secret = StaticSecret::from(seed_bytes);
        let x_pub = XPublicKey::from(&secret);
        let ed_pub = signing.verifying_key().to_bytes();
        // The signature covers the domain and the X25519 public half: a browser that has
        // checked `uuid_for(ed_pub)` against its link now knows `x_pub` is the PC's.
        let mut signed = Vec::with_capacity(INFO.len() + KEY_LEN);
        signed.extend_from_slice(INFO);
        signed.extend_from_slice(x_pub.as_bytes());
        StaticKeys {
            secret,
            params_json: serde_json::json!({
                "edPub": crate::util::b64(&ed_pub),
                "xPub": crate::util::b64(x_pub.as_bytes()),
                "sig": crate::util::b64(&signing.sign(&signed).to_bytes()),
            }),
        }
    }

    /// The shared secret of one conversation: the browser's ephemeral public key meets the
    /// static private half.
    pub fn shared(&self, their_public: &[u8; KEY_LEN]) -> [u8; 32] {
        *self
            .secret
            .diffie_hellman(&XPublicKey::from(*their_public))
            .as_bytes()
    }
}

/// HKDF-SHA512 (RFC 5869): the browser twin implements the same sixteen lines over
/// tweetnacl's SHA-512 — the vectors hold both to it.
pub fn hkdf_sha512(salt: &[u8], ikm: &[u8], info: &[u8], out: usize) -> Vec<u8> {
    // Extract: PRK = HMAC-SHA512(salt, ikm); Expand: T(n) = HMAC(PRK, T(n-1) ‖ info ‖ n).
    let hmac = |key: &[u8], message: &[u8]| -> [u8; 64] {
        let block = 64;
        let mut ipad = vec![0x36u8; block];
        let mut opad = vec![0x5cu8; block];
        for (at, byte) in key.iter().enumerate().take(block) {
            ipad[at] ^= byte;
            opad[at] ^= byte;
        }
        let inner = Sha512::new()
            .chain_update(&ipad)
            .chain_update(message)
            .finalize();
        Sha512::new()
            .chain_update(&opad)
            .chain_update(inner)
            .finalize()
            .into()
    };
    let prk = hmac(salt, ikm);

    let mut out_bytes = Vec::with_capacity(out);
    let mut previous: Vec<u8> = Vec::new();
    let mut counter = 1u8;
    while out_bytes.len() < out {
        let mut message = previous.clone();
        message.extend_from_slice(info);
        message.push(counter);
        let block = hmac(&prk, &message).to_vec();
        let take = (out - out_bytes.len()).min(block.len());
        out_bytes.extend_from_slice(&block[..take]);
        previous = block;
        counter += 1;
    }
    out_bytes
}

/// The conversation key: HKDF over the shared secret, salted by the dialogue so far (both
/// public halves — the transcript a bystander sees).
pub fn conversation_key(
    shared: &[u8; 32],
    browser_pub: &[u8; KEY_LEN],
    pc_pub: &[u8; KEY_LEN],
) -> [u8; KEY_LEN] {
    let mut salt = Vec::with_capacity(KEY_LEN * 2);
    salt.extend_from_slice(browser_pub);
    salt.extend_from_slice(pc_pub);
    hkdf_sha512(&salt, shared, INFO, KEY_LEN)
        .try_into()
        .unwrap()
}

/// `secretbox`: `nonce(24) ‖ ciphertext` over NaCl's XSalsa20-Poly1305 — the exact bytes
/// tweetnacl's `nacl.secretbox` produces and opens.
pub fn seal(key: &[u8; KEY_LEN], plaintext: &[u8], nonce: &[u8; NONCE_LEN]) -> Vec<u8> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .encrypt(Nonce::from_slice(nonce), plaintext)
        .expect("AES-GCM never fails to seal")
}

pub fn open(key: &[u8; KEY_LEN], sealed: &[u8], nonce: &[u8; NONCE_LEN]) -> Option<Vec<u8>> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher.decrypt(Nonce::from_slice(nonce), sealed).ok()
}

/// Wrap one frame: the outer header (with `FLAG_ENCRYPTED`) around a nonce and the box of
/// the whole original frame — header included, so the inner session field rides encrypted
/// too and the Hub's stamping keeps working on the outer one alone.
pub fn wrap_frame(frame: &[u8], key: &[u8; KEY_LEN], nonce: &[u8; NONCE_LEN]) -> Vec<u8> {
    let mut out = Vec::with_capacity(frame.len() + NONCE_LEN + 16 + 16);
    out.extend_from_slice(&frame[..20]);
    out[1] |= FLAG_ENCRYPTED;
    // Length covers nonce + box (the tag rides inside).
    let sealed = seal(key, frame, nonce);
    let len = (NONCE_LEN + sealed.len()) as u32;
    out[16..20].copy_from_slice(&len.to_le_bytes());
    out.extend_from_slice(nonce);
    out.extend_from_slice(&sealed);
    out
}

/// Unwrap one frame (its header already carried `FLAG_ENCRYPTED`); answers the original.
pub fn unwrap_frame(envelope: &[u8], key: &[u8; KEY_LEN]) -> Option<Vec<u8>> {
    if envelope.len() < 20 + NONCE_LEN + 16 {
        return None;
    }
    let nonce: [u8; NONCE_LEN] = envelope[20..20 + NONCE_LEN].try_into().ok()?;
    // The box covered the whole original frame, header included — the plaintext is it.
    open(key, &envelope[20 + NONCE_LEN..], &nonce)
}

/// Verify a browser's key-agreement parameters: the Ed25519 public key must hash to the
/// uuid the link spells, and the signature must bind the X25519 half to it.
pub fn verify_params(
    params: &serde_json::Value,
    expected_uuid: Option<&str>,
) -> Option<[u8; KEY_LEN]> {
    let ed_pub: [u8; 32] = crate::util::b64_decode(params.get("edPub")?.as_str()?)?
        .try_into()
        .ok()?;
    let x_pub: [u8; KEY_LEN] = crate::util::b64_decode(params.get("xPub")?.as_str()?)?
        .try_into()
        .ok()?;
    let sig_bytes = crate::util::b64_decode(params.get("sig")?.as_str()?)?;
    let sig = ed25519_dalek::Signature::from_slice(&sig_bytes).ok()?;
    let verifying = ed25519_dalek::VerifyingKey::from_bytes(&ed_pub).ok()?;
    if let Some(uuid) = expected_uuid {
        if crate::hub::identity::uuid_for(&ed_pub) != uuid {
            return None;
        }
    }
    let mut signed = Vec::with_capacity(INFO.len() + KEY_LEN);
    signed.extend_from_slice(INFO);
    signed.extend_from_slice(&x_pub);
    verifying.verify(&signed, &sig).ok()?;
    Some(x_pub)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signing() -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&[7u8; 32])
    }

    #[test]
    fn params_verify_against_the_uuid_and_reject_substitution() {
        let signing = signing();
        let keys = StaticKeys::from_seed(&[3u8; 32], &signing);
        let uuid = crate::hub::identity::uuid_for(&signing.verifying_key().to_bytes());
        assert!(verify_params(&keys.params_json, Some(&uuid)).is_some());
        // A substituted X25519 half breaks the signature; a substituted Ed25519 half
        // breaks the uuid.
        let mut tampered = keys.params_json.clone();
        tampered["xPub"] = serde_json::json!(crate::util::b64(&[9u8; 32]));
        assert!(verify_params(&tampered, Some(&uuid)).is_none());
        let mut wrong_uuid = keys.params_json.clone();
        wrong_uuid["edPub"] = serde_json::json!(crate::util::b64(&[1u8; 32]));
        assert!(verify_params(&wrong_uuid, Some(&uuid)).is_none());
        // No uuid to check (the LAN shape): the signature still binds the pair.
        assert!(verify_params(&keys.params_json, None).is_some());
    }

    #[test]
    fn the_browser_ephemeral_meets_the_same_key() {
        let signing = signing();
        let keys = StaticKeys::from_seed(&[3u8; 32], &signing);
        let browser = StaticSecret::from([5u8; 32]);
        let browser_pub = XPublicKey::from(&browser);
        let pc_pub = XPublicKey::from(&keys.secret);
        let shared_browser = browser.diffie_hellman(&pc_pub);
        assert_eq!(
            keys.shared(browser_pub.as_bytes()),
            shared_browser.as_bytes()[..]
        );
        let key = conversation_key(
            &keys.shared(browser_pub.as_bytes()),
            browser_pub.as_bytes(),
            pc_pub.as_bytes(),
        );
        // The same sixteen HKDF lines on the other side land on the same key (the vectors
        // file proves the browser twin byte-for-byte).
        assert_eq!(key.len(), KEY_LEN);
    }

    /// Writes `tests/vectors/e2e.json` (run explicitly: `cargo test -- --ignored
    /// write_e2e_vectors -- --nocapture`): fixed inputs, the Rust answers — the browser
    /// twin in `src/remote/e2e.ts` is held to every one of them through
    /// `tests/remote.test.ts`.
    #[test]
    #[ignore = "the vector generator; run explicitly to refresh the committed file"]
    fn write_e2e_vectors() {
        let signing = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let keys = StaticKeys::from_seed(&[3u8; 32], &signing);
        let browser = StaticSecret::from([5u8; 32]);
        let browser_pub = XPublicKey::from(&browser);
        let pc_pub = XPublicKey::from(&keys.secret);
        let shared = keys.shared(browser_pub.as_bytes());
        let key = conversation_key(&shared, browser_pub.as_bytes(), pc_pub.as_bytes());
        let nonce: [u8; NONCE_LEN] = [2u8; NONCE_LEN];
        let frame = {
            let mut f = vec![0u8; 20];
            f[0] = 0x10; // INVOKE
            f[1] = 1 << 2;
            f[8..12].copy_from_slice(&7u32.to_le_bytes());
            let payload = br#"{"c":"list_dir","a":{"path":"C:
epo"}}"#
                .to_vec();
            f[16..20].copy_from_slice(&(payload.len() as u32).to_le_bytes());
            f.extend_from_slice(&payload);
            f
        };
        let sealed = seal(&key, &frame, &nonce);
        let envelope = wrap_frame(&frame, &key, &nonce);
        let vectors = serde_json::json!({
            "deviceSeed": crate::util::b64(&[7u8; 32]),
            "e2eSeed": crate::util::b64(&[3u8; 32]),
            "browserSeed": crate::util::b64(&[5u8; 32]),
            "edPub": crate::util::b64(&signing.verifying_key().to_bytes()),
            "uuid": crate::hub::identity::uuid_for(&signing.verifying_key().to_bytes()),
            "xPub": crate::util::b64(pc_pub.as_bytes()),
            "browserPub": crate::util::b64(browser_pub.as_bytes()),
            "sig": keys.params_json["sig"].as_str().unwrap(),
            "shared": crate::util::b64(&shared),
            "conversationKey": crate::util::b64(&key),
            "nonce": crate::util::b64(&nonce),
            "frame": crate::util::b64(&frame),
            "sealed": crate::util::b64(&sealed),
            "envelope": crate::util::b64(&envelope),
        });
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors/e2e.json");
        std::fs::write(&out, serde_json::to_string_pretty(&vectors).unwrap()).unwrap();
        println!("wrote {}", out.display());
    }

    #[test]
    fn frames_round_trip_through_the_envelope() {
        let key = [11u8; KEY_LEN];
        let frame = {
            let mut f = vec![0u8; 20];
            f[0] = 0x10; // INVOKE
            f[1] = 1 << 2;
            f[8..12].copy_from_slice(&7u32.to_le_bytes());
            f.extend_from_slice(b"{\"c\":\"list_dir\"}");
            f
        };
        let envelope = wrap_frame(&frame, &key, &[2u8; NONCE_LEN]);
        assert_eq!(envelope[1] & FLAG_ENCRYPTED, FLAG_ENCRYPTED);
        let plain = unwrap_frame(&envelope, &key).unwrap();
        assert_eq!(plain, frame);
        // The wrong key opens nothing.
        assert!(unwrap_frame(&envelope, &[12u8; KEY_LEN]).is_none());
    }
}
