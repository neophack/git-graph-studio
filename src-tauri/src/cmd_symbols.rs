//! The symbol index command adapters (plan M4): the `#[tauri::command]` half over
//! ggs-index's per-root databases. A folder open resumes the saved index from
//! `~/.ggs/index/` (the composition root's `start_root_services` starts it), watcher
//! batches update single files, and the queries answer from the database — with the
//! in-memory rebuild (ggs-index's cache) still the fallback when no index has landed.
//! Progress reaches the frontend two ways: a `Channel` for the explicit rebuild command,
//! and the `studio://symbol-index` event for the background builds (both through the
//! ggs-base push seams).


use tauri::ipc::Channel;
use tauri::State;

use ggs_base::sink::BatchSink;
use ggs_index::symbols::cache::cached_symbols;
use ggs_index::symbols::index::{
    references_for, tree_from, IndexStatus, SymbolIndexEvent, TreeFile,
};
use ggs_index::symbols::WorkspaceSymbol;
use ggs_index::scan::FileMatches;

use ggs_base::workspace::WorkspaceRoots;

fn resolve_root(roots: &WorkspaceRoots, repo: Option<String>) -> Result<String, String> {
    repo.or_else(|| roots.first())
        .ok_or_else(|| "No folder is open".to_owned())
}

/// The index state of the open folder: what the status bar shows.
#[tauri::command]
pub async fn symbols_status(
    roots: State<'_, WorkspaceRoots>,
    symbol_index: State<'_, std::sync::Arc<ggs_index::symbols::index::SymbolIndex>>,
    repo: Option<String>,
) -> Result<IndexStatus, String> {
    let root = resolve_root(roots.inner(), repo)?;
    Ok(symbol_index.status(&root))
}

/// Rebuild the symbol index from scratch (also what a first open does in the background).
/// Streams `progress` batches over the channel, then one `done`.
#[tauri::command]
pub async fn symbols_rebuild(
    roots: State<'_, WorkspaceRoots>,
    symbol_index: State<'_, std::sync::Arc<ggs_index::symbols::index::SymbolIndex>>,
    repo: Option<String>,
    on_event: Channel<SymbolIndexEvent>,
) -> Result<IndexStatus, String> {
    let root = resolve_root(roots.inner(), repo)?;
    let index = std::sync::Arc::clone(symbol_index.inner());
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
    roots: State<'_, WorkspaceRoots>,
    symbol_index: State<'_, std::sync::Arc<ggs_index::symbols::index::SymbolIndex>>,
    name: String,
    repo: Option<String>,
) -> Result<Vec<WorkspaceSymbol>, String> {
    let root = resolve_root(roots.inner(), repo)?;
    Ok(symbol_index.lookup(&root, &name).unwrap_or_default())
}

/// The whole index as a per-file outline — the Symbol Database page renders it as a
/// collapsible tree (the MCP server drills per file through `file_symbols` instead).
#[tauri::command]
pub async fn symbol_tree(
    roots: State<'_, WorkspaceRoots>,
    symbol_index: State<'_, std::sync::Arc<ggs_index::symbols::index::SymbolIndex>>,
    symbol_cache: State<'_, std::sync::Arc<ggs_index::symbols::cache::SymbolCache>>,
    repo: Option<String>,
) -> Result<Vec<TreeFile>, String> {
    let root = resolve_root(roots.inner(), repo)?;
    if let Some((symbols, counts)) = symbol_index.symbols_with_refs(&root) {
        return Ok(tree_from(symbols, |name| {
            counts.get(name).copied().unwrap_or(0)
        }));
    }
    // No index yet: the in-memory rebuild serves the outline without occurrence counts.
    let all = cached_symbols(&root, symbol_cache.inner());
    Ok(tree_from(all, |_| 0))
}

/// Every whole-word occurrence of `name` in the workspace's code files — Find References'
/// raw material. The index's occurrence list narrows the scan to the files that contain the
/// word at all; without one (or for a name the list does not trust), the whole tree is
/// scanned. `find_references` (cmd_search) and this command are both that one implementation.
#[tauri::command]
pub async fn symbol_references(
    roots: State<'_, WorkspaceRoots>,
    symbol_index: State<'_, std::sync::Arc<ggs_index::symbols::index::SymbolIndex>>,
    name: String,
    repo: Option<String>,
) -> Result<Vec<FileMatches>, String> {
    let root = resolve_root(roots.inner(), repo)?;
    references_for(&symbol_index, &root, &name)
}
