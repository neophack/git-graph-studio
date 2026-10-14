//! The folder comparison service (module 8's backend): a full walk of both trees (no
//! Quick Open pruning — a comparison must see `node_modules` and `target` too), sizes
//! compared first, equal sizes hashed before two files are called the same.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use sha1::{Digest, Sha1};

use crate::scan::filter_paths;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirDiffEntry {
    pub path: String,
    /// `leftOnly`, `rightOnly`, `different`, `same`.
    pub status: String,
    pub left_size: u64,
    pub right_size: u64,
}

/// A file walk without Quick Open's pruning: a folder comparison must see `node_modules` and
/// `target` too. Only `.git` is skipped.
fn walk_all_files(root: &str) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::new();
    let mut pending = vec![PathBuf::from(root)];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if kind.is_dir() {
                if name != ".git" {
                    pending.push(entry.path());
                }
            } else if kind.is_file() {
                let full = entry.path();
                let Ok(relative) = full.strip_prefix(root) else {
                    continue;
                };
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                out.insert(relative.to_string_lossy().replace('\\', "/"), size);
            }
        }
    }
    out
}

fn file_hash(path: &Path) -> Option<[u8; 20]> {
    let bytes = fs::read(path).ok()?;
    Some(Sha1::digest(&bytes).into())
}

/// Compare two folders file by file. Equal sizes hash to equal content before two files are
/// called the same. Directories themselves are not reported - only files, with their status.
pub fn compare_roots(
    left: &str,
    right: &str,
    include: &str,
    exclude: &str,
) -> Result<Vec<DirDiffEntry>, String> {
    for (label, dir) in [("left", left), ("right", right)] {
        if !Path::new(dir).is_dir() {
            return Err(format!("The {label} folder does not exist: {dir}"));
        }
    }
    let left_files = walk_all_files(left);
    let right_files = walk_all_files(right);
    let mut paths: Vec<&String> = left_files.keys().chain(right_files.keys()).collect();
    paths.sort();
    paths.dedup();
    let mut entries = Vec::new();
    for path in filter_paths(paths.into_iter().cloned().collect(), include, exclude) {
        let (l_size, r_size) = (
            left_files.get(&path).copied(),
            right_files.get(&path).copied(),
        );
        let status = match (l_size, r_size) {
            (Some(_), None) => "leftOnly",
            (None, Some(_)) => "rightOnly",
            (Some(l), Some(r)) => {
                if l != r {
                    "different"
                } else {
                    let lp = Path::new(left).join(&path);
                    let rp = Path::new(right).join(&path);
                    let same = match (file_hash(&lp), file_hash(&rp)) {
                        (Some(a), Some(b)) => a == b,
                        _ => false,
                    };
                    if same {
                        "same"
                    } else {
                        "different"
                    }
                }
            }
            (None, None) => continue,
        };
        entries.push(DirDiffEntry {
            path,
            status: status.to_owned(),
            left_size: l_size.unwrap_or(0),
            right_size: r_size.unwrap_or(0),
        });
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_dirs_reports_statuses() {
        let left = tempfile::tempdir().unwrap();
        let right = tempfile::tempdir().unwrap();
        std::fs::write(left.path().join("same.txt"), b"x").unwrap();
        std::fs::write(right.path().join("same.txt"), b"x").unwrap();
        std::fs::write(left.path().join("diff.txt"), b"1").unwrap();
        std::fs::write(right.path().join("diff.txt"), b"2").unwrap();
        std::fs::write(left.path().join("only-l.txt"), b"").unwrap();
        std::fs::write(right.path().join("only-r.txt"), b"").unwrap();

        let mut entries = compare_roots(
            &left.path().display().to_string(),
            &right.path().display().to_string(),
            "",
            "",
        )
        .unwrap();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        let by_path: std::collections::BTreeMap<&str, &str> = entries
            .iter()
            .map(|e| (e.path.as_str(), e.status.as_str()))
            .collect();
        assert_eq!(by_path["same.txt"], "same");
        assert_eq!(by_path["diff.txt"], "different");
        assert_eq!(by_path["only-l.txt"], "leftOnly");
        assert_eq!(by_path["only-r.txt"], "rightOnly");
    }
}
