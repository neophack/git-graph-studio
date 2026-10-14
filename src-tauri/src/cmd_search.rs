//! The search / compare / symbol command adapters (module 5's frontend half): each
//! `#[tauri::command]` resolves the open root, walks the cached file list (ggs-fs), and
//! hands the work to the ggs-index engine. The streaming search keeps the P3-1 seam shape:
//! batches cross through `events::ChannelSink`, cancellation is the generation counter
//! `ggs_index::search::SearchState` owns.

use std::fs;
use std::path::Path;

use tauri::ipc::Channel;
use tauri::State;

use ggs_fs::{cached_file_list, walk_files};
use ggs_index::compare::{compare_roots, DirDiffEntry};
use ggs_index::hexdiff::{hex_of, HexDiff};
use ggs_index::replace::{replace_root, ReplaceOutcome};
use ggs_index::scan::{build_matcher, filter_paths, FileMatches};
use ggs_index::search::{search_files, SearchEvent, FILE_LIST_TTL};
use ggs_index::symbols::cache::cached_symbols;
use ggs_index::symbols::index::references_for;
use ggs_index::symbols::WorkspaceSymbol;

use ggs_base::workspace::WorkspaceRoots;

/// Search every file of the open folder, streaming results over `on_event`. `query` is a
/// substring or (with `isRegex`) a regular expression; batches arrive grouped by file, files
/// ordered by path. A newer search or `search_cancel` stops this one, which still ends with
/// a `done { cancelled: true }` so the view never waits on a search that will not finish.
// Tauri commands mirror the frontend's argument object one parameter each; the search has
// seven options plus its channel.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn search_workspace(
    roots: State<'_, WorkspaceRoots>,
    search: State<'_, std::sync::Arc<ggs_index::search::SearchState>>,
    cache: State<'_, std::sync::Arc<ggs_fs::FileListCache>>,
    query: String,
    is_regex: bool,
    case_sensitive: bool,
    include: Option<String>,
    exclude: Option<String>,
    word_only: Option<bool>,
    repo: Option<String>,
    on_event: Channel<SearchEvent>,
) -> Result<(), String> {
    let generation = search.next();
    if query.is_empty() {
        let _ = on_event.send(SearchEvent::Done {
            scanned: 0,
            truncated: false,
            cancelled: false,
        });
        return Ok(());
    }
    let root = repo
        .or_else(|| roots.inner().first())
        .ok_or_else(|| "No folder is open".to_string())?;
    let matcher = build_matcher(&query, is_regex, case_sensitive, word_only.unwrap_or(false))?;
    let files = filter_paths(
        cached_file_list(cache.inner(), &root, FILE_LIST_TTL, walk_files),
        include.as_deref().unwrap_or(""),
        exclude.as_deref().unwrap_or(""),
    );
    let search = std::sync::Arc::clone(search.inner());
    // The scan is CPU- and IO-bound rayon work: it runs on a blocking thread so the async
    // runtime (and every other command) stays responsive while a big tree is searched.
    tauri::async_runtime::spawn_blocking(move || {
        // The batch stream crosses through the BatchSink seam (events.rs).
        let mut sink = crate::events::ChannelSink(on_event);
        let (scanned, truncated, cancelled) = search_files(
            &files,
            &root,
            &matcher,
            |batch| {
                use ggs_base::sink::BatchSink;
                sink.send(SearchEvent::Batch { files: batch });
            },
            || !search.is_current(generation),
        );
        use ggs_base::sink::BatchSink as _;
        let _ = sink.send(SearchEvent::Done {
            scanned,
            truncated,
            cancelled,
        });
    })
    .await
    .map_err(|e| format!("The search thread failed: {e}"))
}

/// Stop the running search (the view calls this when its query is cleared or it is hidden).
#[tauri::command]
pub fn search_cancel(search: State<'_, std::sync::Arc<ggs_index::search::SearchState>>) {
    search.cancel();
}

/// Replace every match in every file of the open folder. Files are rewritten whole; the file
/// list cache is dropped so Quick Open and the search see the new state.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // the search options mirror search_workspace's
pub async fn replace_in_files(
    roots: State<'_, WorkspaceRoots>,
    cache: State<'_, std::sync::Arc<ggs_fs::FileListCache>>,
    query: String,
    replacement: String,
    is_regex: bool,
    case_sensitive: bool,
    include: Option<String>,
    exclude: Option<String>,
    repo: Option<String>,
    word_only: Option<bool>,
) -> Result<ReplaceOutcome, String> {
    let root = repo
        .or_else(|| roots.inner().first())
        .ok_or_else(|| "No folder is open".to_string())?;
    let files = filter_paths(
        cached_file_list(cache.inner(), &root, FILE_LIST_TTL, walk_files),
        include.as_deref().unwrap_or(""),
        exclude.as_deref().unwrap_or(""),
    );
    let outcome = replace_root(
        files,
        &root,
        &query,
        &replacement,
        is_regex,
        case_sensitive,
        word_only.unwrap_or(false),
    )?;
    cache.invalidate();
    Ok(outcome)
}

/// Compare two folders file by file (the folder-comparison page's backend).
#[tauri::command]
pub async fn compare_dirs(
    left: String,
    right: String,
    include: Option<String>,
    exclude: Option<String>,
) -> Result<Vec<DirDiffEntry>, String> {
    compare_roots(
        &left,
        &right,
        include.as_deref().unwrap_or(""),
        exclude.as_deref().unwrap_or(""),
    )
}

/// Every workspace symbol whose name contains the (case-insensitive) query; an empty query
/// returns the first `limit` symbols, so the frontend can list "all" for the call tree.
/// The persistent index answers when it has landed; the in-memory rebuild stays the
/// fallback for the window before it does.
#[tauri::command]
pub async fn workspace_symbols(
    roots: State<'_, WorkspaceRoots>,
    symbol_index: State<'_, std::sync::Arc<ggs_index::symbols::index::SymbolIndex>>,
    symbol_cache: State<'_, std::sync::Arc<ggs_index::symbols::cache::SymbolCache>>,
    query: String,
    limit: Option<usize>,
    repo: Option<String>,
) -> Result<Vec<WorkspaceSymbol>, String> {
    let root = repo
        .or_else(|| roots.inner().first())
        .ok_or_else(|| "No folder is open".to_string())?;
    let all = symbol_index
        .inner()
        .all_symbols(&root)
        .unwrap_or_else(|| cached_symbols(&root, symbol_cache.inner()));
    let needle = query.to_lowercase();
    let mut hits: Vec<WorkspaceSymbol> = all
        .into_iter()
        .filter(|s| needle.is_empty() || s.name.to_lowercase().contains(&needle))
        .collect();
    if let Some(limit) = limit {
        hits.truncate(limit);
    }
    Ok(hits)
}

/// Every occurrence of `name` as a whole word in the workspace's code files - the raw material
/// of Find References and the call tree, which filter and rank it frontend-side. The
/// persistent index's occurrence list narrows the scan to the files that contain the word,
/// when one has landed.
#[tauri::command]
pub async fn find_references(
    roots: State<'_, WorkspaceRoots>,
    symbol_index: State<'_, std::sync::Arc<ggs_index::symbols::index::SymbolIndex>>,
    name: String,
) -> Result<Vec<FileMatches>, String> {
    let root = roots
        .inner()
        .first()
        .ok_or_else(|| "No folder is open".to_string())?;
    references_for(symbol_index.inner(), &root, &name)
}

/* ---------- Hex comparison ---------- */

fn bytes_at(
    git: &ggs_git::runner::Git,
    root: &str,
    revision: &str,
    path: &str,
) -> Result<Vec<u8>, String> {
    if revision == "*" {
        return fs::read(Path::new(root).join(path)).map_err(|e| format!("{path}: {e}"));
    }
    let spec = if revision == ":index" {
        format!(":{path}")
    } else {
        format!("{revision}:{path}")
    };
    let output = git
        .command()
        .args(["cat-file", "blob", &spec])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("git cat-file failed for {spec}"));
    }
    Ok(output.stdout)
}

/// Byte-level comparison of one file at two revisions (or in two working trees, with `*` and
/// repo-relative paths). Reports the differing 16-byte rows for the hex view.
#[tauri::command]
pub async fn hex_diff(
    roots: State<'_, WorkspaceRoots>,
    revision_a: String,
    revision_b: String,
    path_a: String,
    path_b: String,
) -> Result<HexDiff, String> {
    let root = roots
        .inner()
        .first()
        .ok_or_else(|| "No folder is open".to_string())?;
    let git = ggs_git::runner::Git::new(&root);
    let a = bytes_at(&git, &root, &revision_a, &path_a)?;
    let b = bytes_at(&git, &root, &revision_b, &path_b)?;
    Ok(hex_of(a, b))
}
