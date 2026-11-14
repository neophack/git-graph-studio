//! The carve pass (module 21): the dumped memory regions are scanned byte-linearly for
//! embedded files, one format record at a time — the same shape MultiExtractor's engine
//! is (a table of header magic + per-format validation, a scan loop, and a per-hit length
//! decision). Every format in the table carries a validator that either reads the length
//! out of the file's own structures (BMP's `bfSize`, RIFF's size field, SQLite's page
//! count, OGG's page walk) or finds its end marker within a bounded window (JPEG's EOI,
//! PNG's IEND, ZIP's central directory, PDF's `%%EOF`). A hit the validator rejects is a
//! false positive — the 4-byte magics of a process dump are full of constants that only
//! look like file headers — and is skipped, never reported.

use std::fs::File;
use std::path::Path;

use ggs_base::sink::BatchSink;

use crate::{CarvedEntry, Dump, DumpEvent, DumpScanOptions, DumpScanStart};

/// Bytes scanned per chunk. Each chunk re-scans `OVERLAP` bytes of its predecessor, so
/// a header split across the boundary is still seen exactly once.
const CHUNK: usize = 4 * 1024 * 1024;
const OVERLAP: usize = 16;
/// Bytes scanned between progress events.
const PROGRESS_EVERY: u64 = 8 * 1024 * 1024;
/// The default minimum and maximum entry size (a 4-byte SOI+EOI JPEG or a "PNG" inside
/// a jump table is noise; the cap also bounds every end-marker search).
pub const DEFAULT_MIN_SIZE: u64 = 256;
pub const DEFAULT_MAX_SIZE: u64 = 64 * 1024 * 1024;

/// What a scan produced, beyond the streamed events: the final counts for the log.
pub struct ScanOutcome {
    pub entries: u64,
    pub elapsed_ms: u64,
    pub cancelled: bool,
}

/// One format record: the header magic the scanner matches, the family tag the list
/// filters by, and the validator that turns a hit into a definite end offset.
struct FormatSpec {
    format: &'static str,
    tag: &'static str,
    magic: &'static [u8],
    detect: fn(&mut Detect) -> Option<u64>,
}

/// The validator's view of one hit: a private file handle (the scanner's cursor stays
/// put), the hit's absolute file offset, and the size cap every search respects.
struct Detect<'a> {
    file: &'a mut File,
    hit: u64,
    max_size: u64,
}

impl Detect<'_> {
    /// Reads up to `len` bytes at the hit (the header fields live here).
    fn head(&mut self, len: usize) -> Vec<u8> {
        use std::io::{Read, Seek, SeekFrom};
        let mut buf = vec![0u8; len];
        if self.file.seek(SeekFrom::Start(self.hit)).is_err() {
            return Vec::new();
        }
        let mut filled = 0;
        while filled < len {
            match self.file.read(&mut buf[filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(_) => break,
            }
        }
        buf.truncate(filled);
        buf
    }

    /// Searches `needle` forward from `from` (an absolute file offset), bounded by the
    /// size cap. Block reads with one needle of overlap, so a marker split across a
    /// block boundary is still found.
    fn find(&mut self, needle: &[u8], from: u64) -> Option<u64> {
        use std::io::{Read, Seek, SeekFrom};
        let limit = self.hit.saturating_add(self.max_size);
        if from >= limit {
            return None;
        }
        const BLOCK: usize = 1024 * 1024;
        let mut pos = from;
        let mut carry: Vec<u8> = Vec::new();
        while pos < limit {
            let want = ((limit - pos) as usize).min(BLOCK);
            if self.file.seek(SeekFrom::Start(pos)).is_err() {
                return None;
            }
            let mut block = vec![0u8; want];
            let mut filled = 0;
            while filled < want {
                match self.file.read(&mut block[filled..]) {
                    Ok(0) => break,
                    Ok(n) => filled += n,
                    Err(_) => break,
                }
            }
            if filled == 0 {
                return None;
            }
            block.truncate(filled);
            let mut hay = std::mem::take(&mut carry);
            hay.extend_from_slice(&block);
            if let Some(at) = find_in(&hay, needle) {
                return Some(pos + (hay.len() - block.len()) as u64 + at as u64);
            }
            let keep = needle.len().saturating_sub(1).min(block.len());
            carry = block[block.len() - keep..].to_vec();
            pos += filled as u64;
        }
        None
    }
}

/// The first occurrence of `needle` in `haystack` (a 4-8 byte needle over megabyte
/// blocks — a byte-window scan is plenty).
fn find_in(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let first = needle[0];
    let mut i = 0;
    while i + needle.len() <= haystack.len() {
        if haystack[i] == first && haystack[i + 1..i + needle.len()] == needle[1..] {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn u16_at(buf: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(buf.get(at..at + 2).map_or([0; 2], |b| b.try_into().expect("slice")))
}

fn u32_at(buf: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(buf.get(at..at + 4).map_or([0; 4], |b| b.try_into().expect("slice")))
}

/* ---------- The validators ---------- */

fn png(d: &mut Detect) -> Option<u64> {
    let head = d.head(16);
    if head.get(12..16) != Some(b"IHDR") {
        return None;
    }
    d.find(b"IEND\xAE\x42\x60\x82", d.hit + 8).map(|at| at + 8)
}

fn jpg(d: &mut Detect) -> Option<u64> {
    let head = d.head(4);
    // SOI followed by a real marker segment: APP0/APP1 (JFIF/Exif), DQT, APP13/APP14,
    // or COM. A jump-table's `FF D8 FF xx` never puts one of these at +3.
    if !matches!(head.get(3), Some(0xE0 | 0xE1 | 0xDB | 0xED | 0xEE | 0xFE)) {
        return None;
    }
    d.find(&[0xFF, 0xD9], d.hit + 4).map(|at| at + 2)
}

fn gif(d: &mut Detect) -> Option<u64> {
    d.find(&[0x3B], d.hit + 13).map(|at| at + 1)
}

fn bmp(d: &mut Detect) -> Option<u64> {
    let head = d.head(8);
    let size = u64::from(u32_at(&head, 2));
    (size >= 54 && size <= d.max_size).then_some(d.hit + size)
}

/// ICO and CUR share the directory walk: the entries' own offsets and sizes sum to the
/// file's true end.
fn icon_dir(d: &mut Detect) -> Option<u64> {
    let head = d.head(6 + 64 * 16);
    let count = usize::from(u16_at(&head, 4));
    if count == 0 || count > 64 {
        return None;
    }
    let mut end = 6u64 + 16 * count as u64;
    for i in 0..count {
        let at = 6 + i * 16;
        let res = u64::from(u32_at(&head, at + 8));
        let off = u64::from(u32_at(&head, at + 12));
        if off < end || off.checked_add(res).is_none_or(|e| e > d.max_size) {
            return None;
        }
        end = end.max(off + res);
    }
    Some(d.hit + end)
}

/// The RIFF family: one container magic, three form types, each length read from the
/// RIFF size field (which excludes the 8-byte header).
fn riff_len(d: &mut Detect, form: &[u8], min_body: u64) -> Option<u64> {
    let head = d.head(12);
    if head.get(8..12) != Some(form) {
        return None;
    }
    let size = u64::from(u32_at(&head, 4));
    if size < min_body || size > d.max_size {
        return None;
    }
    Some(d.hit + 8 + size)
}

fn webp(d: &mut Detect) -> Option<u64> {
    riff_len(d, b"WEBP", 20)
}

fn wav(d: &mut Detect) -> Option<u64> {
    riff_len(d, b"WAVE", 36)
}

fn avi(d: &mut Detect) -> Option<u64> {
    riff_len(d, b"AVI ", 200)
}

fn tiff(d: &mut Detect) -> Option<u64> {
    let head = d.head(4 * 1024);
    let le = head.get(0..4) == Some(b"II\x2A\x00");
    let word = |at: usize| -> u32 {
        if le {
            u32_at(&head, at)
        } else {
            u32::from_be_bytes(head.get(at..at + 4).map_or([0; 4], |b| b.try_into().expect("slice")))
        }
    };
    let ifd = u64::from(word(4));
    if ifd < 8 || ifd > d.max_size || ifd as usize + 2 > head.len() {
        return None;
    }
    let count = usize::from(u16_at(&head, ifd as usize));
    if count == 0 || count > 512 || ifd as usize + 2 + 12 * count > head.len() {
        return None;
    }
    // The end is the furthest byte any entry points at (its value field, when the value
    // does not fit inline), past the directory itself.
    let mut end = ifd + 2 + 12 * count as u64 + 4;
    for i in 0..count {
        let at = ifd as usize + 2 + i * 12;
        let typ = u16_at(&head, at + 2);
        let n = u64::from(u32_at(&head, at + 4));
        let size = match typ {
            1 | 2 | 6 | 7 => n,
            3 | 8 => n * 2,
            4 | 9 | 11 => n * 4,
            5 | 10 | 12 => n * 8,
            _ => return None,
        };
        if size > 4 {
            let off = u64::from(word(at + 8));
            if off.checked_add(size).is_none_or(|e| e > d.max_size) {
                return None;
            }
            end = end.max(off + size);
        }
    }
    Some(d.hit + end)
}

/// MP3: a bare sync byte is everything, so the validator walks whole frames — the first
/// four must sit back to back (a constant inside code never does), then the walk runs to
/// the first invalid header and the end is the last good frame's end.
fn mp3(d: &mut Detect) -> Option<u64> {
    const BITRATES: [[u32; 15]; 2] = [
        // MPEG-1 Layer III, kbps
        [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
        // MPEG-2 / 2.5 Layer III, kbps
        [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    ];
    const SAMPLINGS: [u32; 3] = [44_100, 48_000, 32_000]; // MPEG-1; /2 for MPEG-2, /4 for 2.5
    let mut pos = d.hit;
    let mut frames = 0u32;
    let mut end = 0u64;
    while pos + 4 <= d.hit + d.max_size {
        let head = {
            use std::io::{Read, Seek, SeekFrom};
            let mut b = [0u8; 4];
            if d.file.seek(SeekFrom::Start(pos)).is_err() {
                return None;
            }
            if d.file.read_exact(&mut b).is_err() {
                break;
            }
            b
        };
        if head[0] != 0xFF || head[1] & 0xE0 != 0xE0 {
            break;
        }
        let version = (head[1] >> 3) & 0x03; // 0=2.5, 1=reserved, 2=2, 3=1
        let layer = (head[1] >> 1) & 0x03; // 1 = Layer III
        let bitrate_idx = usize::from((head[2] >> 4) & 0x0F);
        let sampling_idx = usize::from((head[2] >> 2) & 0x03);
        let padding = usize::from((head[2] >> 1) & 0x01);
        if version == 1 || layer == 0 || bitrate_idx == 0 || bitrate_idx == 15 || sampling_idx == 3 {
            break;
        }
        let mpeg1 = version == 3;
        let rate = u64::from(SAMPLINGS[sampling_idx])
            / match version {
                0 => 4,
                2 => 2,
                _ => 1,
            };
        let kbps = u64::from(BITRATES[if mpeg1 { 0 } else { 1 }][bitrate_idx]);
        let frame_len = kbps * 144_000 / rate + padding as u64;
        if frame_len < 24 {
            break;
        }
        frames += 1;
        end = pos + frame_len;
        pos += frame_len;
    }
    // Four consecutive frames (~100 bytes at 128 kbps) before the hit counts.
    (frames >= 4).then_some(end)
}

fn midi(d: &mut Detect) -> Option<u64> {
    let head = d.head(14);
    if u32_at(&head, 4) != 6 {
        return None;
    }
    let tracks = usize::from(u16_at(&head, 10));
    if tracks == 0 || tracks > 512 {
        return None;
    }
    let mut pos = d.hit + 14;
    for _ in 0..tracks {
        let mut chunk = [0u8; 8];
        use std::io::{Read, Seek, SeekFrom};
        if d.file.seek(SeekFrom::Start(pos)).is_err() || d.file.read_exact(&mut chunk).is_err() {
            return None;
        }
        if &chunk[0..4] != b"MTrk" {
            return None;
        }
        pos += 8 + u64::from(u32::from_be_bytes(chunk[4..8].try_into().expect("slice")));
        if pos > d.hit + d.max_size {
            return None;
        }
    }
    Some(pos)
}

fn ogg(d: &mut Detect) -> Option<u64> {
    use std::io::{Read, Seek, SeekFrom};
    let mut pos = d.hit;
    let mut pages = 0u32;
    let mut end = 0u64;
    while pos + 27 <= d.hit + d.max_size {
        let mut header = [0u8; 27];
        if d.file.seek(SeekFrom::Start(pos)).is_err() || d.file.read_exact(&mut header).is_err() {
            break;
        }
        if &header[0..4] != b"OggS" || header[4] != 0 || header[5] & 0xF8 != 0 {
            break;
        }
        let segments = usize::from(header[26]);
        let mut table = [0u8; 255];
        if d.file.read_exact(&mut table[..segments]).is_err() {
            break;
        }
        let body: u64 = table[..segments].iter().map(|s| u64::from(*s)).sum();
        pages += 1;
        end = pos + 27 + segments as u64 + body;
        pos = end;
        if header[5] & 0x04 != 0 {
            break; // the end-of-stream page
        }
    }
    (pages >= 2).then_some(end)
}

fn swf(d: &mut Detect) -> Option<u64> {
    // Uncompressed (FWS) only: a compressed CWS's declared length is the uncompressed
    // total, which says nothing about the bytes on disk.
    let head = d.head(8);
    let len = u64::from(u32_at(&head, 4));
    (len >= 9 && len <= d.max_size).then_some(d.hit + len)
}

fn zip(d: &mut Detect) -> Option<u64> {
    let head = d.head(32);
    let name_len = usize::from(u16_at(&head, 26));
    let extra_len = usize::from(u16_at(&head, 28));
    if !(1..=1024).contains(&name_len) || extra_len > 4096 {
        return None;
    }
    let eocd = d.find(b"PK\x05\x06", d.hit + 4)?;
    let mut comment = [0u8; 2];
    use std::io::{Read, Seek, SeekFrom};
    if d.file.seek(SeekFrom::Start(eocd + 20)).is_err() || d.file.read_exact(&mut comment).is_err() {
        return None;
    }
    Some(eocd + 22 + u64::from(u16::from_le_bytes(comment)))
}

/// RAR 4 archives walk block by block: every block states its own size, the END block
/// (0x7B) stops the walk. RAR 5's vint framing is not attempted.
fn rar(d: &mut Detect) -> Option<u64> {
    use std::io::{Read, Seek, SeekFrom};
    let mut pos = d.hit + 7;
    let mut end = 0u64;
    while pos + 7 <= d.hit + d.max_size {
        let mut header = [0u8; 11];
        if d.file.seek(SeekFrom::Start(pos)).is_err() || d.file.read_exact(&mut header).is_err() {
            break;
        }
        let block_type = header[2];
        let flags = u16::from_le_bytes([header[3], header[4]]);
        let size = u64::from(u16::from_le_bytes([header[5], header[6]]));
        let mut total = size;
        if flags & 0x8000 != 0 {
            total += u64::from(u32::from_le_bytes([header[7], header[8], header[9], header[10]]));
        }
        if size < 7 || total > d.max_size {
            break;
        }
        end = pos + total;
        pos = end;
        if block_type == 0x7B {
            break;
        }
    }
    (end > d.hit + 7).then_some(end)
}

fn cab(d: &mut Detect) -> Option<u64> {
    let head = d.head(32);
    if u32_at(&head, 4) != 0 || head.get(24) != Some(&3) || head.get(25) != Some(&1) {
        return None;
    }
    let size = u64::from(u32_at(&head, 8));
    (size >= 32 && size <= d.max_size).then_some(d.hit + size)
}

fn pdf(d: &mut Detect) -> Option<u64> {
    d.find(b"%%EOF", d.hit + 5).map(|at| at + 5)
}

fn sqlite(d: &mut Detect) -> Option<u64> {
    let head = d.head(100);
    let mut page_size = u64::from(u16_at(&head, 16));
    if page_size == 1 {
        page_size = 65_536;
    }
    if !(512..=65_536).contains(&page_size) || !page_size.is_power_of_two() {
        return None;
    }
    let pages = u64::from(u32_at(&head, 28));
    if pages == 0 {
        return None;
    }
    let size = pages.checked_mul(page_size)?;
    (size <= d.max_size).then_some(d.hit + size)
}

/// The table, in the MultiExtractor record's spirit: magic, tag, validator, extension.
/// Two magics per GIF/TIFF spelling and four MP3 sync variants make one format each.
static SPECS: &[FormatSpec] = &[
    FormatSpec { format: "png", tag: "image", magic: b"\x89PNG\r\n\x1a\n", detect: png },
    FormatSpec { format: "jpg", tag: "image", magic: b"\xFF\xD8\xFF", detect: jpg },
    FormatSpec { format: "gif", tag: "image", magic: b"GIF87a", detect: gif },
    FormatSpec { format: "gif", tag: "image", magic: b"GIF89a", detect: gif },
    FormatSpec { format: "bmp", tag: "image", magic: b"BM", detect: bmp },
    FormatSpec { format: "ico", tag: "image", magic: b"\x00\x00\x01\x00", detect: icon_dir },
    FormatSpec { format: "cur", tag: "image", magic: b"\x00\x00\x02\x00", detect: icon_dir },
    FormatSpec { format: "webp", tag: "image", magic: b"RIFF", detect: webp },
    FormatSpec { format: "wav", tag: "media", magic: b"RIFF", detect: wav },
    FormatSpec { format: "avi", tag: "media", magic: b"RIFF", detect: avi },
    FormatSpec { format: "tif", tag: "image", magic: b"II\x2A\x00", detect: tiff },
    FormatSpec { format: "tif", tag: "image", magic: b"MM\x00\x2A", detect: tiff },
    FormatSpec { format: "mp3", tag: "media", magic: b"\xFF\xFB", detect: mp3 },
    FormatSpec { format: "mp3", tag: "media", magic: b"\xFF\xFA", detect: mp3 },
    FormatSpec { format: "mp3", tag: "media", magic: b"\xFF\xF3", detect: mp3 },
    FormatSpec { format: "mp3", tag: "media", magic: b"\xFF\xF2", detect: mp3 },
    FormatSpec { format: "mid", tag: "media", magic: b"MThd", detect: midi },
    FormatSpec { format: "ogg", tag: "media", magic: b"OggS\x00", detect: ogg },
    FormatSpec { format: "swf", tag: "media", magic: b"FWS", detect: swf },
    FormatSpec { format: "zip", tag: "archive", magic: b"PK\x03\x04", detect: zip },
    FormatSpec { format: "rar", tag: "archive", magic: b"Rar!\x1A\x07\x00", detect: rar },
    FormatSpec { format: "cab", tag: "archive", magic: b"MSCF", detect: cab },
    FormatSpec { format: "pdf", tag: "doc", magic: b"%PDF-", detect: pdf },
    FormatSpec { format: "sqlite", tag: "db", magic: b"SQLite format 3\x00", detect: sqlite },
];

/// The format names the scan accepts in `options.formats` (the filter's choices).
pub fn supported_formats() -> Vec<&'static str> {
    let mut names: Vec<&'static str> = Vec::new();
    for spec in SPECS {
        if !names.contains(&spec.format) {
            names.push(spec.format);
        }
    }
    names
}

/// The specs one scan runs: every one, or the named subset.
fn enabled_specs(formats: &[String]) -> Vec<&'static FormatSpec> {
    if formats.is_empty() {
        return SPECS.iter().collect();
    }
    SPECS
        .iter()
        .filter(|s| formats.iter().any(|f| f == s.format))
        .collect()
}

/// One scan over the dump's memory regions, streaming entries through `sink` and
/// stopping the moment `cancel` answers true (a new scan started, or the receiver is
/// gone). The synchronous part (modules, byte total) returns with the outcome.
pub fn scan(
    path: &Path,
    options: &DumpScanOptions,
    cancel: &dyn Fn() -> bool,
    sink: &mut dyn BatchSink<DumpEvent>,
) -> Result<(DumpScanStart, ScanOutcome), String> {
    let started = std::time::Instant::now();
    let mut dump = Dump::open(path)?;
    let modules = dump.modules()?;
    let regions = dump.regions()?;
    let scan_bytes: u64 = regions.iter().map(|r| r.size).sum();
    let start = DumpScanStart {
        modules: modules.clone(),
        scan_bytes,
    };

    let min_size = if options.min_size > 0 { options.min_size } else { DEFAULT_MIN_SIZE };
    let max_size = if options.max_size > 0 { options.max_size } else { DEFAULT_MAX_SIZE };
    let specs = enabled_specs(&options.formats);
    // First-byte buckets: the inner loop compares only the specs whose magic starts
    // with the byte under the cursor.
    let mut buckets: Vec<Vec<usize>> = vec![Vec::new(); 256];
    for (i, spec) in specs.iter().enumerate() {
        buckets[usize::from(spec.magic[0])].push(i);
    }
    let mut detect_file = File::open(path).map_err(|e| e.to_string())?;

    let mut id = 0u64;
    let mut entries = 0u64;
    let mut scanned = 0u64;
    let mut next_progress = PROGRESS_EVERY;
    let mut cancelled = false;

    'regions: for region in &regions {
        let region_end = region.file_offset + region.size;
        let mut pos = region.file_offset;
        while pos < region_end {
            if cancel() {
                cancelled = true;
                break 'regions;
            }
            let want = usize::try_from(region_end - pos).unwrap_or(usize::MAX).min(CHUNK);
            let chunk = {
                use std::io::{Read, Seek, SeekFrom};
                let file = dump.file();
                if file.seek(SeekFrom::Start(pos)).is_err() {
                    break 'regions;
                }
                let mut buf = vec![0u8; want];
                let mut filled = 0;
                while filled < want {
                    match file.read(&mut buf[filled..]) {
                        Ok(0) => break,
                        Ok(n) => filled += n,
                        Err(_) => break,
                    }
                }
                buf.truncate(filled);
                buf
            };
            let skip = if pos == region.file_offset { 0 } else { OVERLAP };
            let mut batch: Vec<CarvedEntry> = Vec::new();
            for p in skip..chunk.len() {
                for &si in &buckets[usize::from(chunk[p])] {
                    let spec = specs[si];
                    if chunk.len() - p < spec.magic.len() {
                        continue;
                    }
                    if chunk[p..p + spec.magic.len()] != *spec.magic {
                        continue;
                    }
                    let hit = pos + p as u64;
                    let mut d = Detect {
                        file: &mut detect_file,
                        hit,
                        max_size,
                    };
                    let Some(end) = (spec.detect)(&mut d) else {
                        continue;
                    };
                    let size = end - hit;
                    if size < min_size || size > max_size {
                        continue;
                    }
                    let va = region.va + (hit - region.file_offset);
                    let in_module = modules
                        .iter()
                        .find(|m| va >= m.base && va - m.base < u64::from(m.size))
                        .map(|m| m.file_name.clone());
                    batch.push(CarvedEntry {
                        id,
                        format: spec.format.to_string(),
                        tag: spec.tag.to_string(),
                        offset: hit,
                        size,
                        va: Some(va),
                        in_module,
                    });
                    id += 1;
                }
            }
            entries += batch.len() as u64;
            if !batch.is_empty() && !sink.send(DumpEvent::Batch { entries: batch }) {
                cancelled = true;
                break 'regions;
            }
            let took = chunk.len().saturating_sub(skip) as u64;
            scanned += took;
            if scanned >= next_progress {
                next_progress = scanned + PROGRESS_EVERY;
                if !sink.send(DumpEvent::Progress {
                    scanned: scanned.min(scan_bytes),
                    total: scan_bytes,
                    entries,
                }) {
                    cancelled = true;
                    break 'regions;
                }
            }
            pos += took;
        }
    }
    let done = DumpEvent::Done {
        entries,
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        cancelled,
    };
    sink.send(done);
    Ok((
        start,
        ScanOutcome {
            entries,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            cancelled,
        },
    ))
}

/* ---------- Tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixture;

    /// Assembles a payload of carved candidates and runs the scan over it through a
    /// collecting sink. Returns the entries, the up-front module list, and the payload's
    /// file offset (the Memory64List's BaseRva) — entry offsets are FILE offsets.
    fn scan_payload(payload: &[u8], formats: &[String]) -> (Vec<CarvedEntry>, DumpScanStart, u64) {
        let dir = tempfile::tempdir().expect("tempdir");
        let f = fixture::write(
            &dir,
            &[(0x10_0000, 0x2000, r"C:\some\module.dll")],
            &[(0x10_0000, payload.len() as u64)],
            &|buf| buf.extend_from_slice(payload),
        );
        let mut sink = ggs_base::sink::VecSink(Vec::new());
        let (start, outcome) = scan(
            &f.path,
            &DumpScanOptions {
                formats: formats.to_vec(),
                // The fixtures carry toy-sized files; the defaults would filter them out.
                min_size: 32,
                max_size: 0,
            },
            &|| false,
            &mut sink,
        )
        .expect("scan");
        assert!(!outcome.cancelled);
        let entries = sink
            .0
            .into_iter()
            .flat_map(|e| match e {
                DumpEvent::Batch { entries } => entries,
                _ => Vec::new(),
            })
            .collect();
        (entries, start, f.base_rva)
    }

    fn minimal_png() -> Vec<u8> {
        // A real structure, not just the magic: IHDR chunk, one IDAT-ish blob, IEND+CRC.
        let mut v = Vec::new();
        v.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&[1, 0, 0, 1, 8, 2, 0, 0, 0]);
        v.extend_from_slice(&[0u8; 4]); // IHDR CRC
        v.extend_from_slice(&4u32.to_be_bytes());
        v.extend_from_slice(b"IDAT");
        v.extend_from_slice(&[0xAB, 0xCD, 0xEF, 0x01]);
        v.extend_from_slice(&[0u8; 4]);
        v.extend_from_slice(&0u32.to_be_bytes());
        v.extend_from_slice(b"IEND\xAE\x42\x60\x82");
        v
    }

    #[test]
    fn a_structured_png_is_carved_with_its_va_and_module() {
        let mut payload = vec![0u8; 100]; // noise before the hit
        payload.extend_from_slice(&minimal_png());
        let (entries, _start, base_rva) = scan_payload(&payload, &[]);
        let png: Vec<&CarvedEntry> = entries.iter().filter(|e| e.format == "png").collect();
        assert_eq!(png.len(), 1, "{entries:?}");
        assert_eq!(png[0].offset, base_rva + 100);
        assert_eq!(png[0].size, minimal_png().len() as u64);
        assert_eq!(png[0].va, Some(0x10_0000 + 100));
        assert_eq!(png[0].in_module.as_deref(), Some("module.dll"));
        assert_eq!(png[0].tag, "image");
    }

    #[test]
    fn the_format_filter_narrows_the_table() {
        let mut payload = minimal_png();
        payload.extend(std::iter::repeat_n(0u8, 100));
        payload.extend_from_slice(b"%PDF-1.4 ");
        payload.extend(std::iter::repeat_n(b'x', 60));
        payload.extend_from_slice(b"\n%%EOF");
        let (all, _, _) = scan_payload(&payload, &[]);
        assert!(all.iter().any(|e| e.format == "png"));
        assert!(all.iter().any(|e| e.format == "pdf"));
        let (pngs_only, _, _) = scan_payload(&payload, &["png".to_string()]);
        assert!(pngs_only.iter().all(|e| e.format == "png"));
        assert_eq!(pngs_only.len(), 1);
    }

    #[test]
    fn a_magic_without_structure_is_rejected() {
        // The PNG magic alone, with no IHDR — exactly what a constant in code looks like.
        let mut payload = vec![0u8; 64];
        payload.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        payload.extend_from_slice(&[0xEEu8; 200]);
        let (entries, _, _) = scan_payload(&payload, &[]);
        assert!(entries.iter().all(|e| e.format != "png"), "{entries:?}");
    }

    #[test]
    fn cancellation_stops_the_scan_before_it_finishes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let big = vec![0x41u8; 2 * CHUNK]; // two chunks of walkable bytes
        let f = fixture::write(
            &dir,
            &[],
            &[(0x10_0000, big.len() as u64)],
            &|buf| buf.extend_from_slice(&big),
        );
        let mut sink = ggs_base::sink::VecSink(Vec::new());
        let (_, outcome) = scan(
            &f.path,
            &DumpScanOptions::default(),
            &|| true, // cancelled from the first chunk on
            &mut sink,
        )
        .expect("scan");
        assert!(outcome.cancelled);
        let done = sink
            .0
            .iter()
            .any(|e| matches!(e, DumpEvent::Done { cancelled: true, .. }));
        assert!(done, "{:?}", sink.0);
    }

    #[test]
    fn the_scan_reports_its_module_list_up_front() {
        let dir = tempfile::tempdir().expect("tempdir");
        let f = fixture::write(
            &dir,
            &[(0x5000, 0x100, r"C:\Windows\System32\a.dll")],
            &[(0x5000, 32)],
            &|buf| buf.extend_from_slice(&[0u8; 32]),
        );
        let mut sink = ggs_base::sink::VecSink(Vec::new());
        let (start, _) = scan(&f.path, &DumpScanOptions::default(), &|| false, &mut sink).expect("scan");
        assert_eq!(start.modules.len(), 1);
        assert_eq!(start.modules[0].file_name, "a.dll");
        assert_eq!(start.scan_bytes, 32);
    }

    #[test]
    fn every_supported_format_has_a_distinct_validator_shape() {
        // The catalogue the frontend's filter renders: names unique, tags sane.
        let names = supported_formats();
        assert!(names.contains(&"png") && names.contains(&"sqlite"));
        for name in names {
            assert!(SPECS.iter().any(|s| s.format == name));
        }
        for spec in SPECS {
            assert!(matches!(spec.tag, "image" | "media" | "archive" | "doc" | "db"));
        }
    }
}
