//! Memory-bounded viewing of enormous text files: a line-start byte index over the raw
//! file, plus windows read from disk on demand. A gigabyte trace costs the index — eight
//! bytes a line — instead of the whole decoded file; a single line of tens of millions of
//! characters is one index entry and however much of it a window asked for.
//!
//! The index builds in parallel in the background while the head (the first screens,
//! decoded once at open) serves immediately and an extrapolated line count drives the
//! scrollbar; the landing swaps in the exact count over the same `studio://viewer-lines`
//! event the rope viewer uses, so the frontend does not care which backend serves it.
//! Find streams the file in chunks and matches whole lines, exactly the rope viewer's
//! matcher over a scan that never holds the document. Documents here are read-only: this
//! tier serves the minified monsters whose enormous lines defeat every line window and the
//! files the rope backend refused — the view's Edit button still swaps the tab into the
//! whole-file editor, so nothing a JavaScript string can hold is beyond editing.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use serde::Serialize;

use super::doc;
use super::find::{FindOptions, MatchLoc, Matcher};
use super::{positioned_read, read_exact_at, LinesLanded, TailGate, HEAD_BYTES};

/// The index: every line's starting byte offset into the raw file. Line 0 starts after the
/// BOM when one exists; every later entry is the byte after a line break.
pub struct LineIndex {
    starts: Vec<u64>,
}

impl LineIndex {
    pub fn line_count(&self) -> usize {
        self.starts.len()
    }

    /// The raw byte range of lines `start..=end` (0-based, inclusive).
    fn byte_range(&self, start: usize, end: usize, total: u64) -> (u64, u64) {
        let from = self.starts[start];
        let to = if end + 1 < self.starts.len() {
            self.starts[end + 1]
        } else {
            total
        };
        (from, to)
    }
}

/// How the index counts a document whose encoding stores one character in two bytes:
/// `None` is the single-byte family (UTF-8 and every legacy multibyte whose trail bytes
/// never collide with `\n`), `Some(true)` UTF-16LE, `Some(false)` UTF-16BE.
fn utf16_of(encoding: &str) -> Option<bool> {
    match encoding {
        "utf-16le" => Some(true),
        "utf-16be" => Some(false),
        _ => None,
    }
}

/// The parallel index build: positioned reads in chunks, `memchr` for `\n` on each core,
/// offsets concatenated in order. UTF-16 checks the pairing (`0A 00` / `00 0A`) and the
/// code-unit parity, reading two bytes past its chunk end so a pair never straddles unseen.
fn build_index(
    path: &str,
    from: u64,
    total: u64,
    utf16: Option<bool>,
    bom: u64,
) -> Result<LineIndex, String> {
    use rayon::prelude::*;
    let file = File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let file = &file;
    const CHUNK: u64 = 16 << 20;
    let mut bounds: Vec<u64> = Vec::new();
    let mut at = from;
    while at < total {
        bounds.push(at);
        at += CHUNK;
    }
    bounds.push(total);
    let offsets: Vec<Vec<u64>> = bounds
        .par_windows(2)
        .map(|pair| {
            let (start, end) = (pair[0], pair[1]);
            // The +2 tail lets a UTF-16 pair complete; its offsets still report below `end`.
            let mut buf = vec![0u8; (end - start) as usize + 2];
            let len = (end - start) as usize;
            read_exact_at(file, &mut buf[..len], start).map_err(|e| format!("{path}: {e}"))?;
            if end < total {
                let _ = positioned_read(file, &mut buf[len..], end);
            }
            let mut found: Vec<u64> = Vec::new();
            let mut at = 0usize;
            while let Some(hit) = memchr::memchr(b'\n', &buf[at..len]) {
                let at_newline = at + hit;
                let raw = start + at_newline as u64;
                match utf16 {
                    Some(little) => {
                        let low_first = (raw - bom) % 2 == 0;
                        let paired = if little == low_first {
                            buf.get(at_newline + 1).copied() == Some(0)
                        } else {
                            buf.get(at_newline).copied() == Some(0)
                                && at_newline > 0
                                && buf[at_newline - 1] == b'\n'
                        };
                        if paired {
                            found.push(raw + 1);
                        }
                    }
                    None => found.push(raw + 1),
                }
                at = at_newline + 1;
            }
            Ok(found)
        })
        .collect::<Result<_, String>>()?;
    let mut starts: Vec<u64> = Vec::new();
    starts.push(from);
    for chunk in offsets {
        for offset in chunk {
            if offset > *starts.last().unwrap_or(&0) {
                starts.push(offset);
            }
        }
    }
    Ok(LineIndex { starts })
}

/// One open indexed document. The decoded head serves until the index lands; then windows
/// read their byte ranges straight from the file.
struct IndexedDoc {
    path: String,
    total: u64,
    /// The encoding id (`crate::encoding`) windows decode with.
    encoding: String,
    head_text: String,
    /// The handle window reads share — a fetch must not pay a file open per window.
    file: Mutex<Option<File>>,
    /// The extrapolated line count the scrollbar starts with.
    estimate: usize,
    /// The exact index once the background scan lands. `None` while building.
    index: RwLock<Option<Arc<LineIndex>>>,
    /// Set when the build failed: the head still serves, whole-file scans report this.
    error: Mutex<Option<String>>,
    gate: Arc<TailGate>,
    find_gen: AtomicU64,
}

impl IndexedDoc {
    fn line_count(&self) -> usize {
        match self
            .index
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            Some(index) => index.line_count(),
            None => self.estimate,
        }
    }

    /// Wait for the index to land (or fail), then report the verdict.
    fn wait_index(&self) -> Result<(), String> {
        self.gate.wait();
        match self
            .error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            Some(error) => Err(format!("the line index did not finish building: {error}")),
            None => Ok(()),
        }
    }

    /// The decoded text of lines `start..=end`. The head serves before the index lands;
    /// after that, byte ranges come off the disk and decode per window.
    fn window(&self, start: usize, end: usize) -> Result<Vec<String>, String> {
        let total = self.line_count().max(1);
        let start = start.min(total - 1);
        let end = end.min(total - 1);
        let index = self
            .index
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let Some(index) = index else {
            // Still building: the head covers what it covers, past it waits.
            if start >= self.head_lines() {
                self.wait_index()?;
                return self.window(start, end);
            }
            let end = end.min(self.head_lines().saturating_sub(1));
            return Ok(self.head_lines_text(start, end));
        };
        // One line's payload is capped (a single line of millions of characters serves a
        // leading slice); a window over the cap serves fewer lines than asked.
        const WINDOW_BYTES: u64 = 4 << 20;
        const LINE_BYTES: u64 = 1 << 20;
        // The cached handle, opened once and held for the document's life.
        let mut slot = self
            .file
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_none() {
            *slot = Some(File::open(&self.path).map_err(|e| format!("{}: {e}", self.path))?);
        }
        let file = slot.as_ref().expect("just opened");
        let mut lines = Vec::with_capacity(end.saturating_sub(start) + 1);
        let mut line = start;
        while line <= end {
            let (from, to) = index.byte_range(line, line, self.total);
            if to - from > LINE_BYTES {
                let mut buf = vec![0u8; LINE_BYTES as usize];
                read_exact_at(file, &mut buf, from).map_err(|e| format!("{}: {e}", self.path))?;
                let mut text = self.decode(&buf);
                text.pop(); // the newline the slice never reached
                text.push('…');
                lines.push(text);
            } else {
                // Accumulate consecutive lines while the window's payload stays bounded.
                let mut stop = line;
                while stop < end {
                    let (_, next_to) = index.byte_range(line, stop + 1, self.total);
                    if next_to - from > WINDOW_BYTES {
                        break;
                    }
                    stop += 1;
                }
                let (from, to) = index.byte_range(line, stop, self.total);
                let mut buf = vec![0u8; (to - from) as usize];
                read_exact_at(file, &mut buf, from).map_err(|e| format!("{}: {e}", self.path))?;
                let decoded = self.decode(&buf);
                let mut split: Vec<String> = decoded
                    .split('\n')
                    .map(|text| text.trim_end_matches('\r').to_owned())
                    .collect();
                // A range that ends on a line-start boundary carries the last line's own
                // `\n`; the empty split artefact after it is the *next* line's beginning,
                // not a line of this window. At the file's end there is no boundary — the
                // final (possibly empty) line is real and stays.
                if stop + 1 < index.line_count() && split.last().is_some_and(|text| text.is_empty())
                {
                    split.pop();
                }
                lines.append(&mut split);
                line = stop;
            }
            line += 1;
        }
        Ok(lines)
    }

    fn head_lines(&self) -> usize {
        self.head_text.split('\n').count()
    }

    fn head_lines_text(&self, start: usize, end: usize) -> Vec<String> {
        self.head_text
            .split('\n')
            .skip(start)
            .take(end - start + 1)
            .map(|text| text.trim_end_matches('\r').to_owned())
            .collect()
    }

    fn decode(&self, bytes: &[u8]) -> String {
        if self.encoding == "utf8" {
            return String::from_utf8_lossy(bytes).into_owned();
        }
        let encoding = encoding_rs::Encoding::for_label(self.encoding.as_bytes())
            .unwrap_or(encoding_rs::UTF_8);
        let (text, _) = encoding.decode_without_bom_handling(bytes);
        text.into_owned()
    }
}

#[derive(Default)]
pub struct IndexedState {
    next_id: AtomicU64,
    docs: Mutex<HashMap<u64, Arc<IndexedDoc>>>,
}

impl IndexedState {
    fn get(&self, doc_id: u64) -> Result<Arc<IndexedDoc>, String> {
        self.docs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&doc_id)
            .cloned()
            .ok_or_else(|| format!("No open indexed document {doc_id}"))
    }
}

/// The open result mirrors the rope viewer's (`viewer_open`), so the fast viewer serves
/// both backends through one code path.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedOpenResult {
    pub doc_id: u64,
    pub line_count: usize,
    pub language: String,
    pub syntax_name: String,
    pub encoding: String,
    pub eol: String,
}

/// A line with empty token spans — the shape `viewer_lines` serves, so the frontend's one
/// landing path serves both backends.
type PlainLine = (String, Vec<(usize, usize, String)>);

/// A window of lines, shaped as the rope viewer's `viewer_lines` result with empty token
/// spans: the indexed tier serves plain text (a gigabyte's highlight walk is not a
/// first-paint concern), and `tokens_pending: false` keeps the frontend from asking.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedLinesResult {
    pub start_line: usize,
    pub line_count: usize,
    pub lines: Vec<PlainLine>,
    pub tokens_pending: bool,
}

/// Open a file for indexed viewing: read and decode the head (the first screens, served
/// immediately), extrapolate the scrollbar's line count, and build the exact index in the
/// background. The landing emits `studio://viewer-lines` with the exact count.
#[tauri::command]
pub async fn indexed_open(
    state: tauri::State<'_, IndexedState>,
    app: tauri::AppHandle,
    path: String,
) -> Result<IndexedOpenResult, String> {
    let doc_id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let load = path.clone();
    let opened = tauri::async_runtime::spawn_blocking(move || open_indexed(&load))
        .await
        .map_err(|e| e.to_string())??;
    let IndexedHead {
        total,
        encoding,
        eol,
        head_bytes,
        head_text,
        bom,
    } = opened;
    let language = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    let syntax_name = doc::syntax_name_for(&language);
    let head_lines = head_text.split('\n').count().max(1);
    let per_line = (head_bytes / head_lines as u64).max(1);
    let estimate = head_lines + ((total - head_bytes) / per_line) as usize;
    let gate = TailGate::pending();
    let document = Arc::new(IndexedDoc {
        path: path.clone(),
        total,
        encoding: encoding.clone(),
        head_text,
        file: Mutex::new(None),
        estimate: estimate.max(head_lines),
        index: RwLock::new(None),
        error: Mutex::new(None),
        gate: Arc::clone(&gate),
        find_gen: AtomicU64::new(0),
    });
    state
        .docs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(doc_id, Arc::clone(&document));
    let result = IndexedOpenResult {
        doc_id,
        line_count: document.line_count(),
        language,
        syntax_name,
        encoding,
        eol,
    };
    // The exact index builds in the background; the head serves meanwhile.
    let scan_path = path.clone();
    let scan_from = bom;
    let utf16 = utf16_of(&document.encoding);
    let scan_doc = Arc::clone(&document);
    let scan_gate = Arc::clone(&gate);
    let spawned = std::thread::Builder::new()
        .name("indexed-scan".to_owned())
        .spawn(move || {
            let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                build_index(&scan_path, scan_from, scan_doc.total, utf16, scan_from)
            }));
            let mut landed = None;
            match built {
                Ok(Ok(index)) => {
                    let count = index.line_count();
                    *scan_doc
                        .index
                        .write()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::new(index));
                    landed = Some(count);
                }
                Ok(Err(error)) => {
                    *scan_doc
                        .error
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error);
                }
                Err(_) => {
                    *scan_doc
                        .error
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                        Some("the index build panicked".to_owned());
                }
            }
            scan_gate.land();
            if let Some(count) = landed {
                use tauri::Emitter;
                let _ = app.emit(
                    "studio://viewer-lines",
                    LinesLanded {
                        doc_id,
                        line_count: count,
                    },
                );
            }
        });
    if spawned.is_err() {
        *document
            .error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
            Some("the index build could not start".to_owned());
        gate.land();
    }
    Ok(result)
}

struct IndexedHead {
    total: u64,
    encoding: String,
    eol: String,
    head_bytes: u64,
    head_text: String,
    /// The byte offset line 0 starts at (past a BOM).
    bom: u64,
}

/// Read and decode the head: `HEAD_BYTES` extended to the next line break, the encoding
/// sniffed the way every reader of the app sniffs it.
fn open_indexed(path: &str) -> Result<IndexedHead, String> {
    let total = std::fs::metadata(path)
        .map_err(|e| format!("{path}: {e}"))?
        .len();
    let mut file = File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let mut head = vec![0u8; HEAD_BYTES.min(total as usize)];
    if !head.is_empty() {
        file.read_exact(&mut head)
            .map_err(|e| format!("{path}: {e}"))?;
    }
    if head.len() < total as usize {
        let mut slack = [0u8; 4096];
        loop {
            let read = file.read(&mut slack).map_err(|e| format!("{path}: {e}"))?;
            if read == 0 {
                break;
            }
            let stop = memchr::memchr(b'\n', &slack[..read]);
            let keep = match stop {
                Some(at) => at + 1,
                None => read,
            };
            head.extend_from_slice(&slack[..keep]);
            if stop.is_some() || head.len() >= HEAD_BYTES + (1 << 20) {
                break;
            }
        }
    }
    if crate::encoding::looks_binary(&head) {
        return Err(format!("{path}: binary file"));
    }
    let decoded = crate::encoding::decode(&head, None);
    let bom = match decoded.encoding {
        "utf8bom" => 3,
        "utf-16le" | "utf-16be" => 2,
        _ => 0,
    };
    Ok(IndexedHead {
        total,
        encoding: decoded.encoding.to_owned(),
        eol: decoded.eol.to_owned(),
        head_bytes: head.len() as u64,
        head_text: decoded.text,
        bom: bom as u64,
    })
}

/// The lines a window asked for — the fast viewer's fetch. `end` is inclusive.
#[tauri::command]
pub async fn indexed_lines(
    state: tauri::State<'_, IndexedState>,
    doc_id: u64,
    start: usize,
    end: usize,
) -> Result<IndexedLinesResult, String> {
    let doc = state.get(doc_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let line_count = doc.line_count();
        let lines = doc.window(start, end)?;
        Ok(IndexedLinesResult {
            start_line: start.min(line_count.max(1) - 1),
            line_count,
            lines: lines.into_iter().map(|text| (text, Vec::new())).collect(),
            tokens_pending: false,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The find result mirrors `viewer_find`'s.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedFindResult {
    pub matches: Vec<MatchLoc>,
    pub capped: bool,
    pub line_count: usize,
}

/// Find over the whole file by streaming it: chunks read off the disk, whole lines fed to
/// the same matcher the rope viewer uses. A newer find on the same document supersedes the
/// walk between chunks. A line past the cap is skipped rather than buffered whole.
#[tauri::command]
pub async fn indexed_find(
    state: tauri::State<'_, IndexedState>,
    doc_id: u64,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regexp: bool,
) -> Result<IndexedFindResult, String> {
    let doc = state.get(doc_id)?;
    let generation = doc.find_gen.fetch_add(1, Ordering::Relaxed) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        doc.wait_index()?;
        let matcher = Matcher::compile(
            &query,
            &FindOptions {
                case_sensitive,
                whole_word,
                regexp,
            },
        )?;
        const CHUNK: usize = 4 << 20;
        const LINE_CAP: usize = 4 << 20;
        let mut file = File::open(&doc.path).map_err(|e| format!("{}: {e}", doc.path))?;
        let mut matches: Vec<MatchLoc> = Vec::new();
        let mut capped = false;
        let mut carried: Vec<u8> = Vec::new();
        let mut line_no = 0usize;
        let mut chunk = vec![0u8; CHUNK];
        loop {
            let read = file
                .read(&mut chunk)
                .map_err(|e| format!("{}: {e}", doc.path))?;
            if read == 0 {
                break;
            }
            if doc.find_gen.load(Ordering::Relaxed) != generation {
                return Err("superseded".to_owned());
            }
            carried.extend_from_slice(&chunk[..read]);
            let mut from = 0usize;
            while let Some(hit) = memchr::memchr(b'\n', &carried[from..]) {
                let line_end = from + hit;
                let text = String::from_utf8_lossy(&carried[from..line_end]);
                for (start, end) in matcher.matches_in(&text, whole_word) {
                    if matches.len() >= super::find::MAX_FIND_MATCHES {
                        capped = true;
                        break;
                    }
                    matches.push(MatchLoc {
                        line: line_no,
                        start_col: start,
                        end_col: end,
                    });
                }
                line_no += 1;
                from = line_end + 1;
            }
            carried.drain(..from);
            if carried.len() > LINE_CAP {
                // A monster line: drop the buffer, its matches are not worth the memory.
                carried.clear();
                line_no += 1;
            }
        }
        if !carried.is_empty() {
            let text = String::from_utf8_lossy(&carried);
            for (start, end) in matcher.matches_in(&text, whole_word) {
                if matches.len() >= super::find::MAX_FIND_MATCHES {
                    capped = true;
                    break;
                }
                matches.push(MatchLoc {
                    line: line_no,
                    start_col: start,
                    end_col: end,
                });
            }
        }
        Ok(IndexedFindResult {
            matches,
            capped,
            line_count: doc.line_count(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drop an indexed document (its tab closed).
#[tauri::command]
pub fn indexed_close(state: tauri::State<IndexedState>, doc_id: u64) {
    let mut docs = state
        .docs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(doc) = docs.get(&doc_id) {
        doc.find_gen.fetch_add(1, Ordering::Relaxed);
    }
    docs.remove(&doc_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_file(name: &str, contents: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(name);
        std::fs::write(&path, contents).expect("write");
        (dir, path.display().to_string())
    }

    fn scratch_bytes(name: &str, bytes: &[u8]) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).expect("write");
        (dir, path.display().to_string())
    }

    /// Release-run latency probe of the indexed viewer against a real file:
    /// `GGS_BENCH_FILE=... cargo test --release indexed_bench -- --nocapture`. Reports the
    /// three numbers the felt open is made of: the head (what `indexed_open` returns), the
    /// full index build, and a far window's read.
    #[test]
    fn indexed_bench_real_file() {
        let Ok(path) = std::env::var("GGS_BENCH_FILE") else {
            return;
        };
        let t = std::time::Instant::now();
        let head = open_indexed(&path).expect("head");
        let head_ms = t.elapsed().as_millis();
        let gate = TailGate::pending();
        let doc = IndexedDoc {
            path: path.clone(),
            total: head.total,
            encoding: head.encoding.clone(),
            head_text: head.head_text.clone(),
            file: Mutex::new(None),
            estimate: 1,
            index: RwLock::new(None),
            error: Mutex::new(None),
            gate: Arc::clone(&gate),
            find_gen: AtomicU64::new(0),
        };
        let utf16 = utf16_of(&head.encoding);
        let t = std::time::Instant::now();
        let index = build_index(&path, head.bom, head.total, utf16, head.bom).expect("index");
        let index_ms = t.elapsed().as_millis();
        let lines = index.line_count();
        *doc.index
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::new(index));
        gate.land();
        let t = std::time::Instant::now();
        let window = doc.window(lines / 2, lines / 2 + 60).expect("window");
        let window_ms = t.elapsed().as_millis();
        let t = std::time::Instant::now();
        let again = doc.window(lines - 61, lines - 1).expect("tail window");
        let tail_ms = t.elapsed().as_millis();
        println!(
            "head={head_ms}ms index={index_ms}ms ({lines} lines, {} bytes) mid_window={window_ms}ms ({} lines) tail_window={tail_ms}ms ({} lines)",
            head.total,
            window.len(),
            again.len()
        );
    }

    #[test]
    fn windows_read_lines_from_the_index() {
        let text = (0..40_000)
            .map(|i| format!("line {i:05}\r\n"))
            .collect::<String>();
        let (_dir, path) = scratch_file("indexed.log", &text);
        // The head covers the first lines; the index lands in the background.
        let head = open_indexed(&path).unwrap();
        assert_eq!(head.encoding, "utf8");
        let doc = IndexedDoc {
            path: path.clone(),
            total: head.total,
            encoding: head.encoding.clone(),
            head_text: head.head_text.clone(),
            file: Mutex::new(None),
            estimate: head.head_text.split('\n').count(),
            index: RwLock::new(None),
            error: Mutex::new(None),
            gate: TailGate::pending(),
            find_gen: AtomicU64::new(0),
        };
        // Build the index inline (the background thread only wraps this).
        let index = build_index(&path, head.bom, head.total, None, head.bom).unwrap();
        assert_eq!(index.line_count(), 40_001); // the final empty line after the last \r\n
        *doc.index.write().unwrap() = Some(Arc::new(index));
        // A far window serves the real lines, CRLF stripped.
        let window = doc.window(39_995, 39_998).unwrap();
        assert_eq!(window[0], "line 39995");
        assert_eq!(window[3], "line 39998");
        // A window inside the head serves from the decoded head.
        let head_window = doc.window(0, 2).unwrap();
        assert_eq!(head_window, ["line 00000", "line 00001", "line 00002"]);
    }

    #[test]
    fn a_monster_line_is_one_index_entry_and_a_capped_slice() {
        // One line of 2 MB followed by ordinary lines: the index stays tiny and the window
        // read is bounded.
        let mut text = "x".repeat(2 << 20);
        text.push_str("\nafter the monster\nlast\n");
        let (_dir, path) = scratch_file("monster.txt", &text);
        let index = build_index(&path, 0, text.len() as u64, None, 0).unwrap();
        assert_eq!(index.line_count(), 4); // monster, after, last, trailing empty
        let (from, to) = index.byte_range(1, 1, text.len() as u64);
        assert_eq!((to - from) as usize, "after the monster\n".len());
    }

    #[test]
    fn utf16_lines_index_on_code_unit_pairs() {
        let encoded: Vec<u8> = "first\r\nsecond\nthird"
            .encode_utf16()
            .flat_map(|unit| unit.to_le_bytes())
            .collect();
        let mut bytes = vec![0xFF, 0xFE]; // the LE BOM
        bytes.extend_from_slice(&encoded);
        let (_dir, path) = scratch_bytes("utf16.txt", &bytes);
        let index = build_index(&path, 2, bytes.len() as u64, Some(true), 2).unwrap();
        assert_eq!(index.line_count(), 3);
    }

    #[test]
    fn find_streams_matches_over_the_file() {
        let text = (0..20_000)
            .map(|i| format!("needle {i} plain\n"))
            .collect::<String>();
        let (_dir, path) = scratch_file("find.log", &text);
        // Wire the document like indexed_open does, but synchronously.
        let head = open_indexed(&path).unwrap();
        let gate = TailGate::pending();
        let doc = Arc::new(IndexedDoc {
            path: path.clone(),
            total: head.total,
            encoding: head.encoding,
            head_text: head.head_text,
            file: Mutex::new(None),
            estimate: 20_001,
            index: RwLock::new(None),
            error: Mutex::new(None),
            gate: Arc::clone(&gate),
            find_gen: AtomicU64::new(0),
        });
        let index = build_index(&path, head.bom, head.total, None, head.bom).unwrap();
        *doc.index.write().unwrap() = Some(Arc::new(index));
        gate.land();
        let matcher = Matcher::compile(
            "needle 199",
            &FindOptions {
                case_sensitive: false,
                whole_word: false,
                regexp: false,
            },
        )
        .unwrap();
        let mut matches = Vec::new();
        let mut file = File::open(&path).unwrap();
        let mut chunk = vec![0u8; 8192];
        let mut carried: Vec<u8> = Vec::new();
        let mut line_no = 0usize;
        loop {
            let read = file.read(&mut chunk).unwrap();
            if read == 0 {
                break;
            }
            carried.extend_from_slice(&chunk[..read]);
            let mut from = 0usize;
            while let Some(hit) = memchr::memchr(b'\n', &carried[from..]) {
                let text = String::from_utf8_lossy(&carried[from..from + hit]);
                for (start, end) in matcher.matches_in(&text, false) {
                    matches.push(MatchLoc {
                        line: line_no,
                        start_col: start,
                        end_col: end,
                    });
                }
                line_no += 1;
                from += hit + 1;
            }
            carried.drain(..from);
        }
        let hit_199x: Vec<&MatchLoc> = matches
            .iter()
            .filter(|m| (1990..=1999).contains(&m.line))
            .collect();
        assert!(hit_199x.iter().all(|m| (1990..=1999).contains(&m.line)));
        assert_eq!(hit_199x.len(), 10, "one match per line 1990..=1999");
        assert!(
            matches.len() >= 11,
            "line 199 matches the prefix too: {matches:?}"
        );
    }
}
