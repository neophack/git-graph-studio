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
use ggs_index::replace::{replace_one_in_file, replace_root, ReplaceOutcome};
use ggs_index::scan::{build_matcher, select_paths, FileMatches, SearchMatch};
use ggs_index::search::{search_files, SearchEvent, FILE_LIST_TTL};
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
    let files = select_paths(
        &cached_file_list(cache.inner(), &root, FILE_LIST_TTL, walk_files),
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

/// The replace's file list: the exact workspace-relative paths a single-file replace names
/// (`files` carries them — no glob interpretation, because a separator-free include pattern
/// would be matched against the basename at any depth and hit every same-named file), or the
/// include/exclude selection over the cached walk for the workspace-wide replace. Absolute
/// paths and `..` segments are refused: a replace never leaves the workspace.
fn replace_files(
    files: Option<Vec<String>>,
    cache: &ggs_fs::FileListCache,
    root: &str,
    include: Option<&str>,
    exclude: Option<&str>,
) -> Result<Vec<String>, String> {
    match files {
        Some(list) => {
            for relative in &list {
                if Path::new(relative).is_absolute()
                    || relative.split(['/', '\\']).any(|segment| segment == "..")
                {
                    return Err(format!(
                        "{relative}: only a workspace-relative path is accepted"
                    ));
                }
            }
            Ok(list)
        }
        None => Ok(select_paths(
            &cached_file_list(cache, root, FILE_LIST_TTL, walk_files),
            include.unwrap_or(""),
            exclude.unwrap_or(""),
        )),
    }
}

/// Replace every match in every file of the open folder. Files are rewritten whole; the file
/// list cache is dropped so Quick Open and the search see the new state. `preserve_case`
/// derives each replacement's casing from its own match (all-lower → lower, ALL-UPPER →
/// UPPER, Title → Title) — off by default, the replacement as typed. `files` (the per-file
/// replace) names exact workspace-relative paths instead of the include selection.
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
    preserve_case: Option<bool>,
    files: Option<Vec<String>>,
) -> Result<ReplaceOutcome, String> {
    let root = repo
        .or_else(|| roots.inner().first())
        .ok_or_else(|| "No folder is open".to_string())?;
    let files = replace_files(
        files,
        cache.inner(),
        &root,
        include.as_deref(),
        exclude.as_deref(),
    )?;
    let outcome = replace_root(
        files,
        &root,
        &query,
        &replacement,
        is_regex,
        case_sensitive,
        word_only.unwrap_or(false),
        preserve_case.unwrap_or(false),
    )?;
    cache.invalidate();
    Ok(outcome)
}

/// Replace exactly one listed match — a search result row's own file, line and character
/// column. The path is the result's root-relative spelling (an absolute path or a `..`
/// segment would leave the workspace and is refused); the file is re-matched with the
/// search's own options so what is replaced is exactly the occurrence the row showed, and
/// the line's remaining matches come back recomputed for the row's local update.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn search_replace_one(
    roots: State<'_, WorkspaceRoots>,
    cache: State<'_, std::sync::Arc<ggs_fs::FileListCache>>,
    path: String,
    line: usize,
    column: usize,
    query: String,
    replacement: String,
    is_regex: bool,
    case_sensitive: bool,
    repo: Option<String>,
    word_only: Option<bool>,
    preserve_case: Option<bool>,
) -> Result<Vec<SearchMatch>, String> {
    if Path::new(&path).is_absolute() || path.split(['/', '\\']).any(|segment| segment == "..") {
        return Err(format!("{path}: only a workspace-relative result path is accepted"));
    }
    let root = repo
        .or_else(|| roots.inner().first())
        .ok_or_else(|| "No folder is open".to_string())?;
    let outcome = replace_one_in_file(
        &Path::new(&root).join(&path),
        line,
        column,
        &query,
        &replacement,
        is_regex,
        case_sensitive,
        word_only.unwrap_or(false),
        preserve_case.unwrap_or(false),
    )?;
    cache.invalidate();
    Ok(outcome.matches)
}

/// Compare two folders file by file (the folder-comparison page's backend). The full
/// two-tree walk with its per-pair hashing is blocking work: it runs off the async
/// runtime, the way the search scan and the analysis builds do.
#[tauri::command]
pub async fn compare_dirs(
    left: String,
    right: String,
    include: Option<String>,
    exclude: Option<String>,
) -> Result<Vec<DirDiffEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        compare_roots(
            &left,
            &right,
            include.as_deref().unwrap_or(""),
            exclude.as_deref().unwrap_or(""),
        )
    })
    .await
    .map_err(|e| format!("The comparison thread failed: {e}"))?
}

/// Every workspace symbol whose name contains the (case-insensitive) query; an empty query
/// returns the first `limit` symbols, so the frontend can list "all" for the call tree.
/// The persistent index answers, made resident on demand (cmd_symbols' `ensure_symbols`).
#[tauri::command]
pub async fn workspace_symbols(
    app: tauri::AppHandle,
    roots: State<'_, WorkspaceRoots>,
    symbol_index: State<'_, std::sync::Arc<ggs_index::symbols::index::SymbolIndex>>,
    query: String,
    limit: Option<usize>,
    repo: Option<String>,
) -> Result<Vec<WorkspaceSymbol>, String> {
    let root = repo
        .or_else(|| roots.inner().first())
        .ok_or_else(|| "No folder is open".to_string())?;
    crate::cmd_symbols::ensure_symbols(&app, symbol_index.inner(), root.clone()).await?;
    // Filtered inside the store: only the hits are copied out, never the whole index.
    Ok(symbol_index
        .inner()
        .matching(&root, &query.to_lowercase(), limit.unwrap_or(usize::MAX))
        .unwrap_or_default())
}

/// Every occurrence of `name` as a whole word in the workspace's code files - the raw material
/// of Find References and the call tree, which filter and rank it frontend-side. The
/// persistent index's occurrence list (made resident on demand) narrows the scan to the
/// files that contain the word.
#[tauri::command]
pub async fn find_references(
    app: tauri::AppHandle,
    roots: State<'_, WorkspaceRoots>,
    symbol_index: State<'_, std::sync::Arc<ggs_index::symbols::index::SymbolIndex>>,
    name: String,
) -> Result<Vec<FileMatches>, String> {
    let root = roots
        .inner()
        .first()
        .ok_or_else(|| "No folder is open".to_string())?;
    crate::cmd_symbols::ensure_symbols(&app, symbol_index.inner(), root.clone()).await?;
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
    let output = git.raw_output(&["cat-file", "blob", &spec])?;
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

#[cfg(test)]
mod replace_files_tests {
    use super::*;

    /// The per-file replace's exact-path list names exactly that one file. A workspace with
    /// `README.md` at the root and `docs/README.md` used to rewrite both: the per-file
    /// replace passed the path as an include glob, and a separator-free pattern is matched
    /// against the basename at any depth (`ggs_index::scan::glob_match`).
    #[test]
    fn a_single_file_replace_names_exactly_that_path() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("README.md"), "# one\n").unwrap();
        std::fs::create_dir_all(dir.path().join("docs")).unwrap();
        std::fs::write(dir.path().join("docs").join("README.md"), "# two\n").unwrap();
        let root = dir.path().display().to_string();
        let cache = ggs_fs::FileListCache::default();

        let files = replace_files(Some(vec!["README.md".to_owned()]), &cache, &root, None, None)
            .unwrap();
        assert_eq!(files, ["README.md"]);

        // The include path `docs/README.md` (a separator-carrying glob) names its own file.
        let files = replace_files(
            Some(vec!["docs/README.md".to_owned()]),
            &cache,
            &root,
            None,
            None,
        )
        .unwrap();
        assert_eq!(files, ["docs/README.md"]);

        // The workspace-wide replace still walks the include/exclude selection.
        let both = replace_files(None, &cache, &root, Some("README.md"), None).unwrap();
        assert_eq!(both, ["README.md", "docs/README.md"]);
    }

    /// A replace never leaves the workspace: a `..` segment is refused before any file is
    /// touched (the absolute-path refusal is Windows-shaped and covered by the same check's
    /// `is_absolute` arm on that platform).
    #[test]
    fn a_path_outside_the_workspace_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().display().to_string();
        let cache = ggs_fs::FileListCache::default();
        for escape in ["../outside.txt", "src/../../a.txt"] {
            let err =
                replace_files(Some(vec![escape.to_owned()]), &cache, &root, None, None)
                    .unwrap_err();
            assert!(err.contains("workspace-relative"), "{escape}: {err}");
        }
    }
}
