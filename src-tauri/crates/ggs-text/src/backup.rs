//! The editor's backup store (`~/.ggs/backups`): hot-exit drafts written whole by the
//! backend, so a hundred-megabyte windowed draft never crosses the IPC — one JSON file
//! per document, named by the hash of its path.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub path: String,
    /// Seconds since the Unix epoch.
    pub saved_at: u64,
    pub contents: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: String,
    pub saved_at: u64,
}

pub fn backups_dir() -> Result<PathBuf, String> {
    ggs_base::paths::backups_home()
}
fn backup_file(dir: &Path, path: &str) -> PathBuf {
    use sha1::{Digest, Sha1};
    dir.join(format!(
        "{}.json",
        hex::encode(Sha1::digest(path.as_bytes()))
    ))
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
pub fn clear_in(dir: &Path, path: &str) {
    let _ = fs::remove_file(backup_file(dir, path));
}
pub fn list_in(dir: &Path) -> Vec<BackupInfo> {
    let mut out: Vec<BackupInfo> = fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|entry| serde_json::from_slice::<Backup>(&fs::read(entry.path()).ok()?).ok())
        .map(|b| BackupInfo {
            path: b.path,
            saved_at: b.saved_at,
        })
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}
pub fn read_in(dir: &Path, path: &str) -> Result<String, String> {
    let bytes =
        fs::read(backup_file(dir, path)).map_err(|e| format!("no backup of {path}: {e}"))?;
    serde_json::from_slice::<Backup>(&bytes)
        .map(|b| b.contents)
        .map_err(|e| e.to_string())
}
pub fn write_into(dir: &Path, path: &str, contents: String) -> Result<(), String> {
    let backup = Backup {
        path: path.to_owned(),
        saved_at: now(),
        contents,
    };
    let target = backup_file(dir, path);
    // Atomic replace, and a process-unique temp name: a crash mid-write never leaves a
    // half backup behind, and two app instances back up the same file without sharing
    // one temp path.
    ggs_base::fsx::atomic_write(
        &target,
        &serde_json::to_vec(&backup).map_err(|e| e.to_string())?,
    )
}
