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

use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tauri::State;

use ggs_analysis::index::{
    run_dead_code, run_metrics, run_security, security_scan_files, AnalysisIndexEvent,
    AnalysisStatus, DeadCodeEvent, MetricsEvent, SecurityEvent,
};
use ggs_analysis::imports::ImportGraph;
use ggs_analysis::modules::{self, ModuleGraph};
use ggs_analysis::AnalysisData;
use ggs_analysis::diagram::ModuleDiagram;

use ggs_base::sink::BatchSink;
use ggs_base::workspace::WorkspaceRoots;

/* ---------- The commands ---------- */

fn resolve_root(roots: &WorkspaceRoots, repo: Option<String>) -> Result<String, String> {
    repo.or_else(|| roots.first())
        .ok_or_else(|| "No folder is open".to_owned())
}

/// The root's analysis, built now when none is resident — off the async runtime, since a
/// first build of a large tree takes a while.
async fn analysis_of(
    app: &tauri::AppHandle,
    analysis_index: &Arc<ggs_analysis::index::AnalysisIndex>,
    root: String,
) -> Result<Arc<Mutex<AnalysisData>>, String> {
    let index = Arc::clone(analysis_index);
    let sink = crate::events::TauriEvents(app.clone());
    tauri::async_runtime::spawn_blocking(move || index.ensure_blocking(Some(&sink), &root))
        .await
        .map_err(|e| e.to_string())?
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

/// The workspace's module graph: which module (directory) depends on which, the file
/// pairs that carry the calls and the call sites under each — the Module Analysis
/// page's whole model, in one answer (see `ggs_analysis::modules`). `folders` scopes the
/// answer to a folder pick (empty or absent: the whole workspace).
#[tauri::command]
pub async fn analysis_module_graph(
    app: tauri::AppHandle,
    roots: State<'_, WorkspaceRoots>,
    analysis_index: State<'_, std::sync::Arc<ggs_analysis::index::AnalysisIndex>>,
    repo: Option<String>,
    folders: Option<Vec<String>>,
) -> Result<ModuleGraph, String> {
    let root = resolve_root(roots.inner(), repo)?;
    let data = analysis_of(&app, analysis_index.inner(), root).await?;
    let data = data.lock().unwrap();
    Ok(modules::module_graph(
        &data,
        &modules::normalize_scope(&folders.unwrap_or_default()),
    ))
}

/// The Module Analysis drawing (the gitdiagram-style architecture diagram): the
/// module graph laid out in the backend — group boxes, blocks, arrows, the mermaid
/// source and what the caps dropped — geometry ready to set (see `ggs_analysis::diagram`).
/// The filter and the optional focus narrow the pairs the same way the page's tree
/// does; the page refetches on either changing. `folders` scopes the whole drawing
/// to a folder pick (empty or absent: the whole workspace).
#[tauri::command]
pub async fn analysis_module_diagram(
    app: tauri::AppHandle,
    roots: State<'_, WorkspaceRoots>,
    analysis_index: State<'_, std::sync::Arc<ggs_analysis::index::AnalysisIndex>>,
    repo: Option<String>,
    focus: Option<String>,
    filter: Option<String>,
    folders: Option<Vec<String>>,
) -> Result<ModuleDiagram, String> {
    let root = resolve_root(roots.inner(), repo)?;
    let data = analysis_of(&app, analysis_index.inner(), root).await?;
    let data = data.lock().unwrap();
    let scope = modules::normalize_scope(&folders.unwrap_or_default());
    Ok(ggs_analysis::diagram::module_diagram(
        &modules::module_graph(&data, &scope),
        focus.as_deref(),
        filter.as_deref().unwrap_or(""),
        &scope,
    ))
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

/// Declarations no call site in the workspace spells, streamed in batches.
#[tauri::command]
pub async fn analysis_dead_code(
    app: tauri::AppHandle,
    roots: State<'_, WorkspaceRoots>,
    analysis_index: State<'_, std::sync::Arc<ggs_analysis::index::AnalysisIndex>>,
    include_exported: Option<bool>,
    repo: Option<String>,
    on_event: Channel<DeadCodeEvent>,
) -> Result<(), String> {
    let root = resolve_root(roots.inner(), repo)?;
    let data = analysis_of(&app, analysis_index.inner(), root).await?;
    let index = std::sync::Arc::clone(analysis_index.inner());
    let include_exported = include_exported.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let mut sink = crate::events::ChannelSink(on_event);
        run_dead_code(&index, &data, include_exported, &mut sink);
    })
    .await
    .map_err(|e| e.to_string())
}

/// The rule-based security scan (secrets, dangerous and weak-crypto APIs), streamed in
/// batches. Pattern rules need the raw text, so the files are re-read here — a report
/// run, not the index's hot path. On a cold index the scan streams DURING the build:
/// every parsed batch's findings cross at once, the click's first answer being rows
/// instead of a spinner (the metrics report's rhythm).
#[tauri::command]
pub async fn analysis_security(
    app: tauri::AppHandle,
    roots: State<'_, WorkspaceRoots>,
    analysis_index: State<'_, std::sync::Arc<ggs_analysis::index::AnalysisIndex>>,
    repo: Option<String>,
    on_event: Channel<SecurityEvent>,
) -> Result<(), String> {
    let root = resolve_root(roots.inner(), repo)?;
    let index = std::sync::Arc::clone(analysis_index.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let events = crate::events::TauriEvents(app.clone());
        let mut sink = crate::events::ChannelSink(on_event);
        let mut streamed = 0usize;
        let mut scanned = 0usize;
        let mut findings = 0usize;
        let mut hook = |data: &ggs_analysis::AnalysisData| {
            let files = data.files();
            if files.len() > streamed {
                let (scan, found) =
                    security_scan_files(data, &root, &files[streamed..], &mut sink);
                scanned += scan;
                findings += found;
                streamed = files.len();
            }
        };
        match index.ensure_with_batches(Some(&events), &root, Some(&mut hook)) {
            Ok(data) => {
                if streamed == 0 {
                    // The analysis was already resident (the hook never ran): the
                    // ordinary whole-report run.
                    run_security(&index, &data, &root, &mut sink);
                } else {
                    let _ = sink.send(SecurityEvent::Done {
                        files: scanned,
                        findings,
                        cancelled: false,
                    });
                }
            }
            // A cancelled build (a folder switch, a newer rebuild) retires the page the
            // way a retired report does — no error banner, the newer run owns the view.
            Err(message) if message == "cancelled" => {
                let _ = sink.send(SecurityEvent::Done {
                    files: 0,
                    findings: 0,
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

/// The workspace's import graph with its cycles, in one answer.
#[tauri::command]
pub async fn analysis_import_graph(
    app: tauri::AppHandle,
    roots: State<'_, WorkspaceRoots>,
    analysis_index: State<'_, std::sync::Arc<ggs_analysis::index::AnalysisIndex>>,
    repo: Option<String>,
) -> Result<ImportGraph, String> {
    let root = resolve_root(roots.inner(), repo)?;
    let data = analysis_of(&app, analysis_index.inner(), root).await?;
    let data = data.lock().unwrap();
    Ok(ggs_analysis::imports::import_graph(&data))
}
