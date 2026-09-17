//! The symbol store: the workspace's declarations and their occurrences in one compact,
//! little-endian binary per root (`~/.ggs/index/<hash>/symbols.bin`). Design:
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

use crate::cmd_fs::walk_files;
use crate::cmd_search::{is_symbol_source, WorkspaceSymbol};

/// The symbol kinds the outline extractor produces, as ids on disk. The order is the format:
/// a kind byte is an index into this table.
const KINDS: &[&str] = &["function", "method", "class", "struct", "interface", "enum", "module", "type"];

fn kind_id(kind: &str) -> u8 {
	KINDS.iter().position(|k| *k == kind).unwrap_or(0) as u8
}

fn kind_name(id: u8) -> &'static str {
	KINDS.get(id as usize).copied().unwrap_or(KINDS[0])
}

/// The format marker: a corrupt or foreign file is discarded, never fatal.
const MAGIC: &[u8; 6] = b"GGSIDX";
const VERSION: u8 = 1;
/// Full builds report progress every this many files; also the cancellation checkpoint.
pub const BUILD_BATCH: usize = 256;

#[derive(Clone, Debug, PartialEq)]
struct StoredSymbol {
	kind: u8,
	name_id: u32,
	line: u32,
}

/// One indexed file: its fingerprint and what it declares. `words` is the transpose of the
/// occurrence lists — the names this file contains — kept so an update can subtract the
/// file's contributions before rescanning it.
struct FileEntry {
	path: String,
	mtime_ms: u64,
	size: u64,
	symbols: Vec<StoredSymbol>,
	words: Vec<u32>,
}

/// A file's extraction, before the names are interned.
struct Extraction {
	path: String,
	mtime_ms: u64,
	size: u64,
	symbols: Vec<(u8, String, u32)>,
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
}

pub struct BuildStats {
	pub files: usize,
	pub symbols: usize,
	pub names: usize,
}

/// What one file on disk currently is: its fingerprint, or nothing when it is gone.
struct Stat {
	mtime_ms: u64,
	size: u64,
}

fn stat_of(path: &Path) -> Option<Stat> {
	let meta = fs::metadata(path).ok()?;
	let mtime_ms = meta.modified().ok()?.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
	Some(Stat { mtime_ms, size: meta.len() })
}

impl SymbolStore {
	/// The empty store for a root (nothing indexed yet).
	pub fn empty(root: &str) -> SymbolStore {
		SymbolStore { root: root.to_owned(), files: Vec::new(), names: Vec::new(), refs: Vec::new() }
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
		let mut all = Vec::new();
		for file in &self.files {
			for symbol in &file.symbols {
				all.push(WorkspaceSymbol {
					kind: kind_name(symbol.kind).to_owned(),
					name: self.names[symbol.name_id as usize].clone(),
					path: file.path.clone(),
					line: symbol.line as usize,
				});
			}
		}
		all
	}

	/// Every declaration of exactly `name` (same spelling, any case — the extractor records
	/// declarations as written, and Go-to-Definition wants all of them).
	pub fn lookup(&self, name: &str) -> Vec<WorkspaceSymbol> {
		self.all_symbols()
			.into_iter()
			.filter(|s| s.name == name)
			.collect()
	}

	/// How many files contain each trusted name: the Symbol Database page's "n refs" chips
	/// and the MCP server's `symbol_tree` read it (an untrusted name reports nothing, the
	/// same way its references fall back to a full scan).
	pub fn occurrence_counts(&self) -> std::collections::HashMap<&str, usize> {
		let mut counts = std::collections::HashMap::with_capacity(self.names.len());
		for (id, files) in self.refs.iter().enumerate() {
			if let Some(files) = files {
				counts.insert(self.names[id].as_str(), files.len());
			}
		}
		counts
	}

	/// The files whose text contains `name` as a word, or `None` when the occurrence list is
	/// absent or untrusted — the caller then scans everything, exactly like before.
	pub fn files_containing(&self, name: &str) -> Option<Vec<String>> {
		let id = self.names.binary_search_by(|n| n.as_str().cmp(name)).ok()?; // names stay sorted
		let files = self.refs.get(id)?.as_ref()?;
		Some(files.iter().map(|&file| self.files[file as usize].path.clone()).collect())
	}

	/* ---------- Building ---------- */

	/// The full build: extract every source file, intern the names, then one more pass to
	/// record which files contain which declared words. `report` receives (done, total) per
	/// batch; `cancelled` is honoured between batches. `threads` sizes a private rayon pool
	/// for the build (RustDesk's `codec_thread_num` lesson: a background build must not
	/// take every core from the interactive app), so the rest of the process's parallel
	/// work keeps its headroom.
	pub fn build(root: &str, threads: usize, report: &(dyn Fn(usize, usize) + Sync), cancelled: &(dyn Fn() -> bool + Sync)) -> Option<SymbolStore> {
		let pool = rayon::ThreadPoolBuilder::new()
			.num_threads(threads.max(1))
			.build()
			.ok()?;
		pool.install(|| Self::build_on(root, report, cancelled))
	}

	fn build_on(root: &str, report: &(dyn Fn(usize, usize) + Sync), cancelled: &(dyn Fn() -> bool + Sync)) -> Option<SymbolStore> {
		let paths: Vec<String> = walk_files(root).into_iter().filter(|p| is_symbol_source(p)).collect();
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

		// Phase 2: the name table, interned in sorted order so ids are binary-searchable.
		let mut interned: BTreeMap<String, u32> = BTreeMap::new();
		for file in &extracted {
			for (_, name, _) in &file.symbols {
				interned.entry(name.clone()).or_insert_with(|| 0);
			}
		}
		let names: Vec<String> = interned.keys().cloned().collect();
		for (id, name) in names.iter().enumerate() {
			interned.insert(name.clone(), id as u32);
		}
		let lookup: HashMap<&str, u32> = interned.iter().map(|(name, &id)| (name.as_str(), id)).collect();

		// Phase 3: occurrences. Every file is scanned once for the declared words it
		// contains; the per-file results transpose into the per-name lists below.
		let mut scanned: Vec<(String, Vec<u32>, Vec<StoredSymbol>)> = Vec::with_capacity(extracted.len());
		for batch in extracted.chunks(BUILD_BATCH) {
			if cancelled() {
				return None;
			}
			let mut part: Vec<(String, Vec<u32>, Vec<StoredSymbol>)> = batch
				.par_iter()
				.map(|file| {
					let words = match fs::read_to_string(Path::new(root).join(&file.path)) {
						Ok(text) => words_in(&text, &|word| lookup.get(word).copied()),
						Err(_) => Vec::new(),
					};
					let symbols = file
						.symbols
						.iter()
						.map(|&(kind, ref name, line)| StoredSymbol { kind, name_id: lookup[name.as_str()], line })
						.collect();
					(file.path.clone(), words, symbols)
				})
				.collect();
			scanned.append(&mut part);
		}

		let mut store = SymbolStore {
			root: root.to_owned(),
			files: scanned
				.iter()
				.map(|(path, _, _)| path.clone())
				.zip(extracted.iter().map(|f| (f.mtime_ms, f.size)))
				.map(|(path, (mtime_ms, size))| FileEntry { path, mtime_ms, size, symbols: Vec::new(), words: Vec::new() })
				.collect(),
			names,
			refs: Vec::new(),
		};
		// The walk is sorted and phase 1 sorted again; the zip above keeps that order.
		debug_assert!(store.files.windows(2).all(|w| w[0].path < w[1].path));
		for (i, (_, words, symbols)) in scanned.into_iter().enumerate() {
			store.files[i].words = words;
			store.files[i].symbols = symbols;
		}
		store.rebuild_refs();
		Some(store)
	}

	/* ---------- Incremental updates ---------- */

	/// Apply watcher changes (repo-relative paths): gone files are dropped, changed files
	/// re-extracted (a matching fingerprint skips the work), new files added. Names first
	/// seen here stay untrusted; every trusted name's occurrence list stays complete because
	/// each touched file's contributions are subtracted and rescanned.
	pub fn apply_changes(&mut self, paths: &[String]) {
		let wanted: HashSet<&str> = paths.iter().map(String::as_str).filter(|p| is_symbol_source(p)).collect();
		// Subtract and drop the entries whose file is gone or changed; the paths that still
		// exist are collected once, whether they were known before or arrived with the batch.
		// The store's fields are borrowed apart so the scan of `files` can subtract into
		// `refs` while it walks.
		let root = self.root.clone();
		let SymbolStore { files, refs, .. } = self;
		let mut keep: Vec<bool> = Vec::with_capacity(files.len());
		let mut to_extract: HashSet<String> = HashSet::new();
		for file in files.iter() {
			let touched = wanted.contains(file.path.as_str());
			let stat = stat_of(&Path::new(&root).join(&file.path));
			let unchanged = !touched && stat.as_ref().is_some_and(|s| s.mtime_ms == file.mtime_ms && s.size == file.size);
			if unchanged {
				keep.push(true);
				continue;
			}
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
		self.upsert(upserts);
		self.renumber_after_edits();
	}

	/// Remove `file`'s occurrence contributions from the name lists. An associated function
	/// with explicit field borrows: the caller scans `files` while subtracting into `refs`.
	fn subtract_contributions(refs: &mut [Option<Vec<u32>>], files: &[FileEntry], file: &FileEntry) {
		for &name in &file.words {
			if let Some(Some(list)) = refs.get_mut(name as usize) {
				list.retain(|&f| files[f as usize].path != file.path);
			}
		}
	}

	/// Bring a store loaded from disk back in line with the tree: files that appeared,
	/// changed or vanished since it was written are applied incrementally. Returns how many
	/// files needed work (0 means the store was already current).
	pub fn refresh_against_disk(&mut self, report: &(dyn Fn(usize, usize) + Sync), cancelled: &(dyn Fn() -> bool + Sync)) -> Result<usize, String> {
		let current: Vec<String> = walk_files(&self.root).into_iter().filter(|p| is_symbol_source(p)).collect();
		let known: HashSet<&str> = self.files.iter().map(|f| f.path.as_str()).collect();
		let mut touched: Vec<String> = current.iter().filter(|p| !known.contains(p.as_str())).cloned().collect();
		let total = current.len();
		let mut done = 0;
		for file in &self.files {
			if cancelled() {
				return Err("cancelled".to_owned());
			}
			let stat = stat_of(&Path::new(&self.root).join(&file.path));
			let gone_or_changed = stat.as_ref().is_none_or(|s| s.mtime_ms != file.mtime_ms || s.size != file.size);
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
			for (_, name, _) in &file.symbols {
				if self.names.binary_search_by(|n| n.as_str().cmp(name.as_str())).is_err() {
					fresh.insert(name.clone());
				}
			}
		}
		for name in &fresh {
			self.names.push(name.clone());
			self.refs.push(None); // untrusted until a full build
		}
		// The id map is built once the table is complete; sort_names fixes the order after.
		let mut lookup: HashMap<String, u32> = self.names.iter().enumerate().map(|(id, name)| (name.clone(), id as u32)).collect();
		lookup.shrink_to_fit();
		for file in upserts {
			let words = match fs::read_to_string(Path::new(&self.root).join(&file.path)) {
				Ok(text) => words_in(&text, &|word| lookup.get(word).copied()),
				Err(_) => Vec::new(),
			};
			let symbols = file
				.symbols
				.iter()
				.map(|&(kind, ref name, line)| StoredSymbol { kind, name_id: lookup[name.as_str()], line })
				.collect();
			let entry = FileEntry { path: file.path, mtime_ms: file.mtime_ms, size: file.size, symbols, words: words.clone() };
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
				std::mem::replace(&mut self.files[old_id as usize], FileEntry::empty_placeholder())
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

	/// Where this root's index lives under the GGS home (`~/.ggs/index/<hash>/`).
	pub fn index_dir(root: &str, home: &Path) -> PathBuf {
		use sha1::{Digest, Sha1};
		let mut hasher = Sha1::new();
		hasher.update(root.as_bytes());
		let hash = hex::encode(hasher.finalize());
		home.join("index").join(&hash[..16])
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
				out.extend_from_slice(&symbol.line.to_le_bytes());
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
		crate::atomic_write(&dir.join("symbols.bin"), &out)
	}

	/// Read the root's index back. `None` for anything absent or not exactly this format's
	/// shape — a corrupt file means "rebuild", never an error to surface.
	pub fn load(root: &str, home: &Path) -> Option<SymbolStore> {
		let bytes = fs::read(Self::index_dir(root, home).join("symbols.bin")).ok()?;
		let mut at = 0usize;
		take(&bytes, &mut at, MAGIC.len())?.iter().eq(MAGIC.iter()).then_some(())?;
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
				let line = take_u32(&bytes, &mut at)?;
				if name_id as usize >= names.len() {
					return None;
				}
				parsed.push(StoredSymbol { kind, name_id, line });
			}
			files.push(FileEntry { path, mtime_ms, size, symbols: parsed, words: Vec::new() });
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
		// The words transpose comes back from the occurrence lists.
		let mut store = SymbolStore { root, files, names, refs };
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
		FileEntry { path: String::new(), mtime_ms: 0, size: 0, symbols: Vec::new(), words: Vec::new() }
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
	let symbols = crate::viewer::outline_symbols_for(&text, ext)
		.into_iter()
		.map(|s| (kind_id(&s.kind), s.name, s.line as u32))
		.collect();
	Some(Extraction { path: relative.to_owned(), mtime_ms: stat.mtime_ms, size: stat.size, symbols })
}

/// Which of the interned names occur as words in `text`, as a sorted, deduplicated id list.
/// The scan is a plain character walk — no allocation per word, only per hit.
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
		write(dir.path(), "src/lib.rs", "pub fn alpha() {}\nfn beta() { alpha(); }\n");
		write(dir.path(), "src/other.rs", "fn gamma() { beta(); alpha(); }\n");
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
		assert_eq!((alpha[0].path.as_str(), alpha[0].line, alpha[0].kind.as_str()), ("src/lib.rs", 0, "function"));

		// Occurrences: alpha is used in both files, beta in both, gamma nowhere else.
		assert_eq!(store.files_containing("alpha"), Some(vec!["src/lib.rs".to_owned(), "src/other.rs".to_owned()]));
		assert_eq!(store.files_containing("beta"), Some(vec!["src/lib.rs".to_owned(), "src/other.rs".to_owned()]));
		assert_eq!(store.files_containing("gamma"), Some(vec!["src/other.rs".to_owned()]));
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
		assert_eq!(loaded.files_containing("alpha"), store.files_containing("alpha"));

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
		assert_eq!(store.files_containing("alpha"), Some(vec!["a.rs".to_owned(), "b.rs".to_owned()]));

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
		assert_eq!(store.files_containing("alpha"), Some(vec!["a.rs".to_owned()]));
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
			Some(vec!["a.rs".to_owned(), "b.rs".to_owned(), "c.rs".to_owned()])
		);

		fs::remove_file(dir.path().join("b.rs")).unwrap();
		store.apply_changes(&["b.rs".to_owned()]);
		assert_eq!(store.files_containing("alpha"), Some(vec!["a.rs".to_owned(), "c.rs".to_owned()]));
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
		assert_eq!((store.stats().files, store.stats().symbols), (before.files, before.symbols));
		assert_eq!(store.lookup("alpha").len(), 1);
	}

	#[test]
	fn refresh_against_disk_reports_and_repairs() {
		let dir = tempfile::tempdir().unwrap();
		write(dir.path(), "a.rs", "fn alpha() {}\n");
		let root = dir.path().display().to_string();
		let mut store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
		assert_eq!(store.refresh_against_disk(&|_, _| {}, &|| false).unwrap(), 0);

		write(dir.path(), "b.rs", "fn beta() { alpha(); }\n");
		write(dir.path(), "a.rs", "fn alpha2() {}\n");
		assert_eq!(store.refresh_against_disk(&|_, _| {}, &|| false).unwrap(), 2);
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
		assert_eq!(store.names, sorted, "the name table stays sorted after an update");
		// "alfa" arrived with the incremental update, so its occurrence list is untrusted
		// (references fall back to a full scan); the full build's names keep theirs.
		assert_eq!(store.files_containing("alfa"), None);
		assert_eq!(store.lookup("alfa").len(), 1);
		for name in ["yankee", "zulu"] {
			assert!(store.files_containing(name).is_some(), "{name} is findable");
		}
	}
}
