//! The ELF Inspector commands' thin adapters (module 21): every #[tauri::command] the
//! ELF view knows — the parsing and the symbol windows live in the ggs-elf crate
//! (open_doc, symbols_of). This is the only ELF file that may name tauri.

use std::path::Path;
use std::sync::Arc;

use ggs_elf::{ElfState, SymbolWindow};
use tauri::State;

/// The answer `elf_open` carries: the image's summary (header, segments, sections,
/// footprint sums) beside the session handle its symbol table reads through.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElfOpenResult {
    pub doc_id: u32,
    #[serde(flatten)]
    pub doc: Arc<ggs_elf::ElfDocument>,
}

/// Parses the image at `path` and registers it. One blocking read — a firmware image
/// is read whole (the crate refuses past 256 MiB) and the view has nothing to show
/// before the sections exist.
#[tauri::command]
pub async fn elf_open(path: String, state: State<'_, ElfState>) -> Result<ElfOpenResult, String> {
    let doc = ggs_elf::open_doc(Path::new(&path))?;
    let doc_id = state.register(Arc::clone(&doc));
    Ok(ElfOpenResult { doc_id, doc })
}

/// A window of the symbol table in the document's order (largest first), narrowed by a
/// case-insensitive substring filter — the answer names the filtered total, which is
/// the scroll range's length.
#[tauri::command]
pub async fn elf_symbols(
    state: State<'_, ElfState>,
    doc_id: u32,
    start: usize,
    end: usize,
    filter: Option<String>,
) -> Result<SymbolWindow, String> {
    let doc = state
        .get(doc_id)
        .ok_or_else(|| "this ELF image was closed".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(ggs_elf::symbols_of(&doc, start, end, filter.as_deref()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Releases an image when its tab closes.
#[tauri::command]
pub fn elf_close(state: State<'_, ElfState>, doc_id: u32) -> Result<(), String> {
    state.release(doc_id);
    Ok(())
}
