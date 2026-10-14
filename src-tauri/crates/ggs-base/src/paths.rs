//! The `~/.ggs` layout — the ONE place that computes it. Every user-data path in every
//! crate resolves through here, so `GGS_HOME` (the relocation a sandboxed probe or a test
//! instance sets) is honoured uniformly and the layout can never fork between modules.

use std::path::PathBuf;

/// The user-level GGS home: `$GGS_HOME` when set (the relocation every user-data path
/// honours — a sandboxed instance or probe moves the whole store), else `~/.ggs`.
pub fn ggs_home() -> PathBuf {
    if let Some(root) = std::env::var_os("GGS_HOME") {
        if !root.is_empty() {
            return PathBuf::from(root);
        }
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home).join(".ggs")
}

fn joined(rel: &str) -> Result<PathBuf, String> {
    if std::env::var_os("GGS_HOME").is_none()
        && std::env::var_os("HOME").is_none()
        && std::env::var_os("USERPROFILE").is_none()
    {
        return Err("no user home directory".to_string());
    }
    Ok(ggs_home().join(rel))
}

/// `~/.ggs/settings.json`.
pub fn settings_file() -> Result<PathBuf, String> {
    joined("settings.json")
}

/// `~/.ggs/keybindings.json`.
pub fn keybindings_file() -> Result<PathBuf, String> {
    joined("keybindings.json")
}

/// `~/.ggs/extensions`, created if missing — the extension store directory itself. The
/// one-time app-data migration and the test pinning stay with the store's owner
/// (cmd_ext today, ggs-ext's `store` from P3-9).
pub fn extensions_home() -> Result<PathBuf, String> {
    let dir = joined("extensions")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// `~/.ggs/index`, created if missing — the persistent symbol index home.
pub fn index_home() -> Result<PathBuf, String> {
    let dir = joined("index")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// `~/.ggs/logs`, created on demand (None is never returned silently: the caller gets
/// the error string and decides how to degrade).
pub fn logs_home() -> Result<PathBuf, String> {
    let dir = joined("logs")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// `~/.ggs/backups`, created if missing — the editor's backup store.
pub fn backups_home() -> Result<PathBuf, String> {
    let dir = joined("backups")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// `~/.ggs/cache`, created if missing — the bytecode cache and other regenerable data.
pub fn cache_home() -> Result<PathBuf, String> {
    let dir = joined("cache")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// `~/.ggs/extension-data/<id>` — one extension's own persisted state.
pub fn extension_data(ext_id: &str) -> Result<PathBuf, String> {
    joined(&format!("extension-data/{ext_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ggs_home_honours_relocation_first() {
        // SAFETY: a test-scoped env mutation; every other test in this crate runs
        // without reading these keys after this test completes (serial enough by the
        // test runner's single-threaded default for a crate this small).
        std::env::set_var("GGS_HOME", "/tmp/ggs-base-test-home");
        assert_eq!(ggs_home(), PathBuf::from("/tmp/ggs-base-test-home"));
        assert_eq!(
            extensions_home().unwrap(),
            PathBuf::from("/tmp/ggs-base-test-home/extensions")
        );
        std::env::remove_var("GGS_HOME");
    }
}
