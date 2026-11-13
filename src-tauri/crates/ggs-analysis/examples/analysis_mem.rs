//! The Code Analysis memory bench (module 17, the viewer bench's precedent): one
//! example that builds a root's analysis and runs every report over a real tree,
//! reporting each phase's live heap, phase peak heap and peak process private bytes —
//! the numbers the memory work is measured against (`analysis_mem <root>`; the harness
//! runs it against a many-thousand-file tree).
//!
//! The heap numbers come from a counting global allocator; the process numbers come
//! from the OS (Windows: private committed bytes) sampled by a background thread, so
//! tree-sitter's own C-side allocations are seen too — the allocator counts only the
//! Rust heap. Tree-sitter parser trees never survive a file's extraction, so the
//! numbers to watch are the build phase's peak and the resident index after it.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicIsize, AtomicUsize, Ordering};
use std::time::Instant;

use ggs_base::sink::BatchSink;
use ggs_analysis::index::{run_dead_code, run_metrics, run_security};

struct Counting;

static LIVE: AtomicIsize = AtomicIsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if !ptr.is_null() {
            let now = LIVE.fetch_add(layout.size() as isize, Ordering::Relaxed)
                + layout.size() as isize;
            PEAK.fetch_max(now.max(0) as usize, Ordering::Relaxed);
        }
        ptr
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size() as isize, Ordering::Relaxed);
        System.dealloc(ptr, layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_ptr = System.realloc(ptr, layout, new_size);
        if !new_ptr.is_null() {
            let now = LIVE.fetch_add(new_size as isize - layout.size() as isize, Ordering::Relaxed)
                + new_size as isize
                - layout.size() as isize;
            PEAK.fetch_max(now.max(0) as usize, Ordering::Relaxed);
        }
        new_ptr
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc_zeroed(layout);
        if !ptr.is_null() {
            let now = LIVE.fetch_add(layout.size() as isize, Ordering::Relaxed)
                + layout.size() as isize;
            PEAK.fetch_max(now.max(0) as usize, Ordering::Relaxed);
        }
        ptr
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

/* ---------- The process-private-bytes sampler ---------- */

static RSS_NOW: AtomicUsize = AtomicUsize::new(0);
static RSS_PEAK: AtomicUsize = AtomicUsize::new(0);
static SAMPLER_RUN: AtomicIsize = AtomicIsize::new(1);

#[cfg(windows)]
fn private_bytes() -> usize {
    #[repr(C)]
    struct CountersEx {
        cb: u32,
        page_faults: u32,
        peak_working_set: usize,
        working_set: usize,
        quota_peak_paged_pool: usize,
        quota_paged_pool: usize,
        quota_peak_non_paged_pool: usize,
        quota_non_paged_pool: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
        private_usage: usize,
    }
    #[link(name = "psapi")]
    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn GetProcessMemoryInfo(
            process: isize,
            counters: *mut CountersEx,
            cb: u32,
        ) -> i32;
    }
    let mut counters = CountersEx {
        cb: std::mem::size_of::<CountersEx>() as u32,
        page_faults: 0,
        peak_working_set: 0,
        working_set: 0,
        quota_peak_paged_pool: 0,
        quota_paged_pool: 0,
        quota_peak_non_paged_pool: 0,
        quota_non_paged_pool: 0,
        pagefile_usage: 0,
        peak_pagefile_usage: 0,
        private_usage: 0,
    };
    unsafe {
        if GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters,
            std::mem::size_of::<CountersEx>() as u32,
        ) != 0
        {
            counters.private_usage
        } else {
            0
        }
    }
}

#[cfg(not(windows))]
fn private_bytes() -> usize {
    // Linux and macOS: the bench's heap numbers still work; the process number is a
    // Windows-only courtesy here, not worth a dependency.
    0
}

fn start_sampler() -> std::thread::JoinHandle<()> {
    std::thread::spawn(|| {
        while SAMPLER_RUN.load(Ordering::Relaxed) == 1 {
            let now = private_bytes();
            RSS_NOW.store(now, Ordering::Relaxed);
            RSS_PEAK.fetch_max(now, Ordering::Relaxed);
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    })
}

/// A report sink that drops every batch the moment it arrives — the report's memory is
/// what the producer holds, never the channel's contents.
struct Dropping {
    batches: usize,
    rows: usize,
}
impl Dropping {
    fn new() -> Dropping {
        Dropping {
            batches: 0,
            rows: 0,
        }
    }
}

impl<T: serde::Serialize> BatchSink<T> for Dropping {
    fn send(&mut self, batch: T) -> bool {
        // Serialize once, like the real Channel does, so the JSON pass is measured too.
        let json = serde_json::to_string(&batch).unwrap_or_default();
        self.rows += json.len();
        self.batches += 1;
        true
    }
}

fn mb(bytes: usize) -> f64 {
    bytes as f64 / 1048576.0
}

fn phase<F: FnOnce() -> R, R>(name: &str, body: F) -> R {
    PEAK.store(LIVE.load(Ordering::Relaxed).max(0) as usize, Ordering::Relaxed);
    RSS_PEAK.store(RSS_NOW.load(Ordering::Relaxed), Ordering::Relaxed);
    let started = Instant::now();
    let result = body();
    let elapsed = started.elapsed();
    let live = LIVE.load(Ordering::Relaxed).max(0) as usize;
    let peak = PEAK.load(Ordering::Relaxed);
    let rss_peak = RSS_PEAK.load(Ordering::Relaxed);
    println!(
        "{name:<22} live {live:>12} ({:>8.1} MB)   heap-peak {:>12} ({:>8.1} MB)   proc-peak {:>9.1} MB   {:>7.2?}",
        mb(live),
        peak,
        mb(peak),
        mb(rss_peak),
        elapsed
    );
    result
}

fn main() {
    let mut args = std::env::args().skip(1);
    let root = args.next().expect("usage: analysis_mem <root> [phase]");
    let only = args.next(); // run just one phase ("build") for quick iterations
    let sampler = start_sampler();
    let threads = ggs_index::symbols::index::SymbolIndex::index_threads(false);
    println!(
        "root {root}\nthreads {threads}\n{:>22}  {:>12}   {:>19}   {:>12}   {:>9}",
        "", "live heap", "heap peak", "", "process peak"
    );
    let run = |name: &str| only.as_deref().is_none_or(|p| p == "all" || p == name);

    // Phase 1: the build — walk, parse every file, derive the tables.
    let index = std::sync::Arc::new(ggs_analysis::index::AnalysisIndex::new());
    let data = phase("build", || {
        let data = ggs_analysis::AnalysisData::build(&root, threads, &|_, _| {}, &|| false)
            .unwrap();
        println!(
            "  files {} symbols {} calls {}",
            data.file_count(),
            data.symbol_count(),
            data.call_count()
        );
        std::sync::Arc::new(std::sync::Mutex::new(data))
    });
    if !run("build") {
        SAMPLER_RUN.store(0, Ordering::Relaxed);
        let _ = sampler.join();
        return;
    }

    // Phase 2: the Module Analysis graph, serialized like the command answers it.
    phase("module graph", || {
        let graph = ggs_analysis::modules::module_graph(&data.lock().unwrap(), &[]);
        let json = serde_json::to_string(&graph).unwrap();
        println!("  module graph json {} bytes", json.len());
    });

    // Phase 3: the architecture drawing (its own module graph pass inside).
    phase("module diagram", || {
        let diagram = ggs_analysis::diagram::module_diagram(
            &ggs_analysis::modules::module_graph(&data.lock().unwrap(), &[]),
            None,
            "",
            &[],
        );
        let json = serde_json::to_string(&diagram).unwrap();
        println!("  diagram json {} bytes", json.len());
    });

    // Phase 4: the Complexity & Hotspots report, streamed batch by batch.
    let mut sink = Dropping::new();
    phase("metrics", || {
        run_metrics(&index, &data, &root, &|_| 0, &mut sink);
        println!("  {} batches, {} json bytes", sink.batches, sink.rows);
    });

    // Phase 5: Dead Code.
    let mut sink = Dropping::new();
    phase("dead code", || {
        run_dead_code(&index, &data, false, &mut sink);
        println!("  {} batches, {} json bytes", sink.batches, sink.rows);
    });

    // Phase 6: the Security Scan.
    let mut sink = Dropping::new();
    phase("security", || {
        run_security(&index, &data, &root, &mut sink);
        println!("  {} batches, {} json bytes", sink.batches, sink.rows);
    });

    // Phase 7: the Import Graph.
    phase("import graph", || {
        let graph = ggs_analysis::imports::import_graph(&data.lock().unwrap());
        let json = serde_json::to_string(&graph).unwrap();
        println!("  import graph json {} bytes", json.len());
    });

    // Phase 8: the release — drop the analysis and confirm the heap comes back.
    phase("release", || {
        drop(data);
        let live = LIVE.load(Ordering::Relaxed).max(0) as usize;
        println!("  heap after release {:>8.1} MB", mb(live));
    });
    SAMPLER_RUN.store(0, Ordering::Relaxed);
    let _ = sampler.join();
}
