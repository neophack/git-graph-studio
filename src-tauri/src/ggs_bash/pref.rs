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

/// A Git installation root's bash: `bin\bash.exe` — the environment-setting one the
/// "Git Bash" shortcut runs — falling back to the raw `usr\bin\bash.exe` a minimal or
/// portable tree may only carry. Pure filesystem logic, so the derivation is testable.
#[cfg(windows)]
pub fn bash_from_root(root: &Path) -> Option<PathBuf> {
    let wrapper = root.join("bin").join(bash_name());
    if wrapper.is_file() {
        return Some(wrapper);
    }
    let raw = root.join("usr").join("bin").join(bash_name());
    if raw.is_file() {
        return Some(raw);
    }
    None
}

/// WSL's launcher (`<SystemRoot>\System32\bash.exe`) and the Microsoft Store's
/// app-execution shims (`...\WindowsApps\...`) also answer `bash.exe` on PATH — none
/// of them is Git Bash, and pointing a shell key at WSL's launcher would run the
/// command inside a distro, not on Windows.
#[cfg(windows)]
fn is_wsl_bash(bash: &Path) -> bool {
    let path = bash.to_string_lossy().replace('\\', "/").to_lowercase();
    path.contains("/system32/bash") || path.contains("/windowsapps/")
}

/// The Git Bash one PATH entry leads to: a `git.exe` there names the install root
/// (`<root>\cmd`, `<root>\bin` — a shim directory such as scoop's carries no tree and
/// simply does not match); a `bash.exe` there is Git Bash's own when it is not WSL's,
/// preferring the root's wrapper when the entry is its `usr\bin`.
#[cfg(windows)]
fn bash_from_path_entry(entry: &Path) -> Option<PathBuf> {
    if entry.join("git.exe").is_file() {
        if let Some(bash) = entry.parent().and_then(bash_from_root) {
            return Some(bash);
        }
    }
    let bash = entry.join(bash_name());
    if !bash.is_file() || is_wsl_bash(&bash) {
        return None;
    }
    // The entry may be the root's own `usr\bin`: one scheme level up, the wrapper
    // exists and is the better answer.
    if let Some(wrapper) = entry
        .parent()
        .and_then(Path::parent)
        .and_then(bash_from_root)
    {
        return Some(wrapper);
    }
    Some(bash)
}

/// The first Git Bash a PATH names — entries in order, first hit wins. Pure over the
/// PATH value, so the scan is testable.
#[cfg(windows)]
fn git_bash_from_path(path_value: &std::ffi::OsStr) -> Option<PathBuf> {
    std::env::split_paths(path_value)
        .filter(|entry| !entry.as_os_str().is_empty())
        .find_map(|entry| bash_from_path_entry(&entry))
}

/// Locate Git for Windows' bash.exe for the Git Bash choice (2026-10-13, the owner's
/// direction: the setting offers Git Bash too, and its path is found, never typed).
/// First hit wins:
///
/// 1. the `SOFTWARE\GitForWindows\InstallPath` value Git's own installer writes —
///    HKCU (a per-user install) then HKLM;
/// 2. the standard install roots — `%ProgramFiles%\Git`,
///    `%ProgramFiles(x86)%\Git`, `%LocalAppData%\Programs\Git`;
/// 3. the PATH — a `git.exe` or a non-WSL `bash.exe` entry names the install root
///    ([`bash_from_path_entry`]).
///
/// Windows only: `None` everywhere else — there is no Git Bash to find, and Claude
/// Code's own POSIX picker serves those platforms as it always has.
#[cfg(windows)]
pub fn find_git_bash() -> Option<PathBuf> {
    for root in git_install_roots() {
        if let Some(bash) = bash_from_root(&root) {
            return Some(bash);
        }
    }
    std::env::var_os("PATH").and_then(|path| git_bash_from_path(&path))
}

/// The install roots the registry and the environment carry, deduplicated, in the
/// order they are tried.
#[cfg(windows)]
fn git_install_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for hive in [
        winreg::enums::HKEY_CURRENT_USER,
        winreg::enums::HKEY_LOCAL_MACHINE,
    ] {
        if let Ok(install) = winreg::RegKey::predef(hive)
            .open_subkey("SOFTWARE\\GitForWindows")
            .and_then(|key| key.get_value::<String, _>("InstallPath"))
        {
            let root = PathBuf::from(install);
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
    }
    for name in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(dir) = std::env::var_os(name) {
            roots.push(PathBuf::from(dir).join("Git"));
        }
    }
    if let Some(dir) = std::env::var_os("LocalAppData") {
        roots.push(PathBuf::from(dir).join("Programs").join("Git"));
    }
    roots
}

/// No Git Bash exists to find outside Windows.
#[cfg(not(windows))]
pub fn find_git_bash() -> Option<PathBuf> {
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

    #[cfg(windows)]
    #[test]
    fn a_git_root_answers_its_wrapper_bash_and_falls_back_to_usr_bin() {
        let root = tempfile::TempDir::new().unwrap();
        assert_eq!(bash_from_root(root.path()), None);
        // A tree that only carries the raw usr/bin bash still answers it.
        std::fs::create_dir_all(root.path().join("usr").join("bin")).unwrap();
        std::fs::write(root.path().join("usr").join("bin").join(bash_name()), b"").unwrap();
        assert_eq!(
            bash_from_root(root.path()),
            Some(root.path().join("usr").join("bin").join(bash_name()))
        );
        // The wrapper one the "Git Bash" shortcut runs wins once it exists.
        std::fs::create_dir_all(root.path().join("bin")).unwrap();
        std::fs::write(root.path().join("bin").join(bash_name()), b"").unwrap();
        assert_eq!(
            bash_from_root(root.path()),
            Some(root.path().join("bin").join(bash_name()))
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_path_scan_derives_the_root_and_skips_wsl() {
        let root = tempfile::TempDir::new().unwrap();
        let wrapper = root.path().join("bin").join(bash_name());
        std::fs::create_dir_all(root.path().join("bin")).unwrap();
        std::fs::write(&wrapper, b"").unwrap();
        // `<root>\cmd\git.exe` on PATH names the root.
        std::fs::create_dir_all(root.path().join("cmd")).unwrap();
        std::fs::write(root.path().join("cmd").join("git.exe"), b"").unwrap();
        // WSL's launcher and a store shim must never be taken for Git Bash.
        let wsl = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(wsl.path().join("System32")).unwrap();
        std::fs::write(wsl.path().join("System32").join("bash.exe"), b"").unwrap();
        let store = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(store.path().join("Microsoft").join("WindowsApps")).unwrap();
        std::fs::write(
            store
                .path()
                .join("Microsoft")
                .join("WindowsApps")
                .join("bash.exe"),
            b"",
        )
        .unwrap();
        let path_value = std::env::join_paths([
            wsl.path().join("System32"),
            store.path().join("Microsoft").join("WindowsApps"),
            root.path().join("cmd"),
        ])
        .unwrap();
        assert_eq!(git_bash_from_path(&path_value), Some(wrapper.clone()));
        // The same root found through its `usr\bin` entry still prefers the wrapper.
        std::fs::create_dir_all(root.path().join("usr").join("bin")).unwrap();
        std::fs::write(root.path().join("usr").join("bin").join(bash_name()), b"").unwrap();
        let path_value = std::env::join_paths([root.path().join("usr").join("bin")]).unwrap();
        assert_eq!(git_bash_from_path(&path_value), Some(wrapper));
        // A PATH of nothing matching answers nothing.
        let path_value = std::env::join_paths([wsl.path().join("System32")]).unwrap();
        assert_eq!(git_bash_from_path(&path_value), None);
    }

    /// The machine-wide resolution, whatever it found, names a bash that is really
    /// there and carries the basename every consumer whitelist-checks.
    #[cfg(windows)]
    #[test]
    fn a_real_machine_resolution_names_a_bash_that_exists() {
        if let Some(bash) = find_git_bash() {
            assert!(
                bash.is_file(),
                "points at a shell that is not there: {}",
                bash.display()
            );
            assert_eq!(bash.file_name().and_then(|n| n.to_str()), Some(bash_name()));
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
