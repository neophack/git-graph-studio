//! The symbol store: the workspace's declarations and their occurrences in one compact,
//! little-endian binary per root, living in the analyzed folder's own hidden analysis
//! database (`.ggs/analysis/<hash>/symbols.bin` — 2026-11-21, the owner's direction: a
//! project-local analysis database, a hidden folder the program may delete at any
//! time and never enters the git index; the next query regenerates the same files; a
//! read-only folder falls back to `~/.ggs/index/<hash>/`, the pre-2026-11-21 home whose
//! older copies still resume). Design:
//!
//! - **Names are interned.** Every declared name appears once; files reference it by id.
//! - **Files carry fingerprints** (mtime + size), so an incremental update re-extracts only
//!   what changed and a restart resumes from disk.
//! - **Occurrences are per-name file lists** (the "refs"): which files contain the word at
//!   all. Find References narrows its scan to those files instead of walking the tree — the
//!   positions themselves are still matched on demand, so a reference is never stale text.
//! - **Trust is explicit.** A name added by an incremental update may also occur in files
//!   the update did not touch, so its occurrence list is marked untrusted and references to
//!   it fall back to a full scan until the next full build.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rayon::prelude::*;

use crate::scan::is_symbol_source;
use crate::symbols::anadb;
use crate::symbols::WorkspaceSymbol;
use ggs_fs::walk_files;

/// The symbol kinds the parser layer produces, as ids on disk. The order is the format:
/// a kind byte is an index into this table — new kinds are appended, never inserted.
const KINDS: &[&str] = &[
    "function",
    "method",
    "class",
    "struct",
    "interface",
    "enum",
    "module",
    "type",
    "macro",
    "variable",
];

fn kind_id(kind: &str) -> u8 {
    KINDS.iter().position(|k| *k == kind).unwrap_or(0) as u8
}

fn kind_name(id: u8) -> &'static str {
    KINDS.get(id as usize).copied().unwrap_or(KINDS[0])
}

/// The format marker: a corrupt or foreign file is discarded, never fatal.
const MAGIC: &[u8; 6] = b"GGSIDX";
/// Format 2 (the tree-sitter parser layer, plan M4.1): symbols gained a column, an end
/// line and an interned container name. A version-1 file fails the load below and is
/// rebuilt from scratch.
/// Format 3: the C/C++ queries index variables and require a struct/enum/class body —
/// a version-2 file holds the old shapes (no variables, every `struct T` use indexed as
/// a definition) and is rebuilt from scratch the same way.
/// Format 4 (2026-11-18): scope-local declarations — a function's parameters and locals —
/// no longer ride the global index (they resolve per file against their scope), so a
/// version-3 file holds names and entries the global index must not serve and is rebuilt.
/// Format 5 (2026-11-19): parameters without an enclosing function — a prototype's, a
/// function-pointer typedef's — own nothing and are no longer indexed at all; a
/// version-4 file holds them stored under the KINDS fallback kind and is rebuilt.
/// Format 6 (2026-11-20): a class-like declaration carries its base types' names (the
/// relation window's Base/Derived Classes rings) as a per-file side table; a version-5
/// file has no such table and is rebuilt.
/// Format 7 (2026-11-20, the same day): the container walk stopped matching a class-like
/// declaration's own node — a self-container made every C++/Java/C#/TS class its own
/// member and blinded the nested-class chains; a version-6 file carries those rows and
/// is rebuilt.
const VERSION: u8 = 7;

/// The hidden per-project analysis folder (2026-11-21, the owner's direction: add a hidden
/// code-analysis folder inside the project — the program may delete it, it never enters
/// the git index, and the same files regenerate): the
/// store lives beside the code it describes, one hidden folder per project.
/// Deleting it loses nothing — the next query regenerates the same bytes — and the walk's
/// `SKIPPED_DIRS` keeps search and re-index out of it.
pub const PROJECT_ANALYSIS_DIR: &str = ".ggs";

/// The per-root directory name under the analysis folder: the root path's SHA-1 prefix,
/// the same hash on every machine, so two app instances over one folder meet on one store.
fn store_hash(root: &str) -> String {
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(root.as_bytes());
    let hash = hex::encode(hasher.finalize());
    hash[..16].to_owned()
}

/// The analysis folder hides itself the way `.git` does — git marks its own folder hidden
/// on Windows, and a bare dot name alone still shows in Explorer there.
#[cfg(windows)]
fn mark_hidden(dir: &Path) {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        windows_sys::Win32::Storage::FileSystem::SetFileAttributesW(
            wide.as_ptr(),
            windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_HIDDEN,
        );
    }
}

#[cfg(not(windows))]
fn mark_hidden(_dir: &Path) {}

/// Keep the analysis folder out of the git index without touching the project's own
/// `.gitignore`: the repo-local `.git/info/exclude` (never committed) gains the line the
/// moment the folder is created. The repository may be above the analyzed folder (an
/// opened subdirectory of a checkout), so the search ascends the way git itself resolves
/// a repository. A linked worktree's `.git` is a pointer file whose `commondir` names
/// the shared git directory the exclude actually lives in.
fn ensure_git_ignored(root: &Path) {
    let mut dir = Some(root.to_path_buf());
    let dot_git = loop {
        let Some(current) = dir else { return };
        let candidate = current.join(".git");
        if candidate.exists() {
            break candidate;
        }
        dir = current.parent().map(Path::to_path_buf);
    };
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else if dot_git.is_file() {
        let pointer = match fs::read_to_string(&dot_git) {
            Ok(text) => text,
            Err(_) => return,
        };
        let Some(rest) = pointer.trim().strip_prefix("gitdir:") else {
            return;
        };
        let target = PathBuf::from(rest.trim());
        // A relative `gitdir:` resolves against the folder holding the pointer file.
        let base = dot_git.parent().unwrap_or(root).to_path_buf();
        let target = if target.is_absolute() {
            target
        } else {
            base.join(target)
        };
        // The worktree git dir carries a `commondir` file (`../..`) pointing at the
        // shared git directory; `info/exclude` lives there, not per worktree.
        match fs::read_to_string(target.join("commondir")) {
            Ok(rel) => {
                let rel = rel.trim();
                if Path::new(rel).is_absolute() {
                    PathBuf::from(rel)
                } else {
                    target.join(rel)
                }
            }
            Err(_) => target,
        }
    } else {
        return;
    };
    let info = git_dir.join("info");
    if fs::create_dir_all(&info).is_err() {
        return;
    }
    let exclude = info.join("exclude");
    let line = format!("{}/", PROJECT_ANALYSIS_DIR);
    let existing = fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == line) {
        return;
    }
    let mut body = existing;
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }
    body.push_str(&line);
    body.push('\n');
    let _ = fs::write(&exclude, body);
}
/// The interned-name id a symbol without a container carries.
const NO_CONTAINER: u32 = u32::MAX;
/// Full builds report progress every this many files; also the cancellation checkpoint.
pub const BUILD_BATCH: usize = 256;

#[derive(Clone, Debug, PartialEq)]
struct StoredSymbol {
    kind: u8,
    name_id: u32,
    /// The enclosing type's interned name, or [`NO_CONTAINER`].
    container_id: u32,
    line: u32,
    column: u32,
    end_line: u32,
}

/// One declaration's base types, as interned name ids. The symbol field indexes the
/// file's own `symbols`; the table carries only the declarations that derive from
/// something, so a workspace without inheritance pays one empty vector per file.
#[derive(Clone, Debug, PartialEq)]
struct StoredBases {
    symbol: u32,
    bases: Vec<u32>,
}

/// One file's build scan: its path, the words it contains, its stored symbols and its
/// base records — phase 3's per-file output before it lands in the entry.
type Scanned = (
    String,
    Vec<u32>,
    Vec<StoredSymbol>,
    Vec<StoredBases>,
    Vec<(u32, u32)>,
);

/// One indexed file: its fingerprint and what it declares. `words` is the transpose of the
/// occurrence lists — the names this file contains — kept so an update can subtract the
/// file's contributions before rescanning it.
struct FileEntry {
    path: String,
    mtime_ms: u64,
    size: u64,
    symbols: Vec<StoredSymbol>,
    words: Vec<u32>,
    bases: Vec<StoredBases>,
}

/// A file's extraction, before the names are interned. `words` is the file's unique
/// identifier words, walked off the same read the symbols came from — an update never
/// re-reads the file for its occurrence list.
struct Extraction {
    path: String,
    mtime_ms: u64,
    size: u64,
    symbols: Vec<Extracted>,
    words: Vec<String>,
    /// The parse's call sites — the callee's name and its 0-based line — the reference
    /// database's call edges read from.
    calls: Vec<(String, u32)>,
}

/// One declaration as extracted, names still owned by the file.
struct Extracted {
    kind: u8,
    name: String,
    container: Option<String>,
    line: u32,
    column: u32,
    end_line: u32,
    bases: Vec<String>,
}

pub struct SymbolStore {
    root: String,
    /// Sorted by path; a file's index is its id in the occurrence lists.
    files: Vec<FileEntry>,
    /// Sorted, unique declared names.
    names: Vec<String>,
    /// Per name: the ids of the files containing the word, or `None` when the list is not
    /// trusted to be complete (the name first appeared in an incremental update).
    refs: Vec<Option<Vec<u32>>>,
    /// The reference analysis database's tables (si4-rea's si-lite format), collected on
    /// a full build and persisted beside the store as `si.db` + `si.tix`. `None` after a
    /// disk resume — the saved `si.db` stays standing untouched until the next full
    /// build (the Rebuild command's delete-and-regenerate) rewrites it whole.
    si: Option<anadb::AnaTables>,
}

pub struct BuildStats {
    pub files: usize,
    pub symbols: usize,
    pub names: usize,
}

/// One row of a single file's outline — the MCP server's `file_outline` reads it. The
/// container (the enclosing type the index has carried since format v2) rides along:
/// the flat catalogue never showed it, and a method without its class is half a name.
pub struct FileOutlineRow {
    pub kind: &'static str,
    pub name: String,
    pub container: Option<String>,
    /// 0-based, the index's own coordinate.
    pub line: usize,
    /// 0-based last line of the definition body; equals `line` when the parser could
    /// not bound it (the outline fallback). The relation window's interval attribution
    /// and the MCP server's body reads both need it.
    pub end_line: usize,
    /// How many files contain the name (the occurrence list length); untrusted lists
    /// report 0, the same honesty `symbols_with_refs` keeps.
    pub refs: usize,
}

/// What one file on disk currently is: its fingerprint, or nothing when it is gone.
struct Stat {
    mtime_ms: u64,
    size: u64,
}

fn stat_of(path: &Path) -> Option<Stat> {
    let meta = fs::metadata(path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(Stat {
        mtime_ms,
        size: meta.len(),
    })
}

impl SymbolStore {
    /// The empty store for a root (nothing indexed yet).
    pub fn empty(root: &str) -> SymbolStore {
        SymbolStore {
            root: root.to_owned(),
            files: Vec::new(),
            names: Vec::new(),
            refs: Vec::new(),
            si: None,
        }
    }

    pub fn root(&self) -> &str {
        &self.root
    }

    pub fn stats(&self) -> BuildStats {
        BuildStats {
            files: self.files.len(),
            symbols: self.files.iter().map(|f| f.symbols.len()).sum(),
            names: self.names.len(),
        }
    }

    /// Every declaration, path-then-line sorted — the same shape the in-memory index served.
    pub fn all_symbols(&self) -> Vec<WorkspaceSymbol> {
        let mut all = Vec::with_capacity(self.files.iter().map(|f| f.symbols.len()).sum());
        for file in &self.files {
            for symbol in &file.symbols {
                all.push(self.materialize(file, symbol));
            }
        }
        all
    }

    fn materialize(&self, file: &FileEntry, symbol: &StoredSymbol) -> WorkspaceSymbol {
        WorkspaceSymbol {
            kind: kind_name(symbol.kind).to_owned(),
            name: self.names[symbol.name_id as usize].clone(),
            path: file.path.clone(),
            line: symbol.line as usize,
            column: symbol.column as usize,
            end_line: symbol.end_line as usize,
            container: (symbol.container_id != NO_CONTAINER)
                .then(|| self.names[symbol.container_id as usize].clone()),
        }
    }

    /// The declarations whose name `keep` selects, in path-then-line order, at most
    /// `limit`: the name table is asked once per distinct name and only the hits are
    /// copied out — a lookup used to materialize the whole index (every name, path and
    /// kind as fresh strings) just to keep a handful.
    fn symbols_named(&self, keep: impl Fn(&str) -> bool, limit: usize) -> Vec<WorkspaceSymbol> {
        let wanted: Vec<bool> = self.names.iter().map(|name| keep(name)).collect();
        let mut hits = Vec::new();
        if limit == 0 || !wanted.contains(&true) {
            return hits;
        }
        for file in &self.files {
            for symbol in &file.symbols {
                if wanted[symbol.name_id as usize] {
                    hits.push(self.materialize(file, symbol));
                    if hits.len() >= limit {
                        return hits;
                    }
                }
            }
        }
        hits
    }

    /// Every declaration of exactly `name` (same spelling, any case — the extractor records
    /// declarations as written, and Go-to-Definition wants all of them).
    pub fn lookup(&self, name: &str) -> Vec<WorkspaceSymbol> {
        self.symbols_named(|candidate| candidate == name, usize::MAX)
    }

    /// The declarations whose name contains `needle_lower` (already lowercased; empty
    /// matches every name), at most `limit` — the workspace symbol search.
    pub fn matching(&self, needle_lower: &str, limit: usize) -> Vec<WorkspaceSymbol> {
        if needle_lower.is_empty() {
            return self.symbols_named(|_| true, limit);
        }
        self.symbols_named(|name| name.to_lowercase().contains(needle_lower), limit)
    }

    /// How many files contain each trusted name: the Symbol Database page's "n refs"
    /// chips read it (an untrusted name reports nothing, the same way its references
    /// fall back to a full scan).
    pub fn occurrence_counts(&self) -> std::collections::HashMap<&str, usize> {
        let mut counts = std::collections::HashMap::with_capacity(self.names.len());
        for (id, files) in self.refs.iter().enumerate() {
            if let Some(files) = files {
                counts.insert(self.names[id].as_str(), files.len());
            }
        }
        counts
    }

    /// The `n` names the most files contain (the occurrence list lengths), most first —
    /// the MCP server's overview ranks the workspace's hub names with it. Untrusted
    /// lists report nothing, the same honesty `occurrence_counts` keeps; only the
    /// winners' names are cloned.
    pub fn top_names_by_refs(&self, n: usize) -> Vec<(String, usize)> {
        let mut rows: Vec<(usize, usize)> = self
            .refs
            .iter()
            .enumerate()
            .filter_map(|(id, files)| files.as_ref().map(|files| (id, files.len())))
            .collect();
        rows.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then_with(|| self.names[a.0].cmp(&self.names[b.0]))
        });
        rows.truncate(n);
        rows.into_iter()
            .map(|(id, count)| (self.names[id].clone(), count))
            .collect()
    }

    /// The declarations whose container is `container` — the relation window's `contains`
    /// direction. The container is an interned name, so one binary search finds its id and
    /// one scan copies only the hits, path-then-line sorted (the store's own order), at
    /// most `limit`.
    /// The declarations whose container is `container`, path-then-line order, at most
    /// `limit` — `kinds` narrows them to the given kinds (`Some` is the Member
    /// Types/Classes rings' filter; `None` keeps every member). The container is an
    /// interned name, so the filter runs inside the store and only the hits leave it.
    pub fn members_of(
        &self,
        container: &str,
        limit: usize,
        kinds: Option<&[&str]>,
    ) -> Vec<(String, FileOutlineRow)> {
        let mut hits: Vec<(String, FileOutlineRow)> = Vec::new();
        if limit == 0 {
            return hits;
        }
        let Ok(id) = self.names.binary_search_by(|n| n.as_str().cmp(container)) else {
            return hits;
        };
        for file in &self.files {
            for symbol in &file.symbols {
                if symbol.container_id != id as u32 {
                    continue;
                }
                let kind = kind_name(symbol.kind);
                if kinds.is_some_and(|kinds| !kinds.contains(&kind)) {
                    continue;
                }
                hits.push((
                    file.path.clone(),
                    FileOutlineRow {
                        kind,
                        name: self.names[symbol.name_id as usize].clone(),
                        container: (symbol.container_id != NO_CONTAINER)
                            .then(|| self.names[symbol.container_id as usize].clone()),
                        line: symbol.line as usize,
                        end_line: symbol.end_line as usize,
                        refs: self
                            .refs
                            .get(symbol.name_id as usize)
                            .and_then(|files| files.as_ref())
                            .map_or(0, |files| files.len()),
                    },
                ));
                if hits.len() >= limit {
                    return hits;
                }
            }
        }
        hits
    }

    /// Which of `names` are themselves containers **of members the `kinds` filter keeps**
    /// — the contains rings' `has_children` peek: one scan answers the whole ring instead
    /// of one members query per member.
    pub fn container_names_among(
        &self,
        names: &[&str],
        kinds: Option<&[&str]>,
    ) -> HashSet<String> {
        let wanted: HashSet<&str> = names.iter().copied().collect();
        let mut found = HashSet::new();
        if wanted.is_empty() {
            return found;
        }
        for file in &self.files {
            for symbol in &file.symbols {
                if symbol.container_id == NO_CONTAINER {
                    continue;
                }
                if kinds.is_some_and(|kinds| !kinds.contains(&kind_name(symbol.kind))) {
                    continue;
                }
                let name = &self.names[symbol.container_id as usize];
                if wanted.contains(name.as_str()) {
                    found.insert(name.clone());
                }
            }
        }
        found
    }

    /// The base types the name's class-like declarations carry, source order, deduplicated
    /// across every declaration of the name — the relation window's Base Classes ring. A
    /// name nothing derives (or nothing declares) answers empty.
    pub fn bases_of(&self, name: &str) -> Vec<String> {
        let Ok(id) = self.names.binary_search_by(|n| n.as_str().cmp(name)) else {
            return Vec::new();
        };
        let mut out: Vec<String> = Vec::new();
        for file in &self.files {
            for record in &file.bases {
                let Some(symbol) = file.symbols.get(record.symbol as usize) else {
                    continue;
                };
                if symbol.name_id != id as u32 {
                    continue;
                }
                for &base in &record.bases {
                    let name = &self.names[base as usize];
                    if !out.contains(name) {
                        out.push(name.clone());
                    }
                }
            }
        }
        out
    }

    /// The declarations that name `base` among their bases, path-then-line order, at most
    /// `limit` — the relation window's Derived Classes ring (the scan walks the same side
    /// table `bases_of` reads, never the texts).
    pub fn derived_of(&self, base: &str, limit: usize) -> Vec<(String, FileOutlineRow)> {
        let mut hits: Vec<(String, FileOutlineRow)> = Vec::new();
        if limit == 0 {
            return hits;
        }
        let Ok(id) = self.names.binary_search_by(|n| n.as_str().cmp(base)) else {
            return hits;
        };
        for file in &self.files {
            for record in &file.bases {
                if !record.bases.contains(&(id as u32)) {
                    continue;
                }
                let Some(symbol) = file.symbols.get(record.symbol as usize) else {
                    continue;
                };
                hits.push((
                    file.path.clone(),
                    FileOutlineRow {
                        kind: kind_name(symbol.kind),
                        name: self.names[symbol.name_id as usize].clone(),
                        container: (symbol.container_id != NO_CONTAINER)
                            .then(|| self.names[symbol.container_id as usize].clone()),
                        line: symbol.line as usize,
                        end_line: symbol.end_line as usize,
                        refs: self
                            .refs
                            .get(symbol.name_id as usize)
                            .and_then(|files| files.as_ref())
                            .map_or(0, |files| files.len()),
                    },
                ));
                if hits.len() >= limit {
                    return hits;
                }
            }
        }
        hits
    }

    /// The files whose text contains `name` as a word, or `None` when the occurrence list is
    /// absent or untrusted — the caller then scans everything, exactly like before.
    pub fn files_containing(&self, name: &str) -> Option<Vec<String>> {
        let id = self.names.binary_search_by(|n| n.as_str().cmp(name)).ok()?; // names stay sorted
        let files = self.refs.get(id)?.as_ref()?;
        Some(
            files
                .iter()
                .map(|&file| self.files[file as usize].path.clone())
                .collect(),
        )
    }

    /// How many files contain `name` — the trusted occurrence list's length, read in
    /// place: the metrics report asks this per function name, and a query that
    /// materializes every file list (as `occurrence_counts` does for the whole table)
    /// would put a large workspace's answer table in memory just to keep one number.
    /// `None` when the name is unknown or its list is untrusted — the same honesty
    /// that sends those references to a full scan.
    pub fn ref_count(&self, name: &str) -> Option<usize> {
        let id = self.names.binary_search_by(|n| n.as_str().cmp(name)).ok()?; // names stay sorted
        self.refs.get(id)?.as_ref().map(|files| files.len())
    }

    /* ---------- Aggregates (the MCP server's progressive disclosure) ---------- */

    /// Every indexed file with its declaration count, path-sorted — one pass, no symbol
    /// clones. The MCP server's directory rollups, hub-file ranking and language mix
    /// read it; an AI's first look at a large workspace must not pay for every name.
    pub fn files_with_counts(&self) -> Vec<(String, usize)> {
        self.files
            .iter()
            .map(|file| (file.path.clone(), file.symbols.len()))
            .collect()
    }

    /// How many declarations each kind carries, most first — the overview's kind mix.
    pub fn kind_counts(&self) -> Vec<(&'static str, usize)> {
        let mut counts = vec![0usize; KINDS.len()];
        for file in &self.files {
            for symbol in &file.symbols {
                if let Some(count) = counts.get_mut(symbol.kind as usize) {
                    *count += 1;
                }
            }
        }
        let mut rows: Vec<(&'static str, usize)> = KINDS
            .iter()
            .zip(counts)
            .filter(|(_, count)| *count > 0)
            .map(|(kind, count)| (*kind, count))
            .collect();
        rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.cmp(b)));
        rows
    }

    /// One file's declarations in line order with their occurrence counts, or `None`
    /// when no indexed file sits at `path` (the files stay path-sorted, so this is a
    /// binary search, not a scan).
    pub fn file_symbols(&self, path: &str) -> Option<Vec<FileOutlineRow>> {
        let file = self
            .files
            .binary_search_by(|file| file.path.as_str().cmp(path))
            .ok()
            .map(|at| &self.files[at])?;
        let refs_of = |name_id: u32| {
            self.refs
                .get(name_id as usize)
                .and_then(|files| files.as_ref())
                .map_or(0, |files| files.len())
        };
        Some(
            file.symbols
                .iter()
                .map(|symbol| FileOutlineRow {
                    kind: kind_name(symbol.kind),
                    name: self.names[symbol.name_id as usize].clone(),
                    container: (symbol.container_id != NO_CONTAINER)
                        .then(|| self.names[symbol.container_id as usize].clone()),
                    line: symbol.line as usize,
                    end_line: symbol.end_line as usize,
                    refs: refs_of(symbol.name_id),
                })
                .collect(),
        )
    }

    /* ---------- Building ---------- */

    /// The full build: extract every source file, intern the names, then one more pass to
    /// record which files contain which declared words. `report` receives (done, total) per
    /// batch; `cancelled` is honoured between batches. `threads` sizes a private rayon pool
    /// for the build (RustDesk's `codec_thread_num` lesson: a background build must not
    /// take every core from the interactive app), so the rest of the process's parallel
    /// work keeps its headroom.
    pub fn build(
        root: &str,
        threads: usize,
        report: &(dyn Fn(usize, usize) + Sync),
        cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Option<SymbolStore> {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads.max(1))
            .build()
            .ok()?;
        pool.install(|| Self::build_on(root, report, cancelled))
    }

    fn build_on(
        root: &str,
        report: &(dyn Fn(usize, usize) + Sync),
        cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Option<SymbolStore> {
        let paths: Vec<String> = walk_files(root)
            .into_iter()
            .filter(|p| is_symbol_source(p))
            .collect();
        let total = paths.len();
        // Phase 1: declarations and fingerprints, one rayon task per file, batched so the
        // loop between batches can report and stop.
        let mut extracted: Vec<Extraction> = Vec::with_capacity(total);
        for batch in paths.chunks(BUILD_BATCH) {
            if cancelled() {
                return None;
            }
            let mut part: Vec<Extraction> = batch
                .par_iter()
                .map(|relative| extract_file(root, relative))
                .flatten()
                .collect();
            extracted.append(&mut part);
            report(extracted.len(), total);
        }
        extracted.sort_by(|a, b| a.path.cmp(&b.path));

        // Phase 2: the name table (declaration names and container names alike), interned
        // in sorted order so ids are binary-searchable.
        let mut interned: BTreeMap<String, u32> = BTreeMap::new();
        for file in &extracted {
            for symbol in &file.symbols {
                interned.entry(symbol.name.clone()).or_insert_with(|| 0);
                if let Some(container) = &symbol.container {
                    interned.entry(container.clone()).or_insert_with(|| 0);
                }
                for base in &symbol.bases {
                    interned.entry(base.clone()).or_insert_with(|| 0);
                }
            }
        }
        let names: Vec<String> = interned.keys().cloned().collect();
        for (id, name) in names.iter().enumerate() {
            interned.insert(name.clone(), id as u32);
        }
        let lookup: HashMap<&str, u32> = interned
            .iter()
            .map(|(name, &id)| (name.as_str(), id))
            .collect();

        // Phase 3: occurrences. Every file is scanned once for the declared words it
        // contains; the per-file results transpose into the per-name lists below.
        let mut scanned: Vec<Scanned> = Vec::with_capacity(extracted.len());
        for batch in extracted.chunks(BUILD_BATCH) {
            if cancelled() {
                return None;
            }
            let mut part: Vec<Scanned> = batch
                .par_iter()
                .map(|file| {
                    let (words, hits) = match fs::read_to_string(Path::new(root).join(&file.path))
                    {
                        Ok(text) => (
                            words_in(&text, &|word| lookup.get(word).copied()),
                            positioned_hits(&text, &|word| lookup.get(word).copied()),
                        ),
                        Err(_) => (Vec::new(), Vec::new()),
                    };
                    let symbols = file
                        .symbols
                        .iter()
                        .map(|symbol| StoredSymbol {
                            kind: symbol.kind,
                            name_id: lookup[symbol.name.as_str()],
                            container_id: symbol
                                .container
                                .as_deref()
                                .and_then(|name| lookup.get(name).copied())
                                .unwrap_or(NO_CONTAINER),
                            line: symbol.line,
                            column: symbol.column,
                            end_line: symbol.end_line,
                        })
                        .collect();
                    let bases = file
                        .symbols
                        .iter()
                        .enumerate()
                        .filter(|(_, symbol)| !symbol.bases.is_empty())
                        .map(|(at, symbol)| StoredBases {
                            symbol: at as u32,
                            bases: symbol
                                .bases
                                .iter()
                                .map(|base| lookup[base.as_str()])
                                .collect(),
                        })
                        .collect();
                    (file.path.clone(), words, symbols, bases, hits)
                })
                .collect();
            scanned.append(&mut part);
        }

        let mut store = SymbolStore {
            root: root.to_owned(),
            files: scanned
                .iter()
                .map(|(path, _, _, _, _)| path.clone())
                .zip(extracted.iter().map(|f| (f.mtime_ms, f.size)))
                .map(|(path, (mtime_ms, size))| FileEntry {
                    path,
                    mtime_ms,
                    size,
                    symbols: Vec::new(),
                    words: Vec::new(),
                    bases: Vec::new(),
                })
                .collect(),
            names,
            refs: Vec::new(),
            si: None,
        };
        // The walk is sorted and phase 1 sorted again; the zip above keeps that order.
        debug_assert!(store.files.windows(2).all(|w| w[0].path < w[1].path));
        for (i, (_, words, symbols, bases, _)) in scanned.iter().enumerate() {
            store.files[i].words = words.clone();
            store.files[i].symbols = symbols.clone();
            store.files[i].bases = bases.clone();
        }
        store.rebuild_refs();
        // The reference database's tables, from the parse's calls and the masked
        // positioned hits — collected only here, on a full build.
        let calls_per_file: Vec<Vec<(String, u32)>> = extracted
            .iter()
            .map(|file| file.calls.clone())
            .collect();
        let hits_per_file: Vec<Vec<(u32, u32)>> = scanned
            .into_iter()
            .map(|(_, _, _, _, hits)| hits)
            .collect();
        store.si = Some(build_si_tables(&store, &calls_per_file, &hits_per_file));
        Some(store)
    }

    /* ---------- Incremental updates ---------- */

    /// Apply watcher changes (repo-relative paths): gone files are dropped, changed files
    /// re-extracted (a matching fingerprint skips the work), new files added. Names first
    /// seen here stay untrusted; every trusted name's occurrence list stays complete because
    /// each touched file's contributions are subtracted and rescanned. Answers whether the
    /// store changed at all — a batch naming nothing the store holds must not pay a save
    /// (the write is bytes on disk and a watcher event, never free).
    pub fn apply_changes(&mut self, paths: &[String]) -> bool {
        let wanted: HashSet<&str> = paths
            .iter()
            .map(String::as_str)
            .filter(|p| is_symbol_source(p))
            .collect();
        // Subtract and drop the entries whose file is gone or changed; the paths that still
        // exist are collected once, whether they were known before or arrived with the batch.
        // The store's fields are borrowed apart so the scan of `files` can subtract into
        // `refs` while it walks.
        let root = self.root.clone();
        let SymbolStore { files, refs, .. } = self;
        let mut keep: Vec<bool> = Vec::with_capacity(files.len());
        let mut to_extract: HashSet<String> = HashSet::new();
        let mut changed = false;
        for file in files.iter() {
            let touched = wanted.contains(file.path.as_str());
            let stat = stat_of(&Path::new(&root).join(&file.path));
            let unchanged = !touched
                && stat
                    .as_ref()
                    .is_some_and(|s| s.mtime_ms == file.mtime_ms && s.size == file.size);
            if unchanged {
                keep.push(true);
                continue;
            }
            changed = true;
            Self::subtract_contributions(refs, files, file);
            if stat.is_some() {
                to_extract.insert(file.path.clone());
            }
            keep.push(false);
        }
        let mut kept: Vec<FileEntry> = Vec::with_capacity(files.len());
        // The compacted id of every old id — u32::MAX for the dropped rows. The occurrence
        // lists still name pre-compaction ids, and renumber_after_edits remaps by current
        // position, so a kept file whose old id outlives the shrunken table would index out
        // of bounds there. Rewrite the ids here; a dropped id subtraction somehow left
        // behind is a reference to a file that no longer exists and goes with it.
        let mut compact: Vec<u32> = Vec::with_capacity(files.len());
        for (file, keep_file) in files.drain(..).zip(keep) {
            if keep_file {
                compact.push(kept.len() as u32);
                kept.push(file);
            } else {
                compact.push(u32::MAX);
            }
        }
        *files = kept;
        for list in refs.iter_mut().flatten() {
            for id in list.iter_mut() {
                *id = compact.get(*id as usize).copied().unwrap_or(u32::MAX);
            }
            list.retain(|&id| id != u32::MAX);
        }
        // Watched paths the store never knew (a brand-new file) join the re-extraction.
        for path in wanted {
            if !to_extract.contains(path) && Path::new(&root).join(path).exists() {
                to_extract.insert(path.to_owned());
            }
        }
        let mut upserts: Vec<Extraction> = to_extract
            .iter()
            .filter_map(|path| extract_file(&root, path))
            .collect();
        upserts.sort_by(|a, b| a.path.cmp(&b.path));
        if !upserts.is_empty() {
            changed = true;
        }
        self.upsert(upserts);
        self.renumber_after_edits();
        changed
    }

    /// Remove `file`'s occurrence contributions from the name lists. An associated function
    /// with explicit field borrows: the caller scans `files` while subtracting into `refs`.
    fn subtract_contributions(
        refs: &mut [Option<Vec<u32>>],
        files: &[FileEntry],
        file: &FileEntry,
    ) {
        for &name in &file.words {
            if let Some(Some(list)) = refs.get_mut(name as usize) {
                list.retain(|&f| files[f as usize].path != file.path);
            }
        }
    }

    /// Bring a store loaded from disk back in line with the tree: files that appeared,
    /// changed or vanished since it was written are applied incrementally. Returns how many
    /// files needed work (0 means the store was already current).
    pub fn refresh_against_disk(
        &mut self,
        report: &(dyn Fn(usize, usize) + Sync),
        cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Result<usize, String> {
        let current: Vec<String> = walk_files(&self.root)
            .into_iter()
            .filter(|p| is_symbol_source(p))
            .collect();
        let known: HashSet<&str> = self.files.iter().map(|f| f.path.as_str()).collect();
        let mut touched: Vec<String> = current
            .iter()
            .filter(|p| !known.contains(p.as_str()))
            .cloned()
            .collect();
        let total = current.len();
        let mut done = 0;
        for file in &self.files {
            if cancelled() {
                return Err("cancelled".to_owned());
            }
            let stat = stat_of(&Path::new(&self.root).join(&file.path));
            let gone_or_changed = stat
                .as_ref()
                .is_none_or(|s| s.mtime_ms != file.mtime_ms || s.size != file.size);
            if gone_or_changed {
                touched.push(file.path.clone());
            }
            done += 1;
            if done % BUILD_BATCH == 0 {
                report(done.min(total), total);
            }
        }
        if touched.is_empty() {
            return Ok(0);
        }
        self.apply_changes(&touched);
        Ok(touched.len())
    }

    /// Insert freshly extracted files (sorted by path): intern new names as untrusted, append
    /// entries, add their occurrence contributions. File ids are repaired by the caller.
    fn upsert(&mut self, upserts: Vec<Extraction>) {
        if upserts.is_empty() {
            return;
        }
        // Intern the names not yet known (the sorted invariant makes the check a search).
        let mut fresh: BTreeSet<String> = BTreeSet::new();
        for file in &upserts {
            for symbol in &file.symbols {
                for name in std::iter::once(&symbol.name)
                    .chain(symbol.container.iter())
                    .chain(symbol.bases.iter())
                {
                    if self
                        .names
                        .binary_search_by(|n| n.as_str().cmp(name.as_str()))
                        .is_err()
                    {
                        fresh.insert(name.clone());
                    }
                }
            }
        }
        for name in &fresh {
            self.names.push(name.clone());
            self.refs.push(None); // untrusted until a full build
        }
        // The id map is built once the table is complete; sort_names fixes the order after.
        let mut lookup: HashMap<String, u32> = self
            .names
            .iter()
            .enumerate()
            .map(|(id, name)| (name.clone(), id as u32))
            .collect();
        lookup.shrink_to_fit();
        for file in upserts {
            // The words rode the extraction (one read in extract_file covered both the
            // parse and this list); an unknown word — never a declared name — drops.
            let words = file
                .words
                .iter()
                .filter_map(|word| lookup.get(word.as_str()).copied())
                .collect::<Vec<u32>>();
            let symbols = file
                .symbols
                .iter()
                .map(|symbol| StoredSymbol {
                    kind: symbol.kind,
                    name_id: lookup[symbol.name.as_str()],
                    container_id: symbol
                        .container
                        .as_deref()
                        .and_then(|name| lookup.get(name).copied())
                        .unwrap_or(NO_CONTAINER),
                    line: symbol.line,
                    column: symbol.column,
                    end_line: symbol.end_line,
                })
                .collect();
            let bases = file
                .symbols
                .iter()
                .enumerate()
                .filter(|(_, symbol)| !symbol.bases.is_empty())
                .map(|(at, symbol)| StoredBases {
                    symbol: at as u32,
                    bases: symbol
                        .bases
                        .iter()
                        .map(|base| lookup[base.as_str()])
                        .collect(),
                })
                .collect();
            let entry = FileEntry {
                path: file.path,
                mtime_ms: file.mtime_ms,
                size: file.size,
                symbols,
                words: words.clone(),
                bases,
            };
            // The entry's pre-renumber id is final here — renumber_after_edits remaps it.
            let entry_id = self.files.len() as u32;
            self.files.push(entry);
            for word in words {
                if let Some(Some(files)) = self.refs.get_mut(word as usize) {
                    files.push(entry_id);
                }
            }
        }
        self.sort_names();
    }

    /// Restore the sorted-name invariant after interning (files_containing binary-searches
    /// the table). The id remap touches every reference to a name id in one pass.
    fn sort_names(&mut self) {
        let mut order: Vec<u32> = (0..self.names.len() as u32).collect();
        order.sort_by_key(|&i| self.names[i as usize].clone());
        let mut new_ids = vec![0u32; self.names.len()];
        self.names = order
            .iter()
            .enumerate()
            .map(|(new_id, &old_id)| {
                new_ids[old_id as usize] = new_id as u32;
                std::mem::take(&mut self.names[old_id as usize])
            })
            .collect();
        let mut refs = vec![None; self.names.len()];
        for (old_id, owned) in std::mem::take(&mut self.refs).into_iter().enumerate() {
            refs[new_ids[old_id] as usize] = owned;
        }
        self.refs = refs;
        for file in &mut self.files {
            for symbol in &mut file.symbols {
                symbol.name_id = new_ids[symbol.name_id as usize];
                if symbol.container_id != NO_CONTAINER {
                    symbol.container_id = new_ids[symbol.container_id as usize];
                }
            }
            for record in &mut file.bases {
                for base in &mut record.bases {
                    *base = new_ids[*base as usize];
                }
            }
            for word in &mut file.words {
                *word = new_ids[*word as usize];
            }
            file.words.sort_unstable();
            file.words.dedup();
        }
    }

    /// Restore the store's invariants after structural edits: files sorted by path, the
    /// occurrence lists remapped to the new ids.
    fn renumber_after_edits(&mut self) {
        let mut order: Vec<u32> = (0..self.files.len() as u32).collect();
        order.sort_by_key(|&i| self.files[i as usize].path.clone());
        let mut new_ids = vec![0u32; self.files.len()];
        self.files = order
            .into_iter()
            .enumerate()
            .map(|(new_id, old_id)| {
                new_ids[old_id as usize] = new_id as u32;
                std::mem::replace(
                    &mut self.files[old_id as usize],
                    FileEntry::empty_placeholder(),
                )
            })
            .collect();
        for name in 0..self.refs.len() {
            if let Some(files) = &mut self.refs[name] {
                for file in files.iter_mut() {
                    *file = new_ids[*file as usize];
                }
                files.sort_unstable();
                files.dedup();
            }
        }
    }

    /// Recompute every occurrence list from the files' `words` (after a full build).
    fn rebuild_refs(&mut self) {
        self.refs = vec![Some(Vec::new()); self.names.len()];
        for (file_id, file) in self.files.iter().enumerate() {
            for &name in &file.words {
                if let Some(Some(files)) = self.refs.get_mut(name as usize) {
                    files.push(file_id as u32);
                }
            }
        }
    }

    /* ---------- Persistence ---------- */

    /// Where this root's index lives: inside the analyzed folder itself — the hidden
    /// `.ggs/analysis/<hash>/` database (2026-11-21, the owner's direction) — when the
    /// folder accepts the write, the GGS home (`~/.ggs/index/<hash>/`, the layout before
    /// that date) otherwise. Preparing the project folder marks it hidden (the `.git`
    /// treatment) and gains it a `.git/info/exclude` line, so `git status` never lists it.
    pub fn index_dir(root: &str, home: &Path) -> PathBuf {
        Self::prepared_store_dir(root).unwrap_or_else(|| home.join("index").join(store_hash(root)))
    }

    /// The store's project-local directory `<root>/.ggs/analysis/<hash>/`, created —
    /// `None` when the folder refuses the write (a read-only share, or `root` is not a
    /// directory at all).
    fn prepared_store_dir(root: &str) -> Option<PathBuf> {
        let analysis = Path::new(root).join(PROJECT_ANALYSIS_DIR);
        let dir = analysis.join("analysis").join(store_hash(root));
        fs::create_dir_all(&dir).ok()?;
        mark_hidden(&analysis);
        ensure_git_ignored(Path::new(root));
        Some(dir)
    }

    /// Every place the root's store may sit, project-local first: the load reads the
    /// first copy present — the project folder, else the GGS home copy an older build
    /// saved (the next save migrates it into the project). The rebuild's wipe removes
    /// every entry.
    fn store_dirs(root: &str, home: &Path) -> [PathBuf; 2] {
        [
            Path::new(root)
                .join(PROJECT_ANALYSIS_DIR)
                .join("analysis")
                .join(store_hash(root)),
            home.join("index").join(store_hash(root)),
        ]
    }

    /// Delete the root's saved store from every location it may live in — the rebuild's
    /// clean start. Nothing user-authored ever lives in the analysis folder, so a wipe
    /// never loses work; the next build regenerates the files whole.
    pub fn remove_store_dirs(root: &str, home: &Path) {
        for dir in Self::store_dirs(root, home) {
            let _ = fs::remove_dir_all(dir);
        }
    }

    /// Persist the root's index. Two app instances can have the same root open (the app is
    /// multi-instance), so the write goes through `crate::atomic_write` — each instance
    /// writes its own temp sibling and one rename lands the whole file, never a shared
    /// `symbols.bin.new` two saves would interleave through.
    pub fn save(&self, home: &Path) -> Result<(), String> {
        let dir = Self::index_dir(&self.root, home);
        let mut out = Vec::new();
        out.extend_from_slice(MAGIC);
        out.push(VERSION);
        push_str(&mut out, &self.root);
        push_u32(&mut out, self.files.len() as u32);
        push_u32(&mut out, self.names.len() as u32);
        for name in &self.names {
            push_str(&mut out, name);
        }
        for file in &self.files {
            push_str(&mut out, &file.path);
            push_u64(&mut out, file.mtime_ms);
            push_u64(&mut out, file.size);
            push_u32(&mut out, file.symbols.len() as u32);
            for symbol in &file.symbols {
                out.push(symbol.kind);
                out.extend_from_slice(&symbol.name_id.to_le_bytes());
                out.extend_from_slice(&symbol.container_id.to_le_bytes());
                out.extend_from_slice(&symbol.line.to_le_bytes());
                out.extend_from_slice(&symbol.column.to_le_bytes());
                out.extend_from_slice(&symbol.end_line.to_le_bytes());
            }
            push_u32(&mut out, file.bases.len() as u32);
            for record in &file.bases {
                out.extend_from_slice(&record.symbol.to_le_bytes());
                push_u32(&mut out, record.bases.len() as u32);
                for &base in &record.bases {
                    out.extend_from_slice(&base.to_le_bytes());
                }
            }
        }
        for refs in &self.refs {
            match refs {
                None => out.push(0),
                Some(files) => {
                    out.push(1);
                    push_u32(&mut out, files.len() as u32);
                    for &file in files {
                        out.extend_from_slice(&file.to_le_bytes());
                    }
                }
            }
        }
        ggs_base::fsx::atomic_write(&dir.join("symbols.bin"), &out)?;
        // The reference database rides beside the store in the same folder: a full build
        // collected its tables, so the delete-and-regenerate promise covers them too.
        // No tables (a resumed store) leaves the saved files standing untouched.
        if let Some(si) = &self.si {
            ggs_base::fsx::atomic_write(&dir.join(anadb::DB_FILE), &anadb::write_db(si))?;
            ggs_base::fsx::atomic_write(&dir.join(anadb::TIX_FILE), &anadb::write_tix(si))?;
        }
        Ok(())
    }

    /// Read the root's index back. `None` for anything absent or not exactly this format's
    /// shape — a corrupt file means "rebuild", never an error to surface.
    pub fn load(root: &str, home: &Path) -> Option<SymbolStore> {
        let bytes = Self::store_dirs(root, home)
            .iter()
            .find_map(|dir| fs::read(dir.join("symbols.bin")).ok())?;
        let mut at = 0usize;
        take(&bytes, &mut at, MAGIC.len())?
            .iter()
            .eq(MAGIC.iter())
            .then_some(())?;
        (take(&bytes, &mut at, 1)?[0] == VERSION).then_some(())?;
        let root = take_str(&bytes, &mut at)?;
        let file_count = take_u32(&bytes, &mut at)? as usize;
        let name_count = take_u32(&bytes, &mut at)? as usize;
        let mut names = Vec::with_capacity(name_count);
        for _ in 0..name_count {
            names.push(take_str(&bytes, &mut at)?);
        }
        let mut files = Vec::with_capacity(file_count);
        for _ in 0..file_count {
            let path = take_str(&bytes, &mut at)?;
            let mtime_ms = take_u64(&bytes, &mut at)?;
            let size = take_u64(&bytes, &mut at)?;
            let symbols = take_u32(&bytes, &mut at)? as usize;
            let mut parsed = Vec::with_capacity(symbols);
            for _ in 0..symbols {
                let kind = take(&bytes, &mut at, 1)?[0];
                let name_id = take_u32(&bytes, &mut at)?;
                let container_id = take_u32(&bytes, &mut at)?;
                let line = take_u32(&bytes, &mut at)?;
                let column = take_u32(&bytes, &mut at)?;
                let end_line = take_u32(&bytes, &mut at)?;
                if name_id as usize >= names.len()
                    || (container_id != NO_CONTAINER && container_id as usize >= names.len())
                {
                    return None;
                }
                parsed.push(StoredSymbol {
                    kind,
                    name_id,
                    container_id,
                    line,
                    column,
                    end_line,
                });
            }
            let mut bases = Vec::new();
            let base_records = take_u32(&bytes, &mut at)? as usize;
            for _ in 0..base_records {
                let symbol = take_u32(&bytes, &mut at)?;
                let count = take_u32(&bytes, &mut at)? as usize;
                let mut ids = Vec::with_capacity(count);
                for _ in 0..count {
                    let base = take_u32(&bytes, &mut at)?;
                    if base as usize >= names.len() {
                        return None;
                    }
                    ids.push(base);
                }
                if symbol as usize >= symbols {
                    return None;
                }
                bases.push(StoredBases { symbol, bases: ids });
            }
            files.push(FileEntry {
                path,
                mtime_ms,
                size,
                symbols: parsed,
                words: Vec::new(),
                bases,
            });
        }
        let mut refs = Vec::with_capacity(name_count);
        for _ in 0..name_count {
            match take(&bytes, &mut at, 1)?[0] {
                0 => refs.push(None),
                1 => {
                    let count = take_u32(&bytes, &mut at)? as usize;
                    let mut list = Vec::with_capacity(count);
                    for _ in 0..count {
                        list.push(take_u32(&bytes, &mut at)?);
                    }
                    refs.push(Some(list));
                }
                _ => return None,
            }
        }
        if at != bytes.len() {
            return None;
        }
        // The words transpose comes back from the occurrence lists. The reference
        // tables stay `None` — the saved `si.db` on disk keeps standing until the next
        // full build rewrites it whole.
        let mut store = SymbolStore {
            root,
            files,
            names,
            refs,
            si: None,
        };
        for (name, files_with) in store.refs.iter().enumerate() {
            for &file in files_with.as_deref().unwrap_or(&[]) {
                if file as usize >= store.files.len() {
                    return None;
                }
                store.files[file as usize].words.push(name as u32);
            }
        }
        Some(store)
    }
}

impl FileEntry {
    /// A moved-out placeholder for in-place reordering (renumber_after_edits).
    fn empty_placeholder() -> FileEntry {
        FileEntry {
            path: String::new(),
            mtime_ms: 0,
            size: 0,
            symbols: Vec::new(),
            words: Vec::new(),
            bases: Vec::new(),
        }
    }
}

/* ---------- Extraction and word scanning ---------- */

/// Read one file and extract its declarations and fingerprint. `None` when the file is gone
/// or not decodable text — the index is best-effort, like the in-memory one before it.
fn extract_file(root: &str, relative: &str) -> Option<Extraction> {
    let path = Path::new(root).join(relative);
    let stat = stat_of(&path)?;
    let text = fs::read_to_string(&path).ok()?;
    let ext = relative.rsplit_once('.')?.1;
    let parsed = crate::symbols::parse::parse_file(&text, ext);
    let symbols = parsed
        .symbols
        .into_iter()
        .map(|s| Extracted {
            kind: kind_id(s.kind),
            name: s.name,
            container: s.container,
            line: s.line as u32,
            column: s.column as u32,
            end_line: s.end_line as u32,
            bases: s.bases,
        })
        .collect();
    let calls = parsed
        .calls
        .into_iter()
        .map(|call| (call.name, call.line as u32))
        .collect();
    let words = unique_words(&text);
    Some(Extraction {
        path: relative.to_owned(),
        mtime_ms: stat.mtime_ms,
        size: stat.size,
        symbols,
        words,
        calls,
    })
}

/// The file's unique identifier words, deduplicated — the raw material the interned
/// occurrence list maps from.
fn unique_words(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut words = Vec::new();
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let mut start = None;
    for (at, c) in text.char_indices() {
        if is_word(c) {
            if start.is_none() {
                start = Some(at);
            }
        } else if let Some(from) = start.take() {
            let word = &text[from..at];
            if seen.insert(word) {
                words.push(word.to_owned());
            }
        }
    }
    if let Some(from) = start {
        let word = &text[from..];
        if seen.insert(word) {
            words.push(word.to_owned());
        }
    }
    words
}

/// Which of the interned names occur as words in `text`, as a sorted, deduplicated id list.
/// The scan is a plain character walk — no allocation per word, only per hit.
/// The positioned, code-only word hits one file carries: `(name id, 0-based line)`, every
/// whole word whose name the index knows, hits inside comments and strings filtered out
/// by the mask. The reference database's reference rows read from this — the store's own
/// occurrence lists stay the unfiltered unique words `words_in` gathers.
fn positioned_hits(text: &str, id_of: &impl Fn(&str) -> Option<u32>) -> Vec<(u32, u32)> {
    let code_mask = crate::symbols::mask::mask(text);
    let mut hits: Vec<(u32, u32)> = Vec::new();
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let mut start: Option<usize> = None;
    // The line bookkeeping as it stood when the word started — a flush that happens on
    // the newline closing the word's line must still read the word's own line.
    let mut word_line = 0usize;
    let mut word_line_start = 0usize;
    // The character before the word, ignoring whitespace — a `.` or `>` marks member
    // access (`self.x`, `ptr->x`), which the reference engine never records as a plain
    // reference.
    let mut last_significant: Option<char> = None;
    let mut line = 0usize;
    let mut line_start_byte = 0usize;
    for (at, c) in text.char_indices() {
        if is_word(c) {
            if start.is_none() {
                start = Some(at);
                word_line = line;
                word_line_start = line_start_byte;
            }
        } else {
            if let Some(from) = start.take() {
                push_positioned_hit(
                    &mut hits,
                    text,
                    &code_mask,
                    id_of,
                    from,
                    at,
                    word_line,
                    word_line_start,
                    last_significant,
                );
            }
            if c == '\n' {
                line += 1;
                line_start_byte = at + 1;
            }
            if !c.is_whitespace() {
                last_significant = Some(c);
            }
        }
    }
    if let Some(from) = start {
        push_positioned_hit(
            &mut hits,
            text,
            &code_mask,
            id_of,
            from,
            text.len(),
            line,
            line_start_byte,
            last_significant,
        );
    }
    hits
}

#[allow(clippy::too_many_arguments)]
fn push_positioned_hit(
    hits: &mut Vec<(u32, u32)>,
    text: &str,
    code_mask: &crate::symbols::mask::CodeMask,
    id_of: &impl Fn(&str) -> Option<u32>,
    from: usize,
    to: usize,
    line: usize,
    line_start_byte: usize,
    last_significant: Option<char>,
) {
    let word = &text[from..to];
    let Some(id) = id_of(word) else {
        return;
    };
    if matches!(last_significant, Some('.') | Some('>')) {
        return;
    }
    let col = text[line_start_byte..from].chars().count();
    if code_mask.is_masked(line, col) {
        return;
    }
    hits.push((id, line as u32));
}

/// The innermost declaration covering `line` (0-based) — the latest-starting span wins,
/// the same innermost rule the relation scans attribute references by.
fn enclosing_symbol(symbols: &[StoredSymbol], line: u32) -> Option<&StoredSymbol> {
    symbols
        .iter()
        .filter(|symbol| symbol.line <= line && line <= symbol.end_line)
        .max_by_key(|symbol| symbol.line)
}

/// The reference database's SymType for one of the store's kinds.
fn si_type_of(kind: u8) -> i32 {
    match kind_name(kind) {
        "function" => anadb::SYM_FUNCTION,
        "method" => anadb::SYM_PROTOTYPE,
        "class" => anadb::SYM_CLASS,
        "struct" => anadb::SYM_STRUCT,
        "interface" => anadb::SYM_INTERFACE,
        "enum" => anadb::SYM_ENUM,
        "module" => anadb::SYM_NAMESPACE,
        "type" => anadb::SYM_TYPEDEF,
        "macro" => anadb::SYM_MACRO,
        "variable" => anadb::SYM_VARIABLE,
        _ => anadb::SYM_UNKNOWN,
    }
}

/// The kinds the reference database's type-definition table records — its `db_add_tdr`
/// covers class / struct / union / enum / typedef / interface / namespace declarations.
fn is_si_tdr_kind(kind: u8) -> bool {
    matches!(
        kind_name(kind),
        "class" | "struct" | "interface" | "enum" | "module" | "type"
    )
}

/// Assemble the reference database's six tables from a fully built store plus the
/// per-file call sites and positioned hits. Mirrors si-lite's parse flow: symbols
/// deduplicate by name (first declaration wins, and only a new symbol bumps its
/// module's count); every declaration row lands in the code table with `enc = -1`;
/// a call whose both ends resolve records the (caller, callee) edge — deduplicated on
/// the exact pair, first line wins — plus its code row; a plain code-positioned
/// identifier records its code row alone; member access and self-references never
/// record. The tables are deterministic, so a rebuild regenerates the same bytes.
fn build_si_tables(
    store: &SymbolStore,
    calls_per_file: &[Vec<(String, u32)>],
    hits_per_file: &[Vec<(u32, u32)>],
) -> anadb::AnaTables {
    let mut tables = anadb::AnaTables {
        mods: store
            .files
            .iter()
            .map(|file| anadb::AnaModule {
                name: file.path.clone(),
                sym_count: 0,
            })
            .collect(),
        ..anadb::AnaTables::default()
    };
    let mut si_id_of: HashMap<&str, i32> = HashMap::new();
    let mut tdr_of: HashSet<&str> = HashSet::new();
    let mut syl_seen: HashSet<(i32, Vec<u8>)> = HashSet::new();
    let mut edge_seen: HashSet<(i32, i32)> = HashSet::new();

    // Pass 1 — declarations: symbols, type-def records, syllables, definition code rows.
    for (module, file) in store.files.iter().enumerate() {
        for symbol in &file.symbols {
            let name = store.names[symbol.name_id as usize].as_str();
            let line = symbol.line as i32 + 1;
            let id = match si_id_of.get(name) {
                Some(&id) => id,
                None => {
                    let id = tables.syms.len() as i32;
                    tables.syms.push(anadb::AnaSymbol {
                        id,
                        name: name.to_owned(),
                        type_: si_type_of(symbol.kind),
                        module: module as i32,
                        line,
                    });
                    tables.mods[module].sym_count += 1;
                    si_id_of.insert(name, id);
                    for frag in anadb::split_syllables(name) {
                        if syl_seen.insert((id, frag.clone())) {
                            tables.syls.push(anadb::AnaSyl { frag, sym: id });
                        }
                    }
                    id
                }
            };
            tables.code.push(anadb::AnaCode {
                sym: id,
                module: module as i32,
                line,
                is_def: 1,
                enc: -1,
            });
            if is_si_tdr_kind(symbol.kind) && tdr_of.insert(name) {
                tables.tdrs.push(anadb::AnaTdr {
                    name: name.to_owned(),
                    type_: si_type_of(symbol.kind),
                    module: module as i32,
                    line,
                });
            }
        }
    }

    // Pass 2 — references: the parse's call sites (grammar-clean) and the masked
    // positioned words, both attributed to their innermost enclosing declaration.
    let id_of_name = |name: &str| si_id_of.get(name).copied();
    for (module, file) in store.files.iter().enumerate() {
        let record = |tables: &mut anadb::AnaTables,
                      subject: &str,
                      line: u32,
                      want_edge: bool,
                      edge_seen: &mut HashSet<(i32, i32)>| {
            let Some(enclosing) = enclosing_symbol(&file.symbols, line) else {
                return;
            };
            let enc_name = store.names[enclosing.name_id as usize].as_str();
            let (Some(subject_id), Some(enc_id)) = (id_of_name(subject), id_of_name(enc_name))
            else {
                return;
            };
            if subject_id == enc_id {
                return;
            }
            if want_edge && edge_seen.insert((enc_id, subject_id)) {
                tables.edges.push(anadb::AnaEdge {
                    caller: enc_id,
                    callee: subject_id,
                    line: line as i32 + 1,
                });
            }
            tables.code.push(anadb::AnaCode {
                sym: subject_id,
                module: module as i32,
                line: line as i32 + 1,
                is_def: 0,
                enc: enc_id,
            });
        };
        for (name, line) in calls_per_file
            .get(module)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            record(&mut tables, name, *line, true, &mut edge_seen);
        }
        for (name_id, line) in hits_per_file
            .get(module)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            record(
                &mut tables,
                store.names[*name_id as usize].as_str(),
                *line,
                false,
                &mut edge_seen,
            );
        }
    }
    tables
}

fn words_in(text: &str, id_of: &impl Fn(&str) -> Option<u32>) -> Vec<u32> {
    let mut hits: Vec<u32> = Vec::new();
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let mut start = None;
    for (at, c) in text.char_indices() {
        if is_word(c) {
            if start.is_none() {
                start = Some(at);
            }
        } else if let Some(from) = start.take() {
            if let Some(id) = id_of(&text[from..at]) {
                hits.push(id);
            }
        }
    }
    if let Some(from) = start {
        if let Some(id) = id_of(&text[from..]) {
            hits.push(id);
        }
    }
    hits.sort_unstable();
    hits.dedup();
    hits
}

/* ---------- The little-endian cursor ---------- */

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_str(out: &mut Vec<u8>, text: &str) {
    push_u32(out, text.len() as u32);
    out.extend_from_slice(text.as_bytes());
}

fn take<'a>(bytes: &'a [u8], at: &mut usize, len: usize) -> Option<&'a [u8]> {
    let slice = bytes.get(*at..*at + len)?;
    *at += len;
    Some(slice)
}

fn take_u32(bytes: &[u8], at: &mut usize) -> Option<u32> {
    let slice = take(bytes, at, 4)?;
    Some(u32::from_le_bytes(slice.try_into().ok()?))
}

fn take_u64(bytes: &[u8], at: &mut usize) -> Option<u64> {
    let slice = take(bytes, at, 8)?;
    Some(u64::from_le_bytes(slice.try_into().ok()?))
}

fn take_str(bytes: &[u8], at: &mut usize) -> Option<String> {
    let len = take_u32(bytes, at)? as usize;
    let slice = take(bytes, at, len)?;
    String::from_utf8(slice.to_vec()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, path: &str, text: &str) {
        let file = root.join(path);
        fs::create_dir_all(file.parent().unwrap_or(root)).unwrap();
        fs::write(file, text).unwrap();
    }

    /// A build whose fingerprint-identical files survive a rebuild of the same tree.
    #[test]
    fn build_extracts_names_and_occurrences() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "src/lib.rs",
            "pub fn alpha() {}\nfn beta() { alpha(); }\n",
        );
        write(
            dir.path(),
            "src/other.rs",
            "fn gamma() { beta(); alpha(); }\n",
        );
        write(dir.path(), "skip.txt", "fn ignored()\n");
        let root = dir.path().display().to_string();

        let store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        let stats = store.stats();
        assert_eq!((stats.files, stats.symbols), (2, 3));
        let mut names = store.names.clone();
        names.sort();
        assert_eq!(names, ["alpha", "beta", "gamma"]);

        let alpha = store.lookup("alpha");
        assert_eq!(alpha.len(), 1);
        assert_eq!(
            (
                alpha[0].path.as_str(),
                alpha[0].line,
                alpha[0].kind.as_str()
            ),
            ("src/lib.rs", 0, "function")
        );

        // Occurrences: alpha is used in both files, beta in both, gamma nowhere else.
        assert_eq!(
            store.files_containing("alpha"),
            Some(vec!["src/lib.rs".to_owned(), "src/other.rs".to_owned()])
        );
        assert_eq!(
            store.files_containing("beta"),
            Some(vec!["src/lib.rs".to_owned(), "src/other.rs".to_owned()])
        );
        assert_eq!(
            store.files_containing("gamma"),
            Some(vec!["src/other.rs".to_owned()])
        );
        assert_eq!(store.files_containing("nothing"), None);
    }

    #[test]
    fn build_is_cancellable() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..600 {
            write(dir.path(), &format!("f{i:03}.rs"), "fn x() {}\n");
        }
        let root = dir.path().display().to_string();
        assert!(SymbolStore::build(&root, 4, &|_, _| {}, &|| true).is_none());
    }

    /// The base table: a C++ inheritance chain's bases land in the store, survive the
    /// save/load round trip intact, and answer the two rings' queries — the Base Classes
    /// side by name, the Derived Classes side by the reverse scan.
    #[test]
    fn bases_round_trip_and_answer_both_rings() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "src/shape.cpp", "class Base {};
class Mid : public Base {};
class Leaf : public Mid, Extra {};
");
        let root = dir.path().display().to_string();
        let home = tempfile::tempdir().unwrap();

        let store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        assert_eq!(store.bases_of("Leaf"), vec!["Mid", "Extra"]);
        assert_eq!(store.bases_of("Mid"), vec!["Base"]);
        assert!(store.bases_of("Base").is_empty());
        let derived = store.derived_of("Base", 10);
        assert_eq!(derived.len(), 1);
        assert_eq!((derived[0].0.as_str(), derived[0].1.name.as_str()), ("src/shape.cpp", "Mid"));

        store.save(home.path()).unwrap();
        let loaded = SymbolStore::load(&root, home.path()).expect("the saved index loads back");
        assert_eq!(loaded.bases_of("Leaf"), vec!["Mid", "Extra"]);
        assert_eq!(loaded.bases_of("Mid"), vec!["Base"]);
        let names = |rows: Vec<(String, FileOutlineRow)>| -> Vec<(String, String)> {
            rows.into_iter()
                .map(|(path, row)| (path, row.name))
                .collect()
        };
        assert_eq!(
            names(loaded.derived_of("Base", 10)),
            names(store.derived_of("Base", 10))
        );

        // A version-5 file has no base table — a clean rebuild, never a partial answer.
        let index_file = SymbolStore::index_dir(&root, home.path()).join("symbols.bin");
        let mut bytes = fs::read(&index_file).unwrap();
        bytes[6] = 5; // the version byte, past the magic
        fs::write(&index_file, &bytes).unwrap();
        assert!(SymbolStore::load(&root, home.path()).is_none());
    }

    #[test]
    fn save_and_load_round_trip_and_corruption_is_a_rebuild() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.rs", "fn alpha() {}\n");
        let root = dir.path().display().to_string();
        let home = tempfile::tempdir().unwrap();

        let store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        store.save(home.path()).unwrap();
        let loaded = SymbolStore::load(&root, home.path()).expect("the saved index loads back");
        assert_eq!(loaded.all_symbols(), store.all_symbols());
        assert_eq!(
            loaded.files_containing("alpha"),
            store.files_containing("alpha")
        );

        // A foreign root gets no index; a corrupt file is discarded, not fatal.
        assert!(SymbolStore::load("Z:\\nowhere", home.path()).is_none());
        let index_file = SymbolStore::index_dir(&root, home.path()).join("symbols.bin");
        let good = fs::read(&index_file).unwrap();
        fs::write(&index_file, &good[..good.len() - 3]).unwrap();
        assert!(SymbolStore::load(&root, home.path()).is_none());
    }

    #[test]
    fn apply_changes_updates_replaces_and_removes() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.rs", "fn alpha() {}\n");
        write(dir.path(), "b.rs", "fn beta() { alpha(); }\n");
        let root = dir.path().display().to_string();
        let mut store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        assert_eq!(
            store.files_containing("alpha"),
            Some(vec!["a.rs".to_owned(), "b.rs".to_owned()])
        );

        // beta's declaration moves into a new file; b.rs stops mentioning alpha.
        write(dir.path(), "b.rs", "fn other() {}\n");
        write(dir.path(), "c.rs", "fn beta() {}\n");
        store.apply_changes(&["b.rs".to_owned(), "c.rs".to_owned()]);

        let beta = store.lookup("beta");
        assert_eq!(beta.len(), 1);
        assert_eq!(beta[0].path, "c.rs");
        assert_eq!(store.lookup("other").len(), 1);
        // alpha now occurs only where it is declared; "other" is untrusted (new since the
        // full build), so references to it fall back to a full scan.
        assert_eq!(
            store.files_containing("alpha"),
            Some(vec!["a.rs".to_owned()])
        );
        assert_eq!(store.files_containing("other"), None);

        // A deleted file disappears entirely.
        fs::remove_file(dir.path().join("c.rs")).unwrap();
        store.apply_changes(&["c.rs".to_owned()]);
        assert_eq!(store.lookup("beta").len(), 0);
    }

    /// A deletion from the middle of the path order compacts the table: the surviving
    /// files' ids in the occurrence lists must move down with them, not outlive the table
    /// (renumber_after_edits remaps by current position, and an unremapped id past the end
    /// panics — the release profile aborts the process on it).
    #[test]
    fn deleting_a_middle_file_keeps_occurrence_ids_in_bounds() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.rs", "fn alpha() {}\n");
        write(dir.path(), "b.rs", "fn beta() { alpha(); }\n");
        write(dir.path(), "c.rs", "fn gamma() { alpha(); }\n");
        let root = dir.path().display().to_string();
        let mut store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        assert_eq!(
            store.files_containing("alpha"),
            Some(vec![
                "a.rs".to_owned(),
                "b.rs".to_owned(),
                "c.rs".to_owned()
            ])
        );

        fs::remove_file(dir.path().join("b.rs")).unwrap();
        store.apply_changes(&["b.rs".to_owned()]);
        assert_eq!(
            store.files_containing("alpha"),
            Some(vec!["a.rs".to_owned(), "c.rs".to_owned()])
        );
    }

    #[test]
    fn fingerprint_untouched_files_survive_a_watch_batch() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.rs", "fn alpha() {}\n");
        let root = dir.path().display().to_string();
        let mut store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        let before = store.stats();
        // The watcher reports a path that did not actually change on disk.
        store.apply_changes(&["a.rs".to_owned()]);
        assert_eq!(
            (store.stats().files, store.stats().symbols),
            (before.files, before.symbols)
        );
        assert_eq!(store.lookup("alpha").len(), 1);
    }

    #[test]
    fn refresh_against_disk_reports_and_repairs() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.rs", "fn alpha() {}\n");
        let root = dir.path().display().to_string();
        let mut store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        assert_eq!(
            store.refresh_against_disk(&|_, _| {}, &|| false).unwrap(),
            0
        );

        write(dir.path(), "b.rs", "fn beta() { alpha(); }\n");
        write(dir.path(), "a.rs", "fn alpha2() {}\n");
        assert_eq!(
            store.refresh_against_disk(&|_, _| {}, &|| false).unwrap(),
            2
        );
        assert_eq!(store.lookup("alpha").len(), 0);
        assert_eq!(store.lookup("alpha2").len(), 1);
        assert_eq!(store.lookup("beta").len(), 1);
        assert!(store.refresh_against_disk(&|_, _| {}, &|| true).is_err());
    }

    #[test]
    fn names_stay_sorted_so_binary_search_finds_them() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "z.rs", "fn zulu() { yankee(); }\n");
        write(dir.path(), "y.rs", "fn yankee() {}\n");
        let root = dir.path().display().to_string();
        let mut store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        // An incremental addition must not break the sorted invariant either.
        write(dir.path(), "a.rs", "fn alfa() {}\n");
        store.apply_changes(&["a.rs".to_owned()]);
        let mut sorted = store.names.clone();
        sorted.sort();
        assert_eq!(
            store.names, sorted,
            "the name table stays sorted after an update"
        );
        // "alfa" arrived with the incremental update, so its occurrence list is untrusted
        // (references fall back to a full scan); the full build's names keep theirs.
        assert_eq!(store.files_containing("alfa"), None);
        assert_eq!(store.lookup("alfa").len(), 1);
        for name in ["yankee", "zulu"] {
            assert!(store.files_containing(name).is_some(), "{name} is findable");
        }
    }

    /// The aggregates the MCP server's progressive disclosure reads: per-file counts,
    /// the kind mix, and one file's outline with the container the flat catalogue
    /// never showed.
    #[test]
    fn aggregates_serve_counts_kinds_and_one_files_outline() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "src/lib.rs",
            "pub fn alpha() {}\nimpl Thing {\n    pub fn beta(&self) { alpha(); }\n}\n",
        );
        write(dir.path(), "src/other.rs", "fn alpha2() { alpha(); }\n");
        let root = dir.path().display().to_string();
        let store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();

        // files_with_counts: path-sorted, one row per file, declaration counts.
        assert_eq!(
            store.files_with_counts(),
            vec![("src/lib.rs".to_owned(), 2), ("src/other.rs".to_owned(), 1)]
        );

        // kind_counts: most first, kinds with nothing stay off.
        assert_eq!(store.kind_counts(), vec![("function", 2), ("method", 1)]);

        // file_symbols: line order, containers carried, refs = files containing the name.
        let rows = store
            .file_symbols("src/lib.rs")
            .expect("the file is indexed");
        assert_eq!(rows.len(), 2);
        assert_eq!(
            (
                rows[0].name.as_str(),
                rows[0].kind,
                rows[0].line,
                rows[0].end_line,
                rows[0].container.as_deref()
            ),
            ("alpha", "function", 0, 0, None)
        );
        assert_eq!(rows[0].refs, 2, "alpha occurs in both files");
        assert_eq!(
            (rows[1].name.as_str(), rows[1].kind, rows[1].line),
            ("beta", "method", 2)
        );
        assert_eq!(
            rows[1].end_line, 2,
            "the definition's body extent rides along"
        );
        assert_eq!(rows[1].container.as_deref(), Some("Thing"));
        assert_eq!(rows[1].refs, 1, "beta occurs only where it is declared");
        assert!(store.file_symbols("missing.rs").is_none());
    }

    /* ---------- the project analysis folder (2026-11-21) ---------- */

    #[test]
    fn the_store_lives_in_the_projects_hidden_analysis_folder() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.c", "void draw(void) {}\n");
        let root = dir.path().display().to_string();
        let home = tempfile::tempdir().unwrap();

        let store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        store.save(home.path()).unwrap();

        // The store landed inside the analyzed folder, under the hidden `.ggs`.
        let local = dir
            .path()
            .join(PROJECT_ANALYSIS_DIR)
            .join("analysis")
            .join(store_hash(&root));
        assert!(local.join("symbols.bin").exists());
        assert!(
            !home
                .path()
                .join("index")
                .join(store_hash(&root))
                .join("symbols.bin")
                .exists()
        );
        // A load reads the project copy back.
        assert!(SymbolStore::load(&root, home.path()).is_some());
    }

    #[cfg(windows)]
    #[test]
    fn the_analysis_folder_hides_itself_in_explorer() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.c", "void f(void) {}\n");
        let root = dir.path().display().to_string();
        let home = tempfile::tempdir().unwrap();

        let store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        store.save(home.path()).unwrap();
        let analysis = dir.path().join(PROJECT_ANALYSIS_DIR);
        let meta = fs::metadata(&analysis).unwrap();
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        assert_ne!(
            meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN,
            0,
            "the analysis folder carries the hidden attribute, the .git treatment"
        );
    }

    #[test]
    fn the_analysis_folder_leaves_the_git_index_alone() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.c", "void f(void) {}\n");
        // A repository: the exclude gains the analysis folder the moment it is created.
        fs::create_dir_all(dir.path().join(".git").join("info")).unwrap();
        let root = dir.path().display().to_string();
        let home = tempfile::tempdir().unwrap();

        let store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        store.save(home.path()).unwrap();
        let exclude = fs::read_to_string(dir.path().join(".git/info/exclude")).unwrap();
        assert!(
            exclude.lines().any(|l| l.trim() == ".ggs/"),
            "the exclude names the analysis folder: {exclude:?}"
        );
        // Idempotent: a second save does not grow the line.
        store.save(home.path()).unwrap();
        let exclude = fs::read_to_string(dir.path().join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.lines().filter(|l| l.trim() == ".ggs/").count(), 1);
    }

    #[test]
    fn a_worktree_pointer_excludes_through_the_shared_git_dir() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.c", "void f(void) {}\n");
        // The linked worktree's `.git` is a pointer file; the shared git dir it names
        // (via `commondir`) is where `info/exclude` lives.
        let shared = tempfile::tempdir().unwrap();
        fs::create_dir_all(shared.path().join("worktrees").join("wt1")).unwrap();
        fs::write(dir.path().join(".git"), format!("gitdir: {}", shared.path().join("worktrees/wt1").display())).unwrap();
        fs::write(shared.path().join("worktrees/wt1/commondir"), "../..").unwrap();
        let root = dir.path().display().to_string();
        let home = tempfile::tempdir().unwrap();

        let store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        store.save(home.path()).unwrap();
        let exclude = fs::read_to_string(shared.path().join("info/exclude")).unwrap();
        assert!(exclude.lines().any(|l| l.trim() == ".ggs/"));
    }

    #[test]
    fn a_refusing_root_falls_back_to_the_home() {
        let dir = tempfile::tempdir().unwrap();
        // The root is a FILE — no `.ggs` folder can ever be created under it.
        let blocker = dir.path().join("notafolder");
        fs::write(&blocker, "x").unwrap();
        let root = blocker.display().to_string();
        let home = tempfile::tempdir().unwrap();

        let store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        store.save(home.path()).unwrap();
        assert!(
            home.path().join("index").join(store_hash(&root)).join("symbols.bin").exists(),
            "an unwritable project keeps its store in the GGS home"
        );
    }

    #[test]
    fn a_full_build_writes_the_reference_database_and_a_wipe_regenerates_it() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "src/shape.cpp",
            "struct Shape { int area; };\nvoid draw(Shape s) { use(s.area); }\nvoid render(void) { draw(*(Shape*)0); }\n",
        );
        let root = dir.path().display().to_string();
        let home = tempfile::tempdir().unwrap();

        let store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        store.save(home.path()).unwrap();
        let dir_path = dir.path().join(PROJECT_ANALYSIS_DIR).join("analysis").join(store_hash(&root));
        let db = dir_path.join(anadb::DB_FILE);
        let tix = dir_path.join(anadb::TIX_FILE);
        let db_bytes = fs::read(&db).expect("the reference database rides beside the store");
        let tix_bytes = fs::read(&tix).expect("the syllable index rides beside the store");
        assert_eq!(&db_bytes[0..4], &anadb::DB_MAGIC.to_le_bytes());
        assert_eq!(&tix_bytes[0..4], b"TIX1");

        // The delete-and-regenerate surface: wipe, then a fresh build writes the same
        // bytes whole.
        SymbolStore::remove_store_dirs(&root, home.path());
        assert!(SymbolStore::load(&root, home.path()).is_none());
        assert!(!db.exists());
        let rebuilt = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        rebuilt.save(home.path()).unwrap();
        assert_eq!(fs::read(&db).unwrap(), db_bytes, "the same analysis regenerates the same file");

        // The database's tables speak the parsed truth: one module, the declarations,
        // the call edge render -> draw, and the syllable fragments.
        let tables = store.si.as_ref().unwrap();
        assert_eq!(tables.mods.len(), 1);
        assert_eq!(tables.mods[0].name, "src/shape.cpp");
        let names: Vec<&str> = tables.syms.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"draw") && names.contains(&"render") && names.contains(&"Shape"));
        assert!(tables.syls.iter().any(|s| s.frag == b"draw"));
        let edges: Vec<(i32, i32)> = tables.edges.iter().map(|e| (e.caller, e.callee)).collect();
        assert_eq!(edges.len(), 1, "the call inside render is the one edge: {edges:?}");
        // `use(s.area)` — a member access after '.', never a reference row.
        let plain: Vec<_> = tables.code.iter().filter(|c| c.is_def == 0).collect();
        assert!(
            plain.iter().all(|c| tables.syms[c.sym as usize].name != "area"),
            "member access records no reference: {plain:?}"
        );
    }
}
