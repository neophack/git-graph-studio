//! The per-root analysis index (module 17's state half): one `AnalysisIndex` owns the
//! built analyses; a folder open builds in the background (half the cores), the explicit
//! rebuild takes them all, watcher batches update single files, and the streaming report
//! runners (`run_metrics` / `run_dead_code` / `run_security`) push their rows in batches
//! with a cancellation generation — the search view's rhythm (plan §3.4): a first batch
//! lands fast, and a newer run retires the older one. Progress reaches the frontend
//! through the ggs-base push seams (`BatchSink` over the command channel, the
//! `studio://analysis-index` event over `EventSink`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use rayon::prelude::*;

use ggs_base::sink::BatchSink;

use crate::bca;
use crate::deadcode::DeadRow;
use crate::metrics::MetricRow;
use crate::security::{self, Finding};
use crate::AnalysisData;

/// The event the Analysis sidebar listens to; the payload is an [`AnalysisStatus`].
pub const ANALYSIS_INDEX_EVENT: &str = "studio://analysis-index";

/// Rows per streamed batch — small enough that the first batch lands in milliseconds,
/// large enough that the channel is not the bottleneck (the metrics report batches by
/// file, which lands the same rhythm).
pub(crate) const REPORT_BATCH: usize = 256;

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
    Batch { rows: Vec<DeadRow> },
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
    pub fn start_build(self: &Arc<Self>, sink: Option<Arc<dyn ggs_base::sink::EventSink>>, root: &str) {
        let index = Arc::clone(self);
        let root = root.to_owned();
        std::thread::spawn(move || {
            let _ = index.build_on_blocking(sink.as_deref(), &root, None, index_threads(true));
        });
    }

    /// An explicit rebuild (the sidebar's button, `analysis_rebuild`, the MCP start): the
    /// user or the script is waiting, so every core is fair game.
    pub fn build_blocking(
        &self,
        sink: Option<&dyn ggs_base::sink::EventSink>,
        root: &str,
        channel: Option<&mut dyn BatchSink<AnalysisIndexEvent>>,
    ) -> Result<AnalysisStatus, String> {
        self.build_on_blocking(sink, root, channel, index_threads(false))
    }

    fn build_on_blocking(
        &self,
        sink: Option<&dyn ggs_base::sink::EventSink>,
        root: &str,
        channel: Option<&mut dyn BatchSink<AnalysisIndexEvent>>,
        threads: usize,
    ) -> Result<AnalysisStatus, String> {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let is_current = || self.generation.load(Ordering::SeqCst) == generation;
        // The report callback meets the &mut BatchSink through a Mutex (the symbol index's
        // bridge — the callback must stay Fn + Sync across rayon workers).
        let channel = channel.map(Mutex::new);
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
            if let Some(channel) = &channel {
                let _ = channel
                    .lock()
                    .unwrap()
                    .send(AnalysisIndexEvent::Progress { done, total });
            }
            if let Some(sink) = sink {
                if let Ok(payload) = serde_json::to_value(self.status(root)) {
                    sink.emit(ANALYSIS_INDEX_EVENT, payload);
                }
            }
        };
        let built = AnalysisData::build(root, threads, &report, &|| !is_current());
        // A cancelled build leaves the previous analysis standing, like the symbol index —
        // and its STATUS too: the progress report left "Building N/M" on the note, and a
        // cancelled build never clears it (a report run bumps the same generation, so
        // "open a report while a rebuild streams" strands the stale counter forever).
        let data = match built {
            Some(data) => data,
            None => {
                if let Some(existing) = self.data(root) {
                    // The cancelled build's generation was retired, the installed
                    // analysis stands: restore its READY status over the stranded
                    // "Building N/M" note.
                    let status = existing.lock().map(|data| ready_status(&data));
                    if let Ok(status) = status {
                        self.note(root, status);
                    }
                } else {
                    self.note(root, AnalysisStatus::empty());
                }
                if let Some(channel) = &channel {
                    let _ = channel.lock().unwrap().send(AnalysisIndexEvent::Done {
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
        if let Some(channel) = &channel {
            let _ = channel.lock().unwrap().send(AnalysisIndexEvent::Done {
                files: stats.files,
                symbols: stats.symbols,
                calls: stats.calls,
                cancelled: false,
            });
        }
        if let Some(sink) = sink {
            if let Ok(payload) = serde_json::to_value(self.status(root)) {
                sink.emit(ANALYSIS_INDEX_EVENT, payload);
            }
        }
        Ok(stats)
    }

    /// Apply a watcher batch to the root's analysis on a background thread.
    pub fn apply_changes(
        self: &Arc<Self>,
        sink: Option<Arc<dyn ggs_base::sink::EventSink>>,
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
            if let Some(sink) = sink.as_deref() {
                if let Ok(payload) = serde_json::to_value(index.status(&root)) {
                    sink.emit(ANALYSIS_INDEX_EVENT, payload);
                }
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

/// How many threads a build may take — the symbol index's budget, reached through its
/// public helper so the two indexes always agree.
fn index_threads(background: bool) -> usize {
    ggs_index::symbols::index::SymbolIndex::index_threads(background)
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

/* ---------- The streaming report runners ---------- */

/// Every function and method with its measured shape, streamed in batches. The hotspot
/// column blends the symbol index's occurrence counts in when they have landed (`refs`);
/// the big-code-analysis columns (cognitive complexity, Halstead, LLOC, MI) enrich each
/// batch outside the analysis lock — a re-read per report, the security scan's rhythm.
pub fn run_metrics(
    index: &AnalysisIndex,
    data: &Arc<Mutex<AnalysisData>>,
    root: &str,
    refs: &HashMap<String, usize>,
    sink: &mut dyn BatchSink<MetricsEvent>,
) {
    let run = index.begin_run();
    // Base rows under the lock (the index already measured the shape); the
    // enrichment parses outside it, so the analysis keeps serving queries.
    let mut files: Vec<(String, Vec<MetricRow>)> = {
        let data = data.lock().unwrap();
        data.files()
            .iter()
            .map(|file| {
                (
                    file.path.clone(),
                    crate::metrics::rows_for_file(file, &|name| refs.get(name).copied().unwrap_or(0)),
                )
            })
            .collect()
    };
    let file_count = files.len();
    let mut functions = 0usize;
    for batch in files.chunks_mut(REPORT_BATCH) {
        if !index.is_current_run(run) {
            let _ = sink.send(MetricsEvent::Done {
                files: 0,
                functions: 0,
                cancelled: true,
            });
            return;
        }
        batch.par_iter_mut().for_each(|(path, rows)| {
            let ext = path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
            if let Ok(text) = std::fs::read_to_string(std::path::Path::new(root).join(path.as_str())) {
                bca::enrich_file(ext, &text, rows);
            }
        });
        functions += batch.iter().map(|(_, rows)| rows.len()).sum::<usize>();
        let rows: Vec<MetricRow> = batch
            .iter()
            .flat_map(|(_, rows)| rows.iter().cloned())
            .collect();
        let _ = sink.send(MetricsEvent::Batch { rows });
    }
    let _ = sink.send(MetricsEvent::Done {
        files: file_count,
        functions,
        cancelled: false,
    });
}

/// Declarations no call site in the workspace spells, streamed in batches.
pub fn run_dead_code(
    index: &AnalysisIndex,
    data: &Arc<Mutex<AnalysisData>>,
    include_exported: bool,
    sink: &mut dyn BatchSink<DeadCodeEvent>,
) {
    let run = index.begin_run();
    let rows = {
        let data = data.lock().unwrap();
        crate::deadcode::dead_rows(&data, include_exported)
    };
    for batch in rows.chunks(REPORT_BATCH) {
        if !index.is_current_run(run) {
            let _ = sink.send(DeadCodeEvent::Done {
                found: 0,
                cancelled: true,
            });
            return;
        }
        let _ = sink.send(DeadCodeEvent::Batch {
            rows: batch.to_vec(),
        });
    }
    let _ = sink.send(DeadCodeEvent::Done {
        found: rows.len(),
        cancelled: false,
    });
}

/// The rule-based security scan (secrets, dangerous and weak-crypto APIs), streamed in
/// batches. Pattern rules need the raw text, so the files are re-read here — a report
/// run, not the index's hot path.
pub fn run_security(
    index: &AnalysisIndex,
    data: &Arc<Mutex<AnalysisData>>,
    root: &str,
    sink: &mut dyn BatchSink<SecurityEvent>,
) {
    let run = index.begin_run();
    let mut files = 0usize;
    let mut total = 0usize;
    {
        let data = data.lock().unwrap();
        for file in data.files() {
            if !index.is_current_run(run) {
                let _ = sink.send(SecurityEvent::Done {
                    files: 0,
                    findings: 0,
                    cancelled: true,
                });
                return;
            }
            let Ok(text) = std::fs::read_to_string(std::path::Path::new(root).join(&file.path))
            else {
                continue;
            };
            files += 1;
            let ext = file.path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
            let findings = security::scan_file(&file.path, ext, &text, &file.calls);
            total += findings.len();
            if !findings.is_empty() {
                let _ = sink.send(SecurityEvent::Batch { findings });
            }
        }
    }
    let _ = sink.send(SecurityEvent::Done {
        files,
        findings: total,
        cancelled: false,
    });
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
            .call_graph("helper", None, crate::Direction::Callers, 2);
        // helper is called by middle (direct) and start (through middle, depth 2).
        assert_eq!(graph.nodes.len(), 3);
        let names: Vec<&str> = graph.nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(
            names.contains(&"start") && names.contains(&"middle"),
            "{names:?}"
        );

        // The whole seed sits in one file, so the module graph has no cross-file edge.
        let modules = crate::modules::module_graph(&data.lock().unwrap(), &[]);
        assert!(modules.edges.is_empty());
        assert_eq!(modules.modules.len(), 1);

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

    #[test]
    fn the_report_runners_stream_batches_through_a_sink() {
        use ggs_base::sink::VecSink;
        let (_dir, index, root) = seeded();
        let data = index.analysis(&root).unwrap();

        let mut metrics_sink = VecSink(Vec::new());
        run_metrics(&index, &data, &root, &HashMap::new(), &mut metrics_sink);
        assert!(metrics_sink.0.len() >= 2);
        assert!(matches!(
            metrics_sink.0.last(),
            Some(MetricsEvent::Done { cancelled: false, .. })
        ));

        let mut dead_sink = VecSink(Vec::new());
        run_dead_code(&index, &data, false, &mut dead_sink);
        assert!(matches!(
            dead_sink.0.last(),
            Some(DeadCodeEvent::Done { .. })
        ));

        let mut security_sink = VecSink(Vec::new());
        run_security(&index, &data, &root, &mut security_sink);
        assert!(matches!(
            security_sink.0.last(),
            Some(SecurityEvent::Done { .. })
        ));
    }
}
