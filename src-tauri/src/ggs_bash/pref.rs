//! The Terminal Shell preference (module 18's half of the setting): which shell the
//! integrated terminal opens and the bridged claude-code backend drives — PowerShell
//! (the default) or GGS Bash. The backend side reads it from `~/.ggs/settings.json`
//! the way `cmd_app::stored_locale` does (a raw, tolerant parse — a missing or broken
//! file is the default, never an error), because the spawn path has no app handle.

use std::path::Path;

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

/// The environment that points Claude Code at the bundled shell — its documented
/// `CLAUDE_CODE_GIT_BASH_PATH` is what the tool consults on Windows before falling
/// back to PowerShell (the failure this whole module exists to prevent). Only when the
/// preference is GGS Bash *and* the sidecar actually resolves: never point a backend
/// at a shell that is not there. Pure over the inputs, so the exact bytes are testable.
pub fn claude_shell_env(
    preference: ShellPreference,
    sidecar: Option<&Path>,
) -> Vec<(String, String)> {
    match (preference, sidecar) {
        (ShellPreference::GgsBash, Some(path)) => vec![
            (
                "CLAUDE_CODE_GIT_BASH_PATH".to_owned(),
                path.to_string_lossy().into_owned(),
            ),
            // Git Bash's own identity: tooling that asks (`uname`, `$SHELL`, MSYSTEM
            // probes) answers exactly as it does under Git Bash.
            ("MSYSTEM".to_owned(), "MINGW64".to_owned()),
            ("SHELL".to_owned(), path.to_string_lossy().into_owned()),
        ],
        _ => Vec::new(),
    }
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
        let sidecar = Path::new("/apps/ggs-bash.exe");
        let env = claude_shell_env(ShellPreference::GgsBash, Some(sidecar));
        assert_eq!(
            env,
            vec![
                (
                    "CLAUDE_CODE_GIT_BASH_PATH".to_owned(),
                    "/apps/ggs-bash.exe".to_owned()
                ),
                ("MSYSTEM".to_owned(), "MINGW64".to_owned()),
                ("SHELL".to_owned(), "/apps/ggs-bash.exe".to_owned()),
            ]
        );
        // The PowerShell choice, or a sidecar that did not resolve, adds nothing.
        assert!(claude_shell_env(ShellPreference::PowerShell, Some(sidecar)).is_empty());
        assert!(claude_shell_env(ShellPreference::GgsBash, None).is_empty());
    }
}
