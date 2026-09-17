//! Filesystem commands for the Explorer and the editor: the folder tree, file contents (of the
//! working tree, of the index, or of any revision, for the diff editors), and the Explorer's
//! own new/rename/delete operations.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::git::Git;
use crate::AppState;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// The names VS Code's default `files.exclude` hides from the Explorer.
const EXCLUDED: &[&str] = &[".git", ".svn", ".hg", "CVS", ".DS_Store", "Thumbs.db"];

/// One directory level of the Explorer tree, folders first, then files, both alphabetically
/// (case-insensitive, matching how the VS Code explorer orders entries).
#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    let entries = fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if EXCLUDED.contains(&name.as_str()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let info = DirEntryInfo {
            name,
            path: entry.path().display().to_string(),
            is_dir: meta.is_dir(),
            size: meta.len(),
        };
        if meta.is_dir() {
            dirs.push(info);
        } else {
            files.push(info);
        }
    }
    dirs.sort_by_key(|e| e.name.to_lowercase());
    files.sort_by_key(|e| e.name.to_lowercase());
    dirs.extend(files);
    Ok(dirs)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    /// The text, or `None` for a binary file (the editor shows a notice instead).
    pub contents: Option<String>,
    pub binary: bool,
    pub size: u64,
    /// The encoding id the text was decoded with (`encoding::ENCODINGS`); the editor saves
    /// the file back in it unless the user picks another.
    pub encoding: String,
    /// `lf` or `crlf`.
    pub eol: String,
}

/// Decode a file's bytes: binary files (a NUL within the first 8000 bytes, git's own
/// heuristic) carry no text; the rest is decoded as `forced`, or by detection.
fn decode(bytes: Vec<u8>, forced: Option<&str>) -> FileContents {
    let size = bytes.len() as u64;
    // A file reopened as UTF-16 by hand has NULs in every other byte without a BOM to say so.
    let forced_utf16 = matches!(forced, Some("utf-16le" | "utf-16be"));
    if crate::encoding::looks_binary(&bytes) && !forced_utf16 {
        return FileContents {
            contents: None,
            binary: true,
            size,
            encoding: "utf8".into(),
            eol: "lf".into(),
        };
    }
    let decoded = crate::encoding::decode(&bytes, forced);
    FileContents {
        contents: Some(decoded.text),
        binary: false,
        size,
        encoding: decoded.encoding.into(),
        eol: decoded.eol.into(),
    }
}

/// Read a file as text, detecting its encoding - or decoding it as `encoding` when the user
/// asked to reopen it with a specific one.
#[tauri::command]
pub async fn read_file(path: String, encoding: Option<String>) -> Result<FileContents, String> {
    let bytes = fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    Ok(decode(bytes, encoding.as_deref()))
}

/// The metadata half of `read_file_raw`'s payload, riding ahead of the text itself.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RawFileMeta {
    binary: bool,
    size: u64,
    encoding: String,
    eol: String,
}

/// The same text as `read_file`, but as raw IPC bytes instead of a JSON string: a large file
/// skipped the multi-pass JSON escaping (and its full-buffer copies) that stalled the webview
/// for seconds on open. The payload is an 8-byte little-endian header length, the JSON
/// `RawFileMeta`, then the decoded UTF-8 text itself.
#[tauri::command]
pub async fn read_file_raw(
    path: String,
    encoding: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let bytes = fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    Ok(tauri::ipc::Response::new(raw_payload(&bytes, encoding.as_deref())))
}

/// Build `read_file_raw`'s payload: header length, metadata, text.
fn raw_payload(bytes: &[u8], forced: Option<&str>) -> Vec<u8> {
    let size = bytes.len() as u64;
    let forced_utf16 = matches!(forced, Some("utf-16le" | "utf-16be"));
    let (meta, text) = if crate::encoding::looks_binary(bytes) && !forced_utf16 {
        (
            RawFileMeta { binary: true, size, encoding: "utf8".into(), eol: "lf".into() },
            Vec::new(),
        )
    } else {
        let decoded = crate::encoding::decode(bytes, forced);
        (
            RawFileMeta {
                binary: false,
                size,
                encoding: decoded.encoding.into(),
                eol: decoded.eol.into(),
            },
            decoded.text.into_bytes(),
        )
    };
    let header = serde_json::to_vec(&meta).expect("serializing plain strings cannot fail");
    let mut payload = Vec::with_capacity(8 + header.len() + text.len());
    payload.extend_from_slice(&(header.len() as u64).to_le_bytes());
    payload.extend_from_slice(&header);
    payload.extend_from_slice(&text);
    payload
}

/// What the editor learns about a file before reading its body: the size, and whether the
/// first bytes look binary. One small read routes the open - a binary file straight to the
/// hex viewer, a very large text file to the windowed viewer, the rest to the editor -
/// so no path ever reads a large file only to find out it should not have.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileProbe {
    pub size: u64,
    pub binary: bool,
    /// The head shows no line breaks within multi-kilobyte runs: a minified single-line
    /// file, whose few enormous lines defeat a line-windowed editor (its window would be
    /// the whole file). Those open in the full editor instead.
    pub long_lines: bool,
}

/// The probe behind `file_probe`, reading at most the sniff window.
pub fn probe(path: &str) -> Result<FileProbe, String> {
    use std::io::Read;
    let mut file = fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let size = file.metadata().map_err(|e| format!("{path}: {e}"))?.len();
    let mut head = Vec::with_capacity(crate::encoding::SNIFF_BYTES);
    file.by_ref()
        .take(crate::encoding::SNIFF_BYTES as u64)
        .read_to_end(&mut head)
        .map_err(|e| format!("{path}: {e}"))?;
    Ok(FileProbe {
        size,
        binary: crate::encoding::looks_binary(&head),
        long_lines: head_has_long_lines(&head, size),
    })
}

/// A sniffed head with any run of 4 KiB without a line break — or no break at all in a file
/// over 1 MiB — marks the file as minified-style. (The sniff window is 8000 bytes, so the
/// threshold has to sit inside it; the frontend only consults this for files it would
/// otherwise window, where even a 4 KiB line is a sign the file has few, huge lines.)
fn head_has_long_lines(head: &[u8], size: u64) -> bool {
    const LONG_LINE: usize = 4 * 1024;
    let mut run = 0usize;
    let mut saw_break = false;
    for &byte in head {
        if byte == b'\n' {
            saw_break = true;
            run = 0;
        } else {
            run += 1;
            if run >= LONG_LINE {
                return true;
            }
        }
    }
    // No break anywhere in the sniff window: a file this size is one huge (minified) line.
    !saw_break && size > 1024 * 1024
}

#[tauri::command]
pub async fn file_probe(path: String) -> Result<FileProbe, String> {
    probe(&path)
}

/// A file's bytes as base64 (the image preview, a Markdown preview's relative images). Capped:
/// a data URL of tens of megabytes would stall the webview.
#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<String, String> {
    const MAX: u64 = 32 * 1024 * 1024;
    let size = fs::metadata(&path)
        .map_err(|e| format!("{path}: {e}"))?
        .len();
    if size > MAX {
        return Err(format!(
            "{path} is {} MB; the preview shows images up to {} MB",
            size / (1024 * 1024),
            MAX / (1024 * 1024)
        ));
    }
    let bytes = fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// One window of a file's bytes, as base64 - the hex viewer pages through a large
/// file rather than reading it whole.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChunk {
    pub size: u64,
    pub base64: String,
}

/// Read `len` bytes of a file starting at `offset` (clamped to the file's end).
#[tauri::command]
pub async fn read_file_chunk(path: String, offset: u64, len: u32) -> Result<FileChunk, String> {
    read_chunk(&path, offset, len)
}

fn read_chunk(path: &str, offset: u64, len: u32) -> Result<FileChunk, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let size = file.metadata().map_err(|e| format!("{path}: {e}"))?.len();
    let start = offset.min(size);
    let len = (len as u64).min(size - start).min(u32::MAX as u64) as usize;
    file.seek(SeekFrom::Start(start)).map_err(|e| format!("{path}: {e}"))?;
    let mut bytes = vec![0u8; len];
    file.read_exact(&mut bytes)
        .map_err(|e| format!("{path}: {e}"))?;
    use base64::Engine;
    Ok(FileChunk {
        size,
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// One changed byte of an in-place hex edit, at its absolute file offset.
#[derive(Clone, Deserialize)]
pub struct BytePatch {
    pub offset: u64,
    pub byte: u8,
}

/// Write the bytes a hex-editor session changed back in place; everything else of the
/// file is left untouched on disk, exactly as it was read.
#[tauri::command]
pub fn patch_file(path: String, edits: Vec<BytePatch>) -> Result<(), String> {
    patch_bytes(&path, &edits)
}

fn patch_bytes(path: &str, edits: &[BytePatch]) -> Result<(), String> {
    use std::io::{Seek, SeekFrom, Write};
    let mut file = fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|e| format!("{path}: {e}"))?;
    let size = file.metadata().map_err(|e| format!("{path}: {e}"))?.len();
    let mut sorted = edits.to_vec();
    sorted.sort_by_key(|patch| patch.offset);
    for patch in sorted {
        if patch.offset >= size {
            return Err(format!(
                "{path}: byte offset {} is past the end of the {}-byte file",
                patch.offset, size
            ));
        }
        file.seek(SeekFrom::Start(patch.offset))
            .map_err(|e| format!("{path}: {e}"))?;
        file.write_all(&[patch.byte])
            .map_err(|e| format!("{path}: {e}"))?;
    }
    Ok(())
}

/// The encodings the status bar's picker offers, as `[id, label]` pairs.
#[tauri::command]
pub fn encodings() -> Vec<[&'static str; 2]> {
    crate::encoding::ENCODINGS
        .iter()
        .map(|(id, label)| [*id, *label])
        .collect()
}

/// Cheap change detection for periodic refreshes: size plus modification time, so unchanged
/// files skip the reload entirely instead of visibly rebuilding their viewer.
#[tauri::command]
pub async fn file_fingerprint(path: String) -> Result<Option<String>, String> {
    let meta = match fs::metadata(&path) {
        Ok(meta) => meta,
        Err(_) => return Ok(None),
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(Some(format!("{}:{mtime}", meta.len())))
}

/// Write a file's text, encoded as `encoding` (UTF-8 when absent) with `eol` line endings
/// (the editor's own `\n` when absent).
#[tauri::command]
pub async fn write_file(
    state: State<'_, AppState>,
    path: String,
    contents: String,
    encoding: Option<String>,
    eol: Option<String>,
) -> Result<(), String> {
    state.file_list_cache.invalidate();
    let target = Path::new(&path);
    // Saving a file whose parent vanished (an external delete) would create a stray file.
    if let Some(parent) = target.parent() {
        if !parent.exists() {
            return Err(format!("{path}: the containing folder no longer exists"));
        }
    }
    let bytes = crate::encoding::encode(
        &contents,
        encoding.as_deref().unwrap_or("utf8"),
        eol.as_deref().unwrap_or("lf"),
    );
    fs::write(target, bytes).map_err(|e| format!("{path}: {e}"))
}

/// A file as it is in a revision of the open repository, for the diff editors. `HEAD`, a hash,
/// `<hash>^`… are all accepted; `*` (the view's uncommitted sentinel) reads the working tree,
/// and `:index` reads the staged copy.
#[tauri::command]
pub async fn read_file_at(
    state: State<'_, AppState>,
    revision: String,
    path: String,
    repo: Option<String>,
) -> Result<FileContents, String> {
    // The repository the revision belongs to rides with the request (a diff opened from a
    // submodule's commit reads that submodule); the shell's own reads name none and get the
    // open repository.
    let repo_path = repo
        .or_else(|| state.first_repo())
        .ok_or_else(|| "No repository is open".to_string())?;
    if revision == "*" {
        return read_file(
            Path::new(&repo_path).join(&path).display().to_string(),
            None,
        )
        .await;
    }
    // The engine answers in this process.
    let file = tauri::async_runtime::spawn_blocking(move || {
        crate::cmd_graph::revision_file(&repo_path, &revision, &path)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(FileContents {
        binary: file.binary,
        size: file.contents.as_ref().map(|c| c.len() as u64).unwrap_or(0),
        eol: file
            .contents
            .as_deref()
            .map(crate::encoding::detect_eol)
            .unwrap_or("lf")
            .into(),
        contents: file.contents,
        encoding: "utf8".into(),
    })
}

/// The status bar's branch item: the checked-out branch (or the short hash when detached),
/// plus how far it is ahead of / behind its upstream.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadInfo {
    pub branch: Option<String>,
    pub short_hash: String,
    pub ahead: u32,
    pub behind: u32,
    pub upstream: Option<String>,
}

#[tauri::command]
pub async fn repo_head(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<HeadInfo, String> {
    // `repo` names a submodule's section of the Source Control view; the open repository otherwise.
    let repo_path = state.resolve_repo(repo)?;
    let git = Git::new(&repo_path);
    // One subprocess instead of four (each git spawn costs ~50-90 ms on Windows): the
    // porcelain v2 branch header carries the branch, the oid, the upstream and the
    // ahead/behind counts in a single `git status`.
    let out = git.output(&["status", "--porcelain=v2", "--branch"])?;
    Ok(parse_status_branch(&out))
}

/// The `# branch.*` header lines of `git status --porcelain=v2 --branch`, as `HeadInfo`.
/// A detached HEAD reports `branch.head (detached)`, an empty repo `branch.oid (initial)`.
pub(crate) fn parse_status_branch(out: &str) -> HeadInfo {
    let mut info = HeadInfo {
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

/* ---------- Explorer operations ---------- */

fn checked(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if path.as_os_str().is_empty() {
        return Err("No path was given".to_owned());
    }
    Ok(path)
}

/// Where the Git Graph view's session log is written when the user opens it (graphHost.ts
/// `openLogFile`): one file per app session, in the OS temp directory. The name carries
/// the process id — the app is multi-instance, and each instance's session logs to its
/// own file instead of overwriting another window's export.
#[tauri::command]
pub fn session_log_file() -> String {
    std::env::temp_dir()
        .join(format!("git-graph-studio-session-{}.log", std::process::id()))
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod session_log_tests {
    use super::session_log_file;

    #[test]
    fn the_log_file_is_named_per_process() {
        let path = session_log_file();
        assert!(path.contains("git-graph-studio-session-"));
        assert!(path.contains(&std::process::id().to_string()));
    }
}

#[tauri::command]
pub fn create_file(state: State<'_, AppState>, path: String) -> Result<(), String> {
    state.file_list_cache.invalidate();
    let target = checked(&path)?;
    if target.exists() {
        return Err(format!("{path} already exists"));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{path}: {e}"))?;
    }
    fs::write(&target, b"").map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
pub fn create_folder(state: State<'_, AppState>, path: String) -> Result<(), String> {
    state.file_list_cache.invalidate();
    let target = checked(&path)?;
    if target.exists() {
        return Err(format!("{path} already exists"));
    }
    fs::create_dir_all(&target).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
pub fn rename_path(state: State<'_, AppState>, from: String, to: String) -> Result<(), String> {
    state.file_list_cache.invalidate();
    rename(&from, &to)
}

/// Rename `from` to `to`, refusing to clobber an existing entry - except the entry itself: on
/// a case-insensitive file system (Windows, macOS) `README.md` -> `readme.md` finds `to`
/// "existing", and that is the rename the user asked for, not a collision.
pub(crate) fn rename(from: &str, to: &str) -> Result<(), String> {
    let target = checked(to)?;
    if target.exists() && !same_entry(Path::new(from), &target) {
        return Err(format!("{to} already exists"));
    }
    fs::rename(from, &target).map_err(|e| format!("{from}: {e}"))
}

/// Whether two paths name the same directory entry - differing only in case, on a file
/// system that ignores case. The canonical forms of both paths agree then, and nothing but
/// the spelling does; two distinct entries canonicalise to distinct paths.
fn same_entry(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    // Windows file systems ignore case: the same spelling up to case is the same entry.
    if cfg!(windows) && a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()) {
        return true;
    }
    let (Ok(a), Ok(b)) = (fs::canonicalize(a), fs::canonicalize(b)) else {
        return false;
    };
    // `canonicalize` reports the spelling the file system stores, so a case-only rename of
    // the very entry yields the same path both ways; a different entry cannot.
    a == b
}

/// Delete a file or folder. Like VS Code (`files.enableTrash`), the entry goes to the
/// system's Recycle Bin / Trash so it can be restored; `permanent` (Shift+Delete, or the
/// fallback the Explorer offers when the trash refuses) removes it outright.
#[tauri::command]
pub fn delete_path(state: State<'_, AppState>, path: String, permanent: Option<bool>) -> Result<(), String> {
    state.file_list_cache.invalidate();
    let target = checked(&path)?;
    let meta = fs::symlink_metadata(&target).map_err(|e| format!("{path}: {e}"))?;
    if !permanent.unwrap_or(false) {
        return trash::delete(&target).map_err(|e| format!("{path}: could not move to the Recycle Bin: {e}"));
    }
    if meta.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| format!("{path}: {e}"))
    } else {
        fs::remove_file(&target).map_err(|e| format!("{path}: {e}"))
    }
}

/// Every file under the open folder (repo-relative, forward slashes), for "Go to File", the
/// Search view and the symbol index.
///
/// The walk is `ignore`'s parallel walker (ripgrep's): it honours `.gitignore` / `.ignore`
/// and the excluded-folder list, spreads directory reads across all cores, and is uncapped —
/// a 100,000-file tree lists in full. The result is cached for a short while: opening the
/// picker twice in a row must not re-walk the tree, and every mutating Explorer command
/// (`create_file`, `rename_path`, …) and the file watcher drop the cache so a change shows up
/// on the next request.
#[tauri::command]
pub async fn list_files(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<Vec<String>, String> {
    const TTL: Duration = Duration::from_secs(5);
    let root = repo
        .or_else(|| state.first_repo())
        .ok_or_else(|| "No folder is open".to_string())?;
    Ok(cached_file_list(
        &state.file_list_cache,
        &root,
        TTL,
        walk_files,
    ))
}

/// The folders VS Code's search excludes by default when walking for Quick Open. Pruned even
/// when no `.gitignore` names them, so a checkout without one still opens instantly.
const SKIPPED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "out",
    "dist",
    ".svn",
    ".hg",
    "bower_components",
];

/// One walk of the tree, `.gitignore`-aware and parallel; see `list_files`. Sorted, so the
/// Search view's batches and Quick Open's candidates come in a stable order.
pub fn walk_files(root: &str) -> Vec<String> {
    use std::sync::Mutex;
    let root_path = PathBuf::from(root);
    let files: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let mut builder = ignore::WalkBuilder::new(&root_path);
    builder
        // Dotfiles are project files too (`.github/`, `.eslintrc`); only the VCS folders go.
        .hidden(false)
        .git_ignore(true)
        // A `.gitignore` counts outside a repository too (VS Code's `search.useIgnoreFiles`).
        .require_git(false)
        .git_exclude(true)
        .git_global(false)
        .ignore(true)
        .parents(false)
        .follow_links(false)
        .threads(rayon::current_num_threads().max(2))
        .filter_entry(|entry| {
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            !(is_dir
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| SKIPPED_DIRS.contains(&name)))
        });
    /// One worker's gathered paths, merged into the shared list when the worker finishes
    /// (the walker drops its closures at the end, which is what flushes the remainders) —
    /// so the shared lock is taken a handful of times, not once per file.
    struct Gather<'a> {
        local: Vec<String>,
        shared: &'a Mutex<Vec<String>>,
    }
    impl Drop for Gather<'_> {
        fn drop(&mut self) {
            self.shared.lock().unwrap().append(&mut self.local);
        }
    }
    builder.build_parallel().run(|| {
        let mut gather = Gather {
            local: Vec::new(),
            shared: &files,
        };
        let root_path = &root_path;
        Box::new(move |entry| {
            if let Ok(entry) = entry {
                if entry.file_type().is_some_and(|t| t.is_file()) {
                    if let Ok(relative) = entry.path().strip_prefix(root_path) {
                        gather
                            .local
                            .push(relative.to_string_lossy().replace('\\', "/"));
                    }
                }
            }
            ignore::WalkState::Continue
        })
    });
    let mut files = files.into_inner().unwrap();
    files.sort();
    files.dedup();
    files
}

/// The Quick Open file list cache, one slot per open root (a multi-root workspace keeps
/// several), each stamped so a repeat open within the TTL is served without touching the
/// filesystem.
#[derive(Default)]
pub struct FileListCache {
    inner: Mutex<std::collections::HashMap<String, (Instant, Vec<String>)>>,
}

impl FileListCache {
    pub fn invalidate(&self) {
        self.inner.lock().unwrap().clear();
    }

    /// Store a freshly walked list, as the open-folder prefetch does from its own thread.
    pub fn store(&self, root: &str, files: Vec<String>) {
        self.inner
            .lock()
            .unwrap()
            .insert(root.to_owned(), (Instant::now(), files));
    }
}

/// Serve `root`'s file list from the cache when it is fresh enough, otherwise walk (via
/// `walk`) and store the result.
pub(crate) fn cached_file_list(
    cache: &FileListCache,
    root: &str,
    ttl: Duration,
    walk: fn(&str) -> Vec<String>,
) -> Vec<String> {
    {
        let cached = cache.inner.lock().unwrap();
        if let Some((at, files)) = cached.get(root) {
            if at.elapsed() < ttl {
                return files.clone();
            }
        }
    }
    let files = walk(root);
    cache
        .inner
        .lock()
        .unwrap()
        .insert(root.to_owned(), (Instant::now(), files.clone()));
    files
}

/* ---------- Hot exit: backups of unsaved buffers ---------- */

/// Where unsaved buffers are kept between a crash and the next launch: one JSON file per
/// document under `~/.ggs/backups/`, named by the hash of its path.
pub(crate) fn backups_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "no user home directory".to_string())?;
    let dir = home.join(".ggs").join("backups");
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn backup_file(dir: &Path, path: &str) -> PathBuf {
    use sha1::{Digest, Sha1};
    dir.join(format!(
        "{}.json",
        hex::encode(Sha1::digest(path.as_bytes()))
    ))
}

#[derive(Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
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

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub(crate) fn backup_write_into(dir: &Path, path: &str, contents: String) -> Result<(), String> {
    let backup = Backup {
        path: path.to_owned(),
        saved_at: now(),
        contents,
    };
    let target = backup_file(dir, path);
    // Atomic replace, and a process-unique temp name: a crash mid-write never leaves a
    // half backup behind, and two app instances back up the same file without sharing
    // one temp path.
    crate::atomic_write(
        &target,
        &serde_json::to_vec(&backup).map_err(|e| e.to_string())?,
    )
}

pub(crate) fn backup_clear_in(dir: &Path, path: &str) {
    let _ = fs::remove_file(backup_file(dir, path));
}

pub(crate) fn backup_list_in(dir: &Path) -> Vec<BackupInfo> {
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

pub(crate) fn backup_read_in(dir: &Path, path: &str) -> Result<String, String> {
    let bytes =
        fs::read(backup_file(dir, path)).map_err(|e| format!("no backup of {path}: {e}"))?;
    serde_json::from_slice::<Backup>(&bytes)
        .map(|b| b.contents)
        .map_err(|e| e.to_string())
}

/// Keep an unsaved buffer's contents (called a moment after every edit).
#[tauri::command]
pub async fn backup_write(path: String, contents: String) -> Result<(), String> {
    backup_write_into(&backups_dir()?, &path, contents)
}

/// The buffer was saved or its changes discarded: nothing to recover any more.
#[tauri::command]
pub async fn backup_clear(path: String) -> Result<(), String> {
    backup_clear_in(&backups_dir()?, &path);
    Ok(())
}

/// Every backup on disk (the ones of a previous session that did not end cleanly).
#[tauri::command]
pub async fn backup_list() -> Result<Vec<BackupInfo>, String> {
    Ok(backup_list_in(&backups_dir()?))
}

#[tauri::command]
pub async fn backup_read(path: String) -> Result<String, String> {
    backup_read_in(&backups_dir()?, &path)
}

/// The repository the app opened, if any — the frontend asks for this at startup.
#[tauri::command]
pub fn initial_repo(state: State<'_, AppState>) -> Option<String> {
    state.first_repo()
}

/// The roots of a repository's initialised submodules (absolute paths), as the Git Graph
/// view's repository dropdown lists them alongside the repository itself.
#[tauri::command]
pub fn repo_submodules(repo: String) -> Vec<String> {
    crate::cmd_graph::submodule_roots(&repo)
}

#[cfg(test)]
mod file_list_tests {
    use super::*;

    #[test]
    fn patch_bytes_rewrites_only_the_edited_offsets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob.bin");
        fs::write(&path, (0..16u8).collect::<Vec<_>>()).unwrap();
        let path = path.to_string_lossy().into_owned();
        patch_bytes(
            &path,
            &[
                BytePatch { offset: 3, byte: 0xaa },
                BytePatch { offset: 15, byte: 0xbb },
            ],
        )
        .unwrap();
        let patched = fs::read(&path).unwrap();
        assert_eq!(patched, [0, 1, 2, 0xaa, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 0xbb]);
        // An offset past the end is refused, leaving the file as it was.
        let err = patch_bytes(&path, &[BytePatch { offset: 99, byte: 1 }]).unwrap_err();
        assert!(err.contains("past the end"));
        assert_eq!(fs::read(&path).unwrap(), patched);
    }

    #[test]
    fn rename_allows_a_case_only_rename_but_never_clobbers_another_entry() {
        let dir = tempfile::tempdir().unwrap();
        let readme = dir.path().join("README.md");
        let other = dir.path().join("other.md");
        fs::write(&readme, b"#").unwrap();
        fs::write(&other, b"o").unwrap();
        let from = readme.to_string_lossy().into_owned();
        // A different existing entry is refused, whatever its spelling.
        let err = rename(&from, &other.to_string_lossy()).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert!(readme.exists() && other.exists());
        // The same entry, respelled: on a case-insensitive file system `to` "exists", yet it
        // is this very file - the rename goes through and the new spelling is what is stored.
        let to = dir.path().join("readme.md").to_string_lossy().into_owned();
        rename(&from, &to).unwrap();
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"readme.md".to_owned()), "{names:?}");
        assert!(!names.contains(&"README.md".to_owned()), "{names:?}");
        // A rename onto itself is a no-op, not an error.
        rename(&to, &to).unwrap();
        assert!(Path::new(&to).exists());
    }

    #[test]
    fn raw_payload_carries_meta_header_then_text() {
        let payload = raw_payload(b"hello\r\nworld", None);
        let header_len =
            u64::from_le_bytes(payload[..8].try_into().unwrap()) as usize;
        let meta: serde_json::Value =
            serde_json::from_slice(&payload[8..8 + header_len]).unwrap();
        assert_eq!(meta["binary"], false);
        assert_eq!(meta["eol"], "crlf");
        assert_eq!(&payload[8 + header_len..], b"hello\r\nworld");
        // A binary sniff yields no text, only the header saying so.
        let binary = raw_payload(b"ab\0cd", None);
        let header_len = u64::from_le_bytes(binary[..8].try_into().unwrap()) as usize;
        let meta: serde_json::Value =
            serde_json::from_slice(&binary[8..8 + header_len]).unwrap();
        assert_eq!(meta["binary"], true);
        assert_eq!(binary.len(), 8 + header_len);
    }

    #[test]
    fn probe_reads_only_the_head_and_agrees_with_read_file() {
        let dir = tempfile::tempdir().unwrap();
        // A NUL far beyond the sniff window does not make a file binary (git's rule), a NUL
        // inside it does, and a UTF-16 BOM exempts its NULs; `read_file` must say the same.
        let mut late = vec![b'x'; 9000];
        late.push(0);
        let mut utf16 = vec![0xFF, 0xFE];
        utf16.extend("hi".encode_utf16().flat_map(u16::to_le_bytes));
        for (name, bytes, binary, long_lines) in [
            ("late.txt", late, false, true),
            ("early.bin", b"ab\0cd".to_vec(), true, false),
            ("wide.txt", utf16, false, false),
            ("empty.txt", Vec::new(), false, false),
        ] {
            let path = dir.path().join(name);
            fs::write(&path, &bytes).unwrap();
            let path = path.to_string_lossy().into_owned();
            assert_eq!(
                probe(&path).unwrap(),
                FileProbe { size: bytes.len() as u64, binary, long_lines },
                "{name}"
            );
            assert_eq!(decode(bytes, None).binary, binary, "{name}");
        }
        assert!(probe(&dir.path().join("missing").to_string_lossy()).is_err());
    }

    #[test]
    fn probe_flags_minified_heads_as_long_lines() {
        let dir = tempfile::tempdir().unwrap();
        // A 32 KiB unbroken run inside the sniff window flags the file.
        let minified = dir.path().join("min.js");
        fs::write(&minified, vec![b'x'; 33 * 1024]).unwrap();
        assert!(probe(&minified.to_string_lossy()).unwrap().long_lines);
        // A head with no break at all flags only when the file is large: a 2 MB single-line
        // JSON dump is exactly the case to keep away from a line-windowed editor.
        let one_line = dir.path().join("one.json");
        fs::write(&one_line, vec![b'x'; 2 * 1024 * 1024]).unwrap();
        assert!(probe(&one_line.to_string_lossy()).unwrap().long_lines);
        // Ordinary multi-line files of any size do not.
        let lines = dir.path().join("lines.log");
        fs::write(&lines, "short\nlines\nonly\n".repeat(100_000)).unwrap();
        let probed = probe(&lines.to_string_lossy()).unwrap();
        assert!(!probed.long_lines && probed.size > 1024 * 1024);
    }

    #[test]
    fn read_file_chunk_pages_and_clamps_to_the_end() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob.bin");
        fs::write(&path, (0..100u8).collect::<Vec<_>>()).unwrap();
        let path = path.to_string_lossy().into_owned();

        use base64::Engine;
        let first = read_chunk(&path, 0, 16).unwrap();
        assert_eq!(first.size, 100);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(first.base64)
                .unwrap(),
            (0..16u8).collect::<Vec<_>>()
        );
        // A window past the end is clamped, not an error.
        let tail = read_chunk(&path, 90, 4096).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(tail.base64)
                .unwrap(),
            (90..100u8).collect::<Vec<_>>()
        );
        // A start past the end reads nothing.
        let past = read_chunk(&path, 200, 16).unwrap();
        assert_eq!(past.base64, "");
    }

    #[test]
    fn walk_skips_excluded_folders_and_lists_repo_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("main.rs"), b"").unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src").join("lib.rs"), b"").unwrap();
        fs::create_dir_all(dir.path().join("node_modules").join("pkg")).unwrap();
        fs::write(
            dir.path().join("node_modules").join("pkg").join("index.js"),
            b"",
        )
        .unwrap();

        let files = walk_files(&dir.path().display().to_string());
        assert_eq!(files, ["main.rs", "src/lib.rs"]);
    }

    #[test]
    fn walk_honours_gitignore_keeps_dotfolders_and_has_no_cap() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".gitignore"), b"*.log\nbuild/\n").unwrap();
        fs::write(dir.path().join("keep.txt"), b"").unwrap();
        fs::write(dir.path().join("noise.log"), b"").unwrap();
        fs::create_dir_all(dir.path().join("build")).unwrap();
        fs::write(dir.path().join("build").join("x.o"), b"").unwrap();
        fs::create_dir_all(dir.path().join(".github")).unwrap();
        fs::write(dir.path().join(".github").join("ci.yml"), b"").unwrap();
        let many = dir.path().join("many");
        fs::create_dir_all(&many).unwrap();
        for i in 0..25_000 {
            fs::write(many.join(format!("f{i}")), b"").unwrap();
        }

        let files = walk_files(&dir.path().display().to_string());
        assert!(files.contains(&".github/ci.yml".to_owned()));
        assert!(files.contains(&".gitignore".to_owned()));
        assert!(files.contains(&"keep.txt".to_owned()));
        assert!(
            !files.contains(&"noise.log".to_owned()),
            "a .gitignore'd file is not listed"
        );
        assert!(
            !files.iter().any(|f| f.starts_with("build/")),
            "a .gitignore'd folder is not walked"
        );
        assert_eq!(
            files.iter().filter(|f| f.starts_with("many/")).count(),
            25_000,
            "the old 20,000 cap is gone"
        );
        assert!(files.windows(2).all(|w| w[0] < w[1]), "sorted and unique");
    }

    #[test]
    fn cache_serves_a_repeat_request_without_rewalking_and_invalidation_rewalks() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), b"").unwrap();
        let root = dir.path().display().to_string();
        let cache = FileListCache::default();

        assert_eq!(
            cached_file_list(&cache, &root, Duration::from_secs(60), walk_files),
            ["a.txt"]
        );

        // A new file lands after the walk: within the TTL the stale cached list is served…
        fs::write(dir.path().join("b.txt"), b"").unwrap();
        assert_eq!(
            cached_file_list(&cache, &root, Duration::from_secs(60), walk_files),
            ["a.txt"]
        );

        // …and after an Explorer mutation drops the cache, the next open sees it.
        cache.invalidate();
        assert_eq!(
            cached_file_list(&cache, &root, Duration::from_secs(60), walk_files),
            ["a.txt", "b.txt"]
        );

        // A different folder never shares the cache entry.
        let empty: fn(&str) -> Vec<String> = |_| vec![];
        assert_eq!(
            cached_file_list(&cache, "Z:/nowhere", Duration::from_secs(60), empty),
            Vec::<String>::new()
        );
    }
}

#[cfg(test)]
mod backup_tests {
    use super::*;

    #[test]
    fn backups_round_trip_list_and_clear() {
        let dir = tempfile::tempdir().unwrap();
        backup_write_into(dir.path(), "C:\\repo\\a.txt", "draft one".into()).unwrap();
        backup_write_into(dir.path(), "C:\\repo\\b.txt", "draft two".into()).unwrap();
        backup_write_into(dir.path(), "C:\\repo\\a.txt", "draft one, newer".into()).unwrap();
        let listed = backup_list_in(dir.path());
        assert_eq!(
            listed.iter().map(|b| b.path.as_str()).collect::<Vec<_>>(),
            ["C:\\repo\\a.txt", "C:\\repo\\b.txt"]
        );
        assert!(listed[0].saved_at > 0);
        assert_eq!(
            backup_read_in(dir.path(), "C:\\repo\\a.txt").unwrap(),
            "draft one, newer"
        );
        backup_clear_in(dir.path(), "C:\\repo\\a.txt");
        assert!(backup_read_in(dir.path(), "C:\\repo\\a.txt").is_err());
        assert_eq!(backup_list_in(dir.path()).len(), 1);
        // No stray temp files remain from the atomic writes.
        assert!(fs::read_dir(dir.path()).unwrap().flatten().all(|e| e
            .path()
            .extension()
            .and_then(|x| x.to_str())
            == Some("json")));
    }
}

#[cfg(test)]
mod head_info_tests {
    use super::*;

    #[test]
    fn parses_branch_upstream_and_counts_from_porcelain_v2() {
        let out = "# branch.oid 3b8b1f9e5b6cf01a03a3bf9b3f79be4b2c5c80d5\n\
                   # branch.head main\n\
                   # branch.upstream origin/main\n\
                   # branch.ab +2 -1\n\
                   1 .M N... 100644 100644 100644 abc def README.md\n";
        let info = parse_status_branch(out);
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.short_hash, "3b8b1f9");
        assert_eq!(info.upstream.as_deref(), Some("origin/main"));
        assert_eq!((info.ahead, info.behind), (2, 1));
    }

    #[test]
    fn detached_head_reports_the_hash_and_no_branch() {
        let out = "# branch.oid deadbeef00000000\n# branch.head (detached)\n";
        let info = parse_status_branch(out);
        assert_eq!(info.branch, None);
        assert_eq!(info.short_hash, "deadbee");
        assert_eq!(info.upstream, None);
        assert_eq!((info.ahead, info.behind), (0, 0));
    }

    #[test]
    fn an_empty_repository_has_no_hash_to_show() {
        let out = "# branch.oid (initial)\n# branch.head main\n";
        let info = parse_status_branch(out);
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.short_hash, "");
    }
}
