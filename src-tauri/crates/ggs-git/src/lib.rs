//! ggs-git (L1, module 9's foundation): the ONLY git-CLI surface of the app —
//! `locate` (where Git and Git Bash live on this machine), `runner` (the one
//! spawn point, the output log, the ref/hash validators, the fetch builder and the
//! spawn PATH every extension backend inherits) and `diff` (the line diff the diff
//! editors render, computed by the gix engine — gix-diff's Myers + git's own slider
//! heuristics — never in the frontend).
//! Principle 2 of the development plan (§3.2) lands here: every git read and write
//! crosses this crate, never a bare spawn.
//!
//! Allowed dependencies: ggs-base, gix-diff (the diff engine only), winreg (Windows).
//! No network, no tauri.
//! No global mutable state (the located-install cache is a process-wide OnceLock,
//! listed here: `locate::find_git_exe` memoises nothing today — each caller resolves).

pub mod diff;
pub mod locate;
#[cfg(test)]
mod testkit_ext;
pub mod ops;
pub mod revision;
pub mod runner;
