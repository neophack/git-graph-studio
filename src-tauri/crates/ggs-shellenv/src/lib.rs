//! ggs-shellenv (L1, module 18's app-side half): the Terminal Shell setting and its
//! outward environment — which shell the integrated terminal opens and the bridged
//! claude-code backend drives (Git for Windows' own Git Bash found-never-typed, GGS
//! Bash standing in, PowerShell), the `~/.ggs/shell/bash[.exe]` copy Claude Code's
//! basename whitelist accepts, and the exact `CLAUDE_CODE_*` pairs the spawn env
//! carries. A Windows-shaped concern that reads harmlessly everywhere else.
//!
//! Allowed dependencies: ggs-git (locate's bash_name and Git-Bash discovery),
//! serde_json (the settings read). No global state.

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


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_broken_settings_file_is_the_default() {
        let home = tempfile::TempDir::new().unwrap();
        assert_eq!(preference(home.path()), ShellPreference::GitBash);
        std::fs::create_dir_all(home.path().join(".ggs")).unwrap();
        std::fs::write(home.path().join(".ggs").join("settings.json"), "{ not json").unwrap();
        assert_eq!(preference(home.path()), ShellPreference::GitBash);
    }
    #[test]
    fn the_persisted_choice_is_read_verbatim() {
        let home = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(home.path().join(".ggs")).unwrap();
        std::fs::write(
            home.path().join(".ggs").join("settings.json"),
            r#"{ "theme": "nord", "terminalShell": "powershell" }"#,
        )
        .unwrap();
        assert_eq!(preference(home.path()), ShellPreference::PowerShell);
        // The explicit GGS Bash choice is read the same way.
        std::fs::write(
            home.path().join(".ggs").join("settings.json"),
            r#"{ "terminalShell": "ggsBash" }"#,
        )
        .unwrap();
        assert_eq!(preference(home.path()), ShellPreference::GgsBash);
        // An unknown value falls back to the default — Git Bash since 2026-10-13 —
        // never errors.
        std::fs::write(
            home.path().join(".ggs").join("settings.json"),
            r#"{ "terminalShell": "cmd" }"#,
        )
        .unwrap();
        assert_eq!(preference(home.path()), ShellPreference::GitBash);
    }
    #[test]
    fn the_claude_env_names_the_shell_only_when_it_exists() {
        let bash = Path::new("/apps/bash.exe");
        let env = claude_shell_env(ShellPreference::GgsBash, Some(bash));
        let mut expected = vec![
            (
                "CLAUDE_CODE_GIT_BASH_PATH".to_owned(),
                "/apps/bash.exe".to_owned(),
            ),
            ("MSYSTEM".to_owned(), "MINGW64".to_owned()),
            ("SHELL".to_owned(), "/apps/bash.exe".to_owned()),
        ];
        if cfg!(windows) {
            expected.push(("CLAUDE_CODE_USE_POWERSHELL_TOOL".to_owned(), "0".to_owned()));
        }
        assert_eq!(env, expected);
        // The Git Bash choice names the located Git for Windows bash with exactly the
        // same pairs — one bash environment shape, whichever bash was picked.
        assert_eq!(
            claude_shell_env(ShellPreference::GitBash, Some(bash)),
            expected
        );
        // The PowerShell choice pins the git bash path EMPTY — not merely absent
        // from the pairs, but overridden against whatever the app's own environment
        // carried — and turns the PowerShell tool on (Windows): the user asked for
        // PowerShell, so the tool is primary and no bash path may survive.
        let powershell = claude_shell_env(ShellPreference::PowerShell, Some(bash));
        if cfg!(windows) {
            assert_eq!(
                powershell,
                vec![
                    ("CLAUDE_CODE_GIT_BASH_PATH".to_owned(), "".to_owned()),
                    ("CLAUDE_CODE_USE_POWERSHELL_TOOL".to_owned(), "1".to_owned()),
                ]
            );
        } else {
            assert!(powershell.is_empty());
        }
        // A shell that did not resolve adds nothing for either bash choice — never
        // point at a shell that is not there; the PowerShell choice needs no resolved
        // shell (PowerShell itself is the thing being chosen).
        assert!(claude_shell_env(ShellPreference::GgsBash, None).is_empty());
        assert!(claude_shell_env(ShellPreference::GitBash, None).is_empty());
        if !cfg!(windows) {
            assert!(claude_shell_env(ShellPreference::PowerShell, None).is_empty());
        }
    }
    /// The injected path must carry the basename Claude Code's whitelist accepts —
    /// the sidecar's own `ggs-bash` name is rejected as "not a bash/sh binary", which
    /// is the bug this copy exists to fix.
    #[test]
    fn the_bash_copy_lands_under_the_ggs_home_and_keeps_the_sidecars_bytes() {
        let home = tempfile::TempDir::new().unwrap();
        let sidecar_dir = tempfile::TempDir::new().unwrap();
        let sidecar = sidecar_dir.path().join("ggs-bash.exe");
        std::fs::write(&sidecar, b"#!/ggs-bash\n").unwrap();

        let bash = ensure_bash_exe(home.path(), &sidecar).expect("the copy materialises");
        assert_eq!(bash.file_name().unwrap(), bash_name());
        assert!(bash.starts_with(home.path().join(".ggs").join("shell")));
        assert_eq!(
            std::fs::read(&bash).unwrap(),
            std::fs::read(&sidecar).unwrap()
        );
        // No staging leftovers, and a second pass is an idempotent no-op.
        let shell_dir = home.path().join(".ggs").join("shell");
        let entries: Vec<_> = std::fs::read_dir(&shell_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from(bash_name())]);
        assert_eq!(
            ensure_bash_exe(home.path(), &sidecar).as_deref(),
            Some(bash.as_path())
        );

        // A replaced build (different bytes) refreshes the copy.
        std::fs::write(&sidecar, b"#!/ggs-bash v2, longer\n").unwrap();
        let refreshed = ensure_bash_exe(home.path(), &sidecar).expect("the copy refreshes");
        assert_eq!(refreshed, bash);
        assert_eq!(std::fs::read(&bash).unwrap(), b"#!/ggs-bash v2, longer\n");
    }
    /// A sidecar that is not there leaves nothing behind to point at.
    #[test]
    fn a_missing_sidecar_materialises_nothing() {
        let home = tempfile::TempDir::new().unwrap();
        let sidecar = home.path().join("nowhere").join("ggs-bash.exe");
        assert!(ensure_bash_exe(home.path(), &sidecar).is_none());
        assert!(!home.path().join(".ggs").join("shell").exists());
    }
}
