//! The Code Analysis command adapters (module 17): the `#[tauri::command]` half over
//! ggs-analysis's per-root `AnalysisIndex`. Nothing builds on a folder open: the first
//! analysis command builds the index (every core, progress on the
//! `studio://analysis-index` event the sidebar shows), later ones reuse it, and the
//! composition root's sweeper (`index_lease`) releases it once it sits idle. Watcher
//! batches update a resident index file by file, and every report command streams its
//! rows over a channel through the ggs-base push seam — the search view's rhythm (plan
//! §3.4). The two per-file reports (metrics, security) do not wait the build out: on a
//! cold index their rows stream through the build's per-batch hook, the click's first
//! batch landing one parse batch in instead of a whole tree in.

use tauri::ipc::Channel;
use tauri::State;

use ggs_analysis::imports::ImportGraph;
use ggs_analysis::index::{
    run_dead_code, run_metrics, run_security, AnalysisIndexEvent,
    AnalysisStatus, DeadCodeEvent, MetricsEvent, SecurityEvent,
};
use ggs_analysis::modules::{self, ModuleEdgeDetail, ModuleEdgeTypes, ModuleOverview};

use ggs_base::sink::BatchSink;
use ggs_base::workspace::WorkspaceRoots;

/* ---------- The commands ---------- */

fn resolve_root(roots: &WorkspaceRoots, repo: Option<String>) -> Result<String, String> {
    repo.or_else(|| roots.first())
        .ok_or_else(|| "No folder is open".to_owned())
}

/// The index state of the open folder: what the Analysis sidebar shows.
#[tauri::command]
pub async fn analysis_status(
    roots: State<'_, WorkspaceRoots>,
    analysis_index: State<'_, std::sync::Arc<ggs_analysis::index::AnalysisIndex>>,
    repo: Option<String>,
) -> Result<AnalysisStatus, String> {
    let root = resolve_root(roots.inner(), repo)?;
    Ok(analysis_index.status(&root))
}

/// Rebuild the analysis from scratch (the sidebar's button).
/// Streams `progress` batches over the channel, then one `done`.
#[tauri::command]
pub async fn analysis_rebuild(
    roots: State<'_, WorkspaceRoots>,
    analysis_index: State<'_, std::sync::Arc<ggs_analysis::index::AnalysisIndex>>,
    repo: Option<String>,
    on_event: Channel<AnalysisIndexEvent>,
) -> Result<AnalysisStatus, String> {
    let root = resolve_root(roots.inner(), repo)?;
    let index = std::sync::Arc::clone(analysis_index.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut channel = crate::events::ChannelSink(on_event);
        let channel: Option<&mut dyn ggs_base::sink::BatchSink<AnalysisIndexEvent>> =
            Some(&mut channel);
        index.build_blocking(None, &root, channel)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Scoped, layered module architecture overview read directly from the nine `project.ggs_*`
/// volumes via zero-clone `&SymbolStore` access — no `AnalysisData` build.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn analysis_module_overview(
    app: tauri::AppHandle,
    roots: State<'_, WorkspaceRoots>,
    symbol_index: State<'_, std::sync::Arc<ggs_index::symbols::index::SymbolIndex>>,
    repo: Option<String>,
    scope: Option<String>,
    depth: Option<u8>,
    folders: Option<Vec<String>>,
    edge_types: Option<ModuleEdgeTypes>,
) -> Result<ModuleOverview, String> {
    let root = resolve_root(roots.inner(), repo)?;
    crate::cmd_symbols::ensure_symbols(&app, symbol_index.inner(), root.clone()).await?;
    let index = std::sync::Arc::clone(symbol_index.inner());
    let folders = folders.unwrap_or_default();
    let depth = depth.unwrap_or(0);
    let edge_types = edge_types.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let scanned_imports = if edge_types.imports {
            let plan = index
                .with_store(&root, |store| {
                    modules::prepare_import_scan_plan(store, scope.as_deref(), &folders)
                })
                .ok_or_else(|| "The symbol index could not be built".to_owned())?;
            Some(modules::scan_import_edges(&root, &plan))
        } else {
            None
        };
        index
            .with_store(&root, |store| {
                modules::module_overview_from_store(
                    store,
                    scope.as_deref(),
                    depth,
                    &folders,
                    edge_types,
                    scanned_imports.as_deref(),
                )
            })
            .ok_or_else(|| "The symbol index could not be built".to_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// On-demand L2 evidence for a single module dependency edge `from → to`: extracts a
/// minimal plan under the store read lock and scans only relevant `from`-side files lock-free.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn analysis_module_edge_detail(
    app: tauri::AppHandle,
    roots: State<'_, WorkspaceRoots>,
    symbol_index: State<'_, std::sync::Arc<ggs_index::symbols::index::SymbolIndex>>,
    repo: Option<String>,
    from: String,
    to: String,
    scope: Option<String>,
    depth: Option<u8>,
    folders: Option<Vec<String>>,
) -> Result<ModuleEdgeDetail, String> {
    let root = resolve_root(roots.inner(), repo)?;
    crate::cmd_symbols::ensure_symbols(&app, symbol_index.inner(), root.clone()).await?;
    let folders = folders.unwrap_or_default();
    let depth = depth.unwrap_or(0);
    let plan = symbol_index
        .with_store(&root, |store| {
            modules::prepare_edge_detail_from_store(
                store,
                &from,
                &to,
                scope.as_deref(),
                depth,
                &folders,
            )
        })
        .ok_or("The symbol index could not be built")?;
    tauri::async_runtime::spawn_blocking(move || modules::scan_edge_detail(&root, &plan))
        .await
        .map_err(|e| e.to_string())
}

/// Every function and method with its measured shape, streamed in batches. The hotspot
/// column blends the symbol index's occurrence counts in (the index is made resident for
/// it, like any symbol query); the big-code-analysis columns (cognitive complexity, Halstead, LLOC, MI) enrich each
/// batch outside the analysis lock — a re-read per report, the security scan's rhythm.
/// On a cold index the report streams DURING the build: every parsed batch's rows cross
/// at once, the click's first answer being rows instead of a spinner (plan §3.4 — the
/// first batch reaches the UI in the parse of one batch, not the parse of the tree).
#[tauri::command]
pub async fn analysis_metrics(
    app: tauri::AppHandle,
    roots: State<'_, WorkspaceRoots>,
    analysis_index: State<'_, std::sync::Arc<ggs_analysis::index::AnalysisIndex>>,
    symbol_index: State<'_, std::sync::Arc<ggs_index::symbols::index::SymbolIndex>>,
    repo: Option<String>,
    on_event: Channel<MetricsEvent>,
) -> Result<(), String> {
    let root = resolve_root(roots.inner(), repo)?;
    // Without the counts the hotspot column reads zero, still a report: a failed symbol
    // load does not fail the page. (Before the build, so the streamed rows enrich too.)
    let _ = crate::cmd_symbols::ensure_symbols(&app, symbol_index.inner(), root.clone()).await;
    let index = std::sync::Arc::clone(analysis_index.inner());
    let symbols = std::sync::Arc::clone(symbol_index.inner());
    // The hotspot column asks per name as rows stream: one binary search into the
    // store's occurrence lists, never the whole name-to-count table a large workspace
    // would put in memory for the report's run.
    tauri::async_runtime::spawn_blocking(move || {
        let events = crate::events::TauriEvents(app.clone());
        let mut sink = crate::events::ChannelSink(on_event);
        let refs_root = root.clone();
        let refs_of = move |name: &str| symbols.ref_count(&refs_root, name).unwrap_or(0);
        // The build-time hook: every parsed batch's rows leave at once, and the counts
        // the final Done needs accumulate beside them.
        let mut streamed = 0usize;
        let mut functions = 0usize;
        let mut hook = |data: &ggs_analysis::AnalysisData| {
            let files = data.files();
            if files.len() > streamed {
                let rows =
                    ggs_analysis::metrics::rows_for_files(data, &files[streamed..], &refs_of);
                functions += rows.len();
                streamed = files.len();
                let _ = sink.send(MetricsEvent::Batch { rows });
            }
        };
        match index.ensure_with_batches(Some(&events), &root, Some(&mut hook)) {
            Ok(data) => {
                if streamed == 0 {
                    // The analysis was already resident (the hook never ran): the
                    // ordinary whole-report run.
                    run_metrics(&index, &data, &refs_of, &mut sink);
                } else {
                    let _ = sink.send(MetricsEvent::Done {
                        files: streamed,
                        functions,
                        cancelled: false,
                    });
                }
            }
            // A cancelled build (a folder switch, a newer rebuild) retires the page the
            // way a retired report does — no error banner, the newer run owns the view.
            Err(message) if message == "cancelled" => {
                let _ = sink.send(MetricsEvent::Done {
                    files: 0,
                    functions: 0,
                    cancelled: true,
                });
            }
            Err(message) => return Err(message),
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Declarations no call site in the workspace spells, streamed in batches — the rule
/// reads the project volumes' store (`analysis_dead_code` never builds the Code
/// Analysis engine): the store resumes on demand (the same path every symbol query
/// takes), the occurrence lists pre-filter, the masked token walk confirms.
#[tauri::command]
pub async fn analysis_dead_code(
    app: tauri::AppHandle,
    roots: State<'_, WorkspaceRoots>,
    analysis_index: State<'_, std::sync::Arc<ggs_analysis::index::AnalysisIndex>>,
    symbol_index: State<'_, std::sync::Arc<ggs_index::symbols::index::SymbolIndex>>,
    include_exported: Option<bool>,
    repo: Option<String>,
    on_event: Channel<DeadCodeEvent>,
) -> Result<(), String> {
    let root = resolve_root(roots.inner(), repo)?;
    crate::cmd_symbols::ensure_symbols(&app, symbol_index.inner(), root.clone()).await?;
    // The store's facts the rule reads, snapshotted under the store's lock — the file
    // reads of the confirmation pass run lock-free.
    let catalogue = symbol_index
        .with_store(&root, ggs_analysis::deadcode::dead_catalogue)
        .ok_or("The symbol index could not be built")?;
    let index = std::sync::Arc::clone(analysis_index.inner());
    let include_exported = include_exported.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let mut sink = crate::events::ChannelSink(on_event);
        run_dead_code(&index, &root, &catalogue, include_exported, &mut sink);
    })
    .await
    .map_err(|e| e.to_string())
}

/// The rule-based security scan (secrets, dangerous and weak-crypto APIs), streamed in
/// batches over the project volumes' store file table — one read per file, a report
/// run, no Code Analysis engine behind it.
#[tauri::command]
pub async fn analysis_security(
    app: tauri::AppHandle,
    roots: State<'_, WorkspaceRoots>,
    analysis_index: State<'_, std::sync::Arc<ggs_analysis::index::AnalysisIndex>>,
    symbol_index: State<'_, std::sync::Arc<ggs_index::symbols::index::SymbolIndex>>,
    repo: Option<String>,
    on_event: Channel<SecurityEvent>,
) -> Result<(), String> {
    let root = resolve_root(roots.inner(), repo)?;
    crate::cmd_symbols::ensure_symbols(&app, symbol_index.inner(), root.clone()).await?;
    let store_files = symbol_index
        .with_store(&root, |store| {
            store
                .files_with_counts()
                .into_iter()
                .map(|(path, _)| path)
                .collect::<Vec<_>>()
        })
        .ok_or("The symbol index could not be built")?;
    // The scan reads raw text lossily — the walk adds the files the store's decoder
    // refused, so their ASCII secrets still report.
    let files = ggs_analysis::AnalysisData::report_files(&root, store_files);
    let index = std::sync::Arc::clone(analysis_index.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut sink = crate::events::ChannelSink(on_event);
        run_security(&index, &root, &files, &mut sink);
    })
    .await
    .map_err(|e| e.to_string())
}

/// The workspace's import graph with its cycles, in one answer — read off the project
/// volumes' store: the volumes' file table names every file, the masked line scanner
/// reads each file's import spellings, and the resolution is the one the engine's own
/// graph always applied. No Code Analysis engine behind it.
#[tauri::command]
pub async fn analysis_import_graph(
    app: tauri::AppHandle,
    roots: State<'_, WorkspaceRoots>,
    symbol_index: State<'_, std::sync::Arc<ggs_index::symbols::index::SymbolIndex>>,
    repo: Option<String>,
) -> Result<ImportGraph, String> {
    let root = resolve_root(roots.inner(), repo)?;
    crate::cmd_symbols::ensure_symbols(&app, symbol_index.inner(), root.clone()).await?;
    let files = symbol_index
        .with_store(&root, |store| {
            store
                .files_with_counts()
                .into_iter()
                .map(|(path, _)| path)
                .collect::<Vec<_>>()
        })
        .ok_or("The symbol index could not be built")?;
    tauri::async_runtime::spawn_blocking(move || ggs_analysis::imports::import_graph(&root, &files))
        .await
        .map_err(|e| e.to_string())
}
