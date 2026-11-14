//! The carve pass (module 21): the dumped memory regions are scanned for embedded
//! files by magic signature. The engine's shape is the classic one — a table of
//! (header magic, validator, extension) records over a linear scan — with the
//! performance rule that makes a 455 MiB dump scan finish in seconds: the dump is read
//! into memory once and every validator afterwards is a pure slice read. No per-hit
//! seeks, no per-block re-reads — those turn a scan into minutes of syscall waits
//! (every read of a dump file is also a real-time-scanner event on Windows), where the
//! same work in memory is a memchr pass at multiple gigabytes per second.
//!
//! The scan itself never walks bytes: for each format record, `memchr` jumps straight
//! to the positions of the magic's first byte at SIMD speed and the rest of the magic
//! is one slice compare. Every validator either reads the length out of the file's own
//! structures (BMP's `bfSize`, RIFF's size field, SQLite's page count, OGG's page walk,
//! TrueType's table directory) or finds its end marker within a bounded window (JPEG's
//! EOI, PNG's IEND, ZIP's central directory, PDF's `%%EOF`) — also in memory. A hit the
//! validator rejects is a false positive — process memory is full of constants that
//! only look like file headers — and is skipped, never reported.

use std::path::Path;

use ggs_base::sink::BatchSink;

use crate::{CarvedEntry, Dump, DumpEvent, DumpScanOptions, DumpScanStart};

/// Bytes scanned between progress events.
const PROGRESS_EVERY: u64 = 8 * 1024 * 1024;
/// The default minimum and maximum entry size. The cap also bounds every end-marker
/// search: a false-positive header pays one linear pass up to this limit, which is why
/// it is 16 MB rather than "whatever the biggest ZIP ever was".
pub const DEFAULT_MIN_SIZE: u64 = 256;
pub const DEFAULT_MAX_SIZE: u64 = 16 * 1024 * 1024;

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
    detect: fn(&Detect) -> Option<u64>,
}

/// The validator's view of one hit: the whole dump in memory (validators work in file
/// coordinates), the hit's offset, and the size cap every search respects. Every read
/// is a slice of the buffer — a validator can never cost a syscall.
struct Detect<'a> {
    data: &'a [u8],
    hit: u64,
    max_size: u64,
}

impl<'a> Detect<'a> {
    /// The hit's bytes, up to `len` (empty past the file's end).
    fn head(&self, len: usize) -> &'a [u8] {
        self.read_at(self.hit, len)
    }

    /// Up to `len` bytes at an absolute file offset — the available prefix when the
    /// range crosses the file's end (a file header sitting at a dump's tail must still
    /// parse its first bytes).
    fn read_at(&self, offset: u64, len: usize) -> &'a [u8] {
        if offset >= self.data.len() as u64 {
            return &[];
        }
        let start = offset as usize;
        let take = len.min(self.data.len() - start);
        &self.data[start..start + take]
    }

    /// One byte at an absolute file offset (a palette marker, a header word).
    fn byte_at(&self, offset: u64) -> u8 {
        self.read_at(offset, 1).first().copied().unwrap_or(0)
    }

    /// A little-endian u16/u32/u64 (and big-endian u32) at an absolute offset.
    fn u16_le_at(&self, offset: u64) -> u16 {
        let b = self.read_at(offset, 2);
        if b.len() == 2 {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            0
        }
    }

    fn u32_le_at(&self, offset: u64) -> u32 {
        let b = self.read_at(offset, 4);
        if b.len() == 4 {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            0
        }
    }

    fn u32_be_at(&self, offset: u64) -> u32 {
        let b = self.read_at(offset, 4);
        if b.len() == 4 {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        } else {
            0
        }
    }

    /// Searches `needle` forward from `from` (an absolute file offset), bounded by the
    /// size cap and the file's end — one memchr pass over the buffer.
    fn find(&self, needle: &[u8], from: u64) -> Option<u64> {
        let limit = self.hit.saturating_add(self.max_size).min(self.data.len() as u64);
        if from >= limit {
            return None;
        }
        find_in(&self.data[from as usize..limit as usize], needle).map(|at| from + at as u64)
    }
}

/// The first occurrence of `needle` in `haystack`: memchr jumps to the first byte's
/// positions at SIMD speed, the slice compare confirms.
fn find_in(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    for at in memchr::memchr_iter(needle[0], haystack) {
        if at + needle.len() > haystack.len() {
            return None;
        }
        if &haystack[at..at + needle.len()] == needle {
            return Some(at);
        }
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

fn png(d: &Detect) -> Option<u64> {
    let head = d.head(16);
    if head.get(12..16) != Some(b"IHDR") {
        return None;
    }
    d.find(b"IEND\xAE\x42\x60\x82", d.hit + 8).map(|at| at + 8)
}

fn jpg(d: &Detect) -> Option<u64> {
    let head = d.head(4);
    // SOI followed by a real marker segment: APP0/APP1 (JFIF/Exif), DQT, APP13/APP14,
    // or COM. A jump-table's `FF D8 FF xx` never puts one of these at +3.
    if !matches!(head.get(3), Some(0xE0 | 0xE1 | 0xDB | 0xED | 0xEE | 0xFE)) {
        return None;
    }
    d.find(&[0xFF, 0xD9], d.hit + 4).map(|at| at + 2)
}

fn gif(d: &Detect) -> Option<u64> {
    d.find(&[0x3B], d.hit + 13).map(|at| at + 1)
}

fn bmp(d: &Detect) -> Option<u64> {
    let head = d.head(8);
    let size = u64::from(u32_at(head, 2));
    (size >= 54 && size <= d.max_size).then_some(d.hit + size)
}

/// ICO and CUR share the directory walk: the entries' own offsets and sizes sum to the
/// file's true end.
fn icon_dir(d: &Detect) -> Option<u64> {
    let head = d.head(6 + 64 * 16);
    let count = usize::from(u16_at(head, 4));
    if count == 0 || count > 64 {
        return None;
    }
    let mut end = 6u64 + 16 * count as u64;
    for i in 0..count {
        let at = 6 + i * 16;
        let res = u64::from(u32_at(head, at + 8));
        let off = u64::from(u32_at(head, at + 12));
        if off < end || off.checked_add(res).is_none_or(|e| e > d.max_size) {
            return None;
        }
        end = end.max(off + res);
    }
    Some(d.hit + end)
}

/// The RIFF family: one container magic, three form types, each length read from the
/// RIFF size field (which excludes the 8-byte header).
fn riff_len(d: &Detect, form: &[u8], min_body: u64) -> Option<u64> {
    let head = d.head(12);
    if head.get(8..12) != Some(form) {
        return None;
    }
    let size = u64::from(u32_at(head, 4));
    if size < min_body || size > d.max_size {
        return None;
    }
    Some(d.hit + 8 + size)
}

fn webp(d: &Detect) -> Option<u64> {
    riff_len(d, b"WEBP", 20)
}

fn wav(d: &Detect) -> Option<u64> {
    riff_len(d, b"WAVE", 36)
}

fn avi(d: &Detect) -> Option<u64> {
    riff_len(d, b"AVI ", 200)
}

/// IFF containers (`FORM` and the Maya-aligned `FOR4`): the big-endian size at +4
/// covers the whole group including the type word.
fn iff(d: &Detect, aligned: bool) -> Option<u64> {
    let head = d.head(12);
    if head.len() < 12 {
        return None;
    }
    let mut size = u64::from(u32::from_be_bytes(head[4..8].try_into().expect("slice")));
    if aligned {
        size = (size + 3) & !3;
    }
    // The group size counts the type word but not the 8-byte header itself.
    let file = size.checked_add(8)?;
    if size < 4 || file > d.max_size {
        return None;
    }
    Some(d.hit + file)
}

fn form(d: &Detect) -> Option<u64> {
    iff(d, false)
}

fn for4(d: &Detect) -> Option<u64> {
    iff(d, true)
}

fn tiff(d: &Detect) -> Option<u64> {
    let head = d.head(4 * 1024);
    let le = head.get(0..4) == Some(b"II\x2A\x00");
    let word = |at: usize| -> u32 {
        if le {
            u32_at(head, at)
        } else {
            u32::from_be_bytes(head.get(at..at + 4).map_or([0; 4], |b| b.try_into().expect("slice")))
        }
    };
    let ifd = u64::from(word(4));
    if ifd < 8 || ifd > d.max_size || ifd as usize + 2 > head.len() {
        return None;
    }
    let count = usize::from(u16_at(head, ifd as usize));
    if count == 0 || count > 512 || ifd as usize + 2 + 12 * count > head.len() {
        return None;
    }
    // The end is the furthest byte any entry points at (its value field, when the value
    // does not fit inline), past the directory itself.
    let mut end = ifd + 2 + 12 * count as u64 + 4;
    for i in 0..count {
        let at = ifd as usize + 2 + i * 12;
        let typ = u16_at(head, at + 2);
        let n = u64::from(u32_at(head, at + 4));
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
fn mp3(d: &Detect) -> Option<u64> {
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
        let head = d.read_at(pos, 4);
        if head.len() < 4 || head[0] != 0xFF || head[1] & 0xE0 != 0xE0 {
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

fn midi(d: &Detect) -> Option<u64> {
    let head = d.head(14);
    // The MIDI header's fields are big-endian.
    if head.len() < 14 || &head[0..4] != b"MThd" || u32::from_be_bytes(head[4..8].try_into().expect("slice")) != 6 {
        return None;
    }
    let tracks = usize::from(u16::from_be_bytes(head[10..12].try_into().expect("slice")));
    if tracks == 0 || tracks > 512 {
        return None;
    }
    let mut pos = d.hit + 14;
    for _ in 0..tracks {
        let chunk = d.read_at(pos, 8);
        if chunk.len() < 8 || &chunk[0..4] != b"MTrk" {
            return None;
        }
        pos += 8 + u64::from(u32::from_be_bytes(chunk[4..8].try_into().expect("slice")));
        if pos > d.hit + d.max_size {
            return None;
        }
    }
    Some(pos)
}

fn ogg(d: &Detect) -> Option<u64> {
    let mut pos = d.hit;
    let mut pages = 0u32;
    let mut end = 0u64;
    while pos + 27 <= d.hit + d.max_size {
        let header = d.read_at(pos, 27 + 255);
        if header.len() < 27 || &header[0..4] != b"OggS" || header[4] != 0 || header[5] & 0xF8 != 0 {
            break;
        }
        let segments = usize::from(header[26]);
        if header.len() < 27 + segments {
            break;
        }
        let body: u64 = header[27..27 + segments].iter().map(|s| u64::from(*s)).sum();
        pages += 1;
        end = pos + 27 + segments as u64 + body;
        pos = end;
        if header[5] & 0x04 != 0 {
            break; // the end-of-stream page
        }
    }
    (pages >= 2).then_some(end)
}

fn swf(d: &Detect) -> Option<u64> {
    // Uncompressed (FWS) only: a compressed CWS's declared length is the uncompressed
    // total, which says nothing about the bytes on disk.
    let head = d.head(8);
    let len = u64::from(u32_at(head, 4));
    (len >= 9 && len <= d.max_size).then_some(d.hit + len)
}

fn zip(d: &Detect) -> Option<u64> {
    let head = d.head(32);
    let name_len = usize::from(u16_at(head, 26));
    let extra_len = usize::from(u16_at(head, 28));
    if !(1..=1024).contains(&name_len) || extra_len > 4096 {
        return None;
    }
    let eocd = d.find(b"PK\x05\x06", d.hit + 4)?;
    Some(eocd + 22 + u64::from(d.u16_le_at(eocd + 20)))
}

/// RAR 4 archives walk block by block: every block states its own size, the END block
/// (0x7B) stops the walk. RAR 5's vint framing is not attempted.
fn rar(d: &Detect) -> Option<u64> {
    let mut pos = d.hit + 7;
    let mut end = 0u64;
    while pos + 7 <= d.hit + d.max_size {
        let header = d.read_at(pos, 11);
        if header.len() < 11 {
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

fn cab(d: &Detect) -> Option<u64> {
    let head = d.head(32);
    if u32_at(head, 4) != 0 || head.get(24) != Some(&3) || head.get(25) != Some(&1) {
        return None;
    }
    let size = u64::from(u32_at(head, 8));
    (size >= 32 && size <= d.max_size).then_some(d.hit + size)
}

fn pdf(d: &Detect) -> Option<u64> {
    d.find(b"%%EOF", d.hit + 5).map(|at| at + 5)
}

fn sqlite(d: &Detect) -> Option<u64> {
    let head = d.head(100);
    let mut page_size = u64::from(u16_at(head, 16));
    if page_size == 1 {
        page_size = 65_536;
    }
    if !(512..=65_536).contains(&page_size) || !page_size.is_power_of_two() {
        return None;
    }
    let pages = u64::from(u32_at(head, 28));
    if pages == 0 {
        return None;
    }
    let size = pages.checked_mul(page_size)?;
    (size <= d.max_size).then_some(d.hit + size)
}

/// EMF: the enhanced-metafile header carries the whole file's byte count at +48.
fn emf(d: &Detect) -> Option<u64> {
    let head = d.head(64);
    if u32_at(head, 0) != 1 || u32_at(head, 4) < 88 || u32_at(head, 40) != 0x464D_4520 {
        return None;
    }
    let bytes = u64::from(u32_at(head, 48));
    (bytes >= 88 && bytes <= d.max_size).then_some(d.hit + bytes)
}

/// WMF (the standard in-place header, not the placeable copy): `mtHeaderSize` words at
/// +6 count the whole metafile.
fn wmf(d: &Detect) -> Option<u64> {
    let head = d.head(12);
    let words = u64::from(u32_at(head, 6));
    let end = words.checked_mul(2)?;
    (head.first() == Some(&1) && head.get(2) == Some(&9) && end >= 18 && end <= d.max_size)
        .then_some(d.hit + end)
}

/// TGA type 2 (uncompressed RGB): the header's own dimensions and depth give the size.
fn tga(d: &Detect) -> Option<u64> {
    let head = d.head(18);
    let width = u64::from(u16_at(head, 12));
    let height = u64::from(u16_at(head, 14));
    let depth = u64::from(*head.get(16).unwrap_or(&0));
    let bytes_pp = match depth {
        8 => 1,
        15 | 16 => 2,
        24 => 3,
        32 => 4,
        _ => return None,
    };
    if !(1..=16_384).contains(&width) || !(1..=16_384).contains(&height) {
        return None;
    }
    let size = width * height * bytes_pp;
    (size > 0 && size <= d.max_size).then_some(d.hit + 18 + size)
}

/// PCX (8-bit): the header's window and bytes-per-line give the image data; a 256-color
/// palette rides behind a 0x0C marker when present.
fn pcx(d: &Detect) -> Option<u64> {
    let head = d.head(128);
    let xmin = u64::from(u16_at(head, 4));
    let ymin = u64::from(u16_at(head, 6));
    let xmax = u64::from(u16_at(head, 8));
    let ymax = u64::from(u16_at(head, 10));
    let planes = u64::from(*head.get(65).unwrap_or(&0));
    let bpl = u64::from(u16_at(head, 66));
    if planes == 0 || planes > 4 || bpl == 0 || bpl > 8192 || xmax < xmin || ymax < ymin {
        return None;
    }
    let width = xmax - xmin + 1;
    let height = ymax - ymin + 1;
    if width > 16_384 || height > 16_384 {
        return None;
    }
    let mut end = d.hit + 128 + planes * bpl * height;
    if planes == 1 && d.byte_at(end) == 0x0C {
        end += 769; // the VGA palette
    }
    (end - d.hit <= d.max_size).then_some(end)
}

/// DDS: the header's flags, dimensions, format and mip count give the surface size.
fn dds(d: &Detect) -> Option<u64> {
    let head = d.head(128);
    if u32_at(head, 4) != 124 {
        return None;
    }
    let flags = u32_at(head, 8);
    let width = u64::from(u32_at(head, 12));
    let height = u64::from(u32_at(head, 16));
    let mips = if flags & 0x20_0000 != 0 { u64::from(u32_at(head, 24)).max(1) } else { 1 };
    if !(1..=16_384).contains(&width) || !(1..=16_384).contains(&height) || mips > 16 {
        return None;
    }
    let fourcc = u32_at(head, 84);
    let (block_w, block_h, block_bytes) = match fourcc {
        0x3154_5844 => (4u64, 4, 4), // "DXT1"
        0x3354_5844 => (4, 4, 8), // "DXT3"
        0x3554_5844 => (4, 4, 8), // "DXT5"
        _ => (1, 1, u64::from(u32_at(head, 88) & 0xFF).max(8)),
    };
    let mut size = 0u64;
    let (mut w, mut h) = (width.div_ceil(block_w).max(1), height.div_ceil(block_h).max(1));
    for _ in 0..mips {
        size += w * h * block_bytes;
        if w > 1 {
            w = w.div_ceil(2);
        }
        if h > 1 {
            h = h.div_ceil(2);
        }
    }
    (128 + size <= d.max_size).then_some(d.hit + 128 + size)
}

/// The sfnt walk shared by TTF and TTC: the table directory's furthest byte is the end.
fn sfnt_end(d: &Detect, at: u64) -> Option<u64> {
    let head = d.read_at(at, 12 + 256 * 16);
    if head.len() < 12 {
        return None;
    }
    let num_tables = usize::from(u16::from_be_bytes([head[4], head[5]]));
    if num_tables == 0 || num_tables > 256 || head.len() < 12 + num_tables * 16 {
        return None;
    }
    let mut end = 12usize + num_tables * 16;
    for i in 0..num_tables {
        let e = 12 + i * 16;
        let off = u32::from_be_bytes(head[e + 8..e + 12].try_into().expect("slice"));
        let len = u32::from_be_bytes(head[e + 12..e + 16].try_into().expect("slice"));
        end = end.max(off as usize + len as usize);
    }
    (end as u64 <= d.max_size).then_some(at + end as u64)
}

fn ttf(d: &Detect) -> Option<u64> {
    let head = d.head(4);
    if head.get(0..4) != Some(&[0x00, 0x01, 0x00, 0x00]) {
        return None;
    }
    sfnt_end(d, d.hit)
}

fn ttc(d: &Detect) -> Option<u64> {
    let head = d.head(12 + 4 * 16);
    if head.get(0..4) != Some(b"ttcf") {
        return None;
    }
    let num_fonts = u32::from_be_bytes(head[8..12].try_into().expect("slice"));
    if num_fonts == 0 || num_fonts > 16 || head.len() < 12 + num_fonts as usize * 4 {
        return None;
    }
    let mut end = 0u64;
    for i in 0..num_fonts as usize {
        let at = u32::from_be_bytes(head[12 + i * 4..16 + i * 4].try_into().expect("slice"));
        if u64::from(at) < 12 || u64::from(at) > d.max_size {
            return None;
        }
        end = end.max(sfnt_end(d, d.hit + u64::from(at))?);
    }
    Some(end)
}

/// ASF: the first object is the header object, whose size covers every sub-object.
fn asf(d: &Detect) -> Option<u64> {
    let head = d.head(32);
    if head.len() < 32
        || &head[0..16] != b"\x30\x26\xB2\x75\x8E\x66\xCF\x11\xA6\xD9\x00\xAA\x00\x62\xCE\x6C"
    {
        return None;
    }
    let size = u64::from_le_bytes(head[16..24].try_into().expect("slice"));
    (size >= 30 && size <= d.max_size).then_some(d.hit + size)
}

/// QuickTime atoms: the hit sits on the type word, the big-endian size one word before
/// it (`moov`, `mdat`, `wide` all follow the shape).
fn mov(d: &Detect) -> Option<u64> {
    if d.hit < 4 {
        return None;
    }
    let size = u64::from(d.u32_be_at(d.hit - 4));
    (size >= 8 && size <= d.max_size).then_some(d.hit - 4 + size)
}

/// 3DS: the main chunk's length at +6 covers the file; the version chunk at +2 is the
/// sanity check that separates a model from two text bytes.
fn model_3ds(d: &Detect) -> Option<u64> {
    let head = d.head(12);
    if u16_at(head, 2) != 2 {
        return None;
    }
    let len = u64::from(u32_at(head, 6));
    (len >= 12 && len <= d.max_size).then_some(d.hit + 6 + len)
}

/// Bink video: the file size sits right behind the magic.
fn bik(d: &Detect) -> Option<u64> {
    let head = d.head(8);
    let size = u64::from(u32_at(head, 4));
    (size >= 44 && size <= d.max_size).then_some(d.hit + size)
}

/// MPQ (v1/v2): the archive size at +12 covers the file.
fn mpq(d: &Detect) -> Option<u64> {
    let head = d.head(16);
    let header_size = u32_at(head, 8);
    let size = u64::from(u32_at(head, 12));
    let version = *head.get(4).unwrap_or(&0);
    (matches!(header_size, 0x20 | 0x2C)
        && matches!(version, 0 | 1)
        && size >= 32
        && size <= d.max_size)
        .then_some(d.hit + size)
}

/// FLIC (FLC/FLI): the header is fixed 128 bytes, then frame chunks (`F1FA`) walk to
/// the zero terminator.
fn flc(d: &Detect) -> Option<u64> {
    let head = d.head(130);
    let frames = u16_at(head, 6);
    if frames == 0 {
        return None;
    }
    let mut pos = d.hit + 128;
    let mut walked = 0u16;
    let mut end = 0u64;
    while walked < frames && pos + 6 <= d.hit + d.max_size {
        let size = u64::from(d.u32_le_at(pos));
        let kind = d.u16_le_at(pos + 4);
        if size < 6 || kind != 0xF1FA {
            break;
        }
        end = pos + size;
        pos = end;
        walked += 1;
    }
    (walked >= 1).then_some(end)
}

/// Protracker module: the magic sits 1080 bytes INTO the file, so the validator
/// rewinds to the real header — the 31 sample lengths and the pattern table's high
/// water mark sum to the exact size. The carve still starts at the magic (the engine
/// reports from the hit); the header bytes before it stay in the dump.
fn protracker(d: &Detect) -> Option<u64> {
    if d.hit < 1080 {
        return None;
    }
    let start = d.hit - 1080;
    let song_length = usize::from(d.byte_at(start + 950));
    if !(1..=128).contains(&song_length) {
        return None;
    }
    let mut num_patterns = 0usize;
    for i in 0..song_length {
        num_patterns = num_patterns.max(usize::from(d.byte_at(start + 952 + i as u64)) + 1);
    }
    if num_patterns == 0 {
        return None;
    }
    let mut sample_bytes = 0u64;
    for i in 0..31 {
        let word = d.read_at(start + 42 + i * 30, 2);
        if word.len() < 2 {
            return None;
        }
        let len = u64::from(u16::from_be_bytes([word[0], word[1]])) * 2;
        if len > d.max_size {
            return None;
        }
        sample_bytes += len;
    }
    let end = start + 1084 + num_patterns as u64 * 1024 + sample_bytes;
    (end > d.hit && end - d.hit <= d.max_size).then_some(end)
}

/// The table, in scan-record form: magic, family tag, validator, extension. Repeat
/// magics per spelling (two GIFs, two TIFFs, four MP3 sync variants) make one record
/// each so the first-byte pass stays a single compare.
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
    FormatSpec { format: "tga", tag: "image", magic: b"\x00\x00\x02\x00", detect: tga },
    FormatSpec { format: "pcx", tag: "image", magic: b"\x0A\x05\x01\x08", detect: pcx },
    FormatSpec { format: "dds", tag: "image", magic: b"DDS \x7C", detect: dds },
    FormatSpec { format: "emf", tag: "image", magic: b"\x01\x00\x00\x00", detect: emf },
    FormatSpec { format: "wmf", tag: "image", magic: b"\x01\x00\x09\x00", detect: wmf },
    FormatSpec { format: "ttf", tag: "font", magic: b"\x00\x01\x00\x00", detect: ttf },
    FormatSpec { format: "ttc", tag: "font", magic: b"ttcf", detect: ttc },
    FormatSpec { format: "mp3", tag: "media", magic: b"\xFF\xFB", detect: mp3 },
    FormatSpec { format: "mp3", tag: "media", magic: b"\xFF\xFA", detect: mp3 },
    FormatSpec { format: "mp3", tag: "media", magic: b"\xFF\xF3", detect: mp3 },
    FormatSpec { format: "mp3", tag: "media", magic: b"\xFF\xF2", detect: mp3 },
    FormatSpec { format: "mid", tag: "media", magic: b"MThd", detect: midi },
    FormatSpec { format: "ogg", tag: "media", magic: b"OggS\x00", detect: ogg },
    FormatSpec { format: "swf", tag: "media", magic: b"FWS", detect: swf },
    FormatSpec { format: "mod", tag: "media", magic: b"M.K.", detect: protracker },
    FormatSpec { format: "mov", tag: "media", magic: b"moov", detect: mov },
    FormatSpec { format: "flc", tag: "media", magic: b"\x12\xAF", detect: flc },
    FormatSpec { format: "bik", tag: "media", magic: b"BIK", detect: bik },
    FormatSpec { format: "asf", tag: "media", magic: b"\x30\x26\xB2\x75\x8E\x66\xCF\x11\xA6\xD9\x00\xAA\x00\x62\xCE\x6C", detect: asf },
    FormatSpec { format: "zip", tag: "archive", magic: b"PK\x03\x04", detect: zip },
    FormatSpec { format: "rar", tag: "archive", magic: b"Rar!\x1A\x07\x00", detect: rar },
    FormatSpec { format: "cab", tag: "archive", magic: b"MSCF", detect: cab },
    FormatSpec { format: "mpq", tag: "archive", magic: b"MPQ\x1A", detect: mpq },
    FormatSpec { format: "pdf", tag: "doc", magic: b"%PDF-", detect: pdf },
    FormatSpec { format: "sqlite", tag: "db", magic: b"SQLite format 3\x00", detect: sqlite },
    FormatSpec { format: "iff", tag: "image", magic: b"FORM", detect: form },
    FormatSpec { format: "3ds", tag: "image", magic: b"MM", detect: model_3ds },
    FormatSpec { format: "iff", tag: "image", magic: b"FOR4", detect: for4 },
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
/// gone). The dump is read into memory once — 455 MiB in about a second, every check
/// after that a slice read — and the synchronous part (modules, byte total) returns
/// with the outcome.
pub fn scan(
    path: &Path,
    options: &DumpScanOptions,
    cancel: &dyn Fn() -> bool,
    sink: &mut dyn BatchSink<DumpEvent>,
) -> Result<(DumpScanStart, ScanOutcome), String> {
    let started = std::time::Instant::now();
    let data = std::fs::read(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    let mut dump = Dump::open(path)?;
    let modules = dump.modules()?;
    let regions = dump.regions()?;
    let scan_bytes: u64 = regions
        .iter()
        .map(|r| r.size.min(u64::try_from(data.len()).unwrap_or(u64::MAX).saturating_sub(r.file_offset)))
        .sum();
    let start = DumpScanStart {
        modules: modules.clone(),
        scan_bytes,
    };

    let min_size = if options.min_size > 0 { options.min_size } else { DEFAULT_MIN_SIZE };
    let max_size = if options.max_size > 0 { options.max_size } else { DEFAULT_MAX_SIZE };
    let specs = enabled_specs(&options.formats);

    let mut id = 0u64;
    let mut entries = 0u64;
    let mut scanned = 0u64;
    let mut next_progress = PROGRESS_EVERY;
    let mut cancelled = false;

    'regions: for region in &regions {
        if cancel() {
            cancelled = true;
            break 'regions;
        }
        let base = region.file_offset.min(data.len() as u64) as usize;
        let end = region.file_offset.saturating_add(region.size).min(data.len() as u64) as usize;
        if base >= end {
            continue;
        }
        let region_data = &data[base..end];
        let mut batch: Vec<CarvedEntry> = Vec::new();
        // One memchr pass per format record: the scanner never walks bytes, it
        // jumps to each record's first byte and compares the rest of the magic.
        for spec in &specs {
            for at in memchr::memchr_iter(spec.magic[0], region_data) {
                if region_data.len() - at < spec.magic.len() {
                    break;
                }
                if &region_data[at..at + spec.magic.len()] != spec.magic {
                    continue;
                }
                let hit = region.file_offset + at as u64;
                let d = Detect { data: &data, hit, max_size };
                let Some(end) = (spec.detect)(&d) else {
                    continue;
                };
                let size = end - hit;
                if size < min_size || size > max_size {
                    continue;
                }
                let va = region.va + at as u64;
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
        scanned += (end - base) as u64;
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
                min_size: 16,
                max_size: 1024 * 1024,
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
        let big = vec![0x41u8; 1024 * 1024]; // one walkable region
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
            &|| true, // cancelled from the first region on
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
            assert!(matches!(spec.tag, "image" | "media" | "archive" | "doc" | "db" | "font"));
        }
    }

    #[test]
    fn a_declared_length_carves_without_a_trailer() {
        // EMF declares its byte count: the hit is a record the length field alone settles.
        let mut payload = vec![0u8; 40];
        let start = payload.len() as u64;
        payload.extend_from_slice(&1u32.to_le_bytes()); // iType = EMR_HEADER
        payload.extend_from_slice(&120u32.to_le_bytes()); // nSize
        payload.extend_from_slice(&[0u8; 32]); // bounds etc.
        payload.extend_from_slice(&0x464D_4520u32.to_le_bytes()); // dSignature
        payload.extend_from_slice(&0u32.to_le_bytes()); // nVersion
        payload.extend_from_slice(&200u32.to_le_bytes()); // nBytes = the whole file
        payload.extend_from_slice(&[0u8; 40]);
        let (entries, _, base_rva) = scan_payload(&payload, &["emf".to_string()]);
        let emf: Vec<&CarvedEntry> = entries.iter().filter(|e| e.format == "emf").collect();
        assert_eq!(emf.len(), 1, "{entries:?}");
        assert_eq!(emf[0].offset, base_rva + start);
        assert_eq!(emf[0].size, 200);
    }

    #[test]
    fn a_ttf_with_a_sane_table_directory_carves() {
        let mut font = Vec::new();
        font.extend_from_slice(&[0x00, 0x01, 0x00, 0x00]); // version 1.0
        font.extend_from_slice(&1u16.to_be_bytes()); // numTables
        font.extend_from_slice(&[0u8; 6]); // search range etc.
        // one table entry: tag, checksum, offset 40, length 60
        font.extend_from_slice(b"glyf");
        font.extend_from_slice(&[0u8; 4]);
        font.extend_from_slice(&40u32.to_be_bytes());
        font.extend_from_slice(&60u32.to_be_bytes());
        // the table's bytes, at the offset the entry declares (40 into the font)
        font.extend(std::iter::repeat_n(0u8, 40 - font.len()));
        font.extend(std::iter::repeat_n(0x77u8, 60));
        let mut payload = vec![0u8; 24];
        let start = payload.len() as u64;
        payload.extend_from_slice(&font);
        let (entries, _, base_rva) = scan_payload(&payload, &["ttf".to_string()]);
        let ttf: Vec<&CarvedEntry> = entries.iter().filter(|e| e.format == "ttf").collect();
        assert_eq!(ttf.len(), 1, "{entries:?}");
        assert_eq!(ttf[0].size, font.len() as u64);
        assert_eq!(ttf[0].offset, base_rva + start);
        assert_eq!(ttf[0].tag, "font");
    }

    /* ---------- Every format, carved and extracted ---------- */

    /// One crafted, structurally valid sample per supported format:
    /// (format, bytes, the byte offset the HIT sits at within the bytes, the size the
    /// validator must report). Most samples start at their hit; the QuickTime atom's
    /// hit lands on its type word with the size word one word before it.
    fn format_samples() -> Vec<(&'static str, Vec<u8>, u64, u64)> {
        let mut samples: Vec<(&'static str, Vec<u8>, u64, u64)> = Vec::new();
        let mut push = |format: &'static str, hit_at: u64, size: u64, build: &dyn Fn(&mut Vec<u8>)| {
            let mut v = Vec::new();
            build(&mut v);
            samples.push((format, v, hit_at, size));
        };

        push("png", 0, 0, &|v| {
            v.extend(minimal_png());
        });
        push("jpg", 0, 0, &|v| {
            v.extend_from_slice(&[0xFF, 0xD8, 0xFF, 0xE0]); // SOI + APP0
            v.extend_from_slice(&[0x00, 0x10, b'J', b'F', b'I', b'F', 0x00]);
            v.extend(std::iter::repeat_n(0x11u8, 24));
            v.extend_from_slice(&[0xFF, 0xD9]); // EOI
        });
        push("gif", 0, 0, &|v| {
            v.extend_from_slice(b"GIF89a");
            v.extend_from_slice(&[0u8; 7]); // the logical screen block (13-byte header)
            v.extend(std::iter::repeat_n(0x22u8, 8));
            v.push(0x3B); // trailer
        });
        push("bmp", 0, 0, &|v| {
            v.extend_from_slice(b"BM");
            v.extend_from_slice(&68u32.to_le_bytes()); // bfSize = the whole file
            v.extend_from_slice(&[0u8; 4]); // reserved
            v.extend_from_slice(&14u32.to_le_bytes()); // bfOffBits
            v.extend(std::iter::repeat_n(0x33u8, 54)); // the pixel data
        });
        push("ico", 0, 0, &|v| {
            v.extend_from_slice(&[0, 0, 1, 0, 1, 0]); // ICONDIR, 1 image
            // entry: 16x16, 2 colors, 1 plane, 32 bpp, 40 bytes at offset 22
            v.extend_from_slice(&[16, 16, 2, 0, 1, 0, 32, 0]);
            v.extend_from_slice(&40u32.to_le_bytes()); // bytes in resource
            v.extend_from_slice(&22u32.to_le_bytes()); // image offset
            v.extend(std::iter::repeat_n(0x44u8, 40));
        });
        push("cur", 0, 0, &|v| {
            v.extend_from_slice(&[0, 0, 2, 0, 1, 0]); // CURDIR, 1 image
            v.extend_from_slice(&[16, 16, 2, 0, 1, 0, 32, 0]);
            v.extend_from_slice(&40u32.to_le_bytes());
            v.extend_from_slice(&22u32.to_le_bytes());
            v.extend(std::iter::repeat_n(0x55u8, 40));
        });
        push("webp", 0, 0, &|v| {
            v.extend_from_slice(b"RIFF");
            v.extend_from_slice(&32u32.to_le_bytes()); // file - 8
            v.extend_from_slice(b"WEBP");
            v.extend_from_slice(b"VP8 ");
            v.extend_from_slice(&20u32.to_le_bytes());
            v.extend(std::iter::repeat_n(0x66u8, 20));
        });
        push("wav", 0, 0, &|v| {
            v.extend_from_slice(b"RIFF");
            v.extend_from_slice(&44u32.to_le_bytes()); // file - 8
            v.extend_from_slice(b"WAVE");
            v.extend_from_slice(b"fmt ");
            v.extend_from_slice(&16u32.to_le_bytes());
            v.extend(std::iter::repeat_n(0x77u8, 32));
        });
        push("avi", 0, 0, &|v| {
            v.extend_from_slice(b"RIFF");
            v.extend_from_slice(&(220u32).to_le_bytes()); // file - 8
            v.extend_from_slice(b"AVI ");
            v.extend(std::iter::repeat_n(0x11u8, 216));
        });
        push("tif", 0, 0, &|v| {
            v.extend_from_slice(b"II\x2A\x00");
            v.extend_from_slice(&8u32.to_le_bytes()); // IFD at 8
            v.extend_from_slice(&1u16.to_le_bytes()); // 1 entry
            v.extend_from_slice(&[0x00, 0x01, 3, 0]); // ImageWidth, SHORT
            v.extend_from_slice(&1u32.to_le_bytes()); // count
            v.extend_from_slice(&[8, 0, 0, 0]); // inline value
            v.extend_from_slice(&0u32.to_le_bytes()); // next IFD
        });
        push("tga", 0, 0, &|v| {
            v.extend_from_slice(&[0, 0, 2, 0, 0, 0, 0, 0]); // type 2, no cmap
            v.extend_from_slice(&[0u8; 4]); // cmap spec (length 0 — not an ICO dir)
            v.extend_from_slice(&4u16.to_le_bytes()); // width
            v.extend_from_slice(&4u16.to_le_bytes()); // height
            v.push(24); // depth
            v.push(0); // descriptor
            v.extend(std::iter::repeat_n(0x88u8, 4 * 4 * 3)); // the pixels
        });
        push("pcx", 0, 160, &|v| {
            v.extend_from_slice(&[0x0A, 0x05, 0x01, 0x08]); // magic, version, RLE, 8 bpp
            v.extend_from_slice(&0u16.to_le_bytes()); // xmin
            v.extend_from_slice(&0u16.to_le_bytes()); // ymin
            v.extend_from_slice(&7u16.to_le_bytes()); // xmax
            v.extend_from_slice(&3u16.to_le_bytes()); // ymax
            v.extend(std::iter::repeat_n(0u8, 53)); // hdpi/palette/reserved, through byte 64
            v.push(1); // planes (byte 65)
            v.extend_from_slice(&8u16.to_le_bytes()); // bytes per line (66..68)
            v.extend(std::iter::repeat_n(0x99u8, 32)); // one plane, four rows
        });
        push("dds", 0, 0, &|v| {
            v.extend_from_slice(b"DDS ");
            v.extend_from_slice(&124u32.to_le_bytes()); // dwSize
            v.extend_from_slice(&0x1007u32.to_le_bytes()); // CAPS|HEIGHT|WIDTH|PIXELFORMAT
            v.extend_from_slice(&4u32.to_le_bytes()); // width
            v.extend_from_slice(&4u32.to_le_bytes()); // height
            v.extend_from_slice(&16u32.to_le_bytes()); // linear size
            v.extend_from_slice(&[0u8; 8]); // depth, mipMapCount
            v.extend_from_slice(&[0u8; 44]); // reserved
            v.extend_from_slice(&32u32.to_le_bytes()); // pixel-format size
            v.extend_from_slice(&[0u8; 4]); // pixel-format flags
            v.extend_from_slice(b"DXT1");
            v.extend(std::iter::repeat_n(0u8, 16)); // the rest of the pixel format
            v.extend(std::iter::repeat_n(0u8, 24)); // caps, caps2, reserved — the full 128
            v.extend(std::iter::repeat_n(0xAAu8, 4)); // one 4x4 DXT1 block
        });
        push("emf", 0, 0, &|v| {
            v.extend_from_slice(&1u32.to_le_bytes()); // iType = EMR_HEADER
            v.extend_from_slice(&120u32.to_le_bytes()); // nSize
            v.extend_from_slice(&[0u8; 32]); // bounds etc.
            v.extend_from_slice(&0x464D_4520u32.to_le_bytes()); // dSignature
            v.extend_from_slice(&0u32.to_le_bytes()); // nVersion
            v.extend_from_slice(&200u32.to_le_bytes()); // nBytes
            v.extend(std::iter::repeat_n(0xEEu8, 200 - 52));
        });
        push("wmf", 0, 18, &|v| {
            v.extend_from_slice(&[1, 0, 9, 0]); // type 1, header size 9 words
            v.extend_from_slice(&0u16.to_le_bytes()); // version
            v.extend_from_slice(&9u32.to_le_bytes()); // mtSize, in words
            v.extend(std::iter::repeat_n(0x12u8, 6));
        });
        push("ttf", 0, 0, &|v| {
            v.extend_from_slice(&[0x00, 0x01, 0x00, 0x00]); // version 1.0
            v.extend_from_slice(&1u16.to_be_bytes()); // numTables
            v.extend_from_slice(&[0u8; 6]); // search range etc.
            v.extend_from_slice(b"glyf");
            v.extend_from_slice(&[0u8; 4]); // checksum
            v.extend_from_slice(&40u32.to_be_bytes()); // offset
            v.extend_from_slice(&60u32.to_be_bytes()); // length
            v.extend(std::iter::repeat_n(0u8, 40 - 28));
            v.extend(std::iter::repeat_n(0x77u8, 60));
        });
        push("ttc", 0, 64, &|v| {
            v.extend_from_slice(b"ttcf");
            v.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // version
            v.extend_from_slice(&1u32.to_be_bytes()); // one font
            v.extend_from_slice(&16u32.to_be_bytes()); // its offset (past the 16-byte header)
            // the sfnt at 16: one table of 32 bytes at 16 (within the sfnt)
            v.extend_from_slice(&[0x00, 0x01, 0x00, 0x00]);
            v.extend_from_slice(&1u16.to_be_bytes());
            v.extend_from_slice(&[0u8; 6]);
            v.extend_from_slice(b"glyf");
            v.extend_from_slice(&[0u8; 4]);
            v.extend_from_slice(&16u32.to_be_bytes());
            v.extend_from_slice(&32u32.to_be_bytes());
            v.extend(std::iter::repeat_n(0x77u8, 32));
        });
        push("mp3", 0, 1668, &|v| {
            // four MPEG-1 Layer III 128 kbps 44.1 kHz frames of 417 bytes
            for _ in 0..4 {
                v.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
                v.extend(std::iter::repeat_n(0x55u8, 417 - 4));
            }
        });
        push("mid", 0, 0, &|v| {
            v.extend_from_slice(b"MThd");
            v.extend_from_slice(&6u32.to_be_bytes());
            v.extend_from_slice(&1u16.to_be_bytes()); // format 1
            v.extend_from_slice(&1u16.to_be_bytes()); // one track
            v.extend_from_slice(&48u16.to_be_bytes()); // division
            v.extend_from_slice(b"MTrk");
            v.extend_from_slice(&32u32.to_be_bytes());
            v.extend(std::iter::repeat_n(0x44u8, 32));
        });
        push("ogg", 0, 0, &|v| {
            for (i, header_type) in [0x02u8, 0x04].into_iter().enumerate() {
                v.extend_from_slice(b"OggS");
                v.push(0); // version
                v.push(header_type); // BOS then EOS
                v.extend_from_slice(&[0u8; 20]); // granule, serial, page, checksum
                v.push(1); // one segment
                v.push(if i == 0 { 20 } else { 10 });
                v.extend(std::iter::repeat_n(0x66u8, if i == 0 { 20 } else { 10 }));
            }
        });
        push("swf", 0, 80, &|v| {
            v.extend_from_slice(b"FWS");
            v.push(6); // version
            v.extend_from_slice(&80u32.to_le_bytes()); // the whole file's length
            v.extend(std::iter::repeat_n(0x22u8, 73));
        });
        push("mod", 1080, 1028, &|v| {
            v.extend(std::iter::repeat_n(0u8, 20)); // song title
            v.extend(std::iter::repeat_n(0u8, 31 * 30)); // 31 silent sample headers
            v.push(1); // song length: one pattern position
            v.push(0); // restart
            v.extend(std::iter::repeat_n(0u8, 128)); // the pattern table
            v.extend_from_slice(b"M.K.");
            v.extend(std::iter::repeat_n(0x11u8, 1024)); // one pattern
        });
        push("mov", 4, 60, &|v| {
            v.extend_from_slice(&64u32.to_be_bytes()); // atom size, one word BEFORE the hit
            v.extend_from_slice(b"moov");
            v.extend(std::iter::repeat_n(0x33u8, 56));
        });
        push("flc", 0, 148, &|v| {
            v.extend_from_slice(&[0x12, 0xAF]);
            v.extend_from_slice(&[0u8; 4]); // compression etc.
            v.extend_from_slice(&1u16.to_le_bytes()); // frames
            v.extend_from_slice(&[0u8; 120]); // the rest of the fixed 128-byte header
            v.extend_from_slice(&20u32.to_le_bytes()); // frame chunk size
            v.extend_from_slice(&0xF1FAu16.to_le_bytes());
            v.extend(std::iter::repeat_n(0x44u8, 14));
        });
        push("bik", 0, 200, &|v| {
            v.extend_from_slice(b"BIKi");
            v.extend_from_slice(&200u32.to_le_bytes()); // file size
            v.extend(std::iter::repeat_n(0x55u8, 192));
        });
        push("asf", 0, 128, &|v| {
            v.extend_from_slice(b"\x30\x26\xB2\x75\x8E\x66\xCF\x11\xA6\xD9\x00\xAA\x00\x62\xCE\x6C");
            v.extend_from_slice(&128u64.to_le_bytes()); // the header object's size
            v.extend(std::iter::repeat_n(0x77u8, 128 - 24));
        });
        push("zip", 0, 0, &|v| {
            v.extend_from_slice(b"PK\x03\x04");
            v.extend_from_slice(&20u16.to_le_bytes()); // version
            v.extend_from_slice(&[0u8; 20]); // flags through CRC
            v.extend_from_slice(&10u32.to_le_bytes()); // compressed size
            v.extend_from_slice(&10u32.to_le_bytes()); // uncompressed size
            v.extend_from_slice(&4u16.to_le_bytes()); // name length
            v.extend_from_slice(&0u16.to_le_bytes()); // extra length
            v.extend_from_slice(b"file");
            v.extend(std::iter::repeat_n(0x77u8, 10));
            v.extend_from_slice(b"PK\x05\x06"); // EOCD
            v.extend_from_slice(&[0u8; 16]);
            v.extend_from_slice(&0u16.to_le_bytes()); // comment length
        });
        push("rar", 0, 20, &|v| {
            v.extend_from_slice(b"Rar!\x1A\x07\x00");
            // the END block: crc, type 0x7B, flags 0x4000, size 13
            v.extend_from_slice(&[0u8, 0, 0x7B]);
            v.extend_from_slice(&0x4000u16.to_le_bytes());
            v.extend_from_slice(&13u16.to_le_bytes());
        });
        push("cab", 0, 80, &|v| {
            v.extend_from_slice(b"MSCF");
            v.extend_from_slice(&0u32.to_le_bytes()); // reserved1
            v.extend_from_slice(&80u32.to_le_bytes()); // cbCabinet
            v.extend_from_slice(&0u32.to_le_bytes()); // reserved2
            v.extend_from_slice(&0u32.to_le_bytes()); // first-file offset
            v.extend_from_slice(&0u32.to_le_bytes()); // reserved3
            v.push(3); // version minor
            v.push(1); // version major
            v.extend(std::iter::repeat_n(0x11u8, 80 - 32));
        });
        push("mpq", 0, 256, &|v| {
            v.extend_from_slice(b"MPQ\x1A");
            v.push(0); // format version 0
            v.extend_from_slice(&[0u8; 3]); // the rest of the format word
            v.extend_from_slice(&0x20u32.to_le_bytes()); // header size
            v.extend_from_slice(&256u32.to_le_bytes()); // archive size
            v.extend(std::iter::repeat_n(0x99u8, 256 - 16));
        });
        push("pdf", 0, 0, &|v| {
            v.extend_from_slice(b"%PDF-1.4\n");
            v.extend(std::iter::repeat_n(b'x', 40));
            v.extend_from_slice(b"%%EOF");
        });
        push("sqlite", 0, 2048, &|v| {
            v.extend_from_slice(b"SQLite format 3\x00");
            v.extend_from_slice(&1024u16.to_le_bytes()); // page size
            v.extend_from_slice(&[0u8; 10]); // write/read versions, reserved bytes
            v.extend_from_slice(&2u32.to_le_bytes()); // page count
            v.extend(std::iter::repeat_n(0x44u8, 2048 - 100));
        });
        push("iff", 0, 0, &|v| {
            v.extend_from_slice(b"FORM");
            v.extend_from_slice(&60u32.to_be_bytes()); // group size: type word + body
            v.extend_from_slice(b"ILBM");
            v.extend(std::iter::repeat_n(0x11u8, 56));
        });
        push("3ds", 0, 100, &|v| {
            v.extend_from_slice(b"MM");
            v.extend_from_slice(&2u16.to_le_bytes()); // MAIN chunk id
            v.extend_from_slice(&[0u8; 2]);
            v.extend_from_slice(&94u32.to_le_bytes()); // MAIN length
            v.extend(std::iter::repeat_n(0x22u8, 94));
        });
        samples
    }

    /// THE end-to-end guarantee: one dump whose memory carries one crafted sample of
    /// EVERY supported format — the scan finds each one at its offset with its exact
    /// size, and the extract writes every one of them back byte-identical to the dump's
    /// own bytes.
    #[test]
    fn every_format_is_carved_and_extracts_byte_identical() {
        let mut payload: Vec<u8> = Vec::new();
        let mut expected: Vec<(String, u64, u64, u64)> = Vec::new(); // (format, hit at, size, carve start)
        for (format, sample, hit_at, size) in format_samples() {
            // 64 bytes of non-magic filler between the samples, so neighbouring
            // headers cannot bleed into each other.
            while !payload.len().is_multiple_of(64) {
                payload.push(0xEE);
            }
            let start = payload.len() as u64;
            let size = if size == 0 { sample.len() as u64 } else { size };
            expected.push((format.to_string(), start + hit_at, size, start + hit_at));
            payload.extend_from_slice(&sample);
        }

        let dir = tempfile::tempdir().expect("tempdir");
        let f = crate::fixture::write(
            &dir,
            &[(0x10_0000, payload.len() as u32, r"C:\some\module.dll")],
            &[(0x10_0000, payload.len() as u64)],
            &|buf| buf.extend_from_slice(&payload),
        );
        let mut sink = ggs_base::sink::VecSink(Vec::new());
        let (start, outcome) = scan(
            &f.path,
            &DumpScanOptions {
                formats: Vec::new(),
                min_size: 16,
                max_size: 1024 * 1024,
            },
            &|| false,
            &mut sink,
        )
        .expect("scan");
        assert!(!outcome.cancelled);
        assert_eq!(start.scan_bytes, payload.len() as u64);
        let entries: Vec<CarvedEntry> = sink
            .0
            .into_iter()
            .flat_map(|e| match e {
                DumpEvent::Batch { entries } => entries,
                _ => Vec::new(),
            })
            .collect();

        // Every expected format was found at its offset with its exact size.
        for (format, hit_at, size, carve_at) in &expected {
            let hits: Vec<&CarvedEntry> = entries
                .iter()
                .filter(|e| e.format == *format && e.offset == f.base_rva + hit_at)
                .collect();
            assert_eq!(
                hits.len(),
                1,
                "format {format} at {hit_at}: expected exactly one hit, got {hits:?} ({} entries total)",
                entries.len()
            );
            assert_eq!(hits[0].size, *size, "format {format}: size mismatch");
            assert_eq!(hits[0].offset, f.base_rva + carve_at, "format {format}: carve start");
        }
        // And nothing was invented beyond the catalogue's formats.
        let supported = supported_formats();
        for entry in &entries {
            assert!(
                supported.iter().any(|s| *s == entry.format),
                "unknown format {} reported",
                entry.format
            );
        }

        // The extract writes every carved file back byte-identical.
        let out_dir = dir.path().join("out");
        let requests: Vec<crate::ExtractRequest> = expected
            .iter()
            .map(|(format, _hit_at, size, carve_at)| crate::ExtractRequest {
                kind: "file".to_string(),
                format: format.clone(),
                name: format!("carved.{format}"),
                offset: f.base_rva + carve_at,
                size: *size,
                base: 0,
                module_size: 0,
            })
            .collect();
        let mut progress = ggs_base::sink::VecSink(Vec::new());
        let result = crate::extract_all(&f.path, &requests, &out_dir, &|| false, &mut progress).expect("extract");
        assert!(result.items.iter().all(|i| i.error.is_none()), "{:?}", result.items);
        assert_eq!(result.items.len(), expected.len());
        for (item, (format, _hit_at, size, carve_at)) in result.items.iter().zip(&expected) {
            assert!(item.error.is_none(), "{format}: {}", item.error.as_deref().unwrap_or(""));
            assert_eq!(item.bytes, *size, "{format}");
            let bytes = std::fs::read(&item.path).expect("read extracted");
            assert_eq!(bytes.len() as u64, *size, "{format}");
            assert_eq!(
                bytes.as_slice(),
                &payload[*carve_at as usize..(*carve_at + *size) as usize],
                "{format}: extracted bytes differ"
            );
        }
    }
}
