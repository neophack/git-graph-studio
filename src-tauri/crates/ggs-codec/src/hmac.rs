//! The keyed constructions over the hash cores: HMAC (RFC 2104) and PBKDF2
//! (RFC 8018 §5.2) — pure std, no crypto crate, which is what keeps `md-5` / `sha1` /
//! `hmac` / `pbkdf2` out of the ggs-node sidecar's dependency graph (ci-speed-plan P3 /
//! restructure P6-3): the `crypto` builtin's `pbkdf2Sync` / `createHmac` / `hkdfSync`
//! ride these.
//!
//! Every algorithm is pinned by standard vectors — RFC 2202 (HMAC-SHA1), RFC 4231
//! (HMAC-SHA256/512), RFC 6070 (PBKDF2-HMAC-SHA1) and the Josefsson PBKDF2 set
//! (SHA-256/512, byte-checked against Node's own crypto) — so the hand-written
//! implementation cannot drift from the crates it replaced.

use super::hash::{Sha1Core, Sha256Core, Sha512Core, SHA1_IV, SHA256_IV, SHA512_IV};

/// What HMAC needs from a hash core: the family's block and digest sizes, a fresh
/// instance of the standard initial state, and the absorb/finish halves of the
/// streaming cores. Sealed to this crate's three implementations.
trait Core: Clone {
    /// The compression block size — 64 for the 32-bit hashes, 128 for SHA-512.
    const BLOCK: usize;
    /// The digest length in bytes.
    const DIGEST: usize;
    fn init() -> Self;
    fn update(&mut self, data: &[u8]);
    fn finish(self) -> Vec<u8>;

    /// The plain digest of a one-shot message — [`Hmac::new`] hashes an oversized
    /// key with exactly this.
    fn once(data: &[u8]) -> Vec<u8> {
        let mut core = Self::init();
        core.update(data);
        core.finish()
    }
}

impl Core for Sha256Core {
    const BLOCK: usize = 64;
    const DIGEST: usize = 32;
    fn init() -> Self {
        Self::new(SHA256_IV)
    }
    fn update(&mut self, data: &[u8]) {
        Self::update(self, data);
    }
    fn finish(self) -> Vec<u8> {
        Self::finish(self)
    }
}

impl Core for Sha1Core {
    const BLOCK: usize = 64;
    const DIGEST: usize = 20;
    fn init() -> Self {
        Self::new(SHA1_IV)
    }
    fn update(&mut self, data: &[u8]) {
        Self::update(self, data);
    }
    fn finish(self) -> Vec<u8> {
        Self::finish(self)
    }
}

impl Core for Sha512Core {
    const BLOCK: usize = 128;
    const DIGEST: usize = 64;
    fn init() -> Self {
        Self::new(SHA512_IV)
    }
    fn update(&mut self, data: &[u8]) {
        Self::update(self, data);
    }
    fn finish(self) -> Vec<u8> {
        Self::finish(self)
    }
}

/// HMAC over one hash family, the key's inner and outer pads precomputed once
/// (RFC 2104's `K ⊕ ipad *` / `K ⊕ opad *` states). A key longer than the block is
/// hashed first, per the RFC; [`mac`] clones the two states per message, which is
/// where PBKDF2's speed comes from — its iteration loop re-hashes two short messages
/// per round and never pays the key schedule again.
struct Hmac<C: Core> {
    inner: C,
    outer: C,
}

impl<C: Core> Hmac<C> {
    fn new(key: &[u8]) -> Self {
        // The padded key block XORed into both pads as it goes — a key longer than
        // the block is hashed first (its digest is always shorter than the block),
        // exactly RFC 2104 §2's K'.
        let mut ipad = vec![0x36u8; C::BLOCK];
        let mut opad = vec![0x5cu8; C::BLOCK];
        let key_bytes: Vec<u8> = if key.len() > C::BLOCK {
            C::once(key)
        } else {
            key.to_vec()
        };
        for (index, byte) in key_bytes.iter().enumerate() {
            ipad[index] ^= byte;
            opad[index] ^= byte;
        }
        let mut inner = C::init();
        let mut outer = C::init();
        inner.update(&ipad);
        outer.update(&opad);
        Self { inner, outer }
    }

    /// HMAC(key, data) as raw digest bytes.
    fn mac(&self, data: &[u8]) -> Vec<u8> {
        let mut inner = self.inner.clone();
        inner.update(data);
        let mut outer = self.outer.clone();
        outer.update(&inner.finish());
        outer.finish()
    }
}

/// PBKDF2 over whichever HMAC family (RFC 8018 §5.2): each output block is
/// `F(P, S, c, i) = U1 ^ U2 ^ … ^ Uc`, `U1 = PRF(P, S ‖ INT(i))`, `Uj = PRF(P, Uj-1)`.
/// `iterations` follows the RFC's `c ≥ 1`; exactly `out.len()` bytes are written
/// (the caller's keylen), truncating a final partial block.
fn pbkdf2<C: Core>(prf: &Hmac<C>, salt: &[u8], iterations: u32, out: &mut [u8]) {
    debug_assert!(iterations >= 1, "PBKDF2's iteration count is at least 1 (RFC 8018)");
    for (index, chunk) in out.chunks_mut(C::DIGEST).enumerate() {
        let mut salt_block = Vec::with_capacity(salt.len() + 4);
        salt_block.extend_from_slice(salt);
        salt_block.extend_from_slice(&((index as u32 + 1).to_be_bytes()));
        let mut u = prf.mac(&salt_block);
        let mut accumulator = u.clone();
        for _ in 1..iterations {
            u = prf.mac(&u);
            for (byte, other) in accumulator.iter_mut().zip(&u) {
                *byte ^= other;
            }
        }
        chunk.copy_from_slice(&accumulator[..chunk.len()]);
    }
}

/// HMAC-SHA1 (RFC 2104) — raw digest bytes.
pub fn hmac_sha1(key: &[u8], data: &[u8]) -> Vec<u8> {
    Hmac::<Sha1Core>::new(key).mac(data)
}

/// HMAC-SHA256 (RFC 2104) — raw digest bytes; `createHmac('sha256', …)` and HKDF's
/// extract-and-expand both ride this.
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    Hmac::<Sha256Core>::new(key).mac(data)
}

/// HMAC-SHA512 (RFC 2104) — raw digest bytes.
pub fn hmac_sha512(key: &[u8], data: &[u8]) -> Vec<u8> {
    Hmac::<Sha512Core>::new(key).mac(data)
}

/// PBKDF2-HMAC-SHA1 (RFC 8018) — the digest Node's `pbkdf2Sync` names `sha1`.
pub fn pbkdf2_hmac_sha1(password: &[u8], salt: &[u8], iterations: u32, out: &mut [u8]) {
    pbkdf2(&Hmac::<Sha1Core>::new(password), salt, iterations, out)
}

/// PBKDF2-HMAC-SHA256 (RFC 8018) — the digest Node's `pbkdf2Sync` names `sha256`.
pub fn pbkdf2_hmac_sha256(password: &[u8], salt: &[u8], iterations: u32, out: &mut [u8]) {
    pbkdf2(&Hmac::<Sha256Core>::new(password), salt, iterations, out)
}

/// PBKDF2-HMAC-SHA512 (RFC 8018) — the digest Node's `pbkdf2Sync` names `sha512`.
pub fn pbkdf2_hmac_sha512(password: &[u8], salt: &[u8], iterations: u32, out: &mut [u8]) {
    pbkdf2(&Hmac::<Sha512Core>::new(password), salt, iterations, out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::to_hex;

    #[test]
    fn hmac_sha1_matches_rfc2202() {
        // The RFC's cases 1–4 and 6–7 (case 5 is truncation, which no caller here
        // asks for): short keys, the "Jefe" key, repeated-byte keys, a 25-byte
        // counting key, and keys past the 64-byte block.
        assert_eq!(
            to_hex(&hmac_sha1(&[0x0b; 20], b"Hi There")),
            "b617318655057264e28bc0b6fb378c8ef146be00"
        );
        assert_eq!(
            to_hex(&hmac_sha1(b"Jefe", b"what do ya want for nothing?")),
            "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79"
        );
        assert_eq!(
            to_hex(&hmac_sha1(&[0xaa; 20], &[0xdd; 50])),
            "125d7342b9ac11cd91a39af48aa17b4f63f175d3"
        );
        let counting: Vec<u8> = (1..=25u8).collect();
        assert_eq!(
            to_hex(&hmac_sha1(&counting, &[0xcd; 50])),
            "4c9007f4026250c6bc8414f9bf50c86c2d7235da"
        );
        assert_eq!(
            to_hex(&hmac_sha1(
                &[0xaa; 80],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "aa4ae5e15272d00e95705637ce8a3b55ed402112"
        );
        assert_eq!(
            to_hex(&hmac_sha1(
                &[0xaa; 80],
                b"Test Using Larger Than Block-Size Key and Larger Than One Block-Size Data"
            )),
            "e8e99d0f45237d786d6bbaa7965c7808bbff1a91"
        );
    }

    #[test]
    fn hmac_sha256_matches_rfc4231() {
        assert_eq!(
            to_hex(&hmac_sha256(&[0x0b; 20], b"Hi There")),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        assert_eq!(
            to_hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(
            to_hex(&hmac_sha256(&[0xaa; 20], &[0xdd; 50])),
            "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"
        );
        let counting: Vec<u8> = (1..=25u8).collect();
        assert_eq!(
            to_hex(&hmac_sha256(&counting, &[0xcd; 50])),
            "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b"
        );
        // Cases 6–7: keys past the block size hash first (a 131-byte key against
        // the 64-byte SHA-256 block).
        assert_eq!(
            to_hex(&hmac_sha256(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
        assert_eq!(
            to_hex(&hmac_sha256(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key and Larger Than One Block-Size Data - \
                  The Data Needs To Be Hashed Before Being Used"
            )),
            "55911e90f0537d3a73f6d34a9788072d3c920f20c532db222479115f39b01476"
        );
    }

    #[test]
    fn hmac_sha512_matches_rfc4231() {
        // SHA-512's block is 128 bytes, so the 131-byte keys of cases 6–7 still
        // exercise the hash-the-key-first path.
        assert_eq!(
            to_hex(&hmac_sha512(&[0x0b; 20], b"Hi There")),
            "87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cde\
             daa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854"
        );
        assert_eq!(
            to_hex(&hmac_sha512(b"Jefe", b"what do ya want for nothing?")),
            "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea250554\
             9758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737"
        );
        assert_eq!(
            to_hex(&hmac_sha512(&[0xaa; 20], &[0xdd; 50])),
            "fa73b0089d56a284efb0f0756c890be9b1b5dbdd8ee81a3655f83e33b2279d39\
             bf3e848279a722c806b485a47e67c807b946a337bee8942674278859e13292fb"
        );
        let counting: Vec<u8> = (1..=25u8).collect();
        assert_eq!(
            to_hex(&hmac_sha512(&counting, &[0xcd; 50])),
            "b0ba465637458c6990e5a8c5f61d4af7e576d97ff94b872de76f8050361ee3db\
             a91ca5c11aa25eb4d679275cc5788063a5f19741120c4f2de2adebeb10a298dd"
        );
        assert_eq!(
            to_hex(&hmac_sha512(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "80b24263c7c1a3ebb71493c1dd7be8b49b46d1f41b4aeec1121b013783f8f352\
             6b56d037e05f2598bd0fd2215d6a1e5295e64f73f63f0aec8b915a985d786598"
        );
    }

    #[test]
    fn pbkdf2_hmac_sha1_matches_rfc6070() {
        let mut out = [0u8; 20];
        pbkdf2_hmac_sha1(b"password", b"salt", 1, &mut out);
        assert_eq!(to_hex(&out), "0c60c80f961f0e71f3a9b524af6012062fe037a6");
        pbkdf2_hmac_sha1(b"password", b"salt", 2, &mut out);
        assert_eq!(to_hex(&out), "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957");
        pbkdf2_hmac_sha1(b"password", b"salt", 4096, &mut out);
        assert_eq!(to_hex(&out), "4b007901b765489abead49d926f721d065a429c1");
        // The long password/salt case, dkLen 25 — a partial final block.
        let mut out = [0u8; 25];
        pbkdf2_hmac_sha1(
            b"passwordPASSWORDpassword",
            b"saltSALTsaltSALTsaltSALTsaltSALTsalt",
            4096,
            &mut out,
        );
        assert_eq!(
            to_hex(&out),
            "3d2eec4fe41c849b80c8d83662c0e44a8b291a964cf2f07038"
        );
    }

    #[test]
    fn pbkdf2_hmac_sha256_matches_the_josefsson_vectors() {
        let mut out = [0u8; 32];
        pbkdf2_hmac_sha256(b"password", b"salt", 1, &mut out);
        assert_eq!(
            to_hex(&out),
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
        );
        pbkdf2_hmac_sha256(b"password", b"salt", 2, &mut out);
        assert_eq!(
            to_hex(&out),
            "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43"
        );
        pbkdf2_hmac_sha256(b"password", b"salt", 4096, &mut out);
        assert_eq!(
            to_hex(&out),
            "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"
        );
        // dkLen 40 crosses into a second output block, ending on a partial one.
        let mut out = [0u8; 40];
        pbkdf2_hmac_sha256(
            b"passwordPASSWORDpassword",
            b"saltSALTsaltSALTsaltSALTsaltSALTsalt",
            4096,
            &mut out,
        );
        assert_eq!(
            to_hex(&out),
            "348c89dbcbd32b2f32d814b8116e84cf2b17347ebc1800181c4e2a1fb8dd53e1c635518c7dac47e9"
        );
    }

    #[test]
    fn pbkdf2_hmac_sha512_matches_the_known_vectors() {
        // The SHA-512 set the Josefsson draft shapes cover, byte-checked against
        // Node's crypto (the same answers `pbkdf2Sync(..., 'sha512')` gives).
        let mut out = [0u8; 64];
        pbkdf2_hmac_sha512(b"password", b"salt", 1, &mut out);
        assert_eq!(
            to_hex(&out),
            "867f70cf1ade02cff3752599a3a53dc4af34c7a669815ae5d513554e1c8cf252\
             c02d470a285a0501bad999bfe943c08f050235d7d68b1da55e63f73b60a57fce"
        );
        pbkdf2_hmac_sha512(b"password", b"salt", 2, &mut out);
        assert_eq!(
            to_hex(&out),
            "e1d9c16aa681708a45f5c7c4e215ceb66e011a2e9f0040713f18aefdb866d53c\
             f76cab2868a39b9f7840edce4fef5a82be67335c77a6068e04112754f27ccf4e"
        );
        pbkdf2_hmac_sha512(b"password", b"salt", 4096, &mut out);
        assert_eq!(
            to_hex(&out),
            "d197b1b33db0143e018b12f3d1d1479e6cdebdcc97c5c0f87f6902e072f457b5\
             143f30602641b3d55cd335988cb36b84376060ecd532e039b742a239434af2d5"
        );
        // dkLen 100 — two whole blocks plus a partial third.
        let mut out = [0u8; 100];
        pbkdf2_hmac_sha512(
            b"passwordPASSWORDpassword",
            b"saltSALTsaltSALTsaltSALTsaltSALTsalt",
            4096,
            &mut out,
        );
        assert_eq!(
            to_hex(&out),
            "8c0511f4c6e597c6ac6315d8f0362e225f3c501495ba23b868c005174dc4ee71\
             115b59f9e60cd9532fa33e0f75aefe30225c583a186cd82bd4daea9724a3d3b8\
             04f75bdd41494fa324cab24bcc680fb3b96a30cf5d21fac3c2875913919f3399\
             b1d9ce7e"
        );
    }

    #[test]
    fn multi_block_pbkdf2_and_block_edge_keys_stay_right() {
        // Three output blocks whose first block matches the dkLen=32 answer — the
        // block counter and the truncation both exercised.
        let mut narrow = [0u8; 32];
        pbkdf2_hmac_sha256(b"password", b"salt", 1, &mut narrow);
        let mut wide = [0u8; 73];
        pbkdf2_hmac_sha256(b"password", b"salt", 1, &mut wide);
        assert_eq!(&wide[..32], &narrow);
        assert_eq!(
            to_hex(&wide),
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b\
             4dbf3a2f3dad3377264bb7b8e8330d4efc7451418617dabef683735361cdc18c\
             22cd7fe60fa40e91c6"
        );
        // A key exactly the block size (64) needs no hashing and no padding — the
        // boundary case of RFC 2104's key preparation.
        assert_eq!(
            to_hex(&hmac_sha256(&[0x55; 64], b"x")),
            "a05d203ff38ae1799782be564cd00c7471528a19a7fecd341005aaaae161ec31"
        );
        // An empty password still derives (Node's own answer, the shape a stray
        // `pbkdf2Sync('', …)` crosses with).
        let mut out = [0u8; 32];
        pbkdf2_hmac_sha512(b"", b"salt", 1, &mut out);
        assert_eq!(
            to_hex(&out),
            "00ef42cdbfc98d29db20976608e455567fdddf141f6eb03b5a85addd25974f5d"
        );
        // Zero-length output is legal (keylen 0) and runs no blocks at all.
        let mut none = [0u8; 0];
        pbkdf2_hmac_sha256(b"password", b"salt", 3, &mut none);
        assert!(none.is_empty());
    }
}
