//! The Terminal Shell preference (module 18's half of the setting): which shell the
//! integrated terminal opens and the bridged claude-code backend drives — Git for
//! Windows' own Git Bash (the default since 2026-10-13, the owner's direction: found,
//! never shipped — its path is located at read time, and GGS Bash stands in wherever
//! none is installed), GGS Bash (the bundled shell, always there), or PowerShell. A
//! Windows-only concern (2026-10-13, the owner's direction): off Windows neither bash
//! of the setting exists — the terminal opens the system's own shell and Claude Code's
//! POSIX picker serves itself, so the consumers inject nothing. The backend side reads
//! the choice from `~/.ggs/settings.json` the way `cmd_app::stored_locale` does (a
//! raw, tolerant parse — a missing or broken file is the default, never an error),
//! because the spawn path has no app handle.

use std::path::{Path, PathBuf};

use ggs_git::locate::bash_name;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellPreference {
    PowerShell,
    GgsBash,
    GitBash,
}

/// The `terminalShell` value persisted by the Settings dialog; anything else — a
/// missing file, a broken JSON, an unknown value — is the Git Bash default (the
/// owner's 2026-10-13 direction: Git Bash where it is installed, GGS Bash standing
/// in where it is not; GGS Bash itself was the 2026-10-10 default).
pub fn preference(home: &Path) -> ShellPreference {
    let Ok(contents) = std::fs::read_to_string(home.join(".ggs").join("settings.json")) else {
        return ShellPreference::GitBash;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return ShellPreference::GitBash;
    };
    match value.get("terminalShell").and_then(|v| v.as_str()) {
        Some("powershell") => ShellPreference::PowerShell,
        Some("ggsBash") => ShellPreference::GgsBash,
        _ => ShellPreference::GitBash,
    }
}

/// Materialise the sidecar under the name Claude Code accepts: a copy at
/// `<home>/.ggs/shell/bash[.exe]`. Claude Code prepends that directory to every
/// child's `PATH`, so the copy is also where its shell-relative lookups land. The
/// copy is staged under a temp name and renamed into place (no reader ever sees a
/// half-written exe) and refreshed when missing, a different size than the sidecar,
/// or older than it — a replaced build must not keep serving its old bytes. A target
/// that cannot be replaced right now (Windows locks a running exe's name slot)
/// survives as the stale-but-working copy. `None` only when nothing exists to point
/// at: Claude Code then runs its own detection rather than a path that is not there.
pub fn ensure_bash_exe(home: &Path, sidecar: &Path) -> Option<PathBuf> {
    // Nothing to copy: bail before creating anything, so a broken resolution leaves
    // no empty shell dir behind.
    if !sidecar.is_file() {
        return None;
    }
    let dir = home.join(".ggs").join("shell");
    let target = dir.join(bash_name());
    let fresh = match (std::fs::metadata(sidecar), std::fs::metadata(&target)) {
        (Ok(source), Ok(current)) => {
            source.len() == current.len()
                && matches!(
                    (source.modified(), current.modified()),
                    (Ok(source), Ok(current)) if source <= current
                )
        }
        _ => false,
    };
    if fresh {
        return Some(target);
    }
    let staged = dir.join(format!(".{}.tmp-{}", bash_name(), std::process::id()));
    let staged_cleanup = |staged: &Path| {
        let _ = std::fs::remove_file(staged);
    };
    let copy = std::fs::create_dir_all(&dir)
        .and_then(|_| std::fs::copy(sidecar, &staged).map(|_| ()))
        .and_then(|_| std::fs::rename(&staged, &target));
    match copy {
        Ok(()) => Some(target),
        Err(error) => {
            staged_cleanup(&staged);
            // A rename onto a running exe fails on Windows: the old copy keeps
            // serving this backend's children, and the next spawn retries.
            if target.is_file() {
                eprintln!(
                    "[ggs-bash] refresh {}/{} kept the old copy: {error}",
                    dir.display(),
                    bash_name()
                );
                Some(target)
            } else {
                eprintln!(
                    "[ggs-bash] materialise {}/{} failed: {error}",
                    dir.display(),
                    bash_name()
                );
                None
            }
        }
    }
}

/* ---------- Git Bash (the found shell): locating Git for Windows' own bash ---------- */

/// No Git Bash exists to find outside Windows.
#[cfg(not(windows))]
pub fn find_git_bash() -> Option<PathBuf> {
    None
}

/* ---------- The git executable: one located install for the whole app ---------- */

/// No registry, no out-of-PATH install to find outside Windows.
#[cfg(not(windows))]
pub fn find_git_exe() -> Option<PathBuf> {
    None
}

/// The environment that points Claude Code at the chosen shell. With one of the bash
/// choices made and a shell that exists: its documented `CLAUDE_CODE_GIT_BASH_PATH`
/// (GGS Bash's `bash`-named copy, never the sidecar's own name — see [`bash_name`];
/// Git Bash's located `bin\bash.exe` — see [`find_git_bash`]), Git Bash's identity
/// (`MSYSTEM`), `SHELL`, and — on Windows, where claude-code 2.1.296 ships a
/// dedicated PowerShell tool that a rollout makes the model's first choice even
/// with bash present — `CLAUDE_CODE_USE_POWERSHELL_TOOL=0`, so the Bash tool is the
/// command tool. The PowerShell choice instead sets `=1` and pins
/// `CLAUDE_CODE_GIT_BASH_PATH` empty (2026-10-13, the owner's direction: after
/// switching to PowerShell no git bash path may be set): the spawn env can only add
/// pairs, and the app's own environment may carry one — a Git Bash session that
/// launched the app, a user-level experiment leftover — which the child would
/// inherit. An empty value reads as unset everywhere downstream (JS-falsy in
/// Claude Code's own read; its basename whitelist rejects it and falls back), so
/// the backend and its CLI children see no git bash path at all. Pure over the
/// inputs, so the exact bytes are testable.
pub fn claude_shell_env(preference: ShellPreference, bash: Option<&Path>) -> Vec<(String, String)> {
    let pairs: Vec<(&str, std::borrow::Cow<'_, str>)> = match (preference, bash) {
        // Whichever bash the choice resolved carries the same pairs: the path, Git
        // Bash's identity, and the PowerShell tool off.
        (ShellPreference::GgsBash | ShellPreference::GitBash, Some(path)) => {
            let mut pairs = vec![
                ("CLAUDE_CODE_GIT_BASH_PATH", path.to_string_lossy()),
                // Git Bash's own identity: tooling that asks (`uname`, `$SHELL`, MSYSTEM
                // probes) answers exactly as it does under Git Bash.
                ("MSYSTEM", std::borrow::Cow::Borrowed("MINGW64")),
                ("SHELL", path.to_string_lossy()),
            ];
            if cfg!(windows) {
                pairs.push((
                    "CLAUDE_CODE_USE_POWERSHELL_TOOL",
                    std::borrow::Cow::Borrowed("0"),
                ));
            }
            pairs
        }
        // Only Windows has the PowerShell tool to switch on; elsewhere the choice
        // stays the terminal's own and Claude Code's POSIX picker keeps its default.
        (ShellPreference::PowerShell, _) if cfg!(windows) => vec![
            // No git bash path may survive this choice — not merely absent from the
            // pairs, but overridden empty against whatever the app itself inherited.
            ("CLAUDE_CODE_GIT_BASH_PATH", std::borrow::Cow::Borrowed("")),
            (
                "CLAUDE_CODE_USE_POWERSHELL_TOOL",
                std::borrow::Cow::Borrowed("1"),
            ),
        ],
        _ => Vec::new(),
    };
    pairs
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.into_owned()))
        .collect()
}

