//! The viewer commands' thin adapters (modules 6/7): the #[tauri::command]s whose
//! bodies orchestrate ggs-text's session table — the blocking work, the rope, the
//! highlight checkpoints, the indexed viewer's windows all live in the ggs-text crate.
//! This is the only viewer file that may name tauri.

use std::fs::File;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use ggs_text::viewer::doc;
use ggs_text::viewer::find::{FindOptions, Matcher};
use ggs_text::viewer::indexed::*;

use ggs_text::viewer::*;

/// Open a file in the viewer. The head — read, decoded and roped synchronously — is what
/// this returns, tens of milliseconds whatever the file's size; the rest of a huge file
/// appends on a background thread, and the `studio://viewer-lines` event delivers the exact
/// line count when it lands. Highlighting stays lazy (per window via `viewer_lines`), and
/// so does the outline (`viewer_symbols` on demand).
#[tauri::command]
pub async fn viewer_open(
    state: tauri::State<'_, ggs_text::viewer::ViewerState>,
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
        ggs_text::viewer::spawn_tail(
            &handle,
            Some(Arc::new(crate::events::TauriEvents(app)) as Arc<dyn ggs_base::sink::EventSink>),
            doc_id,
            path,
            from,
            total,
        );
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
    state: tauri::State<'_, ggs_text::viewer::ViewerState>,
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
    state: tauri::State<'_, ggs_text::viewer::ViewerState>,
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

/// Apply one replacement to the document's rope. Positions are 0-based line + code-point
/// columns (the frontend converts its UTF-16 offsets before sending). Off the main thread
/// like `viewer_find`: the whole-rope scan a find runs holds the document lock, and a sync
/// edit must queue on the blocking pool for it — never stall the window's UI waiting.
#[tauri::command]
pub async fn viewer_edit(
    state: tauri::State<'_, ggs_text::viewer::ViewerState>,
    doc_id: u64,
    start_line: usize,
    start_col: usize,
    end_line: usize,
    end_col: usize,
    text: String,
) -> Result<EditResult, String> {
    state.stop_warming(doc_id);
    let handle = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        edit_handle(&handle, start_line, start_col, end_line, end_col, &text)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write a viewer document back to disk, reporting progress over `on_progress` as the rope
/// streams out — a multi-hundred-megabyte Ctrl+S takes seconds, and the status bar's bar is
/// how the user knows it is moving. The encode and write run on the blocking pool — the UI
/// must not freeze the way it did when the whole document crossed the IPC as one JSON string.
/// `encoding` / `eol` are the Save-with-Encoding / EOL pick the tab passes: they override
/// the document's own for this write (resolved in the crate's `save_plan`, adopted by its
/// `save_adopt`).
#[tauri::command]
pub async fn viewer_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, ggs_text::viewer::ViewerState>,
    doc_id: u64,
    encoding: Option<String>,
    eol: Option<String>,
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
    let (path, encoding, eol, rope, saved_rope) = save_plan(&state, doc_id, encoding, eol)?;
    // The choice survives the blocking pass for the adoption below.
    let write_encoding = encoding.clone();
    let write_eol = eol.clone();
    let stamp = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let progress = move |written: u64, total: u64| {
            let _ = on_progress.send(SaveProgress { written, total });
        };
        write_doc(&path, &rope, &write_encoding, &write_eol, &progress)?;
        // The stamp the file now carries, so the save's own watcher echo reads as "unchanged".
        Ok(fingerprint(&path))
    })
    .await
    .map_err(|e| e.to_string())??;
    save_adopt(&state, doc_id, encoding, eol, saved_rope, stamp);
    // Match write_file: a saved (possibly new) file must show up in Quick Open and search.
    use tauri::Manager;
    app.state::<std::sync::Arc<ggs_fs::FileListCache>>()
        .invalidate();
    Ok(())
}

/// Reload the document when its file changed on disk; a save's own watcher echo (the stamp
/// matches what was written) reports `changed: false` and leaves the document untouched —
/// cursor, undo stack and all.
#[tauri::command]
pub async fn viewer_reload(
    state: tauri::State<'_, ggs_text::viewer::ViewerState>,
    app: tauri::AppHandle,
    doc_id: u64,
) -> Result<ReloadResult, String> {
    let (path, stamp) =
        state.with_doc(doc_id, |doc| (doc.path.clone(), doc.fingerprint.clone()))?;
    if fingerprint(&path) == stamp {
        return Ok(ReloadResult {
            changed: false,
            line_count: 0,
            // No swap: the generation the document currently serves, so the caller's
            // baseline stays truthful either way.
            gen: state
                .doc_handle(doc_id)
                .map(|h| h.gen.load(Ordering::Relaxed))
                .unwrap_or(0),
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
    // back as a document nobody will ever close again. The swap keeps the id and advances
    // the reload generation (`ViewerState::replace_doc`), so any window read that cloned
    // the old handle names a generation the frontend has since been told past — its
    // response is dropped instead of written (`docEditView`'s gen baseline).
    let (generation, handle) = state.replace_doc(doc_id, doc, None)?;
    if let Some((from, total)) = tail {
        ggs_text::viewer::spawn_tail(
            &handle,
            Some(Arc::new(crate::events::TauriEvents(app))
                as Arc<dyn ggs_base::sink::EventSink>),
            doc_id,
            path.display().to_string(),
            from,
            total,
        );
    }
    Ok(ReloadResult {
        changed: true,
        line_count,
        gen: generation,
    })
}

/// A window of lines as plain text (0-based, inclusive), for the editable windowed editor.
/// Off the main thread like `viewer_lines`: the same rope reads, the same latency spikes.
/// Lines the rope does not hold yet (a huge file's tail still building) wait for the
/// landing — the head's window never does.
#[tauri::command]
pub async fn viewer_text(
    state: tauri::State<'_, ggs_text::viewer::ViewerState>,
    doc_id: u64,
    start: usize,
    end: usize,
) -> Result<TextResult, String> {
    check_window(start, end)?;
    let doc = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    // The reload generation the window serves against, read with the clone: however long
    // the read runs, the response names exactly what it served — and a `viewer_reload`
    // swapping the document meanwhile (same id, next generation) is the frontend's to
    // drop, so a predecessor's rows are never written into the editor.
    let generation = doc.gen.load(Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        ensure_lines(&doc, start)?;
        let mut doc = doc
            .doc
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(text_of(&mut doc, start, end, generation))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Find every (single-line) match of a query over a whole document. The scan runs on the
/// blocking pool — a 200 MB rope takes a moment — and aborts as soon as a newer find on
/// the same document supersedes it, so typing in the widget never queues stale scans.
#[tauri::command]
pub async fn viewer_find(
    state: tauri::State<'_, ggs_text::viewer::ViewerState>,
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
    // still holds. `served` is the reload generation the scan runs against: a reload (or a
    // close) during the walk — the tail wait alone can hold it for seconds — makes the
    // matches a predecessor's, and the response is refused below.
    let generation = handle.find_gen.fetch_add(1, Ordering::Relaxed) + 1;
    let served = handle.gen.load(Ordering::Relaxed);
    let result = tauri::async_runtime::spawn_blocking(move || {
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
    .map_err(|e| e.to_string())?;
    // The scan is stale when the slot no longer holds the handle it served: refuse with
    // the supersede marker the find widget already drops silently (a newer find or a
    // refresh rescans the current document).
    let current = state
        .doc_handle(doc_id)
        .map(|h| h.gen.load(Ordering::Relaxed));
    if current != Some(served) {
        return Err("superseded".to_owned());
    }
    result
}

/// Replace the next `max` matches of a query from a 0-based line/column position — `1` is
/// the widget's Replace (the position is its current match), `usize::MAX` its Replace All.
/// Every replacement lands in the rope as one undo step, so a Replace All is a single Ctrl+Z.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // the find options mirror viewer_find's, plus the replace spec
pub async fn viewer_replace(
    state: tauri::State<'_, ggs_text::viewer::ViewerState>,
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

/// Keep a windowed editor's unsaved buffer for hot exit. The backend writes the backup
/// itself, so a hundred-megabyte draft never crosses the IPC — the JSON path the full
/// editor takes would freeze the webview on documents this large.
#[tauri::command]
pub async fn viewer_backup(
    state: tauri::State<'_, ggs_text::viewer::ViewerState>,
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
    let dir = ggs_base::paths::backups_home()?;
    tauri::async_runtime::spawn_blocking(move || ggs_text::backup::write_into(&dir, &path, text))
        .await
        .map_err(|e| e.to_string())?
}

/// The document's outline, computed on demand (the open path no longer pays for it). The
/// scan runs on the blocking pool over a snapshot clone of the rope — ropey clones share
/// chunks — so the document lock is held only for the clone and a window fetch never queues
/// behind a whole-file outline pass.
#[tauri::command]
pub async fn viewer_symbols(
    state: tauri::State<'_, ggs_text::viewer::ViewerState>,
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

/// Undo the most recent edit. `None` when there is nothing to undo. Off the main thread
/// like `viewer_edit`: the document lock it takes must queue behind a running find on the
/// blocking pool, not on the window's UI.
#[tauri::command]
pub async fn viewer_undo(
    state: tauri::State<'_, ggs_text::viewer::ViewerState>,
    doc_id: u64,
) -> Result<Option<UndoResult>, String> {
    state.stop_warming(doc_id);
    let handle = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut doc = handle
            .doc
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match doc.undo() {
            Some((first_line, line_count)) => Ok(Some(UndoResult {
                first_line,
                line_count,
                clean: doc.at_saved_state(),
            })),
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Redo the most recently undone edit. `None` when there is nothing to redo. Async like
/// `viewer_undo`, for the same lock-vs-find reason.
#[tauri::command]
pub async fn viewer_redo(
    state: tauri::State<'_, ggs_text::viewer::ViewerState>,
    doc_id: u64,
) -> Result<Option<UndoResult>, String> {
    state.stop_warming(doc_id);
    let handle = state
        .doc_handle(doc_id)
        .ok_or_else(|| format!("No open document {doc_id}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut doc = handle
            .doc
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match doc.redo() {
            Some((first_line, line_count)) => Ok(Some(UndoResult {
                first_line,
                line_count,
                clean: doc.at_saved_state(),
            })),
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drop a document (its tab closed). The warmer holds its own `Arc` to the handle, so the
/// generation bump is what tells it to stop parsing against a document nobody reads.
#[tauri::command]
pub fn viewer_close(state: tauri::State<ggs_text::viewer::ViewerState>, doc_id: u64) {
    let mut docs = state
        .docs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(handle) = docs.remove(&doc_id) {
        handle.warm_gen.fetch_add(1, Ordering::Relaxed);
    }
}

/// Open a file for indexed viewing: read and decode the head (the first screens, served
/// immediately), extrapolate the scrollbar's line count, and build the exact index in the
/// background. The landing emits `studio://viewer-lines` with the exact count.
#[tauri::command]
pub async fn indexed_open(
    state: tauri::State<'_, ggs_text::viewer::indexed::IndexedState>,
    app: tauri::AppHandle,
    path: String,
) -> Result<IndexedOpenResult, String> {
    let doc_id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let load = path.clone();
    let opened = tauri::async_runtime::spawn_blocking(move || open_indexed(&load))
        .await
        .map_err(|e| e.to_string())??;
    let IndexedHead {
        total,
        encoding,
        eol,
        head_bytes,
        head_text,
        bom,
    } = opened;
    let language = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    let syntax_name = doc::syntax_name_for(&language);
    let head_lines = head_text.split('\n').count().max(1);
    let per_line = (head_bytes / head_lines as u64).max(1);
    let estimate = head_lines + ((total - head_bytes) / per_line) as usize;
    let gate = TailGate::pending();
    let document = Arc::new(IndexedDoc {
        path: path.clone(),
        total,
        encoding: encoding.clone(),
        head_text,
        file: Mutex::new(None),
        estimate: estimate.max(head_lines),
        index: RwLock::new(None),
        error: Mutex::new(None),
        gate: Arc::clone(&gate),
        find_gen: AtomicU64::new(0),
    });
    state
        .docs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(doc_id, Arc::clone(&document));
    let result = IndexedOpenResult {
        doc_id,
        line_count: document.line_count(),
        language,
        syntax_name,
        encoding,
        eol,
    };
    // The exact index builds in the background; the head serves meanwhile.
    let scan_path = path.clone();
    let scan_from = bom;
    let utf16 = utf16_of(&document.encoding);
    let scan_doc = Arc::clone(&document);
    let scan_gate = Arc::clone(&gate);
    let spawned = std::thread::Builder::new()
        .name("indexed-scan".to_owned())
        .spawn(move || {
            let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                build_index(&scan_path, scan_from, scan_doc.total, utf16, scan_from)
            }));
            let mut landed = None;
            match built {
                Ok(Ok(index)) => {
                    let count = index.line_count();
                    *scan_doc
                        .index
                        .write()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::new(index));
                    landed = Some(count);
                }
                Ok(Err(error)) => {
                    *scan_doc
                        .error
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error);
                }
                Err(_) => {
                    *scan_doc
                        .error
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                        Some("the index build panicked".to_owned());
                }
            }
            scan_gate.land();
            if let Some(count) = landed {
                use tauri::Emitter;
                let _ = app.emit(
                    "studio://viewer-lines",
                    LinesLanded {
                        doc_id,
                        line_count: count,
                    },
                );
            }
        });
    if spawned.is_err() {
        *document
            .error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
            Some("the index build could not start".to_owned());
        gate.land();
    }
    Ok(result)
}

/// The lines a window asked for — the fast viewer's fetch. `end` is inclusive.
#[tauri::command]
pub async fn indexed_lines(
    state: tauri::State<'_, ggs_text::viewer::indexed::IndexedState>,
    doc_id: u64,
    start: usize,
    end: usize,
) -> Result<IndexedLinesResult, String> {
    let doc = state.get(doc_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let line_count = doc.line_count();
        let lines = doc.window(start, end)?;
        Ok(IndexedLinesResult {
            start_line: start.min(line_count.max(1) - 1),
            line_count,
            lines: lines.into_iter().map(|text| (text, Vec::new())).collect(),
            tokens_pending: false,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The streamed line scan behind `indexed_find`: chunks read off the disk, complete lines
/// fed to the same matcher the rope viewer uses. One line is one number: a monster line
/// (past `LINE_CAP`, dropped rather than buffered whole) takes its number when its
/// trailing newline arrives, so every later match's line stays true to LineIndex's count.
/// Returns the matches (0-based lines, code-point columns) and whether the cap cut the
/// list short. `still_current` is the supersede check between chunks.
fn scan_indexed_matches(
    path: &std::path::Path,
    matcher: &Matcher,
    whole_word: bool,
    still_current: impl Fn() -> bool,
) -> Result<(Vec<MatchLoc>, bool), String> {
    const CHUNK: usize = 4 << 20;
    const LINE_CAP: usize = 4 << 20;
    let mut file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut matches: Vec<MatchLoc> = Vec::new();
    let mut capped = false;
    let mut carried: Vec<u8> = Vec::new();
    let mut line_no = 0usize;
    let mut chunk = vec![0u8; CHUNK];
    loop {
        let read = file
            .read(&mut chunk)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        if !still_current() {
            return Err("superseded".to_owned());
        }
        carried.extend_from_slice(&chunk[..read]);
        let mut from = 0usize;
        while let Some(hit) = memchr::memchr(b'\n', &carried[from..]) {
            let line_end = from + hit;
            let text = String::from_utf8_lossy(&carried[from..line_end]);
            for (start, end) in matcher.matches_in(&text, whole_word) {
                if matches.len() >= find::MAX_FIND_MATCHES {
                    capped = true;
                    break;
                }
                matches.push(MatchLoc {
                    line: line_no,
                    start_col: start,
                    end_col: end,
                });
            }
            line_no += 1;
            from = line_end + 1;
        }
        carried.drain(..from);
        if carried.len() > LINE_CAP {
            // A monster line: drop the buffer, its matches are not worth the memory. The
            // line's own number lands with its newline — counting it here too made one
            // such line consume two numbers and drift every later match.
            carried.clear();
        }
    }
    if !carried.is_empty() {
        let text = String::from_utf8_lossy(&carried);
        for (start, end) in matcher.matches_in(&text, whole_word) {
            if matches.len() >= find::MAX_FIND_MATCHES {
                capped = true;
                break;
            }
            matches.push(MatchLoc {
                line: line_no,
                start_col: start,
                end_col: end,
            });
        }
    }
    Ok((matches, capped))
}

/// Find over the whole file by streaming it: chunks read off the disk, whole lines fed to
/// the same matcher the rope viewer uses. A newer find on the same document supersedes the
/// walk between chunks. A line past the cap is skipped rather than buffered whole.
#[tauri::command]
pub async fn indexed_find(
    state: tauri::State<'_, ggs_text::viewer::indexed::IndexedState>,
    doc_id: u64,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regexp: bool,
) -> Result<IndexedFindResult, String> {
    let doc = state.get(doc_id)?;
    let generation = doc.find_gen.fetch_add(1, Ordering::Relaxed) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        doc.wait_index()?;
        let matcher = Matcher::compile(
            &query,
            &FindOptions {
                case_sensitive,
                whole_word,
                regexp,
            },
        )?;
        let still_current = || doc.find_gen.load(Ordering::Relaxed) == generation;
        let (matches, capped) = scan_indexed_matches(
            std::path::Path::new(&doc.path),
            &matcher,
            whole_word,
            still_current,
        )?;
        Ok(IndexedFindResult {
            matches,
            capped,
            line_count: doc.line_count(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drop an indexed document (its tab closed).
#[tauri::command]
pub fn indexed_close(state: tauri::State<ggs_text::viewer::indexed::IndexedState>, doc_id: u64) {
    let mut docs = state
        .docs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(doc) = docs.get(&doc_id) {
        doc.find_gen.fetch_add(1, Ordering::Relaxed);
    }
    docs.remove(&doc_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory unique to this test process, fresh per call. The caller cleans
    /// it up; tests must not depend on anything outside it.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ggs-viewer-commands-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn indexed_find_counts_a_monster_line_once() {
        // One line spanning two full chunk reads plus change, then a match on the next
        // line: the monster consumes one line number — when its newline arrives — so the
        // match sits on line 1, exactly where LineIndex puts it. Counting the dropped
        // buffer too made one such line eat two numbers and drift every later match.
        let dir = scratch("monster-line");
        let path = dir.join("monster.log");
        let monster = "x".repeat((4 << 20) * 2 + 16);
        std::fs::write(&path, format!("{monster}\nneedle here\n")).unwrap();
        let matcher = Matcher::compile(
            "needle",
            &FindOptions {
                case_sensitive: true,
                whole_word: false,
                regexp: false,
            },
        )
        .unwrap();
        let (matches, capped) = scan_indexed_matches(&path, &matcher, false, || true).unwrap();
        assert!(!capped);
        assert_eq!(
            matches,
            vec![MatchLoc {
                line: 1,
                start_col: 0,
                end_col: 6,
            }]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn indexed_find_reports_a_trailing_line_without_newline() {
        let dir = scratch("trailing-line");
        let path = dir.join("tail.log");
        std::fs::write(&path, "first needle\nlast needle").unwrap();
        let matcher = Matcher::compile(
            "needle",
            &FindOptions {
                case_sensitive: true,
                whole_word: false,
                regexp: false,
            },
        )
        .unwrap();
        let (matches, capped) = scan_indexed_matches(&path, &matcher, false, || true).unwrap();
        assert!(!capped);
        assert_eq!(
            matches.iter().map(|m| m.line).collect::<Vec<_>>(),
            vec![0, 1]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
