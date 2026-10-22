//! The symbol index command adapters (plan M4): the `#[tauri::command]` half over
//! ggs-index's per-root databases. Nothing loads on a folder open: the first symbol query
//! (`ensure_symbols`) resumes the saved index from `~/.ggs/index/` — or builds it when
//! none was saved — and the composition root's sweeper (`index_lease`) drops it from
//! memory once no query has touched it for a while; the disk copy stays current through
//! the watcher's per-file updates, so the next query only resumes it.
//! Progress reaches the frontend two ways: a `Channel` for the explicit rebuild command,
//! and the `studio://symbol-index` event for the on-demand builds (both through the
//! ggs-base push seams).

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use ggs_base::sink::BatchSink;
use ggs_index::scan::FileMatches;
use ggs_index::symbols::index::{
    references_for, tree_from, IndexStatus, SymbolIndex, SymbolIndexEvent, TreeFile,
};
use ggs_index::symbols::WorkspaceSymbol;

use ggs_base::workspace::WorkspaceRoots;

fn resolve_root(roots: &WorkspaceRoots, repo: Option<String>) -> Result<String, String> {
    repo.or_else(|| roots.first())
        .ok_or_else(|| "No folder is open".to_owned())
}

/// Make the root's symbol index resident — resumed or built now when it is not — off the
/// async runtime (a first build of a large tree takes a while). Every symbol query runs
/// it first; `workspace_symbols` / `find_references` (cmd_search) and the metrics report
/// (cmd_analysis) share it.
pub(crate) async fn ensure_symbols(
    app: &tauri::AppHandle,
    symbol_index: &Arc<SymbolIndex>,
    root: String,
) -> Result<(), String> {
    let index = Arc::clone(symbol_index);
    let sink = crate::events::TauriEvents(app.clone());
    tauri::async_runtime::spawn_blocking(move || index.ensure_blocking(Some(&sink), &root))
        .await
        .map_err(|e| e.to_string())?
}

/// The index state of the open folder: what the status bar shows. Never loads anything.
#[tauri::command]
pub async fn symbols_status(
    roots: State<'_, WorkspaceRoots>,
    symbol_index: State<'_, Arc<SymbolIndex>>,
    repo: Option<String>,
) -> Result<IndexStatus, String> {
    let root = resolve_root(roots.inner(), repo)?;
    Ok(symbol_index.status(&root))
}

/// Rebuild the symbol index from scratch (the status item's click).
/// Streams `progress` batches over the channel, then one `done`.
#[tauri::command]
pub async fn symbols_rebuild(
    roots: State<'_, WorkspaceRoots>,
    symbol_index: State<'_, Arc<SymbolIndex>>,
    repo: Option<String>,
    on_event: Channel<SymbolIndexEvent>,
) -> Result<IndexStatus, String> {
    let root = resolve_root(roots.inner(), repo)?;
    let index = Arc::clone(symbol_index.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut channel = crate::events::ChannelSink(on_event);
        let channel: Option<&mut dyn BatchSink<SymbolIndexEvent>> = Some(&mut channel);
        index.build_blocking(None, &root, channel)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Every declaration of exactly `name` — Go-to-Definition's index answer. An empty list is
/// a real answer (nothing declares it); the frontend falls back to its other heuristics.
#[tauri::command]
pub async fn symbol_lookup(
    app: tauri::AppHandle,
    roots: State<'_, WorkspaceRoots>,
    symbol_index: State<'_, Arc<SymbolIndex>>,
    name: String,
    repo: Option<String>,
) -> Result<Vec<WorkspaceSymbol>, String> {
    let root = resolve_root(roots.inner(), repo)?;
    ensure_symbols(&app, symbol_index.inner(), root.clone()).await?;
    Ok(symbol_index.lookup(&root, &name).unwrap_or_default())
}

/// The whole index as a per-file outline — the Symbol Database page renders it as a
/// collapsible tree (the MCP server drills per file through `file_symbols` instead).
#[tauri::command]
pub async fn symbol_tree(
    app: tauri::AppHandle,
    roots: State<'_, WorkspaceRoots>,
    symbol_index: State<'_, Arc<SymbolIndex>>,
    repo: Option<String>,
) -> Result<Vec<TreeFile>, String> {
    let root = resolve_root(roots.inner(), repo)?;
    ensure_symbols(&app, symbol_index.inner(), root.clone()).await?;
    let (symbols, counts) = symbol_index.symbols_with_refs(&root).unwrap_or_default();
    Ok(tree_from(symbols, |name| {
        counts.get(name).copied().unwrap_or(0)
    }))
}

/// Every whole-word occurrence of `name` in the workspace's code files — Find References'
/// raw material. The index's occurrence list narrows the scan to the files that contain the
/// word at all; for a name the list does not trust, the whole tree is scanned.
/// `find_references` (cmd_search) and this command are both that one implementation.
#[tauri::command]
pub async fn symbol_references(
    app: tauri::AppHandle,
    roots: State<'_, WorkspaceRoots>,
    symbol_index: State<'_, Arc<SymbolIndex>>,
    name: String,
    repo: Option<String>,
) -> Result<Vec<FileMatches>, String> {
    let root = resolve_root(roots.inner(), repo)?;
    ensure_symbols(&app, symbol_index.inner(), root.clone()).await?;
    references_for(&symbol_index, &root, &name)
}
