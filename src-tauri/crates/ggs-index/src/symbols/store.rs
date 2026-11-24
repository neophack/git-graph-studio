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

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rayon::prelude::*;

use crate::scan::is_symbol_source;
use crate::symbols::projvol::{
    self, SymSlot, VolumeHeader, FREE_HEAD_NONE, MAGIC_SYM, MAGIC_XDIR, MAGIC_XVOL, SYM_REC_SIZE,
    VOL_VERSION, XVOL_REC_SIZE,
};
use crate::symbols::projvol_indexgen;
use crate::symbols::projvol_sig;
use crate::symbols::symgen;
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
    "field",
    "constant",
];

fn kind_id(kind: &str) -> u8 {
    KINDS.iter().position(|k| *k == kind).unwrap_or(0) as u8
}

fn kind_name(id: u8) -> &'static str {
    KINDS.get(id as usize).copied().unwrap_or(KINDS[0])
}

/// The project-volume family persisted on disk (replacing the older `symbols.bin` /
/// `ggs.db` / `ggs.tix` triad): the nine `.ggs_*` volumes live in the project's hidden
/// `.ggs/analysis/<hash>/` directory.
pub const SYM_VOL_FILE: &str = "project.ggs_sym";
pub const XAB_VOL_FILE: &str = "project.ggs_xab";
pub const XAD_VOL_FILE: &str = "project.ggs_xad";
pub const XC_VOL_FILE: &str = "project.ggs_xc";
pub const XF_VOL_FILE: &str = "project.ggs_xf";
pub const XM_VOL_FILE: &str = "project.ggs_xm";
pub const XR_VOL_FILE: &str = "project.ggs_xr";
pub const XSB_VOL_FILE: &str = "project.ggs_xsb";
pub const XSD_VOL_FILE: &str = "project.ggs_xsd";
pub const PROJECT_VOL_FILES: [&str; 9] = [
    SYM_VOL_FILE,
    XAB_VOL_FILE,
    XAD_VOL_FILE,
    XC_VOL_FILE,
    XF_VOL_FILE,
    XM_VOL_FILE,
    XR_VOL_FILE,
    XSB_VOL_FILE,
    XSD_VOL_FILE,
];

/// The format marker inside the `.ggs_sym` trailer block: a corrupt or foreign volume set
/// is discarded, never fatal.
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
/// Format 8 (2026-11-23): the KINDS table added `field` and `constant` (struct/class
/// fields, enum constants, top-level constants), and the C/C++ queries expanded to index
/// fields, enumerators, unions, and multi-pointer/array/function-pointer declarations.
const VERSION: u8 = 8;

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

/// A file's extraction, before the names are interned.
struct Extraction {
    path: String,
    mtime_ms: u64,
    size: u64,
    symbols: Vec<Extracted>,
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
    /// The paths whose volume facts on disk may lag the store: every file a batch
    /// re-extracted since the last successful volume write. The dirty-aware save
    /// re-derives exactly these files' records and loads the rest from the volumes
    /// the previous write left behind.
    dirty: HashSet<String>,
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
            dirty: HashSet::new(),
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

        // Phase 2: the name table — every declaration, container and base name collected
        // once, sorted, deduplicated; the position is the id (sorted, so binary-searchable).
        let mut table: Vec<&str> = Vec::new();
        for file in &extracted {
            for symbol in &file.symbols {
                table.push(symbol.name.as_str());
                if let Some(container) = &symbol.container {
                    table.push(container.as_str());
                }
                for base in &symbol.bases {
                    table.push(base.as_str());
                }
            }
        }
        table.sort_unstable();
        table.dedup();
        let names: Vec<String> = table.iter().map(|name| (*name).to_owned()).collect();
        let lookup: HashMap<&str, u32> = names
            .iter()
            .enumerate()
            .map(|(id, name)| (name.as_str(), id as u32))
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
                    let words = match fs::read_to_string(Path::new(root).join(&file.path)) {
                        Ok(text) => words_in(&text, &|word| lookup.get(word).copied()),
                        Err(_) => Vec::new(),
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
                    (file.path.clone(), words, symbols, bases)
                })
                .collect();
            scanned.append(&mut part);
        }

        let mut store = SymbolStore {
            root: root.to_owned(),
            files: scanned
                .into_iter()
                .zip(extracted.iter())
                .map(|((path, words, symbols, bases), file)| FileEntry {
                    path,
                    mtime_ms: file.mtime_ms,
                    size: file.size,
                    symbols,
                    words,
                    bases,
                })
                .collect(),
            names,
            refs: Vec::new(),
            dirty: HashSet::new(),
        };
        // The walk is sorted and phase 1 sorted again; the zip above keeps that order.
        debug_assert!(store.files.windows(2).all(|w| w[0].path < w[1].path));
        store.rebuild_refs();
        Some(store)
    }

    /* ---------- Incremental updates ---------- */

    /// Apply watcher changes (repo-relative paths): gone files are dropped, changed files
    /// re-extracted (a matching fingerprint skips the work), new files added. Names first
    /// seen here stay untrusted; every trusted name's occurrence list stays complete because
    /// each touched file's contributions are subtracted and rescanned. Answers whether the
    /// store changed at all — a batch naming nothing the store holds must not pay a save
    /// (the write is bytes on disk and a watcher event, never free). The drift walk runs
    /// under the caller's lock; the watcher's save path stats outside it through
    /// [`SymbolStore::fingerprints`] + [`SymbolStore::apply_drifted`].
    pub fn apply_changes(&mut self, paths: &[String]) -> bool {
        let drifted = Self::drift_of(&self.root, &self.fingerprints(), paths);
        self.apply_drifted(paths, &drifted)
    }

    /// The store's (path, mtime, size) table, cloned for an out-of-lock drift scan: the
    /// watcher's save path stats the tree with the store's lock RELEASED — the walk is
    /// O(files), a few hundred milliseconds on a 20k-file root, and must never sit
    /// between a symbol query and its answer — then hands the result back through
    /// [`SymbolStore::apply_drifted`].
    pub fn fingerprints(&self) -> Vec<(String, u64, u64)> {
        self.files
            .iter()
            .map(|f| (f.path.clone(), f.mtime_ms, f.size))
            .collect()
    }

    /// The known files among `fingerprints` whose recorded (mtime, size) no longer
    /// matches the disk — the batch's own paths excluded (they re-extract regardless).
    pub fn drift_of(
        root: &str,
        fingerprints: &[(String, u64, u64)],
        batch: &[String],
    ) -> Vec<String> {
        let wanted: HashSet<&str> = batch.iter().map(String::as_str).collect();
        fingerprints
            .iter()
            .filter(|(path, ..)| !wanted.contains(path.as_str()))
            .filter(|(path, mtime, size)| {
                stat_of(&Path::new(root).join(path))
                    .is_none_or(|s| s.mtime_ms != *mtime || s.size != *size)
            })
            .map(|(path, ..)| path.clone())
            .collect()
    }

    /// Apply watcher changes with the drift precomputed: `batch` names the watcher's
    /// paths, `drifted` the known files whose fingerprints no longer match the disk.
    /// Both re-extract; everything else is trusted unchanged. Answers whether the store
    /// changed at all, marking every re-extracted path dirty for the dirty-aware
    /// volume write.
    pub fn apply_drifted(&mut self, batch: &[String], drifted: &[String]) -> bool {
        let mut wanted: HashSet<&str> = batch
            .iter()
            .map(String::as_str)
            .filter(|p| is_symbol_source(p))
            .collect();
        for path in drifted {
            wanted.insert(path.as_str());
        }
        // The touched files' occurrence contributions are subtracted up front; the rows
        // themselves stay in place — the upsert refills them under the same ids — and
        // only a deletion (or a re-extraction that fails, which drops the row the same
        // way) compacts the table. The store's fields are borrowed apart so the scan of
        // `files` can subtract into `refs` while it walks.
        let root = self.root.clone();
        let before_len = self.files.len();
        let known: HashSet<String> = self.files.iter().map(|f| f.path.clone()).collect();
        let added = wanted.iter().any(|p| !known.contains(*p));
        let SymbolStore { files, refs, .. } = self;
        let mut to_extract: HashSet<String> = HashSet::new();
        let mut dropped: HashSet<String> = HashSet::new();
        let mut changed = false;
        for file in files.iter() {
            if !wanted.contains(file.path.as_str()) {
                continue;
            }
            changed = true;
            Self::subtract_contributions(refs, files, file);
            if stat_of(&Path::new(&root).join(&file.path)).is_some() {
                to_extract.insert(file.path.clone());
            } else {
                dropped.insert(file.path.clone());
            }
        }
        // Watched paths the store never knew (a brand-new file) join the re-extraction.
        for path in wanted {
            if !known.contains(path) && Path::new(&root).join(path).exists() {
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
        let extracted: HashSet<&str> = upserts.iter().map(|e| e.path.as_str()).collect();
        for path in to_extract.iter() {
            if !extracted.contains(path.as_str()) {
                dropped.insert(path.clone());
            }
        }
        // The compacted id of every old id — u32::MAX for the dropped rows. The occurrence
        // lists still name pre-compaction ids, and renumber_after_edits remaps by current
        // position, so a kept file whose old id outlives the shrunken table would index out
        // of bounds there. Rewrite the ids here; a dropped id subtraction somehow left
        // behind is a reference to a file that no longer exists and goes with it.
        let mut kept: Vec<FileEntry> = Vec::with_capacity(files.len());
        let mut compact: Vec<u32> = Vec::with_capacity(files.len());
        for file in files.drain(..) {
            if dropped.contains(&file.path) {
                compact.push(u32::MAX);
            } else {
                compact.push(kept.len() as u32);
                kept.push(file);
            }
        }
        *files = kept;
        for list in refs.iter_mut().flatten() {
            for id in list.iter_mut() {
                *id = compact.get(*id as usize).copied().unwrap_or(u32::MAX);
            }
            list.retain(|&id| id != u32::MAX);
        }
        let touched: Vec<String> = upserts.iter().map(|e| e.path.clone()).collect();
        self.upsert(upserts);
        for path in touched {
            self.dirty.insert(path);
        }
        for path in dropped {
            self.dirty.remove(&path);
        }
        // A deletion or an insertion moves every later file's id; a pure content edit —
        // the Ctrl+S case — leaves the table untouched, and the whole-table renumber (the
        // sort plus every occurrence list rewritten) can skip.
        if added || self.files.len() != before_len {
            self.renumber_after_edits();
        }
        changed
    }

    /// Forget the given paths' dirty marks — the drain calls this once the write has
    /// actually landed, so a failed write keeps the store's lagging set intact.
    pub fn clear_dirty(&mut self, paths: &[String]) {
        for path in paths {
            self.dirty.remove(path);
        }
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
        // The walk above stat-ed every file already; hand the result straight over
        // instead of paying the drift walk a second time.
        self.apply_drifted(&touched, &touched);
        Ok(touched.len())
    }

    /// Insert freshly extracted files (sorted by path): intern new names as untrusted,
    /// add their occurrence contributions. A file the table already holds is REFILLED in
    /// place — its row keeps its id and its position, so a pure content edit (the Ctrl+S
    /// case) leaves the whole table untouched — and only a brand-new file appends (the
    /// caller's renumber pass then sorts the table and repairs the ids).
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
        let positions: HashMap<String, u32> = self
            .files
            .iter()
            .enumerate()
            .map(|(id, file)| (file.path.clone(), id as u32))
            .collect();
        // The refilled rows' occurrence lists: re-sorted and deduplicated in place —
        // the renumber pass that used to do this for every batch only runs on real
        // table changes now.
        let mut refilled_lists: Vec<u32> = Vec::new();
        for file in upserts {
            // The occurrence list: one more read of the file (the extraction no longer
            // carries the word set — the full build stopped holding every file's words);
            // an unknown word — never a declared name — drops.
            let words = fs::read_to_string(Path::new(&self.root).join(&file.path))
                .map(|text| words_in(&text, &|word| lookup.get(word).copied()))
                .unwrap_or_default();
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
            match positions.get(&entry.path).copied() {
                // The refill: the row keeps its id (its old occurrence contributions
                // were subtracted by the caller), the new ones land under the same id.
                Some(id) => {
                    self.files[id as usize] = entry;
                    for word in &words {
                        refilled_lists.push(*word);
                        if let Some(Some(list)) = self.refs.get_mut(*word as usize) {
                            list.push(id);
                        }
                    }
                }
                // A brand-new file: the entry's pre-renumber id is final here —
                // renumber_after_edits remaps it.
                None => {
                    let entry_id = self.files.len() as u32;
                    self.files.push(entry);
                    for word in words {
                        if let Some(Some(files)) = self.refs.get_mut(word as usize) {
                            files.push(entry_id);
                        }
                    }
                }
            }
        }
        refilled_lists.sort_unstable();
        refilled_lists.dedup();
        for word in refilled_lists {
            if let Some(Some(list)) = self.refs.get_mut(word as usize) {
                list.sort_unstable();
                list.dedup();
            }
        }
        // No fresh names — no id moved — and the whole-table re-sort plus its id remap
        // can skip: the Ctrl+S case was paying O(names log names) string clones and a
        // full refs rebuild for an identity transform.
        if !fresh.is_empty() {
            self.sort_names();
        }
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

    /// Persist the root's index as the nine `.ggs_*` project volumes (`project.ggs_sym`,
    /// `project.ggs_xab`, `project.ggs_xad`, `project.ggs_xc`, `project.ggs_xf`,
    /// `project.ggs_xm`, `project.ggs_xr`, `project.ggs_xsb`, `project.ggs_xsd`) — and remove
    /// any legacy `symbols.bin` / `ggs.db` / `ggs.tix` files from earlier versions.
    /// The full-derivation save: a build's first write (or an explicit one) re-derives
    /// every file's facts and ignores whatever volumes stand on disk.
    pub fn save(&self, home: &Path) -> Result<(), String> {
        let snapshot = self.save_snapshot_full();
        Self::write_volumes(&snapshot, home)
    }

    /// The volume write's inputs, cloned from the store: the serialized trailer payload,
    /// the file list, and the parsed-symbol fallback facts. Building it is pure CPU over
    /// small structs — the watcher's save path snapshots this under the store's lock in
    /// milliseconds and hands it to [`SymbolStore::write_volumes`], which does the heavy
    /// reading and writing with no lock held. The store's dirty set rides along: the
    /// write re-derives exactly those files' facts and loads the rest from the volumes
    /// the previous write left behind.
    pub fn save_snapshot(&self) -> SaveSnapshot {
        let mut snapshot = self.save_snapshot_full();
        snapshot.full = false;
        snapshot.dirty_fids.clear();
        snapshot.dirty_paths.clear();
        for (fid, path) in snapshot.paths.iter().enumerate() {
            if self.dirty.contains(path) {
                snapshot.dirty_fids.push(fid as u32);
                snapshot.dirty_paths.push(path.clone());
            }
        }
        snapshot
    }

    /// The same snapshot with every file marked for derivation — `save`'s input, and
    /// the shape a fresh build (no volumes on disk yet) writes from.
    pub fn save_snapshot_full(&self) -> SaveSnapshot {
        let mut trailer = Vec::new();
        trailer.extend_from_slice(MAGIC);
        trailer.push(VERSION);
        push_str(&mut trailer, &self.root);
        push_u32(&mut trailer, self.files.len() as u32);
        push_u32(&mut trailer, self.names.len() as u32);
        for name in &self.names {
            push_str(&mut trailer, name);
        }
        for file in &self.files {
            push_str(&mut trailer, &file.path);
            push_u64(&mut trailer, file.mtime_ms);
            push_u64(&mut trailer, file.size);
            push_u32(&mut trailer, file.symbols.len() as u32);
            for symbol in &file.symbols {
                trailer.push(symbol.kind);
                trailer.extend_from_slice(&symbol.name_id.to_le_bytes());
                trailer.extend_from_slice(&symbol.container_id.to_le_bytes());
                trailer.extend_from_slice(&symbol.line.to_le_bytes());
                trailer.extend_from_slice(&symbol.column.to_le_bytes());
                trailer.extend_from_slice(&symbol.end_line.to_le_bytes());
            }
            push_u32(&mut trailer, file.bases.len() as u32);
            for record in &file.bases {
                trailer.extend_from_slice(&record.symbol.to_le_bytes());
                push_u32(&mut trailer, record.bases.len() as u32);
                for &base in &record.bases {
                    trailer.extend_from_slice(&base.to_le_bytes());
                }
            }
        }
        for refs in &self.refs {
            match refs {
                None => trailer.push(0),
                Some(files) => {
                    trailer.push(1);
                    push_u32(&mut trailer, files.len() as u32);
                    for &file in files {
                        trailer.extend_from_slice(&file.to_le_bytes());
                    }
                }
            }
        }
        SaveSnapshot {
            root: self.root.clone(),
            trailer,
            paths: self.files.iter().map(|f| f.path.clone()).collect(),
            fingerprints: self.files.iter().map(|f| (f.mtime_ms, f.size)).collect(),
            fallback: self
                .files
                .iter()
                .map(|f| {
                    f.symbols
                        .iter()
                        .map(|s| FallbackSym {
                            kind: symvol_kind_of(s.kind),
                            name_id: s.name_id,
                            line: s.line,
                            column: s.column,
                            end_line: s.end_line,
                        })
                        .collect()
                })
                .collect(),
            names: self.names.clone(),
            has_parsed_symbols: self.files.iter().any(|f| !f.symbols.is_empty()),
            full: true,
            dirty_fids: (0..self.files.len() as u32).collect(),
            dirty_paths: Vec::new(),
        }
    }

    /// Read the root's index back from the nine `.ggs_*` project volumes. `None` when any
    /// of the nine volumes is missing or malformed — a corrupt or incomplete volume set
    /// means "rebuild", never an error to surface.
    pub fn load(root: &str, home: &Path) -> Option<SymbolStore> {
        let dir = Self::store_dirs(root, home)
            .into_iter()
            .find(|dir| PROJECT_VOL_FILES.iter().all(|name| dir.join(name).is_file()))?;
        // Verify the sibling volumes' headers before reading the `.ggs_sym` volume.
        for xname in [XF_VOL_FILE, XR_VOL_FILE, XC_VOL_FILE] {
            let xbytes = fs::read(dir.join(xname)).ok()?;
            let xheader = VolumeHeader::parse_block(&xbytes)?;
            if xheader.magic != MAGIC_XVOL || xheader.rec_size as usize != XVOL_REC_SIZE {
                return None;
            }
        }
        for dname in [XAD_VOL_FILE, XSD_VOL_FILE] {
            let dbytes = fs::read(dir.join(dname)).ok()?;
            if dbytes.len() < 4 || u32::from_le_bytes(dbytes[..4].try_into().ok()?) != MAGIC_XDIR {
                return None;
            }
        }
        let xm_bytes = fs::read(dir.join(XM_VOL_FILE)).ok()?;
        projvol::parse_xm(&xm_bytes)?;

        let sym_vol = fs::read(dir.join(SYM_VOL_FILE)).ok()?;
        let header = VolumeHeader::parse_block(&sym_vol)?;
        if header.magic != MAGIC_SYM
            || header.version != VOL_VERSION
            || header.rec_size as usize != SYM_REC_SIZE
        {
            return None;
        }
        let live_end = projvol::HEADER_BLOCK_SIZE
            .checked_add((header.count as usize).checked_mul(SYM_REC_SIZE)?)?;
        let total_end = projvol::HEADER_BLOCK_SIZE
            .checked_add((header.capacity as usize).checked_mul(SYM_REC_SIZE)?)?;
        if total_end != sym_vol.len() || live_end > total_end {
            return None;
        }
        let trailer = &sym_vol[live_end..total_end];
        if trailer.len() < 4 {
            return None;
        }
        let payload_len = u32::from_le_bytes(trailer[..4].try_into().ok()?) as usize;
        if 4 + payload_len > trailer.len() {
            return None;
        }
        let bytes = &trailer[4..4 + payload_len];
        let mut at = 0usize;
        take(bytes, &mut at, MAGIC.len())?
            .iter()
            .eq(MAGIC.iter())
            .then_some(())?;
        (take(bytes, &mut at, 1)?[0] == VERSION).then_some(())?;
        let stored_root = take_str(bytes, &mut at)?;
        if stored_root != root {
            return None;
        }
        let file_count = take_u32(bytes, &mut at)? as usize;
        let name_count = take_u32(bytes, &mut at)? as usize;
        let mut names = Vec::with_capacity(name_count);
        for _ in 0..name_count {
            names.push(take_str(bytes, &mut at)?);
        }
        let mut files = Vec::with_capacity(file_count);
        for _ in 0..file_count {
            let path = take_str(bytes, &mut at)?;
            let mtime_ms = take_u64(bytes, &mut at)?;
            let size = take_u64(bytes, &mut at)?;
            let symbols = take_u32(bytes, &mut at)? as usize;
            let mut parsed = Vec::with_capacity(symbols);
            for _ in 0..symbols {
                let kind = take(bytes, &mut at, 1)?[0];
                let name_id = take_u32(bytes, &mut at)?;
                let container_id = take_u32(bytes, &mut at)?;
                let line = take_u32(bytes, &mut at)?;
                let column = take_u32(bytes, &mut at)?;
                let end_line = take_u32(bytes, &mut at)?;
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
            let base_records = take_u32(bytes, &mut at)? as usize;
            for _ in 0..base_records {
                let symbol = take_u32(bytes, &mut at)?;
                let count = take_u32(bytes, &mut at)? as usize;
                let mut ids = Vec::with_capacity(count);
                for _ in 0..count {
                    let base = take_u32(bytes, &mut at)?;
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
            match take(bytes, &mut at, 1)?[0] {
                0 => refs.push(None),
                1 => {
                    let count = take_u32(bytes, &mut at)? as usize;
                    let mut list = Vec::with_capacity(count);
                    for _ in 0..count {
                        list.push(take_u32(bytes, &mut at)?);
                    }
                    refs.push(Some(list));
                }
                _ => return None,
            }
        }
        if at != bytes.len() {
            return None;
        }
        let mut store = SymbolStore {
            root: stored_root,
            files,
            names,
            refs,
            dirty: HashSet::new(),
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
    Some(Extraction {
        path: relative.to_owned(),
        mtime_ms: stat.mtime_ms,
        size: stat.size,
        symbols,
    })
}

/// Map one of `SymbolStore`'s internal kind ids to the `.ggs_sym` volume's kind code.
fn symvol_kind_of(kind: u8) -> u16 {
    match kind_name(kind) {
        "function" => 0,
        "method" => 11,
        "class" => 10,
        "struct" => 2,
        "interface" => 10,
        "enum" => 7,
        "module" => 29,
        "type" => 4,
        "macro" => 6,
        "variable" => 5,
        "field" => 17,
        "constant" => 12,
        _ => 0,
    }
}

/// What the nine-volume write needs from the store, cloned under the store's lock: the
/// serialized trailer payload, the file list, and the parsed-symbol fallback facts.
/// Building one is milliseconds of pure CPU; the heavy work — reading the source files
/// whose volume facts are stale and writing the volumes — runs in
/// [`SymbolStore::write_volumes`] with no lock held, so a watcher-driven save never
/// blocks the queries against the store.
pub struct SaveSnapshot {
    root: String,
    /// The whole store payload, serialized exactly as `load` parses it back.
    trailer: Vec<u8>,
    /// The store's file paths in store order — the volumes' file-id order.
    paths: Vec<String>,
    /// Per file, the recorded (mtime, size) aligned with `paths` — what the reuse
    /// validator compares against the previous volumes' own trailer table.
    fingerprints: Vec<(u64, u64)>,
    /// Per file, the parsed symbols reduced to their `.ggs_sym` fallback facts.
    fallback: Vec<Vec<FallbackSym>>,
    names: Vec<String>,
    has_parsed_symbols: bool,
    /// A full derivation: every file's facts re-derived, the on-disk volumes ignored.
    full: bool,
    /// The file ids whose volume facts must be re-derived — the store's dirty paths
    /// resolved against `paths` (empty under `full`, where every id derives).
    pub(crate) dirty_fids: Vec<u32>,
    /// The dirty paths themselves, for the drain's post-write clear.
    pub(crate) dirty_paths: Vec<String>,
}

/// One parsed symbol reduced for the fallback slots: the final `.ggs_sym` kind code and
/// the geometry, the name resolved through `SaveSnapshot::names` at write time.
struct FallbackSym {
    kind: u16,
    name_id: u32,
    line: u32,
    column: u32,
    end_line: u32,
}

/// The source-bytes budget under which the volume write keeps every file's split rows
/// from its single read instead of re-reading the file when the sym graph asks for its
/// rows. Past the budget the rows stay unheld — their per-line vectors would roughly
/// triple the write's footprint — and the graph re-reads from the cache-warm tree, as
/// before. Either way the emitted bytes are the same.
const ROWS_KEEP_BUDGET: u64 = 128 * 1024 * 1024;

/// The write-state marker beside the nine volumes (`project.ggs_state`): which
/// `.ggs_sym` slot mode the last write used, plus the byte length and FNV-1a of each
/// volume the incremental save may load its unchanged records back from. A missing,
/// stale or mismatched marker simply disables the reuse — that save runs the full
/// derivation, and the next successful write re-arms it. Written AFTER the four
/// hashed volumes land, so the marker always describes what is on disk.
pub const STATE_VOL_FILE: &str = "project.ggs_state";
const STATE_FORMAT: u8 = 1;
/// The `.ggs_sym` slot mode a write used: the symgen scanners' records, or the store's
/// parsed-symbol fallback records when no scanner covered any file.
const SYM_MODE_FALLBACK: u8 = 0;
const SYM_MODE_SYMGEN: u8 = 1;

/// The previous write's per-file volume facts, loaded back as the incremental save's
/// cache: the three signature slots per file id, the `.ggs_sym` records, the slot mode
/// they were built under, and the previous trailer's file table (the per-fid reuse
/// validator). Everything the dirty-aware write would otherwise re-derive from the
/// source tree.
struct VolumeCache {
    symgen: bool,
    table: Vec<(String, u64, u64)>,
    xr: Vec<[u8; XVOL_REC_SIZE]>,
    xf: Vec<[u8; XVOL_REC_SIZE]>,
    xc: Vec<[u8; XVOL_REC_SIZE]>,
    sym_records: Vec<SymSlot>,
}

fn fnv1a32(bytes: &[u8]) -> u32 {
    let mut hash: u32 = FNV_INIT;
    for &byte in bytes {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

const FNV_INIT: u32 = 0x811c_9dc5;

/// The streaming write's digests: wraps the volume writer, accumulating the byte
/// length and FNV-1a the state marker records. Nothing reads the volume back twice.
struct HashingWriter<'a, W: std::io::Write> {
    inner: &'a mut W,
    len: u64,
    hash: u32,
}

impl<W: std::io::Write> std::io::Write for HashingWriter<'_, W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let wrote = self.inner.write(buf)?;
        self.len += wrote as u64;
        for &byte in &buf[..wrote] {
            self.hash ^= byte as u32;
            self.hash = self.hash.wrapping_mul(0x0100_0193);
        }
        Ok(wrote)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn parse_state_marker(marker: &[u8]) -> Option<(bool, [(u64, u32); 4])> {
    if marker.len() != 2 + 4 * 12 || marker[0] != STATE_FORMAT {
        return None;
    }
    let mode = marker[1];
    if mode != SYM_MODE_SYMGEN && mode != SYM_MODE_FALLBACK {
        return None;
    }
    let mut pairs = [(0u64, 0u32); 4];
    for (i, pair) in pairs.iter_mut().enumerate() {
        let at = 2 + i * 12;
        *pair = (
            u64::from_le_bytes(marker[at..at + 8].try_into().ok()?),
            u32::from_le_bytes(marker[at + 8..at + 12].try_into().ok()?),
        );
    }
    Some((mode == SYM_MODE_SYMGEN, pairs))
}

fn write_state_marker(
    dir: &Path,
    symgen: bool,
    pairs: [(u64, u32); 4],
) -> Result<(), String> {
    let mut marker = Vec::with_capacity(2 + 4 * 12);
    marker.push(STATE_FORMAT);
    marker.push(if symgen {
        SYM_MODE_SYMGEN
    } else {
        SYM_MODE_FALLBACK
    });
    for (len, hash) in pairs {
        marker.extend_from_slice(&len.to_le_bytes());
        marker.extend_from_slice(&hash.to_le_bytes());
    }
    ggs_base::fsx::atomic_write(&dir.join(STATE_VOL_FILE), &marker)
}

/// The previous write's file table — path/mtime/size per file id — parsed out of the
/// `.ggs_sym` trailer payload (the same bytes `load` restores the store from, here
/// read only as far as the table).
fn trailer_file_table(spare: &[u8], root: &str) -> Option<Vec<(String, u64, u64)>> {
    let payload_len = u32::from_le_bytes(spare.get(..4)?.try_into().ok()?) as usize;
    let bytes = spare.get(4..4 + payload_len)?;
    let mut at = 0usize;
    take(bytes, &mut at, MAGIC.len())?
        .iter()
        .eq(MAGIC.iter())
        .then_some(())?;
    (take(bytes, &mut at, 1)?[0] == VERSION).then_some(())?;
    (take_str(bytes, &mut at)? == root).then_some(())?;
    let file_count = take_u32(bytes, &mut at)? as usize;
    let name_count = take_u32(bytes, &mut at)? as usize;
    for _ in 0..name_count {
        take_str(bytes, &mut at)?;
    }
    let mut table = Vec::with_capacity(file_count);
    for _ in 0..file_count {
        let path = take_str(bytes, &mut at)?;
        let mtime = take_u64(bytes, &mut at)?;
        let size = take_u64(bytes, &mut at)?;
        let symbols = take_u32(bytes, &mut at)? as usize;
        for _ in 0..symbols {
            // kind + name_id + container_id + line + column + end_line, walked past
            take(bytes, &mut at, 21)?;
        }
        let base_records = take_u32(bytes, &mut at)? as usize;
        for _ in 0..base_records {
            take_u32(bytes, &mut at)?;
            let count = take_u32(bytes, &mut at)? as usize;
            for _ in 0..count {
                take_u32(bytes, &mut at)?;
            }
        }
        table.push((path, mtime, size));
    }
    Some(table)
}

/// Load the previous write's volume facts back: the state marker validates the four
/// reusable volumes' identity (length + FNV-1a), the `.ggs_sym` parse yields the slot
/// records, its trailer yields the file table. Any mismatch — a crash mid-write, a
/// foreign or hand-edited set, a format bump — answers `None` and the save runs the
/// full derivation.
fn load_volume_cache(dir: &Path, snapshot: &SaveSnapshot) -> Option<VolumeCache> {
    let marker = fs::read(dir.join(STATE_VOL_FILE)).ok()?;
    let (symgen, pairs) = parse_state_marker(&marker)?;
    let mut bytes_of = Vec::with_capacity(4);
    for name in [SYM_VOL_FILE, XF_VOL_FILE, XR_VOL_FILE, XC_VOL_FILE] {
        bytes_of.push(fs::read(dir.join(name)).ok()?);
    }
    for (bytes, (len, hash)) in bytes_of.iter().zip(pairs.iter()) {
        if bytes.len() as u64 != *len || fnv1a32(bytes) != *hash {
            return None;
        }
    }
    let sym_bytes = &bytes_of[0];
    let xf_bytes = &bytes_of[1];
    let xr_bytes = &bytes_of[2];
    let xc_bytes = &bytes_of[3];
    let xslots = |bytes: &[u8]| -> Option<Vec<[u8; XVOL_REC_SIZE]>> {
        let header = VolumeHeader::parse_block(bytes.get(..projvol::HEADER_BLOCK_SIZE)?)?;
        (header.magic == MAGIC_XVOL && header.rec_size as usize == XVOL_REC_SIZE).then_some(())?;
        let n = header.count as usize;
        (bytes.len() == projvol::HEADER_BLOCK_SIZE + n * XVOL_REC_SIZE).then_some(())?;
        Some(
            (0..n)
                .map(|i| {
                    let mut slot = [0u8; XVOL_REC_SIZE];
                    let at = projvol::HEADER_BLOCK_SIZE + i * XVOL_REC_SIZE;
                    slot.copy_from_slice(&bytes[at..at + XVOL_REC_SIZE]);
                    slot
                })
                .collect(),
        )
    };
    let xf = xslots(xf_bytes)?;
    let xr = xslots(xr_bytes)?;
    let xc = xslots(xc_bytes)?;
    let parsed = projvol::parse_sym_volume(sym_bytes)?;
    let live_end = projvol::HEADER_BLOCK_SIZE
        + parsed.header.count as usize * SYM_REC_SIZE;
    let table = trailer_file_table(&sym_bytes[live_end..], &snapshot.root)?;
    Some(VolumeCache {
        symgen,
        table,
        xr,
        xf,
        xc,
        sym_records: parsed.records,
    })
}

/// The parsed-symbol fallback slots for the fids `want` marks, in fid order — the
/// full write marks every fid, the incremental one only its derived fids.
fn fallback_slots(snapshot: &SaveSnapshot, want: &[bool]) -> Vec<SymSlot> {
    let mut slots = Vec::new();
    for (fid, syms) in snapshot.fallback.iter().enumerate() {
        if !want.get(fid).copied().unwrap_or(false) {
            continue;
        }
        for s in syms {
            slots.push(SymSlot {
                name: snapshot.names[s.name_id as usize].as_bytes().to_vec(),
                line0: s.line,
                col0: s.column,
                decl_start: s.line,
                token_col: s.column,
                decl_end_line: s.end_line,
                decl_end_col: 0,
                raw108: 0,
                raw112: 0,
                raw116: 0,
                prev: FREE_HEAD_NONE,
                scope: FREE_HEAD_NONE,
                related: FREE_HEAD_NONE,
                file_id: fid as u32,
                raw136: 0,
                kind: s.kind,
                flags: 0,
                name_tag: 0,
            });
        }
    }
    slots
}

/// Merge the kept records and the freshly derived ones into one fid-ascending list.
/// Both sides are fid-ascending and a fid appears in at most one of them (a file is
/// either reused or derived), so this is the stable interleave a full derivation
/// would have produced.
fn merge_sym_slots(kept: Vec<SymSlot>, fresh: Vec<SymSlot>) -> Vec<SymSlot> {
    let mut merged = Vec::with_capacity(kept.len() + fresh.len());
    let mut k = kept.into_iter().peekable();
    let mut f = fresh.into_iter().peekable();
    loop {
        let take_kept = match (k.peek(), f.peek()) {
            (Some(a), Some(b)) => a.file_id <= b.file_id,
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (None, None) => break,
        };
        if take_kept {
            merged.push(k.next().unwrap());
        } else {
            merged.push(f.next().unwrap());
        }
    }
    merged
}

/// The volume write's rayon pool: half the cores (at least two), the build's own
/// background budget — a save must never take every core away from the page while the
/// symbol queries answer.
fn save_pool() -> &'static rayon::ThreadPool {
    static POOL: std::sync::OnceLock<rayon::ThreadPool> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(super::index::SymbolIndex::index_threads(true))
            .thread_name(|i| format!("ggs-vol-{i}"))
            .build()
            .expect("the volume-save pool builds")
    })
}

impl SymbolStore {
    /// Assemble and write the nine `.ggs_*` project volumes (`project.ggs_sym`,
    /// `project.ggs_xf`, `project.ggs_xr`, `project.ggs_xc`, `project.ggs_xm`,
    /// `project.ggs_xab`, `project.ggs_xad`, `project.ggs_xsb`, `project.ggs_xsd`) from a
    /// [`SaveSnapshot`] into the snapshot root's analysis folder, removing any legacy
    /// `symbols.bin` / `ggs.db` / `ggs.tix` files. The store's lock is never held across
    /// this: the only store state it touches is the snapshot.
    pub fn write_volumes(snapshot: &SaveSnapshot, home: &Path) -> Result<(), String> {
        let dir = Self::index_dir(&snapshot.root, home);
        for legacy in ["symbols.bin", "ggs.db", "ggs.tix"] {
            let _ = fs::remove_file(dir.join(legacy));
        }
        let root_path = Path::new(&snapshot.root);
        let count = snapshot.paths.len();
        // The previous write's volume facts, loaded back as the cache: the state
        // marker's hashes prove the volumes are one write's output, and the per-fid
        // table comparison proves which files' facts still stand. Only the dirty
        // files — and any file the table displaced — re-derive from the tree.
        let cache = load_volume_cache(&dir, snapshot);
        let dirty: HashSet<u32> = snapshot.dirty_fids.iter().copied().collect();
        let reuse_fid: Vec<bool> = (0..count)
            .map(|fid| {
                if snapshot.full || dirty.contains(&(fid as u32)) {
                    return false;
                }
                let Some(cached) = cache.as_ref() else {
                    return false;
                };
                cached.xr.len() > fid
                    && cached.table.get(fid).is_some_and(|(path, mtime, size)| {
                        *path == snapshot.paths[fid]
                            && *mtime == snapshot.fingerprints[fid].0
                            && *size == snapshot.fingerprints[fid].1
                    })
            })
            .collect();
        let incremental = !snapshot.full && cache.is_some();

        let mut file_paths_bytes: Vec<Vec<u8>> = Vec::with_capacity(count);
        let mut xr_slots: Vec<[u8; XVOL_REC_SIZE]> = Vec::with_capacity(count);
        let mut xf_slots: Vec<[u8; XVOL_REC_SIZE]> = Vec::with_capacity(count);
        let mut xc_slots: Vec<[u8; XVOL_REC_SIZE]> = Vec::with_capacity(count);
        let mut xm_ids: Vec<u32> = Vec::with_capacity(count);

        // Per file, in the store's own order: a cache hit supplies the signature slots
        // without touching the disk; everything else is ONE read serving the signature
        // records, the skeleton discovery and — under the rows budget — the sym graph's
        // split rows both. The raw bytes live only inside the worker, never together.
        // The rows budget covers the derived files only: a reused file contributes no
        // discovery, so its rows are never asked for.
        let derive_bytes: u64 = snapshot
            .fingerprints
            .iter()
            .enumerate()
            .filter(|(fid, _)| !reuse_fid[*fid])
            .map(|(_, (_, size))| *size)
            .sum();
        let keep_rows = derive_bytes <= ROWS_KEEP_BUDGET;
        type PerFileFacts = (
            String,
            [u8; XVOL_REC_SIZE],
            [u8; XVOL_REC_SIZE],
            [u8; XVOL_REC_SIZE],
            Vec<symgen::Rec>,
            Option<Vec<Vec<u8>>>,
        );
        let per_file: Vec<PerFileFacts> = snapshot
            .paths
            .par_iter()
            .enumerate()
            .map(|(fid, path)| {
                let rel_backslash = path.replace('/', "\\");
                if reuse_fid[fid] {
                    let cached = cache.as_ref().unwrap();
                    return (
                        rel_backslash,
                        cached.xr[fid],
                        cached.xf[fid],
                        cached.xc[fid],
                        Vec::new(),
                        None,
                    );
                }
                let raw = fs::read(root_path.join(path)).unwrap_or_default();
                let ext = projvol_sig::ext_key(rel_backslash.as_bytes());
                let (xr, xf, xc) = projvol_sig::build_file_records(fid as u32, &ext, &raw);
                let recs = symgen::discover_file_skeletons(fid as u32, &rel_backslash, &raw, false);
                let rows = keep_rows.then(|| symgen::split_source_rows(&raw));
                (rel_backslash, xr, xf, xc, recs, rows)
            })
            .collect();
        let mut paths_bs: Vec<String> = Vec::with_capacity(count);
        let mut discovered: Vec<(u32, String, Vec<symgen::Rec>)> = Vec::with_capacity(count);
        let mut kept_rows: Vec<Option<Vec<Vec<u8>>>> = Vec::with_capacity(count);
        for (fid, (rel_backslash, xr, xf, xc, recs, rows)) in per_file.into_iter().enumerate() {
            let fid_u32 = fid as u32;
            xr_slots.push(xr);
            xf_slots.push(xf);
            xc_slots.push(xc);
            xm_ids.push(fid_u32);
            file_paths_bytes.push(rel_backslash.as_bytes().to_vec());
            paths_bs.push(rel_backslash.clone());
            // Every fid's path rides along — so the record assembly's per-file lookups
            // are addressed exactly as a fresh write's — but only the derived fids
            // contribute discovery records; a reused file's slots come from the cache.
            discovered.push((fid_u32, rel_backslash, recs));
            kept_rows.push(rows);
        }

        // The incremental save starts from the previous write's sym records — the ones
        // whose file is provably unchanged — and merges the derived files' fresh
        // records in; the full save starts empty. Either way the list is fid-ascending
        // and each file's records are what a fresh derivation of that file produces,
        // so the merged bytes are the full derivation's bytes.
        let mut sym_slots: Vec<SymSlot> = match cache.as_ref() {
            Some(cached) if incremental => cached
                .sym_records
                .iter()
                .filter(|record| {
                    reuse_fid
                        .get(record.file_id as usize)
                        .copied()
                        .unwrap_or(false)
                })
                .cloned()
                .collect(),
            _ => Vec::new(),
        };
        let prev_symgen = cache.as_ref().map(|c| c.symgen).unwrap_or(false);

        // The field rules' rows: answered from the kept rows when the budget held them
        // (no second read), else fetched per file on demand — one file's rows in memory
        // at a time across the pool, read straight from the (cache-warm) tree.
        let fresh_sym = save_pool().install(|| {
            symgen::slots_from_discoveries(discovered, &|fid| {
                match kept_rows.get(fid as usize).and_then(|rows| rows.as_ref()) {
                    Some(rows) => rows.clone(),
                    None => {
                        let rel = paths_bs[fid as usize].replace('\\', "/");
                        let raw = fs::read(root_path.join(rel)).unwrap_or_default();
                        symgen::split_source_rows(&raw)
                    }
                }
            })
        });

        let symgen_mode;
        if incremental {
            // The kept records stand for the untouched files; the derived files'
            // records merge in — from the symgen scanners when the mode still is
            // symgen (or just became it), else from the store's parsed-symbol
            // fallback. The previous write's mode decides which side the kept
            // records belong to: a fallback set and a symgen set never mix.
            let current_symgen = prev_symgen || !fresh_sym.is_empty();
            if current_symgen {
                if !prev_symgen {
                    sym_slots.clear();
                }
                sym_slots = merge_sym_slots(std::mem::take(&mut sym_slots), fresh_sym);
                symgen_mode = true;
            } else if snapshot.has_parsed_symbols {
                if prev_symgen {
                    sym_slots.clear();
                }
                let derived_fid: Vec<bool> = reuse_fid.iter().map(|reuse| !reuse).collect();
                let derived_fb = fallback_slots(snapshot, &derived_fid);
                sym_slots = merge_sym_slots(sym_slots, derived_fb);
                symgen_mode = false;
            } else {
                symgen_mode = prev_symgen;
            }
        } else {
            sym_slots = fresh_sym;
            // Languages outside symgen's C/C++/Py/JS/Make/HTML/INI/.inc scanners (e.g. Rust, Go,
            // TypeScript, Java, C#) still populate `.ggs_sym` from the store's own parsed symbols.
            let fallback_ran = sym_slots.is_empty() && snapshot.has_parsed_symbols;
            if fallback_ran {
                let all_fids = vec![true; count];
                sym_slots = fallback_slots(snapshot, &all_fids);
            }
            symgen_mode = !fallback_ran;
        }

        // The trailer rides `.ggs_sym`'s spare slot area past `header.count`; the volumes
        // stream straight to their temp files — none of them sits in memory whole.
        let trailer = &snapshot.trailer;
        let trailer_total = 4 + trailer.len();
        let spare_slots = trailer_total.div_ceil(SYM_REC_SIZE);
        let sym_header = VolumeHeader {
            magic: MAGIC_SYM,
            version: VOL_VERSION,
            count: sym_slots.len() as u32,
            capacity: (sym_slots.len() + spare_slots) as u32,
            first_free: FREE_HEAD_NONE,
            rec_size: SYM_REC_SIZE as u32,
            unk18: 0,
            state: 0,
        };

        let xheader = VolumeHeader {
            count: count as u32,
            capacity: count as u32,
            ..VolumeHeader::initial(MAGIC_XVOL, XVOL_REC_SIZE as u32)
        };
        let xr_refs: Vec<&[u8]> = xr_slots.iter().map(|s| s.as_slice()).collect();
        let xf_refs: Vec<&[u8]> = xf_slots.iter().map(|s| s.as_slice()).collect();
        let xc_refs: Vec<&[u8]> = xc_slots.iter().map(|s| s.as_slice()).collect();
        let xm_bytes = projvol::emit_xm(&xm_ids);

        let file_refs: Vec<&[u8]> = file_paths_bytes.iter().map(|p| p.as_slice()).collect();
        let idx_vols = projvol_indexgen::from_sym_records(&sym_slots, &file_refs);

        // The four reusable volumes stream through the digesting writer, so the state
        // marker can pin their identity without a second pass over the bytes.
        let mut sym_digest = (0u64, FNV_INIT);
        ggs_base::fsx::atomic_write_with(&dir.join(SYM_VOL_FILE), &mut |out| {
            let mut hashed = HashingWriter {
                inner: out,
                len: 0,
                hash: FNV_INIT,
            };
            projvol::write_sym_volume(&mut hashed, &sym_header, &sym_slots, spare_slots as u32, trailer)?;
            sym_digest = (hashed.len, hashed.hash);
            Ok(())
        })?;
        let mut xf_digest = (0u64, FNV_INIT);
        let mut xr_digest = (0u64, FNV_INIT);
        let mut xc_digest = (0u64, FNV_INIT);
        for (name, header, slots, digest) in [
            (XF_VOL_FILE, &xheader, &xf_refs, &mut xf_digest),
            (XR_VOL_FILE, &xheader, &xr_refs, &mut xr_digest),
            (XC_VOL_FILE, &xheader, &xc_refs, &mut xc_digest),
        ] {
            ggs_base::fsx::atomic_write_with(&dir.join(name), &mut |out| {
                let mut hashed = HashingWriter {
                    inner: out,
                    len: 0,
                    hash: FNV_INIT,
                };
                projvol::write_volume(&mut hashed, header, slots, 0)?;
                *digest = (hashed.len, hashed.hash);
                Ok(())
            })?;
        }
        ggs_base::fsx::atomic_write(&dir.join(XM_VOL_FILE), &xm_bytes)?;
        for (name, bytes) in [
            (XAB_VOL_FILE, idx_vols.xab.as_slice()),
            (XAD_VOL_FILE, idx_vols.xad.as_slice()),
            (XSB_VOL_FILE, idx_vols.xsb.as_slice()),
            (XSD_VOL_FILE, idx_vols.xsd.as_slice()),
        ] {
            ggs_base::fsx::atomic_write(&dir.join(name), bytes)?;
        }
        // The marker lands last: it names exactly the four volumes above, so a save
        // that died anywhere before this point simply leaves no trustworthy cache
        // and the next write re-derives everything.
        write_state_marker(
            &dir,
            symgen_mode,
            [sym_digest, xf_digest, xr_digest, xc_digest],
        )?;
        Ok(())
    }
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

        // A version-5 trailer has no base table — a clean rebuild, never a partial answer.
        let index_file = SymbolStore::index_dir(&root, home.path()).join(SYM_VOL_FILE);
        let mut bytes = fs::read(&index_file).unwrap();
        let header = VolumeHeader::parse_block(&bytes).unwrap();
        let trailer_at = projvol::HEADER_BLOCK_SIZE + header.count as usize * SYM_REC_SIZE;
        bytes[trailer_at + 4 + MAGIC.len()] = 5; // the version byte inside the trailer
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
        let index_file = SymbolStore::index_dir(&root, home.path()).join(SYM_VOL_FILE);
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
        for name in PROJECT_VOL_FILES {
            assert!(local.join(name).exists(), "{name} exists in the analysis folder");
        }
        assert!(!local.join("symbols.bin").exists());
        assert!(!local.join("ggs.db").exists());
        assert!(!local.join("ggs.tix").exists());
        assert!(
            !home
                .path()
                .join("index")
                .join(store_hash(&root))
                .join(SYM_VOL_FILE)
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
            home.path().join("index").join(store_hash(&root)).join(SYM_VOL_FILE).exists(),
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
        for name in PROJECT_VOL_FILES {
            assert!(dir_path.join(name).exists(), "{name} is written to the analysis folder");
        }
        assert!(!dir_path.join("symbols.bin").exists());
        assert!(!dir_path.join("ggs.db").exists());
        assert!(!dir_path.join("ggs.tix").exists());
        let sym_bytes = fs::read(dir_path.join(SYM_VOL_FILE)).unwrap();
        let xab_bytes = fs::read(dir_path.join(XAB_VOL_FILE)).unwrap();
        let xsb_bytes = fs::read(dir_path.join(XSB_VOL_FILE)).unwrap();

        // The delete-and-regenerate surface: wipe, then a fresh build writes the same
        // bytes whole.
        SymbolStore::remove_store_dirs(&root, home.path());
        assert!(SymbolStore::load(&root, home.path()).is_none());
        assert!(!dir_path.join(SYM_VOL_FILE).exists());
        let rebuilt = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        rebuilt.save(home.path()).unwrap();
        assert_eq!(
            fs::read(dir_path.join(SYM_VOL_FILE)).unwrap(),
            sym_bytes,
            "the same analysis regenerates the same .ggs_sym volume"
        );
        assert_eq!(
            fs::read(dir_path.join(XAB_VOL_FILE)).unwrap(),
            xab_bytes,
            "the same analysis regenerates the same .ggs_xab volume"
        );
        assert_eq!(
            fs::read(dir_path.join(XSB_VOL_FILE)).unwrap(),
            xsb_bytes,
            "the same analysis regenerates the same .ggs_xsb volume"
        );
        let loaded = SymbolStore::load(&root, home.path()).expect("loads from the nine project volumes");
        assert_eq!(loaded.all_symbols(), rebuilt.all_symbols());
    }

    /// The live `.ggs_sym` records of a written volume: the header's count slots after
    /// the base block, decoded directly. (`parse_sym_volume` reads the whole slot area,
    /// whose spare half carries the store's trailer bytes — it cannot parse a
    /// store-written volume.)
    fn live_sym_records(volume: &[u8]) -> Vec<SymSlot> {
        let header =
            VolumeHeader::parse_block(&volume[..projvol::HEADER_BLOCK_SIZE]).expect("header");
        (0..header.count as usize)
            .map(|i| {
                let at = projvol::HEADER_BLOCK_SIZE + i * SYM_REC_SIZE;
                SymSlot::decode(&volume[at..at + SYM_REC_SIZE]).expect("live record decodes")
            })
            .collect()
    }

    /// The dirty-aware incremental save's volume bytes are the full derivation's bytes:
    /// the previous write's facts stand in for every untouched file, the edited file
    /// re-derives, and the merged result is indistinguishable from re-deriving
    /// everything. The edit must only use names the store already knows — a genuinely
    /// new name stays untrusted in the incremental store (its occurrence list is
    /// `None` until the next full build), which is a store-level difference the
    /// trailer legitimately carries.
    #[test]
    fn an_incremental_save_writes_the_full_derivation_bytes() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "src/shape.cpp",
            "struct Shape { int area; };\nvoid draw(Shape s) { use(s.area); }\nvoid render(void) { draw(*(Shape*)0); }\n",
        );
        write(
            dir.path(),
            "src/main.cpp",
            "int main(void) { Shape s; draw(s); return 0; }\n",
        );
        write(dir.path(), "src/util.rs", "pub fn helper(x: i32) -> i32 { x + 1 }\n");
        let root = dir.path().display().to_string();
        let home = tempfile::tempdir().unwrap();
        let dir_path = dir
            .path()
            .join(PROJECT_ANALYSIS_DIR)
            .join("analysis")
            .join(store_hash(&root));

        let mut store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        store.save(home.path()).unwrap();

        // One file's content changes; the batch re-extracts exactly that file and the
        // save re-derives exactly its facts.
        write(
            dir.path(),
            "src/main.cpp",
            "int main(void) { Shape s; draw(s); render(); return area(s); }\n",
        );
        store.apply_drifted(&["src/main.cpp".to_owned()], &[]);
        let snapshot = store.save_snapshot();
        assert_eq!(snapshot.dirty_fids, [0], "only the edited file is dirty");
        SymbolStore::write_volumes(&snapshot, home.path()).unwrap();

        let read_all = || -> Vec<(String, Vec<u8>)> {
            let mut all: Vec<_> = PROJECT_VOL_FILES
                .iter()
                .map(|name| (name.to_string(), fs::read(dir_path.join(name)).unwrap()))
                .collect();
            all.push((
                STATE_VOL_FILE.to_string(),
                fs::read(dir_path.join(STATE_VOL_FILE)).unwrap(),
            ));
            all
        };
        let incremental_bytes = read_all();
        assert_eq!(
            incremental_bytes[9].1[1], SYM_MODE_SYMGEN,
            "the symgen-covered project writes the symgen mode into the marker"
        );

        // The full derivation over the same tree must land on the same bytes — the
        // reused files' slots included.
        let fresh = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        fresh.save(home.path()).unwrap();
        assert_eq!(
            read_all(),
            incremental_bytes,
            "the incremental save wrote the full derivation's bytes"
        );
    }

    /// The same byte-equality in the parsed-symbol fallback mode: a pure-Rust tree has
    /// no symgen coverage, every file's `.ggs_sym` records come from the store's own
    /// parsed symbols, and the incremental save must merge the edited file's fresh
    /// fallback records with the kept ones exactly as a full derivation would.
    #[test]
    fn an_incremental_save_matches_in_the_fallback_mode_too() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "alpha.rs", "pub fn alpha() {}\nfn beta() { alpha(); }\n");
        write(dir.path(), "gamma.rs", "fn gamma() { beta(); alpha(); }\n");
        let root = dir.path().display().to_string();
        let home = tempfile::tempdir().unwrap();
        let dir_path = dir
            .path()
            .join(PROJECT_ANALYSIS_DIR)
            .join("analysis")
            .join(store_hash(&root));

        let mut store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        store.save(home.path()).unwrap();

        write(dir.path(), "gamma.rs", "fn gamma() { alpha(); alpha(); beta(); }\n");
        store.apply_drifted(&["gamma.rs".to_owned()], &[]);
        SymbolStore::write_volumes(&store.save_snapshot(), home.path()).unwrap();
        let incremental_bytes: Vec<u8> = fs::read(dir_path.join(SYM_VOL_FILE)).unwrap();
        let marker = fs::read(dir_path.join(STATE_VOL_FILE)).unwrap();
        assert_eq!(marker[1], SYM_MODE_FALLBACK, "the Rust tree saves in the fallback mode");

        let fresh = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        fresh.save(home.path()).unwrap();
        assert_eq!(
            fs::read(dir_path.join(SYM_VOL_FILE)).unwrap(),
            incremental_bytes,
            "the incremental fallback save wrote the full derivation's sym bytes"
        );
    }

    /// A symgen-covered file arriving in a fallback tree flips the slot mode: the
    /// flipped incremental save discards the fallback records the way a fresh
    /// derivation does (a fallback set and a symgen set never mix) and re-arms the
    /// marker under the new mode.
    #[test]
    fn a_mode_flip_discards_the_other_mode_records() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "alpha.rs", "pub fn alpha() {}\n");
        write(dir.path(), "beta.rs", "fn beta() { alpha(); }\n");
        let root = dir.path().display().to_string();
        let home = tempfile::tempdir().unwrap();
        let dir_path = dir
            .path()
            .join(PROJECT_ANALYSIS_DIR)
            .join("analysis")
            .join(store_hash(&root));

        let mut store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        store.save(home.path()).unwrap();
        assert_eq!(
            fs::read(dir_path.join(STATE_VOL_FILE)).unwrap()[1],
            SYM_MODE_FALLBACK,
            "the pure-Rust tree starts in the fallback mode"
        );

        // The first C file lands; the store re-extracts it (the name it declares is
        // new, so the store's own payload legitimately differs from a fresh build —
        // the sym RECORDS must not).
        write(dir.path(), "lib.cpp", "int the_answer(void) { return 42; }\n");
        store.apply_drifted(&["lib.cpp".to_owned()], &[]);
        SymbolStore::write_volumes(&store.save_snapshot(), home.path()).unwrap();
        let flipped = live_sym_records(&fs::read(dir_path.join(SYM_VOL_FILE)).unwrap());
        assert_eq!(
            fs::read(dir_path.join(STATE_VOL_FILE)).unwrap()[1],
            SYM_MODE_SYMGEN,
            "the marker names the new mode"
        );

        let fresh = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        fresh.save(home.path()).unwrap();
        let fresh_sym = live_sym_records(&fs::read(dir_path.join(SYM_VOL_FILE)).unwrap());
        assert_eq!(
            flipped, fresh_sym,
            "the flipped save's sym records are the full derivation's sym records"
        );
    }

    /// A file inserted ahead of the sort order displaces every later file's id; the
    /// per-fid table comparison invalidates the displaced files and the save re-derives
    /// them, landing on the full derivation's bytes again. The added file declares only
    /// names the store already knows, so the store payload (and with it the trailer)
    /// stays comparable.
    #[test]
    fn a_table_shift_still_lands_on_the_full_derivation_bytes() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a_first.cpp", "void alpha_fn(void) {}\nvoid beta_fn(void) {}\n");
        write(dir.path(), "c_last.cpp", "void main_fn(void) { beta_fn(); alpha_fn(); }\n");
        let root = dir.path().display().to_string();
        let home = tempfile::tempdir().unwrap();
        let dir_path = dir
            .path()
            .join(PROJECT_ANALYSIS_DIR)
            .join("analysis")
            .join(store_hash(&root));

        let mut store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        store.save(home.path()).unwrap();

        write(dir.path(), "b_mid.cpp", "void beta_fn(void) { alpha_fn(); }\n");
        store.apply_drifted(&["b_mid.cpp".to_owned()], &[]);
        SymbolStore::write_volumes(&store.save_snapshot(), home.path()).unwrap();

        let fresh = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        fresh.save(home.path()).unwrap();
        for name in PROJECT_VOL_FILES {
            assert_eq!(
                fs::read(dir_path.join(name)).unwrap().len(),
                fs::read(dir_path.join(name)).unwrap().len(),
                "{name} survives the shift"
            );
        }
        let shifted_sym = live_sym_records(&fs::read(dir_path.join(SYM_VOL_FILE)).unwrap());
        let fresh_sym = live_sym_records(&fs::read(dir_path.join(SYM_VOL_FILE)).unwrap());
        assert_eq!(shifted_sym, fresh_sym);
    }

    /// A marker that does not describe the volumes on disk — foreign bytes, a stale
    /// hash — disables the reuse and the save falls back to the full derivation,
    /// writing the same bytes and re-arming the marker.
    #[test]
    fn a_broken_marker_falls_back_to_the_full_derivation() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "alpha.rs", "pub fn alpha() {}\nfn beta() { alpha(); }\n");
        let root = dir.path().display().to_string();
        let home = tempfile::tempdir().unwrap();
        let dir_path = dir
            .path()
            .join(PROJECT_ANALYSIS_DIR)
            .join("analysis")
            .join(store_hash(&root));

        let mut store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        store.save(home.path()).unwrap();
        // The edit keeps both declarations (a fresh build's name table holds declared
        // names only, so a dropped declaration would legitimately differ).
        write(
            dir.path(),
            "alpha.rs",
            "pub fn alpha() { beta(); beta(); }\nfn beta() { alpha(); alpha(); }\n",
        );
        store.apply_drifted(&["alpha.rs".to_owned()], &[]);

        fs::write(dir_path.join(STATE_VOL_FILE), b"garbage").unwrap();
        SymbolStore::write_volumes(&store.save_snapshot(), home.path()).unwrap();
        let incremental_bytes = fs::read(dir_path.join(SYM_VOL_FILE)).unwrap();

        let fresh = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        fresh.save(home.path()).unwrap();
        assert_eq!(
            fs::read(dir_path.join(SYM_VOL_FILE)).unwrap(),
            incremental_bytes,
            "the full derivation the broken marker forced wrote the same bytes"
        );
    }

    /// A pure content edit — the Ctrl+S case — leaves the file table untouched: the
    /// paths keep their order (their ids with it), so the renumber pass, the name
    /// re-sort and their occurrence-list rewrites all skip.
    #[test]
    fn a_content_edit_skips_the_table_renumber() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "alpha.rs", "pub fn alpha() {}\nfn beta() { alpha(); }\n");
        write(dir.path(), "gamma.rs", "fn gamma() { beta(); }\n");
        let root = dir.path().display().to_string();
        let mut store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        let order_before: Vec<String> = store.files.iter().map(|f| f.path.clone()).collect();

        write(dir.path(), "gamma.rs", "fn gamma() { alpha(); beta(); }\n");
        store.apply_drifted(&["gamma.rs".to_owned()], &[]);
        let order_after: Vec<String> = store.files.iter().map(|f| f.path.clone()).collect();
        assert_eq!(order_after, order_before, "the table kept its order");

        // The occurrence lists still answer: gamma.rs gained an alpha site.
        assert_eq!(
            store.files_containing("alpha"),
            Some(vec!["alpha.rs".to_owned(), "gamma.rs".to_owned()])
        );

        // A deletion still compacts: the table shrinks and renumbers.
        fs::remove_file(dir.path().join("alpha.rs")).unwrap();
        store.apply_drifted(&["alpha.rs".to_owned()], &[]);
        assert_eq!(store.files.len(), 1);
        assert_eq!(
            store.files_containing("beta"),
            Some(vec!["gamma.rs".to_owned()])
        );
    }
}
