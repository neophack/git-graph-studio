//! The CAN Database commands' thin adapters (module 13's DBC half): every
//! #[tauri::command] the DBC view knows — the parsing and the frame decode live in the
//! ggs-dbc crate (open_doc, decode_message). This is the only DBC file that may name
//! tauri.

use std::path::Path;
use std::sync::Arc;

use ggs_dbc::{DbcDocument, DbcState, DecodedSignal};
use tauri::State;

/// The answer `dbc_open` carries: the whole document (a database is small — messages,
/// signals, value tables, comments) beside the session handle its decode panel reads
/// through.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbcOpenResult {
    pub doc_id: u32,
    #[serde(flatten)]
    pub doc: Arc<DbcDocument>,
}

/// Parses the database at `path` and registers it. One blocking read — the file is
/// small and the view has nothing to show before the messages exist.
#[tauri::command]
pub async fn dbc_open(path: String, state: State<'_, DbcState>) -> Result<DbcOpenResult, String> {
    let doc = ggs_dbc::open_doc(Path::new(&path))?;
    let doc_id = state.register(Arc::clone(&doc));
    Ok(DbcOpenResult { doc_id, doc })
}

/// Decodes one frame against the open database: the canonical id (any 0x80000000 flag
/// cleared by the caller's parse — a hex field's value past 0x7ff is extended here)
/// plus the payload bytes' hex, answered with every signal that fits the bytes.
#[tauri::command]
pub async fn dbc_decode(
    state: State<'_, DbcState>,
    doc_id: u32,
    id: u64,
    data_hex: String,
) -> Result<Vec<DecodedSignal>, String> {
    let doc = state
        .get(doc_id)
        .ok_or_else(|| "this CAN database was closed".to_string())?;
    let data = decode_hex(&data_hex)?;
    let (extended, id) = if id >= 0x8000_0000 {
        (true, (id & 0x1FFF_FFFF) as u32)
    } else if id > 0x7ff {
        (true, id as u32)
    } else {
        (false, id as u32)
    };
    let _ = extended;
    ggs_dbc::decode_message(&doc, id, &data).ok_or_else(|| {
        format!("no frame with id 0x{id:x} in this database, or no signal fits the bytes")
    })
}

/// Releases a database when its tab closes.
#[tauri::command]
pub fn dbc_close(state: State<'_, DbcState>, doc_id: u32) -> Result<(), String> {
    state.release(doc_id);
    Ok(())
}

/// A hex payload string ("17 28 00 …" — spaces optional) to bytes.
fn decode_hex(hex: &str) -> Result<Vec<u8>, String> {
    let cleaned: String = hex.chars().filter(|c| !c.is_whitespace()).collect();
    if cleaned.is_empty() {
        return Ok(Vec::new());
    }
    if !cleaned.len().is_multiple_of(2) {
        return Err("the payload needs whole byte pairs of hex digits".to_string());
    }
    (0..cleaned.len())
        .step_by(2)
        .map(|k| {
            u8::from_str_radix(&cleaned[k..k + 2], 16)
                .map_err(|_| format!("'{}' is not hex", &cleaned[k..k + 2]))
        })
        .collect()
}
