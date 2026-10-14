//! ggs-codec (L0, beneath modules 18 and 19): the pure-Rust digest and archive
//! codecs — MD5 / SHA-1 / SHA-224/256 / SHA-384/512 / BLAKE2b-512 / CRC-32 / BSD-SysV
//! sums (`hash`), DEFLATE decompression and the gzip container both ways (`compress`),
//! USTAR/GNU tar reading and writing (`tar`), and the zip local-file-stream reader with
//! its one-entry lookup (`zip`). Zero dependencies — std only, byte-exact against real
//! tools (GGS Bash's parity wave pins the behaviour).
//!
//! Users: ggs-bash (every digest and archive applet), ggs-config (the daemon binary
//! out of a bundled VSIX), the app (remote_config), later ggs-node (the crypto
//! builtin's digests — ci-speed-plan P3 / restructure P6-3).
//! No global state.

pub mod compress;
pub mod hash;
pub mod tar;
pub mod zip;
