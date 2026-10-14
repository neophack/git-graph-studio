//! ggs-git (L1, module 9's foundation): the ONLY git-CLI surface of the app —
//! `locate` (where Git and Git Bash live on this machine) and `runner` (the one
//! spawn point, the output log, the ref/hash validators, the fetch builder and the
//! spawn PATH every extension backend inherits).
//! Principle 2 of the development plan (§3.2) lands here: every git read and write
//! crosses this crate, never a bare spawn.
//!
//! Allowed dependencies: ggs-base, winreg (Windows). No network, no tauri.
//! No global mutable state (the located-install cache is a process-wide OnceLock,
//! listed here: `locate::find_git_exe` memoises nothing today — each caller resolves).

pub mod locate;
#[cfg(test)]
mod testkit_ext;
pub mod ops;
pub mod revision;
pub mod runner;
