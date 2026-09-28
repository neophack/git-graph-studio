//! GGS-patch: per-opcode execution counters, behind `GGS_OPCODE_STATS` — the diagnosis of
//! the interpreter's share of a big-bundle load (claude-code's 3 MB bundle spends ~210 ms
//! of its activation executing; this says which opcodes own that time). The counters are a
//! plain shared map — the counting runs on the JS thread, the ranking prints from the main
//! thread at exit — and the hot path pays one atomic load for the off switch.
//!
//! `GGS_OPCODE_STATS=time` additionally records per-opcode TIME: one clock read per
//! instruction, attributed to the previous instruction's opcode (the delta until the next
//! instruction starts). The uniform ~20 ns of clock overhead rides on every instruction
//! equally, so count-heavy opcodes read a few ms hot — the shares, not the absolutes, are
//! the diagnosis.

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

fn counts() -> &'static Mutex<HashMap<&'static str, u64>> {
    static COUNTS: OnceLock<Mutex<HashMap<&'static str, u64>>> = OnceLock::new();
    COUNTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether the stats collection was asked for (checked once; the hot path reads this).
pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("GGS_OPCODE_STATS").is_some())
}

/// Whether per-opcode TIME collection was asked for (`GGS_OPCODE_STATS=time`).
pub fn timing() -> bool {
    static TIMING: OnceLock<bool> = OnceLock::new();
    *TIMING.get_or_init(|| std::env::var("GGS_OPCODE_STATS").as_deref() == Ok("time"))
}

thread_local! {
    /// The clock read at the previous instruction's start, and that instruction's opcode:
    /// the delta until THIS instruction's start is the previous one's execution time.
    static PREV: Cell<(Option<std::time::Instant>, u32)> = const { Cell::new((None, 0)) };
}

/// Cumulative nanoseconds per opcode (indexed by `Opcode as usize`), shared across
/// threads: the JS thread accumulates, the exit print reads from the main thread.
static NANOS: [std::sync::atomic::AtomicU64; 256] =
    [const { std::sync::atomic::AtomicU64::new(0) }; 256];

/// Count one execution of `opcode`, and time-attribute the previous one.
pub(crate) fn count(opcode: crate::vm::opcode::Opcode) {
    if timing() {
        let now = std::time::Instant::now();
        let (prev_time, prev_opcode) = PREV.get();
        if let Some(prev_time) = prev_time {
            let delta = now.saturating_duration_since(prev_time).as_nanos() as u64;
            NANOS[prev_opcode as usize].fetch_add(delta, std::sync::atomic::Ordering::Relaxed);
        }
        PREV.set((Some(now), opcode as u32));
    }
    if let Ok(mut counts) = counts().lock() {
        *counts.entry(opcode.as_str()).or_insert(0) += 1;
    }
}

/// Print the ranking (highest count first), if collection was on and counted anything.
pub fn print_totals() {
    let Ok(counts) = counts().lock() else { return };
    if counts.is_empty() {
        return;
    }
    let mut ranked: Vec<(&'static str, u64)> = counts.iter().map(|(k, v)| (*k, *v)).collect();
    ranked.sort_unstable_by(|a, b| b.1.cmp(&a.1));
    let total: u64 = ranked.iter().map(|(_, v)| v).sum();
    eprintln!("[opcode-stats] {total} instructions executed, top {}:", ranked.len().min(25));
    for (name, count) in ranked.iter().take(25) {
        eprintln!("[opcode-stats]   {name:<28} {count:>10} ({:.1}%)", (*count as f64 / total as f64) * 100.0);
    }
    drop(counts);
    // The time table: the same opcodes ranked by owned nanoseconds (only collected under
    // `GGS_OPCODE_STATS=time`).
    if timing() {
        let mut timed: Vec<(usize, u64)> = NANOS
            .iter()
            .enumerate()
            .map(|(idx, cell)| (idx, cell.load(std::sync::atomic::Ordering::Relaxed)))
            .filter(|(_, time)| *time > 0)
            .collect();
        if timed.is_empty() {
            return;
        }
        timed.sort_unstable_by(|a, b| b.1.cmp(&a.1));
        let total: u64 = timed.iter().map(|(_, t)| *t).sum();
        eprintln!("[opcode-stats] {:.1} ms attributed, top owners:", total as f64 / 1e6);
        for (idx, nanos) in timed.iter().take(20) {
            let opcode = crate::vm::opcode::Opcode::decode(*idx as u8);
            let count = counts_now(opcode);
            let per = if count > 0 { nanos / count } else { 0 };
            eprintln!(
                "[opcode-stats]   {:<28} {:>8.1} ms ({:>4.1}%) {:>10} calls  {:>4} ns/call",
                opcode.as_str(),
                *nanos as f64 / 1e6,
                (*nanos as f64 / total as f64) * 100.0,
                count,
                per
            );
        }
    }
}

fn counts_now(opcode: crate::vm::opcode::Opcode) -> u64 {
    counts()
        .lock()
        .ok()
        .and_then(|counts| counts.get(opcode.as_str()).copied())
        .unwrap_or(0)
}
