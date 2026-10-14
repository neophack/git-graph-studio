//! Filesystem commands for the Explorer and the editor: the folder tree, file contents (of the
//! working tree, of the index, or of any revision, for the diff editors), and the Explorer's
//! own new/rename/delete operations.

use ggs_fs::*;
use ggs_fs::{cached_file_list, walk_files};
use ggs_git::revision::{parse_status_branch, repo_folder_name, revision_file_bytes, revision_file_text, write_temp_blob, HeadInfo};

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use ggs_git::runner::Git;
use crate::AppState;
use tauri::ipc::Channel;
use tauri::State;

/// One directory level of the Explorer tree, folders first, then files, both alphabetically
/// (case-insensitive, matching how the VS Code explorer orders entries).
#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    read_dir_sorted(&path)
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

/// Read a file as text, detecting its encoding - or decoding it as `encoding` when the user
/// asked to reopen it with a specific one.
#[tauri::command]
pub async fn read_file(path: String, encoding: Option<String>) -> Result<FileContents, String> {
    let bytes = fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    Ok(decode(bytes, encoding.as_deref()))
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

/// Read `len` bytes of a file starting at `offset` (clamped to the file's end).
#[tauri::command]
pub async fn read_file_chunk(path: String, offset: u64, len: u32) -> Result<FileChunk, String> {
    read_chunk(&path, offset, len)
}

/// Write the bytes a hex-editor session changed back in place; everything else of the
/// file is left untouched on disk, exactly as it was read.
#[tauri::command]
pub fn patch_file(path: String, edits: Vec<BytePatch>) -> Result<(), String> {
    patch_bytes(&path, &edits)
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

/* ---------- Explorer operations ---------- */

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

// ---- File transfers: the desktop half of the workbench's transfer layer ----
//
// One vocabulary in every environment (`src/transfer.ts`): a browser session rides the
// remote wire (the chunked `fs_write_chunk` uploads and the daemon's one-time download
// tickets), and the desktop app drives native pickers plus these commands. The boundary
// stays as it was: a remote session never reaches `fs_import` / `fs_export` at all (the
// Relay refuses them — src/remote/pathGate.ts), because their paths name anywhere on the
// machine, which is the desktop user's own picker's business, never a browser's.

/// Stop the running transfer (the progress toast's Cancel action): the copy loop honours
/// the generation change at the next chunk boundary and settles cancelled.
#[tauri::command]
pub fn fs_transfer_cancel(state: State<'_, AppState>) {
    state.transfer.cancel();
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
