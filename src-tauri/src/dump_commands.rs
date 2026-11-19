//! The Memory Dump Viewer commands' thin adapters (module 21): every #[tauri::command]
//! the dump view knows — the open, the streamed carve scan, the byte preview, the
//! extract and the cancel. The blocking work itself lives in the ggs-dmp crate (Dump::
//! open, carve::scan, extract_all). This is the only dump file that may name tauri.

use std::path::Path;

use base64::Engine as _;
use ggs_dmp::{
    DumpEvent, DumpExtractResult, DumpOverview, DumpScanOptions, DumpScanStart, DumpState,
    ExtractProgress, ExtractRequest,
};
use tauri::ipc::Channel;
use tauri::State;

/// The preview's answer: up to `maxBytes` bytes of a carved entry as base64 — the
/// bridge's compact binary shape, where a JSON number array would be four times the
/// size — and whether the entry was longer than what crossed.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpPreview {
    pub data: String,
    pub truncated: bool,
    pub total_size: u64,
}

/// Opens a minidump: the header, stream table, module list and memory map in one pass —
/// a few kilobytes of reads, answered at once, long before any scan runs.
#[tauri::command]
pub async fn dump_open(path: String) -> Result<DumpOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dump = ggs_dmp::Dump::open(Path::new(&path))?;
        dump.overview(Path::new(&path))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The carve scan over the dump's memory regions. The module list and the byte total
/// come back with the answer; the carved entries stream over `on_event` (progress every
/// few megabytes, batches as they are found, one done) and a newer scan — or
/// `dump_cancel` — retires the running one.
#[tauri::command]
pub async fn dump_scan(
    path: String,
    options: Option<DumpScanOptions>,
    on_event: Channel<DumpEvent>,
    state: State<'_, DumpState>,
) -> Result<DumpScanStart, String> {
    let options = options.unwrap_or_default();
    let cancel = std::sync::Arc::clone(&state.cancel);
    tauri::async_runtime::spawn_blocking(move || {
        let generation = cancel.next();
        let mut sink = crate::events::ChannelSink(on_event);
        ggs_dmp::carve::scan(
            Path::new(&path),
            &options,
            &|| !cancel.is_current(generation),
            &mut sink,
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|(start, _outcome)| start)
}

/// Reads up to `max_bytes` of a carved entry (or any byte range of the dump) for the
/// preview pane — image bytes for a thumbnail, a text head, a hex head.
#[tauri::command]
pub async fn dump_preview(
    path: String,
    offset: u64,
    size: u64,
    max_bytes: Option<u32>,
) -> Result<DumpPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cap = u64::from(max_bytes.unwrap_or(512 * 1024)).min(4 * 1024 * 1024);
        let want = size.min(cap) as usize;
        use std::io::{Read, Seek, SeekFrom};
        let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; want];
        let mut filled = 0;
        while filled < buf.len() {
            match file.read(&mut buf[filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(e) => return Err(e.to_string()),
            }
        }
        buf.truncate(filled);
        Ok(DumpPreview {
            data: base64::engine::general_purpose::STANDARD.encode(&buf),
            truncated: (buf.len() as u64) < size,
            total_size: size,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Extracts the selected entries (carved files flat, rebuilt modules under `modules/`)
/// into `out_dir`, streaming one progress event per item. A newer extract — or a scan —
/// retires the running one; a failed item is recorded per item, the rest carry on.
#[tauri::command]
pub async fn dump_extract(
    path: String,
    entries: Vec<ExtractRequest>,
    out_dir: String,
    on_progress: Channel<ExtractProgress>,
    state: State<'_, DumpState>,
) -> Result<DumpExtractResult, String> {
    let cancel = std::sync::Arc::clone(&state.cancel);
    tauri::async_runtime::spawn_blocking(move || {
        let generation = cancel.next();
        let mut sink = crate::events::ChannelSink(on_progress);
        ggs_dmp::extract_all(
            Path::new(&path),
            &entries,
            Path::new(&out_dir),
            &|| !cancel.is_current(generation),
            &mut sink,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Retires whatever scan or extract is current.
#[tauri::command]
pub fn dump_cancel(state: State<'_, DumpState>) -> Result<(), String> {
    state.cancel.cancel();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The events cross the Channel as JSON, and the view reads `elapsedMs` — serde's
    /// enum-level `rename_all` names the variants alone, so the `Done` variant carries
    /// its own field casing. This pins the wire shape the frontend's `DumpEvent` type
    /// is typed against (the "用时 NaNs" regression, 2026-11-15).
    #[test]
    fn the_done_event_crosses_the_wire_with_camel_case_fields() {
        let json = serde_json::to_value(DumpEvent::Done {
            entries: 12,
            elapsed_ms: 3200,
            cancelled: false,
        })
        .expect("serialize");
        assert_eq!(json["kind"], "done");
        assert_eq!(json["entries"], 12);
        assert_eq!(
            json["elapsedMs"], 3200,
            "the view reads elapsedMs, never elapsed_ms"
        );
        assert_eq!(json["cancelled"], false);
        let progress = serde_json::to_value(DumpEvent::Progress {
            scanned: 1,
            total: 2,
            entries: 3,
        })
        .expect("serialize");
        assert_eq!(progress["kind"], "progress");
    }
}
