//! The persistent workspace symbol database (plan M4): the compact on-disk index behind
//! Go-to-Definition, Find References, Quick Open's symbol modes and the Call Tree. The
//! extraction layer reuses the viewer's outline scan (a real parser layer stays open — see
//! the plan's M4.1); what this module adds is the storage: interned names, per-file
//! fingerprints and per-name occurrence lists under `~/.ggs/index/`, so a restart resumes
//! instead of rebuilding, and a watcher batch updates single files instead of the world.

pub mod store;
