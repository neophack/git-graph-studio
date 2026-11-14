//! The Data Table's engine (module 20): CSV/TSV measurement exports opened like a CAN
//! trace — the delimiter and header are sniffed from the first kilobytes, a background
//! walk streams the records into a document while the table browses what is already
//! there, and the plot reads every numeric column back as a decimated series. The crate
//! is pure Rust: the `csv_commands.rs` adapters are the only file that may name tauri.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

/* ---------- The document ---------- */

/// One parsed cell. A cell that reads as a finite number stores the value (the plot and
/// the sort read it back without re-parsing); everything else keeps its original text,
/// which the table shows verbatim.
#[derive(Clone, Debug)]
pub enum CsvCell {
    Num(f64),
    Str(Box<str>),
}

impl CsvCell {
    /// The numeric reading of a cell, or `None` for text and empties.
    fn num(&self) -> Option<f64> {
        match self {
            CsvCell::Num(v) => Some(*v),
            CsvCell::Str(_) => None,
        }
    }
}

/// A cell as the bridge sees it: a number, or the original text. Untagged — the table's
/// value column renders whatever shape arrives.
#[derive(Serialize, Debug, PartialEq)]
#[serde(untagged)]
pub enum CsvValue {
    Num(f64),
    Str(String),
}

/// One column of the parsed file: its header name (when the file has one and the cell is
/// not empty) and whether it is predominantly numeric — the plot picker's candidate set
/// and the table header's type mark.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CsvColumn {
    pub name: Option<String>,
    pub numeric: bool,
}

/// Per-column tallies the walk keeps: numeric cells among the non-empty ones — empty
/// cells (sparse logs) never disqualify a numeric column, while a text cell does.
#[derive(Clone, Copy, Default)]
struct ColCount {
    nonempty: u64,
    numeric: u64,
}

impl ColCount {
    /// Predominantly numeric: 95 % of the non-empty cells parse (a stray text row does
    /// not kill a sensor column, a text column stays out of the plot picker).
    fn numeric(self) -> bool {
        self.nonempty > 0 && self.numeric * 20 >= self.nonempty * 19
    }
}

/// A sort spec from the table's header click. Rows live in the document, so the order is
/// computed there and memoized until the walk lands more rows.
#[derive(Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CsvSort {
    pub column: usize,
    pub descending: bool,
}

/// The sort ordering's three groups: numbers first, then text case-insensitively,
/// empties last — the order a data tool's column sort is expected to produce.
#[derive(PartialEq, Eq)]
enum SortKey {
    Num(u64),
    Text(Box<str>),
    Empty,
}

impl SortKey {
    fn of(cell: Option<&CsvCell>) -> SortKey {
        match cell {
            None => SortKey::Empty,
            Some(CsvCell::Num(v)) => {
                // Total order over floats: flip the sign bit into a u64 ranking (IEEE-754
                // trick), so -inf sorts under +inf without a float comparator.
                let bits = v.to_bits();
                SortKey::Num(if bits & 0x8000_0000_0000_0000 == 0 {
                    bits | 0x8000_0000_0000_0000
                } else {
                    !bits
                })
            }
            Some(CsvCell::Str(s)) if s.is_empty() => SortKey::Empty,
            Some(CsvCell::Str(s)) => SortKey::Text(s.to_lowercase().into_boxed_str()),
        }
    }
}

/// The memoized sorted order: valid while the walk has not grown past the prefix it was
/// built over and the spec still matches the header's last click.
struct SortCache {
    column: usize,
    descending: bool,
    built: usize,
    order: Vec<u32>,
}

/// A CSV file opened for browsing: the walk's records, filled in by a background task
/// while the table renders whatever is already there — the raw CAN log's document shape,
/// carrying cells instead of frames.
pub struct CsvDoc {
    rows: Mutex<Vec<Vec<CsvCell>>>,
    /// The authoritative column count; column names and tallies, which a wider row
    /// (a ragged export) grows. Lock order: readers snapshot `width` / `names` /
    /// `counts` BEFORE taking `rows`, and the walk's landing holds the three under
    /// `rows` — so no landing ever waits on a reader that waits back on it.
    width: Mutex<usize>,
    names: Mutex<Vec<Option<String>>>,
    counts: Mutex<Vec<ColCount>>,
    /// The memoized sort (one spec at a time — the header carries one click's state).
    /// Locked on its own, never nested inside another document mutex.
    sort: Mutex<Option<SortCache>>,
    parsed: AtomicUsize,
    bytes: AtomicU64,
    total_bytes: u64,
    done: AtomicBool,
    error: Mutex<Option<String>>,
    delimiter: u8,
    has_header: bool,
}

impl CsvDoc {
    fn new(total_bytes: u64, delimiter: u8, has_header: bool, names: Vec<Option<String>>) -> Self {
        let width = names.len();
        CsvDoc {
            rows: Mutex::new(Vec::new()),
            width: Mutex::new(width),
            names: Mutex::new(names),
            counts: Mutex::new(vec![ColCount::default(); width]),
            sort: Mutex::new(None),
            parsed: AtomicUsize::new(0),
            bytes: AtomicU64::new(0),
            total_bytes,
            done: AtomicBool::new(false),
            error: Mutex::new(None),
            delimiter,
            has_header,
        }
    }

    /// Widens the column metadata to `to` columns (a ragged row landed wider than the
    /// header): unnamed columns, fresh tallies.
    fn widen(names: &mut Vec<Option<String>>, counts: &mut Vec<ColCount>, width: &mut usize, to: usize) {
        while *width < to {
            names.push(None);
            counts.push(ColCount::default());
            *width += 1;
        }
    }

    /// The file's size — the open answer's progress denominator.
    pub fn total_bytes(&self) -> u64 {
        self.total_bytes
    }

    /// The sniffed delimiter, as the display character the toolbar may name.
    pub fn delimiter(&self) -> char {
        self.delimiter as char
    }

    /// Whether the walk skips a first header record.
    pub fn has_header(&self) -> bool {
        self.has_header
    }
}

/// Every open CSV document by id — the raw CAN log's `CanLogState`, so a tab's rows live
/// exactly as long as the tab does.
#[derive(Default)]
pub struct CsvState {
    docs: Mutex<HashMap<u32, Arc<CsvDoc>>>,
    next_id: AtomicU32,
}

impl CsvState {
    pub fn register(&self, doc: Arc<CsvDoc>) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.docs.lock().unwrap().insert(id, doc);
        id
    }

    /// Releases a document's rows when its tab closes.
    pub fn release(&self, doc_id: u32) {
        self.docs.lock().unwrap().remove(&doc_id);
    }

    pub fn get(&self, id: u32) -> Option<Arc<CsvDoc>> {
        self.docs.lock().unwrap().get(&id).cloned()
    }
}

/* ---------- The bridge shapes ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvOpenResult {
    pub doc_id: u32,
    pub total_bytes: u64,
    /// The sniffed field delimiter, as the one-character string the toolbar may show.
    pub delimiter: String,
    pub has_header: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvCount {
    /// The records published so far — the scroll range's length while the walk runs.
    pub parsed: u64,
    pub done: bool,
    pub error: Option<String>,
    /// The walk's file position and the file's size — the live percentage.
    pub bytes: u64,
    pub total_bytes: u64,
    /// The columns as they stand (a ragged row can still widen the table while the walk
    /// runs) — the table header and the plot picker read them.
    pub columns: Vec<CsvColumn>,
}

/// One row as the table renders it: the row's own place in the file (the "No." column,
/// whatever sort ordered the view) and its cells. A short row is padded with empties at
/// serve time — ragged exports cost nothing at parse time.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvRowLine {
    pub index: u64,
    pub cells: Vec<CsvValue>,
}

#[derive(Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CsvSeriesPoint {
    pub x: f64,
    pub y: f64,
}

/// The numbers a legend chip names for its column, over the plotted range.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct CsvColumnStats {
    pub count: u64,
    pub min: f64,
    pub max: f64,
    pub avg: f64,
}

/// One plotted column: its decimated points and the range's stats.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvSeries {
    pub column: usize,
    pub name: Option<String>,
    pub points: Vec<CsvSeriesPoint>,
    pub stats: CsvColumnStats,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvSeriesResult {
    pub x_min: f64,
    pub x_max: f64,
    pub series: Vec<CsvSeries>,
}

/* ---------- Sniffing ---------- */

/// The sniff's answer: the delimiter, whether the first record is a header, and the
/// header's names (empty cells become `None` — the frontend labels those columns).
pub struct Sniffed {
    pub delimiter: u8,
    pub has_header: bool,
    pub names: Vec<Option<String>>,
}

/// Whether a cell reads as a finite number (`inf`/`NaN` spellings are text — a
/// measurement column never carries them, a label column might).
fn parse_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// The delimiters a sniff considers, in preference order.
const DELIMITERS: [u8; 4] = *b",;\t|";

/// Reads the first 64 KiB and decides the shape: the delimiter that separates the most
/// lines consistently, then whether the first record is a header (it names the columns
/// when no cell of it parses as a number — a data row almost always carries at least one).
pub fn sniff(path: &Path) -> Result<Sniffed, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut prefix = vec![0u8; 64 * 1024];
    let read = file.read(&mut prefix).map_err(|e| e.to_string())?;
    prefix.truncate(read);
    if prefix.starts_with(&[0xEF, 0xBB, 0xBF]) {
        prefix.drain(0..3);
    }
    if prefix.is_empty() {
        return Ok(Sniffed {
            delimiter: b',',
            has_header: false,
            names: Vec::new(),
        });
    }
    let delimiter = sniff_delimiter(&prefix);
    // The first two records over the sniffed delimiter decide the header question and
    // name the columns.
    let mut splitter = RecordSplitter::new(delimiter);
    let mut records = Vec::new();
    splitter.feed(&prefix, &mut records);
    if records.is_empty() {
        // A single unterminated giant first record (a minified data blob): treat it as
        // headerless data — the walk below serves it as one row.
        let mut tail = Vec::new();
        splitter.finish(&mut tail);
        records = tail;
    }
    let first = records.first().cloned().unwrap_or_default();
    let first_numeric = first.iter().any(|cell| parse_number(cell).is_some());
    // An all-text first row names the columns; a row with any number in it is data.
    // (A two-record all-text file reads as header + data — the common text-column case.)
    let has_header = !first_numeric;
    let names: Vec<Option<String>> = if has_header {
        first
            .iter()
            .map(|cell| {
                let trimmed = cell.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(Sniffed {
        delimiter,
        has_header,
        names,
    })
}

/// The delimiter that appears in the most lines of the prefix (≥ 90 % of them) wins;
/// none reaching it, the one with the highest presence at all; a single-column file
/// keeps the comma.
fn sniff_delimiter(prefix: &[u8]) -> u8 {
    let lines: Vec<&[u8]> = prefix.split(|b| *b == b'\n').collect();
    let counted = lines.len().max(1);
    let mut best = b',';
    let mut best_score = 0.0f64;
    for candidate in DELIMITERS {
        let present = lines
            .iter()
            .filter(|line| line.contains(&candidate))
            .count();
        let score = present as f64 / counted as f64;
        if score > best_score {
            best_score = score;
            best = candidate;
        }
        if best_score >= 0.9 {
            break;
        }
    }
    best
}

/* ---------- The incremental record reader ---------- */

/// Feeds byte chunks, emits complete records. RFC 4180 quoting: a `"`-quoted field may
/// carry the delimiter, newlines and `""` escapes; records end at `\n` (a preceding `\r`
/// is stripped), inside quotes or not. The unfinished tail stays in the carry for the
/// next chunk; `finish` emits it as the file's last record.
struct RecordSplitter {
    delimiter: u8,
    carry: Vec<u8>,
    in_quotes: bool,
}

impl RecordSplitter {
    fn new(delimiter: u8) -> Self {
        RecordSplitter {
            delimiter,
            carry: Vec::new(),
            in_quotes: false,
        }
    }

    fn feed(&mut self, chunk: &[u8], out: &mut Vec<Vec<String>>) {
        let mut start = 0usize;
        for (i, b) in chunk.iter().enumerate() {
            if *b == b'"' {
                self.in_quotes = !self.in_quotes;
            } else if *b == b'\n' && !self.in_quotes {
                self.carry.extend_from_slice(&chunk[start..i]);
                start = i + 1;
                self.emit(out);
            }
        }
        self.carry.extend_from_slice(&chunk[start..]);
    }

    /// The bytes after the file's last newline: a record when they carry content, the
    /// trailing whitespace of the final newline when they do not.
    fn finish(&mut self, out: &mut Vec<Vec<String>>) {
        if self.carry.iter().any(|b| !b.is_ascii_whitespace()) {
            self.emit(out);
        }
    }

    fn emit(&mut self, out: &mut Vec<Vec<String>>) {
        if self.carry.last() == Some(&b'\r') {
            self.carry.pop();
        }
        if self.carry.is_empty() {
            // A blank line between records is not a row of empties.
            self.carry.clear();
            return;
        }
        out.push(split_record(&self.carry, self.delimiter));
        self.carry.clear();
        self.in_quotes = false;
    }
}

/// Splits one complete record's bytes into its field texts.
fn split_record(bytes: &[u8], delimiter: u8) -> Vec<String> {
    let mut fields = Vec::new();
    let mut field = Vec::new();
    let mut i = 0usize;
    let mut quoted = false;
    while i < bytes.len() {
        let b = bytes[i];
        if quoted {
            if b == b'"' {
                if bytes.get(i + 1) == Some(&b'"') {
                    field.push(b'"');
                    i += 2;
                    continue;
                }
                quoted = false;
                i += 1;
                continue;
            }
            field.push(b);
            i += 1;
            continue;
        }
        if b == b'"' && field.is_empty() {
            quoted = true;
            i += 1;
            continue;
        }
        if b == delimiter {
            fields.push(String::from_utf8_lossy(&field).into_owned());
            field.clear();
            i += 1;
            continue;
        }
        field.push(b);
        i += 1;
    }
    fields.push(String::from_utf8_lossy(&field).into_owned());
    fields
}

/* ---------- The background walk ---------- */

/// How many staged records land in the document per lock — thousands of locks for a
/// ten-million-row walk, not millions, with the published count still moving.
const WALK_BATCH: usize = 4096;

/// The read chunk the walk feeds the splitter with.
const WALK_CHUNK: usize = 256 * 1024;

/// Streams the file into the document: records batch in a staging vec and land under one
/// lock, the tallies grow with them, and the published count and byte position move with
/// every landing so the table can grow its scroll range live. The header record (when
/// the sniff found one) is skipped. A failure parks in the document — the poll surfaces
/// it once the walk ends.
pub fn open_into_doc(path: &Path, doc: &Arc<CsvDoc>) {
    let result = walk_into_doc(path, doc);
    doc.done.store(true, Ordering::Relaxed);
    if let Err(error) = result {
        *doc.error.lock().unwrap() = Some(error);
    }
}

fn walk_into_doc(path: &Path, doc: &Arc<CsvDoc>) -> Result<(), String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut splitter = RecordSplitter::new(doc.delimiter);
    let mut chunk = vec![0u8; WALK_CHUNK];
    let mut staging: Vec<Vec<CsvCell>> = Vec::new();
    let mut skipped_header = false;
    loop {
        let read = reader.read(&mut chunk).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        let mut records = Vec::new();
        splitter.feed(&chunk[..read], &mut records);
        if records.is_empty() {
            doc.bytes.fetch_add(read as u64, Ordering::Relaxed);
            continue;
        }
        for record in records.drain(..) {
            if doc.has_header && !skipped_header {
                skipped_header = true;
                continue;
            }
            staging.push(record.into_iter().map(cell_of).collect());
            if staging.len() >= WALK_BATCH {
                land(doc, &mut staging);
            }
        }
        doc.bytes.fetch_add(read as u64, Ordering::Relaxed);
    }
    let mut tail = Vec::new();
    splitter.finish(&mut tail);
    for record in tail {
        if doc.has_header && !skipped_header {
            skipped_header = true;
            continue;
        }
        staging.push(record.into_iter().map(cell_of).collect());
    }
    land(doc, &mut staging);
    Ok(())
}

fn cell_of(text: String) -> CsvCell {
    // Anything that parses as a float is a number — `nan`/`inf` spellings included (the
    // way pandas writes a missing sample). The plot skips non-finite samples; the tally
    // keeps the column numeric, so one `NaN` row never disqualifies a sensor column.
    match text.trim().parse::<f64>() {
        Ok(v) => CsvCell::Num(v),
        Err(_) => CsvCell::Str(text.into_boxed_str()),
    }
}

/// Lands one batch: the rows first, the column metadata under them (the lock order the
/// readers respect), then the published count — the view's poll reads it back.
fn land(doc: &Arc<CsvDoc>, staging: &mut Vec<Vec<CsvCell>>) {
    if staging.is_empty() {
        return;
    }
    let seen = {
        let mut rows = doc.rows.lock().unwrap();
        let mut names = doc.names.lock().unwrap();
        let mut counts = doc.counts.lock().unwrap();
        let mut width = doc.width.lock().unwrap();
        rows.reserve(staging.len());
        for row in staging.drain(..) {
            if row.len() > *width {
                CsvDoc::widen(&mut names, &mut counts, &mut width, row.len());
            }
            let w = *width;
            for (c, cell) in row.iter().enumerate().take(w) {
                let tally = &mut counts[c];
                match cell {
                    CsvCell::Num(_) => {
                        tally.nonempty += 1;
                        tally.numeric += 1;
                    }
                    CsvCell::Str(s) if !s.is_empty() => tally.nonempty += 1,
                    _ => {}
                }
            }
            rows.push(row);
        }
        rows.len()
    };
    doc.parsed.store(seen, Ordering::Relaxed);
    // New rows reorder a sorted view; the cache rebuilds on the next window fetch.
    doc.sort.lock().unwrap().take();
}

/* ---------- The poll, the windows, the sort, the series ---------- */

/// How far the background walk has come — what the view polls to extend its scroll range,
/// together with the columns as they stand.
pub fn count_of(doc: &Arc<CsvDoc>) -> CsvCount {
    let names = doc.names.lock().unwrap();
    let counts = doc.counts.lock().unwrap();
    let columns = names
        .iter()
        .enumerate()
        .map(|(c, name)| CsvColumn {
            name: name.clone(),
            numeric: counts.get(c).copied().unwrap_or_default().numeric(),
        })
        .collect();
    CsvCount {
        parsed: doc.parsed.load(Ordering::Relaxed) as u64,
        done: doc.done.load(Ordering::Relaxed),
        error: doc.error.lock().unwrap().clone(),
        bytes: doc.bytes.load(Ordering::Relaxed),
        total_bytes: doc.total_bytes,
        columns,
    }
}

/// A window of rows, in natural or sorted order. The sorted order is computed over the
/// parsed prefix and memoized — a walk landing more rows invalidates it (the header's
/// sort stays; the order rebuilds on the next fetch).
pub fn rows_of(doc: &Arc<CsvDoc>, start: usize, end: usize, sort: Option<&CsvSort>) -> Vec<CsvRowLine> {
    // Width snapshotted before the rows lock (the readers' lock order): a widen landing
    // between the two leaves this window padded at the old width — the next fetch is exact.
    let width = *doc.width.lock().unwrap();
    let rows = doc.rows.lock().unwrap();
    let parsed = rows.len();
    let order: Vec<usize> = match sort {
        None => (start.min(parsed)..end.min(parsed)).collect(),
        Some(spec) => {
            {
                let mut cache = doc.sort.lock().unwrap();
                let valid = cache
                    .as_ref()
                    .is_some_and(|c| c.column == spec.column && c.descending == spec.descending && c.built == parsed);
                if !valid {
                    *cache = Some(build_order(&rows, spec, parsed));
                }
            }
            let cache = doc.sort.lock().unwrap();
            let cache = cache.as_ref().unwrap();
            let order = &cache.order;
            let (a, b) = (start.min(order.len()), end.min(order.len()));
            order[a..b].iter().map(|i| *i as usize).collect()
        }
    };
    order
        .into_iter()
        .map(|index| {
            let row = &rows[index];
            let mut cells: Vec<CsvValue> = Vec::with_capacity(width);
            for c in 0..width {
                cells.push(match row.get(c) {
                    Some(CsvCell::Num(v)) => CsvValue::Num(*v),
                    Some(CsvCell::Str(s)) => CsvValue::Str(s.to_string()),
                    None => CsvValue::Str(String::new()),
                });
            }
            CsvRowLine {
                index: index as u64,
                cells,
            }
        })
        .collect()
}

fn build_order(rows: &[Vec<CsvCell>], spec: &CsvSort, parsed: usize) -> SortCache {
    let mut keyed: Vec<(SortKey, u32)> = rows
        .iter()
        .take(parsed)
        .enumerate()
        .map(|(i, row)| (SortKey::of(row.get(spec.column)), i as u32))
        .collect();
    keyed.sort_unstable_by(|a, b| {
        // Descending reverses the values inside each group; the groups themselves stay
        // in order — numbers first, text next, empties last, whichever the direction.
        let rank_ord = rank_of(&a.0).cmp(&rank_of(&b.0));
        let val_ord = match (&a.0, &b.0) {
            (SortKey::Num(a), SortKey::Num(b)) => a.cmp(b),
            (SortKey::Text(a), SortKey::Text(b)) => a.cmp(b),
            _ => std::cmp::Ordering::Equal,
        };
        rank_ord.then(if spec.descending { val_ord.reverse() } else { val_ord })
    });
    SortCache {
        column: spec.column,
        descending: spec.descending,
        built: parsed,
        order: keyed.into_iter().map(|(_, i)| i).collect(),
    }
}

fn rank_of(key: &SortKey) -> u8 {
    match key {
        SortKey::Num(_) => 0,
        SortKey::Text(_) => 1,
        SortKey::Empty => 2,
    }
}

/// How many points a plot series keeps: min/max decimation doubles the bucket count.
const SERIES_POINTS: usize = 2048;

/// Every requested column as a decimated series over the x axis — the plot's one backend
/// read. `x` selects the abscissa column (`None` = the row's own position), `range` clips
/// both ends (the zoom's refetch passes the visible window). Rows whose x cell is not a
/// number are skipped for every series together; a y cell that is not a number is a gap.
/// Each series keeps at most `SERIES_POINTS * 2` points: the walk buckets the range and
/// keeps each bucket's extremes, so a one-sample spike inside a million-row range still
/// draws. The stats cover the plotted range, what the legend names.
pub fn series_of(
    doc: &Arc<CsvDoc>,
    x: Option<usize>,
    ys: &[usize],
    range: Option<(f64, f64)>,
) -> CsvSeriesResult {
    // Column metadata snapshotted before the rows lock (the readers' lock order).
    let names = doc.names.lock().unwrap().clone();
    let width = names.len().max(*doc.width.lock().unwrap());
    let rows = doc.rows.lock().unwrap();
    let x_col = x.filter(|c| *c < width);
    let ys: Vec<usize> = ys.iter().copied().filter(|c| *c < width).collect();
    let mut result = CsvSeriesResult {
        x_min: f64::INFINITY,
        x_max: f64::NEG_INFINITY,
        series: Vec::new(),
    };
    if ys.is_empty() {
        return result;
    }
    // One pass per series, under one lock scope: the plot's read holds the document for
    // as short a time as the table's window fetch does, not once per column.
    let mut stats: Vec<CsvColumnStats> = ys
        .iter()
        .map(|_| CsvColumnStats {
            count: 0,
            min: f64::INFINITY,
            max: f64::NEG_INFINITY,
            avg: 0.0,
        })
        .collect();
    let mut raw: Vec<Vec<CsvSeriesPoint>> = vec![Vec::new(); ys.len()];
    let mut x_vals: Vec<f64> = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let xv = match x_col {
            None => index as f64,
            Some(c) => match row.get(c).and_then(CsvCell::num) {
                Some(v) => v,
                None => continue,
            },
        };
        if let Some((from, to)) = range {
            if xv < from || xv > to {
                continue;
            }
        }
        result.x_min = result.x_min.min(xv);
        result.x_max = result.x_max.max(xv);
        x_vals.push(xv);
        for (s, &c) in ys.iter().enumerate() {
            // A non-finite number (`nan`, the way exports write a missing sample) is a
            // gap in the line, not a point at minus infinity.
            if let Some(v) = row.get(c).and_then(CsvCell::num).filter(|v| v.is_finite()) {
                raw[s].push(CsvSeriesPoint { x: xv, y: v });
                let st = &mut stats[s];
                st.count += 1;
                st.min = st.min.min(v);
                st.max = st.max.max(v);
                st.avg += v;
            }
        }
    }
    for (s, &c) in ys.iter().enumerate() {
        let st = &mut stats[s];
        if st.count > 0 {
            st.avg /= st.count as f64;
        }
        let name = names.get(c).cloned().flatten();
        result.series.push(CsvSeries {
            column: c,
            name,
            points: decimate(&raw[s], SERIES_POINTS),
            stats: *st,
        });
    }
    if !x_vals.is_empty() {
        // Row-index axis: the x range is the row span, not the sampled cells'.
        if x_col.is_none() {
            result.x_min = 0.0;
            result.x_max = (rows.len().saturating_sub(1)) as f64;
        }
    }
    result
}

/// Min/max decimation: `buckets` even slices over the sample order, each keeping its
/// first, min, max and last points in x order — a series of n samples becomes at most
/// 4 per bucket, its shape and every spike intact.
fn decimate(points: &[CsvSeriesPoint], buckets: usize) -> Vec<CsvSeriesPoint> {
    if points.len() <= buckets {
        return points.to_vec();
    }
    let n = points.len();
    let per = n / buckets.max(1);
    let mut out = Vec::with_capacity(buckets * 4);
    let mut start = 0usize;
    while start < n {
        let end = (start + per).min(n);
        let slice = &points[start..end];
        if let Some(first) = slice.first() {
            out.push(*first);
        }
        let mut lo = slice[0];
        let mut hi = slice[0];
        for p in slice {
            if p.y < lo.y {
                lo = *p;
            }
            if p.y > hi.y {
                hi = *p;
            }
        }
        let mut pair = [lo, hi];
        // lo and hi are whichever extremes the bucket held; they go out in x order, so
        // the polyline never doubles back between them.
        if lo.x > hi.x {
            pair = [hi, lo];
        }
        for p in pair {
            if out.last() != Some(&p) {
                out.push(p);
            }
        }
        if let Some(last) = slice.last() {
            if out.last() != Some(last) {
                out.push(*last);
            }
        }
        start = end;
    }
    out
}

/// The file's size, so a progress report can say how far along the walk is.
pub fn total_bytes_of(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// Opens a CSV for browsing: the sniff decides the shape from the first kilobytes, the
/// document exists at once, and `open_into_doc` streams it in the background.
pub fn open_doc(path: &Path) -> Result<Arc<CsvDoc>, String> {
    let sniffed = sniff(path)?;
    Ok(Arc::new(CsvDoc::new(
        total_bytes_of(path),
        sniffed.delimiter,
        sniffed.has_header,
        sniffed.names,
    )))
}

/* ---------- Tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    /* the record reader */

    #[test]
    fn split_respects_quotes_and_escapes() {
        assert_eq!(split_record(b"a,b,c", b','), vec!["a", "b", "c"]);
        assert_eq!(split_record(b"\"a,b\",c", b','), vec!["a,b", "c"]);
        assert_eq!(split_record(b"\"say \"\"hi\"\"\",x", b','), vec!["say \"hi\"", "x"]);
        assert_eq!(split_record(b"1;2;3", b';'), vec!["1", "2", "3"]);
        // A quote in the middle of an unquoted field is text.
        assert_eq!(split_record(b"12\"3,4", b','), vec!["12\"3", "4"]);
    }

    #[test]
    fn splitter_carries_quoted_newlines_across_chunks() {
        let mut splitter = RecordSplitter::new(b',');
        let mut records = Vec::new();
        // The quoted newline splits exactly at the chunk boundary.
        splitter.feed(b"a,\"line one\n", &mut records);
        assert!(records.is_empty());
        splitter.feed(b"line two\",b\n", &mut records);
        assert_eq!(records, vec![vec!["a", "line one\nline two", "b"]]);
        splitter.finish(&mut records);
        assert_eq!(records.len(), 1);
    }

    #[test]
    fn splitter_reads_crlf_and_the_final_record() {
        let mut splitter = RecordSplitter::new(b',');
        let mut records = Vec::new();
        splitter.feed(b"a,b\r\nc,d\r\nlast,row", &mut records);
        assert_eq!(records, vec![vec!["a", "b"], vec!["c", "d"]]);
        splitter.finish(&mut records);
        assert_eq!(records.last().unwrap(), &vec!["last".to_string(), "row".to_string()]);
    }

    #[test]
    fn splitter_skips_blank_lines() {
        let mut splitter = RecordSplitter::new(b',');
        let mut records = Vec::new();
        splitter.feed(b"a,b\n\n\nc,d\n", &mut records);
        assert_eq!(records.len(), 2);
    }

    /* the sniff */

    #[test]
    fn sniffs_the_delimiter_that_separates_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("semi.csv");
        std::fs::write(&path, "a;b;c\n1;2;3\n4;5;6\n").unwrap();
        let sniffed = sniff(&path).unwrap();
        assert_eq!(sniffed.delimiter, b';');
        assert!(sniffed.has_header);
        assert_eq!(sniffed.names, vec![Some("a".into()), Some("b".into()), Some("c".into())]);
    }

    #[test]
    fn a_numeric_first_row_is_not_a_header() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bare.csv");
        std::fs::write(&path, "1,2,3\n4,5,6\n").unwrap();
        let sniffed = sniff(&path).unwrap();
        assert!(!sniffed.has_header);
        assert!(sniffed.names.is_empty());
    }

    /* the walk and the document */

    fn walk(path: &Path) -> Arc<CsvDoc> {
        let doc = open_doc(path).unwrap();
        open_into_doc(path, &doc);
        doc
    }

    #[test]
    fn the_walk_lands_rows_tallies_and_names() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.csv");
        std::fs::write(&path, "time,value,label\n0,1.5,ok\n0.1,nan,ng\n0.2,3,\n").unwrap();
        let doc = walk(&path);
        assert_eq!(doc.parsed.load(Ordering::Relaxed), 3);
        assert!(doc.done.load(Ordering::Relaxed));
        let count = count_of(&doc);
        assert_eq!(count.parsed, 3);
        assert_eq!(count.columns.len(), 3);
        // `time` and `value` are numeric (the text `nan` does not parse); `label` is not,
        // and its one empty cell never disqualified it — but its `ng` did.
        assert!(count.columns[0].numeric);
        assert!(count.columns[1].numeric);
        assert!(!count.columns[2].numeric);
        assert_eq!(count.columns[0].name.as_deref(), Some("time"));
        let rows = rows_of(&doc, 0, 10, None);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].cells, vec![CsvValue::Num(0.0), CsvValue::Num(1.5), CsvValue::Str("ok".into())]);
    }

    #[test]
    fn ragged_rows_widen_and_pad() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ragged.csv");
        std::fs::write(&path, "a,b\n1,2,3,4\n5\n").unwrap();
        let doc = walk(&path);
        let count = count_of(&doc);
        assert_eq!(count.columns.len(), 4);
        let rows = rows_of(&doc, 0, 10, None);
        assert_eq!(rows.len(), 2);
        // The two-column header names the first two; the wider row grew the table; the
        // short one pads with empty text.
        assert_eq!(rows[0].cells.len(), 4);
        assert_eq!(rows[1].cells, vec![CsvValue::Num(5.0), CsvValue::Str("".into()), CsvValue::Str("".into()), CsvValue::Str("".into())]);
        assert_eq!(count.columns[2].name, None);
    }

    #[test]
    fn the_sort_orders_numbers_text_and_empties() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sort.csv");
        // The blank third row is not a record; the empty first CELL of ",keep" is.
        std::fs::write(&path, "v,note\n10,a\napple,\n,keep\n2,b\nBanana,c\n-3,d\n").unwrap();
        let doc = walk(&path);
        let asc = rows_of(&doc, 0, 100, Some(&CsvSort { column: 0, descending: false }));
        let texts: Vec<String> = asc
            .iter()
            .map(|r| match &r.cells[0] {
                CsvValue::Str(s) => s.clone(),
                CsvValue::Num(v) => v.to_string(),
            })
            .collect();
        // Numbers first ascending, then text case-insensitive, empties last.
        assert_eq!(texts, vec!["-3", "2", "10", "apple", "Banana", ""]);
        let desc = rows_of(&doc, 0, 100, Some(&CsvSort { column: 0, descending: true }));
        let first = match &desc[0].cells[0] {
            CsvValue::Num(v) => *v,
            _ => panic!("expected a number"),
        };
        assert_eq!(first, 10.0);
        // Empties stay last descending too.
        assert_eq!(desc.last().unwrap().cells[0], CsvValue::Str("".into()));
    }

    /* the plot series */

    #[test]
    fn series_reads_every_selected_column_over_the_row_axis() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plot.csv");
        std::fs::write(&path, "t,a,b\n0,1,10\n1,2,20\n2,3,30\n").unwrap();
        let doc = walk(&path);
        let result = series_of(&doc, Some(0), &[1, 2], None);
        assert_eq!(result.series.len(), 2);
        assert_eq!(result.x_min, 0.0);
        assert_eq!(result.x_max, 2.0);
        let a = &result.series[0];
        assert_eq!(a.name.as_deref(), Some("a"));
        assert_eq!(a.points.len(), 3);
        assert_eq!(a.stats.min, 1.0);
        assert_eq!(a.stats.max, 3.0);
        assert!((a.stats.avg - 2.0).abs() < 1e-9);
        // A text x column skips its rows for every series together.
        let gaps = series_of(&doc, None, &[1], None);
        assert_eq!(gaps.series[0].points.len(), 3);
    }

    #[test]
    fn decimation_keeps_a_spike_inside_a_huge_range() {
        let n = 100_000;
        let mut points = Vec::with_capacity(n);
        for i in 0..n {
            let y = if i == n / 2 { 1_000_000.0 } else { (i as f64) * 0.001 };
            points.push(CsvSeriesPoint { x: i as f64, y });
        }
        let kept = decimate(&points, 100);
        assert!(kept.len() <= 400);
        assert!(kept.iter().any(|p| p.y == 1_000_000.0), "the spike survives decimation");
        // The shape stays ordered by x.
        assert!(kept.windows(2).all(|w| w[0].x <= w[1].x));
    }

    #[test]
    fn the_range_clips_and_the_stats_cover_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("range.csv");
        let mut body = String::from("t,v\n");
        for i in 0..100 {
            body.push_str(&format!("{},{}\n", i, i * 2));
        }
        std::fs::write(&path, body).unwrap();
        let doc = walk(&path);
        let result = series_of(&doc, Some(0), &[1], Some((10.0, 19.0)));
        let s = &result.series[0];
        assert_eq!(s.points.len(), 10);
        assert_eq!(s.stats.min, 20.0);
        assert_eq!(s.stats.max, 38.0);
        assert_eq!(result.x_min, 10.0);
    }

    #[test]
    fn the_state_registers_and_releases_documents() {
        let state = CsvState::default();
        let doc = Arc::new(CsvDoc::new(0, b',', false, Vec::new()));
        let id = state.register(Arc::clone(&doc));
        assert!(state.get(id).is_some());
        state.release(id);
        assert!(state.get(id).is_none());
    }
}
