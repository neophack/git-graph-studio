//! The Terminal Shell preference (module 18's half of the setting): which shell the
//! integrated terminal opens and the bridged claude-code backend drives — GGS Bash
//! (the default) or PowerShell. The backend side reads it from `~/.ggs/settings.json`
//! the way `cmd_app::stored_locale` does (a raw, tolerant parse — a missing or broken
//! file is the default, never an error), because the spawn path has no app handle.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellPreference {
    PowerShell,
    GgsBash,
}

/// The `terminalShell` value persisted by the Settings dialog; anything else — a
/// missing file, a broken JSON, an unknown value — is the GGS Bash default
/// (the owner's 2026-10-10 direction: GGS Bash is the shell this app ships to be).
pub fn preference(home: &Path) -> ShellPreference {
    let Ok(contents) = std::fs::read_to_string(home.join(".ggs").join("settings.json")) else {
        return ShellPreference::GgsBash;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return ShellPreference::GgsBash;
    };
    match value.get("terminalShell").and_then(|v| v.as_str()) {
        Some("powershell") => ShellPreference::PowerShell,
        _ => ShellPreference::GgsBash,
    }
}

/// The file name Claude Code's Windows shell picker accepts for
/// `CLAUDE_CODE_GIT_BASH_PATH`: it whitelist-checks the *basename* — exactly
/// `bash.exe` / `sh.exe` / `bash` / `sh` (claude-code 2.1.296 rejects anything else
/// with "is not a bash/sh binary; falling back to auto-detection") — so the bundled
/// `ggs-bash` can never pass as itself, however the path is spelled.
fn bash_name() -> &'static str {
    if cfg!(windows) {
        "bash.exe"
    } else {
        "bash"
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
                eprintln!("[ggs-bash] refresh {}/{} kept the old copy: {error}", dir.display(), bash_name());
                Some(target)
            } else {
                eprintln!("[ggs-bash] materialise {}/{} failed: {error}", dir.display(), bash_name());
                None
            }
        }
    }
}

/// The environment that points Claude Code at the bundled shell. With GGS Bash
/// chosen and a shell that exists: its documented `CLAUDE_CODE_GIT_BASH_PATH` (the
/// `bash`-named copy, never the sidecar's own name — see [`bash_name`]), Git Bash's
/// identity (`MSYSTEM`), `SHELL`, and — on Windows, where claude-code 2.1.296 ships
/// a dedicated PowerShell tool that a rollout makes the model's first choice even
/// with bash present — `CLAUDE_CODE_USE_POWERSHELL_TOOL=0`, so the Bash tool is the
/// command tool. The PowerShell choice instead sets `=1`: the user asked for
/// PowerShell, so its tool is primary rather than left to the rollout. Pure over the
/// inputs, so the exact bytes are testable.
pub fn claude_shell_env(
    preference: ShellPreference,
    bash: Option<&Path>,
) -> Vec<(String, String)> {
    let pairs: Vec<(&str, std::borrow::Cow<'_, str>)> = match (preference, bash) {
        (ShellPreference::GgsBash, Some(path)) => {
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
        (ShellPreference::PowerShell, _) if cfg!(windows) => vec![(
            "CLAUDE_CODE_USE_POWERSHELL_TOOL",
            std::borrow::Cow::Borrowed("1"),
        )],
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
        assert_eq!(preference(home.path()), ShellPreference::GgsBash);
        std::fs::create_dir_all(home.path().join(".ggs")).unwrap();
        std::fs::write(home.path().join(".ggs").join("settings.json"), "{ not json").unwrap();
        assert_eq!(preference(home.path()), ShellPreference::GgsBash);
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
        // An unknown value falls back to the default, never errors.
        std::fs::write(
            home.path().join(".ggs").join("settings.json"),
            r#"{ "terminalShell": "cmd" }"#,
        )
        .unwrap();
        assert_eq!(preference(home.path()), ShellPreference::GgsBash);
    }

    #[test]
    fn the_claude_env_names_the_shell_only_when_it_exists() {
        let bash = Path::new("/apps/bash.exe");
        let env = claude_shell_env(ShellPreference::GgsBash, Some(bash));
        let mut expected = vec![
            ("CLAUDE_CODE_GIT_BASH_PATH".to_owned(), "/apps/bash.exe".to_owned()),
            ("MSYSTEM".to_owned(), "MINGW64".to_owned()),
            ("SHELL".to_owned(), "/apps/bash.exe".to_owned()),
        ];
        if cfg!(windows) {
            expected.push(("CLAUDE_CODE_USE_POWERSHELL_TOOL".to_owned(), "0".to_owned()));
        }
        assert_eq!(env, expected);
        // The PowerShell choice names no shell: the environment carries nothing of
        // module 18's bash, and on Windows it turns the PowerShell tool on instead —
        // the user asked for PowerShell, not for the rollout to decide.
        let powershell = claude_shell_env(ShellPreference::PowerShell, Some(bash));
        if cfg!(windows) {
            assert_eq!(
                powershell,
                vec![("CLAUDE_CODE_USE_POWERSHELL_TOOL".to_owned(), "1".to_owned())]
            );
        } else {
            assert!(powershell.is_empty());
        }
        // A shell that did not resolve adds nothing for GGS Bash — never point at a
        // shell that is not there; the PowerShell choice needs no resolved shell
        // (PowerShell itself is the thing being chosen).
        assert!(claude_shell_env(ShellPreference::GgsBash, None).is_empty());
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
        assert_eq!(std::fs::read(&bash).unwrap(), std::fs::read(&sidecar).unwrap());
        // No staging leftovers, and a second pass is an idempotent no-op.
        let shell_dir = home.path().join(".ggs").join("shell");
        let entries: Vec<_> = std::fs::read_dir(&shell_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from(bash_name())]);
        assert_eq!(ensure_bash_exe(home.path(), &sidecar).as_deref(), Some(bash.as_path()));

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
