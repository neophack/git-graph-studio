//! The workspace text search: the streaming scan (path-ordered batches, the 200 ms
//! first-batch promise, the match cap, generation-counter cancellation), the one-shot
//! root search the `--measure` probe times, and the first-batch latency probe itself.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use regex::bytes::Regex;
use serde::Serialize;

use rayon::prelude::*;

use crate::scan::{read_searchable, scan_text, FileMatches, SearchMatch, MAX_TEXT_FILE};

/// The search stops after this many matches, reporting `truncated: true`.
pub(crate) const MAX_MATCHES: usize = 5000;

/// How long the file list serves repeat searches without a re-walk - shared with Quick Open's
/// cache, so one walk feeds both and Explorer mutations drop it for both.
pub const FILE_LIST_TTL: Duration = Duration::from_secs(5);

/// Files per streamed batch: small enough that the first batch lands within a few
/// milliseconds on any tree, large enough that rayon has work to spread across the cores.
const BATCH_FILES: usize = 256;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub files: Vec<FileMatches>,
    pub truncated: bool,
    /// How many files were scanned, for the results header.
    pub scanned: usize,
}

/// What the streaming search pushes over its channel: result batches in path order as the
/// scan proceeds, then exactly one `done` (also after a cancellation, so the view can settle).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SearchEvent {
    Batch {
        files: Vec<FileMatches>,
    },
    Done {
        scanned: usize,
        truncated: bool,
        cancelled: bool,
    },
}

/// The generation counter behind search cancellation: every search takes the next number
/// and stops as soon as the counter moves on (a newer search, or an explicit cancel).
#[derive(Default)]
pub struct SearchState {
    generation: AtomicU64,
}

impl SearchState {
    pub fn next(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    pub fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
}

/// One file's matches by size: small files go through the whole-read path, anything over
/// `MAX_TEXT_FILE` streams — a giant `.asc` trace is as searchable as a source file, without
/// ever holding it in memory. `None` leaves the file invisible to the search, the rules
/// [`read_searchable`] already applies.
fn scan_file(
    path: &Path,
    matcher: &Regex,
    budget: usize,
    cancelled: &dyn Fn() -> bool,
) -> Option<Vec<SearchMatch>> {
    let size = fs::metadata(path).map(|m| m.len()).unwrap_or(u64::MAX);
    if size > MAX_TEXT_FILE {
        return scan_stream(path, matcher, budget, cancelled);
    }
    let (text, _) = read_searchable(path)?;
    Some(scan_text(&text, matcher))
}

/// [`scan_text`] over a file too large to read whole: the bounded line reader the CAN log
/// walks use keeps memory flat at any size (an overlong, newline-less line is consumed and
/// skipped), the scan stops at `budget` matches so a needle-a-line file cannot grow the
/// result past what the match cap would keep anyway, and `cancelled` is honoured every few
/// thousand lines so a superseded search stops mid-gigabyte. A binary head or a BOM-marked
/// UTF-16 body (which would need whole-file decoding) returns `None`, as today.
fn scan_stream(
    path: &Path,
    matcher: &Regex,
    budget: usize,
    cancelled: &dyn Fn() -> bool,
) -> Option<Vec<SearchMatch>> {
    use std::io::BufRead as _;
    let file = fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    // The peek through fill_buf does not consume: the sniff decides, then the walk starts at 0.
    let head = reader.fill_buf().ok()?;
    if ggs_text::encoding::looks_binary(head) {
        return None;
    }
    if matches!(encoding_rs::Encoding::for_bom(head), Some((e, _)) if e == encoding_rs::UTF_16LE || e == encoding_rs::UTF_16BE)
    {
        return None;
    }
    let mut out = Vec::new();
    let mut buf: Vec<u8> = Vec::with_capacity(256);
    let mut bytes = 0u64;
    let mut line_no = 0usize;
    loop {
        if line_no.is_multiple_of(4096) && cancelled() {
            return Some(out);
        }
        match ggs_base::fsx::read_line_bounded(&mut reader, &mut buf, &mut bytes) {
            Ok(ggs_base::fsx::LineRead::Line) => {
                line_no += 1;
                let mut text: Option<String> = None;
                for hit in matcher.find_iter(&buf) {
                    let text =
                        text.get_or_insert_with(|| String::from_utf8_lossy(&buf).into_owned());
                    let column = text
                        .char_indices()
                        .take_while(|(i, _)| *i < hit.start())
                        .count()
                        + 1;
                    let length = String::from_utf8_lossy(&buf[hit.start()..hit.end()])
                        .chars()
                        .count();
                    out.push(SearchMatch {
                        line: line_no,
                        column,
                        length,
                        text: text.clone(),
                    });
                }
                if out.len() >= budget {
                    return Some(out);
                }
            }
            Ok(ggs_base::fsx::LineRead::Overlong) => line_no += 1,
            Ok(ggs_base::fsx::LineRead::Eof) => return Some(out),
            Err(_) => return None,
        }
    }
}

/// The scan itself: the (path-ordered) file list is taken in batches, each batch read and
/// matched in parallel, and every batch with hits is handed to `emit` in path order - so the
/// view fills top-down while the walk continues. Stops at the match cap or when `cancelled`
/// says so; returns how many files were scanned, whether the cap was hit, and whether it was
/// cancelled. The cancellation flag is also honoured inside one file's streaming scan, so it
/// must be shareable across rayon workers.
pub fn search_files(
    files: &[String],
    root: &str,
    matcher: &Regex,
    mut emit: impl FnMut(Vec<FileMatches>),
    cancelled: impl Fn() -> bool + Send + Sync,
) -> (usize, bool, bool) {
    let mut scanned = 0usize;
    let mut budget = MAX_MATCHES;
    for batch in files.chunks(BATCH_FILES) {
        if cancelled() {
            return (scanned, false, true);
        }
        // The per-file early-stop budget of this batch: a snapshot, since the rayon workers
        // cannot see the budget the sequential loop trims as batches land.
        let cap = budget;
        let found: Vec<Option<FileMatches>> = batch
            .par_iter()
            .map(|relative| {
                let matches = scan_file(&Path::new(root).join(relative), matcher, cap, &cancelled)?;
                (!matches.is_empty()).then(|| FileMatches {
                    path: relative.clone(),
                    matches,
                })
            })
            .collect();
        scanned += batch.len();
        let mut hits: Vec<FileMatches> = found.into_iter().flatten().collect();
        let mut truncated = false;
        for file in &mut hits {
            if file.matches.len() > budget {
                file.matches.truncate(budget);
                truncated = true;
            }
            budget -= file.matches.len();
        }
        hits.retain(|f| !f.matches.is_empty());
        if !hits.is_empty() {
            emit(hits);
        }
        if truncated || budget == 0 {
            return (scanned, true, false);
        }
    }
    (scanned, false, false)
}

/// The one-shot search over a file list (the `--measure` probe; the command streams instead).
pub fn search_root(
    files: Vec<String>,
    root: &str,
    query: &str,
    is_regex: bool,
    case_sensitive: bool,
    word_only: bool,
) -> Result<SearchOutcome, String> {
    let matcher = crate::scan::build_matcher(query, is_regex, case_sensitive, word_only)?;
    let mut all = Vec::new();
    let (scanned, truncated, _) =
        search_files(&files, root, &matcher, |batch| all.extend(batch), || false);
    Ok(SearchOutcome {
        files: all,
        truncated,
        scanned,
    })
}

/// A literal, case-insensitive search over an already-walked file list (the `--measure` probe).
pub fn search_literal(files: &[String], root: &str, query: &str) -> Result<SearchOutcome, String> {
    search_root(files.to_vec(), root, query, false, false, false)
}

/// The first streaming batch's latency, in milliseconds — plan §3.4's "the first batch
/// reaches the UI within 200 ms" as a number instead of an adjective. The scan stops right
/// after the first batch lands (the stop flag trips on the emitted batch), so the probe pays
/// one batch's work, not the whole tree. The clock is microsecond — a small first batch can
/// land in well under a millisecond, and a 0 would read as "no batch". `Err` when the first
/// batch held no hits: the caller's query missed the head of the tree — pick one that hits.
pub fn search_first_batch_ms(files: &[String], root: &str, query: &str) -> Result<f64, String> {
    let matcher = crate::scan::build_matcher(query, false, false, false)?;
    let first_us = AtomicU64::new(0);
    let started = Instant::now();
    search_files(
        files,
        root,
        &matcher,
        |_batch| {
            first_us.store(
                u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX),
                Ordering::Relaxed,
            );
        },
        || first_us.load(Ordering::Relaxed) != 0,
    );
    let us = first_us.load(Ordering::Relaxed);
    (us > 0)
        .then_some(us as f64 / 1000.0)
        .ok_or_else(|| format!("the first batch found no {query:?} hits"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_finds_matches_and_respects_case_and_glob_filters() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn alpha() {}\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "alpha beta alpha\n").unwrap();
        let root = dir.path().display().to_string();

        let outcome = search_root(
            crate::scan::filter_paths(ggs_fs::walk_files(&root), "*.rs", ""),
            &root,
            "alpha",
            false,
            false,
            false,
        )
        .unwrap();
        assert_eq!(outcome.scanned, 1);
        assert_eq!(outcome.files.len(), 1);
        assert_eq!(outcome.files[0].path, "a.rs");

        let none = search_root(
            crate::scan::filter_paths(ggs_fs::walk_files(&root), "", ""),
            &root,
            "Alpha",
            false,
            true,
            false,
        )
        .unwrap();
        assert!(none.files.is_empty());
    }

    #[test]
    fn search_streams_batches_in_path_order_and_stops_when_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..600 {
            std::fs::write(dir.path().join(format!("f{i:04}.txt")), "needle\n").unwrap();
        }
        let root = dir.path().display().to_string();
        let files = ggs_fs::walk_files(&root);
        let matcher = crate::scan::build_matcher("needle", false, false, false).unwrap();

        // Uncancelled: every file is scanned, batches arrive in path order.
        let mut batches: Vec<Vec<String>> = Vec::new();
        let (scanned, truncated, cancelled) = search_files(
            &files,
            &root,
            &matcher,
            |b| batches.push(b.iter().map(|f| f.path.clone()).collect()),
            || false,
        );
        assert_eq!((scanned, truncated, cancelled), (600, false, false));
        assert!(
            batches.len() >= 2,
            "600 files must stream as more than one batch"
        );
        let flat: Vec<String> = batches.concat();
        assert_eq!(flat, files);

        // Cancelled after the first batch: the scan stops and says so. The flag is an atomic
        // because the cancellation is also checked inside rayon's per-file workers.
        let seen = std::sync::atomic::AtomicUsize::new(0);
        let (scanned, _, cancelled) = search_files(
            &files,
            &root,
            &matcher,
            |_| {
                seen.fetch_add(1, Ordering::SeqCst);
            },
            || seen.load(Ordering::SeqCst) >= 1,
        );
        assert!(cancelled);
        assert!(scanned < 600);
    }

    #[test]
    fn the_first_batch_probe_answers_one_batchs_latency_and_stops() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..600 {
            std::fs::write(dir.path().join(format!("f{i:04}.txt")), "needle\n").unwrap();
        }
        let root = dir.path().display().to_string();
        let files = ggs_fs::walk_files(&root);

        let ms = search_first_batch_ms(&files, &root, "needle").unwrap();
        assert!(
            ms > 0.0 && ms < 5000.0,
            "the first batch's latency is a real number ({ms} ms)"
        );

        // A single tiny file lands in well under a millisecond — the microsecond clock
        // keeps that a number, not a false "no batch".
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "// TODO one\nfn alpha() {}\n").unwrap();
        let files = ggs_fs::walk_files(&dir.path().display().to_string());
        let ms = search_first_batch_ms(&files, &dir.path().display().to_string(), "TODO").unwrap();
        assert!(
            ms > 0.0,
            "a sub-millisecond first batch still reports ({ms} ms)"
        );

        // A query the head of the tree never matches is an error, not a null: the caller
        // picks a query that hits early (the measure probe's own words).
        assert!(search_first_batch_ms(&files, &root, "no-such-needle").is_err());
    }

    #[test]
    fn oversized_text_files_are_searched_by_streaming() {
        let dir = tempfile::tempdir().unwrap();
        // A .asc-shaped trace past MAX_TEXT_FILE: filler lines plus one needle near the end.
        let filler = "   0.000001 1  100x  Rx   d 1 00\n";
        let lines = MAX_TEXT_FILE as usize / filler.len() + 100;
        let mut big = String::with_capacity(lines * filler.len());
        for _ in 0..lines {
            big.push_str(filler);
        }
        big.push_str("   9.999999 1  7FF  Rx   d 1 needle-byte\n");
        std::fs::write(dir.path().join("trace.asc"), &big).unwrap();
        let root = dir.path().display().to_string();

        let outcome =
            search_root(ggs_fs::walk_files(&root), &root, "needle", false, false, false).unwrap();
        assert_eq!(outcome.files.len(), 1);
        assert_eq!(outcome.files[0].path, "trace.asc");
        assert_eq!(outcome.files[0].matches.len(), 1);
        assert_eq!(outcome.files[0].matches[0].line, lines + 1);
        assert!(outcome.files[0].matches[0].text.contains("needle-byte"));
    }

    #[test]
    fn streaming_skips_binary_and_overlong_line_files_and_honours_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        // Binary past the size limit stays invisible (the sniff needs its NUL).
        let mut binary = vec![b'x'; MAX_TEXT_FILE as usize + 4096];
        binary[100] = 0;
        std::fs::write(dir.path().join("big.blf"), &binary).unwrap();
        // A newline-less file past the line cap: its single overlong line is skipped whole.
        let mut flat = vec![b'a'; MAX_TEXT_FILE as usize + 4096];
        flat.extend_from_slice(b"tail-needle\n");
        std::fs::write(dir.path().join("flat.log"), &flat).unwrap();
        // The same needle in a normally-lined file is found.
        std::fs::write(
            dir.path().join("ok.txt"),
            format!(
                "{}\nneedle\n",
                "padding".repeat(MAX_TEXT_FILE as usize / 6 + 8)
            ),
        )
        .unwrap();
        let root = dir.path().display().to_string();

        let outcome =
            search_root(ggs_fs::walk_files(&root), &root, "needle", false, false, false).unwrap();
        let paths: Vec<&str> = outcome.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["ok.txt"]);

        // A cancelled search stops mid-stream: the well-lined file yields nothing once the
        // flag is up before its first line settles in.
        let matcher = crate::scan::build_matcher("needle", false, false, false).unwrap();
        let hits =
            scan_stream(&dir.path().join("ok.txt"), &matcher, MAX_MATCHES, &|| true).unwrap();
        assert!(hits.is_empty());
        let hits =
            scan_stream(&dir.path().join("ok.txt"), &matcher, MAX_MATCHES, &|| false).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn streaming_stops_at_the_match_budget() {
        let dir = tempfile::tempdir().unwrap();
        // A needle-a-line file past the size limit: the scan stops at the budget it was given,
        // not at the file's end.
        let line = "needle\n".repeat(16);
        let big = line.repeat(MAX_TEXT_FILE as usize / line.len() + 1);
        std::fs::write(dir.path().join("many.txt"), &big).unwrap();
        let matcher = crate::scan::build_matcher("needle", false, false, false).unwrap();
        let hits = scan_stream(&dir.path().join("many.txt"), &matcher, 100, &|| false).unwrap();
        assert_eq!(hits.len(), 100);
    }

    #[test]
    fn search_caps_the_total_matches_and_reports_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let line = "x\n".repeat(MAX_MATCHES / 2 + 10);
        std::fs::write(dir.path().join("a.txt"), &line).unwrap();
        std::fs::write(dir.path().join("b.txt"), &line).unwrap();
        std::fs::write(dir.path().join("c.txt"), "x\n").unwrap();
        let root = dir.path().display().to_string();
        let outcome = search_root(ggs_fs::walk_files(&root), &root, "x", false, false, false)
            .unwrap();
        assert!(outcome.truncated);
        assert_eq!(
            outcome.files.iter().map(|f| f.matches.len()).sum::<usize>(),
            MAX_MATCHES
        );
    }

    #[test]
    fn search_state_generations_cancel_older_searches() {
        let state = SearchState::default();
        let first = state.next();
        assert!(state.is_current(first));
        let second = state.next();
        assert!(!state.is_current(first));
        assert!(state.is_current(second));
        state.cancel();
        assert!(!state.is_current(second));
    }

    #[test]
    fn utf16_files_with_a_bom_are_searched_and_replaced_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "foo bar\nbaz\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        std::fs::write(dir.path().join("u.txt"), &bytes).unwrap();
        let root = dir.path().display().to_string();

        let outcome =
            search_root(ggs_fs::walk_files(&root), &root, "bar", false, false, false).unwrap();
        assert_eq!(outcome.files.len(), 1);
        assert_eq!(outcome.files[0].matches.len(), 1);
        assert_eq!(
            (
                outcome.files[0].matches[0].line,
                outcome.files[0].matches[0].column
            ),
            (1, 5)
        );
        assert_eq!(outcome.files[0].matches[0].text, "foo bar");
    }
}
