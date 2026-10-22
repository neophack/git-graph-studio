//! The on-demand lifetime of the symbol and analysis indexes (modules 5 and 17): nothing
//! builds them on a folder open — the first query that needs one does (the command
//! adapters' `ensure_*`) — and this sweeper drops each once it has sat idle, so a large
//! tree's indexes hold memory only while somebody is using them. The analysis has no
//! disk copy and is released soon after its last report; the symbol index persists under
//! `~/.ggs/index/`, so its next query only resumes it, and it is kept longer because
//! Go-to-Definition comes in bursts while editing. A release announces the root's
//! `Empty` status on the same events the builds report on, then hands the freed heap
//! back to the OS — dropping the tables only returns it to the allocator.
//!
//! The same look retires the two other caches a large tree used to pin for the process's
//! life: the walked file list (every reader asks with a seconds-long freshness window, so
//! an older list is never served again) and a launch file's prewarmed rope the page never
//! claimed.

use std::sync::Arc;
use std::time::Duration;

use ggs_analysis::index::{AnalysisIndex, ANALYSIS_INDEX_EVENT};
use ggs_base::sink::EventSink;
use ggs_index::symbols::index::{SymbolIndex, SYMBOL_INDEX_EVENT};

/// How long an analysis outlives its last use: covers the think time between the Module
/// Analysis page's filter and focus refetches and a hop between the analysis pages.
pub const ANALYSIS_IDLE: Duration = Duration::from_secs(60);
/// How long the symbol index outlives its last query.
pub const SYMBOL_IDLE: Duration = Duration::from_secs(5 * 60);
/// A walked file list older than this is dropped (the readers' window is 5 s).
pub const FILE_LIST_STALE: Duration = Duration::from_secs(30);
/// A prewarmed launch document unclaimed for this long is dropped.
pub const PREWARM_STALE: Duration = Duration::from_secs(60);
/// How often the sweeper looks. A held index counts as used at each look, so its idle
/// time starts at most this long after the report holding it finished.
const SWEEP_EVERY: Duration = Duration::from_secs(15);

/// The windows one look applies — the constants above in the app, zero in the tests.
#[derive(Clone, Copy)]
pub struct Windows {
    pub symbol_idle: Duration,
    pub analysis_idle: Duration,
    pub file_list_stale: Duration,
    pub prewarm_stale: Duration,
}

pub const WINDOWS: Windows = Windows {
    symbol_idle: SYMBOL_IDLE,
    analysis_idle: ANALYSIS_IDLE,
    file_list_stale: FILE_LIST_STALE,
    prewarm_stale: PREWARM_STALE,
};

/// What the sweeper releases: the two indexes and the walked file list.
pub struct Leased {
    pub symbols: Arc<SymbolIndex>,
    pub analysis: Arc<AnalysisIndex>,
    pub file_list: Arc<ggs_fs::FileListCache>,
}

/// Start the sweeper thread (once, from the composition root's setup).
pub fn start(app: tauri::AppHandle, leased: Leased) {
    let sink = crate::events::TauriEvents(app);
    let spawned = std::thread::Builder::new()
        .name("ggs-index-lease".to_owned())
        .spawn(move || loop {
            std::thread::sleep(SWEEP_EVERY);
            sweep(&sink, &leased, WINDOWS);
        });
    if let Err(error) = spawned {
        eprintln!("[index] the idle sweeper did not start: {error}");
    }
}

/// One look: release what has been idle past its window, announce the indexes' new
/// state, trim the heap. Answers how many things were released.
pub fn sweep(sink: &dyn EventSink, leased: &Leased, windows: Windows) -> usize {
    let Leased {
        symbols,
        analysis,
        file_list,
    } = leased;
    let (symbol_idle, analysis_idle) = (windows.symbol_idle, windows.analysis_idle);
    let released_analysis = analysis.release_idle(analysis_idle);
    for root in &released_analysis {
        if let Ok(payload) = serde_json::to_value(analysis.status(root)) {
            sink.emit(ANALYSIS_INDEX_EVENT, payload);
        }
    }
    let released_symbols = symbols.release_idle(symbol_idle);
    for root in &released_symbols {
        if let Ok(payload) = serde_json::to_value(symbols.status(root)) {
            sink.emit(SYMBOL_INDEX_EVENT, payload);
        }
    }
    let released_lists = file_list.release_older_than(windows.file_list_stale);
    let released_prewarm = usize::from(ggs_text::viewer::drop_stale_prewarm(windows.prewarm_stale));
    let released =
        released_analysis.len() + released_symbols.len() + released_lists + released_prewarm;
    if released > 0 {
        if !released_analysis.is_empty() || !released_symbols.is_empty() {
            eprintln!(
                "[index] released {} idle analysis and {} idle symbol index(es)",
                released_analysis.len(),
                released_symbols.len()
            );
        }
        trim_heap();
    }
    released
}

/// Ask the allocator to return its free pages to the OS. Rust's system allocator keeps
/// what a dropped index freed for reuse, so the process's memory would not shrink on its
/// own; each platform's allocator has the one call that gives it back.
fn trim_heap() {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetProcessHeap() -> *mut std::ffi::c_void;
            fn HeapCompact(heap: *mut std::ffi::c_void, flags: u32) -> usize;
        }
        // SAFETY: the process heap handle is valid for the life of the process, and
        // HeapCompact only coalesces and decommits free blocks of it.
        unsafe {
            HeapCompact(GetProcessHeap(), 0);
        }
    }
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        extern "C" {
            fn malloc_trim(pad: usize) -> i32;
        }
        // SAFETY: glibc's malloc_trim only releases free memory at the arenas' tops and
        // free pages inside them; it touches no live allocation.
        unsafe {
            malloc_trim(0);
        }
    }
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
        }
        // SAFETY: a null zone means every zone; the call only returns free pages.
        unsafe {
            malloc_zone_pressure_relief(std::ptr::null_mut(), 0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ggs_base::sink::EventSink;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorded(Mutex<Vec<(String, serde_json::Value)>>);

    impl EventSink for Recorded {
        fn emit(&self, event: &str, payload: serde_json::Value) {
            self.0.lock().unwrap().push((event.to_owned(), payload));
        }
    }

    #[test]
    fn a_sweep_releases_both_indexes_and_announces_their_empty_status() {
        let repo = tempfile::tempdir().unwrap();
        std::fs::write(
            repo.path().join("a.rs"),
            "fn alpha() { beta(); }\nfn beta() {}\n",
        )
        .unwrap();
        let home = tempfile::tempdir().unwrap();
        let root = repo.path().display().to_string();
        let leased = Leased {
            symbols: Arc::new(SymbolIndex::with_home(home.path().to_owned())),
            analysis: Arc::new(AnalysisIndex::new()),
            file_list: Arc::new(ggs_fs::FileListCache::default()),
        };
        leased.symbols.ensure_blocking(None, &root).unwrap();
        leased.analysis.ensure_blocking(None, &root).unwrap();
        leased.file_list.store(&root, vec!["a.rs".to_owned()]);

        let sink = Recorded::default();
        // Used just now: nothing goes inside the windows.
        assert_eq!(sweep(&sink, &leased, WINDOWS), 0);
        assert!(sink.0.lock().unwrap().is_empty());

        // Idle past zero-length windows: all three go, each index announced as empty. (The
        // prewarm window stays long: the slot is process-wide, and no test here owns it.)
        let now = Windows {
            symbol_idle: Duration::ZERO,
            analysis_idle: Duration::ZERO,
            file_list_stale: Duration::ZERO,
            prewarm_stale: PREWARM_STALE,
        };
        assert_eq!(sweep(&sink, &leased, now), 3);
        let events = sink.0.lock().unwrap().clone();
        let names: Vec<&str> = events.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, [ANALYSIS_INDEX_EVENT, SYMBOL_INDEX_EVENT]);
        assert!(events
            .iter()
            .all(|(_, payload)| payload["state"] == "empty"));
        assert!(leased.analysis.analysis(&root).is_none());
        assert!(leased.symbols.lookup(&root, "alpha").is_none());
        assert_eq!(
            leased.file_list.release_older_than(Duration::ZERO),
            0,
            "the list already went"
        );
    }
}
