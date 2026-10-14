//! ggs-git::revision — a file's bytes/text at any revision, the temp-blob handoff the
//! diff editors read, and the repository head's parsed shape (branch, ahead/behind) the
//! Source Control view shows.

use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::runner::Git;

static TEMP_BLOB_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A file's raw bytes at one revision, over the git CLI: `git cat-file` of `<rev>:<path>`,
/// where `:index` (the staged copy) reads the index's stage-0 entry. `Ok(None)` when the path
/// does not exist at that revision (the missing side of an added or deleted file); binary
/// content passes through undecoded. `pub(crate)`: the extension pages' byte services
/// (`cmd_ext`'s `ext_page_revision_bytes`) read revision sides through it too.
pub fn revision_file_bytes(
    git: &Git,
    revision: &str,
    path: &str,
) -> Result<Option<Vec<u8>>, String> {
    let spec = format!(
        "{}:{path}",
        if revision == ":index" { "" } else { revision }
    );
    if git.output(&["cat-file", "-e", &spec]).is_err() {
        return Ok(None);
    }
    git.output_bytes(&["cat-file", "blob", &spec]).map(Some)
}

/// A file at one revision as the diff editors read it: `binary` says whether `contents`
/// (UTF-8 text, lossily decoded) is there — a NUL byte in the leading window is git's own
/// binary heuristic. A missing path answers the same "does not exist" error the editors'
/// missing-side handling keys off.
pub fn revision_file_text(
    git: &Git,
    revision: &str,
    path: &str,
) -> Result<(bool, Option<String>), String> {
    match revision_file_bytes(git, revision, path)? {
        None => Err(format!("The file \"{path}\" does not exist in {revision}")),
        Some(bytes) => {
            let window = &bytes[..bytes.len().min(8000)];
            if window.contains(&0) {
                Ok((true, None))
            } else {
                Ok((false, Some(String::from_utf8_lossy(&bytes).into_owned())))
            }
        }
    }
}

/// Write `bytes` to a fresh temp file named after `path`'s basename, in a directory unique to
/// this call, and return its absolute path.
pub fn write_temp_blob(path: &str, bytes: &[u8]) -> Result<String, String> {
    let seq = TEMP_BLOB_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir =
        std::env::temp_dir().join(format!("git-graph-studio-hex-{}-{seq}", std::process::id()));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let target = dir.join(name);
    fs::write(&target, bytes).map_err(|e| format!("{}: {e}", target.display()))?;
    Ok(target.display().to_string())
}

/// The status bar's left items: the repository's folder name, the checked-out branch (or
/// the short hash when detached), plus how far it is ahead of / behind its upstream.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadInfo {
    pub repo: String,
    pub branch: Option<String>,
    pub short_hash: String,
    pub ahead: u32,
    pub behind: u32,
    pub upstream: Option<String>,
}

/// The repository's folder name, as the status bar's repo item shows it. A path without a
/// final component (a root) yields the empty string, which the frontend reads as "no item".
pub fn repo_folder_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map_or_else(String::new, |name| name.to_string_lossy().into_owned())
}

/// The `# branch.*` header lines of `git status --porcelain=v2 --branch`, as `HeadInfo`.
/// A detached HEAD reports `branch.head (detached)`, an empty repo `branch.oid (initial)`.
pub fn parse_status_branch(out: &str) -> HeadInfo {
    let mut info = HeadInfo {
        repo: String::new(),
        branch: None,
        short_hash: String::new(),
        ahead: 0,
        behind: 0,
        upstream: None,
    };
    for line in out.lines() {
        let Some(rest) = line.strip_prefix("# branch.") else {
            continue;
        };
        if let Some(head) = rest.strip_prefix("head ") {
            if head != "(detached)" {
                info.branch = Some(head.to_owned());
            }
        } else if let Some(oid) = rest.strip_prefix("oid ") {
            if oid != "(initial)" {
                // `rev-parse --short` yields 7+ characters; 7 matches every hash the app shows.
                info.short_hash = oid.chars().take(7).collect();
            }
        } else if let Some(upstream) = rest.strip_prefix("upstream ") {
            info.upstream = Some(upstream.to_owned());
        } else if let Some(ab) = rest.strip_prefix("ab ") {
            let mut counts = ab.split_whitespace();
            info.ahead = counts
                .next()
                .and_then(|c| c.trim_start_matches('+').parse().ok())
                .unwrap_or(0);
            info.behind = counts
                .next()
                .and_then(|c| c.trim_start_matches('-').parse().ok())
                .unwrap_or(0);
        }
    }
    info
}