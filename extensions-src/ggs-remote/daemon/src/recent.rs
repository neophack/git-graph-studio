//! The recently opened folders (the window picker's "recent paths" list, 2026-10-12): every
//! folder a GGS window registers or updates with is noted here — most recent first, deduped,
//! capped — and persisted at `~/.ggs/remote/recent.json`, so a freshly started daemon still
//! offers yesterday's paths to pick from instead of a phone keyboard's worth of typing.

use crate::paths::Paths;
use crate::state::Daemon;

/// How many paths the list keeps.
const CAP: usize = 12;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Recent {
    folders: Vec<String>,
}

impl Recent {
    pub fn load(paths: &Paths) -> Recent {
        let folders = std::fs::read(paths.recent())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
            .unwrap_or_default();
        Recent {
            folders: folders.into_iter().take(CAP).collect(),
        }
    }

    pub fn list(&self) -> &[String] {
        &self.folders
    }

    /// Note a window's folders: each moves to the front (a multi-folder window keeps its
    /// order, the primary folder firstmost), duplicates and empties drop, the tail caps.
    /// Answers whether the list changed.
    pub fn note(&mut self, folders: &[String]) -> bool {
        let before = self.folders.clone();
        for folder in folders.iter().filter(|f| !f.is_empty()).rev() {
            self.folders.retain(|f| f != folder);
            self.folders.insert(0, folder.clone());
        }
        self.folders.truncate(CAP);
        before != self.folders
    }

    pub fn save(&self, paths: &Paths) {
        match serde_json::to_vec(&self.folders) {
            Ok(bytes) => {
                if let Err(e) = crate::paths::write_private(&paths.recent(), &bytes) {
                    crate::warn!("recent folders: {e}");
                }
            }
            Err(e) => crate::warn!("recent folders: {e}"),
        }
    }
}

/// Note folders a window registered or updated with. A change persists the list and bumps
/// the registry generation, which is what pushes WINDOWS (the recent list rides that frame).
pub fn note_folders(daemon: &Daemon, folders: &[String]) {
    let mut recent = daemon.recent.lock().unwrap();
    if recent.note(folders) {
        recent.save(&daemon.paths);
        drop(recent);
        daemon.registry.changed();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> (tempfile::TempDir, Paths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
        paths.ensure().unwrap();
        (dir, paths)
    }

    /// Most recent first, a multi-folder window keeps its order, repeats move instead of
    /// duplicating, and the list caps.
    #[test]
    fn noting_moves_to_the_front_deduped_and_capped() {
        let mut recent = Recent::default();
        assert!(recent.note(&["C:/a".into(), "C:/b".into()]));
        assert_eq!(recent.list(), ["C:/a", "C:/b"]);
        assert!(!recent.note(&["C:/a".into(), "C:/b".into()]), "an unchanged set writes nothing");
        assert!(recent.note(&["C:/c".into()]));
        assert_eq!(recent.list(), ["C:/c", "C:/a", "C:/b"]);
        // The same path in another window's set moves to the front alone.
        assert!(recent.note(&["C:/b".into(), "C:/d".into()]));
        assert_eq!(recent.list(), ["C:/b", "C:/d", "C:/c", "C:/a"]);
        // Empties never land.
        assert!(!recent.note(&["".into()]));
        for n in 0..20 {
            assert!(recent.note(&[format!("C:/x{n}")]));
        }
        assert_eq!(recent.list().len(), CAP);
        assert_eq!(recent.list()[0], "C:/x19");
    }

    /// The list survives a restart through `recent.json`.
    #[test]
    fn the_list_persists_and_loads_capped() {
        let (dir, paths) = paths();
        let mut recent = Recent::default();
        recent.note(&["C:/repo".into(), "C:/other".into()]);
        recent.save(&paths);
        let loaded = Recent::load(&paths);
        assert_eq!(loaded.list(), ["C:/repo", "C:/other"]);
        drop(dir);
    }

    #[test]
    fn a_missing_or_broken_file_starts_empty() {
        let (dir, paths) = paths();
        assert!(Recent::load(&paths).list().is_empty());
        std::fs::write(paths.recent(), b"not json").unwrap();
        assert!(Recent::load(&paths).list().is_empty());
        drop(dir);
    }
}
