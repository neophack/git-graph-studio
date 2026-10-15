//! ggs-codec (L0, beneath modules 18 and 19): the pure-Rust digest and archive
//! codecs — MD5 / SHA-1 / SHA-224/256 / SHA-384/512 / BLAKE2b-512 / CRC-32 / BSD-SysV
//! sums (`hash`), HMAC and PBKDF2 over the SHA cores (`hmac` — ggs-node's `crypto`
//! builtin rides these, which keeps the md-5 / sha1 / hmac / pbkdf2 crates out of the
//! sidecar, ci-speed-plan P3 / restructure P6-3), DEFLATE decompression and the gzip
//! container both ways (`compress`), USTAR/GNU tar reading and writing (`tar`), and
//! the zip local-file-stream reader with its one-entry lookup (`zip`). Zero
//! dependencies — std only, byte-exact against real tools and the standard test
//! vectors (GGS Bash's parity wave and the RFC sets pin the behaviour).
//!
//! Users: ggs-bash (every digest and archive applet), ggs-config (the daemon binary
//! out of a bundled VSIX), the app (remote_config), ggs-node (the crypto builtin's
//! digests, HMAC, HKDF and PBKDF2).
//! No global state.

pub mod compress;
pub mod hash;
pub mod hmac;
pub mod tar;
pub mod zip;
