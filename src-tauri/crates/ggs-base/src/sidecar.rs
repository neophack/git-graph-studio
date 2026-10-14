//! Locating the app's bundled sidecar binaries (`ggs-bash`, `ggs-node`): beside the
//! app's own binary first (the installer resources place them together, and cargo's
//! output directory holds them during a build), one profile up second (a dev run
//! executes from `debug/` while `prepare.mjs` builds into `release/`), and exactly
//! where the `GGS_ENGINE_HOST` directory says last — the dev and test override.
//! Only a host that ships with the app can ever run: a package's manifest names one,
//! it never brings its own, so nothing can smuggle an executable through a backend
//! declaration.

use std::path::{Path, PathBuf};

/// Resolve an app-bundled host by name (`ggs-node`, `ggs-bash`). A name that is a
/// path is refused outright — the field names an app-bundled binary, never a location.
pub fn resolve_host(name: &str) -> Result<PathBuf, String> {
    if name
        .split(['/', '\\'])
        .any(|segment| segment == ".." || segment.is_empty())
    {
        return Err(format!("engine host name may not be a path: {name}"));
    }
    let file_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("GGS_ENGINE_HOST") {
        candidates.push(PathBuf::from(dir).join(&file_name));
    }
    if let Ok(exe_dir) = std::env::current_exe()
        .map_err(|e| format!("could not locate the app binary: {e}"))
        .and_then(|exe| {
            exe.parent()
                .map(Path::to_owned)
                .ok_or_else(|| "no parent".to_owned())
        })
    {
        candidates.push(exe_dir.join(&file_name));
        candidates.push(exe_dir.join("..").join("release").join(&file_name));
        // The cargo test layout: `debug/deps/` — the built sidecar sits one level up.
        candidates.push(exe_dir.join("..").join(&file_name));
    }
    candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .cloned()
        .ok_or_else(|| {
            format!(
                "engine host {name} not found (looked at {})",
                candidates
                    .iter()
                    .map(|c| c.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A host name that is a path is refused outright — the field names an app-bundled
    /// binary, never a location.
    #[test]
    fn a_host_name_may_not_be_a_path() {
        assert!(resolve_host("../evil").is_err());
        assert!(resolve_host("some/dir").is_err());
    }
}
