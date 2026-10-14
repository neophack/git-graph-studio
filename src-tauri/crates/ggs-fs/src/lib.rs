//! ggs-fs (L1, module 3's backend): the workspace file services — directory listing,
//! chunked reads and patches, the no-clobber copy engine ("name (copy).ext"), the
//! streaming import/export transfer engine with cancellation, the confined chunked
//! uploads, `zip_tree` (the export and the remote download pack through it) and the
//! `.gitignore`-aware parallel tree walk every consumer (Quick Open, search, the symbol
//! index, the analysis engine) shares — the exclusion policy stays ONE list here.
//!
//! Allowed dependencies: ggs-base, ggs-text (encoding), ignore, rayon, trash, zip,
//! base64. No tauri — transfer progress crosses through callbacks; cancellation through
//! ggs_base::cancel::Generation (the TransferState type).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

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

pub fn read_dir_sorted(path: &str) -> Result<Vec<DirEntryInfo>, String> {
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
pub fn decode(bytes: Vec<u8>, forced: Option<&str>) -> FileContents {
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

/// The metadata half of `read_file_raw`'s payload, riding ahead of the text itself.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RawFileMeta {
    binary: bool,
    size: u64,
    encoding: String,
    eol: String,
}

/// Build `read_file_raw`'s payload: header length, metadata, text.
pub fn raw_payload(bytes: &[u8], forced: Option<&str>) -> Vec<u8> {
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

/// One window of a file's bytes, as base64 - the hex viewer pages through a large
/// file rather than reading it whole.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChunk {
    pub size: u64,
    pub base64: String,
}

pub fn read_chunk(path: &str, offset: u64, len: u32) -> Result<FileChunk, String> {
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

pub fn patch_bytes(path: &str, edits: &[BytePatch]) -> Result<(), String> {
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

/// Where an upload accumulates until its last chunk arrives (a sibling of the target, so the
/// final rename never crosses a file system).
pub fn upload_partial(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    target.with_file_name(format!("{name}.ggs-upload"))
}

/// The canonical form of a path that may not exist yet: the nearest existing ancestor
/// canonicalized, the missing tail re-appended. `..` segments collapse to the real path.
pub fn canonicalize_lenient(path: &Path) -> Option<PathBuf> {
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
pub fn upload_allowed(path: &Path, roots: &[PathBuf]) -> bool {
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

/// Where an interrupted upload of `path` resumes: the partial file's length when it is not
/// larger than the file being uploaded, else 0 (a different file — start over).
pub fn upload_offset(path: &Path, size: u64) -> u64 {
    let partial = upload_partial(path);
    match fs::metadata(&partial) {
        Ok(meta) if meta.len() <= size => meta.len(),
        _ => 0,
    }
}

pub fn checked(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if path.as_os_str().is_empty() {
        return Err("No path was given".to_owned());
    }
    Ok(path)
}

/// Rename `from` to `to`, refusing to clobber an existing entry - except the entry itself: on
/// a case-insensitive file system (Windows, macOS) `README.md` -> `readme.md` finds `to`
/// "existing", and that is the rename the user asked for, not a collision.
pub fn rename(from: &str, to: &str) -> Result<(), String> {
    let target = checked(to)?;
    if target.exists() && !same_entry(Path::new(from), &target) {
        return Err(format!("{to} already exists"));
    }
    fs::rename(from, &target).map_err(|e| format!("{from}: {e}"))
}

/// Whether two paths name the same directory entry - differing only in case, on a file
/// system that ignores case. The canonical forms of both paths agree then, and nothing but
/// the spelling does; two distinct entries canonicalise to distinct paths.
pub fn same_entry(a: &Path, b: &Path) -> bool {
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

pub fn copy_into_paths(sources: &[String], dest_dir: &str) -> Result<Vec<String>, String> {
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
pub fn unique_target(dest: &Path, name: &str) -> PathBuf {
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

pub fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
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
    pub fn next(&self) -> u64 {
        self.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.generation.load(std::sync::atomic::Ordering::SeqCst) == generation
    }

    pub fn cancel(&self) {
        self.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
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

/// The byte total of a transfer plan: one walk up front so every progress report carries
/// an honest denominator. Unreadable entries are counted as zero and fail in the copy
/// pass, which reports them by name.
pub fn tree_size(root: &Path) -> u64 {
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
pub fn import_sources(
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
pub struct TransferJob<'a> {
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
pub fn import_one(
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
pub fn import_dir(
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
pub fn copy_file_streaming(
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

/// The export engine (`fs_export`'s core, pure so the tests drive it without Tauri).
pub fn export_path(
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
pub fn zip_tree<W: std::io::Write + std::io::Seek>(
    root: &Path,
    sink: W,
) -> zip::result::ZipResult<W> {
    zip_tree_reporting(root, sink, &mut |_| {}, &|| false)
}

/// `zip_tree` with the reporting hooks the desktop export drives: every chunk read out of
/// a file crosses `on_bytes`, and `cancelled` aborts the archive between chunks.
pub fn zip_tree_reporting<W: std::io::Write + std::io::Seek>(
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
pub fn cached_file_list(
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