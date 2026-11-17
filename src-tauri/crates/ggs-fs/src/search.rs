//! ggs-fs::search — a single file's byte-pattern search (module 7's hex viewer), streamed
//! and cancellable: the file is read in 4 MiB windows, each scanned with memchr's
//! substring search, and the hit offsets cross in batches the moment they are found. The
//! searched bytes never leave the backend — the multi-gigabyte binary the hex viewer
//! searches used to cross the IPC bridge in 1 MiB base64 chunks for a naive byte-compare
//! loop in the webview (principle 4: heavy work runs in the backend and streams).

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::time::Instant;

use ggs_base::sink::BatchSink;
use serde::Serialize;

/// The read window one pass scans; a hit straddling the boundary is found through the
/// tail overlap (needle − 1 bytes ride into the next window).
const WINDOW: usize = 4 * 1024 * 1024;

/// Hits cross in batches of this many offsets — a pattern matching every other byte of a
/// gigabyte still streams in bounded messages.
const BATCH: usize = 1024;

/// One push of the byte search over the Channel: the scan's progress (one per window), a
/// batch of hit offsets, or the final tally. The variant's own `rename_all` renames the
/// fields — the enum-level attribute names the variants only (the dump scan's
/// "elapsed_ms crossing as snake_case" bug, 2026-11-15).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ByteSearchEvent {
    #[serde(rename_all = "camelCase")]
    Progress { scanned: u64, total: u64 },
    Batch { offsets: Vec<u64> },
    #[serde(rename_all = "camelCase")]
    Done {
        hits: u64,
        elapsed_ms: u64,
        cancelled: bool,
    },
}

/// The in-flight search's cancellation slot (one per window — a newer search retires the
/// running one, the workspace search's own convention).
#[derive(Default)]
pub struct ByteSearchState {
    generation: ggs_base::cancel::Generation,
}

impl ByteSearchState {
    pub fn next(&self) -> u64 {
        self.generation.next()
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.generation.is_current(generation)
    }

    pub fn cancel(&self) {
        self.generation.cancel();
    }
}

/// Search `path` for every occurrence of `needle`, streaming the offsets ascending.
/// `cancel()` turning true stops the scan at the next window boundary; the `done` event
/// lands either way, so the view never waits on a search that will not finish.
pub fn search_bytes(
    path: &Path,
    needle: &[u8],
    cancel: &dyn Fn() -> bool,
    sink: &mut dyn BatchSink<ByteSearchEvent>,
) -> Result<(), String> {
    if needle.is_empty() {
        return Err("an empty pattern matches every offset".to_owned());
    }
    let started = Instant::now();
    let mut file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let total = file.metadata().map_err(|e| e.to_string())?.len();
    let overlap = needle.len() - 1;
    let mut buf = vec![0u8; overlap + WINDOW];
    let mut hits: u64 = 0;
    let mut pending: Vec<u64> = Vec::new();
    let mut cancelled = false;
    // The bytes read so far (the progress event's numerator — reaches the file size).
    let mut scanned = 0u64;
    // The absolute offset `buf[0]` holds. The first window reads from the file's head
    // with no carry; later windows keep the previous tail in `buf[..overlap]` so a
    // needle straddling the boundary is found.
    let mut window_start = 0u64;
    // The first offset a window may report: a match starting earlier ends inside the
    // previous window (the overlap guarantees it) and was reported there.
    let mut floor = 0u64;
    let mut first = true;
    loop {
        let read_at = if first { 0 } else { overlap };
        let mut filled = 0usize;
        while filled < WINDOW {
            match file.read(&mut buf[read_at + filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(e) => return Err(format!("{}: {e}", path.display())),
            }
        }
        if filled == 0 {
            break;
        }
        let window = &buf[..read_at + filled];
        for at in memchr::memmem::find_iter(window, needle) {
            let offset = window_start + at as u64;
            if offset < floor {
                continue;
            }
            pending.push(offset);
            hits += 1;
            if pending.len() >= BATCH && !sink.send(ByteSearchEvent::Batch { offsets: std::mem::take(&mut pending) }) {
                // The receiver is gone (the view closed) — stop without a tally.
                return Ok(());
            }
        }
        if !pending.is_empty() && !sink.send(ByteSearchEvent::Batch { offsets: std::mem::take(&mut pending) }) {
            return Ok(());
        }
        // Carry the tail forward: the next window starts at its absolute offset, and the
        // report floor with it — matches starting before it completed inside this window.
        let carry = overlap.min(read_at + filled);
        buf.copy_within(read_at + filled - carry..read_at + filled, 0);
        window_start += (read_at + filled - carry) as u64;
        floor = window_start;
        first = false;
        scanned += filled as u64;
        if !sink.send(ByteSearchEvent::Progress { scanned, total }) {
            return Ok(());
        }
        if cancel() {
            cancelled = true;
            break;
        }
    }
    sink.send(ByteSearchEvent::Done {
        hits,
        elapsed_ms: started.elapsed().as_millis() as u64,
        cancelled,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ggs_base::sink::VecSink;

    /// Run a search over a temp file holding `bytes`, returning the flattened hits and
    /// the done tally.
    fn run(bytes: &[u8], needle: &[u8]) -> (Vec<u64>, ByteSearchEvent) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.bin");
        std::fs::write(&path, bytes).unwrap();
        let mut sink = VecSink(Vec::new());
        search_bytes(&path, needle, &|| false, &mut sink).unwrap();
        let mut offsets = Vec::new();
        let mut done = None;
        for event in sink.0 {
            match event {
                ByteSearchEvent::Batch { offsets: batch } => offsets.extend(batch),
                ByteSearchEvent::Done { .. } => done = Some(event),
                ByteSearchEvent::Progress { .. } => {}
            }
        }
        (offsets, done.expect("the done event always lands"))
    }

    #[test]
    fn hits_cross_ascending_with_the_tally() {
        let (offsets, done) = run(b"ab--ab--ab", b"ab");
        assert_eq!(offsets, vec![0, 4, 8]);
        assert!(matches!(done, ByteSearchEvent::Done { hits: 3, cancelled: false, .. }));
    }

    #[test]
    fn a_hit_straddling_the_window_boundary_is_found_once() {
        // A needle whose tail overhangs the window: found exactly once, at its real
        // offset — the overlap carry and the floor together (no miss, no duplicate).
        let needle = b"needle!";
        let mut bytes = vec![b'x'; WINDOW + 4096];
        let at = WINDOW - 3;
        bytes[at..at + needle.len()].copy_from_slice(needle);
        let (offsets, _) = run(&bytes, needle);
        assert_eq!(offsets, vec![at as u64]);
    }

    #[test]
    fn a_needle_at_every_position_reports_each_once() {
        // The degenerate density: a one-byte needle on a uniform file crosses the
        // boundary logic a window's worth of times.
        let bytes = vec![7u8; WINDOW + 100];
        let (offsets, done) = run(&bytes, &[7u8]);
        assert_eq!(offsets.len(), bytes.len());
        assert!(offsets.windows(2).all(|w| w[1] == w[0] + 1));
        assert!(matches!(done, ByteSearchEvent::Done { hits, .. } if hits == bytes.len() as u64));
    }

    #[test]
    fn cancellation_stops_at_a_window_boundary_with_the_done() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.bin");
        std::fs::write(&path, vec![b'q'; WINDOW * 2]).unwrap();
        let mut sink = VecSink(Vec::new());
        let windows = std::cell::Cell::new(0u32);
        search_bytes(&path, b"zz", &|| {
            windows.set(windows.get() + 1);
            windows.get() > 1
        }, &mut sink)
        .unwrap();
        let done = sink.0.iter().find(|e| matches!(e, ByteSearchEvent::Done { .. }));
        assert!(matches!(done, Some(ByteSearchEvent::Done { cancelled: true, .. })));
    }

    #[test]
    fn an_empty_pattern_is_refused_and_a_missing_file_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.bin");
        std::fs::write(&path, b"data").unwrap();
        let mut sink = VecSink(Vec::new());
        assert!(search_bytes(&path, &[], &|| false, &mut sink).is_err());
        assert!(search_bytes(&dir.path().join("gone.bin"), b"x", &|| false, &mut sink).is_err());
    }

    #[test]
    fn progress_events_cover_the_whole_file() {
        let bytes = vec![0u8; WINDOW * 2 + 17];
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.bin");
        std::fs::write(&path, &bytes).unwrap();
        let mut sink = VecSink(Vec::new());
        search_bytes(&path, b"nothing", &|| false, &mut sink).unwrap();
        let last = sink.0.iter().rev().find_map(|e| match e {
            ByteSearchEvent::Progress { scanned, total } => Some((*scanned, *total)),
            _ => None,
        });
        assert_eq!(last, Some((bytes.len() as u64, bytes.len() as u64)));
    }
}
