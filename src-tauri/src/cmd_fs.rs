//! Filesystem commands for the Explorer and the editor: the folder tree, file contents (of the
//! working tree, of the index, or of any revision, for the diff editors), and the Explorer's
//! own new/rename/delete operations.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ggs_git::runner::Git;
use crate::AppState;
use tauri::ipc::Channel;
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
    read_dir_sorted(&path)
}

fn read_dir_sorted(path: &str) -> Result<Vec<DirEntryInfo>, String> {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    let entries = fs::read_dir(path).map_err(|e| format!("{path}: {e}"))?;
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

/// A window of a directory listing (docs/ggs-remote-plan.md §10.3): the same order
/// `list_dir` spells, sliced — a remote Explorer on a metered link pages through a huge
/// directory instead of paying for it whole. `total` is the unfiltered count of that order.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirPage {
    pub entries: Vec<DirEntryInfo>,
    pub total: u32,
    pub offset: u32,
    pub limit: u32,
}

#[tauri::command]
pub async fn list_dir_page(path: String, offset: u32, limit: u32) -> Result<DirPage, String> {
    let all = read_dir_sorted(&path)?;
    let total = all.len() as u32;
    let window = all
        .into_iter()
        .skip(offset as usize)
        .take(limit.min(2000) as usize)
        .collect();
    Ok(DirPage {
        entries: window,
        total,
        offset,
        limit: limit.min(2000),
    })
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
    if ggs_text::encoding::looks_binary(&bytes) && !forced_utf16 {
        return FileContents {
            contents: None,
            binary: true,
            size,
            encoding: "utf8".into(),
            eol: "lf".into(),
        };
    }
    let decoded = ggs_text::encoding::decode(&bytes, forced);
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
    Ok(tauri::ipc::Response::new(raw_payload(
        &bytes,
        encoding.as_deref(),
    )))
}

/// Build `read_file_raw`'s payload: header length, metadata, text.
fn raw_payload(bytes: &[u8], forced: Option<&str>) -> Vec<u8> {
    let size = bytes.len() as u64;
    let forced_utf16 = matches!(forced, Some("utf-16le" | "utf-16be"));
    let (meta, text) = if ggs_text::encoding::looks_binary(bytes) && !forced_utf16 {
        (
            RawFileMeta {
                binary: true,
                size,
                encoding: "utf8".into(),
                eol: "lf".into(),
            },
            Vec::new(),
        )
    } else {
        let decoded = ggs_text::encoding::decode(bytes, forced);
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

#[tauri::command]
pub async fn file_probe(path: String) -> Result<ggs_text::probe::FileProbe, String> {
    ggs_text::probe::probe(&path)
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
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("{path}: {e}"))?;
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
    ggs_text::encoding::ENCODINGS
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
    let bytes = ggs_text::encoding::encode(
        &contents,
        encoding.as_deref().unwrap_or("utf8"),
        eol.as_deref().unwrap_or("lf"),
    );
    fs::write(target, bytes).map_err(|e| format!("{path}: {e}"))
}

/// A file's raw bytes at one revision, over the git CLI: `git cat-file` of `<rev>:<path>`,
/// where `:index` (the staged copy) reads the index's stage-0 entry. `Ok(None)` when the path
/// does not exist at that revision (the missing side of an added or deleted file); binary
/// content passes through undecoded. `pub(crate)`: the extension pages' byte services
/// (`cmd_ext`'s `ext_page_revision_bytes`) read revision sides through it too.
pub(crate) fn revision_file_bytes(
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
fn revision_file_text(
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
    let (rev, file_path) = (revision.clone(), path.clone());
    let (binary, contents) = tauri::async_runtime::spawn_blocking(move || {
        let git = Git::new(&repo_path);
        revision_file_text(&git, &rev, &file_path)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(FileContents {
        binary,
        size: contents.as_ref().map(|c| c.len() as u64).unwrap_or(0),
        eol: contents
            .as_deref()
            .map(ggs_text::encoding::detect_eol)
            .unwrap_or("lf")
            .into(),
        contents,
        encoding: "utf8".into(),
    })
}

/// A monotonic tag distinguishing one materialized blob's temp file from the next, so two
/// binary sides of the same basename (or repeat opens of the same diff) never collide.
static TEMP_BLOB_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A file's bytes at a revision, written to a private temp file so the byte-level comparison
/// views (Hex Compare, Hex View) can open it exactly like a file on disk — they stream from a
/// path, and a revision's content only exists in memory once the engine reads its blob. The
/// working tree sentinel `*` needs no copy and hands its own path straight back; a path absent
/// at the revision (the missing side of an added/deleted binary file) materializes as an empty
/// file, so the other side still has something to compare against.
#[tauri::command]
pub async fn materialize_revision_file(
    state: State<'_, AppState>,
    revision: String,
    path: String,
    repo: Option<String>,
) -> Result<String, String> {
    let repo_path = repo
        .or_else(|| state.first_repo())
        .ok_or_else(|| "No repository is open".to_string())?;
    if revision == "*" {
        let full = Path::new(&repo_path).join(&path);
        if full.is_file() {
            return Ok(full.display().to_string());
        }
        return write_temp_blob(&path, &[]);
    }
    let (rev, file_path) = (revision.clone(), path.clone());
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let git = Git::new(&repo_path);
        revision_file_bytes(&git, &rev, &file_path)
    })
    .await
    .map_err(|e| e.to_string())??;
    write_temp_blob(&path, &bytes.unwrap_or_default())
}

/// Write `bytes` to a fresh temp file named after `path`'s basename, in a directory unique to
/// this call, and return its absolute path.
fn write_temp_blob(path: &str, bytes: &[u8]) -> Result<String, String> {
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

/// Delete a temp file `materialize_revision_file` wrote, once the comparison view that asked
/// for it is gone. Only a file directly inside one of the studio temp blob directories under
/// the system temp dir is accepted — the command can never be aimed at a real file.
#[tauri::command]
pub fn discard_temp_blob(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    let not_a_blob = || format!("{path}: not a Studio temp blob");
    let parent = target.parent().ok_or_else(not_a_blob)?;
    let studio_dir = parent
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !parent.starts_with(std::env::temp_dir())
        || !studio_dir.starts_with("git-graph-studio-hex-")
        || target.file_name().is_none()
    {
        return Err(not_a_blob());
    }
    // The directory is unique to the one materialized blob, so removing it clears the file and
    // the directory together; one that is already gone means a previous discard won.
    match fs::remove_dir_all(parent) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{path}: {e}")),
    }
}

/// Where an upload accumulates until its last chunk arrives (a sibling of the target, so the
/// final rename never crosses a file system).
fn upload_partial(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    target.with_file_name(format!("{name}.ggs-upload"))
}

/// The canonical form of a path that may not exist yet: the nearest existing ancestor
/// canonicalized, the missing tail re-appended. `..` segments collapse to the real path.
fn canonicalize_lenient(path: &Path) -> Option<PathBuf> {
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = path;
    loop {
        match fs::canonicalize(cursor) {
            Ok(mut canonical) => {
                for part in missing.iter().rev() {
                    canonical.push(part);
                }
                return Some(canonical);
            }
            Err(_) => {
                missing.push(cursor.file_name()?.to_os_string());
                cursor = cursor.parent()?;
            }
        }
    }
}

/// Remote Access uploads land inside the open folders only (docs/ggs-remote-plan.md §7.8 —
/// the download side confines the same way): an authenticated browser session must not
/// write outside the workspace it serves. `path` may not exist yet; its tail canonicalizes
/// through its nearest existing ancestor.
pub(crate) fn upload_allowed(path: &Path, roots: &[PathBuf]) -> bool {
    let Some(canonical) = canonicalize_lenient(path) else {
        return false;
    };
    roots
        .iter()
        .filter_map(|root| canonicalize_lenient(root))
        .any(|root| canonical.starts_with(root))
}

/// One upload's chunks serialize per process: two uploads of one target would otherwise
/// interleave their appends (the offset check fails loudly, but the round trip it costs the
/// user is avoidable).
static UPLOAD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Write one upload chunk at `offset` of a file that will be `total` bytes. Chunks must
/// arrive in order (the partial file's length is the resume point); the last one moves the
/// partial file into place.
pub fn write_upload_chunk(
    target: &Path,
    offset: u64,
    total: u64,
    bytes: &[u8],
) -> Result<u64, String> {
    use std::io::{Seek, SeekFrom, Write};
    let _guard = UPLOAD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if offset + bytes.len() as u64 > total {
        return Err(format!(
            "{}: chunk past the declared size",
            target.display()
        ));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let partial = upload_partial(target);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(offset == 0)
        .open(&partial)
        .map_err(|e| format!("{}: {e}", partial.display()))?;
    let have = file.metadata().map(|m| m.len()).unwrap_or(0);
    if have != offset {
        return Err(format!(
            "upload offset mismatch: the PC has {have} bytes, the chunk starts at {offset}"
        ));
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .map_err(|e| format!("{}: {e}", partial.display()))?;
    let written = offset + bytes.len() as u64;
    drop(file);
    if written == total {
        fs::rename(&partial, target).map_err(|e| format!("{}: {e}", target.display()))?;
    }
    Ok(written)
}

/// Remote Access uploads (docs/ggs-remote-plan.md §11.3): one chunk as the raw request body,
/// the target in `x-ggs-path` (percent-encoded), its position in `x-ggs-offset` and the
/// file's size in `x-ggs-total`. Answers the bytes the PC now has. The target is confined to
/// the open folders — a browser session writes nowhere else (§7.8).
#[tauri::command]
pub fn fs_write_chunk(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<u64, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("fs_write_chunk expects a binary body".into());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| format!("missing {name}"))
    };
    let path = ggs_base::fsx::percent_decode(&header("x-ggs-path")?);
    let offset: u64 = header("x-ggs-offset")?
        .parse()
        .map_err(|_| "bad x-ggs-offset")?;
    let total: u64 = header("x-ggs-total")?
        .parse()
        .map_err(|_| "bad x-ggs-total")?;
    let roots: Vec<PathBuf> = state
        .repos
        .lock()
        .unwrap()
        .iter()
        .map(PathBuf::from)
        .collect();
    if !upload_allowed(Path::new(&path), &roots) {
        return Err(format!("{path}: uploads land inside the open folders only"));
    }
    write_upload_chunk(Path::new(&path), offset, total, bytes)
}

/// The roots a remote session's path-carrying invokes are confined to (§23.4, the
/// 2026-10-13 audit's F1): the open folders plus a single-file launch. The Relay asks for
/// these locally (no session header) and enforces the boundary before forwarding an
/// invoke — the app's own commands stay unconfined for the desktop window that runs them.
#[tauri::command]
pub fn remote_paths_policy(state: State<'_, AppState>) -> Vec<String> {
    let mut roots: Vec<String> = state.repos.lock().unwrap().clone();
    if let Some(file) = state.single_file.lock().unwrap().clone() {
        roots.push(file);
    }
    roots
}

/// The extension-platform roots a remote session's `ext_fs` may ALSO reach, beyond the open
/// folders (§23.4): the installed packages' own files, the extensions' storage area and
/// their own log directory — exactly the surfaces the desktop's `ext_fs` contract already
/// allows (the extension host passes them as the call's roots). An extension reading its
/// own bundled files — Python copying `pythonrc.py` out of its install — or its stored
/// state is ordinary activation traffic, not a boundary crossing; without these roots every
/// such activation fails from a browser session. The rest of `~/.ggs` (settings, provider
/// keys, Claude state, the remote password) stays outside: only these three subtrees cross.
#[tauri::command]
pub fn remote_ext_roots() -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    if let Ok(store) = ggs_base::paths::extensions_home() {
        if let Some(home) = store.parent() {
            for rel in ["extensions", "extension-data", "logs/extensions"] {
                roots.push(home.join(rel).to_string_lossy().into_owned());
            }
        }
    }
    roots
}

/// Where an interrupted upload of `path` resumes: the partial file's length when it is not
/// larger than the file being uploaded, else 0 (a different file — start over).
fn upload_offset(path: &Path, size: u64) -> u64 {
    let partial = upload_partial(path);
    match fs::metadata(&partial) {
        Ok(meta) if meta.len() <= size => meta.len(),
        _ => 0,
    }
}

/// The resume point of an interrupted upload, confined like the write itself (a refused
/// path errors, and the write refuses too).
#[tauri::command]
pub fn fs_upload_offset(
    state: State<'_, AppState>,
    path: String,
    size: u64,
) -> Result<u64, String> {
    let roots: Vec<PathBuf> = state
        .repos
        .lock()
        .unwrap()
        .iter()
        .map(PathBuf::from)
        .collect();
    if !upload_allowed(Path::new(&path), &roots) {
        return Err(format!("{path}: uploads land inside the open folders only"));
    }
    Ok(upload_offset(Path::new(&path), size))
}

#[cfg(test)]
mod paging_tests {
    use super::list_dir_page;

    #[tokio::test]
    async fn pages_the_same_order_list_dir_spells() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..7 {
            std::fs::write(dir.path().join(format!("f{i}.txt")), b"x").unwrap();
        }
        std::fs::create_dir(dir.path().join("zed")).unwrap();
        let path = dir.path().display().to_string();
        let page = list_dir_page(path.clone(), 0, 3).await.unwrap();
        assert_eq!(page.total, 8);
        assert_eq!(page.entries.len(), 3);
        // The folder leads: zed, then f0….
        assert_eq!(page.entries[0].name, "zed");
        assert_eq!(page.entries[1].name, "f0.txt");
        let next = list_dir_page(path.clone(), 3, 3).await.unwrap();
        assert_eq!(next.entries[0].name, "f2.txt"); // page 1 was zed, f0, f1
        let tail = list_dir_page(path.clone(), 6, 3).await.unwrap();
        assert_eq!(tail.entries.len(), 2);
        // Past the end: empty, not an error.
        let past = list_dir_page(path, 99, 3).await.unwrap();
        assert!(past.entries.is_empty());
    }
}

#[cfg(test)]
mod upload_tests {
    use super::{upload_allowed, upload_offset, write_upload_chunk};

    #[test]
    fn chunks_resume_and_land_whole() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("sub").join("photo.bin");
        let data: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        assert_eq!(
            write_upload_chunk(&target, 0, 1000, &data[..400]).unwrap(),
            400
        );
        assert!(!target.exists());
        // A restarted upload asks where to resume.
        assert_eq!(upload_offset(&target, 1000), 400);
        assert!(write_upload_chunk(&target, 300, 1000, &data[300..400]).is_err());
        assert_eq!(
            write_upload_chunk(&target, 400, 1000, &data[400..]).unwrap(),
            1000
        );
        assert_eq!(std::fs::read(&target).unwrap(), data);
        assert_eq!(upload_offset(&target, 1000), 0);
        assert!(write_upload_chunk(&target, 0, 10, &[0; 11]).is_err());
    }

    #[test]
    fn uploads_are_confined_to_the_workspace_roots() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let roots = vec![root.clone()];
        // Existing file, missing file and missing-deep-tail all pass inside the root.
        assert!(upload_allowed(&root.join("a.txt"), &roots));
        assert!(upload_allowed(
            &root.join("sub").join("deep").join("a.txt"),
            &roots
        ));
        // A sibling, the parent, an escape and an unrelated drive path are refused.
        assert!(!upload_allowed(&dir.path().join("other.txt"), &roots));
        assert!(!upload_allowed(dir.path(), &roots));
        assert!(!upload_allowed(&root.join("..").join("escape.txt"), &roots));
        assert!(!upload_allowed(
            std::path::Path::new(if cfg!(windows) {
                "C:\\Windows\\x.dll"
            } else {
                "/etc/x"
            }),
            &roots
        ));
        // No folder open: nowhere to upload.
        assert!(!upload_allowed(&root.join("a.txt"), &[]));
    }
}

#[cfg(test)]
mod temp_blob_tests {
    use super::{discard_temp_blob, write_temp_blob};

    #[test]
    fn writes_the_bytes_under_the_original_basename() {
        let path = write_temp_blob("some/repo/relative/archive.bin", b"one\0two").unwrap();
        assert!(path.ends_with("archive.bin"));
        assert_eq!(std::fs::read(&path).unwrap(), b"one\0two");
    }

    #[test]
    fn an_empty_slice_still_produces_a_readable_zero_byte_file() {
        let path = write_temp_blob("added.bin", &[]).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn repeat_calls_for_the_same_name_never_collide() {
        let first = write_temp_blob("archive.bin", b"left").unwrap();
        let second = write_temp_blob("archive.bin", b"right").unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(&first).unwrap(), b"left");
        assert_eq!(std::fs::read(&second).unwrap(), b"right");
    }

    #[test]
    fn discard_removes_the_blobs_own_directory_and_tolerates_a_repeat() {
        let path = write_temp_blob("pair/logo.png", b"\x89PNG").unwrap();
        let dir = std::path::Path::new(&path).parent().unwrap().to_path_buf();
        discard_temp_blob(path.clone()).unwrap();
        assert!(!dir.exists());
        discard_temp_blob(path).unwrap(); // already gone: not an error
    }

    #[test]
    fn discard_refuses_anything_outside_the_studio_temp_prefix() {
        let err = discard_temp_blob("C:\\real\\file.bin".to_string()).unwrap_err();
        assert!(err.contains("not a Studio temp blob"));
        // The studio temp directory itself (not a file inside one) is refused too.
        let dir_only = std::env::temp_dir()
            .join("git-graph-studio-hex-made-up-1")
            .display()
            .to_string();
        assert!(discard_temp_blob(dir_only).is_err());
    }
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
pub(crate) fn repo_folder_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map_or_else(String::new, |name| name.to_string_lossy().into_owned())
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
    let mut info = parse_status_branch(&out);
    info.repo = repo_folder_name(&repo_path);
    Ok(info)
}

/// The `# branch.*` header lines of `git status --porcelain=v2 --branch`, as `HeadInfo`.
/// A detached HEAD reports `branch.head (detached)`, an empty repo `branch.oid (initial)`.
pub(crate) fn parse_status_branch(out: &str) -> HeadInfo {
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
        .join(format!(
            "git-graph-studio-session-{}.log",
            std::process::id()
        ))
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
    if cfg!(windows)
        && a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    {
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
pub fn delete_path(
    state: State<'_, AppState>,
    path: String,
    permanent: Option<bool>,
) -> Result<(), String> {
    state.file_list_cache.invalidate();
    let target = checked(&path)?;
    let meta = fs::symlink_metadata(&target).map_err(|e| format!("{path}: {e}"))?;
    if !permanent.unwrap_or(false) {
        return trash::delete(&target)
            .map_err(|e| format!("{path}: could not move to the Recycle Bin: {e}"));
    }
    if meta.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| format!("{path}: {e}"))
    } else {
        fs::remove_file(&target).map_err(|e| format!("{path}: {e}"))
    }
}

/// Copy files or folders into an open folder's directory — the Explorer's external drop
/// (files dragged from the PC's own file manager onto the tree). `sources` are absolute
/// paths from anywhere on the machine; `dest_dir` is the folder the drop landed on. An
/// entry that already exists is never clobbered: the copy lands beside it as
/// "name (copy).ext", then "(copy 2)", the way Explorer's own duplicate paste names
/// them. Dropping an entry onto the folder that already holds it is a no-op, and a
/// folder cannot be copied into itself. Returns the paths that landed.
#[tauri::command]
pub fn copy_into(
    state: State<'_, AppState>,
    sources: Vec<String>,
    dest_dir: String,
) -> Result<Vec<String>, String> {
    state.file_list_cache.invalidate();
    copy_into_paths(&sources, &dest_dir)
}

pub(crate) fn copy_into_paths(sources: &[String], dest_dir: &str) -> Result<Vec<String>, String> {
    let dest = checked(dest_dir)?;
    if !dest.is_dir() {
        return Err(format!("{dest_dir} is not a folder"));
    }
    let dest_canon = fs::canonicalize(&dest).map_err(|e| format!("{dest_dir}: {e}"))?;
    let mut landed = Vec::new();
    for source in sources {
        let from = checked(source)?;
        let meta = fs::symlink_metadata(&from).map_err(|e| format!("{source}: {e}"))?;
        // An entry dropped onto its own containing folder is a no-op, not a duplicate.
        if from.parent().is_some_and(|parent| same_entry(parent, &dest)) {
            continue;
        }
        if meta.is_dir() {
            let from_canon = fs::canonicalize(&from).map_err(|e| format!("{source}: {e}"))?;
            if dest_canon.starts_with(&from_canon) {
                return Err(format!("{source} cannot be copied into itself"));
            }
        }
        let name = from
            .file_name()
            .ok_or_else(|| format!("{source}: not a file name"))?
            .to_string_lossy()
            .into_owned();
        let target = unique_target(&dest, &name);
        if meta.is_dir() {
            copy_dir(&from, &target)?;
        } else {
            fs::copy(&from, &target).map_err(|e| format!("{source}: {e}"))?;
        }
        landed.push(target.to_string_lossy().into_owned());
    }
    Ok(landed)
}

/// The first free spelling of `name` inside `dest`: itself, then " (copy)", " (copy 2)"...
fn unique_target(dest: &Path, name: &str) -> PathBuf {
    let candidate = dest.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_owned());
    let extension = path
        .extension()
        .map(|e| e.to_string_lossy().into_owned());
    for n in 1u32.. {
        let suffix = if n == 1 {
            " (copy)".to_owned()
        } else {
            format!(" (copy {n})")
        };
        let spelled = match &extension {
            Some(ext) => format!("{stem}{suffix}.{ext}"),
            None => format!("{stem}{suffix}"),
        };
        let candidate = dest.join(spelled);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("u32 overflow before the disk fills")
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("{}: {e}", to.display()))?;
    for entry in fs::read_dir(from).map_err(|e| format!("{}: {e}", from.display()))? {
        let entry = entry.map_err(|e| format!("{}: {e}", from.display()))?;
        let target = to.join(entry.file_name());
        if entry.file_type().map_err(|e| format!("{}: {e}", entry.path().display()))?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|e| format!("{}: {e}", entry.path().display()))?;
        }
    }
    Ok(())
}

// ---- File transfers: the desktop half of the workbench's transfer layer ----
//
// One vocabulary in every environment (`src/transfer.ts`): a browser session rides the
// remote wire (the chunked `fs_write_chunk` uploads and the daemon's one-time download
// tickets), and the desktop app drives native pickers plus these commands. The boundary
// stays as it was: a remote session never reaches `fs_import` / `fs_export` at all (the
// Relay refuses them — src/remote/pathGate.ts), because their paths name anywhere on the
// machine, which is the desktop user's own picker's business, never a browser's.

/// One progress report of a running desktop transfer: the entry being moved and the byte
/// counter over the whole job's total.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub name: String,
    pub bytes: u64,
    pub total: u64,
}

/// One entry that never landed, with the error that stopped it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferFailure {
    pub name: String,
    pub error: String,
}

/// What a desktop transfer settled on: the paths that landed, per-entry failures (one bad
/// entry never strands the rest), and whether the Cancel action stopped it early.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferReport {
    pub landed: Vec<String>,
    pub failed: Vec<TransferFailure>,
    pub cancelled: bool,
}

/// The running transfer's generation, for cancellation — the same shape search
/// cancellation uses: every transfer takes the next number and stops as soon as the
/// counter moves on.
#[derive(Default)]
pub struct TransferState {
    generation: std::sync::atomic::AtomicU64,
}

impl TransferState {
    fn next(&self) -> u64 {
        self.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(std::sync::atomic::Ordering::SeqCst) == generation
    }

    pub fn cancel(&self) {
        self.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Stop the running transfer (the progress toast's Cancel action): the copy loop honours
/// the generation change at the next chunk boundary and settles cancelled.
#[tauri::command]
pub fn fs_transfer_cancel(state: State<'_, AppState>) {
    state.transfer.cancel();
}

/// The transfer chunk: progress reports and cancellation land at this granularity.
const TRANSFER_CHUNK: usize = 1024 * 1024;

/// Where a streaming copy accumulates until it completes (a sibling of the target, so the
/// final rename never crosses a file system); removed when the copy dies or is cancelled.
fn transfer_partial(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    target.with_file_name(format!("{name}.ggs-transfer"))
}

/// Upload from the PC's own disk into an open folder — the desktop half of the transfer
/// layer's `uploadInto` (`src/transfer.ts`): the native picker chose `sources` anywhere on
/// the machine and they land inside `target_dir` beside whatever already exists there
/// (the ` (copy)` naming rule the Explorer's own drop copy applies — a desktop upload
/// never clobbers). Progress streams through `on_progress`; a cancel stops the whole job
/// between chunks, leaving every landed file whole.
#[tauri::command]
pub async fn fs_import(
    state: State<'_, AppState>,
    sources: Vec<String>,
    target_dir: String,
    on_progress: Channel<TransferProgress>,
) -> Result<TransferReport, String> {
    let transfer = state.transfer.clone();
    let generation = transfer.next();
    let cache = state.file_list_cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let report = import_sources(
            &sources,
            &target_dir,
            &|p| {
                let _ = on_progress.send(p);
            },
            &|| !transfer.is_current(generation),
        );
        cache.invalidate();
        report
    })
    .await
    .map_err(|e| format!("The transfer thread failed: {e}"))
}

/// The byte total of a transfer plan: one walk up front so every progress report carries
/// an honest denominator. Unreadable entries are counted as zero and fail in the copy
/// pass, which reports them by name.
fn tree_size(root: &Path) -> u64 {
    let meta = match fs::symlink_metadata(root) {
        Ok(meta) => meta,
        Err(_) => return 0,
    };
    if !meta.is_dir() {
        return meta.len();
    }
    let mut total = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        let Ok(entries) = fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    total
}

/// The import engine (`fs_import`'s core, pure so the tests drive it without Tauri):
/// copies each source (a file, or a folder tree under its own name) into `dest_dir`,
/// never clobbering what is already there, streaming progress and honouring cancellation.
fn import_sources(
    sources: &[String],
    dest_dir: &str,
    progress: &dyn Fn(TransferProgress),
    cancelled: &dyn Fn() -> bool,
) -> TransferReport {
    let mut report = TransferReport::default();
    let dest = match checked(dest_dir) {
        Ok(dest) if dest.is_dir() => dest,
        Ok(_) => {
            report.failed.push(TransferFailure {
                name: dest_dir.to_owned(),
                error: "is not a folder".to_owned(),
            });
            return report;
        }
        Err(error) => {
            report.failed.push(TransferFailure {
                name: dest_dir.to_owned(),
                error,
            });
            return report;
        }
    };
    let total: u64 = sources
        .iter()
        .map(|s| tree_size(Path::new(s)))
        .sum();
    let mut job = TransferJob { bytes: 0, total, progress, cancelled };
    for source in sources {
        if job.cancelled() {
            report.cancelled = true;
            return report;
        }
        let name = Path::new(source)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| source.clone());
        match import_one(Path::new(source), &dest, &name, &mut job) {
            Ok(landed) => {
                if let Some(path) = landed {
                    report.landed.push(path);
                }
            }
            // A cancel mid-file stops the whole job — every landed file stays whole, and
            // what never started stays unstarted.
            Err(error) if error == CANCELLED => {
                report.cancelled = true;
                return report;
            }
            Err(error) => report.failed.push(TransferFailure { name, error }),
        }
    }
    // The closing report, an empty name: the toast lands at its final counters.
    job.tick("");
    report
}

/// The job-wide state a transfer's every entry shares: the byte counters behind the
/// progress toast's numerator and denominator, and the callbacks each entry honours.
struct TransferJob<'a> {
    /// The bytes landed so far, across every source.
    bytes: u64,
    /// The whole job's size, walked up front (`tree_size`).
    total: u64,
    progress: &'a dyn Fn(TransferProgress),
    cancelled: &'a dyn Fn() -> bool,
}

impl TransferJob<'_> {
    fn cancelled(&self) -> bool {
        (self.cancelled)()
    }

    /// Report one chunk's worth of `name` at the job's current counters.
    fn tick(&self, name: &str) {
        (self.progress)(TransferProgress {
            name: name.to_owned(),
            bytes: self.bytes,
            total: self.total,
        });
    }
}

/// Import one source. `Ok(None)` is the no-op (a file dropped on its own containing
/// folder); `Err` fails this source alone.
fn import_one(
    source: &Path,
    dest: &Path,
    name: &str,
    job: &mut TransferJob,
) -> Result<Option<String>, String> {
    let meta = fs::symlink_metadata(source).map_err(|e| format!("{name}: {e}"))?;
    // An entry landed on its own containing folder is a no-op, not a duplicate.
    if source.parent().is_some_and(|parent| same_entry(parent, dest)) {
        return Ok(None);
    }
    let dest_canon = fs::canonicalize(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    if meta.is_dir() {
        let source_canon = fs::canonicalize(source).map_err(|e| format!("{name}: {e}"))?;
        if dest_canon.starts_with(&source_canon) {
            return Err(format!("{name} cannot be copied into itself"));
        }
    }
    let target = unique_target(dest, name);
    if meta.is_dir() {
        import_dir(source, &target, name, job)?;
    } else {
        copy_file_streaming(source, &target, name, job)?;
    }
    Ok(Some(target.to_string_lossy().into_owned()))
}

/// Walk a folder source into `target`, creating it and every subfolder, streaming every
/// file through the partial-rename copy.
fn import_dir(
    source: &Path,
    target: &Path,
    name: &str,
    job: &mut TransferJob,
) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|e| format!("{name}: {e}"))?;
    let entries = fs::read_dir(source).map_err(|e| format!("{name}: {e}"))?;
    let children: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    for child in children {
        if job.cancelled() {
            return Err(CANCELLED.to_owned());
        }
        let child_name = child
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let child_target = target.join(&child_name);
        let display = format!("{name}/{child_name}");
        if child.is_dir() {
            import_dir(&child, &child_target, &display, job)?;
        } else {
            copy_file_streaming(&child, &child_target, &display, job)?;
        }
    }
    Ok(())
}

/// What a cancelled copy fails with (mapped back into `report.cancelled` by the caller).
const CANCELLED: &str = "cancelled";

/// Copy one file through a partial sibling, reporting progress and honouring cancellation
/// at every chunk; a death or a cancel leaves no partial behind.
fn copy_file_streaming(
    source: &Path,
    target: &Path,
    name: &str,
    job: &mut TransferJob,
) -> Result<(), String> {
    use std::io::{Read, Write};
    let partial = transfer_partial(target);
    let mut reader =
        fs::File::open(source).map_err(|e| format!("{name}: {e}"))?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{name}: {e}"))?;
    }
    let mut writer = fs::File::create(&partial).map_err(|e| format!("{name}: {e}"))?;
    let mut buf = vec![0u8; TRANSFER_CHUNK];
    loop {
        if job.cancelled() {
            drop((reader, writer));
            let _ = fs::remove_file(&partial);
            return Err(CANCELLED.to_owned());
        }
        let n = reader.read(&mut buf).map_err(|e| format!("{name}: {e}"))?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).map_err(|e| format!("{name}: {e}"))?;
        job.bytes += n as u64;
        job.tick(name);
    }
    drop((reader, writer));
    fs::rename(&partial, target).map_err(|e| format!("{name}: {e}"))?;
    Ok(())
}

/// Download to the PC's own disk — the desktop half of the transfer layer's `downloadTo`
/// (`src/transfer.ts`): a file copies to `dest` (the save dialog's full path), a folder
/// (or any path with `zip`) packs into a zip archive there. Progress streams; a cancel
/// stops it and removes the partial destination.
#[tauri::command]
pub async fn fs_export(
    state: State<'_, AppState>,
    path: String,
    dest: String,
    zip: Option<bool>,
    on_progress: Channel<TransferProgress>,
) -> Result<TransferReport, String> {
    let transfer = state.transfer.clone();
    let generation = transfer.next();
    tauri::async_runtime::spawn_blocking(move || {
        export_path(
            Path::new(&path),
            Path::new(&dest),
            zip.unwrap_or(false),
            &|p| {
                let _ = on_progress.send(p);
            },
            &|| !transfer.is_current(generation),
        )
    })
    .await
    .map_err(|e| format!("The transfer thread failed: {e}"))
}

/// The export engine (`fs_export`'s core, pure so the tests drive it without Tauri).
fn export_path(
    source: &Path,
    dest: &Path,
    zip: bool,
    progress: &dyn Fn(TransferProgress),
    cancelled: &dyn Fn() -> bool,
) -> TransferReport {
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_owned());
    let mut report = TransferReport::default();
    let Ok(meta) = fs::symlink_metadata(source) else {
        report.failed.push(TransferFailure {
            name,
            error: "no such file or directory".to_owned(),
        });
        return report;
    };
    if meta.is_dir() || zip {
        let total = tree_size(source);
        let mut counter = TransferCounter { bytes: 0, total, name: name.clone(), progress };
        let outcome = (|| -> std::io::Result<()> {
            let file = fs::File::create(dest)?;
            let mut buffered = std::io::BufWriter::new(file);
            zip_tree_reporting(source, &mut buffered, &mut |n| counter.file_bytes(n), cancelled)
                .map_err(|e| match e {
                    zip::result::ZipError::Io(io) => io,
                    other => std::io::Error::other(other.to_string()),
                })?;
            use std::io::Write;
            buffered.flush()
        })();
        match outcome {
            Ok(()) => {
                counter.finish();
                report.landed.push(dest.to_string_lossy().into_owned());
            }
            Err(error) => {
                // A cancelled or failed export leaves no partial archive behind.
                let _ = fs::remove_file(dest);
                if error.to_string().contains(CANCELLED) {
                    report.cancelled = true;
                } else {
                    report
                        .failed
                        .push(TransferFailure { name, error: error.to_string() });
                }
            }
        }
        return report;
    }
    let total = meta.len();
    let mut job = TransferJob { bytes: 0, total, progress, cancelled };
    match copy_file_streaming(source, dest, &name, &mut job) {
        Ok(()) => {
            job.tick(&name);
            report.landed.push(dest.to_string_lossy().into_owned());
        }
        Err(error) if error == CANCELLED => {
            report.cancelled = true;
        }
        Err(error) => report.failed.push(TransferFailure { name, error }),
    }
    report
}

/// The zip export's byte counter: the archive is written compressed, so the progress
/// reports count the bytes read out of the tree, not the (smaller) archive stream.
struct TransferCounter<'a> {
    bytes: u64,
    total: u64,
    name: String,
    progress: &'a dyn Fn(TransferProgress),
}

impl TransferCounter<'_> {
    fn file_bytes(&mut self, n: u64) {
        self.bytes += n;
        (self.progress)(TransferProgress {
            name: self.name.clone(),
            bytes: self.bytes,
            total: self.total,
        });
    }

    fn finish(&self) {
        (self.progress)(TransferProgress {
            name: self.name.clone(),
            bytes: self.bytes,
            total: self.total,
        });
    }
}

/// Zip a file or a folder tree, skipping `.git` and whatever cannot be read (the remote
/// download path's silent walk).
pub(crate) fn zip_tree<W: std::io::Write + std::io::Seek>(
    root: &Path,
    sink: W,
) -> zip::result::ZipResult<W> {
    zip_tree_reporting(root, sink, &mut |_| {}, &|| false)
}

/// `zip_tree` with the reporting hooks the desktop export drives: every chunk read out of
/// a file crosses `on_bytes`, and `cancelled` aborts the archive between chunks.
fn zip_tree_reporting<W: std::io::Write + std::io::Seek>(
    root: &Path,
    sink: W,
    on_bytes: &mut dyn FnMut(u64),
    cancelled: &dyn Fn() -> bool,
) -> zip::result::ZipResult<W> {
    use std::io::{Read, Write};
    let mut writer = zip::ZipWriter::new(sink);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let base = if root.is_dir() {
        root.to_path_buf()
    } else {
        root.parent().map(Path::to_path_buf).unwrap_or_default()
    };
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        if cancelled() {
            return Err(zip::result::ZipError::Io(std::io::Error::other(CANCELLED)));
        }
        if path.is_dir() {
            if path.file_name().is_some_and(|n| n == ".git") {
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(&path) {
                let mut children: Vec<PathBuf> =
                    entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
                children.sort();
                stack.extend(children.into_iter().rev());
            }
            continue;
        }
        let Ok(rel) = path.strip_prefix(&base) else {
            continue;
        };
        let name = rel.to_string_lossy().replace('\\', "/");
        let Ok(mut reader) = std::fs::File::open(&path) else {
            continue;
        };
        writer.start_file(name, options)?;
        let mut buf = vec![0u8; TRANSFER_CHUNK];
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            writer.write_all(&buf[..n])?;
            on_bytes(n as u64);
        }
    }
    writer.finish()
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

/// Keep an unsaved buffer's contents (called a moment after every edit).
#[tauri::command]
pub async fn backup_write(path: String, contents: String) -> Result<(), String> {
    ggs_text::backup::write_into(&ggs_text::backup::backups_dir()?, &path, contents)
}

/// The buffer was saved or its changes discarded: nothing to recover any more.
#[tauri::command]
pub async fn backup_clear(path: String) -> Result<(), String> {
    ggs_text::backup::clear_in(&ggs_text::backup::backups_dir()?, &path);
    Ok(())
}

/// Every backup on disk (the ones of a previous session that did not end cleanly).
#[tauri::command]
pub async fn backup_list() -> Result<Vec<ggs_text::backup::BackupInfo>, String> {
    Ok(ggs_text::backup::list_in(&ggs_text::backup::backups_dir()?))
}

#[tauri::command]
pub async fn backup_read(path: String) -> Result<String, String> {
    ggs_text::backup::read_in(&ggs_text::backup::backups_dir()?, &path)
}

/// The roots of the repository's initialised submodules (absolute paths), as the repository
/// dropdowns list them alongside the repository itself: `.gitmodules`'s entries whose working
/// tree copy is checked out (a `.git` exists below it). Never errors — anything unreadable
/// just lists nothing.
#[tauri::command]
pub fn repo_submodules(repo: String) -> Vec<String> {
    let git = Git::new(&repo);
    let Ok(listing) = git.output(&[
        "config",
        "--file",
        ".gitmodules",
        "--get-regexp",
        r"^submodule\..*\.path$",
    ]) else {
        return Vec::new();
    };
    listing
        .lines()
        .filter_map(|line| line.split_once(' ').map(|(_, rel)| rel.trim().to_owned()))
        .filter(|rel| !rel.is_empty())
        .filter(|rel| Path::new(&repo).join(rel).join(".git").exists())
        .map(|rel| Path::new(&repo).join(rel).display().to_string())
        .collect()
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
                BytePatch {
                    offset: 3,
                    byte: 0xaa,
                },
                BytePatch {
                    offset: 15,
                    byte: 0xbb,
                },
            ],
        )
        .unwrap();
        let patched = fs::read(&path).unwrap();
        assert_eq!(
            patched,
            [0, 1, 2, 0xaa, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 0xbb]
        );
        // An offset past the end is refused, leaving the file as it was.
        let err = patch_bytes(
            &path,
            &[BytePatch {
                offset: 99,
                byte: 1,
            }],
        )
        .unwrap_err();
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
        let header_len = u64::from_le_bytes(payload[..8].try_into().unwrap()) as usize;
        let meta: serde_json::Value = serde_json::from_slice(&payload[8..8 + header_len]).unwrap();
        assert_eq!(meta["binary"], false);
        assert_eq!(meta["eol"], "crlf");
        assert_eq!(&payload[8 + header_len..], b"hello\r\nworld");
        // A binary sniff yields no text, only the header saying so.
        let binary = raw_payload(b"ab\0cd", None);
        let header_len = u64::from_le_bytes(binary[..8].try_into().unwrap()) as usize;
        let meta: serde_json::Value = serde_json::from_slice(&binary[8..8 + header_len]).unwrap();
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
                ggs_text::probe::probe(&path).unwrap(),
                ggs_text::probe::FileProbe {
                    size: bytes.len() as u64,
                    binary,
                    long_lines
                },
                "{name}"
            );
            assert_eq!(decode(bytes, None).binary, binary, "{name}");
        }
        assert!(ggs_text::probe::probe(&dir.path().join("missing").to_string_lossy()).is_err());
    }

    #[test]
    fn probe_flags_minified_heads_as_long_lines() {
        let dir = tempfile::tempdir().unwrap();
        // A 32 KiB unbroken run inside the sniff window flags the file.
        let minified = dir.path().join("min.js");
        fs::write(&minified, vec![b'x'; 33 * 1024]).unwrap();
        assert!(ggs_text::probe::probe(&minified.to_string_lossy()).unwrap().long_lines);
        // A head with no break at all flags only when the file is large: a 2 MB single-line
        // JSON dump is exactly the case to keep away from a line-windowed editor.
        let one_line = dir.path().join("one.json");
        fs::write(&one_line, vec![b'x'; 2 * 1024 * 1024]).unwrap();
        assert!(ggs_text::probe::probe(&one_line.to_string_lossy()).unwrap().long_lines);
        // Ordinary multi-line files of any size do not.
        let lines = dir.path().join("lines.log");
        fs::write(&lines, "short\nlines\nonly\n".repeat(100_000)).unwrap();
        let probed = ggs_text::probe::probe(&lines.to_string_lossy()).unwrap();
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
mod copy_into_tests {
    use super::*;

    #[test]
    fn copies_files_and_folders_into_the_drop_folder() {
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        fs::write(src.path().join("notes.txt"), b"dropped").unwrap();
        fs::create_dir(src.path().join("pack")).unwrap();
        fs::write(src.path().join("pack").join("inner.md"), b"#").unwrap();

        let sources = [
            src.path().join("notes.txt").to_string_lossy().into_owned(),
            src.path().join("pack").to_string_lossy().into_owned(),
        ];
        let landed = copy_into_paths(&sources, &dest.path().to_string_lossy()).unwrap();
        assert_eq!(landed.len(), 2, "{landed:?}");
        assert_eq!(
            fs::read(dest.path().join("notes.txt")).unwrap(),
            b"dropped",
            "a file copies with its contents"
        );
        assert_eq!(
            fs::read(dest.path().join("pack").join("inner.md")).unwrap(),
            b"#",
            "a folder copies recursively"
        );
    }

    #[test]
    fn an_existing_entry_is_never_clobbered_but_lands_beside_it() {
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        fs::write(src.path().join("a.txt"), b"new").unwrap();
        fs::write(dest.path().join("a.txt"), b"old").unwrap();
        fs::write(dest.path().join("a (copy).txt"), b"first copy").unwrap();
        // A directory lands beside its namesake the same way.
        fs::create_dir(src.path().join("pack")).unwrap();
        fs::create_dir(dest.path().join("pack")).unwrap();

        let sources = [
            src.path().join("a.txt").to_string_lossy().into_owned(),
            src.path().join("pack").to_string_lossy().into_owned(),
        ];
        let landed = copy_into_paths(&sources, &dest.path().to_string_lossy()).unwrap();
        assert_eq!(
            fs::read(dest.path().join("a.txt")).unwrap(),
            b"old",
            "the existing file keeps its contents"
        );
        assert_eq!(
            fs::read(dest.path().join("a (copy).txt")).unwrap(),
            b"first copy",
            "the first duplicate keeps its contents too — the copy steps past it"
        );
        assert_eq!(fs::read(dest.path().join("a (copy 2).txt")).unwrap(), b"new");
        assert!(dest.path().join("pack (copy)").is_dir());
        assert_eq!(landed.len(), 2, "{landed:?}");
        assert!(landed[0].ends_with("a (copy 2).txt"), "{landed:?}");
        assert!(landed[1].ends_with("pack (copy)"), "{landed:?}");
    }

    #[test]
    fn dropping_onto_the_owning_folder_is_a_noop_and_into_itself_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("here.txt"), b"").unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let here = dir.path().join("here.txt").to_string_lossy().into_owned();

        // A file dropped on its own containing folder makes no duplicate.
        assert_eq!(
            copy_into_paths(std::slice::from_ref(&here), &root).unwrap(),
            Vec::<String>::new()
        );
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["here.txt"], "{names:?}");

        // A folder dropped into its own subtree would recurse forever - refused whole.
        fs::create_dir_all(dir.path().join("pack").join("sub")).unwrap();
        let pack = dir.path().join("pack").to_string_lossy().into_owned();
        let sub = dir.path().join("pack").join("sub").to_string_lossy().into_owned();
        let err = copy_into_paths(&[pack], &sub).unwrap_err();
        assert!(err.contains("cannot be copied into itself"), "{err}");

        // A missing destination or source is an error, not a silent nothing.
        let err = copy_into_paths(&[here], &dir.path().join("nowhere").to_string_lossy()).unwrap_err();
        assert!(err.contains("is not a folder"), "{err}");
        let err = copy_into_paths(
            &[dir.path().join("ghost.txt").to_string_lossy().into_owned()],
            &root,
        )
        .unwrap_err();
        assert!(err.contains("ghost.txt"), "{err}");
    }
}

#[cfg(test)]
mod transfer_tests {
    use super::*;

    #[test]
    fn an_import_copies_files_and_trees_without_clobbering() {
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        fs::write(src.path().join("a.bin"), vec![7u8; 3 * 1024 * 1024]).unwrap();
        fs::create_dir_all(src.path().join("tree").join("inner")).unwrap();
        fs::write(src.path().join("tree").join("inner").join("b.txt"), b"deep").unwrap();
        fs::write(dest.path().join("a.bin"), b"kept").unwrap();

        let sources = [
            src.path().join("a.bin").to_string_lossy().into_owned(),
            src.path().join("tree").to_string_lossy().into_owned(),
        ];
        let report = import_sources(&sources, &dest.path().to_string_lossy(), &|_| {}, &|| false);
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert!(!report.cancelled);
        // The existing file kept its contents; the import landed beside it.
        assert_eq!(fs::read(dest.path().join("a.bin")).unwrap(), b"kept");
        assert_eq!(
            fs::read(dest.path().join("a (copy).bin")).unwrap(),
            vec![7u8; 3 * 1024 * 1024]
        );
        assert_eq!(
            fs::read(dest.path().join("tree").join("inner").join("b.txt")).unwrap(),
            b"deep"
        );
        // No partial sibling survives a completed copy.
        assert!(!dest.path().join("a (copy).bin.ggs-transfer").exists());
        assert_eq!(report.landed.len(), 2, "{:?}", report.landed);
    }

    #[test]
    fn an_import_collects_failures_and_reports_progress() {
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        fs::write(src.path().join("good.txt"), b"ok").unwrap();
        let sources = [
            src.path().join("good.txt").to_string_lossy().into_owned(),
            src.path().join("ghost.txt").to_string_lossy().into_owned(),
        ];
        let events: std::sync::Mutex<Vec<TransferProgress>> = std::sync::Mutex::new(Vec::new());
        let report = import_sources(
            &sources,
            &dest.path().to_string_lossy(),
            &|p| events.lock().unwrap().push(p),
            &|| false,
        );
        assert_eq!(fs::read(dest.path().join("good.txt")).unwrap(), b"ok");
        assert_eq!(report.landed.len(), 1, "{:?}", report.landed);
        assert_eq!(report.failed.len(), 1, "{:?}", report.failed);
        assert!(report.failed[0].name.contains("ghost.txt"));
        // The progress denominator covers the whole job and the counter reached it.
        let events = events.into_inner().unwrap();
        assert_eq!(events.last().unwrap().total, 2);
        assert_eq!(events.last().unwrap().bytes, 2);
        assert!(events.iter().all(|p| p.bytes <= p.total));
    }

    #[test]
    fn a_cancelled_import_stops_whole_and_leaves_no_partial() {
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        fs::write(src.path().join("big.bin"), vec![1u8; 5 * 1024 * 1024]).unwrap();
        fs::write(src.path().join("after.txt"), b"never reached").unwrap();
        // Cancel from the first chunk report on: the copy dies between chunks, the partial
        // sibling goes, and the rest of the job never starts.
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let sources = [
            src.path().join("big.bin").to_string_lossy().into_owned(),
            src.path().join("after.txt").to_string_lossy().into_owned(),
        ];
        let report = import_sources(
            &sources,
            &dest.path().to_string_lossy(),
            &|p| {
                if p.bytes >= 1024 * 1024 {
                    cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                }
            },
            &|| cancel.load(std::sync::atomic::Ordering::SeqCst),
        );
        assert!(report.cancelled, "{report:?}");
        assert!(report.landed.is_empty(), "{:?}", report.landed);
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert!(!dest.path().join("big.bin").exists(), "no partial survived");
        assert!(!dest.path().join("big.bin.ggs-transfer").exists());
        assert!(!dest.path().join("after.txt").exists(), "the job stopped whole");
    }

    #[test]
    fn an_export_copies_a_file_and_reports_it() {
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        fs::write(src.path().join("doc.md"), b"# body").unwrap();
        let target = dest.path().join("doc.md");
        let report = export_path(
            &src.path().join("doc.md"),
            &target,
            false,
            &|_| {},
            &|| false,
        );
        assert_eq!(fs::read(&target).unwrap(), b"# body");
        assert_eq!(report.landed, [target.to_string_lossy().into_owned()]);
        assert!(report.failed.is_empty());
    }

    #[test]
    fn an_export_zips_a_folder_without_git() {
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        fs::create_dir_all(src.path().join("sub")).unwrap();
        fs::write(src.path().join("sub").join("b.txt"), b"deep").unwrap();
        fs::write(src.path().join("top.txt"), b"top").unwrap();
        fs::create_dir_all(src.path().join(".git")).unwrap();
        fs::write(src.path().join(".git").join("HEAD"), b"ref").unwrap();
        let target = dest.path().join("pack.zip");
        let report = export_path(src.path(), &target, false, &|_| {}, &|| false);
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        let archive = zip::ZipArchive::new(fs::File::open(&target).unwrap()).unwrap();
        let names: Vec<String> = archive.file_names().map(str::to_owned).collect();
        assert!(names.contains(&"top.txt".to_owned()), "{names:?}");
        assert!(names.contains(&"sub/b.txt".to_owned()), "{names:?}");
        assert!(!names.iter().any(|n| n.starts_with(".git/")), "{names:?}");
    }

    #[test]
    fn a_cancelled_export_removes_the_partial_archive() {
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        fs::write(src.path().join("one.bin"), vec![1u8; 1024 * 1024]).unwrap();
        fs::write(src.path().join("two.bin"), vec![2u8; 1024 * 1024]).unwrap();
        let target = dest.path().join("pack.zip");
        let report = export_path(src.path(), &target, true, &|_| {}, &|| true);
        assert!(report.cancelled, "{report:?}");
        assert!(!target.exists(), "no partial archive survived");
        assert!(report.landed.is_empty());
    }
}

#[cfg(test)]
mod backup_tests {
    use super::*;

    #[test]
    fn backups_round_trip_list_and_clear() {
        let dir = tempfile::tempdir().unwrap();
        ggs_text::backup::write_into(dir.path(), "C:\\repo\\a.txt", "draft one".into()).unwrap();
        ggs_text::backup::write_into(dir.path(), "C:\\repo\\b.txt", "draft two".into()).unwrap();
        ggs_text::backup::write_into(dir.path(), "C:\\repo\\a.txt", "draft one, newer".into()).unwrap();
        let listed = ggs_text::backup::list_in(dir.path());
        assert_eq!(
            listed.iter().map(|b| b.path.as_str()).collect::<Vec<_>>(),
            ["C:\\repo\\a.txt", "C:\\repo\\b.txt"]
        );
        assert!(listed[0].saved_at > 0);
        assert_eq!(
            ggs_text::backup::read_in(dir.path(), "C:\\repo\\a.txt").unwrap(),
            "draft one, newer"
        );
        ggs_text::backup::clear_in(dir.path(), "C:\\repo\\a.txt");
        assert!(ggs_text::backup::read_in(dir.path(), "C:\\repo\\a.txt").is_err());
        assert_eq!(ggs_text::backup::list_in(dir.path()).len(), 1);
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

    #[test]
    fn the_repo_item_names_the_repositorys_folder() {
        // A backslash path is only a Windows path; on Unix it is one long component.
        #[cfg(windows)]
        assert_eq!(
            repo_folder_name("C:\\dev\\git-graph-studio"),
            "git-graph-studio"
        );
        assert_eq!(
            repo_folder_name("/home/neophack/vscode-git-graph-rs"),
            "vscode-git-graph-rs"
        );
        // A path with no final component names no repo; the frontend hides the item.
        assert_eq!(repo_folder_name("/"), "");
        assert_eq!(repo_folder_name(""), "");
    }
}

#[cfg(test)]
mod remote_gate_tests {
    use super::*;

    /// `remote_ext_roots` names exactly the extension platform's own areas under the one
    /// home — the packages' files, their storage and their logs. Nothing else under `~/.ggs`
    /// (settings, keys, Claude state) may appear: a remote session's `ext_fs` crossing is
    /// confined to these three.
    #[test]
    fn ext_roots_are_the_extension_platforms_own_areas() {
        let _isolated = crate::test_isolated_store::isolated_extension_store();
        let roots: Vec<String> = remote_ext_roots()
            .iter()
            .map(|root| root.replace('\\', "/"))
            .collect();
        assert_eq!(
            roots.len(),
            3,
            "exactly three areas: packages, storage, extension logs"
        );
        for root in &roots {
            let suffix = root.trim_end_matches('/');
            assert!(
                suffix.ends_with("/extensions")
                    || suffix.ends_with("/extension-data")
                    || suffix.ends_with("/logs/extensions"),
                "{root} is not one of the extension platform's areas"
            );
        }
        // All three share the one home — the store's parent.
        let homes: std::collections::HashSet<String> = roots
            .iter()
            .map(|root| {
                root.trim_end_matches('/')
                    .trim_end_matches("/extensions")
                    .trim_end_matches("/extension-data")
                    .trim_end_matches("/logs")
                    .to_owned()
            })
            .collect();
        assert_eq!(
            homes.len(),
            1,
            "the areas all sit under one home: {roots:?}"
        );
    }
}
