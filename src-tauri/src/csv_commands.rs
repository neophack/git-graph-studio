//! The Data Table commands' thin adapters (module 20): every #[tauri::command] the CSV
//! view knows — the blocking work itself lives in the ggs-csv crate (open_doc,
//! open_into_doc, count_of, rows_of, series_of). This is the only CSV file that may
//! name tauri.

use std::path::Path;
use std::sync::Arc;

use ggs_csv::{CsvCount, CsvOpenResult, CsvRowLine, CsvSeriesResult, CsvSort, CsvState};
use tauri::State;

/// Opens a CSV file for table browsing. The sniff reads the first kilobytes (delimiter,
/// header, column names) and the answer comes back at once; the walk streams the records
/// into the document in the background and the view polls `csv_count` while they land,
/// so the first rows are on screen long before a giant export finishes.
#[tauri::command]
pub async fn csv_open(
    path: String,
    state: tauri::State<'_, CsvState>,
) -> Result<CsvOpenResult, String> {
    let doc = ggs_csv::open_doc(Path::new(&path))?;
    let doc_id = state.register(Arc::clone(&doc));
    let walked = Arc::clone(&doc);
    tauri::async_runtime::spawn_blocking(move || {
        ggs_csv::open_into_doc(Path::new(&path), &walked);
    });
    Ok(CsvOpenResult {
        doc_id,
        total_bytes: doc.total_bytes(),
        delimiter: doc.delimiter().to_string(),
        has_header: doc.has_header(),
    })
}

/// A window of the document's rows, in natural or sorted order — only what the viewport
/// shows ever crosses the bridge. A range past the parsed prefix comes back short (or
/// empty). With a sort on, the window is of the sorted order and each line still numbers
/// its row in file order; the sorted order is computed (and memoized) on the blocking
/// pool like every other heavy pass in this module.
#[tauri::command]
pub async fn csv_rows(
    state: tauri::State<'_, CsvState>,
    doc_id: u32,
    start: usize,
    end: usize,
    sort: Option<CsvSort>,
) -> Result<Vec<CsvRowLine>, String> {
    let doc = state
        .get(doc_id)
        .ok_or_else(|| "this data table was closed".to_string())?;
    tauri::async_runtime::spawn_blocking(move || Ok(ggs_csv::rows_of(&doc, start, end, sort.as_ref())))
        .await
        .map_err(|e| e.to_string())?
}

/// How far the background walk has come — what the view polls to extend its scroll
/// range, where a parse failure surfaces once the walk ends, and where the columns (the
/// header's names and numeric flags) stand as they land.
#[tauri::command]
pub async fn csv_count(state: tauri::State<'_, CsvState>, doc_id: u32) -> Result<CsvCount, String> {
    let doc = state
        .get(doc_id)
        .ok_or_else(|| "this data table was closed".to_string())?;
    tauri::async_runtime::spawn_blocking(move || Ok(ggs_csv::count_of(&doc)))
        .await
        .map_err(|e| e.to_string())?
}

/// The plot's one read: every selected column as a decimated series over the chosen x
/// axis (`x` null = the row's own position), clipped to `xFrom`/`xTo` when the view is
/// zoomed. Runs on the blocking pool — a multi-million-row range is a walk, not a lookup.
#[tauri::command]
pub async fn csv_series(
    state: tauri::State<'_, CsvState>,
    doc_id: u32,
    x: Option<usize>,
    ys: Vec<usize>,
    x_from: Option<f64>,
    x_to: Option<f64>,
) -> Result<CsvSeriesResult, String> {
    let doc = state
        .get(doc_id)
        .ok_or_else(|| "this data table was closed".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let range = match (x_from, x_to) {
            (Some(from), Some(to)) => Some((from, to)),
            _ => None,
        };
        Ok(ggs_csv::series_of(&doc, x, &ys, range))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Releases a document's rows when its tab closes.
#[tauri::command]
pub fn csv_close(state: State<'_, CsvState>, doc_id: u32) -> Result<(), String> {
    state.release(doc_id);
    Ok(())
}
