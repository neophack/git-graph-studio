//! The search / compare / symbol services: workspace text search and replace, folder
//! comparison, the workspace symbol index behind Go-to-Definition and Find References, and the
//! byte-level comparison behind the hex view. The reads parallelise with rayon, and every walk
//! reuses the Quick Open file walk so the excluded-folder policy is one list, not three.

use regex::bytes::Regex;
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::cmd_fs::cached_file_list;
use crate::cmd_fs::walk_files;
use crate::AppState;
use rayon::prelude::*;
use tauri::ipc::Channel;
use tauri::State;

/// Files up to this size are read whole for the text search; larger ones are streamed line by
/// line (`scan_stream`) instead of skipped, so a multi-gigabyte `.asc` trace is searchable too.
/// (Replace still rewrites whole files and keeps the whole-read limit.)
const MAX_TEXT_FILE: u64 = 2 * 1024 * 1024;
/// The search stops after this many matches, reporting `truncated: true`.
const MAX_MATCHES: usize = 5000;
/// How long the symbol index stays fresh between queries.
const SYMBOL_TTL: Duration = Duration::from_secs(30);

/* ---------- Globs (the Search view's include / exclude fields) ---------- */

/// A glob matcher over the `*` / `?` / `**` vocabulary VS Code's search uses (`**/*.rs`,
/// `src/*`, …), matched against the repo-relative, forward-slashed path. A pattern without a
/// separator (`*.rs`) is matched against the file name anywhere in the tree, as VS Code's
/// search does.
pub(crate) fn glob_match(pattern: &str, path: &str) -> bool {
    fn m(p: &[char], s: &[char]) -> bool {
        if p.is_empty() {
            return s.is_empty();
        }
        match p[0] {
            '*' => {
                let mut rest = 1;
                while rest < p.len() && p[rest] == '*' {
                    rest += 1;
                }
                let double = rest > 1;
                // `**/` also matches zero folders, so `**/*.rs` hits `a.rs` as well as `s/a.rs`.
                if double && rest < p.len() && p[rest] == '/' {
                    if m(&p[rest + 1..], s) {
                        return true;
                    }
                    return (0..s.len()).any(|k| s[k] == '/' && m(&p[rest + 1..], &s[k + 1..]));
                }
                let tail = &p[rest..];
                for skip in 0..=s.len() {
                    if m(tail, &s[skip..]) {
                        return true;
                    }
                    if !double && skip < s.len() && s[skip] == '/' {
                        return false; // a single `*` never crosses a separator
                    }
                }
                false
            }
            '?' => !s.is_empty() && s[0] != '/' && m(&p[1..], &s[1..]),
            c => !s.is_empty() && s[0] == c && m(&p[1..], &s[1..]),
        }
    }
    let pattern: Vec<char> = pattern.chars().collect();
    let path: Vec<char> = path.chars().collect();
    if !pattern.contains(&'/') {
        let name: Vec<char> = path.iter().copied().rev().take_while(|c| *c != '/').collect::<Vec<_>>().into_iter().rev().collect();
        return m(&pattern, &name);
    }
    m(&pattern, &path)
}

/// The include/exclude fields: comma-separated globs matched against the repo-relative path
/// (a bare `*.rs` matches anywhere, like VS Code's search). Patterns keep their spaces -
/// `my docs/**` is one pattern.
pub(crate) fn filter_paths(files: Vec<String>, include: &str, exclude: &str) -> Vec<String> {
    let split = |s: &str| -> Vec<String> {
        s.split(',')
            .map(|part| part.trim().to_owned())
            .filter(|p| !p.is_empty())
            .collect()
    };
    let includes = split(include);
    let excludes = split(exclude);
    files
        .into_iter()
        .filter(|file| {
            (includes.is_empty() || includes.iter().any(|p| pattern_selects(p, file)))
                && !excludes.iter().any(|p| pattern_selects(p, file))
        })
        .collect()
}

/// Does `pattern` select `file`? Besides the file's own path, a pattern matching any
/// directory above the file selects the whole subtree, as VS Code's search (and gitignore)
/// treat a bare directory name: excluding `vendor` or `src/generated` prunes everything
/// under it.
fn pattern_selects(pattern: &str, file: &str) -> bool {
    if glob_match(pattern, file) {
        return true;
    }
    file.match_indices('/').any(|(at, _)| glob_match(pattern, &file[..at]))
}

/* ---------- Text search & replace ---------- */

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    /// 1-based line, 1-based character column.
    pub line: usize,
    pub column: usize,
    pub length: usize,
    pub text: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: String,
    pub matches: Vec<SearchMatch>,
}

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
    Batch { files: Vec<FileMatches> },
    Done { scanned: usize, truncated: bool, cancelled: bool },
}

/// The generation counter behind search cancellation: every search takes the next number
/// and stops as soon as the counter moves on (a newer search, or an explicit cancel).
#[derive(Default)]
pub struct SearchState {
    generation: AtomicU64,
}

impl SearchState {
    fn next(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    pub fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
}

/// Wrap a query body in the whole-word boundaries, VS Code / CodeMirror style: a `\b` only
/// where the query's own edge character is a word character, so a query with non-word edges
/// (`->`, `(int)`) keeps no boundary to demand there and still matches `a -> b`.
fn whole_word_wrap(query: &str, body: &str) -> String {
    let word_edge = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    let start = if word_edge(query.chars().next()) { r"\b" } else { "" };
    let end = if word_edge(query.chars().next_back()) { r"\b" } else { "" };
    format!("{start}(?:{body}){end}")
}

fn build_matcher(query: &str, is_regex: bool, case_sensitive: bool, word_only: bool) -> Result<Regex, String> {
    let body = if is_regex { query.to_owned() } else { regex::escape(query) };
    // The edge-character rule looks at the raw query, for a regex the same as for a literal.
    let body = if word_only { whole_word_wrap(query, &body) } else { body };
    let pattern = if case_sensitive { body } else { format!("(?i){body}") };
    Regex::new(&pattern).map_err(|e| format!("Invalid pattern: {e}"))
}

/// Read a file as bytes for the search: `None` for binary files (the shared
/// [`crate::encoding::looks_binary`] rule, so a BOM-marked UTF-16 file is not mistaken for
/// one), oversized files, and read errors (a vanished file is simply not searchable). A
/// UTF-16 file arrives decoded to UTF-8 with its encoding id remembered, so its matches are
/// found at all and a replace can write it back the way it was; anything else stays the raw
/// bytes, which are never decoded wholesale - only matched lines are.
fn read_searchable(path: &Path) -> Option<(Vec<u8>, &'static str)> {
    if fs::metadata(path).map(|m| m.len()).unwrap_or(u64::MAX) > MAX_TEXT_FILE {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if crate::encoding::looks_binary(&bytes) {
        return None;
    }
    if let Some((encoding, bom_len)) = encoding_rs::Encoding::for_bom(&bytes) {
        let id = if encoding == encoding_rs::UTF_16LE {
            "utf-16le"
        } else if encoding == encoding_rs::UTF_16BE {
            "utf-16be"
        } else {
            ""
        };
        if !id.is_empty() {
            let (text, had_errors) = encoding.decode_without_bom_handling(&bytes[bom_len..]);
            // Malformed UTF-16 cannot round-trip a replace; such a file stays unsearchable.
            return (!had_errors).then(|| (text.into_owned().into_bytes(), id));
        }
    }
    Some((bytes, "utf8"))
}

/// The write half of [`read_searchable`]: bytes decoded from a BOM-marked UTF-16 file go
/// back out in the same encoding; anything else is written as the raw bytes it was.
fn encode_searchable(text: Vec<u8>, encoding: &str) -> Vec<u8> {
    match encoding {
        "utf-16le" | "utf-16be" => crate::encoding::encode(&String::from_utf8_lossy(&text), encoding, "lf"),
        _ => text,
    }
}

/// Scan raw bytes, decoding only the lines that have at least one hit. Columns and lengths are
/// character counts, so byte offsets are mapped through the decoded line.
fn scan_text(bytes: &[u8], matcher: &Regex) -> Vec<SearchMatch> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut line_no = 0usize;
    loop {
        line_no += 1;
        let end = match bytes[start..].iter().position(|&b| b == b'\n') {
            Some(p) => start + p,
            None => bytes.len(),
        };
        let mut line_end = end;
        if line_end > start && bytes[line_end - 1] == b'\r' {
            line_end -= 1;
        }
        let line = &bytes[start..line_end];
        let mut text: Option<String> = None;
        for hit in matcher.find_iter(line) {
            let text = text.get_or_insert_with(|| String::from_utf8_lossy(line).into_owned());
            let column = text.char_indices().take_while(|(i, _)| *i < hit.start()).count() + 1;
            let length = String::from_utf8_lossy(&line[hit.start()..hit.end()]).chars().count();
            out.push(SearchMatch { line: line_no, column, length, text: text.clone() });
        }
        if end == bytes.len() {
            return out;
        }
        start = end + 1;
    }
}

/// One file's matches by size: small files go through the whole-read path, anything over
/// `MAX_TEXT_FILE` streams — a giant `.asc` trace is as searchable as a source file, without
/// ever holding it in memory. `None` leaves the file invisible to the search, the rules
/// [`read_searchable`] already applies.
fn scan_file(path: &Path, matcher: &Regex, budget: usize, cancelled: &dyn Fn() -> bool) -> Option<Vec<SearchMatch>> {
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
fn scan_stream(path: &Path, matcher: &Regex, budget: usize, cancelled: &dyn Fn() -> bool) -> Option<Vec<SearchMatch>> {
    use std::io::BufRead as _;
    let file = fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    // The peek through fill_buf does not consume: the sniff decides, then the walk starts at 0.
    let head = reader.fill_buf().ok()?;
    if crate::encoding::looks_binary(head) {
        return None;
    }
    if matches!(encoding_rs::Encoding::for_bom(head), Some((e, _)) if e == encoding_rs::UTF_16LE || e == encoding_rs::UTF_16BE) {
        return None;
    }
    let mut out = Vec::new();
    let mut buf: Vec<u8> = Vec::with_capacity(256);
    let mut bytes = 0u64;
    let mut line_no = 0usize;
    loop {
        if line_no % 4096 == 0 && cancelled() {
            return Some(out);
        }
        match crate::can_log::read_line_bounded(&mut reader, &mut buf, &mut bytes) {
            Ok(crate::can_log::LineRead::Line) => {
                line_no += 1;
                let mut text: Option<String> = None;
                for hit in matcher.find_iter(&buf) {
                    let text = text.get_or_insert_with(|| String::from_utf8_lossy(&buf).into_owned());
                    let column = text.char_indices().take_while(|(i, _)| *i < hit.start()).count() + 1;
                    let length = String::from_utf8_lossy(&buf[hit.start()..hit.end()]).chars().count();
                    out.push(SearchMatch { line: line_no, column, length, text: text.clone() });
                }
                if out.len() >= budget {
                    return Some(out);
                }
            }
            Ok(crate::can_log::LineRead::Overlong) => line_no += 1,
            Ok(crate::can_log::LineRead::Eof) => return Some(out),
            Err(_) => return None,
        }
    }
}

/// How long the file list serves repeat searches without a re-walk - shared with Quick Open's
/// cache, so one walk feeds both and Explorer mutations drop it for both.
const FILE_LIST_TTL: Duration = Duration::from_secs(5);

/// Files per streamed batch: small enough that the first batch lands within a few
/// milliseconds on any tree, large enough that rayon has work to spread across the cores.
const BATCH_FILES: usize = 256;

/// The scan itself: the (path-ordered) file list is taken in batches, each batch read and
/// matched in parallel, and every batch with hits is handed to `emit` in path order - so the
/// view fills top-down while the walk continues. Stops at the match cap or when `cancelled`
/// says so; returns how many files were scanned, whether the cap was hit, and whether it was
/// cancelled. The cancellation flag is also honoured inside one file's streaming scan, so it
/// must be shareable across rayon workers.
fn search_files(
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
                (!matches.is_empty()).then(|| FileMatches { path: relative.clone(), matches })
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

fn search_root(files: Vec<String>, root: &str, query: &str, is_regex: bool, case_sensitive: bool, word_only: bool) -> Result<SearchOutcome, String> {
    let matcher = build_matcher(query, is_regex, case_sensitive, word_only)?;
    let mut all = Vec::new();
    let (scanned, truncated, _) = search_files(&files, root, &matcher, |batch| all.extend(batch), || false);
    Ok(SearchOutcome { files: all, truncated, scanned })
}

/// Search every file of the open folder, streaming results over `on_event`. `query` is a
/// substring or (with `isRegex`) a regular expression; batches arrive grouped by file, files
/// ordered by path. A newer search or `search_cancel` stops this one, which still ends with
/// a `done { cancelled: true }` so the view never waits on a search that will not finish.
// Tauri commands mirror the frontend's argument object one parameter each; the search has
// seven options plus its channel.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn search_workspace(
    state: State<'_, AppState>,
    query: String,
    is_regex: bool,
    case_sensitive: bool,
    include: Option<String>,
    exclude: Option<String>,
    word_only: Option<bool>,
    repo: Option<String>,
    on_event: Channel<SearchEvent>,
) -> Result<(), String> {
    let generation = state.search.next();
    if query.is_empty() {
        let _ = on_event.send(SearchEvent::Done { scanned: 0, truncated: false, cancelled: false });
        return Ok(());
    }
    let root = repo
        .or_else(|| state.first_repo())
        .ok_or_else(|| "No folder is open".to_string())?;
    let matcher = build_matcher(&query, is_regex, case_sensitive, word_only.unwrap_or(false))?;
    let files = filter_paths(
        cached_file_list(&state.file_list_cache, &root, FILE_LIST_TTL, walk_files),
        include.as_deref().unwrap_or(""),
        exclude.as_deref().unwrap_or(""),
    );
    let search = state.search.clone();
    // The scan is CPU- and IO-bound rayon work: it runs on a blocking thread so the async
    // runtime (and every other command) stays responsive while a big tree is searched.
    tauri::async_runtime::spawn_blocking(move || {
        let (scanned, truncated, cancelled) = search_files(
            &files,
            &root,
            &matcher,
            |batch| {
                let _ = on_event.send(SearchEvent::Batch { files: batch });
            },
            || !search.is_current(generation),
        );
        let _ = on_event.send(SearchEvent::Done { scanned, truncated, cancelled });
    })
    .await
    .map_err(|e| format!("The search thread failed: {e}"))
}

/// Stop the running search (the view calls this when its query is cleared or it is hidden).
#[tauri::command]
pub fn search_cancel(state: State<'_, AppState>) {
    state.search.cancel();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOutcome {
    pub files: usize,
    pub replacements: usize,
    pub failed: usize,
}

/// Replace `matcher`'s matches line by line - the semantics `scan_text` searches with, so a
/// Replace All rewrites exactly the set the results listed: `^`/`$` anchor at every line, a
/// pattern containing a newline never matches, and each line's terminator (a kept `\r`, the
/// `\n`) survives untouched.
fn replace_per_line(bytes: &[u8], matcher: &Regex, replacement: &str) -> (Vec<u8>, usize) {
    let mut out = Vec::with_capacity(bytes.len());
    let mut count = 0usize;
    let mut start = 0usize;
    loop {
        let end = match bytes[start..].iter().position(|&b| b == b'\n') {
            Some(p) => start + p,
            None => bytes.len(),
        };
        let mut line_end = end;
        if line_end > start && bytes[line_end - 1] == b'\r' {
            line_end -= 1;
        }
        let replaced = matcher.replace_all(&bytes[start..line_end], |caps: &regex::bytes::Captures| {
            count += 1;
            let mut expanded = Vec::new();
            caps.expand(replacement.as_bytes(), &mut expanded);
            expanded
        });
        out.extend_from_slice(&replaced);
        out.extend_from_slice(&bytes[line_end..end]);
        if end == bytes.len() {
            return (out, count);
        }
        out.push(b'\n');
        start = end + 1;
    }
}

fn replace_root(files: Vec<String>, root: &str, query: &str, replacement: &str, is_regex: bool, case_sensitive: bool, word_only: bool) -> Result<ReplaceOutcome, String> {
    // An empty query would match the empty string at every byte position; like the search,
    // it is a no-op.
    if query.is_empty() {
        return Ok(ReplaceOutcome { files: 0, replacements: 0, failed: 0 });
    }
    let matcher = build_matcher(query, is_regex, case_sensitive, word_only)?;
    let results: Vec<Option<(usize, bool)>> = files
        .into_par_iter()
        .map(|relative| {
            let path = Path::new(root).join(&relative);
            let (text, encoding) = read_searchable(&path)?;
            let (replaced, count) = replace_per_line(&text, &matcher, replacement);
            // Report a failed write instead of discarding the count, which would make the
            // replace look like it never matched anything.
            let failed = count > 0 && fs::write(&path, encode_searchable(replaced, encoding)).is_err();
            Some((count, failed))
        })
        .collect();
    let replacements: usize = results.iter().flatten().map(|(c, _)| *c).sum();
    let files = results.iter().flatten().filter(|(c, _)| *c > 0).count();
    let failed = results.iter().flatten().filter(|(_, f)| *f).count();
    Ok(ReplaceOutcome { files, replacements, failed })
}

/// Replace every match in every file of the open folder. Files are rewritten whole; the file
/// list cache is dropped so Quick Open and the search see the new state.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // the search options mirror search_workspace's
pub async fn replace_in_files(
    state: State<'_, AppState>,
    query: String,
    replacement: String,
    is_regex: bool,
    case_sensitive: bool,
    include: Option<String>,
    exclude: Option<String>,
    repo: Option<String>,
    word_only: Option<bool>,
) -> Result<ReplaceOutcome, String> {
    let root = repo
        .or_else(|| state.first_repo())
        .ok_or_else(|| "No folder is open".to_string())?;
    let files = filter_paths(
        cached_file_list(&state.file_list_cache, &root, FILE_LIST_TTL, walk_files),
        include.as_deref().unwrap_or(""),
        exclude.as_deref().unwrap_or(""),
    );
    let outcome = replace_root(files, &root, &query, &replacement, is_regex, case_sensitive, word_only.unwrap_or(false))?;
    state.file_list_cache.invalidate();
    Ok(outcome)
}

/* ---------- Folder comparison ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirDiffEntry {
    pub path: String,
    /// `leftOnly`, `rightOnly`, `different`, `same`.
    pub status: String,
    pub left_size: u64,
    pub right_size: u64,
}

/// A file walk without Quick Open's pruning: a folder comparison must see `node_modules` and
/// `target` too. Only `.git` is skipped.
fn walk_all_files(root: &str) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::new();
    let mut pending = vec![PathBuf::from(root)];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if kind.is_dir() {
                if name != ".git" {
                    pending.push(entry.path());
                }
            } else if kind.is_file() {
                let full = entry.path();
                let Ok(relative) = full.strip_prefix(root) else { continue };
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                out.insert(relative.to_string_lossy().replace('\\', "/"), size);
            }
        }
    }
    out
}

fn file_hash(path: &Path) -> Option<[u8; 20]> {
    let bytes = fs::read(path).ok()?;
    Some(Sha1::digest(&bytes).into())
}

fn compare_roots(left: &str, right: &str, include: &str, exclude: &str) -> Result<Vec<DirDiffEntry>, String> {
    for (label, dir) in [("left", left), ("right", right)] {
        if !Path::new(dir).is_dir() {
            return Err(format!("The {label} folder does not exist: {dir}"));
        }
    }
    let left_files = walk_all_files(left);
    let right_files = walk_all_files(right);
    let mut paths: Vec<&String> = left_files.keys().chain(right_files.keys()).collect();
    paths.sort();
    paths.dedup();
    let mut entries = Vec::new();
    for path in filter_paths(paths.into_iter().cloned().collect(), include, exclude) {
        let (l_size, r_size) = (left_files.get(&path).copied(), right_files.get(&path).copied());
        let status = match (l_size, r_size) {
            (Some(_), None) => "leftOnly",
            (None, Some(_)) => "rightOnly",
            (Some(l), Some(r)) => {
                if l != r {
                    "different"
                } else {
                    let lp = Path::new(left).join(&path);
                    let rp = Path::new(right).join(&path);
                    let same = match (file_hash(&lp), file_hash(&rp)) {
                        (Some(a), Some(b)) => a == b,
                        _ => false,
                    };
                    if same { "same" } else { "different" }
                }
            }
            (None, None) => continue,
        };
        entries.push(DirDiffEntry {
            path,
            status: status.to_owned(),
            left_size: l_size.unwrap_or(0),
            right_size: r_size.unwrap_or(0),
        });
    }
    Ok(entries)
}

/// Compare two folders file by file. Equal sizes hash to equal content before two files are
/// called the same. Directories themselves are not reported - only files, with their status.
#[tauri::command]
pub async fn compare_dirs(left: String, right: String, include: Option<String>, exclude: Option<String>) -> Result<Vec<DirDiffEntry>, String> {
    compare_roots(&left, &right, include.as_deref().unwrap_or(""), exclude.as_deref().unwrap_or(""))
}

/* ---------- The workspace symbol index ---------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSymbol {
    pub kind: String,
    pub name: String,
    /// Repo-relative, forward slashes.
    pub path: String,
    /// 0-based line of the declaration.
    pub line: usize,
}

/// The extensions the outline extractor can parse; everything else is skipped.
pub(crate) const SYMBOL_EXTENSIONS: &[&str] = &["rs", "py", "go", "ts", "tsx", "js", "jsx", "java", "c", "h", "cpp", "hpp", "cs"];

/// The per-root symbol index cache (a multi-root workspace keeps one slot per root): which
/// folder each index was built for, when, and the symbols.
#[derive(Default)]
pub struct SymbolCache(Mutex<std::collections::HashMap<String, (Instant, Vec<WorkspaceSymbol>)>>);

impl SymbolCache {
    /// Drop the index: a source file changed on disk, or the folder was switched.
    pub fn invalidate(&self) {
        self.0.lock().unwrap().clear();
    }
}

/// Whether a repo-relative path is one the symbol index reads (by extension).
pub fn is_symbol_source(path: &str) -> bool {
    match path.rsplit_once('.') {
        Some((_, ext)) => SYMBOL_EXTENSIONS.contains(&ext),
        None => false,
    }
}

/// Build the whole-workspace symbol list, one file per rayon task. Files the extractor does
/// not know contribute nothing, and read errors are skipped - the index is best-effort.
fn index_symbols(root: &str) -> Vec<WorkspaceSymbol> {
    let files: Vec<String> = walk_files(root)
        .into_iter()
        .filter(|file| {
            let ext = file.rsplit('.').next().unwrap_or("");
            SYMBOL_EXTENSIONS.contains(&ext)
        })
        .collect();
    let indexed: Vec<Vec<WorkspaceSymbol>> = files
        .into_par_iter()
        .map(|relative| {
            let path = PathBuf::from(root).join(&relative);
            let Ok(text) = fs::read_to_string(&path) else { return Vec::new() };
            let ext = relative.rsplit('.').next().unwrap_or("").to_owned();
            crate::viewer::outline_symbols_for(&text, &ext)
                .into_iter()
                .map(|s| WorkspaceSymbol { kind: s.kind, name: s.name, path: relative.clone(), line: s.line })
                .collect()
        })
        .collect();
    let mut all: Vec<WorkspaceSymbol> = indexed.into_iter().flatten().collect();
    all.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    all
}

/// The whole-workspace symbol index of a folder, built fresh (the `--measure` probe).
pub fn index_symbols_of(root: &str) -> Vec<WorkspaceSymbol> {
    index_symbols(root)
}

/// A literal, case-insensitive search over an already-walked file list (the `--measure` probe).
pub fn search_literal(files: &[String], root: &str, query: &str) -> Result<SearchOutcome, String> {
    search_root(files.to_vec(), root, query, false, false, false)
}

/// Serve the symbol index from the per-folder cache when it is fresh; otherwise rebuild it.
fn cached_symbols(root: &str, cache: &SymbolCache) -> Vec<WorkspaceSymbol> {
    {
        let cached = cache.0.lock().unwrap();
        if let Some((at, symbols)) = cached.get(root) {
            if at.elapsed() < SYMBOL_TTL {
                return symbols.clone();
            }
        }
    }
    let symbols = index_symbols(root);
    cache
        .0
        .lock()
        .unwrap()
        .insert(root.to_owned(), (Instant::now(), symbols.clone()));
    symbols
}

/// Every workspace symbol whose name contains the (case-insensitive) query; an empty query
/// returns the first `limit` symbols, so the frontend can list "all" for the call tree.
#[tauri::command]
pub async fn workspace_symbols(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
    repo: Option<String>,
) -> Result<Vec<WorkspaceSymbol>, String> {
    let root = repo
        .or_else(|| state.first_repo())
        .ok_or_else(|| "No folder is open".to_string())?;
    let all = cached_symbols(&root, &state.symbol_cache);
    let needle = query.to_lowercase();
    let mut hits: Vec<WorkspaceSymbol> = all
        .into_iter()
        .filter(|s| needle.is_empty() || s.name.to_lowercase().contains(&needle))
        .collect();
    if let Some(limit) = limit {
        hits.truncate(limit);
    }
    Ok(hits)
}

/* ---------- Find references ---------- */

/// Every occurrence of `name` as a whole word in the workspace's code files - the raw material
/// of Find References and the call tree, which filter and rank it frontend-side.
#[tauri::command]
pub async fn find_references(state: State<'_, AppState>, name: String) -> Result<Vec<FileMatches>, String> {
    let root = state.first_repo().ok_or_else(|| "No folder is open".to_string())?;
    let matcher = build_matcher(&name, false, true, true)?;
    let files: Vec<String> = walk_files(&root)
        .into_iter()
        .filter(|file| {
            let ext = file.rsplit('.').next().unwrap_or("");
            SYMBOL_EXTENSIONS.contains(&ext)
        })
        .collect();
    let found: Vec<Option<FileMatches>> = files
        .into_par_iter()
        .map(|relative| {
            let (text, _) = read_searchable(&Path::new(&root).join(&relative))?;
            let matches = scan_text(&text, &matcher);
            (!matches.is_empty()).then_some(FileMatches { path: relative, matches })
        })
        .collect();
    let mut files: Vec<FileMatches> = found.into_iter().flatten().collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/* ---------- Hex comparison ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HexRow {
    pub offset: u64,
    pub a: Vec<u8>,
    pub b: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HexDiff {
    pub identical: bool,
    pub size_a: u64,
    pub size_b: u64,
    /// The differing 16-byte rows, in order, capped.
    pub rows: Vec<HexRow>,
}

const HEX_ROW: usize = 16;
const MAX_HEX_ROWS: usize = 400;

fn hex_of(a: Vec<u8>, b: Vec<u8>) -> HexDiff {
    let identical = a == b;
    let mut rows = Vec::new();
    if !identical {
        for row in 0..a.len().div_ceil(HEX_ROW).max(b.len().div_ceil(HEX_ROW)) {
            if rows.len() >= MAX_HEX_ROWS {
                break;
            }
            let start = row * HEX_ROW;
            let sa = &a[start.min(a.len())..(start + HEX_ROW).min(a.len())];
            let sb = &b[start.min(b.len())..(start + HEX_ROW).min(b.len())];
            if sa != sb {
                rows.push(HexRow { offset: start as u64, a: sa.to_vec(), b: sb.to_vec() });
            }
        }
    }
    HexDiff { identical, size_a: a.len() as u64, size_b: b.len() as u64, rows }
}

fn bytes_at(git: &crate::git::Git, root: &str, revision: &str, path: &str) -> Result<Vec<u8>, String> {
    if revision == "*" {
        return fs::read(Path::new(root).join(path)).map_err(|e| format!("{path}: {e}"));
    }
    let spec = if revision == ":index" { format!(":{path}") } else { format!("{revision}:{path}") };
    let output = git.command().args(["cat-file", "blob", &spec]).output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("git cat-file failed for {spec}"));
    }
    Ok(output.stdout)
}

/// Byte-level comparison of one file at two revisions (or in two working trees, with `*` and
/// repo-relative paths). Reports the differing 16-byte rows for the hex view.
#[tauri::command]
pub async fn hex_diff(
    state: State<'_, AppState>,
    revision_a: String,
    revision_b: String,
    path_a: String,
    path_b: String,
) -> Result<HexDiff, String> {
    let root = state.first_repo().ok_or_else(|| "No folder is open".to_string())?;
    let git = crate::git::Git::new(&root);
    let a = bytes_at(&git, &root, &revision_a, &path_a)?;
    let b = bytes_at(&git, &root, &revision_b, &path_b)?;
    Ok(hex_of(a, b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globs_match_paths_like_vs_code_search() {
        assert!(glob_match("**/*.rs", "main.rs"));
        assert!(glob_match("**/*.rs", "src/lib.rs"));
        assert!(!glob_match("**/*.rs", "src/lib.ts"));
        assert!(glob_match("src/*", "src/a.rs"));
        assert!(!glob_match("src/*", "src/sub/a.rs"));
        assert!(glob_match("src/**", "src/sub/a.rs"));
        assert!(glob_match("*.ts", "app/main.ts"));
        assert!(glob_match("a?c.txt", "abc.txt"));
    }

    #[test]
    fn filter_paths_applies_include_and_exclude() {
        let files = vec!["a.rs".to_owned(), "src/b.rs".to_owned(), "c.ts".to_owned()];
        assert_eq!(filter_paths(files.clone(), "*.rs", ""), ["a.rs", "src/b.rs"]);
        assert_eq!(filter_paths(files.clone(), "", "src/*"), ["a.rs", "c.ts"]);
        assert_eq!(filter_paths(files, "**/*.rs", "src/**"), ["a.rs"]);
    }

    #[test]
    fn scan_text_reports_line_column_and_length_in_characters() {
        let matcher = Regex::new("fn").unwrap();
        let hits = scan_text("alpha fn beta\nfn gamma\n".as_bytes(), &matcher);
        assert_eq!(hits.len(), 2);
        assert_eq!((hits[0].line, hits[0].column, hits[0].length), (1, 7, 2));
        assert_eq!((hits[1].line, hits[1].column), (2, 1));
        assert_eq!(hits[0].text, "alpha fn beta");
    }

    #[test]
    fn search_finds_matches_and_respects_case_and_glob_filters() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn alpha() {}\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "alpha beta alpha\n").unwrap();
        let root = dir.path().display().to_string();

        let outcome = search_root(filter_paths(walk_files(&root), "*.rs", ""), &root, "alpha", false, false, false).unwrap();
        assert_eq!(outcome.scanned, 1);
        assert_eq!(outcome.files.len(), 1);
        assert_eq!(outcome.files[0].path, "a.rs");

        let none = search_root(filter_paths(walk_files(&root), "", ""), &root, "Alpha", false, true, false).unwrap();
        assert!(none.files.is_empty());
    }

    #[test]
    fn search_streams_batches_in_path_order_and_stops_when_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..600 {
            std::fs::write(dir.path().join(format!("f{i:04}.txt")), "needle\n").unwrap();
        }
        let root = dir.path().display().to_string();
        let files = walk_files(&root);
        let matcher = build_matcher("needle", false, false, false).unwrap();

        // Uncancelled: every file is scanned, batches arrive in path order.
        let mut batches: Vec<Vec<String>> = Vec::new();
        let (scanned, truncated, cancelled) = search_files(&files, &root, &matcher, |b| batches.push(b.iter().map(|f| f.path.clone()).collect()), || false);
        assert_eq!((scanned, truncated, cancelled), (600, false, false));
        assert!(batches.len() >= 2, "600 files must stream as more than one batch");
        let flat: Vec<String> = batches.concat();
        assert_eq!(flat, files);

        // Cancelled after the first batch: the scan stops and says so. The flag is an atomic
        // because the cancellation is also checked inside rayon's per-file workers.
        let seen = std::sync::atomic::AtomicUsize::new(0);
        let (scanned, _, cancelled) = search_files(&files, &root, &matcher, |_| { seen.fetch_add(1, Ordering::SeqCst); }, || seen.load(Ordering::SeqCst) >= 1);
        assert!(cancelled);
        assert!(scanned < 600);
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

        let outcome = search_root(walk_files(&root), &root, "needle", false, false, false).unwrap();
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
        std::fs::write(dir.path().join("ok.txt"), format!("{}\nneedle\n", "padding".repeat(MAX_TEXT_FILE as usize / 6 + 8))).unwrap();
        let root = dir.path().display().to_string();

        let outcome = search_root(walk_files(&root), &root, "needle", false, false, false).unwrap();
        let paths: Vec<&str> = outcome.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["ok.txt"]);

        // A cancelled search stops mid-stream: the well-lined file yields nothing once the
        // flag is up before its first line settles in.
        let matcher = build_matcher("needle", false, false, false).unwrap();
        let hits = scan_stream(&dir.path().join("ok.txt"), &matcher, MAX_MATCHES, &|| true).unwrap();
        assert!(hits.is_empty());
        let hits = scan_stream(&dir.path().join("ok.txt"), &matcher, MAX_MATCHES, &|| false).unwrap();
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
        let matcher = build_matcher("needle", false, false, false).unwrap();
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
        let outcome = search_root(walk_files(&root), &root, "x", false, false, false).unwrap();
        assert!(outcome.truncated);
        assert_eq!(outcome.files.iter().map(|f| f.matches.len()).sum::<usize>(), MAX_MATCHES);
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
    fn replace_rewrites_files_and_counts() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x y x\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "z\n").unwrap();
        let root = dir.path().display().to_string();
        let outcome = replace_root(filter_paths(walk_files(&root), "", ""), &root, "x", "w", false, false, false).unwrap();
        assert_eq!((outcome.files, outcome.replacements), (1, 2));
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "w y w\n");
    }

    #[test]
    fn replace_counts_unwritable_files_instead_of_dropping_them() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x y\n").unwrap();
        let locked = dir.path().join("b.txt");
        std::fs::write(&locked, "x z\n").unwrap();
        let mut perms = std::fs::metadata(&locked).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&locked, perms).unwrap();
        let root = dir.path().display().to_string();

        let outcome = replace_root(filter_paths(walk_files(&root), "", ""), &root, "x", "w", false, false, false).unwrap();
        // The writable file is replaced normally; the locked one is reported, not silently
        // dropped from the counts.
        assert_eq!((outcome.files, outcome.replacements, outcome.failed), (2, 2, 1));
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "w y\n");

        // Clearing the read-only bit so the temp dir can be removed (clippy warns that on Unix
        // this alone does not make a file world-writable; here it only undoes the line above).
        #[allow(clippy::permissions_set_readonly_false)]
        {
            let mut perms = std::fs::metadata(&locked).unwrap().permissions();
            perms.set_readonly(false);
            std::fs::set_permissions(&locked, perms).unwrap();
        }
    }

    #[test]
    fn compare_dirs_reports_statuses() {
        let left = tempfile::tempdir().unwrap();
        let right = tempfile::tempdir().unwrap();
        std::fs::write(left.path().join("same.txt"), b"x").unwrap();
        std::fs::write(right.path().join("same.txt"), b"x").unwrap();
        std::fs::write(left.path().join("diff.txt"), b"1").unwrap();
        std::fs::write(right.path().join("diff.txt"), b"2").unwrap();
        std::fs::write(left.path().join("only-l.txt"), b"").unwrap();
        std::fs::write(right.path().join("only-r.txt"), b"").unwrap();

        let mut entries = compare_roots(&left.path().display().to_string(), &right.path().display().to_string(), "", "").unwrap();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        let by_path: std::collections::BTreeMap<&str, &str> =
            entries.iter().map(|e| (e.path.as_str(), e.status.as_str())).collect();
        assert_eq!(by_path["same.txt"], "same");
        assert_eq!(by_path["diff.txt"], "different");
        assert_eq!(by_path["only-l.txt"], "leftOnly");
        assert_eq!(by_path["only-r.txt"], "rightOnly");
    }

    #[test]
    fn index_symbols_extracts_rust_functions() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("lib.rs"), "pub fn alpha() {}\nfn beta() {}\n").unwrap();
        let symbols = index_symbols(&dir.path().display().to_string());
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["alpha", "beta"]);
        assert_eq!(symbols[0].path, "lib.rs");
        assert_eq!(symbols[0].line, 0);
        assert_eq!(symbols[0].kind, "function");
    }

    #[test]
    fn hex_rows_mark_differing_bytes() {
        let a = vec![0u8; 40];
        let mut b = vec![0u8; 40];
        b[20] = 1;
        let diff = hex_of(a, b);
        assert!(!diff.identical);
        assert_eq!(diff.rows.len(), 1);
        assert_eq!(diff.rows[0].offset, 16);
        assert_eq!(diff.rows[0].b[4], 1);
        assert!(hex_of(vec![1, 2], vec![1, 2]).identical);
    }

    #[test]
    fn replace_uses_the_searchs_per_line_semantics() {
        // `^` anchors at a line start for the per-line search, so Replace All must rewrite
        // every line the search listed - not just the first line of the file.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "foo one\nbar\nfoo two\n").unwrap();
        let root = dir.path().display().to_string();
        let outcome = replace_root(walk_files(&root), &root, "^foo", "X", true, false, false).unwrap();
        assert_eq!(outcome.replacements, 2);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "X one\nbar\nX two\n");
    }

    #[test]
    fn replace_never_matches_across_lines_like_the_search() {
        // A pattern containing a newline can never match the per-line search, so Replace All
        // must not rewrite text the results never listed.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "a\nb\n").unwrap();
        let root = dir.path().display().to_string();
        let outcome = replace_root(walk_files(&root), &root, "a\nb", "x", false, false, false).unwrap();
        assert_eq!(outcome.replacements, 0);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "a\nb\n");
    }

    #[test]
    fn whole_word_demands_boundaries_only_at_word_character_edges() {
        let word = |query: &str| build_matcher(query, false, true, true).unwrap();
        // Word-character edges keep their boundaries.
        assert_eq!(scan_text("a foo b afoo foob\n".as_bytes(), &word("foo")).len(), 1);
        // A non-word edge has no boundary to demand: `->` matches spaced too, and `(int)`
        // matches at a line start.
        assert_eq!(scan_text("a -> b\n".as_bytes(), &word("->")).len(), 1);
        assert_eq!(scan_text("(int) x\n".as_bytes(), &word("(int)")).len(), 1);
        // The same edge rule applies to the raw text of a regex query.
        let regex = build_matcher(r"\(int\)", true, true, true).unwrap();
        assert_eq!(scan_text("(int) x\n".as_bytes(), &regex).len(), 1);
    }

    #[test]
    fn utf16_files_with_a_bom_are_searched_and_replaced_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "foo bar\nbaz\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let file = dir.path().join("u.txt");
        std::fs::write(&file, &bytes).unwrap();
        let root = dir.path().display().to_string();

        let outcome = search_root(walk_files(&root), &root, "bar", false, false, false).unwrap();
        assert_eq!(outcome.files.len(), 1);
        assert_eq!(outcome.files[0].matches.len(), 1);
        assert_eq!((outcome.files[0].matches[0].line, outcome.files[0].matches[0].column), (1, 5));
        assert_eq!(outcome.files[0].matches[0].text, "foo bar");

        // A replace writes the file back as UTF-16, not as re-encoded UTF-8.
        let outcome = replace_root(walk_files(&root), &root, "bar", "qux", false, false, false).unwrap();
        assert_eq!(outcome.replacements, 1);
        let written = std::fs::read(&file).unwrap();
        let decoded = crate::encoding::decode(&written, None);
        assert_eq!((decoded.text.as_str(), decoded.encoding), ("foo qux\nbaz\n", "utf-16le"));
    }

    #[test]
    fn binary_files_stay_invisible_to_the_search() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("b.bin"), b"foo\0bar\n").unwrap();
        let root = dir.path().display().to_string();
        let outcome = search_root(walk_files(&root), &root, "bar", false, false, false).unwrap();
        assert!(outcome.files.is_empty());
    }

    #[test]
    fn a_pattern_also_matches_directories_pruning_their_subtrees() {
        let files = vec![
            "src/a.rs".to_owned(),
            "vendor/lib.js".to_owned(),
            "src/generated/g.rs".to_owned(),
            "vendorized/x.js".to_owned(),
        ];
        // A bare name prunes a directory at any depth; a path prefix prunes its subtree.
        assert_eq!(filter_paths(files.clone(), "", "vendor"), ["src/a.rs", "src/generated/g.rs", "vendorized/x.js"]);
        assert_eq!(filter_paths(files.clone(), "", "src/generated"), ["src/a.rs", "vendor/lib.js", "vendorized/x.js"]);
        // As an include, a directory name selects its subtree.
        assert_eq!(filter_paths(files, "vendor", ""), ["vendor/lib.js"]);
    }

    #[test]
    fn an_empty_replace_query_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "hello\n").unwrap();
        let root = dir.path().display().to_string();
        let outcome = replace_root(walk_files(&root), &root, "", "x", false, false, false).unwrap();
        assert_eq!((outcome.files, outcome.replacements, outcome.failed), (0, 0, 0));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello\n");
    }

    #[test]
    fn include_patterns_split_on_commas_only_keeping_spaces() {
        let files = vec!["my docs/a.txt".to_owned(), "src/b.txt".to_owned()];
        assert_eq!(filter_paths(files, "my docs/**", ""), ["my docs/a.txt"]);
        let files = vec!["a.rs".to_owned(), "b.txt".to_owned()];
        assert_eq!(filter_paths(files, "*.rs, *.txt", ""), ["a.rs", "b.txt"]);
    }
}
