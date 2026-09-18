//! The Code Analysis commands (module 17): the per-root `AnalysisIndex` the app state
//! owns, plus the tool commands the Analysis pages and the MCP server call. The index
//! builds in the background on a folder open (half the cores), the explicit rebuild takes
//! them all, watcher batches update single files, and every report command streams its
//! rows over a channel in batches with a cancellation generation — the search view's
//! rhythm (plan §3.4): a first batch lands fast, and a newer run retires the older one.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::analysis::imports::ImportGraph;
use crate::analysis::metrics::MetricRow;
use crate::analysis::security::{self, Finding};
use crate::analysis::{
    deadcode, imports, metrics, AnalysisData, CallGraph, Direction, GraphNode, WorkspaceCallGraph,
};
use crate::AppState;

/// The event the Analysis sidebar listens to; the payload is an [`AnalysisStatus`].
pub const ANALYSIS_INDEX_EVENT: &str = "studio://analysis-index";

/// Rows per streamed batch — small enough that the first batch lands in milliseconds,
/// large enough that the channel is not the bottleneck.
const REPORT_BATCH: usize = 256;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AnalysisState {
    Empty,
    Building,
    Ready,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisStatus {
    pub state: AnalysisState,
    pub done: usize,
    pub total: usize,
    pub files: usize,
    pub symbols: usize,
    pub calls: usize,
}

impl AnalysisStatus {
    fn empty() -> AnalysisStatus {
        AnalysisStatus {
            state: AnalysisState::Empty,
            done: 0,
            total: 0,
            files: 0,
            symbols: 0,
            calls: 0,
        }
    }
}

/// What a rebuild pushes over its channel: progress batches, then exactly one `done`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AnalysisIndexEvent {
    Progress {
        done: usize,
        total: usize,
    },
    Done {
        files: usize,
        symbols: usize,
        calls: usize,
        cancelled: bool,
    },
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MetricsEvent {
    Batch {
        rows: Vec<MetricRow>,
    },
    Done {
        files: usize,
        functions: usize,
        cancelled: bool,
    },
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum DeadCodeEvent {
    Batch { rows: Vec<deadcode::DeadRow> },
    Done { found: usize, cancelled: bool },
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SecurityEvent {
    Batch {
        findings: Vec<Finding>,
    },
    Done {
        files: usize,
        findings: usize,
        cancelled: bool,
    },
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CallPathResult {
    pub found: bool,
    pub path: Vec<GraphNode>,
}

/// The per-root analyses plus their build state. The generation counter cancels a running
/// build or report the way the symbol index's does.
pub struct AnalysisIndex {
    analyses: Mutex<HashMap<String, Arc<Mutex<AnalysisData>>>>,
    progress: Mutex<HashMap<String, AnalysisStatus>>,
    generation: AtomicU64,
}

impl Default for AnalysisIndex {
    fn default() -> Self {
        AnalysisIndex::new()
    }
}

impl AnalysisIndex {
    pub fn new() -> AnalysisIndex {
        AnalysisIndex {
            analyses: Mutex::new(HashMap::new()),
            progress: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
        }
    }

    /// Stop the running build or report (a folder switch or a newer run).
    pub fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn status(&self, root: &str) -> AnalysisStatus {
        self.progress
            .lock()
            .unwrap()
            .get(root)
            .cloned()
            .unwrap_or_else(AnalysisStatus::empty)
    }

    fn note(&self, root: &str, status: AnalysisStatus) {
        self.progress
            .lock()
            .unwrap()
            .insert(root.to_owned(), status);
    }

    fn data(&self, root: &str) -> Option<Arc<Mutex<AnalysisData>>> {
        self.analyses.lock().unwrap().get(root).cloned()
    }

    fn install(&self, root: &str, data: AnalysisData) {
        let stats = ready_status(&data);
        self.analyses
            .lock()
            .unwrap()
            .insert(root.to_owned(), Arc::new(Mutex::new(data)));
        self.note(root, stats);
    }

    /// Drop a root's analysis (the folder closed).
    pub fn remove(&self, root: &str) {
        self.analyses.lock().unwrap().remove(root);
        self.progress.lock().unwrap().remove(root);
    }

    /// Kick off the background build of a root (a folder open). Fire and forget —
    /// progress reaches the frontend through the [`ANALYSIS_INDEX_EVENT`] event.
    pub fn start_build(self: &Arc<Self>, app: Option<tauri::AppHandle>, root: &str) {
        let index = Arc::clone(self);
        let root = root.to_owned();
        std::thread::spawn(move || {
            let _ = index.build_on_blocking(app.as_ref(), &root, None, index_threads(true));
        });
    }

    /// An explicit rebuild (the sidebar's button, `analysis_rebuild`, the MCP start): the
    /// user or the script is waiting, so every core is fair game.
    pub(crate) fn build_blocking(
        &self,
        app: Option<&tauri::AppHandle>,
        root: &str,
        channel: Option<&Channel<AnalysisIndexEvent>>,
    ) -> Result<AnalysisStatus, String> {
        self.build_on_blocking(app, root, channel, index_threads(false))
    }

    fn build_on_blocking(
        &self,
        app: Option<&tauri::AppHandle>,
        root: &str,
        channel: Option<&Channel<AnalysisIndexEvent>>,
        threads: usize,
    ) -> Result<AnalysisStatus, String> {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let is_current = || self.generation.load(Ordering::SeqCst) == generation;
        let report = |done: usize, total: usize| {
            self.note(
                root,
                AnalysisStatus {
                    state: AnalysisState::Building,
                    done,
                    total,
                    files: 0,
                    symbols: 0,
                    calls: 0,
                },
            );
            if let Some(channel) = channel {
                let _ = channel.send(AnalysisIndexEvent::Progress { done, total });
            }
            if let Some(app) = app {
                use tauri::Emitter;
                let _ = app.emit(ANALYSIS_INDEX_EVENT, self.status(root));
            }
        };
        let built = AnalysisData::build(root, threads, &report, &|| !is_current());
        // A cancelled build leaves the previous analysis standing, like the symbol index.
        let data = match built {
            Some(data) => data,
            None => {
                if let Some(channel) = channel {
                    let _ = channel.send(AnalysisIndexEvent::Done {
                        files: 0,
                        symbols: 0,
                        calls: 0,
                        cancelled: true,
                    });
                }
                return Err("cancelled".to_owned());
            }
        };
        let stats = ready_status(&data);
        self.install(root, data);
        if let Some(channel) = channel {
            let _ = channel.send(AnalysisIndexEvent::Done {
                files: stats.files,
                symbols: stats.symbols,
                calls: stats.calls,
                cancelled: false,
            });
        }
        if let Some(app) = app {
            use tauri::Emitter;
            let _ = app.emit(ANALYSIS_INDEX_EVENT, self.status(root));
        }
        Ok(stats)
    }

    /// Apply a watcher batch to the root's analysis on a background thread.
    pub fn apply_changes(
        self: &Arc<Self>,
        app: Option<tauri::AppHandle>,
        root: &str,
        paths: Vec<String>,
    ) {
        let index = Arc::clone(self);
        let root = root.to_owned();
        std::thread::spawn(move || {
            let Some(data) = index.data(&root) else {
                return;
            };
            {
                let mut data = data.lock().unwrap();
                data.apply_changes(&paths);
                index.note(&root, ready_status(&data));
            }
            if let Some(app) = app {
                use tauri::Emitter;
                let _ = app.emit(ANALYSIS_INDEX_EVENT, index.status(&root));
            }
        });
    }

    /// The analysis of a root, when one has landed.
    pub fn analysis(&self, root: &str) -> Option<Arc<Mutex<AnalysisData>>> {
        self.data(root)
    }

    /// Claim the next run generation for a streaming report: a newer report (or a build,
    /// or a folder switch) retires the caller at its next batch.
    fn begin_run(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_current_run(&self, run: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == run
    }
}

fn index_threads(background: bool) -> usize {
    // The same budget the symbol index uses (cmd_symbols::SymbolIndex::index_threads).
    cmd_symbols_threads(background)
}

// The symbol index's thread budget, reached through its public helper.
fn cmd_symbols_threads(background: bool) -> usize {
    crate::cmd_symbols::SymbolIndex::index_threads(background)
}

fn ready_status(data: &AnalysisData) -> AnalysisStatus {
    AnalysisStatus {
        state: AnalysisState::Ready,
        done: data.file_count(),
        total: data.file_count(),
        files: data.file_count(),
        symbols: data.symbol_count(),
        calls: data.call_count(),
    }
}

/* ---------- The commands ---------- */

fn resolve_root(state: &AppState, repo: Option<String>) -> Result<String, String> {
    repo.or_else(|| state.first_repo())
        .ok_or_else(|| "No folder is open".to_owned())
}

fn analysis_of(state: &AppState, repo: Option<String>) -> Result<Arc<Mutex<AnalysisData>>, String> {
    let root = resolve_root(state, repo)?;
    state
        .analysis_index
        .analysis(&root)
        .ok_or_else(|| "The code analysis index is still building".to_owned())
}

/// The index state of the open folder: what the Analysis sidebar shows.
#[tauri::command]
pub async fn analysis_status(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<AnalysisStatus, String> {
    let root = resolve_root(&state, repo)?;
    Ok(state.analysis_index.status(&root))
}

/// Rebuild the analysis from scratch (also what a first open does in the background).
/// Streams `progress` batches over the channel, then one `done`.
#[tauri::command]
pub async fn analysis_rebuild(
    state: State<'_, AppState>,
    repo: Option<String>,
    on_event: Channel<AnalysisIndexEvent>,
) -> Result<AnalysisStatus, String> {
    let root = resolve_root(&state, repo)?;
    let index = Arc::clone(&state.analysis_index);
    tauri::async_runtime::spawn_blocking(move || index.build_blocking(None, &root, Some(&on_event)))
        .await
        .map_err(|e| e.to_string())?
}

/// The call graph around a declaration: `max_depth` levels of callers or callees. When
/// `path` and `line` name one declaration exactly, the graph starts there; otherwise
/// every declaration of `name` is a root.
#[tauri::command]
pub async fn analysis_call_graph(
    state: State<'_, AppState>,
    name: String,
    path: Option<String>,
    line: Option<usize>,
    direction: Direction,
    max_depth: Option<u32>,
    repo: Option<String>,
) -> Result<CallGraph, String> {
    let data = analysis_of(&state, repo)?;
    let data = data.lock().unwrap();
    Ok(data.call_graph(
        &name,
        path.as_deref().zip(line),
        direction,
        max_depth.unwrap_or(2),
    ))
}

/// The workspace's every call relationship at once — the Call Graph page's opening
/// view, before any symbol is picked (see `AnalysisData::workspace_call_graph`).
#[tauri::command]
pub async fn analysis_workspace_call_graph(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<WorkspaceCallGraph, String> {
    let data = analysis_of(&state, repo)?;
    let data = data.lock().unwrap();
    Ok(data.workspace_call_graph())
}

/// A shortest callee chain between two declarations, by name.
#[tauri::command]
pub async fn analysis_call_path(
    state: State<'_, AppState>,
    from: String,
    to: String,
    repo: Option<String>,
) -> Result<CallPathResult, String> {
    let data = analysis_of(&state, repo)?;
    let data = data.lock().unwrap();
    match data.call_path(&from, &to) {
        Some(path) => Ok(CallPathResult { found: true, path }),
        None => Ok(CallPathResult {
            found: false,
            path: Vec::new(),
        }),
    }
}

/// Every function and method with its measured shape, streamed in batches. The hotspot
/// column blends the symbol index's occurrence counts in when it has landed.
#[tauri::command]
pub async fn analysis_metrics(
    state: State<'_, AppState>,
    repo: Option<String>,
    on_event: Channel<MetricsEvent>,
) -> Result<(), String> {
    let root = resolve_root(&state, repo)?;
    let data = state
        .analysis_index
        .analysis(&root)
        .ok_or_else(|| "The code analysis index is still building".to_owned())?;
    let index = Arc::clone(&state.analysis_index);
    let refs = state
        .symbol_index
        .symbols_with_refs(&root)
        .map(|(_, counts)| counts)
        .unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let run = index.begin_run();
        let rows = {
            let data = data.lock().unwrap();
            metrics::metric_rows(&data, &|name| refs.get(name).copied().unwrap_or(0))
        };
        let files = rows.len();
        for batch in rows.chunks(REPORT_BATCH) {
            if !index.is_current_run(run) {
                let _ = on_event.send(MetricsEvent::Done {
                    files: 0,
                    functions: 0,
                    cancelled: true,
                });
                return Ok(());
            }
            let _ = on_event.send(MetricsEvent::Batch {
                rows: batch.to_vec(),
            });
        }
        let _ = on_event.send(MetricsEvent::Done {
            files,
            functions: rows.len(),
            cancelled: false,
        });
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Declarations no call site in the workspace spells, streamed in batches.
#[tauri::command]
pub async fn analysis_dead_code(
    state: State<'_, AppState>,
    include_exported: Option<bool>,
    repo: Option<String>,
    on_event: Channel<DeadCodeEvent>,
) -> Result<(), String> {
    let root = resolve_root(&state, repo)?;
    let data = state
        .analysis_index
        .analysis(&root)
        .ok_or_else(|| "The code analysis index is still building".to_owned())?;
    let index = Arc::clone(&state.analysis_index);
    let include_exported = include_exported.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let run = index.begin_run();
        let rows = {
            let data = data.lock().unwrap();
            deadcode::dead_rows(&data, include_exported)
        };
        for batch in rows.chunks(REPORT_BATCH) {
            if !index.is_current_run(run) {
                let _ = on_event.send(DeadCodeEvent::Done {
                    found: 0,
                    cancelled: true,
                });
                return Ok(());
            }
            let _ = on_event.send(DeadCodeEvent::Batch {
                rows: batch.to_vec(),
            });
        }
        let _ = on_event.send(DeadCodeEvent::Done {
            found: rows.len(),
            cancelled: false,
        });
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The rule-based security scan (secrets, dangerous and weak-crypto APIs), streamed in
/// batches. Pattern rules need the raw text, so the files are re-read here — a report
/// run, not the index's hot path.
#[tauri::command]
pub async fn analysis_security(
    state: State<'_, AppState>,
    repo: Option<String>,
    on_event: Channel<SecurityEvent>,
) -> Result<(), String> {
    let root = resolve_root(&state, repo)?;
    let data = state
        .analysis_index
        .analysis(&root)
        .ok_or_else(|| "The code analysis index is still building".to_owned())?;
    let index = Arc::clone(&state.analysis_index);
    tauri::async_runtime::spawn_blocking(move || {
        let run = index.begin_run();
        let mut files = 0usize;
        let mut total = 0usize;
        {
            let data = data.lock().unwrap();
            for file in data.files() {
                if !index.is_current_run(run) {
                    let _ = on_event.send(SecurityEvent::Done {
                        files: 0,
                        findings: 0,
                        cancelled: true,
                    });
                    return Ok(());
                }
                let Ok(text) =
                    std::fs::read_to_string(std::path::Path::new(&root).join(&file.path))
                else {
                    continue;
                };
                files += 1;
                let ext = file.path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
                let findings = security::scan_file(&file.path, ext, &text, &file.calls);
                total += findings.len();
                if !findings.is_empty() {
                    let _ = on_event.send(SecurityEvent::Batch { findings });
                }
            }
        }
        let _ = on_event.send(SecurityEvent::Done {
            files,
            findings: total,
            cancelled: false,
        });
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The workspace's import graph with its cycles, in one answer.
#[tauri::command]
pub async fn analysis_import_graph(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<ImportGraph, String> {
    let data = analysis_of(&state, repo)?;
    let data = data.lock().unwrap();
    Ok(imports::import_graph(&data))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &std::path::Path, path: &str, text: &str) {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap_or(root)).unwrap();
        std::fs::write(file, text).unwrap();
    }

    fn seeded() -> (tempfile::TempDir, Arc<AnalysisIndex>, String) {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.rs", "pub fn start() -> u32 { middle() + helper() }\nfn middle() -> u32 { helper() }\nfn helper() -> u32 { 7 }\nfn orphan() -> u32 { 0 }\n");
        let index = Arc::new(AnalysisIndex::new());
        let root = dir.path().display().to_string();
        index.build_blocking(None, &root, None).unwrap();
        (dir, index, root)
    }

    #[test]
    fn build_publishes_status_and_serves_queries() {
        let (_dir, index, root) = seeded();
        let status = index.status(&root);
        assert_eq!(status.state, AnalysisState::Ready);
        assert_eq!(status.files, 1);
        assert_eq!(status.symbols, 4);
        assert_eq!(status.calls, 3);

        let data = index.analysis(&root).unwrap();
        let graph = data
            .lock()
            .unwrap()
            .call_graph("helper", None, Direction::Callers, 2);
        // helper is called by middle (direct) and start (through middle, depth 2).
        assert_eq!(graph.nodes.len(), 3);
        let names: Vec<&str> = graph.nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(
            names.contains(&"start") && names.contains(&"middle"),
            "{names:?}"
        );

        index.remove(&root);
        assert_eq!(index.status(&root).state, AnalysisState::Empty);
    }

    #[test]
    fn watcher_batches_reach_the_analysis() {
        let (dir, index, root) = seeded();
        write(dir.path(), "b.rs", "fn extra() { helper(); }\n");
        index.apply_changes(None, &root, vec!["b.rs".to_owned()]);
        let mut landed = false;
        for _ in 0..100 {
            let data = index.analysis(&root).unwrap();
            if data.lock().unwrap().lookup("extra").len() == 1 {
                landed = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(landed, "the watcher batch reached the analysis");
    }

    #[test]
    fn a_cancelled_build_keeps_the_ready_analysis() {
        let (_dir, index, root) = seeded();
        let big = tempfile::tempdir().unwrap();
        for i in 0..1500 {
            write(
                big.path(),
                &format!("f{i:04}.rs"),
                "fn big() -> u32 { 0 }\n",
            );
        }
        let big_root = big.path().display().to_string();
        let builder = {
            let index = Arc::clone(&index);
            std::thread::spawn(move || index.build_blocking(None, &big_root, None))
        };
        std::thread::sleep(std::time::Duration::from_millis(5));
        index.cancel();
        let _ = builder.join().unwrap();
        // Whichever way the big build ended, the seeded root's analysis still serves.
        let data = index.analysis(&root).unwrap();
        assert_eq!(data.lock().unwrap().lookup("helper").len(), 1);
    }
}
