//! The PC's folder browser for a signed-in session (docs/remote-ui-redesign-plan.md §P0):
//! `GET /api/browse?path=` answers ONE directory's sub-folders — names only, never a file —
//! so a browser's "Open Folder" chooses a folder on THIS PC (the one the windows run on)
//! instead of the browser device's own disk. The answer feeds a SPAWN (or the switch to a
//! window already showing the folder); nothing here opens anything.
//!
//! The trust line is the SPAWN's own: the typed-path row (`folderInput`) already lets a
//! session open any folder by name, so listing folder names reveals nothing that row does
//! not — with `folderInput` off the browser is off too. With the security sandbox on
//! (§23) the listing is confined to the sandbox root, the same rule SPAWN enforces.

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::{error, session_of};
use crate::state::Daemon;

/// The ceiling on folders one answer carries: a directory with more is answered truncated
/// (flagged) — the phone's list is not the place to page through a hundred thousand.
const MAX_DIRS: usize = 2000;

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct BrowseQuery {
    path: String,
}

#[derive(Debug, PartialEq)]
pub enum BrowseError {
    /// The path is not absolute, or names no directory.
    NotADirectory,
    /// The sandbox is on and the path lies outside its root.
    OutsideSandbox,
}

/// One answer, as JSON: the folder shown, its parent (absent at a top — a drive root, `/`,
/// or the sandbox root), its sub-folders, and the starting places (home, the drives).
pub fn listing(
    path: &str,
    sandbox_root: Option<&Path>,
    home: Option<&Path>,
) -> Result<serde_json::Value, BrowseError> {
    let requested = path.trim();
    let dir: PathBuf = if requested.is_empty() {
        match (sandbox_root, home) {
            (Some(root), _) => {
                let _ = std::fs::create_dir_all(root);
                root.to_path_buf()
            }
            (None, Some(home)) => home.to_path_buf(),
            (None, None) => PathBuf::from(if cfg!(windows) { "C:\\" } else { "/" }),
        }
    } else {
        PathBuf::from(requested)
    };
    if !dir.is_absolute() || !dir.is_dir() {
        return Err(BrowseError::NotADirectory);
    }
    if let Some(root) = sandbox_root {
        if !crate::sandbox::folder_in_root(&dir, root) {
            return Err(BrowseError::OutsideSandbox);
        }
    }
    let mut dirs: Vec<(String, String)> = Vec::new();
    let mut truncated = false;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            // `metadata` follows a link: a junction or symlink to a folder lists as one.
            let is_dir = entry.metadata().map(|m| m.is_dir()).unwrap_or(false);
            if !is_dir {
                continue;
            }
            if dirs.len() >= MAX_DIRS {
                truncated = true;
                break;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let full = entry.path().to_string_lossy().into_owned();
            dirs.push((name, full));
        }
    }
    dirs.sort_by(|a, b| {
        a.0.to_lowercase()
            .cmp(&b.0.to_lowercase())
            .then(a.0.cmp(&b.0))
    });
    // The parent stops at a top: the filesystem's own, or the sandbox root.
    let at_sandbox_top = sandbox_root
        .map(|root| same_dir(&dir, root))
        .unwrap_or(false);
    let parent = if at_sandbox_top {
        None
    } else {
        dir.parent().map(|p| p.to_string_lossy().into_owned())
    };
    Ok(serde_json::json!({
        "path": dir.to_string_lossy(),
        "parent": parent,
        "dirs": dirs
            .into_iter()
            .map(|(name, path)| serde_json::json!({ "name": name, "path": path }))
            .collect::<Vec<_>>(),
        "truncated": truncated,
        "places": places(sandbox_root, home),
        "sandbox": sandbox_root.is_some(),
    }))
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// The starting places: the sandbox root alone when the sandbox is on; otherwise home and
/// (Windows) every present drive, or `/` elsewhere.
fn places(sandbox_root: Option<&Path>, home: Option<&Path>) -> Vec<serde_json::Value> {
    let place = |kind: &str, path: &Path| serde_json::json!({ "kind": kind, "path": path.to_string_lossy() });
    if let Some(root) = sandbox_root {
        return vec![place("sandbox", root)];
    }
    let mut list = Vec::new();
    if let Some(home) = home {
        list.push(place("home", home));
    }
    #[cfg(windows)]
    {
        // A and B are the floppy letters: a stat on a phantom one can stall for seconds.
        for letter in b'C'..=b'Z' {
            let root = PathBuf::from(format!("{}:\\", letter as char));
            if root.is_dir() {
                list.push(place("drive", &root));
            }
        }
    }
    #[cfg(not(windows))]
    list.push(place("root", Path::new("/")));
    list
}

pub async fn browse(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    Query(query): Query<BrowseQuery>,
) -> Response {
    if session_of(&daemon, &headers).is_none() {
        return error(StatusCode::UNAUTHORIZED, "no-session");
    }
    let config = daemon.config();
    if !config.folder_input {
        return error(StatusCode::FORBIDDEN, "folder-input-off");
    }
    let sandbox_root = config
        .sandbox
        .enabled
        .then(|| crate::sandbox::effective_root(&config, &daemon.paths));
    let home = crate::paths::home_dir();
    let path = query.path;
    let answer = tokio::task::spawn_blocking(move || {
        listing(&path, sandbox_root.as_deref(), home.as_deref())
    })
    .await;
    match answer {
        Ok(Ok(value)) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            value.to_string(),
        )
            .into_response(),
        Ok(Err(BrowseError::NotADirectory)) => error(StatusCode::NOT_FOUND, "not-a-directory"),
        Ok(Err(BrowseError::OutsideSandbox)) => error(StatusCode::FORBIDDEN, "outside-sandbox"),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "browse-failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::{listing, BrowseError};

    #[test]
    fn a_listing_carries_folders_only_sorted_with_the_parent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("beta")).unwrap();
        std::fs::create_dir(dir.path().join("Alpha")).unwrap();
        std::fs::write(dir.path().join("secret.txt"), b"x").unwrap();
        let value = listing(&dir.path().to_string_lossy(), None, None).unwrap();
        let names: Vec<&str> = value["dirs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            ["Alpha", "beta"],
            "files never cross, folders sort caselessly"
        );
        assert!(value["parent"].is_string());
        assert_eq!(value["sandbox"], false);
        assert!(!value.to_string().contains("secret.txt"));
    }

    #[test]
    fn relative_and_missing_paths_are_refused() {
        assert_eq!(
            listing("relative/path", None, None),
            Err(BrowseError::NotADirectory)
        );
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert_eq!(
            listing(&missing.to_string_lossy(), None, None),
            Err(BrowseError::NotADirectory)
        );
    }

    #[test]
    fn the_empty_path_starts_at_home() {
        let home = tempfile::tempdir().unwrap();
        let value = listing("", None, Some(home.path())).unwrap();
        assert_eq!(value["path"], home.path().to_string_lossy().as_ref());
        assert!(value["places"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["kind"] == "home"));
    }

    #[test]
    fn the_sandbox_confines_the_listing_and_tops_out_at_its_root() {
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("sandbox");
        std::fs::create_dir_all(root.join("workspace")).unwrap();
        // The empty path starts at the root, which has no parent to climb to.
        let value = listing("", Some(&root), None).unwrap();
        assert!(value["parent"].is_null());
        assert_eq!(value["sandbox"], true);
        let places = value["places"].as_array().unwrap();
        assert_eq!(places.len(), 1);
        assert_eq!(places[0]["kind"], "sandbox");
        // Inside is fine; outside is refused.
        assert!(listing(&root.join("workspace").to_string_lossy(), Some(&root), None).is_ok());
        assert_eq!(
            listing(&outer.path().to_string_lossy(), Some(&root), None),
            Err(BrowseError::OutsideSandbox)
        );
    }
}
