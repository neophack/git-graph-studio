// Quick Open's fuzzy file matching and the editor's path completion, server-side: the file
// list the backend already caches is scored in ggs-index, so a keystroke ships ~60 rows over
// IPC instead of the walked tree. The tiers mirror the TS scorer in `fuzzy.ts` (a VS Code
// fuzzyScorer port); the frontend keeps the TS scorer as the fallback when no folder is
// open.

use std::time::Duration;

use ggs_fs::{cached_file_list, walk_files};

use ggs_index::fuzzy::{fuzzy_hits, path_entries, FuzzyFileHit, PathEntry};

use crate::AppState;
use tauri::State;

/// Quick Open's query: the open folder's file list scored in Rust, the best `limit` rows
/// first. An empty query returns the first files as walked, like the TS source does.
#[tauri::command]
pub async fn fuzzy_files(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<FuzzyFileHit>, String> {
    const TTL: Duration = Duration::from_secs(5);
    let limit = limit.unwrap_or(60).clamp(1, 200);
    let root = state
        .first_repo()
        .ok_or_else(|| "No folder is open".to_string())?;
    let files = cached_file_list(&state.file_list_cache, &root, TTL, walk_files);
    Ok(fuzzy_hits(&files, &query, limit))
}

/// The editor's path completion, server-side over the cached file list: the entries of the
/// typed fragment's folder that share the last segment's prefix (mirrors `pathOptions` in
/// `autocomplete.ts`, which stays as the frontend's fallback).
#[tauri::command]
pub async fn path_completions(
    state: State<'_, AppState>,
    prefix: String,
    limit: Option<usize>,
) -> Result<Vec<PathEntry>, String> {
    const TTL: Duration = Duration::from_secs(5);
    let limit = limit.unwrap_or(200).clamp(1, 500);
    let root = state
        .first_repo()
        .ok_or_else(|| "No folder is open".to_string())?;
    let files = cached_file_list(&state.file_list_cache, &root, TTL, walk_files);

    let typed = prefix.replace('\\', "/");
    Ok(path_entries(&files, &typed, limit))
}
