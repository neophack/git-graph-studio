//! The CAN commands' thin adapters (module 13): every #[tauri::command] the frontend
//! knows — the blocking work itself lives in the ggs-can crate, reached over the
//! ProgressReporter callback and the pure cores (stats_of, intervals_of, convert_log,
//! open_into_doc, frames_of, count_of, find_of). This is the only CAN file that may
//! name tauri.

use std::path::Path;
use std::sync::Arc;

use ggs_can::{CanFindResult, CanFrameFilter, CanFrameLine, CanIntervals, CanLogCount,
    CanLogState, CanLogStats, CanOpenResult, CanProgress};
use tauri::ipc::Channel;

/// The statistics of a `.blf` or `.asc` CAN log on disk. The walk runs on the blocking
/// pool (it is pure IO and can run for minutes on a giant log) and reports progress over
/// `onProgress`; the view paints immediately and fills in when this resolves.
#[tauri::command]
pub async fn can_log_stats(
    path: String,
    on_progress: tauri::ipc::Channel<CanProgress>,
) -> Result<CanLogStats, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut reporter = ggs_can::ProgressReporter::reporting(
            ggs_can::total_bytes_of(Path::new(&path)),
            move |p| {
                let _ = on_progress.send(p);
            },
        );
        ggs_can::stats_of(Path::new(&path), &mut reporter)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// The periodic-message analysis of one identifier on one channel: cycle statistics
/// (median/avg/min/max, the standard deviation as the jitter figure), the missing-frame
/// check over every interval, and the chart series downsampled to ≤ 4096 points. The whole
/// file is walked in Rust on the blocking pool; only the series and the numbers cross
/// the bridge.
#[tauri::command]
pub async fn can_intervals(
    path: String,
    channel: u16,
    id: u32,
    extended: bool,
    on_progress: tauri::ipc::Channel<CanProgress>,
) -> Result<CanIntervals, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut reporter = ggs_can::ProgressReporter::reporting(
            ggs_can::total_bytes_of(Path::new(&path)),
            move |p| {
                let _ = on_progress.send(p);
            },
        );
        ggs_can::intervals_of(Path::new(&path), channel, id, extended, &mut reporter)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Convert a CAN log between BLF and ASC (or into its own format), frame for frame: every
/// CAN, CAN FD, remote and error frame of the source is written to the target in the
/// target's exact CANoe layout. Runs on the blocking pool with progress reports; returns
/// the frames written.
#[tauri::command]
pub async fn convert_can_log(
    from: String,
    to: String,
    format: String,
    on_progress: Channel<CanProgress>,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let from_path = Path::new(&from);
        let mut reporter = ggs_can::ProgressReporter::reporting(
            ggs_can::total_bytes_of(from_path),
            move |p| {
                let _ = on_progress.send(p);
            },
        );
        ggs_can::convert_log(from_path, Path::new(&to), &format, &mut reporter)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Opens a CAN log for raw browsing. The parse itself is a detached background walk — this
/// returns as soon as the document exists, and the view polls `can_log_count` while the
/// frames accumulate, so the first rows are on screen long before a giant log finishes.
#[tauri::command]
pub async fn can_log_open(
    path: String,
    state: tauri::State<'_, CanLogState>,
) -> Result<CanOpenResult, String> {
    let total_bytes = ggs_can::total_bytes_of(Path::new(&path));
    let doc = Arc::new(ggs_can::CanLogDoc::new(total_bytes));
    let doc_id = state.register(Arc::clone(&doc));
    tauri::async_runtime::spawn_blocking(move || {
        ggs_can::open_into_doc(Path::new(&path), &doc);
    });
    Ok(ggs_can::CanOpenResult {
        doc_id,
        total_bytes,
    })
}
/// A window of the document's frames, in log order — only what the viewport shows ever
/// crosses the bridge. A range past the parsed prefix comes back short (or empty). With a
/// filter, the window is of the frames that pass it and each line still numbers its frame
/// in the whole log; the first application of a filter walks the parsed prefix once, so
/// this runs on the blocking pool like every other heavy walk in this module.
#[tauri::command]
pub async fn can_log_frames(
    state: tauri::State<'_, CanLogState>,
    doc_id: u32,
    start: usize,
    end: usize,
    filter: Option<CanFrameFilter>,
) -> Result<Vec<CanFrameLine>, String> {
    let doc = state
        .get(doc_id)
        .ok_or_else(|| "this log view was closed".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(ggs_can::frames_of(&doc, start, end, filter.as_ref()))
    })
    .await
    .map_err(|e| e.to_string())?
}
/// How far the background walk has come — what the raw view polls to extend its scroll
/// range, and where a parse failure surfaces once the walk ends. The optional filter makes
/// the same poll report the filtered row count (`matched`) and refresh the cached match
/// index as the walk lands more batches.
#[tauri::command]
pub async fn can_log_count(
    state: tauri::State<'_, CanLogState>,
    doc_id: u32,
    filter: Option<CanFrameFilter>,
) -> Result<CanLogCount, String> {
    let doc = state
        .get(doc_id)
        .ok_or_else(|| "this log view was closed".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(ggs_can::count_of(&doc, filter.as_ref()))
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Find in the raw log — the raw view's search bar (Ctrl+F): every frame whose id or
/// payload matches the hex query, in log order, as positions of the current row space (a
/// filter on means only its frames are searched, and the positions address the filtered
/// rows the view scrolls). One bounded pass over the columns on the blocking pool.
#[tauri::command]
pub async fn can_log_find(
    state: tauri::State<'_, CanLogState>,
    doc_id: u32,
    query: String,
    filter: Option<CanFrameFilter>,
) -> Result<CanFindResult, String> {
    let doc = state
        .get(doc_id)
        .ok_or_else(|| "this log view was closed".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        ggs_can::find_of(&doc, &query, filter.as_ref())
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Releases a raw-log document's frames when its tab closes.
#[tauri::command]
pub fn can_log_close(state: tauri::State<'_, CanLogState>, doc_id: u32) -> Result<(), String> {
    state.release(doc_id);
    Ok(())
}