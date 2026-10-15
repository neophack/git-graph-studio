//! ggs-git::locate (L1, modules 9/18's shared seam): where Git lives on this machine —
//! the one `find_git_exe` answer the app's git runner, the extension backends' spawn
//! PATH and GGS Bash's own `git` all ride (2026-10-14: a Git installed to a custom
//! directory the PATH never names still answers), and where Git for Windows' own bash
//! is (the found-never-typed Git Bash the Terminal Shell setting names). Windows does
//! the work (registry InstallPath, standard roots, PATH scans); every other platform
//! answers None — the bare spawn already finds git there.
//!
//! Pure std + winreg (Windows) — no repository access here; the runner lives beside
//! this in `runner` (P2-6).

use std::path::PathBuf;
// Every `Path` use below sits in a `#[cfg(windows)]` item; on the other targets the
// plain import is an unused-imports error under `-D warnings`.
#[cfg(windows)]
use std::path::Path;

/// The file name Claude Code's Windows shell picker accepts for
/// `CLAUDE_CODE_GIT_BASH_PATH`: it whitelist-checks the *basename* — exactly
/// `bash.exe` / `sh.exe` / `bash` / `sh` (claude-code 2.1.296 rejects anything else
/// with "is not a bash/sh binary; falling back to auto-detection") — so the bundled
/// `ggs-bash` can never pass as itself, however the path is spelled.
pub fn bash_name() -> &'static str {
    if cfg!(windows) {
        "bash.exe"
    } else {
        "bash"
    }
}

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
/// order they are tried. Shared by the bash lookup ([`find_git_bash`]), the executable
/// lookup ([`find_git_exe`]) and the shell's Git Bash `usr\bin` fallback (`exec.rs`).
#[cfg(windows)]
pub fn git_install_roots() -> Vec<PathBuf> {
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

/// A Git installation root's `git.exe`: the `cmd` shim first — the one the "Git CMD"
/// shortcut, VS Code's Git extension and every Windows integration run, and the one
/// that sets up its own environment — then the raw `bin` and `mingw64\bin` binaries a
/// minimal or portable tree may carry instead. Pure filesystem logic, testable.
#[cfg(windows)]
pub fn git_exe_from_root(root: &Path) -> Option<PathBuf> {
    ["cmd", "bin", "mingw64/bin"]
        .into_iter()
        .map(|dir| root.join(dir).join("git.exe"))
        .find(|git| git.is_file())
}

/// The first `git.exe` a PATH names. Pure over the PATH value, so the scan is testable.
#[cfg(windows)]
fn git_exe_from_path(path_value: &std::ffi::OsStr) -> Option<PathBuf> {
    std::env::split_paths(path_value)
        .filter(|entry| !entry.as_os_str().is_empty())
        .map(|entry| entry.join("git.exe"))
        .find(|git| git.is_file())
}

/// Locate a `git.exe` on this machine (2026-10-14: a Git installed to a custom
/// directory the PATH never names — "use Git from Git Bash only" — is invisible to a
/// bare `git` spawn and to every standard-root scan). First hit wins:
///
/// 1. the `PATH` — a `git.exe` entry is the machine's own answer, exactly what
///    spawning bare `git` would have run;
/// 2. [`git_install_roots`] — the `SOFTWARE\GitForWindows\InstallPath` value Git's
///    own installer writes at any install location (HKCU for a per-user install,
///    then HKLM), then the standard install roots.
///
/// The app's git runner (`git.rs`), the extension backends' spawn PATH and the shell's
/// own `git` all ride this one answer, so one machine runs one git everywhere.
/// Windows only: `None` everywhere else — a POSIX system's `git` is on the PATH or in
/// `/usr/bin`, where the bare spawn already finds it.
#[cfg(windows)]
pub fn find_git_exe() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH").and_then(|value| git_exe_from_path(&value)) {
        return Some(path);
    }
    git_install_roots()
        .iter()
        .find_map(|root| git_exe_from_root(root))
}

/// POSIX: no Git Bash exists to find — `None` is the documented answer, and every
/// caller's own `cfg!(windows)` branch needs the name to resolve on every target
/// (2026-10-15: without this twin the ungated call sites in `ggs-providers` and the
/// app's `pty.rs` were E0425s only the Linux and macOS builds could see).
#[cfg(not(windows))]
pub fn find_git_bash() -> Option<PathBuf> {
    None
}

/// POSIX: nothing to locate beyond the PATH — `None` is the documented answer, and every
/// caller's fallback (`PathBuf::from("git")`) is the bare spawn that finds it. The
/// runner's unconditional call needs the name to exist on every target (2026-10-15: its
/// `#[cfg(windows)]`-only twin broke the Linux and macOS compiles).
#[cfg(not(windows))]
pub fn find_git_exe() -> Option<PathBuf> {
    None
}


#[cfg(test)]
mod tests {
    use super::*;

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
    #[cfg(windows)]
    #[test]
    fn a_git_root_answers_the_cmd_shim_first() {
        let root = tempfile::TempDir::new().unwrap();
        assert_eq!(git_exe_from_root(root.path()), None);
        // A minimal tree carrying only the real binary still answers.
        std::fs::create_dir_all(root.path().join("mingw64").join("bin")).unwrap();
        std::fs::write(root.path().join("mingw64").join("bin").join("git.exe"), b"").unwrap();
        assert_eq!(
            git_exe_from_root(root.path()),
            Some(root.path().join("mingw64").join("bin").join("git.exe"))
        );
        // The `cmd` shim every Windows integration runs wins once it exists.
        std::fs::create_dir_all(root.path().join("cmd")).unwrap();
        std::fs::write(root.path().join("cmd").join("git.exe"), b"").unwrap();
        assert_eq!(
            git_exe_from_root(root.path()),
            Some(root.path().join("cmd").join("git.exe"))
        );
    }
    #[cfg(windows)]
    #[test]
    fn the_exe_path_scan_takes_the_first_entry_that_carries_git() {
        let bare = tempfile::TempDir::new().unwrap();
        let with_git = tempfile::TempDir::new().unwrap();
        std::fs::write(with_git.path().join("git.exe"), b"").unwrap();
        let later = tempfile::TempDir::new().unwrap();
        std::fs::write(later.path().join("git.exe"), b"").unwrap();
        assert_eq!(
            git_exe_from_path(
                &std::env::join_paths([bare.path(), with_git.path(), later.path(),]).unwrap()
            ),
            Some(with_git.path().join("git.exe"))
        );
        assert_eq!(
            git_exe_from_path(&std::env::join_paths([bare.path()]).unwrap()),
            None
        );
    }
    /// Whatever the machine-wide lookup found — the PATH, the registry, the standard
    /// roots — it names a `git.exe` that is really there.
    #[cfg(windows)]
    #[test]
    fn a_real_machine_exe_resolution_names_a_git_that_exists() {
        if let Some(git) = find_git_exe() {
            assert!(
                git.is_file(),
                "points at a git that is not there: {}",
                git.display()
            );
            assert_eq!(git.file_name().and_then(|n| n.to_str()), Some("git.exe"));
        }
    }
}
