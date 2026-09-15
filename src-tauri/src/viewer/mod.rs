//! The ultra-fast code viewer backend: documents live in a rope with syntect (pure Rust,
//! fancy-regex engine) highlighting checkpointed per block, so opening is O(size of the file
//! read) and every scroll window highlights only what is visible.

pub mod doc;
mod find;
mod outline;

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use doc::ViewerDoc;
pub use find::MatchLoc;
pub use outline::Symbol;

/// The largest window `viewer_lines` will highlight in one call — enough for a viewport plus
/// overscan, small enough that a bug in the frontend cannot ask for the whole file.
const MAX_WINDOW: usize = 500;

/// One open document: the rope behind a lock, plus the find-scan generation. The
/// generation lives outside the lock so a new `viewer_find` can supersede a scan that is
/// still running (and still holding the lock) without waiting for it to finish.
struct DocHandle {
    doc: Mutex<ViewerDoc>,
    find_gen: AtomicU64,
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

    fn insert_doc(&self, doc_id: u64, doc: ViewerDoc) {
        self.docs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                doc_id,
                Arc::new(DocHandle {
                    doc: Mutex::new(doc),
                    find_gen: AtomicU64::new(0),
                }),
            );
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
    pub symbols: Vec<Symbol>,
    /// The encoding the file was decoded with, and its line endings; a save writes them back.
    pub encoding: String,
    pub eol: String,
}

/// One highlighted line as the IPC carries it: its text plus `(start, end, scope)` token
/// spans; offsets are code points.
pub type LineSpans = (String, Vec<(usize, usize, String)>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinesResult {
    pub start_line: usize,
    pub line_count: usize,
    pub lines: Vec<LineSpans>,
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

/// The heavy half of opening — read, decode, rope and outline. Runs on the blocking pool
/// (`viewer_open`) so a file of hundreds of megabytes cannot stall the UI while it loads.
fn open_doc(path: &str) -> Result<(ViewerDoc, Vec<Symbol>), String> {
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
    // The outline scans the decoded text (a borrow per line) before the rope exists; the
    // rope's own scan would copy every line that straddles a chunk.
    let symbols = outline::outline_text(&decoded.text, &language);
    let mut doc = ViewerDoc::new(std::path::PathBuf::from(path), &decoded.text, &language);
    doc.encoding = decoded.encoding.to_owned();
    doc.eol = decoded.eol.to_owned();
    doc.fingerprint = fingerprint(std::path::Path::new(path));
    Ok((doc, symbols))
}

/// A document built ahead of its `viewer_open`: `git-graph-studio <file>` starts the read,
/// decode, rope and outline of its launch file at process start, in parallel with the
/// window and the webview coming up (the better part of a second), so the page's open
/// request finds the work already done instead of starting it then.
struct Prewarmed {
    path: String,
    handle: std::thread::JoinHandle<Result<(ViewerDoc, Vec<Symbol>), String>>,
}

static PREWARMED: Mutex<Option<Prewarmed>> = Mutex::new(None);

/// Start building the document for `path` on a background thread. A binary file is not
/// worth a document (the hex viewer reads windows on demand), so its head is sniffed
/// first - the sniff is what the frontend's probe asks anyway, and it costs one small read.
pub fn prewarm(path: String) {
    if !matches!(crate::cmd_fs::probe(&path), Ok(probe) if !probe.binary) {
        return;
    }
    let load = path.clone();
    let handle = std::thread::spawn(move || open_doc(&load));
    *PREWARMED.lock().unwrap_or_else(|p| p.into_inner()) = Some(Prewarmed { path, handle });
}

/// The prewarmed document for `path`, waiting for its thread if it is still building;
/// `None` when nothing was prewarmed for this path (the slot serves one open, then clears).
fn take_prewarmed(path: &str) -> Option<Result<(ViewerDoc, Vec<Symbol>), String>> {
    let mut slot = PREWARMED.lock().unwrap_or_else(|p| p.into_inner());
    if slot.as_ref().is_none_or(|p| p.path != path) {
        return None;
    }
    let prewarmed = slot.take()?;
    drop(slot);
    Some(
        prewarmed
            .handle
            .join()
            .unwrap_or_else(|_| Err(format!("{path}: the prewarm thread failed"))),
    )
}

fn open_result(doc_id: u64, doc: &ViewerDoc, symbols: Vec<Symbol>) -> OpenResult {
    OpenResult {
        doc_id,
        line_count: doc.line_count(),
        syntax_name: doc.syntax_name.clone(),
        language: doc.language.clone(),
        symbols,
        encoding: doc.encoding.clone(),
        eol: doc.eol.clone(),
    }
}

#[cfg(test)]
fn open_impl(state: &ViewerState, path: &str) -> Result<OpenResult, String> {
    let (doc, symbols) = open_doc(path)?;
    let result = open_result(state.next_id.fetch_add(1, Ordering::Relaxed), &doc, symbols);
    state.insert_doc(result.doc_id, doc);
    Ok(result)
}

/// The highlight window over an already-locked document.
fn lines_of(doc: &mut ViewerDoc, start: usize, end: usize) -> LinesResult {
    let start = start.min(doc.line_count().saturating_sub(1));
    let lines = doc.highlight_lines(start, end);
    LinesResult {
        start_line: start,
        line_count: doc.line_count(),
        lines,
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
    state.with_doc(doc_id, |doc| lines_of(doc, start, end))
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
    state.with_doc(doc_id, |doc| text_of(doc, start, end))
}

/// The plain-text window over an already-locked document.
fn text_of(doc: &mut ViewerDoc, start: usize, end: usize) -> TextResult {
    let total = doc.line_count();
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
        line_count: total,
        lines,
    }
}

/// Open a file in the viewer. Reads, decodes and ropes the file, and extracts the outline —
/// highlighting is deliberately lazy (per window via `viewer_lines`).
#[tauri::command]
pub async fn viewer_open(
    state: tauri::State<'_, ViewerState>,
    path: String,
) -> Result<OpenResult, String> {
    let doc_id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let load = path.clone();
    let (doc, symbols) = tauri::async_runtime::spawn_blocking(move || {
        take_prewarmed(&load).unwrap_or_else(|| open_doc(&load))
    })
    .await
    .map_err(|e| e.to_string())??;
    let result = open_result(doc_id, &doc, symbols);
    state.insert_doc(doc_id, doc);
    Ok(result)
}

/// Highlight a window of lines (0-based, inclusive) for the virtual scroller. The work runs
/// on the blocking pool: a window that lands far beyond every checkpoint parses back to the
/// last one, and that catch-up must not run on (nor freeze) the main thread.
#[tauri::command]
pub async fn viewer_lines(
    state: tauri::State<'_, ViewerState>,
    doc_id: u64,
    start: usize,
    end: usize,
) -> Result<LinesResult, String> {
    check_window(start, end)?;
    let doc = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut doc = doc
            .doc
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        lines_of(&mut doc, start, end)
    })
    .await
    .map_err(|e| e.to_string())
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
    edit_impl(
        &state, doc_id, start_line, start_col, end_line, end_col, &text,
    )
}

/// Write a viewer document back to disk. The encode and write of a large file can take
/// hundreds of milliseconds, so they run on the blocking pool — the UI must not freeze on
/// Ctrl+S the way it did when the whole document crossed the IPC as one JSON string.
#[tauri::command]
pub async fn viewer_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, ViewerState>,
    doc_id: u64,
) -> Result<(), String> {
    let (path, encoding, eol, text) = state.with_doc(doc_id, |doc| {
        (
            doc.path.clone(),
            doc.encoding.clone(),
            doc.eol.clone(),
            doc.full_text(),
        )
    })?;
    let stamp = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        std::fs::write(&path, crate::encoding::encode(&text, &encoding, &eol))
            .map_err(|e| format!("{}: {e}", path.display()))?;
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
    let load = path.clone();
    let (doc, _symbols) =
        tauri::async_runtime::spawn_blocking(move || open_doc(&load.display().to_string()))
            .await
            .map_err(|e| e.to_string())??;
    let line_count = doc.line_count();
    // The tab may have closed while the file was being read: a closed id must not come
    // back as a document nobody will ever close again.
    let mut docs = state
        .docs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match docs.get_mut(&doc_id) {
        Some(slot) => {
            *slot = Arc::new(DocHandle {
                doc: Mutex::new(doc),
                find_gen: AtomicU64::new(0),
            })
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
        let mut doc = doc
            .doc
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        text_of(&mut doc, start, end)
    })
    .await
    .map_err(|e| e.to_string())
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
pub fn viewer_replace(
    state: tauri::State<ViewerState>,
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

/// Undo the most recent edit. `None` when there is nothing to undo.
#[tauri::command]
pub fn viewer_undo(
    state: tauri::State<ViewerState>,
    doc_id: u64,
) -> Result<Option<UndoResult>, String> {
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
    state.with_doc(doc_id, |doc| {
        doc.redo().map(|(first_line, line_count)| UndoResult {
            first_line,
            line_count,
        })
    })
}

/// Keep a windowed editor's unsaved buffer for hot exit. The backend writes the backup
/// itself, so a hundred-megabyte draft never crosses the IPC — the JSON path the full
/// editor takes would freeze the webview on documents this large.
#[tauri::command]
pub async fn viewer_backup(
    state: tauri::State<'_, ViewerState>,
    doc_id: u64,
) -> Result<(), String> {
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

/// The document's outline, recomputed (cheap: a single line scan).
#[tauri::command]
pub fn viewer_symbols(
    state: tauri::State<ViewerState>,
    doc_id: u64,
) -> Result<Vec<Symbol>, String> {
    state.with_doc(doc_id, |doc| outline::outline(&*doc))
}

/// Drop a document (its tab closed).
#[tauri::command]
pub fn viewer_close(state: tauri::State<ViewerState>, doc_id: u64) {
    state.docs.lock().unwrap().remove(&doc_id);
}

#[cfg(test)]
mod tests {
    /// Release-run latency probe of the large-file open path against a real file:
    /// `GGS_BENCH_FILE=... cargo test --release open_bench -- --nocapture`. Skipped without
    /// the variable, so the normal test run never touches it.
    #[test]
    fn open_bench_real_file() {
        let Ok(path) = std::env::var("GGS_BENCH_FILE") else {
            return;
        };
        let t = std::time::Instant::now();
        let (mut doc, symbols) = open_doc(&path).expect("open");
        let open_ms = t.elapsed().as_millis();
        let lines = doc.line_count();
        let t = std::time::Instant::now();
        let screen = doc.highlight_lines(0, 60);
        println!(
            "open={open_ms}ms lines={lines} symbols={} first_screen={:?}ms screen_lines={}",
            symbols.len(),
            t.elapsed().as_millis(),
            screen.len()
        );
    }

    use super::*;
    use std::io::Write;

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
        assert_eq!(opened.symbols[0].name, "main");
        assert_eq!(opened.syntax_name, "Rust");
        let lines = lines_impl(&state, opened.doc_id, 0, 3).unwrap();
        assert_eq!(lines.start_line, 0);
        assert_eq!(lines.lines[1].0, "    println!(\"hi\");");
        assert!(!lines.lines[1].1.is_empty(), "the body line carries tokens");
    }

    #[test]
    fn a_prewarmed_document_serves_its_open_once() {
        let s = scratch();
        let path = s.file("warm.rs", "fn warm() {}\n");
        prewarm(path.clone());
        let (doc, symbols) = take_prewarmed(&path).unwrap().unwrap();
        assert_eq!(symbols[0].name, "warm");
        assert_eq!(doc.syntax_name, "Rust");
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
        let (mut doc, _) = open_doc(&path).unwrap();
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
        state
            .with_doc(opened.doc_id, |doc| {
                std::fs::write(&doc.path, doc.full_text()).map_err(|e| e.to_string())
            })
            .unwrap()
            .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "one\nTWO\n");
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
