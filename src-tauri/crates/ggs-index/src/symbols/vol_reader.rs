//! Native 9-volume reader and query engine (Area 5): unlocks the on-disk
//! `project.ggs_*` volumes for runtime queries instead of leaving them write-only.
//!
//! Capabilities:
//! - **Bloom signature prefiltering** (`.ggs_xc`, `.ggs_xr`, `.ggs_xf`): O(files) bit-pair
//!   testing using [`projvol_sig::sig_pair`] to prune candidate files before touching
//!   source files on disk. `.ggs_xc` strips comments, strings, and `#if` directives so
//!   `Find References` / `refsTo` skips files that only mention a symbol in prose.
//!   `.ggs_xf` indexes camel/snake word parts (length >= 3) for fuzzy sub-word file
//!   prefiltering.
//! - **Paged B-tree prefix search** (`.ggs_xab`/`.ggs_xad` and `.ggs_xsb`/`.ggs_xsd`):
//!   binary-searches the 40-byte page directory and reads only the matching 4 KiB leaf
//!   pages from disk, returning matching `project.ggs_sym` slot indices without scanning
//!   every symbol.
//! - **Structured `SymSlot` metric extraction** (`project.ggs_sym` live prefix): decodes
//!   `raw108` (effective body lines, goto count, control-flow complexity) and `name_tag`
//!   (language id + parameter count) directly from the 180-byte symbol records.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::symbols::projvol::{
    self, IndexRecord, SymSlot, VolumeHeader, XdirVolume, HEADER_BLOCK_SIZE, INDEX_PAGE_SIZE,
    INDEX_RECS_PER_PAGE, INDEX_REC_SIZE, MAGIC_SYM, MAGIC_XVOL, SYM_REC_SIZE, XVOL_REC_SIZE,
};
use crate::symbols::projvol_indexgen::fold;
use crate::symbols::projvol_sig::{sig_pair, SIG_HALF_A_AT, SIG_HALF_B_AT};
use crate::symbols::store::{
    PROJECT_VOL_FILES, SYM_VOL_FILE, XAB_VOL_FILE, XAD_VOL_FILE, XC_VOL_FILE, XF_VOL_FILE,
    XM_VOL_FILE, XR_VOL_FILE, XSB_VOL_FILE, XSD_VOL_FILE,
};

/// Decoded complexity & signature metrics carried natively in a `project.ggs_sym`
/// 180-byte `SymSlot` (`raw108` + `name_tag`).
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SymSlotMetrics {
    /// Effective non-blank, non-preprocessor body lines (`raw108 >> 16`).
    pub effective_lines: u32,
    /// Weighted control-flow count (`if`/`for`/`while`/`do`/`case`/`default`, `raw108 & 0xFF`).
    pub control_flow: u32,
    /// Whole-word `goto` count (`((raw108 >> 8) & 0xFF) / 4`).
    pub goto_count: u32,
    /// Language id (`name_tag >> 8`).
    pub lang_id: u32,
    /// Parameter count (`name_tag & 0xFF`; 255 denotes C varargs `...`).
    pub param_count: u32,
}

impl SymSlotMetrics {
    pub fn from_slot(slot: &SymSlot) -> Self {
        Self {
            effective_lines: slot.raw108 >> 16,
            control_flow: slot.raw108 & 0xFF,
            goto_count: ((slot.raw108 >> 8) & 0xFF) / 4,
            lang_id: slot.name_tag >> 8,
            param_count: slot.name_tag & 0xFF,
        }
    }
}

/// Summary of the 9 `project.ggs_*` volume files on disk for a root.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VolumeStats {
    pub present: bool,
    pub total_bytes: u64,
    pub sym_records: u32,
    pub sig_files: u32,
    pub xab_pages: u32,
    pub xsb_pages: u32,
    pub xm_entries: u32,
}

/// Test whether a 2024-byte x-volume record has both bits of `pair` set.
#[inline]
fn sig_matches_pair(rec: &[u8], pair: u32) -> bool {
    if rec.len() < XVOL_REC_SIZE {
        return false;
    }
    let lo = (pair & 0xFFFF) as usize;
    let hi = (pair >> 16) as usize;
    let bit_a = (rec[SIG_HALF_A_AT + (lo >> 3)] & (1u8 << (lo & 7))) != 0;
    let bit_b = (rec[SIG_HALF_B_AT + (hi >> 3)] & (1u8 << (hi & 7))) != 0;
    bit_a && bit_b
}

/// Parse an x-volume (`project.ggs_xc` / `.ggs_xr` / `.ggs_xf`) into `(file_id, record_bytes)`
/// slices without copying the 2004-byte bitfields.
fn xvol_records(bytes: &[u8]) -> Option<Vec<(u32, &[u8])>> {
    let header = VolumeHeader::parse_block(bytes.get(..HEADER_BLOCK_SIZE)?)?;
    if header.magic != MAGIC_XVOL || header.rec_size as usize != XVOL_REC_SIZE {
        return None;
    }
    let count = header.count as usize;
    let body = bytes.get(HEADER_BLOCK_SIZE..)?;
    if body.len() < count.checked_mul(XVOL_REC_SIZE)? {
        return None;
    }
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let rec = &body[i * XVOL_REC_SIZE..(i + 1) * XVOL_REC_SIZE];
        if !projvol::slot_is_live(rec) {
            continue;
        }
        let fid = u32::from_le_bytes(rec[8..12].try_into().ok()?);
        out.push((fid, rec));
    }
    Some(out)
}

/// On-demand Bloom signature prefilter backed by `.ggs_xc` (code-only), `.ggs_xr` (full
/// text), and `.ggs_xf` (word parts >= 3).
pub struct VolumeSigReader {
    dir: PathBuf,
}

impl VolumeSigReader {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Return the subset of `files` (indexed by `file_id`) whose `.ggs_xc` code-only
    /// Bloom signature matches `word`. Returns `None` if `.ggs_xc` is missing/corrupt or
    /// `word` cannot be hashed by `sig_pair` (e.g. 1-char name or non-ASCII), signaling
    /// callers to fall back to the unfiltered list.
    pub fn filter_files_xc(&self, word: &str, files: &[String]) -> Option<Vec<String>> {
        self.filter_volume(XC_VOL_FILE, word, files)
    }

    /// Return the subset of `files` whose `.ggs_xr` full-text Bloom signature matches `word`.
    pub fn filter_files_xr(&self, word: &str, files: &[String]) -> Option<Vec<String>> {
        self.filter_volume(XR_VOL_FILE, word, files)
    }

    /// Return the subset of `files` whose `.ggs_xf` camel/snake word-part signature
    /// matches `part` (must be >= 3 ASCII word chars).
    pub fn filter_files_xf(&self, part: &str, files: &[String]) -> Option<Vec<String>> {
        if part.len() < 3 {
            return None;
        }
        self.filter_volume(XF_VOL_FILE, part, files)
    }

    fn filter_volume(&self, filename: &str, token: &str, files: &[String]) -> Option<Vec<String>> {
        let pair = sig_pair(token.as_bytes())?;
        let bytes = fs::read(self.dir.join(filename)).ok()?;
        let records = xvol_records(&bytes)?;
        // Reject stale signature volumes whose file count no longer matches the live store.
        if records.len() != files.len() {
            return None;
        }
        let tables = super::projvol_sig::builtin_tables();
        let is_xc = filename == XC_VOL_FILE;
        let token_bytes = token.as_bytes();
        let mut hits = Vec::new();
        for (fid, rec) in records {
            if let Some(path) = files.get(fid as usize) {
                // Stop-words omitted by `build_xc_record` / `build_xr_record` never set
                // bits in this file's bloom signature; conservatively keep the file so
                // Find References never drops valid hits for identifiers like `print`/`get`.
                let ext = super::projvol_sig::ext_key(path.as_bytes());
                let excluded = if is_xc {
                    tables.xc(&ext).contains(token_bytes)
                } else {
                    tables.xr_xf(&ext).contains(token_bytes)
                };
                if excluded || sig_matches_pair(rec, pair) {
                    hits.push(path.clone());
                }
            }
        }
        hits.sort();
        hits.dedup();
        Some(hits)
    }
}

/// Reusable in-memory `.ggs_xc` Bloom signature cache for a single multi-peek relation
/// query: reads `project.ggs_xc` from disk once so `refs_to`, `refs_by_files`, and all
/// `has_refs_to_children` peeks share the loaded bitfield without repeated disk reads.
pub struct XcBloomCache {
    bytes: Vec<u8>,
    file_count: usize,
}

impl XcBloomCache {
    /// Load `project.ggs_xc` if present, valid, and matching `expected_files`.
    pub fn load(dir: &Path, expected_files: usize) -> Option<Self> {
        let bytes = fs::read(dir.join(XC_VOL_FILE)).ok()?;
        let records = xvol_records(&bytes)?;
        if records.len() != expected_files {
            return None;
        }
        Some(Self {
            bytes,
            file_count: expected_files,
        })
    }

    /// Filter `files` (indexed by `file_id`) to those whose `.ggs_xc` code-only Bloom
    /// signature matches `word` (conservatively keeping files where `word` is an `.ggs_xc`
    /// stop-word for that file's extension). Returns `None` if `word` cannot be hashed.
    pub fn filter_files(&self, word: &str, files: &[String]) -> Option<Vec<String>> {
        if files.len() != self.file_count {
            return None;
        }
        let pair = sig_pair(word.as_bytes())?;
        let records = xvol_records(&self.bytes)?;
        let tables = super::projvol_sig::builtin_tables();
        let token_bytes = word.as_bytes();
        let mut hits = Vec::new();
        for (fid, rec) in records {
            if let Some(path) = files.get(fid as usize) {
                let ext = super::projvol_sig::ext_key(path.as_bytes());
                let excluded = tables.xc(&ext).contains(token_bytes);
                if excluded || sig_matches_pair(rec, pair) {
                    hits.push(path.clone());
                }
            }
        }
        hits.sort();
        hits.dedup();
        Some(hits)
    }
}

/// Look up a single symbol's native `SymSlotMetrics` directly from `project.ggs_sym`
/// without allocating a map for the entire workspace.
pub fn read_single_sym_slot_metrics(
    dir: &Path,
    file_id: u32,
    line0: u32,
    name: &str,
) -> Option<SymSlotMetrics> {
    let bytes = fs::read(dir.join(SYM_VOL_FILE)).ok()?;
    let header = VolumeHeader::parse_block(bytes.get(..HEADER_BLOCK_SIZE)?)?;
    if header.magic != MAGIC_SYM || header.rec_size as usize != SYM_REC_SIZE {
        return None;
    }
    let count = header.count as usize;
    let body = bytes.get(HEADER_BLOCK_SIZE..)?;
    if body.len() < count.checked_mul(SYM_REC_SIZE)? {
        return None;
    }
    let name_bytes = name.as_bytes();
    let mut fallback: Option<SymSlotMetrics> = None;
    for i in 0..count {
        let slot_bytes = &body[i * SYM_REC_SIZE..(i + 1) * SYM_REC_SIZE];
        let Some(slot) = SymSlot::decode(slot_bytes) else {
            continue;
        };
        if slot.file_id != file_id || slot.name.as_slice() != name_bytes {
            continue;
        }
        if slot.raw108 == 0 && slot.name_tag == 0 {
            continue;
        }
        let metrics = SymSlotMetrics::from_slot(&slot);
        if slot.line0 == line0 {
            return Some(metrics);
        }
        if fallback.is_none() {
            fallback = Some(metrics);
        }
    }
    fallback
}

/// Compare a 4-byte folded key lexicographically against a folded prefix (length <= 4).
fn cmp_key_to_prefix(key: &[u8; 4], prefix_folded: &[u8]) -> std::cmp::Ordering {
    let n = prefix_folded.len().min(4);
    for i in 0..n {
        let kb = key[i] | 0x20;
        let pb = prefix_folded[i];
        if kb != pb {
            return kb.cmp(&pb);
        }
    }
    std::cmp::Ordering::Equal
}

/// Paged B-tree reader over `.ggs_xab`/`.ggs_xad` (camel word-part index) and
/// `.ggs_xsb`/`.ggs_xsd` (symbol-name index). Reads only the 4 KiB leaf pages whose
/// key range overlaps the requested prefix.
pub struct PagedIndexReader {
    dir: PathBuf,
}

impl PagedIndexReader {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Look up symbol slot indices in `.ggs_xab` matching a camel/snake word prefix.
    pub fn search_xab_prefix(&self, prefix: &str, limit: usize) -> Option<Vec<u16>> {
        self.search_paged(XAB_VOL_FILE, XAD_VOL_FILE, prefix, limit)
    }

    /// Look up symbol slot indices in `.ggs_xsb` matching a symbol/container prefix.
    pub fn search_xsb_prefix(&self, prefix: &str, limit: usize) -> Option<Vec<u16>> {
        self.search_paged(XSB_VOL_FILE, XSD_VOL_FILE, prefix, limit)
    }

    fn search_paged(
        &self,
        vol_name: &str,
        dir_name: &str,
        prefix: &str,
        limit: usize,
    ) -> Option<Vec<u16>> {
        if prefix.is_empty() || limit == 0 {
            return Some(Vec::new());
        }
        let dir_bytes = fs::read(self.dir.join(dir_name)).ok()?;
        let xdir = XdirVolume::parse(&dir_bytes)?;
        if xdir.entries.is_empty() {
            return Some(Vec::new());
        }
        let pref = fold(&prefix.as_bytes()[..prefix.len().min(4)]);
        // Binary search for the first page whose anchor key >= prefix (minus 1 because
        // matching keys may start inside the preceding page).
        let first_ge = xdir
            .entries
            .partition_point(|e| cmp_key_to_prefix(&e.record.key, &pref) == std::cmp::Ordering::Less);
        let start_page = first_ge.saturating_sub(1);

        let mut file = File::open(self.dir.join(vol_name)).ok()?;
        let mut page_buf = [0u8; INDEX_PAGE_SIZE];
        let mut slots = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for entry in &xdir.entries[start_page..] {
            // Stop as soon as a page's anchor is strictly greater than our prefix.
            if cmp_key_to_prefix(&entry.record.key, &pref) == std::cmp::Ordering::Greater {
                break;
            }
            file.seek(SeekFrom::Start(entry.file_offset as u64)).ok()?;
            file.read_exact(&mut page_buf).ok()?;
            let valid = (entry.bucket as usize).min(INDEX_RECS_PER_PAGE);
            for j in 0..valid {
                let rec = IndexRecord::decode(&page_buf[j * INDEX_REC_SIZE..(j + 1) * INDEX_REC_SIZE])?;
                let ord = cmp_key_to_prefix(&rec.key, &pref);
                if ord == std::cmp::Ordering::Greater {
                    return Some(slots);
                }
                if ord == std::cmp::Ordering::Equal && seen.insert(rec.slot) {
                    slots.push(rec.slot);
                    if slots.len() >= limit {
                        return Some(slots);
                    }
                }
            }
        }
        Some(slots)
    }
}

/// Read the live prefix of `project.ggs_sym` (slots `0..header.count`, stopping before
/// the trailer area) and build a lookup map `(file_id, line0, name) -> SymSlotMetrics`.
pub fn read_sym_slot_metrics(dir: &Path) -> Option<HashMap<(u32, u32, String), SymSlotMetrics>> {
    let bytes = fs::read(dir.join(SYM_VOL_FILE)).ok()?;
    let header = VolumeHeader::parse_block(bytes.get(..HEADER_BLOCK_SIZE)?)?;
    if header.magic != MAGIC_SYM || header.rec_size as usize != SYM_REC_SIZE {
        return None;
    }
    let count = header.count as usize;
    let body = bytes.get(HEADER_BLOCK_SIZE..)?;
    if body.len() < count.checked_mul(SYM_REC_SIZE)? {
        return None;
    }
    let mut map = HashMap::with_capacity(count);
    for i in 0..count {
        let slot_bytes = &body[i * SYM_REC_SIZE..(i + 1) * SYM_REC_SIZE];
        let Some(slot) = SymSlot::decode(slot_bytes) else {
            continue;
        };
        if slot.raw108 == 0 && slot.name_tag == 0 {
            continue;
        }
        let name = String::from_utf8_lossy(&slot.name).into_owned();
        map.insert((slot.file_id, slot.line0, name), SymSlotMetrics::from_slot(&slot));
    }
    Some(map)
}

/// Inspect the 9 `project.ggs_*` volume files on disk for diagnostics and status reporting.
pub fn inspect_volume_stats(dir: &Path) -> VolumeStats {
    if !PROJECT_VOL_FILES.iter().all(|name| dir.join(name).is_file()) {
        return VolumeStats::default();
    }
    let mut total_bytes = 0u64;
    for name in PROJECT_VOL_FILES {
        if let Ok(meta) = fs::metadata(dir.join(name)) {
            total_bytes += meta.len();
        }
    }
    let read_header_count = |file: &str| -> u32 {
        let mut f = match File::open(dir.join(file)) {
            Ok(f) => f,
            Err(_) => return 0,
        };
        let mut hdr = [0u8; HEADER_BLOCK_SIZE];
        if f.read_exact(&mut hdr).is_err() {
            return 0;
        }
        VolumeHeader::parse_block(&hdr).map(|h| h.count).unwrap_or(0)
    };
    let sym_records = read_header_count(SYM_VOL_FILE);
    let sig_files = read_header_count(XC_VOL_FILE);
    let xab_pages = fs::read(dir.join(XAD_VOL_FILE))
        .ok()
        .and_then(|b| XdirVolume::parse(&b))
        .map(|d| d.pages_used)
        .unwrap_or(0);
    let xsb_pages = fs::read(dir.join(XSD_VOL_FILE))
        .ok()
        .and_then(|b| XdirVolume::parse(&b))
        .map(|d| d.pages_used)
        .unwrap_or(0);
    let xm_entries = fs::read(dir.join(XM_VOL_FILE))
        .ok()
        .and_then(|b| projvol::parse_xm(&b))
        .map(|v| v.len() as u32)
        .unwrap_or(0);
    VolumeStats {
        present: true,
        total_bytes,
        sym_records,
        sig_files,
        xab_pages,
        xsb_pages,
        xm_entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::symbols::store::SymbolStore;

    fn write(root: &Path, path: &str, text: &str) {
        let file = root.join(path);
        fs::create_dir_all(file.parent().unwrap_or(root)).unwrap();
        fs::write(file, text).unwrap();
    }

    #[test]
    fn xc_prefilter_excludes_comment_only_files_and_xf_matches_word_parts() {
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "src/real.c",
            "int handleHttpServer(int x) {\n    if (x > 0) return x + 1;\n    return 0;\n}\n",
        );
        write(
            dir.path(),
            "src/comment_only.c",
            "// handleHttpServer is documented here only\nint other(void) { return 1; }\n",
        );
        let root = dir.path().display().to_string();
        let store = SymbolStore::build(&root, 2, &|_, _| {}, &|| false).unwrap();
        store.save(home.path()).unwrap();

        let vol_dir = SymbolStore::index_dir(&root, home.path());
        let files: Vec<String> = store.files_with_counts().into_iter().map(|(p, _)| p).collect();
        let reader = VolumeSigReader::new(vol_dir.clone());

        // .ggs_xc strips comments, so comment_only.c is pruned out!
        let xc_hits = reader
            .filter_files_xc("handleHttpServer", &files)
            .expect("xc volume filters");
        assert_eq!(xc_hits, vec!["src/real.c".to_owned()]);

        // .ggs_xr includes comments, so both files match!
        let xr_hits = reader
            .filter_files_xr("handleHttpServer", &files)
            .expect("xr volume filters");
        assert_eq!(
            xr_hits,
            vec!["src/comment_only.c".to_owned(), "src/real.c".to_owned()]
        );

        // .ggs_xf indexes camel word parts ("Server" >= 3 chars).
        let xf_hits = reader
            .filter_files_xf("Server", &files)
            .expect("xf volume filters");
        assert!(xf_hits.contains(&"src/real.c".to_owned()));

        // Paged B-tree reader finds slots via .ggs_xab / .ggs_xsb.
        let paged = PagedIndexReader::new(vol_dir.clone());
        let xab_hits = paged.search_xab_prefix("Serv", 10).expect("xab search");
        assert!(!xab_hits.is_empty());
        let xsb_hits = paged.search_xsb_prefix("hand", 10).expect("xsb search");
        assert!(!xsb_hits.is_empty());

        // SymSlot metrics decode effective_lines & control_flow from raw108. Find the
        // branching function by its count — a same-file slot without an `if` carries
        // effective lines but zero control flow, and the map's order is hash order.
        let metrics = read_sym_slot_metrics(&vol_dir).expect("sym metrics");
        let m = metrics
            .values()
            .find(|m| m.control_flow >= 1)
            .expect("handleHttpServer carries raw108 counts");
        assert!(m.effective_lines >= 1);
        assert_eq!(m.param_count, 1);

        let stats = inspect_volume_stats(&vol_dir);
        assert!(stats.present);
        assert_eq!(stats.sig_files, 2);
        assert!(stats.sym_records >= 2);
    }
}
