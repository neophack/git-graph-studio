//! The operator's kill switch (docs/ggs-remote-plan.md §20.6): a plain file of uuids, one
//! per line, `#` for comments — re-read periodically (and at every handshake), so editing
//! the file takes effect without a restart. A listed PC's tunnel is closed (its browsers
//! see the plain offline page, indistinguishable from a PC that went away) and its next
//! handshake is refused with `banned`.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Blocklist {
    path: Option<PathBuf>,
    set: Mutex<HashSet<String>>,
}

impl Blocklist {
    /// Load the file when a path is configured. A file that does not exist yet is an empty
    /// list (the operator may create it later — the periodic refresh picks it up); one that
    /// cannot be read keeps the last good set.
    pub fn open(path: &str) -> Blocklist {
        let list = Blocklist {
            path: (!path.is_empty()).then(|| PathBuf::from(path)),
            set: Mutex::new(HashSet::new()),
        };
        if let Some(path) = &list.path {
            match std::fs::read_to_string(path) {
                Ok(_) => list.refresh(),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    crate::info!(
                        "blocklist {}: not present yet — an empty list",
                        path.display()
                    )
                }
                Err(e) => crate::warn!("blocklist {}: {e}", path.display()),
            }
        }
        list
    }

    pub fn enabled(&self) -> bool {
        self.path.is_some()
    }

    /// Re-read the file. Lines are trimmed; empty ones and `#` comments drop out —
    /// everything else is a uuid to refuse.
    pub fn refresh(&self) {
        let Some(path) = &self.path else {
            return;
        };
        let Ok(text) = std::fs::read_to_string(path) else {
            return; // keep the last good set; the next refresh tries again
        };
        let set = text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(str::to_owned)
            .collect();
        *self.set.lock().unwrap() = set;
    }

    pub fn blocked(&self, uuid: &str) -> bool {
        self.set.lock().unwrap().contains(uuid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_uuids_and_skips_comments_and_blanks() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("block.txt");
        std::fs::write(
            &file,
            "# blocked PCs\n\n 3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3 \nnot-a-uuid-but-listed\n",
        )
        .unwrap();
        let list = Blocklist::open(file.to_str().unwrap());
        assert!(list.blocked("3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3"));
        assert!(list.blocked("not-a-uuid-but-listed"));
        assert!(!list.blocked("00000000-0000-0000-0000-000000000000"));
        assert!(!list.blocked(""));
    }

    #[test]
    fn a_missing_file_is_an_empty_list_and_edits_land_on_refresh() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("later.txt");
        let list = Blocklist::open(file.to_str().unwrap());
        assert!(list.enabled());
        assert!(!list.blocked("some-uuid"));
        // The operator writes the file after the Hub started: the refresh picks it up.
        std::fs::write(&file, "some-uuid\n").unwrap();
        list.refresh();
        assert!(list.blocked("some-uuid"));
    }

    #[test]
    fn an_empty_path_is_off() {
        let list = Blocklist::open("");
        assert!(!list.enabled());
        assert!(!list.blocked("anything"));
    }
}
