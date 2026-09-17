//! The ultra-fast code viewer backend: documents live in a rope with syntect (pure Rust,
//! fancy-regex engine) highlighting checkpointed per block, so opening is O(size of the file
//! read) and every scroll window highlights only what is visible.
//!
//! A huge file opens in two stages: the head — a few megabytes, read, decoded and roped
//! synchronously — is on screen in tens of milliseconds, while the rest builds on a
//! background thread in parallel chunks (read + validate + rope across the cores) and
//! appends when it lands. Until then the scrollbar runs on an estimated line count that
//! the landing corrects over the `studio://viewer-lines` event.

pub mod doc;
pub(crate) mod find;
pub mod indexed;
mod outline;

use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use doc::ViewerDoc;
pub use find::MatchLoc;
pub use outline::Symbol;

/// The largest window `viewer_lines` will highlight in one call — enough for a viewport plus
/// overscan, small enough that a bug in the frontend cannot ask for the whole file.
const MAX_WINDOW: usize = 500;

/// The head `viewer_open` builds synchronously — a couple of screens plus the scrollbar's
/// first estimate, tens of milliseconds whatever the file's size. Everything past it builds
/// in the background.
pub(crate) const HEAD_BYTES: usize = 4 << 20;

/// How far the head may extend past `HEAD_BYTES` hunting the newline that ends its last
/// whole line (a minified file's "line" can run for megabytes; the head stays bounded).
const HEAD_LINE_SLACK: usize = 1 << 20;

/// The bytes each background tail chunk reads, validates and ropes on its own core.
const TAIL_CHUNK: u64 = 16 << 20;

/// Catch-up this cheap runs inline in `viewer_lines` (a few milliseconds of parse). Beyond
/// it the window is served as plain text with `tokens_pending`, and the frontend pulls the
/// colors through `viewer_highlight` — a drag of a scrollbar never waits on syntect.
const QUICK_CATCHUP: usize = 1024;

/// Lines parsed per lock hold while catching up or warming: each slice costs a few
/// milliseconds on ordinary grammars (tens on the slowest), so a concurrent text window
/// never queues behind more than one slice, and the generation is re-checked between
/// slices. Must stay ≥ `doc::BLOCK` — the slice has to cross a checkpoint boundary or the
/// walk would not advance.
const WARM_SLICE: usize = 256;

/// One open document: the rope behind a lock, plus the find-scan generation. The
/// generation lives outside the lock so a new `viewer_find` can supersede a scan that is
/// still running (and still holding the lock) without waiting for it to finish.
struct DocHandle {
    doc: Mutex<ViewerDoc>,
    find_gen: AtomicU64,
    /// Bumped by every `viewer_lines` / `viewer_highlight` request: the catch-up walk of an
    /// older request checks it between slices and aborts, so a fast drag cancels the parse
    /// of windows nobody is looking at anymore.
    lines_gen: AtomicU64,
    /// Bumped by every mutation (edit, undo, redo, replace, reload, close): checkpoints may
    /// have been invalidated, so the background warmer stops and respawns on fresh demand.
    warm_gen: AtomicU64,
    /// Guards one warmer thread per document (`try_spawn_warmer`).
    warmer_running: AtomicBool,
    /// The tail build's completion gate, `Some` while the background thread owes a landing.
    /// Readers of lines beyond the rope wait on it; a reload replaces it with the new
    /// build's gate.
    tail: Mutex<Option<Arc<TailGate>>>,
}

/// What a reader of beyond-the-head lines blocks on until the tail lands: a one-shot gate
/// the build thread opens exactly once, however it ends (append, failure, supersede).
pub(crate) struct TailGate {
    pending: (Mutex<bool>, Condvar),
}

impl TailGate {
    pub(crate) fn pending() -> Arc<TailGate> {
        Arc::new(TailGate {
            pending: (Mutex::new(true), Condvar::new()),
        })
    }

    /// Open the gate from the build thread: whatever waited proceeds against the doc's
    /// now-truthful fields.
    pub(crate) fn land(&self) {
        let (lock, signal) = &self.pending;
        *lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = false;
        signal.notify_all();
    }

    pub(crate) fn wait(&self) {
        let (lock, signal) = &self.pending;
        let mut pending = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        while *pending {
            pending = signal
                .wait(pending)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

#[derive(Default)]
pub struct ViewerState {
    next_id: AtomicU64,
    /// Documents behind per-doc handles: a window read clones the `Arc` and locks the one
    /// document it needs, so `spawn_blocking` can highlight off the main thread (a cold
    /// window deep in a huge file parses back to its last checkpoint — hundreds of
    /// thousands of lines — and doing that on the main thread froze the whole window).
    docs: Mutex<HashMap<u64, Arc<DocHandle>>>,
}

impl ViewerState {
    /// The document's own handle, cloned out of the map for a blocking task to lock.
    fn doc_handle(&self, doc_id: u64) -> Option<Arc<DocHandle>> {
        self.docs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&doc_id)
            .cloned()
    }

    fn insert_doc(
        &self,
        doc_id: u64,
        doc: ViewerDoc,
        tail: Option<Arc<TailGate>>,
    ) -> Arc<DocHandle> {
        let handle = Arc::new(DocHandle {
            doc: Mutex::new(doc),
            find_gen: AtomicU64::new(0),
            lines_gen: AtomicU64::new(0),
            warm_gen: AtomicU64::new(0),
            warmer_running: AtomicBool::new(false),
            tail: Mutex::new(tail),
        });
        self.docs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(doc_id, Arc::clone(&handle));
        handle
    }

    fn with_doc<T>(&self, doc_id: u64, f: impl FnOnce(&mut ViewerDoc) -> T) -> Result<T, String> {
        let handle = self
            .doc_handle(doc_id)
            .ok_or_else(|| format!("No open document {doc_id}"))?;
        let mut doc = handle
            .doc
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(f(&mut doc))
    }

    /// Invalidate a document's checkpoints from the warmer's point of view: the next slice
    /// it would parse may resume from a state the mutation dropped, so it must stop and let
    /// fresh demand (a window fetch, a highlight) respawn it against the new frontier.
    fn stop_warming(&self, doc_id: u64) {
        if let Some(handle) = self
            .docs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&doc_id)
        {
            handle.warm_gen.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// The window range check every line/text read shares: a bug in the frontend must not be
/// able to ask for the whole file in one call.
fn check_window(start: usize, end: usize) -> Result<(), String> {
    if end.saturating_sub(start) + 1 > MAX_WINDOW {
        return Err(format!(
            "window too large: {start}..{end} (max {MAX_WINDOW} lines)"
        ));
    }
    Ok(())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub doc_id: u64,
    pub line_count: usize,
    pub language: String,
    pub syntax_name: String,
    /// The encoding the file was decoded with, and its line endings; a save writes them back.
    pub encoding: String,
    pub eol: String,
}

/// One highlighted line as the IPC carries it: its text plus `(start, end, scope)` token
/// spans; offsets are code points.
pub type LineSpans = (String, Vec<(usize, usize, String)>);

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LinesResult {
    pub start_line: usize,
    pub line_count: usize,
    pub lines: Vec<LineSpans>,
    /// True when the window was cold — syntect would have had to parse back a long way for
    /// its tokens — and the lines above are plain text. The colors are the frontend's to
    /// pull through `viewer_highlight` once the rows are on screen.
    pub tokens_pending: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResult {
    pub line_count: usize,
    /// The viewer re-highlights from this 0-based line onward (checkpoints before it stay
    /// valid, everything from the edit line down was invalidated).
    pub rehighlight_from: usize,
}

/// A plain-text window: the same range model as `LinesResult` without the highlight work —
/// the editable windowed editor wants text to edit, not tokens.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextResult {
    pub start_line: usize,
    pub line_count: usize,
    pub lines: Vec<String>,
}

/// What an undo or a redo changed: the 0-based line to re-window around.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    pub first_line: usize,
    pub line_count: usize,
}

/// What `viewer_reload` found: `changed` is false when the file on disk still matches the
/// document (the common case is a save's own watcher echo), so the editor keeps its window
/// and cursor exactly where they were.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReloadResult {
    pub changed: bool,
    pub line_count: usize,
}

/// A file's `size:mtime` stamp, the same shape `cmd_fs::file_fingerprint` reports.
fn fingerprint(path: &std::path::Path) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            format!("{}:{mtime}", meta.len())
        }
        Err(_) => String::new(),
    }
}

/// A symbol for the workspace index: the outline's symbol with its kind spelled as the
/// lowercase name the frontend's icon table keys on.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OutlineSymbol {
    pub kind: String,
    pub name: String,
    /// 0-based line of the declaration.
    pub line: usize,
}

/// Extract the outline of an in-memory document (the workspace symbol index never opens a
/// viewer document - it scans the text straight from disk, no rope, no syntax lookup).
pub fn outline_symbols_for(text: &str, language: &str) -> Vec<OutlineSymbol> {
    outline::outline_text(text, language)
        .into_iter()
        .map(|s| OutlineSymbol {
            kind: format!("{:?}", s.kind).to_lowercase(),
            name: s.name,
            line: s.line,
        })
        .collect()
}

/// The whole heavy half of opening a legacy-encoded or unusual file — read, decode, rope,
/// sequentially. Runs on the blocking pool (`viewer_open`) so it cannot stall the UI.
/// The outline is deliberately not part of it: a whole-file scan (and up to twenty thousand
/// symbols across the IPC) does not belong on the first-paint path. `viewer_symbols`
/// computes it on demand, off the document lock.
fn open_doc(path: &str) -> Result<ViewerDoc, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    // Git's own binary heuristic, the one `cmd_fs::read_file` and the probe apply.
    if crate::encoding::looks_binary(&bytes) {
        return Err(format!("{path}: binary file"));
    }
    let decoded = crate::encoding::decode(&bytes, None);
    let language = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    let mut doc = ViewerDoc::new(std::path::PathBuf::from(path), &decoded.text, &language);
    doc.encoding = decoded.encoding.to_owned();
    doc.eol = decoded.eol.to_owned();
    doc.fingerprint = fingerprint(std::path::Path::new(path));
    Ok(doc)
}

/// What `open_staged` can hand the frontend immediately.
enum Staged {
    /// The whole document: a file the head already covers, or one the fast path cannot
    /// chunk (a legacy multi-byte encoding — splitting those mid-character is not a
    /// one-byte check the way UTF-8's is).
    Full(ViewerDoc),
    /// The head *is* the document for now; `from_byte..total_bytes` of the same file
    /// appends on a background thread.
    Head {
        doc: ViewerDoc,
        from_byte: u64,
        total_bytes: u64,
    },
}

/// Open a file in two stages: read `HEAD_BYTES` (extended to the next newline so the head
/// ends on a whole line), decode and rope it, and — when the file runs past that — hand
/// back the head with the tail owed. UTF-8 files only stage; anything else takes the
/// sequential whole-file open, where gigabytes are rare and correctness is cheap.
fn open_staged(path: &str) -> Result<Staged, String> {
    let total = std::fs::metadata(path)
        .map_err(|e| format!("{path}: {e}"))?
        .len();
    let mut file = File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let mut head = vec![0u8; HEAD_BYTES.min(total as usize)];
    if !head.is_empty() {
        file.read_exact(&mut head)
            .map_err(|e| format!("{path}: {e}"))?;
    }
    if head.len() < total as usize {
        // Hunt the newline that ends the head's last whole line, capped: a minified
        // monster must not drag the "head" through megabytes.
        let mut slack = [0u8; 4096];
        loop {
            let read = file.read(&mut slack).map_err(|e| format!("{path}: {e}"))?;
            if read == 0 {
                break;
            }
            let stop = memchr::memchr(b'\n', &slack[..read]);
            let keep = match stop {
                Some(at) => at + 1,
                None => read,
            };
            head.extend_from_slice(&slack[..keep]);
            if stop.is_some() || head.len() >= HEAD_BYTES + HEAD_LINE_SLACK {
                break;
            }
        }
    }
    if crate::encoding::looks_binary(&head) {
        return Err(format!("{path}: binary file"));
    }
    let decoded = crate::encoding::decode(&head, None);
    let language = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    let mut doc = ViewerDoc::new(std::path::PathBuf::from(path), &decoded.text, &language);
    doc.encoding = decoded.encoding.to_owned();
    doc.eol = decoded.eol.to_owned();
    doc.fingerprint = fingerprint(std::path::Path::new(path));
    if head.len() as u64 >= total || decoded.encoding != "utf8" {
        // The head covered everything, or the fast path cannot chunk this encoding.
        if head.len() as u64 >= total {
            return Ok(Staged::Full(doc));
        }
        return open_doc(path).map(Staged::Full);
    }
    // The scroller's first line count: the head's line density over the file's size. A
    // log's lines are near-uniform, so this lands within a fraction of a percent; the
    // tail's landing replaces it with the exact count.
    let head_lines = doc.rope_lines().max(1);
    let per_line = (head.len() as u64 / head_lines as u64).max(1);
    let estimate = head_lines + ((total - head.len() as u64) / per_line) as usize;
    doc.line_estimate = Some(estimate.max(head_lines));
    Ok(Staged::Head {
        doc,
        from_byte: head.len() as u64,
        total_bytes: total,
    })
}

/// A positioned read: Windows' `seek_read` or Unix's `read_at`, whichever platform builds.
pub(crate) fn positioned_read(file: &File, buf: &mut [u8], at: u64) -> std::io::Result<usize> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        file.seek_read(buf, at)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_at(buf, at)
    }
}

pub(crate) fn read_exact_at(file: &File, buf: &mut [u8], at: u64) -> std::io::Result<()> {
    let mut done = 0usize;
    while done < buf.len() {
        let read = positioned_read(file, &mut buf[done..], at + done as u64)?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "short positioned read",
            ));
        }
        done += read;
    }
    Ok(())
}

/// The largest byte offset ≤ `at` at which no UTF-8 character straddles: steps back over
/// up to three continuation bytes, so a chunk split there validates on both sides.
fn utf8_boundary(file: &File, at: u64) -> u64 {
    let begin = at.saturating_sub(3);
    let mut probe = [0u8; 3];
    let read = positioned_read(file, &mut probe, begin).unwrap_or(0);
    let mut back = 0u64;
    for i in (0..read).rev() {
        let index = begin + i as u64;
        if index >= at {
            continue;
        }
        if probe[i] & 0b1100_0000 == 0b1000_0000 {
            back = at - index;
        } else {
            break;
        }
    }
    at - back
}

/// Build `from_byte..total_bytes` of the file as one rope: parallel positioned reads in
/// chunks split at UTF-8 character boundaries, each chunk validated and roped on its own
/// core (rayon), then concatenated in order. A gigabyte lands in a few hundred
/// milliseconds warm instead of the sequential read+decode+rope's several seconds.
fn build_tail(path: &str, from: u64, total: u64) -> Result<ropey::Rope, String> {
    use rayon::prelude::*;
    let file = File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let file = &file;
    let mut bounds: Vec<u64> = Vec::new();
    let mut at = from;
    while at < total {
        bounds.push(at);
        at += TAIL_CHUNK;
    }
    bounds.push(total);
    let bounds: Vec<u64> = bounds
        .iter()
        .enumerate()
        .map(|(i, &bound)| {
            if i == 0 {
                bound
            } else {
                utf8_boundary(file, bound).min(total)
            }
        })
        .collect();
    let parts: Vec<Result<ropey::Rope, String>> = bounds
        .par_windows(2)
        .map(|pair| {
            let (start, end) = (pair[0], pair[1]);
            let mut buf = vec![0u8; (end - start) as usize];
            read_exact_at(file, &mut buf, start).map_err(|e| format!("{path}: {e}"))?;
            let text = std::str::from_utf8(&buf).map_err(|e| format!("{path}: {e}"))?;
            Ok(ropey::Rope::from(text))
        })
        .collect();
    let mut whole = ropey::Rope::new();
    for part in parts {
        whole.append(part?);
    }
    Ok(whole)
}

/// The landing the webview is told about: the exact line count once the tail has appended.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LinesLanded {
    pub doc_id: u64,
    pub line_count: usize,
}

/// Ids for tail builds, so a landing can tell its document from a superseding one.
static TAIL_BUILDS: AtomicU64 = AtomicU64::new(1);

/// Append `from_byte..` of `path` to the document on a background thread. The gate keeps
/// readers of beyond-the-head lines waiting; the landing checks `tail_id`, so a document
/// replaced by a reload meanwhile never receives a stale tail. Edits made while the tail
/// built survive: the tail appends after whatever the head now holds.
fn spawn_tail(
    handle: &Arc<DocHandle>,
    app: Option<tauri::AppHandle>,
    doc_id: u64,
    path: String,
    from: u64,
    total: u64,
) {
    let id = TAIL_BUILDS.fetch_add(1, Ordering::Relaxed);
    {
        let mut doc = handle
            .doc
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        doc.tail_id = Some(id);
        doc.tail_error = None;
    }
    let gate = TailGate::pending();
    *handle
        .tail
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&gate));
    let landing = Arc::clone(handle);
    let landing_gate = Arc::clone(&gate);
    let spawned = std::thread::Builder::new()
        .name("viewer-tail".to_owned())
        .spawn(move || {
            let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                build_tail(&path, from, total)
            }));
            let mut landed = None;
            {
                let mut doc = landing
                    .doc
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if doc.tail_id == Some(id) {
                    match built {
                        Ok(Ok(tail)) => {
                            doc.rope.append(tail);
                            doc.line_estimate = None;
                            doc.tail_id = None;
                            landed = Some(doc.line_count());
                        }
                        Ok(Err(error)) => {
                            doc.tail_error = Some(error);
                            doc.line_estimate = None;
                            doc.tail_id = None;
                        }
                        Err(_) => {
                            doc.tail_error = Some("the tail build panicked".to_owned());
                            doc.line_estimate = None;
                            doc.tail_id = None;
                        }
                    }
                }
            }
            // The gate opens however the build ended — superseded builds included, or a
            // reader of a reloaded document would wait forever.
            landing_gate.land();
            if let Some(count) = landed {
                if let Some(app) = app {
                    use tauri::Emitter;
                    let _ = app.emit(
                        "studio://viewer-lines",
                        LinesLanded {
                            doc_id,
                            line_count: count,
                        },
                    );
                }
            }
        });
    if spawned.is_err() {
        // The thread never ran: fail the document now so no waiter hangs on a gate that
        // will never open.
        let mut doc = handle
            .doc
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if doc.tail_id == Some(id) {
            doc.tail_error = Some("the tail build could not start".to_owned());
            doc.tail_id = None;
            doc.line_estimate = None;
        }
        gate.land();
    }
}

/// Block until the document's tail has landed — its gate, then the doc's own verdict.
fn wait_tail(handle: &DocHandle) -> Result<(), String> {
    let gate = handle
        .tail
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    if let Some(gate) = gate {
        gate.wait();
    }
    let doc = handle
        .doc
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match &doc.tail_error {
        Some(error) => Err(format!(
            "the rest of this file did not finish loading: {error}"
        )),
        None => Ok(()),
    }
}

/// Serve lines up to `start` without waiting when the rope already covers them (the head,
/// and everything once the tail has landed); wait for the tail only past it.
fn ensure_lines(handle: &DocHandle, start: usize) -> Result<(), String> {
    {
        let doc = handle
            .doc
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if doc.tail_id.is_none() {
            return match &doc.tail_error {
                Some(error) => Err(format!(
                    "the rest of this file did not finish loading: {error}"
                )),
                None => Ok(()),
            };
        }
        if start < doc.rope_lines() {
            return Ok(());
        }
    }
    wait_tail(handle)
}

/// The prewarm slot: filled once with the staged open (head or whole), signalled when it
/// is. A condvar pair rather than a join, because the thread keeps building the tail after
/// the slot fills — only the head is worth waiting for.
type PrewarmSlot = Arc<(Mutex<Option<Result<Staged, String>>>, Condvar)>;

/// A document built ahead of its `viewer_open`: `git-graph-studio <file>` starts the staged
/// open of its launch file at process start, in parallel with the window and the webview
/// coming up, so the page's open request finds the head already built instead of starting
/// it then. The slot fills as soon as the head (or the whole small file) is ready.
struct Prewarmed {
    path: String,
    slot: PrewarmSlot,
}

static PREWARMED: Mutex<Option<Prewarmed>> = Mutex::new(None);

/// Start opening `path` on a background thread. A binary file is not worth a document (the
/// hex viewer reads windows on demand), and a minified one (few enormous lines that defeat
/// the line windows both viewers serve) opens read-only through the indexed viewer — either
/// way no rope is worth building, so the head is sniffed first: the sniff is what the
/// frontend's probe asks anyway, and it costs one small read. Size is no reason to refuse:
/// the staged open builds the rope in parallel chunks and the document edits however big
/// the file is.
pub fn prewarm(path: String) {
    if !matches!(crate::cmd_fs::probe(&path), Ok(probe) if !probe.binary && !probe.long_lines) {
        return;
    }
    let slot: PrewarmSlot = Arc::new((Mutex::new(None), Condvar::new()));
    {
        let mut guard = PREWARMED
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // A second prewarm replaces the first: the launch path is what the window opens.
        *guard = Some(Prewarmed {
            path: path.clone(),
            slot: Arc::clone(&slot),
        });
    }
    let load = path;
    let fill = Arc::clone(&slot);
    let _ = std::thread::Builder::new()
        .name("viewer-prewarm".to_owned())
        .spawn(move || {
            let staged = open_staged(&load);
            let (lock, signal) = &*fill;
            *lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(staged);
            signal.notify_all();
        });
}

/// The prewarmed open for `path`, waiting only for its head; `None` when nothing was
/// prewarmed for this path (the slot serves one open, then clears).
fn take_prewarmed(path: &str) -> Option<Result<Staged, String>> {
    let slot = {
        let mut guard = PREWARMED
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_ref() {
            Some(prewarmed) if prewarmed.path == path => {
                let slot = Arc::clone(&prewarmed.slot);
                // The slot serves one open: clear it before waiting, so a second taker
                // never parks on a condvar nobody will signal again.
                *guard = None;
                slot
            }
            _ => return None,
        }
    };
    guard_take(&slot)
}

fn guard_take(slot: &PrewarmSlot) -> Option<Result<Staged, String>> {
    let (lock, signal) = &**slot;
    let mut guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    loop {
        if let Some(staged) = guard.take() {
            return Some(staged);
        }
        guard = signal
            .wait(guard)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }
}

fn open_result(doc_id: u64, doc: &ViewerDoc) -> OpenResult {
    OpenResult {
        doc_id,
        line_count: doc.line_count(),
        syntax_name: doc.syntax_name.clone(),
        language: doc.language.clone(),
        encoding: doc.encoding.clone(),
        eol: doc.eol.clone(),
    }
}

#[cfg(test)]
fn open_impl(state: &ViewerState, path: &str) -> Result<OpenResult, String> {
    let staged = open_staged(path)?;
    let (doc, tail) = match staged {
        Staged::Full(doc) => (doc, None),
        Staged::Head {
            doc,
            from_byte,
            total_bytes,
        } => (doc, Some((from_byte, total_bytes))),
    };
    let result = open_result(state.next_id.fetch_add(1, Ordering::Relaxed), &doc);
    let handle = state.insert_doc(result.doc_id, doc, None);
    if let Some((from, total)) = tail {
        spawn_tail(&handle, None, result.doc_id, path.to_owned(), from, total);
    }
    Ok(result)
}

/// One line of plain text, its newline stripped — the pending half of `lines_fast`.
fn plain_line(doc: &ViewerDoc, line: usize) -> String {
    doc.rope
        .line(line)
        .to_string()
        .trim_end_matches(['\n', '\r'])
        .to_owned()
}

/// The window over an already-locked document. A warm window (its nearest checkpoint close
/// enough) is highlighted inline; a cold one is served as plain text with `tokens_pending`
/// so the rows reach the screen at rope-read speed, whatever syntect still owes them.
/// The rope's own bounds do the clamping — while a tail is building, the line count the
/// frontend sees is the estimate, which may name lines the rope does not hold yet.
fn lines_fast(doc: &mut ViewerDoc, start: usize, end: usize) -> LinesResult {
    let total = doc.rope_lines();
    let reported = doc.line_count();
    if total == 0 {
        return LinesResult {
            start_line: 0,
            line_count: 0,
            lines: vec![(String::new(), Vec::new())],
            tokens_pending: false,
        };
    }
    let start = start.min(total - 1);
    let end = end.min(total - 1);
    if start - doc.resume_line(start) <= QUICK_CATCHUP {
        let lines = doc.highlight_lines(start, end);
        return LinesResult {
            start_line: start,
            line_count: reported,
            lines,
            tokens_pending: false,
        };
    }
    let lines = (start..=end)
        .map(|line| (plain_line(doc, line), Vec::new()))
        .collect();
    LinesResult {
        start_line: start,
        line_count: reported,
        lines,
        tokens_pending: true,
    }
}

/// Parse forward from the nearest checkpoint below `start` until resuming at `start` is
/// cheap, a slice of [`WARM_SLICE`] lines per lock hold. `alive` is checked between slices,
/// so the walk interleaves with window reads and aborts the moment a newer request
/// supersedes it. `pace` (the warmer) sleeps for half of each slice's duration — a slow
/// grammar's slices hold the lock long enough to matter, and warming must never crowd the
/// fetches the user is waiting on.
fn catch_up(
    handle: &DocHandle,
    start: usize,
    end: usize,
    alive: &dyn Fn() -> bool,
    pace: bool,
) -> Result<(), String> {
    loop {
        let slice_at = std::time::Instant::now();
        {
            let mut doc = handle
                .doc
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !alive() {
                return Err("superseded".to_string());
            }
            let total = doc.rope_lines();
            if total == 0 {
                return Ok(());
            }
            let start = start.min(total - 1);
            let end = end.min(total - 1);
            let resume = doc.resume_line(start);
            if start - resume <= QUICK_CATCHUP {
                return Ok(());
            }
            doc.highlight_lines(resume, (resume + WARM_SLICE).min(end));
        }
        if pace {
            let back = (slice_at.elapsed() / 2).max(std::time::Duration::from_millis(1));
            std::thread::sleep(back.min(std::time::Duration::from_millis(50)));
        }
    }
}

/// The full window after its catch-up: tokens for `start..=end`, checkpointing every block
/// crossed on the way (the walk leaves them behind, so the region stays warm).
fn highlight_doc(
    handle: &DocHandle,
    start: usize,
    end: usize,
    generation: u64,
) -> Result<LinesResult, String> {
    let alive = || handle.lines_gen.load(Ordering::Relaxed) == generation;
    catch_up(handle, start, end, &alive, false)?;
    let mut doc = handle
        .doc
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let total = doc.rope_lines();
    let reported = doc.line_count();
    let start = start.min(total.saturating_sub(1));
    let lines = doc.highlight_lines(start, end);
    Ok(LinesResult {
        start_line: start,
        line_count: reported,
        lines,
        tokens_pending: false,
    })
}

/// The warmer's whole run: walk the document's cold span slice by slice, then leave the
/// warmer slot free for a later spawn. Runs on its own thread ([`try_spawn_warmer`]).
fn warm_all(handle: &DocHandle) -> Result<(), String> {
    let total = {
        let doc = handle
            .doc
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        doc.rope_lines()
    };
    let generation = handle.warm_gen.load(Ordering::Relaxed);
    warm_with(handle, total, generation)
}

/// One warm run against a fixed warm generation: the walk stops the moment any mutation
/// (edit, undo, replace, reload, close) bumps it, because the checkpoints it would parse
/// against may have been dropped out from under it.
fn warm_with(handle: &DocHandle, through: usize, generation: u64) -> Result<(), String> {
    let alive = || handle.warm_gen.load(Ordering::Relaxed) == generation;
    catch_up(handle, through, through, &alive, true)
}

/// Start the background warmer for a document, at most one thread at a time. It builds
/// checkpoints ahead of the viewer so a scrollbar jump into unvisited territory lands on a
/// warm resume instead of a long catch-up. Only token consumers trigger it (`viewer_lines`,
/// `viewer_highlight`): the editable windowed editor never highlights, so it never warms.
fn try_spawn_warmer(handle: &Arc<DocHandle>) {
    if handle.warmer_running.swap(true, Ordering::Relaxed) {
        return;
    }
    let warmed = Arc::clone(handle);
    let spawned = std::thread::Builder::new()
        .name("viewer-warmer".to_owned())
        .spawn(move || {
            // Whatever happens inside, the slot must come free: a panicking warmer must not
            // block every later spawn for this document.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = warm_all(&warmed);
            }));
            warmed.warmer_running.store(false, Ordering::Relaxed);
            if let Err(panic) = result {
                std::panic::resume_unwind(panic);
            }
        });
    if spawned.is_err() {
        handle.warmer_running.store(false, Ordering::Relaxed);
    }
}

/// The test-side entry: the command itself locks through `spawn_blocking`.
#[cfg(test)]
fn lines_impl(
    state: &ViewerState,
    doc_id: u64,
    start: usize,
    end: usize,
) -> Result<LinesResult, String> {
    check_window(start, end)?;
    let handle = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    ensure_lines(&handle, start)?;
    state.with_doc(doc_id, |doc| lines_fast(doc, start, end))
}

/// The test-side entry: the command itself runs on the blocking pool.
#[cfg(test)]
fn highlight_impl(
    state: &ViewerState,
    doc_id: u64,
    start: usize,
    end: usize,
) -> Result<LinesResult, String> {
    let handle = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    let generation = handle.lines_gen.fetch_add(1, Ordering::Relaxed) + 1;
    highlight_with(state, doc_id, start, end, generation)
}

/// The same walk pinned to a caller-chosen generation, so a test can run one it has
/// already superseded.
#[cfg(test)]
fn highlight_with(
    state: &ViewerState,
    doc_id: u64,
    start: usize,
    end: usize,
    generation: u64,
) -> Result<LinesResult, String> {
    let handle = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    check_window(start, end)?;
    highlight_doc(&handle, start, end, generation)
}

/// The test-side entry: the command itself snapshots and scans on the blocking pool.
#[cfg(test)]
fn symbols_impl(state: &ViewerState, doc_id: u64) -> Result<Vec<Symbol>, String> {
    let handle = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    let (rope, language) = {
        let doc = handle
            .doc
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (doc.rope.clone(), doc.language.clone())
    };
    Ok(outline::outline_rope(&rope, &language))
}

fn edit_impl(
    state: &ViewerState,
    doc_id: u64,
    start_line: usize,
    start_col: usize,
    end_line: usize,
    end_col: usize,
    text: &str,
) -> Result<EditResult, String> {
    state.with_doc(doc_id, |doc| {
        let start = doc.offset_of(start_line, start_col);
        let end = doc.offset_of(end_line, end_col);
        let rehighlight_from = doc.edit(start, end, text);
        EditResult {
            line_count: doc.line_count(),
            rehighlight_from,
        }
    })
}

/// The test-side entry: the command itself locks through `spawn_blocking`.
#[cfg(test)]
fn text_impl(
    state: &ViewerState,
    doc_id: u64,
    start: usize,
    end: usize,
) -> Result<TextResult, String> {
    check_window(start, end)?;
    let handle = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    ensure_lines(&handle, start)?;
    state.with_doc(doc_id, |doc| text_of(doc, start, end))
}

/// The plain-text window over an already-locked document.
fn text_of(doc: &mut ViewerDoc, start: usize, end: usize) -> TextResult {
    // The rope's own bounds clamp (the reported count may still be the staged estimate).
    let total = doc.rope_lines();
    let reported = doc.line_count();
    let start = start.min(total.saturating_sub(1));
    let end = end.min(total.saturating_sub(1));
    let lines = (start..=end)
        .map(|line| {
            doc.rope
                .line(line)
                .to_string()
                .trim_end_matches(['\n', '\r'])
                .to_owned()
        })
        .collect();
    TextResult {
        start_line: start,
        line_count: reported,
        lines,
    }
}

/// Open a file in the viewer. The head — read, decoded and roped synchronously — is what
/// this returns, tens of milliseconds whatever the file's size; the rest of a huge file
/// appends on a background thread, and the `studio://viewer-lines` event delivers the exact
/// line count when it lands. Highlighting stays lazy (per window via `viewer_lines`), and
/// so does the outline (`viewer_symbols` on demand).
#[tauri::command]
pub async fn viewer_open(
    state: tauri::State<'_, ViewerState>,
    app: tauri::AppHandle,
    path: String,
) -> Result<OpenResult, String> {
    let doc_id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let load = path.clone();
    let staged = tauri::async_runtime::spawn_blocking(move || {
        take_prewarmed(&load).unwrap_or_else(|| open_staged(&load))
    })
    .await
    .map_err(|e| e.to_string())??;
    let (doc, tail) = match staged {
        Staged::Full(doc) => (doc, None),
        Staged::Head {
            doc,
            from_byte,
            total_bytes,
        } => (doc, Some((from_byte, total_bytes))),
    };
    let result = open_result(doc_id, &doc);
    let handle = state.insert_doc(doc_id, doc, None);
    if let Some((from, total)) = tail {
        spawn_tail(&handle, Some(app), doc_id, path, from, total);
    }
    Ok(result)
}

/// Highlight a window of lines (0-based, inclusive) for the virtual scroller. The work runs
/// on the blocking pool: a window that lands far beyond every checkpoint parses back to the
/// last one, and that catch-up must not run on (nor freeze) the main thread. A cold window
/// answers at rope-read speed with plain text (`tokens_pending`); the colors come from
/// `viewer_highlight`.
#[tauri::command]
pub async fn viewer_lines(
    state: tauri::State<'_, ViewerState>,
    doc_id: u64,
    start: usize,
    end: usize,
) -> Result<LinesResult, String> {
    check_window(start, end)?;
    let handle = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    // The bump cancels any catch-up still walking toward a window nobody is looking at.
    handle.lines_gen.fetch_add(1, Ordering::Relaxed);
    let result = tauri::async_runtime::spawn_blocking(move || {
        ensure_lines(&handle, start)?;
        let mut doc = handle
            .doc
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok::<LinesResult, String>(lines_fast(&mut doc, start, end))
    })
    .await
    .map_err(|e| e.to_string())??;
    // The first screen and every cold window are where warming pays: the background walk
    // starts there and keeps every later jump cheap. Warm mid-file scrolls spawn nothing.
    if result.tokens_pending || start == 0 {
        let handle = state.doc_handle(doc_id);
        if let Some(handle) = handle {
            try_spawn_warmer(&handle);
        }
    }
    Ok(result)
}

/// The tokens for a window `viewer_lines` served as plain text: parse forward from the last
/// checkpoint — sliced, generation-guarded, cancellable — then highlight the window and
/// return it colored. The frontend paints the rows as they were and swaps the colored text
/// in when this lands, so content and color arrive as two deliveries, never one wait.
#[tauri::command]
pub async fn viewer_highlight(
    state: tauri::State<'_, ViewerState>,
    doc_id: u64,
    start: usize,
    end: usize,
) -> Result<LinesResult, String> {
    check_window(start, end)?;
    let handle = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    let generation = handle.lines_gen.fetch_add(1, Ordering::Relaxed) + 1;
    let result = tauri::async_runtime::spawn_blocking(move || {
        highlight_doc(&handle, start, end, generation)
    })
    .await
    .map_err(|e| e.to_string())??;
    // The catch-up left the region warm up to this window; keep warming what is beyond it.
    let handle = state.doc_handle(doc_id);
    if let Some(handle) = handle {
        try_spawn_warmer(&handle);
    }
    Ok(result)
}

/// The result types of the find/replace commands over a whole document — the windowed
/// editor and the fast viewer hold only a slice of the rope, so their find widgets search
/// here instead of in the webview.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    pub matches: Vec<MatchLoc>,
    /// More matches existed than [`find::MAX_FIND_MATCHES`]; the count displays the cap.
    pub capped: bool,
    pub line_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub replacements: usize,
    pub first_line: usize,
    pub line_count: usize,
}

/// Apply one replacement to the document's rope. Positions are 0-based line + code-point
/// columns (the frontend converts its UTF-16 offsets before sending).
#[tauri::command]
pub fn viewer_edit(
    state: tauri::State<ViewerState>,
    doc_id: u64,
    start_line: usize,
    start_col: usize,
    end_line: usize,
    end_col: usize,
    text: String,
) -> Result<EditResult, String> {
    state.stop_warming(doc_id);
    edit_impl(
        &state, doc_id, start_line, start_col, end_line, end_col, &text,
    )
}

/// One chunk's CRLF normalisation: the same `"\r\n" → "\n" → "\r\n"` double replace
/// [`crate::encoding::encode`] applies whole-text, on a slice whose line breaks never
/// straddle its ends (a trailing `\r` is held back and re-joined with the next chunk by
/// the caller, so a pair split across a rope chunk boundary still comes out as one CRLF).
fn write_crlf_chunk(out: &mut impl std::io::Write, text: &str) -> std::io::Result<()> {
    if text.contains('\r') || text.contains('\n') {
        let normalised = text.replace("\r\n", "\n").replace('\n', "\r\n");
        out.write_all(normalised.as_bytes())
    } else {
        out.write_all(text.as_bytes())
    }
}

/// The CRLF pass over an iterator of chunks: each chunk's line breaks are normalised the
/// way [`crate::encoding::encode`] does whole-text, while a `\r` at a chunk's end is held
/// back and re-joined with the next chunk — a `\r\n` pair split across a rope chunk
/// boundary still comes out as one CRLF, and a lone CR survives as itself. `on_chunk`
/// hears every chunk's input size, the save progress's unit.
fn write_crlf<'a>(
    out: &mut impl std::io::Write,
    chunks: impl Iterator<Item = &'a str>,
    mut on_chunk: impl FnMut(u64),
) -> std::io::Result<()> {
    let mut pending_cr = false;
    for chunk in chunks {
        let mut text = chunk;
        // An empty chunk (possible at the ends of a sliced iteration) decides nothing:
        // the held-back `\r` keeps waiting for the text that follows it.
        if pending_cr && text.is_empty() {
            continue;
        }
        if pending_cr {
            if let Some(rest) = text.strip_prefix('\n') {
                out.write_all(b"\r\n")?;
                text = rest;
            } else {
                out.write_all(b"\r")?;
            }
            pending_cr = false;
        }
        if text.ends_with('\r') {
            pending_cr = true;
            text = &text[..text.len() - 1];
        }
        write_crlf_chunk(out, text)?;
        on_chunk(chunk.len() as u64);
    }
    if pending_cr {
        out.write_all(b"\r")?;
    }
    Ok(())
}

/// The throttled save reporter: the write stream reports every [`PROGRESS_STEP`] input
/// bytes and exactly once at each end, so the status bar follows a gigabyte at a hundred
/// updates instead of one per rope chunk.
struct SaveReporter<'a> {
    total: u64,
    written: u64,
    reported: u64,
    sink: &'a dyn Fn(u64, u64),
}

impl<'a> SaveReporter<'a> {
    fn new(total: u64, sink: &'a dyn Fn(u64, u64)) -> Self {
        sink(0, total);
        SaveReporter {
            total,
            written: 0,
            reported: 0,
            sink,
        }
    }

    fn step(&mut self, bytes: u64) {
        self.written += bytes;
        if self.written - self.reported >= PROGRESS_STEP {
            self.reported = self.written;
            (self.sink)(self.written, self.total);
        }
    }

    fn done(&mut self) {
        (self.sink)(self.total, self.total);
    }
}

/// How many written bytes separate two progress reports — small enough that a long save
/// visibly moves, large enough that a gigabyte costs ~a hundred IPC messages.
const PROGRESS_STEP: u64 = 8 << 20;

/// Write a rope out as `encoding`/`eol` without ever holding the whole text: chunks stream
/// through a buffer for the UTF-8 family — a gigabyte log's Ctrl+S must not first allocate
/// the gigabyte `String` plus gigabyte `Vec<u8>` that `full_text` + `encode` would. Other
/// encodings keep the whole-text path: they are rare at this size and `encode` is their one
/// implementation. `progress` receives `(written, total)` in input bytes — the read side of
/// the stream, so BOM and CRLF expansion never push the ratio past 1.
fn write_doc(
    path: &std::path::Path,
    rope: &ropey::Rope,
    encoding: &str,
    eol: &str,
    progress: &dyn Fn(u64, u64),
) -> Result<(), String> {
    use std::io::Write;
    let file = std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut out = std::io::BufWriter::with_capacity(1 << 20, file);
    let mut reporter = SaveReporter::new(rope.len_bytes() as u64, progress);
    let written = (|| -> std::io::Result<()> {
        match encoding {
            "utf8" | "utf8bom" => {
                if encoding == "utf8bom" {
                    out.write_all(&[0xEF, 0xBB, 0xBF])?;
                }
                if eol == "crlf" {
                    write_crlf(&mut out, rope.chunks(), |bytes| reporter.step(bytes))?;
                } else {
                    for chunk in rope.chunks() {
                        out.write_all(chunk.as_bytes())?;
                        reporter.step(chunk.len() as u64);
                    }
                }
            }
            _ => {
                let bytes = crate::encoding::encode(&rope.to_string(), encoding, eol);
                out.write_all(&bytes)?;
            }
        }
        Ok(())
    })();
    written.map_err(|e| format!("{}: {e}", path.display()))?;
    out.into_inner()
        .map_err(|e| format!("{}: {e}", path.display()))?
        .flush()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    reporter.done();
    Ok(())
}

/// One save-progress report over the command's channel: bytes of the document streamed out
/// so far, and the document's whole byte size. `written == 0 && total == 0` never happens
/// from here — the frontend's own start-of-save report is what the indeterminate bar serves.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SaveProgress {
    pub written: u64,
    pub total: u64,
}

/// Write a viewer document back to disk, reporting progress over `on_progress` as the rope
/// streams out — a multi-hundred-megabyte Ctrl+S takes seconds, and the status bar's bar is
/// how the user knows it is moving. The encode and write run on the blocking pool — the UI
/// must not freeze the way it did when the whole document crossed the IPC as one JSON string.
#[tauri::command]
pub async fn viewer_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, ViewerState>,
    doc_id: u64,
    on_progress: tauri::ipc::Channel<SaveProgress>,
) -> Result<(), String> {
    // Saving a document whose tail has not landed would write the head alone — the file
    // truncated to a fraction of itself. Wait the tail out first.
    let wait = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    tauri::async_runtime::spawn_blocking(move || wait_tail(&wait))
        .await
        .map_err(|e| e.to_string())??;
    // The rope clones cheap (ropey chunks share under an Arc — the `viewer_symbols` pattern),
    // so the blocking writer below never queues the document lock behind a whole-file pass.
    let (path, encoding, eol, rope) = state.with_doc(doc_id, |doc| {
        (
            doc.path.clone(),
            doc.encoding.clone(),
            doc.eol.clone(),
            doc.rope.clone(),
        )
    })?;
    let stamp = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let progress = move |written: u64, total: u64| {
            let _ = on_progress.send(SaveProgress { written, total });
        };
        write_doc(&path, &rope, &encoding, &eol, &progress)?;
        // The stamp the file now carries, so the save's own watcher echo reads as "unchanged".
        Ok(fingerprint(&path))
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = state.with_doc(doc_id, |doc| doc.fingerprint = stamp.clone());
    // Match write_file: a saved (possibly new) file must show up in Quick Open and search.
    use tauri::Manager;
    app.state::<crate::AppState>().file_list_cache.invalidate();
    Ok(())
}

/// Reload the document when its file changed on disk; a save's own watcher echo (the stamp
/// matches what was written) reports `changed: false` and leaves the document untouched —
/// cursor, undo stack and all.
#[tauri::command]
pub async fn viewer_reload(
    state: tauri::State<'_, ViewerState>,
    app: tauri::AppHandle,
    doc_id: u64,
) -> Result<ReloadResult, String> {
    let (path, stamp) =
        state.with_doc(doc_id, |doc| (doc.path.clone(), doc.fingerprint.clone()))?;
    if fingerprint(&path) == stamp {
        return Ok(ReloadResult {
            changed: false,
            line_count: 0,
        });
    }
    let load = path.display().to_string();
    let staged = tauri::async_runtime::spawn_blocking(move || open_staged(&load))
        .await
        .map_err(|e| e.to_string())??;
    let (doc, tail) = match staged {
        Staged::Full(doc) => (doc, None),
        Staged::Head {
            doc,
            from_byte,
            total_bytes,
        } => (doc, Some((from_byte, total_bytes))),
    };
    let line_count = doc.line_count();
    // The tab may have closed while the file was being read: a closed id must not come
    // back as a document nobody will ever close again.
    let mut docs = state
        .docs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match docs.get_mut(&doc_id) {
        Some(slot) => {
            // The reloaded document replaces the old one's checkpoints wholesale; the old
            // handle's warmer (it holds its own Arc) must not parse on against them.
            slot.warm_gen.fetch_add(1, Ordering::Relaxed);
            *slot = Arc::new(DocHandle {
                doc: Mutex::new(doc),
                find_gen: AtomicU64::new(0),
                lines_gen: AtomicU64::new(0),
                warm_gen: AtomicU64::new(0),
                warmer_running: AtomicBool::new(false),
                tail: Mutex::new(None),
            });
            if let Some((from, total)) = tail {
                spawn_tail(
                    slot,
                    Some(app),
                    doc_id,
                    path.display().to_string(),
                    from,
                    total,
                );
            }
        }
        None => return Err(format!("No open document {doc_id}")),
    }
    Ok(ReloadResult {
        changed: true,
        line_count,
    })
}

/// A window of lines as plain text (0-based, inclusive), for the editable windowed editor.
/// Off the main thread like `viewer_lines`: the same rope reads, the same latency spikes.
/// Lines the rope does not hold yet (a huge file's tail still building) wait for the
/// landing — the head's window never does.
#[tauri::command]
pub async fn viewer_text(
    state: tauri::State<'_, ViewerState>,
    doc_id: u64,
    start: usize,
    end: usize,
) -> Result<TextResult, String> {
    check_window(start, end)?;
    let doc = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        ensure_lines(&doc, start)?;
        let mut doc = doc
            .doc
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(text_of(&mut doc, start, end))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Find every (single-line) match of a query over a whole document. The scan runs on the
/// blocking pool — a 200 MB rope takes a moment — and aborts as soon as a newer find on
/// the same document supersedes it, so typing in the widget never queues stale scans.
#[tauri::command]
pub async fn viewer_find(
    state: tauri::State<'_, ViewerState>,
    doc_id: u64,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regexp: bool,
) -> Result<FindResult, String> {
    let handle = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    // The bump is what cancels an in-flight scan, and it must not need the lock that scan
    // still holds.
    let generation = handle.find_gen.fetch_add(1, Ordering::Relaxed) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        // A whole-document scan must see the whole document: wait out a still-building tail.
        wait_tail(&handle)?;
        let doc = handle
            .doc
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let options = find::FindOptions {
            case_sensitive,
            whole_word,
            regexp,
        };
        let matcher = find::Matcher::compile(&query, &options)?;
        let (matches, capped) = find::scan_rope(
            &doc.rope,
            &matcher,
            whole_word,
            find::MAX_FIND_MATCHES,
            || handle.find_gen.load(Ordering::Relaxed) == generation,
        )?;
        Ok(FindResult {
            matches,
            capped,
            line_count: doc.line_count(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Replace the next `max` matches of a query from a 0-based line/column position — `1` is
/// the widget's Replace (the position is its current match), `usize::MAX` its Replace All.
/// Every replacement lands in the rope as one undo step, so a Replace All is a single Ctrl+Z.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // the find options mirror viewer_find's, plus the replace spec
pub async fn viewer_replace(
    state: tauri::State<'_, ViewerState>,
    doc_id: u64,
    query: String,
    replacement: String,
    case_sensitive: bool,
    whole_word: bool,
    regexp: bool,
    from_line: usize,
    from_col: usize,
    max: usize,
) -> Result<ReplaceResult, String> {
    // A Replace All walks the whole document: wait out a still-building tail off the
    // command's thread first (the rope work below is the same synchronous pass as ever).
    let handle = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    tauri::async_runtime::spawn_blocking(move || wait_tail(&handle))
        .await
        .map_err(|e| e.to_string())??;
    let options = find::FindOptions {
        case_sensitive,
        whole_word,
        regexp,
    };
    replace_impl(
        &state,
        doc_id,
        &query,
        &replacement,
        &options,
        from_line,
        from_col,
        max,
    )
}

#[allow(clippy::too_many_arguments)]
fn replace_impl(
    state: &ViewerState,
    doc_id: u64,
    query: &str,
    replacement: &str,
    options: &find::FindOptions,
    from_line: usize,
    from_col: usize,
    max: usize,
) -> Result<ReplaceResult, String> {
    state.stop_warming(doc_id);
    let matcher = find::Matcher::compile(query, options)?;
    state.with_doc(doc_id, |doc| {
        let sites = find::replacement_sites(
            &doc.rope,
            &matcher,
            options.whole_word,
            replacement,
            from_line,
            from_col,
            max,
        );
        let replacements = sites.len();
        let first_line = doc.replace_sites(sites);
        ReplaceResult {
            replacements,
            first_line,
            line_count: doc.line_count(),
        }
    })
}

/// The test-side entry for `viewer_find`: the command itself locks through
/// `spawn_blocking`.
#[cfg(test)]
fn find_impl(
    state: &ViewerState,
    doc_id: u64,
    query: &str,
    options: &find::FindOptions,
) -> Result<FindResult, String> {
    let matcher = find::Matcher::compile(query, options)?;
    state
        .with_doc(doc_id, |doc| {
            find::scan_rope(
                &doc.rope,
                &matcher,
                options.whole_word,
                find::MAX_FIND_MATCHES,
                || true,
            )
            .map(|(matches, capped)| FindResult {
                matches,
                capped,
                line_count: doc.line_count(),
            })
        })
        .and_then(|inner| inner)
}

/// Keep a windowed editor's unsaved buffer for hot exit. The backend writes the backup
/// itself, so a hundred-megabyte draft never crosses the IPC — the JSON path the full
/// editor takes would freeze the webview on documents this large.
#[tauri::command]
pub async fn viewer_backup(
    state: tauri::State<'_, ViewerState>,
    doc_id: u64,
) -> Result<(), String> {
    // The backup writes the document whole: a still-building tail must land first, or the
    // hot-exit restore would resurrect a truncated file.
    let wait = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    tauri::async_runtime::spawn_blocking(move || wait_tail(&wait))
        .await
        .map_err(|e| e.to_string())??;
    let (path, text) = state.with_doc(doc_id, |doc| {
        (doc.path.display().to_string(), doc.full_text())
    })?;
    let dir = crate::cmd_fs::backups_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::cmd_fs::backup_write_into(&dir, &path, text)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The document's outline, computed on demand (the open path no longer pays for it). The
/// scan runs on the blocking pool over a snapshot clone of the rope — ropey clones share
/// chunks — so the document lock is held only for the clone and a window fetch never queues
/// behind a whole-file outline pass.
#[tauri::command]
pub async fn viewer_symbols(
    state: tauri::State<'_, ViewerState>,
    doc_id: u64,
) -> Result<Vec<Symbol>, String> {
    let handle = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    // The outline is a whole-document scan: it must see the whole document.
    let wait = Arc::clone(&handle);
    tauri::async_runtime::spawn_blocking(move || wait_tail(&wait))
        .await
        .map_err(|e| e.to_string())??;
    let (rope, language) = {
        let doc = handle
            .doc
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (doc.rope.clone(), doc.language.clone())
    };
    tauri::async_runtime::spawn_blocking(move || outline::outline_rope(&rope, &language))
        .await
        .map_err(|e| e.to_string())
}

/// Undo the most recent edit. `None` when there is nothing to undo.
#[tauri::command]
pub fn viewer_undo(
    state: tauri::State<ViewerState>,
    doc_id: u64,
) -> Result<Option<UndoResult>, String> {
    state.stop_warming(doc_id);
    state.with_doc(doc_id, |doc| {
        doc.undo().map(|(first_line, line_count)| UndoResult {
            first_line,
            line_count,
        })
    })
}

/// Redo the most recently undone edit. `None` when there is nothing to redo.
#[tauri::command]
pub fn viewer_redo(
    state: tauri::State<ViewerState>,
    doc_id: u64,
) -> Result<Option<UndoResult>, String> {
    state.stop_warming(doc_id);
    state.with_doc(doc_id, |doc| {
        doc.redo().map(|(first_line, line_count)| UndoResult {
            first_line,
            line_count,
        })
    })
}

/// Drop a document (its tab closed). The warmer holds its own `Arc` to the handle, so the
/// generation bump is what tells it to stop parsing against a document nobody reads.
#[tauri::command]
pub fn viewer_close(state: tauri::State<ViewerState>, doc_id: u64) {
    let mut docs = state
        .docs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(handle) = docs.remove(&doc_id) {
        handle.warm_gen.fetch_add(1, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    /// Release-run latency probe of the large-file paths against a real file:
    /// `GGS_BENCH_FILE=... cargo test --release open_bench -- --nocapture`. Skipped without
    /// the variable, so the normal test run never touches it. Reports the three latencies
    /// the user feels: the open, the cold window's plain-text delivery, and the color pass
    /// that follows it.
    #[test]
    fn open_bench_real_file() {
        let Ok(path) = std::env::var("GGS_BENCH_FILE") else {
            return;
        };
        // The stages the felt open latency is made of, so a regression names its culprit.
        let bytes_len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let t = std::time::Instant::now();
        let bytes = std::fs::read(&path).expect("read");
        let read_ms = t.elapsed().as_millis();
        let t = std::time::Instant::now();
        let decoded = crate::encoding::decode(&bytes, None);
        let decode_ms = t.elapsed().as_millis();
        let t = std::time::Instant::now();
        let rope = ropey::Rope::from(decoded.text.as_str());
        let rope_ms = t.elapsed().as_millis();
        drop(rope);
        let t = std::time::Instant::now();
        let state = ViewerState::default();
        let opened = open_impl(&state, &path).expect("open");
        let open_ms = t.elapsed().as_millis();
        // The staged open returns from the head; the tail builds in the background. The
        // whole-document time is when the landing has cleared the estimate.
        let lines = opened.line_count;
        let t = std::time::Instant::now();
        while state
            .with_doc(opened.doc_id, |doc| doc.line_estimate.is_some())
            .unwrap_or(false)
        {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let whole_ms = t.elapsed().as_millis();
        let exact = state
            .with_doc(opened.doc_id, |doc| doc.line_count())
            .unwrap_or(0);
        let mid = exact / 2;
        let t = std::time::Instant::now();
        let window = lines_impl(&state, opened.doc_id, mid, mid + 60).unwrap();
        let text_ms = t.elapsed().as_millis();
        assert_eq!(window.lines.len(), 61);
        let t = std::time::Instant::now();
        let colored = highlight_impl(&state, opened.doc_id, mid, mid + 60).unwrap();
        let color_ms = t.elapsed().as_millis();
        // The region is warm now: the same window answers inline, colored.
        let t = std::time::Instant::now();
        let again = lines_impl(&state, opened.doc_id, mid, mid + 60).unwrap();
        let revisit_ms = t.elapsed().as_millis();
        println!(
            "head_open={open_ms}ms whole={whole_ms}ms (read={read_ms}ms decode={decode_ms}ms rope={rope_ms}ms sequential, {bytes_len} bytes) est_lines={lines} exact_lines={exact} cold_text={text_ms}ms pending={} cold_color={color_ms}ms revisit={revisit_ms}ms pending_again={} mid_line_scopes={}",
            window.tokens_pending,
            again.tokens_pending,
            colored.lines[0].1.len()
        );
    }

    use super::*;
    use std::io::Write;

    #[test]
    fn a_file_past_the_head_opens_staged_and_appends_its_tail() {
        let s = scratch();
        // ~12 MB of uniform lines: past HEAD_BYTES, so the open returns from the head
        // while the tail builds on its own thread.
        let mut text = String::with_capacity(12 << 20);
        for i in 0..330_000 {
            text.push_str(&format!("line {i:06} of the staged open test\n"));
        }
        let path = s.file("staged.log", &text);
        let state = ViewerState::default();
        let opened = open_impl(&state, &path).unwrap();
        // The scroller's first count is the estimate, in the right ballpark immediately.
        let (estimate, staging) = state
            .with_doc(opened.doc_id, |doc| {
                (doc.line_count(), doc.tail_id.is_some())
            })
            .unwrap();
        assert!(staging, "a file past the head must open staged");
        assert!(
            (300_000..=360_000).contains(&estimate),
            "estimate {estimate}"
        );
        // A window beyond the head waits for the tail and then serves real lines (the
        // estimate may overshoot the exact count; the mid-file window cannot).
        let mid = estimate / 2;
        let beyond = text_impl(&state, opened.doc_id, mid, mid + 9).unwrap();
        assert_eq!(beyond.lines.len(), 10);
        // Landed: the exact count, the estimate gone.
        let exact = state
            .with_doc(opened.doc_id, |doc| doc.line_count())
            .unwrap();
        assert_eq!(exact, 330_001); // the trailing newline's empty final line
        assert!(state
            .with_doc(opened.doc_id, |doc| doc.line_estimate.is_none())
            .unwrap());
        let last = text_impl(&state, opened.doc_id, exact - 3, exact - 1).unwrap();
        assert_eq!(last.lines[0], "line 329998 of the staged open test");
        assert_eq!(last.lines[1], "line 329999 of the staged open test");
        assert_eq!(last.lines[2], "", "the trailing newline's empty final line");
    }

    struct Scratch {
        _dir: tempfile::TempDir,
    }

    impl Scratch {
        fn file(&self, name: &str, contents: &str) -> String {
            let path = self._dir.path().join(name);
            std::fs::File::create(&path)
                .unwrap()
                .write_all(contents.as_bytes())
                .unwrap();
            path.display().to_string()
        }
    }

    fn scratch() -> Scratch {
        Scratch {
            _dir: tempfile::TempDir::new().unwrap(),
        }
    }

    #[test]
    fn open_lines_roundtrip() {
        let s = scratch();
        let path = s.file("main.rs", "fn main() {\n    println!(\"hi\");\n}\n");
        let state = ViewerState::default();
        let opened = open_impl(&state, &path).unwrap();
        assert_eq!(opened.line_count, 4);
        assert_eq!(opened.syntax_name, "Rust");
        // The outline is pulled separately, after the open itself.
        let symbols = symbols_impl(&state, opened.doc_id).unwrap();
        assert_eq!(symbols[0].name, "main");
        let lines = lines_impl(&state, opened.doc_id, 0, 3).unwrap();
        assert_eq!(lines.start_line, 0);
        assert!(
            !lines.tokens_pending,
            "line 0 always has a fresh state to resume from"
        );
        assert_eq!(lines.lines[1].0, "    println!(\"hi\");");
        assert!(!lines.lines[1].1.is_empty(), "the body line carries tokens");
    }

    #[test]
    fn a_prewarmed_document_serves_its_open_once() {
        let s = scratch();
        let path = s.file("warm.rs", "fn warm() {}\n");
        prewarm(path.clone());
        let doc = match take_prewarmed(&path).unwrap().unwrap() {
            Staged::Full(doc) => doc,
            Staged::Head { .. } => panic!("a small file must open whole"),
        };
        assert_eq!(doc.syntax_name, "Rust");
        assert_eq!(doc.line_count(), 2);
        // The slot serves one open; the next open of the same path builds afresh.
        assert!(take_prewarmed(&path).is_none());
        // A binary launch file is never prewarmed, and another path never takes the slot.
        let blob = s.file("blob.bin", "a\0b");
        prewarm(blob.clone());
        assert!(take_prewarmed(&blob).is_none());
        prewarm(path.clone());
        assert!(take_prewarmed(&blob).is_none());
        assert!(take_prewarmed(&path).is_some());
    }

    #[test]
    fn binary_file_is_rejected() {
        let s = scratch();
        let path = s.file("blob.bin", "a\0b");
        let err = open_impl(&ViewerState::default(), &path).unwrap_err();
        assert!(err.contains("binary"), "{err}");
    }

    #[test]
    fn reload_reports_change_only_when_the_disk_differs() {
        let s = scratch();
        let path = s.file("watched.txt", "one\ntwo\n");
        let state = ViewerState::default();
        let opened = open_impl(&state, &path).unwrap();
        let doc_id = opened.doc_id;
        // An unchanged file reports no change; the document is not rebuilt.
        let (path_of, stamp) = state
            .with_doc(doc_id, |doc| (doc.path.clone(), doc.fingerprint.clone()))
            .unwrap();
        assert_eq!(
            fingerprint(&path_of),
            stamp,
            "the open stamp matches the file"
        );
        // An external edit (write + a distinguishable mtime) reports a change and reloads.
        std::thread::sleep(std::time::Duration::from_millis(10));
        s.file("watched.txt", "one\nTWO\nthree\n");
        assert_ne!(fingerprint(&path_of), stamp);
        // (mirrors viewer_reload's body against the test harness's state)
        let mut doc = open_doc(&path).unwrap();
        assert_eq!(doc.line_count(), 4);
        assert_eq!(doc.line_text(1), "TWO");
        // After a save the stamp matches again: the save's own echo reads as unchanged.
        std::fs::write(&doc.path, doc.full_text()).unwrap();
        doc.fingerprint = fingerprint(&doc.path);
        assert_eq!(fingerprint(&doc.path), doc.fingerprint);
    }

    #[test]
    fn text_windows_read_plain_lines_and_cap() {
        let s = scratch();
        let path = s.file("plain.txt", "a\nbb\nccc\n");
        let state = ViewerState::default();
        let opened = open_impl(&state, &path).unwrap();
        let window = text_impl(&state, opened.doc_id, 1, 2).unwrap();
        assert_eq!(window.start_line, 1);
        assert_eq!(window.line_count, 4);
        assert_eq!(window.lines, ["bb", "ccc"]);
        // A range past the end is clamped to the last (empty, trailing-newline) line.
        let tail = text_impl(&state, opened.doc_id, 99, 120).unwrap();
        assert_eq!(tail.lines, [""]);
        assert!(text_impl(&state, opened.doc_id, 0, 600).is_err());
    }

    #[test]
    fn edit_and_save_roundtrip() {
        let s = scratch();
        let path = s.file("notes.txt", "one\ntwo\n");
        let state = ViewerState::default();
        let opened = open_impl(&state, &path).unwrap();
        let edit = edit_impl(&state, opened.doc_id, 1, 0, 2, 0, "TWO\n").unwrap();
        assert_eq!(edit.line_count, 3);
        assert_eq!(edit.rehighlight_from, 1);
        // The save path itself (the streaming writer `viewer_save` runs), not a manual dump.
        let (path_of, encoding, eol, rope) = state
            .with_doc(opened.doc_id, |doc| {
                (
                    doc.path.clone(),
                    doc.encoding.clone(),
                    doc.eol.clone(),
                    doc.rope.clone(),
                )
            })
            .unwrap();
        write_doc(&path_of, &rope, &encoding, &eol, &|_, _| {}).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "one\nTWO\n");
    }

    #[test]
    fn streamed_save_matches_the_whole_text_encoder() {
        let s = scratch();
        // The encodings and line-ending shapes a document can carry: the streaming writer
        // must produce byte-for-byte what `full_text` + `encode` always did.
        for (text, encoding, eol) in [
            ("one\ntwo\n", "utf8", "lf"),
            ("one\ntwo\n", "utf8", "crlf"),
            ("bom\r\nlines\r\r\n", "utf8bom", "crlf"),
            ("lone\rcr kept\r", "utf8", "crlf"),
            ("中文\r\n行\n", "utf8bom", "crlf"),
            ("", "utf8", "lf"),
            ("legacy é\r\n", "windows-1252", "crlf"),
            ("中文\n", "gb18030", "lf"),
        ] {
            let path = s.file("save.out", text);
            write_doc(
                std::path::Path::new(&path),
                &ropey::Rope::from(text),
                encoding,
                eol,
                &|_, _| {},
            )
            .unwrap();
            assert_eq!(
                std::fs::read(&path).unwrap(),
                crate::encoding::encode(text, encoding, eol),
                "{encoding}/{eol}: {text:?}"
            );
        }
    }

    #[test]
    fn crlf_streaming_joins_pairs_split_across_chunk_boundaries() {
        // The exact splits the rope's internal chunking can produce: a `\r\n` pair cut in
        // half by a chunk boundary, a lone CR at a chunk's end, empty chunks between them.
        let joined = |chunks: &[&str]| -> Vec<u8> {
            let mut out = Vec::new();
            write_crlf(&mut out, chunks.iter().copied(), |_| {}).unwrap();
            out
        };
        assert_eq!(joined(&["a\r", "\nb"]), b"a\r\nb");
        assert_eq!(joined(&["a\r", "b"]), b"a\rb");
        assert_eq!(joined(&["a\r", "", "\nb"]), b"a\r\nb");
        assert_eq!(joined(&["a\r"]), b"a\r");
        assert_eq!(joined(&["\r\n", "x\r\n"]), b"\r\nx\r\n");
        // Exhaustively: every split of a mixed text streams to exactly what the whole-text
        // encoder makes of the same text, so no boundary can change the bytes.
        let text = "one\r\ntwo\nthree\r\rfour\r\n\r\nfive\r";
        let whole = crate::encoding::encode(text, "utf8", "crlf");
        for at in 0..=text.len() {
            let (head, tail) = text.split_at(at);
            let mut out = Vec::new();
            write_crlf(&mut out, [head, tail].into_iter(), |_| {}).unwrap();
            assert_eq!(out, whole, "split at {at}");
        }
    }

    #[test]
    fn save_progress_streams_monotonic_bytes() {
        let s = scratch();
        // ~21 MB, so the 8 MiB step reports intermediates, not only the two ends.
        let text = (0..1_000_000)
            .map(|i| format!("progress line {i:06}\n"))
            .collect::<String>();
        let path = s.file("progress.log", &text);
        let events: std::sync::Arc<std::sync::Mutex<Vec<(u64, u64)>>> = Default::default();
        let seen = std::sync::Arc::clone(&events);
        write_doc(
            std::path::Path::new(&path),
            &ropey::Rope::from(text.as_str()),
            "utf8",
            "lf",
            &move |written, total| seen.lock().unwrap().push((written, total)),
        )
        .unwrap();
        let events = events.lock().unwrap();
        let total = text.len() as u64;
        assert_eq!(
            events.first(),
            Some(&(0, total)),
            "starts at zero over the whole size"
        );
        assert_eq!(
            events.last(),
            Some(&(total, total)),
            "ends at the whole size"
        );
        assert!(
            events.len() >= 4,
            "the 8 MiB step must report intermediates: {events:?}"
        );
        assert!(
            events.windows(2).all(|pair| pair[0].0 < pair[1].0),
            "written bytes only ever grow: {events:?}"
        );
        assert!(events.iter().all(|&(written, of)| written <= of));
    }

    #[test]
    fn a_staged_document_saves_whole_after_its_tail_lands() {
        let s = scratch();
        // ~13 MB: past HEAD_BYTES, so the open returns from the head while the tail builds
        // on its own thread. `viewer_save` waits that tail out before writing; the same
        // landing is proven here before the writer runs.
        let mut text = String::with_capacity(13 << 20);
        for i in 0..330_000 {
            text.push_str(&format!("line {i:06} to save\n"));
        }
        let path = s.file("staged-save.log", &text);
        let state = ViewerState::default();
        let opened = open_impl(&state, &path).unwrap();
        while state
            .with_doc(opened.doc_id, |doc| doc.line_estimate.is_some())
            .unwrap()
        {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        edit_impl(&state, opened.doc_id, 0, 0, 0, 0, "edited ").unwrap();
        let (path_of, encoding, eol, rope) = state
            .with_doc(opened.doc_id, |doc| {
                (
                    doc.path.clone(),
                    doc.encoding.clone(),
                    doc.eol.clone(),
                    doc.rope.clone(),
                )
            })
            .unwrap();
        write_doc(&path_of, &rope, &encoding, &eol, &|_, _| {}).unwrap();
        let expect = text.replacen("line 000000", "edited line 000000", 1);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), expect);
    }

    #[test]
    fn window_cap_is_enforced() {
        let s = scratch();
        let path = s.file("big.txt", &"line\n".repeat(600));
        let state = ViewerState::default();
        let opened = open_impl(&state, &path).unwrap();
        assert!(lines_impl(&state, opened.doc_id, 0, 600).is_err());
    }

    #[test]
    fn a_cold_window_answers_as_plain_text_then_colors_through_the_highlight() {
        let s = scratch();
        // 4000 lines, so a window at 2000 sits far beyond every checkpoint (QUICK_CATCHUP
        // is 1024) — the drag-a-scrollbar case.
        let text = (0..4000)
            .map(|i| format!("let v{i} = {i}; // c\n"))
            .collect::<String>();
        let path = s.file("cold.rs", &text);
        let state = ViewerState::default();
        let opened = open_impl(&state, &path).unwrap();
        let window = lines_impl(&state, opened.doc_id, 2000, 2020).unwrap();
        assert!(
            window.tokens_pending,
            "the cold window must not wait on the catch-up parse"
        );
        assert!(window.lines.iter().all(|(_, tokens)| tokens.is_empty()));
        assert_eq!(window.lines[0].0, "let v2000 = 2000; // c");
        // The colors are the second delivery: same range, now with tokens.
        let colored = highlight_impl(&state, opened.doc_id, 2000, 2020).unwrap();
        assert!(!colored.tokens_pending);
        assert!(
            colored.lines[0]
                .1
                .iter()
                .any(|(_, _, scope)| scope.contains("storage.type")),
            "the highlight must carry syntect scopes, got {:?}",
            colored.lines[0].1
        );
        assert_eq!(colored.lines[0].0, "let v2000 = 2000; // c");
        // The catch-up checkpointed every block it crossed: the same window now highlights
        // inline — the second visit to the region is a single fast call.
        let again = lines_impl(&state, opened.doc_id, 2000, 2020).unwrap();
        assert!(!again.tokens_pending);
        assert!(!again.lines[0].1.is_empty());
    }

    #[test]
    fn a_newer_window_generation_supersedes_the_catch_up() {
        // The handle's lines_gen is what the catch-up walk checks between slices: once a
        // newer window request has bumped it, the older walk aborts instead of burning a
        // core parsing toward a viewport nobody is looking at.
        let s = scratch();
        let text = (0..4000)
            .map(|i| format!("let v{i} = {i}; // c\n"))
            .collect::<String>();
        let path = s.file("drag.rs", &text);
        let state = ViewerState::default();
        let opened = open_impl(&state, &path).unwrap();
        let handle = state.doc_handle(opened.doc_id).unwrap();
        let stale = handle.lines_gen.fetch_add(1, Ordering::Relaxed) + 1;
        // A second window request starts here and supersedes the first.
        handle.lines_gen.fetch_add(1, Ordering::Relaxed);
        let err = highlight_with(&state, opened.doc_id, 2000, 2020, stale).unwrap_err();
        assert_eq!(err, "superseded");
    }

    #[test]
    fn the_warmer_leaves_the_document_cheap_to_jump_around() {
        let s = scratch();
        let text = (0..4000)
            .map(|i| format!("let v{i} = {i}; // c\n"))
            .collect::<String>();
        let path = s.file("warm.rs", &text);
        let state = ViewerState::default();
        let opened = open_impl(&state, &path).unwrap();
        let handle = state.doc_handle(opened.doc_id).unwrap();
        warm_all(&handle).unwrap();
        // Warmed to the end: the deepest window answers inline, colored.
        let tail = lines_impl(&state, opened.doc_id, 3990, 3999).unwrap();
        assert!(!tail.tokens_pending);
        assert!(!tail.lines[0].1.is_empty());
        // A stale warm generation must not run: an edit bumped it, so the checkpoints the
        // walk would parse against may be gone.
        let stale = handle.warm_gen.fetch_add(1, Ordering::Relaxed) + 1;
        handle.warm_gen.fetch_add(1, Ordering::Relaxed);
        let err = warm_with(&handle, 3999, stale).unwrap_err();
        assert_eq!(err, "superseded");
    }

    #[test]
    fn find_reports_whole_document_matches_with_the_options() {
        let s = scratch();
        let path = s.file("find.txt", "Alpha beta\nalpha ALPHA\nalphabet\n");
        let state = ViewerState::default();
        let opened = open_impl(&state, &path).unwrap();
        let find = |query: &str, case: bool, word: bool, regex: bool| {
            find_impl(
                &state,
                opened.doc_id,
                query,
                &find::FindOptions {
                    case_sensitive: case,
                    whole_word: word,
                    regexp: regex,
                },
            )
        };
        let locate = |result: &FindResult| {
            result
                .matches
                .iter()
                .map(|m| (m.line, m.start_col, m.end_col))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            locate(&find("alpha", false, false, false).unwrap()),
            [(0, 0, 5), (1, 0, 5), (1, 6, 11), (2, 0, 5)]
        );
        assert_eq!(
            locate(&find("ALPHA", true, false, false).unwrap()),
            [(1, 6, 11)]
        );
        assert_eq!(
            locate(&find("alpha", false, true, false).unwrap()),
            [(0, 0, 5), (1, 0, 5), (1, 6, 11)]
        );
        assert_eq!(
            locate(&find("l+", false, false, true).unwrap()),
            [(0, 1, 2), (1, 1, 2), (1, 7, 8), (2, 1, 2)]
        );
        // An invalid regex is a user-readable error, not a panic.
        assert!(find("([open", false, false, true)
            .unwrap_err()
            .contains("Invalid regular expression"));
        // A find on a closed document says so.
        assert!(find_impl(
            &ViewerState::default(),
            99,
            "x",
            &find::FindOptions::default()
        )
        .is_err());
    }

    #[test]
    fn replace_next_and_replace_all_are_one_undo_step_each() {
        let s = scratch();
        let path = s.file("rep.txt", "a=1 b=22\n");
        let state = ViewerState::default();
        let opened = open_impl(&state, &path).unwrap();
        let opts = find::FindOptions {
            case_sensitive: false,
            whole_word: false,
            regexp: true,
        };
        // Replace All with group references, from the top.
        let result = replace_impl(
            &state,
            opened.doc_id,
            r"(\w+)=(\w+)",
            "$2=$1",
            &opts,
            0,
            0,
            usize::MAX,
        )
        .unwrap();
        assert_eq!(result.replacements, 2);
        assert_eq!(result.first_line, 0);
        assert_eq!(result.line_count, 2);
        assert_eq!(
            text_impl(&state, opened.doc_id, 0, 0).unwrap().lines,
            ["1=a 22=b"]
        );
        // One undo rewinds the whole replace-all.
        state
            .with_doc(opened.doc_id, |doc| doc.undo().unwrap())
            .unwrap();
        assert_eq!(
            text_impl(&state, opened.doc_id, 0, 0).unwrap().lines,
            ["a=1 b=22"]
        );
        // Replace (max 1) from a mid-line position touches only the next match.
        let literal = find::FindOptions {
            case_sensitive: false,
            whole_word: false,
            regexp: false,
        };
        let result = replace_impl(&state, opened.doc_id, "b", "B", &literal, 0, 4, 1).unwrap();
        assert_eq!(result.replacements, 1);
        assert_eq!(
            text_impl(&state, opened.doc_id, 0, 0).unwrap().lines,
            ["a=1 B=22"]
        );
        // The find after the replace sees the new text.
        let found = find_impl(&state, opened.doc_id, "B=", &find::FindOptions::default()).unwrap();
        assert_eq!(found.matches.len(), 1);
        assert_eq!(found.matches[0].line, 0);
    }

    #[test]
    fn a_newer_find_generation_supersedes_a_scan() {
        // The DocHandle generation is what `viewer_find` checks mid-scan: once a newer find
        // has bumped it, the older scan's liveness check turns false and the scan aborts.
        let s = scratch();
        let path = s.file("cancel.txt", &"needle\n".repeat(1200));
        let state = ViewerState::default();
        let opened = open_impl(&state, &path).unwrap();
        let handle = state.doc_handle(opened.doc_id).unwrap();
        let rope = state
            .with_doc(opened.doc_id, |doc| doc.rope.clone())
            .unwrap();
        let matcher = find::Matcher::compile("needle", &find::FindOptions::default()).unwrap();
        let generation = handle.find_gen.fetch_add(1, Ordering::Relaxed) + 1;
        // A second find on the same document starts here.
        handle.find_gen.fetch_add(1, Ordering::Relaxed);
        let alive = || handle.find_gen.load(Ordering::Relaxed) == generation;
        assert!(find::scan_rope(&rope, &matcher, false, find::MAX_FIND_MATCHES, alive).is_err());
    }
}
