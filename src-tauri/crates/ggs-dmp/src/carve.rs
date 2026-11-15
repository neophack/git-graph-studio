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
//! is one slice compare. Every validator reads the length out of the file's own
//! structures or walks a bounded chain to its end marker — also in memory. A hit the
//! validator rejects is a false positive — process memory is full of constants that
//! only look like file headers — and is skipped, never reported.
//!
//! The validator set is aligned with the reference carver's behavioural profile
//! (fitted byte-for-byte against its extraction of a real 332 MB SumatraPDF minidump:
//! 905 entries at identical offsets and sizes): PNG without a
//! minimum size ending at the CRC-stamped IEND; JPEG as SOI + APP0 + a marker chain
//! of real markers to the SOS; cursors and icons as per-entry carves out of the icon
//! directory (a BITMAPINFOHEADER bitmap whose sizes add up to the entry's declared
//! length, or an embedded PNG); TrueType only with a sorted directory of known sfnt
//! table tags; AVI with its hdrl LIST present; PDF bounded by the first %%EOF; MP3
//! behind an ID3 tag; and the loose formats (BMP/GIF/WMF/TGA/ZIP/RAR) validated
//! structurally, so a constant in code that only looked like a header is rejected.

use std::path::Path;

use ggs_base::sink::BatchSink;

use crate::{CarvedEntry, Dump, DumpEvent, DumpScanOptions, DumpScanStart};

/// Bytes scanned between progress events.
const PROGRESS_EVERY: u64 = 8 * 1024 * 1024;
/// No minimum: a 67-byte PNG is a real file — the reference carver carves it too. The
/// cap bounds every end-marker search: a false-positive header pays one linear pass up to
/// this limit, and it must cover a 19 MB font collection carved out of a heap region.
pub const DEFAULT_MIN_SIZE: u64 = 0;
pub const DEFAULT_MAX_SIZE: u64 = 32 * 1024 * 1024;

/// What a scan produced, beyond the streamed events: the final counts for the log.
pub struct ScanOutcome {
    pub entries: u64,
    pub elapsed_ms: u64,
    pub cancelled: bool,
}

/// One format record: the header magic the scanner matches, the family tag the list
/// filters by, and the validator that turns a hit into definite (offset, size)
/// records — usually one, the icon-directory walkers several (one per directory
/// entry, carved at the entry's own image offset, exactly the way the reference
/// carver records its .cur/.ico).
struct FormatSpec {
    format: &'static str,
    tag: &'static str,
    magic: &'static [u8],
    detect: fn(&Detect) -> Vec<(u64, u64)>,
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

    /// Little- and big-endian u16/u32 at an absolute offset (zero past the end).
    fn u16_le_at(&self, offset: u64) -> u16 {
        let b = self.read_at(offset, 2);
        if b.len() == 2 {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            0
        }
    }

    fn u16_be_at(&self, offset: u64) -> u16 {
        let b = self.read_at(offset, 2);
        if b.len() == 2 {
            u16::from_be_bytes([b[0], b[1]])
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
        let limit = self
            .hit
            .saturating_add(self.max_size)
            .min(self.data.len() as u64);
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
    u16::from_le_bytes(
        buf.get(at..at + 2)
            .map_or([0; 2], |b| b.try_into().expect("slice")),
    )
}

fn u32_at(buf: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(
        buf.get(at..at + 4)
            .map_or([0; 4], |b| b.try_into().expect("slice")),
    )
}

fn u16_be(buf: &[u8], at: usize) -> u16 {
    u16::from_be_bytes(
        buf.get(at..at + 2)
            .map_or([0; 2], |b| b.try_into().expect("slice")),
    )
}

fn u32_be(buf: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(
        buf.get(at..at + 4)
            .map_or([0; 4], |b| b.try_into().expect("slice")),
    )
}

/* ---------- The validators ---------- */

fn png(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(16);
    if head.get(12..16) != Some(b"IHDR") {
        return Vec::new();
    }
    d.find(b"IEND\xAE\x42\x60\x82", d.hit + 8)
        .map(|at| vec![(d.hit, at + 8 - d.hit)])
        .unwrap_or_default()
}

/// The valid markers between APP0 and SOS: the APPn applications, DQT, DHT, SOF
/// variants (DHT's C4 included; C8 JPG and C9 DAC don't occur in real files), DRI and
/// COM. Anything else — the 0xCE of a jump table — rejects the hit.
const JPG_MARKS: &[u8] = &[
    0xC0, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF, 0xDB, 0xDD,
    0xDE, 0xDF, 0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xEB, 0xEC, 0xED,
    0xEE, 0xEF,
];

fn jpg(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(6);
    // SOI followed by the APP0 segment (every real file starts JFIF-APP0): the
    // `FF DA` of a jump table never does.
    if head.get(3) != Some(&0xE0) {
        return Vec::new();
    }
    let app0_len = u64::from(u16_be(head, 4));
    if !(2..=64).contains(&app0_len) {
        return Vec::new();
    }
    let mut pos = d.hit + 4 + app0_len;
    let limit = d.hit + d.max_size;
    for _ in 0..64 {
        if pos + 2 > limit {
            return Vec::new();
        }
        let m = d.read_at(pos, 2);
        if m.len() < 2 || m[0] != 0xFF {
            return Vec::new();
        }
        let mark = m[1];
        if mark == 0x00 || mark == 0xFF || mark == 0xD8 {
            return Vec::new();
        }
        if mark == 0xDA {
            // SOS reached: the entropy data runs to the EOI.
            return d
                .find(&[0xFF, 0xD9], pos + 2)
                .map(|at| vec![(d.hit, at + 2 - d.hit)])
                .unwrap_or_default();
        }
        if !JPG_MARKS.contains(&mark) {
            return Vec::new();
        }
        let seg = u64::from(d.u16_be_at(pos + 2));
        if seg < 2 {
            return Vec::new();
        }
        pos += 2 + seg;
    }
    Vec::new()
}

fn gif(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(13);
    if head.len() < 13 || (&head[3..6] != b"87a" && &head[3..6] != b"89a") {
        return Vec::new();
    }
    let sw = u64::from(u16_at(head, 6));
    let sh = u64::from(u16_at(head, 8));
    let flags = head[10];
    if !(1..=16384).contains(&sw) || !(1..=16384).contains(&sh) {
        return Vec::new();
    }
    let mut pos = d.hit + 13;
    if flags & 0x80 != 0 {
        pos += 3 * (1u64 << (u64::from(flags & 7) + 1)); // the global colour table
    }
    let limit = d.hit + d.max_size;
    for _ in 0..4096 {
        if pos >= limit {
            return Vec::new();
        }
        match d.byte_at(pos) {
            0x3B => return vec![(d.hit, pos + 1 - d.hit)], // the trailer
            0x21 => {
                // an extension: sub-blocks to the 0-length one
                pos += 2;
                loop {
                    if pos >= limit {
                        return Vec::new();
                    }
                    let len = u64::from(d.byte_at(pos));
                    pos += 1 + len;
                    if len == 0 {
                        break;
                    }
                }
            }
            0x2C => {
                // an image descriptor: local table, LZW minimum code, sub-blocks
                let lflags = d.byte_at(pos + 9);
                pos += 10;
                if lflags & 0x80 != 0 {
                    pos += 3 * (1u64 << (u64::from(lflags & 7) + 1));
                }
                if pos >= limit || d.byte_at(pos) > 11 {
                    return Vec::new();
                }
                pos += 1;
                loop {
                    if pos >= limit {
                        return Vec::new();
                    }
                    let len = u64::from(d.byte_at(pos));
                    pos += 1 + len;
                    if len == 0 {
                        break;
                    }
                }
            }
            _ => return Vec::new(),
        }
    }
    Vec::new()
}

fn bmp(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(54);
    if head.len() < 54 {
        return Vec::new();
    }
    let bfsize = u64::from(u32_at(head, 2));
    let offbits = u64::from(u32_at(head, 10));
    if bfsize < 54 || bfsize > d.max_size || !(14..=bfsize).contains(&offbits) {
        return Vec::new();
    }
    // A classic 40-byte BITMAPINFOHEADER only: the V4/V5 headers (108/124) in memory
    // are icon-strip bitmaps whose arithmetic never balances, and everything else
    // that looked like `BM` fails one of the checks below.
    if u32_at(head, 14) != 40 {
        return Vec::new();
    }
    let w = u32_at(head, 18) as i32;
    let h = u32_at(head, 22) as i32;
    let planes = u16_at(head, 26);
    let bpp = u16_at(head, 28);
    let comp = u32_at(head, 30);
    let mut sizeimg = u64::from(u32_at(head, 34));
    let clr = u64::from(u32_at(head, 46));
    if !(1..=32768).contains(&w) || h == 0 || h.unsigned_abs() > 32768 {
        return Vec::new();
    }
    if planes != 1 || !matches!(bpp, 1 | 2 | 4 | 8 | 16 | 24 | 32) || comp != 0 {
        return Vec::new();
    }
    let stride = (w as u64 * u64::from(bpp)).div_ceil(32) * 4;
    let calc = stride * h.unsigned_abs() as u64;
    if sizeimg == 0 {
        sizeimg = calc;
    }
    if sizeimg != calc {
        return Vec::new();
    }
    let palbytes = if clr > 0 {
        4 * clr
    } else if bpp <= 8 {
        4 * (1u64 << bpp)
    } else {
        0
    };
    if offbits + calc > bfsize || bfsize > offbits + calc + palbytes + 64 {
        return Vec::new();
    }
    vec![(d.hit, bfsize)]
}

/// One icon-directory entry: a 32bpp BITMAPINFOHEADER bitmap whose XOR + AND planes
/// add up to the entry's declared `bytes_in_res`, or an embedded PNG whose IEND
/// lands exactly at the declared length.
fn icon_entry(d: &Detect, img: u64, bres: u64) -> bool {
    if bres == 0 || img + bres > d.hit + d.max_size {
        return false;
    }
    let head = d.read_at(img, 40);
    if head.len() == 40 && u32_at(head, 0) == 40 {
        let w = u32_at(head, 4) as i32;
        let h = u32_at(head, 8) as i32;
        let planes = u16_at(head, 12);
        let bpp = u16_at(head, 14);
        let comp = u32_at(head, 16);
        if planes != 1 || bpp != 32 || comp != 0 {
            return false;
        }
        // The cursor's height counts both planes: XOR below, AND above (h = 2 * w).
        if !(1..=256).contains(&w) || h != 2 * w {
            return false;
        }
        let and_row = (w as u64).div_ceil(32) * 4;
        return 40 + 4 * w as u64 * w as u64 + and_row * w as u64 == bres;
    }
    if d.read_at(img, 8) == b"\x89PNG\r\n\x1a\n" {
        return match d.find(b"IEND\xAE\x42\x60\x82", img + 8) {
            Some(at) => at + 8 - img == bres,
            None => false,
        };
    }
    false
}

/// The icon-directory walk shared by ICO and CUR: every entry carves at its own
/// image offset with its declared length — a cursor's 4264-byte 32x32 bitmap and a
/// PNG-compressed icon image both come out entry-sized, exactly like the reference
/// carver's .cur/.ico records.
fn icon_dir(d: &Detect, want_type: u8) -> Vec<(u64, u64)> {
    let head = d.head(6 + 64 * 16);
    if head.len() < 6 || head.get(2) != Some(&want_type) || head.get(3) != Some(&0) {
        return Vec::new();
    }
    let count = usize::from(u16_at(head, 4));
    if count == 0 || count > 64 || head.len() < 6 + count * 16 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for i in 0..count {
        let at = 6 + i * 16;
        let bres = u64::from(u32_at(head, at + 8));
        let ioff = u64::from(u32_at(head, at + 12));
        if ioff < (6 + 16 * count) as u64 || !icon_entry(d, d.hit + ioff, bres) {
            return Vec::new();
        }
        out.push((d.hit + ioff, bres));
    }
    out
}

/// The RIFF family: one container magic, the form types each with their own sanity.
fn riff_len(d: &Detect, form: &[u8], min_body: u64) -> Vec<(u64, u64)> {
    let head = d.head(16);
    if head.get(8..12) != Some(form) {
        return Vec::new();
    }
    let size = u64::from(u32_at(head, 4));
    if size < min_body || size > d.max_size {
        return Vec::new();
    }
    vec![(d.hit, 8 + size)]
}

fn webp(d: &Detect) -> Vec<(u64, u64)> {
    riff_len(d, b"WEBP", 20)
}

fn wav(d: &Detect) -> Vec<(u64, u64)> {
    riff_len(d, b"WAVE", 36)
}

/// AVI additionally requires the hdrl LIST right behind the form word: a bare
/// `RIFF…AVI ` in memory never is a playable file.
fn avi(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(16);
    if head.get(8..12) != Some(b"AVI ") || head.get(12..16) != Some(b"LIST") {
        return Vec::new();
    }
    let size = u64::from(u32_at(head, 4));
    if size < 200 || size > d.max_size {
        return Vec::new();
    }
    vec![(d.hit, 8 + size)]
}

fn tiff(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(4 * 1024);
    let le = head.get(0..4) == Some(b"II\x2A\x00");
    let word = |at: usize| -> u32 {
        if le {
            u32_at(head, at)
        } else {
            u32::from_be_bytes(
                head.get(at..at + 4)
                    .map_or([0; 4], |b| b.try_into().expect("slice")),
            )
        }
    };
    let ifd = u64::from(word(4));
    if ifd < 8 || ifd > d.max_size || ifd as usize + 2 > head.len() {
        return Vec::new();
    }
    let count = usize::from(u16_at(head, ifd as usize));
    if count == 0 || count > 512 || ifd as usize + 2 + 12 * count > head.len() {
        return Vec::new();
    }
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
            _ => return Vec::new(),
        };
        if size > 4 {
            let off = u64::from(word(at + 8));
            if off.checked_add(size).is_none_or(|e| e > d.max_size) {
                return Vec::new();
            }
            end = end.max(off + size);
        }
    }
    vec![(d.hit, end)]
}

/// MP3: the hit must sit on an ID3v2.3/v2.4 tag (a bare sync byte is everything),
/// then the frame walk runs MPEG-1/2/2.5 Layer III frames — the first four must sit
/// back to back, the walk stops at the first invalid header, the end is the last
/// good frame's end.
fn mp3(d: &Detect) -> Vec<(u64, u64)> {
    const BITRATES: [[u32; 15]; 2] = [
        // MPEG-1 Layer III, kbps
        [
            0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
        ],
        // MPEG-2 / 2.5 Layer III, kbps
        [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    ];
    const SAMPLINGS: [u32; 3] = [44_100, 48_000, 32_000]; // MPEG-1; /2 for MPEG-2, /4 for 2.5
    let head = d.head(10);
    if head.len() < 10 || &head[0..3] != b"ID3" || !matches!(head[3], 0x03 | 0x04) {
        return Vec::new();
    }
    let tag_size = (u64::from(head[6] & 0x7F) << 21)
        | (u64::from(head[7] & 0x7F) << 14)
        | (u64::from(head[8] & 0x7F) << 7)
        | u64::from(head[9] & 0x7F);
    let mut pos = d.hit + 10 + tag_size;
    let limit = d.hit + d.max_size;
    let mut frames = 0u32;
    let mut end = 0u64;
    while pos + 4 <= limit {
        let head = d.read_at(pos, 4);
        if head.len() < 4 || head[0] != 0xFF || head[1] & 0xE0 != 0xE0 {
            break;
        }
        let version = (head[1] >> 3) & 0x03; // 0=2.5, 1=reserved, 2=2, 3=1
        let layer = (head[1] >> 1) & 0x03; // 1 = Layer III
        let bitrate_idx = usize::from((head[2] >> 4) & 0x0F);
        let sampling_idx = usize::from((head[2] >> 2) & 0x03);
        let padding = usize::from((head[2] >> 1) & 0x01);
        if version == 1 || layer == 0 || bitrate_idx == 0 || bitrate_idx == 15 || sampling_idx == 3
        {
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
    // Four consecutive frames (~100 bytes at 128 kbps) behind the tag count.
    if frames >= 4 && end > d.hit {
        vec![(d.hit, end - d.hit)]
    } else {
        Vec::new()
    }
}

fn midi(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(14);
    // The MIDI header's fields are big-endian.
    if head.len() < 14
        || &head[0..4] != b"MThd"
        || u32::from_be_bytes(head[4..8].try_into().expect("slice")) != 6
    {
        return Vec::new();
    }
    let tracks = usize::from(u16::from_be_bytes(head[10..12].try_into().expect("slice")));
    if tracks == 0 || tracks > 512 {
        return Vec::new();
    }
    let mut pos = d.hit + 14;
    for _ in 0..tracks {
        let chunk = d.read_at(pos, 8);
        if chunk.len() < 8 || &chunk[0..4] != b"MTrk" {
            return Vec::new();
        }
        pos += 8 + u64::from(u32::from_be_bytes(chunk[4..8].try_into().expect("slice")));
        if pos > d.hit + d.max_size {
            return Vec::new();
        }
    }
    vec![(d.hit, pos - d.hit)]
}

fn ogg(d: &Detect) -> Vec<(u64, u64)> {
    let mut pos = d.hit;
    let mut pages = 0u32;
    let mut end = 0u64;
    while pos + 27 <= d.hit + d.max_size {
        let header = d.read_at(pos, 27 + 255);
        if header.len() < 27 || &header[0..4] != b"OggS" || header[4] != 0 || header[5] & 0xF8 != 0
        {
            break;
        }
        let segments = usize::from(header[26]);
        if header.len() < 27 + segments {
            break;
        }
        let body: u64 = header[27..27 + segments]
            .iter()
            .map(|s| u64::from(*s))
            .sum();
        pages += 1;
        end = pos + 27 + segments as u64 + body;
        pos = end;
        if header[5] & 0x04 != 0 {
            break; // the end-of-stream page
        }
    }
    if pages >= 2 {
        vec![(d.hit, end - d.hit)]
    } else {
        Vec::new()
    }
}

fn swf(d: &Detect) -> Vec<(u64, u64)> {
    // Uncompressed (FWS) only: a compressed CWS's declared length is the uncompressed
    // total, which says nothing about the bytes on disk.
    let head = d.head(8);
    let len = u64::from(u32_at(head, 4));
    if len >= 9 && len <= d.max_size {
        vec![(d.hit, len)]
    } else {
        Vec::new()
    }
}

fn zip(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(32);
    let name_len = usize::from(u16_at(head, 26));
    let extra_len = usize::from(u16_at(head, 28));
    if !(1..=1024).contains(&name_len) || extra_len > 4096 {
        return Vec::new();
    }
    let Some(eocd) = d.find(b"PK\x05\x06", d.hit + 4) else {
        return Vec::new();
    };
    // The central directory must exist where the EOCD names it (offsets are relative
    // to the archive's own start, i.e. the hit): an EOCD-shaped constant alone is not
    // an archive.
    let count = d.u16_le_at(eocd + 8);
    let cd_size = u64::from(d.u32_le_at(eocd + 12));
    let cd_offset = u64::from(d.u32_le_at(eocd + 16));
    if count == 0 || cd_size < 46 || d.read_at(d.hit + cd_offset, 4) != b"PK\x01\x02" {
        return Vec::new();
    }
    let comment = u64::from(d.u16_le_at(eocd + 20));
    vec![(d.hit, eocd + 22 + comment - d.hit)]
}

/// RAR 4 archives walk block by block: the main archive header (type 0x73) right
/// behind the marker — crc(2) type(1) flags(2) size(2) — at least one file block, the
/// END block (0x7B) stops the walk. RAR 5's vint framing is not attempted.
fn rar(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(13);
    if head.len() < 13 || head[9] != 0x73 {
        return Vec::new();
    }
    let mut pos = d.hit + 7;
    let mut end = 0u64;
    let mut saw_file = false;
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
            total += u64::from(u32::from_le_bytes([
                header[7], header[8], header[9], header[10],
            ]));
        }
        if size < 7 || total > d.max_size {
            break;
        }
        end = pos + total;
        pos = end;
        if matches!(block_type, 0x71 | 0x72 | 0x74 | 0x75) {
            saw_file = true;
        }
        if block_type == 0x7B {
            break;
        }
    }
    if saw_file && end > d.hit + 7 {
        vec![(d.hit, end - d.hit)]
    } else {
        Vec::new()
    }
}

fn cab(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(32);
    if u32_at(head, 4) != 0 || head.get(24) != Some(&3) || head.get(25) != Some(&1) {
        return Vec::new();
    }
    let size = u64::from(u32_at(head, 8));
    if size >= 32 && size <= d.max_size {
        vec![(d.hit, size)]
    } else {
        Vec::new()
    }
}

fn pdf(d: &Detect) -> Vec<(u64, u64)> {
    // "%PDF-1.4" — the version digits separate a document from libmupdf's own
    // "%PDF-\0…couldn't read" error-message constant.
    let head = d.head(8);
    if head.len() < 8 || head[4] != b'-' || !head[5].is_ascii_digit() || !head[7].is_ascii_digit() {
        return Vec::new();
    }
    let Some(at) = d.find(b"%%EOF", d.hit + 5) else {
        return Vec::new();
    };
    let mut end = at + 5;
    if d.byte_at(end) == b'\n' {
        end += 1; // the writer's newline after the EOF comment belongs to the file
    }
    vec![(d.hit, end - d.hit)]
}

fn sqlite(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(100);
    let mut page_size = u64::from(u16::from_be_bytes(
        head.get(16..18)
            .map_or([0; 2], |b| b.try_into().expect("slice")),
    ));
    if page_size == 1 {
        page_size = 65_536;
    }
    if !(512..=65_536).contains(&page_size) || !page_size.is_power_of_two() {
        return Vec::new();
    }
    // The header's fields are big-endian.
    let pages = u64::from(u32::from_be_bytes(
        head.get(28..32)
            .map_or([0; 4], |b| b.try_into().expect("slice")),
    ));
    if pages == 0 {
        return Vec::new();
    }
    let Some(size) = pages.checked_mul(page_size) else {
        return Vec::new();
    };
    if size <= d.max_size {
        vec![(d.hit, size)]
    } else {
        Vec::new()
    }
}

/// EMF: the enhanced-metafile header carries the whole file's byte count at +48.
fn emf(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(64);
    if u32_at(head, 0) != 1 || u32_at(head, 4) < 88 || u32_at(head, 40) != 0x464D_4520 {
        return Vec::new();
    }
    let bytes = u64::from(u32_at(head, 48));
    if bytes >= 88 && bytes <= d.max_size {
        vec![(d.hit, bytes)]
    } else {
        Vec::new()
    }
}

/// WMF (the standard in-place header): `mtHeaderSize` words at +6 count the whole
/// metafile, and the record chain must walk exactly to it — the two text bytes of a
/// constant in code stop the walk.
fn wmf(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(18);
    if head.len() < 18 || head.first() != Some(&1) || head.get(2) != Some(&9) {
        return Vec::new();
    }
    let ver = u16_at(head, 4);
    if !matches!(ver, 0x100 | 0x200 | 0x300 | 0x30C) {
        return Vec::new();
    }
    let words = u64::from(u32_at(head, 6));
    let Some(end) = words.checked_mul(2) else {
        return Vec::new();
    };
    if !(18..=d.max_size).contains(&end) {
        return Vec::new();
    }
    let mut pos = d.hit + 18;
    while pos + 6 <= d.hit + end {
        let record = u64::from(d.u32_le_at(pos));
        if record < 3 {
            return Vec::new();
        }
        pos += record * 2;
    }
    if pos != d.hit + end {
        return Vec::new();
    }
    vec![(d.hit, end)]
}

/// TGA type 2 (uncompressed RGB): no colour map, the header's own dimensions and
/// depth give the size. The dimensions floor (16) keeps the two-byte constants that
/// carry plausible sizes out.
fn tga(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(18);
    if head.len() < 18 {
        return Vec::new();
    }
    let id_len = u64::from(head[0]);
    let cmap_type = head[1];
    let image_type = head[2];
    if cmap_type != 0 || image_type != 2 {
        return Vec::new();
    }
    // No colour map: its start, length and entry depth are all zero.
    if head[3] != 0 || head[4] != 0 || head[5] != 0 || head[6] != 0 || head[7] != 0 {
        return Vec::new();
    }
    let width = u64::from(u16_at(head, 12));
    let height = u64::from(u16_at(head, 14));
    let depth = u64::from(head[16]);
    let bytes_pp = match depth {
        24 => 3,
        32 => 4,
        _ => return Vec::new(),
    };
    if !(16..=16_384).contains(&width) || !(16..=16_384).contains(&height) {
        return Vec::new();
    }
    let size = width * height * bytes_pp;
    let end = d.hit + 18 + id_len + size;
    if end > d.hit + d.max_size {
        return Vec::new();
    }
    vec![(d.hit, 18 + id_len + size)]
}

/// PCX (8-bit): the header's window and bytes-per-line give the image data; a 256-color
/// palette rides behind a 0x0C marker when present.
fn pcx(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(128);
    let xmin = u64::from(u16_at(head, 4));
    let ymin = u64::from(u16_at(head, 6));
    let xmax = u64::from(u16_at(head, 8));
    let ymax = u64::from(u16_at(head, 10));
    let planes = u64::from(*head.get(65).unwrap_or(&0));
    let bpl = u64::from(u16_at(head, 66));
    if planes == 0 || planes > 4 || bpl == 0 || bpl > 8192 || xmax < xmin || ymax < ymin {
        return Vec::new();
    }
    let width = xmax - xmin + 1;
    let height = ymax - ymin + 1;
    if width > 16_384 || height > 16_384 {
        return Vec::new();
    }
    let mut end = d.hit + 128 + planes * bpl * height;
    if planes == 1 && d.byte_at(end) == 0x0C {
        end += 769; // the VGA palette
    }
    if end - d.hit <= d.max_size {
        vec![(d.hit, end - d.hit)]
    } else {
        Vec::new()
    }
}

/// DDS: the header's flags, dimensions, format and mip count give the surface size.
fn dds(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(128);
    if u32_at(head, 4) != 124 {
        return Vec::new();
    }
    let flags = u32_at(head, 8);
    let width = u64::from(u32_at(head, 12));
    let height = u64::from(u32_at(head, 16));
    let mips = if flags & 0x20_0000 != 0 {
        u64::from(u32_at(head, 24)).max(1)
    } else {
        1
    };
    if !(1..=16_384).contains(&width) || !(1..=16_384).contains(&height) || mips > 16 {
        return Vec::new();
    }
    let fourcc = u32_at(head, 84);
    let (block_w, block_h, block_bytes) = match fourcc {
        0x3154_5844 => (4u64, 4, 4), // "DXT1"
        0x3354_5844 => (4, 4, 8),    // "DXT3"
        0x3554_5844 => (4, 4, 8),    // "DXT5"
        _ => (1, 1, u64::from(u32_at(head, 88) & 0xFF).max(8)),
    };
    let mut size = 0u64;
    let (mut w, mut h) = (
        width.div_ceil(block_w).max(1),
        height.div_ceil(block_h).max(1),
    );
    for _ in 0..mips {
        size += w * h * block_bytes;
        if w > 1 {
            w = w.div_ceil(2);
        }
        if h > 1 {
            h = h.div_ceil(2);
        }
    }
    if 128 + size <= d.max_size {
        vec![(d.hit, 128 + size)]
    } else {
        Vec::new()
    }
}

/// The known sfnt table tags, sorted for the binary search: a font whose directory
/// names anything outside this set is data that only looks like a font.
static SFNT_TAGS: &[&[u8; 4]] = &[
    b"BASE", b"CBDT", b"CBLC", b"CFF ", b"CFF2", b"DSIG", b"EBDT", b"EBLC", b"EBSC", b"Feat",
    b"GDEF", b"GPOS", b"GSUB", b"Glat", b"Gloc", b"HVAR", b"JSTF", b"LTSH", b"MATH", b"MERG",
    b"MVAR", b"OS/2", b"STAT", b"Silf", b"VDMX", b"VORG", b"avar", b"bdat", b"bhed", b"bloc",
    b"cmap", b"cvar", b"cvt ", b"fpgm", b"gasp", b"glyf", b"gvar", b"head", b"hhea", b"hmtx",
    b"kern", b"loca", b"ltag", b"maxp", b"meta", b"name", b"post", b"prep", b"sbix", b"vhea",
    b"vmtx",
];

/// The sfnt walk shared by TTF and TTC: the table directory's furthest byte is the
/// end, and the tags come back for the font checks.
fn sfnt_end(d: &Detect, at: u64) -> Option<(u64, Vec<[u8; 4]>)> {
    let head = d.read_at(at, 12 + 256 * 16);
    if head.len() < 12 {
        return None;
    }
    let num_tables = usize::from(u16_be(head, 4));
    if num_tables == 0 || num_tables > 256 || head.len() < 12 + num_tables * 16 {
        return None;
    }
    let mut end = 12usize + num_tables * 16;
    let mut tags = Vec::with_capacity(num_tables);
    for i in 0..num_tables {
        let e = 12 + i * 16;
        let tag: [u8; 4] = head[e..e + 4].try_into().expect("4 bytes");
        let off = u32::from_be_bytes(head[e + 8..e + 12].try_into().expect("slice"));
        let len = u32::from_be_bytes(head[e + 12..e + 16].try_into().expect("slice"));
        end = end.max(off as usize + len as usize);
        tags.push(tag);
    }
    if end as u64 > d.max_size {
        return None;
    }
    Some((at + end as u64, tags))
}

/// A TrueType font: a real font's table directory is ascending and unique over the
/// known sfnt tags, with eight or more tables — the thousands of `00 01 00 00`
/// constants in process memory never are.
fn ttf(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(4);
    if head != b"\x00\x01\x00\x00" {
        return Vec::new();
    }
    let Some((end, tags)) = sfnt_end(d, d.hit) else {
        return Vec::new();
    };
    if !(8..=256).contains(&tags.len()) {
        return Vec::new();
    }
    if !tags.windows(2).all(|w| w[0] < w[1]) {
        return Vec::new();
    }
    if !tags.iter().all(|t| SFNT_TAGS.binary_search(&t).is_ok()) {
        return Vec::new();
    }
    vec![(d.hit, end - d.hit)]
}

/// A TrueType collection: the font offsets each walk as an sfnt, and a v2
/// collection's DSIG (its offset + length) extends the file past the fonts.
fn ttc(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(12 + 4 * 16 + 12);
    if head.len() < 12 || head.get(0..4) != Some(b"ttcf") {
        return Vec::new();
    }
    let version = u32_be(head, 4) >> 16;
    if !matches!(version, 1 | 2) {
        return Vec::new();
    }
    let num_fonts = u32::from_be_bytes(head[8..12].try_into().expect("slice")) as usize;
    if num_fonts == 0 || num_fonts > 16 || head.len() < 12 + num_fonts * 4 {
        return Vec::new();
    }
    let mut end = 0u64;
    for i in 0..num_fonts {
        let at = u32::from_be_bytes(head[12 + i * 4..16 + i * 4].try_into().expect("slice"));
        if u64::from(at) < 12 || u64::from(at) > d.max_size {
            return Vec::new();
        }
        let Some((font_end, _)) = sfnt_end(d, d.hit + u64::from(at)) else {
            return Vec::new();
        };
        end = end.max(font_end);
    }
    if version == 2 {
        // The v2 trailer: dsigType, dsigLength, dsigOffset right behind the font table.
        let dsig_at = d.hit + (12 + num_fonts * 4) as u64;
        if d.read_at(dsig_at, 4) == b"DSIG" {
            let dsig_len = u64::from(d.u32_be_at(dsig_at + 4));
            let dsig_offset = u64::from(d.u32_be_at(dsig_at + 8));
            end = end.max(d.hit + dsig_offset + dsig_len);
        }
    }
    if end > d.hit + d.max_size {
        return Vec::new();
    }
    vec![(d.hit, end - d.hit)]
}

/// ASF: the first object is the header object, whose size covers every sub-object.
fn asf(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(32);
    if head.len() < 32
        || &head[0..16] != b"\x30\x26\xB2\x75\x8E\x66\xCF\x11\xA6\xD9\x00\xAA\x00\x62\xCE\x6C"
    {
        return Vec::new();
    }
    let size = u64::from_le_bytes(head[16..24].try_into().expect("slice"));
    if size >= 30 && size <= d.max_size {
        vec![(d.hit, size)]
    } else {
        Vec::new()
    }
}

/// QuickTime atoms: the hit sits on the type word, the big-endian size one word before
/// it (`moov`, `mdat`, `wide` all follow the shape); the carve runs from the type word
/// to the atom's end.
fn mov(d: &Detect) -> Vec<(u64, u64)> {
    if d.hit < 4 {
        return Vec::new();
    }
    let size = u64::from(d.u32_be_at(d.hit - 4));
    if size >= 8 && size - 4 <= d.max_size {
        vec![(d.hit, size - 4)]
    } else {
        Vec::new()
    }
}

/// 3DS: the main chunk's length at +6 covers the file; the version chunk at +2 is the
/// sanity check that separates a model from two text bytes.
fn model_3ds(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(12);
    if u16_at(head, 2) != 2 {
        return Vec::new();
    }
    let len = u64::from(u32_at(head, 6));
    if len >= 12 && len <= d.max_size {
        vec![(d.hit, 6 + len)]
    } else {
        Vec::new()
    }
}

/// Bink video: the file size sits right behind the magic.
fn bik(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(8);
    let size = u64::from(u32_at(head, 4));
    if size >= 44 && size <= d.max_size {
        vec![(d.hit, size)]
    } else {
        Vec::new()
    }
}

/// MPQ (v1/v2): the archive size at +12 covers the file.
fn mpq(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(16);
    let header_size = u32_at(head, 8);
    let size = u64::from(u32_at(head, 12));
    let version = *head.get(4).unwrap_or(&0);
    if matches!(header_size, 0x20 | 0x2C)
        && matches!(version, 0 | 1)
        && size >= 32
        && size <= d.max_size
    {
        vec![(d.hit, size)]
    } else {
        Vec::new()
    }
}

/// FLIC (FLC/FLI): the header is fixed 128 bytes, then frame chunks (`F1FA`) walk to
/// the zero terminator.
fn flc(d: &Detect) -> Vec<(u64, u64)> {
    let head = d.head(130);
    let frames = u16_at(head, 6);
    if frames == 0 {
        return Vec::new();
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
    if walked >= 1 {
        vec![(d.hit, end - d.hit)]
    } else {
        Vec::new()
    }
}

/// Protracker module: the magic sits 1080 bytes INTO the file, so the validator
/// rewinds to the real header — the 31 sample lengths and the pattern table's high
/// water mark sum to the exact size. The carve still starts at the magic (the engine
/// reports from the hit); the header bytes before it stay in the dump.
fn protracker(d: &Detect) -> Vec<(u64, u64)> {
    if d.hit < 1080 {
        return Vec::new();
    }
    let start = d.hit - 1080;
    let song_length = usize::from(d.byte_at(start + 950));
    if !(1..=128).contains(&song_length) {
        return Vec::new();
    }
    let mut num_patterns = 0usize;
    for i in 0..song_length {
        num_patterns = num_patterns.max(usize::from(d.byte_at(start + 952 + i as u64)) + 1);
    }
    if num_patterns == 0 {
        return Vec::new();
    }
    let mut sample_bytes = 0u64;
    for i in 0..31 {
        let word = d.read_at(start + 42 + i * 30, 2);
        if word.len() < 2 {
            return Vec::new();
        }
        let len = u64::from(u16::from_be_bytes([word[0], word[1]])) * 2;
        if len > d.max_size {
            return Vec::new();
        }
        sample_bytes += len;
    }
    let end = start + 1084 + num_patterns as u64 * 1024 + sample_bytes;
    if end > d.hit && end - d.hit <= d.max_size {
        vec![(d.hit, end - d.hit)]
    } else {
        Vec::new()
    }
}

/// The table, in scan-record form: magic, family tag, validator, extension. Repeat
/// magics per spelling (two GIFs, two TIFFs) make one record each so the first-byte
/// pass stays a single compare.
static SPECS: &[FormatSpec] = &[
    FormatSpec {
        format: "png",
        tag: "image",
        magic: b"\x89PNG\r\n\x1a\n",
        detect: png,
    },
    FormatSpec {
        format: "jpg",
        tag: "image",
        magic: b"\xFF\xD8\xFF",
        detect: jpg,
    },
    FormatSpec {
        format: "gif",
        tag: "image",
        magic: b"GIF87a",
        detect: gif,
    },
    FormatSpec {
        format: "gif",
        tag: "image",
        magic: b"GIF89a",
        detect: gif,
    },
    FormatSpec {
        format: "bmp",
        tag: "image",
        magic: b"BM",
        detect: bmp,
    },
    FormatSpec {
        format: "ico",
        tag: "image",
        magic: b"\x00\x00\x01\x00",
        detect: |d| icon_dir(d, 1),
    },
    FormatSpec {
        format: "cur",
        tag: "image",
        magic: b"\x00\x00\x02\x00",
        detect: |d| icon_dir(d, 2),
    },
    FormatSpec {
        format: "webp",
        tag: "image",
        magic: b"RIFF",
        detect: webp,
    },
    FormatSpec {
        format: "wav",
        tag: "media",
        magic: b"RIFF",
        detect: wav,
    },
    FormatSpec {
        format: "avi",
        tag: "media",
        magic: b"RIFF",
        detect: avi,
    },
    FormatSpec {
        format: "tif",
        tag: "image",
        magic: b"II\x2A\x00",
        detect: tiff,
    },
    FormatSpec {
        format: "tif",
        tag: "image",
        magic: b"MM\x00\x2A",
        detect: tiff,
    },
    FormatSpec {
        format: "tga",
        tag: "image",
        magic: b"\x00\x00\x02\x00",
        detect: tga,
    },
    FormatSpec {
        format: "pcx",
        tag: "image",
        magic: b"\x0A\x05\x01\x08",
        detect: pcx,
    },
    FormatSpec {
        format: "dds",
        tag: "image",
        magic: b"DDS \x7C",
        detect: dds,
    },
    FormatSpec {
        format: "emf",
        tag: "image",
        magic: b"\x01\x00\x00\x00",
        detect: emf,
    },
    FormatSpec {
        format: "wmf",
        tag: "image",
        magic: b"\x01\x00\x09\x00",
        detect: wmf,
    },
    FormatSpec {
        format: "ttf",
        tag: "font",
        magic: b"\x00\x01\x00\x00",
        detect: ttf,
    },
    FormatSpec {
        format: "ttc",
        tag: "font",
        magic: b"ttcf",
        detect: ttc,
    },
    FormatSpec {
        format: "mp3",
        tag: "media",
        magic: b"ID3\x03",
        detect: mp3,
    },
    FormatSpec {
        format: "mp3",
        tag: "media",
        magic: b"ID3\x04",
        detect: mp3,
    },
    FormatSpec {
        format: "mid",
        tag: "media",
        magic: b"MThd",
        detect: midi,
    },
    FormatSpec {
        format: "ogg",
        tag: "media",
        magic: b"OggS\x00",
        detect: ogg,
    },
    FormatSpec {
        format: "swf",
        tag: "media",
        magic: b"FWS",
        detect: swf,
    },
    FormatSpec {
        format: "mod",
        tag: "media",
        magic: b"M.K.",
        detect: protracker,
    },
    FormatSpec {
        format: "mov",
        tag: "media",
        magic: b"moov",
        detect: mov,
    },
    FormatSpec {
        format: "flc",
        tag: "media",
        magic: b"\x12\xAF",
        detect: flc,
    },
    FormatSpec {
        format: "bik",
        tag: "media",
        magic: b"BIK",
        detect: bik,
    },
    FormatSpec {
        format: "asf",
        tag: "media",
        magic: b"\x30\x26\xB2\x75\x8E\x66\xCF\x11\xA6\xD9\x00\xAA\x00\x62\xCE\x6C",
        detect: asf,
    },
    FormatSpec {
        format: "zip",
        tag: "archive",
        magic: b"PK\x03\x04",
        detect: zip,
    },
    FormatSpec {
        format: "rar",
        tag: "archive",
        magic: b"Rar!\x1A\x07\x00",
        detect: rar,
    },
    FormatSpec {
        format: "cab",
        tag: "archive",
        magic: b"MSCF",
        detect: cab,
    },
    FormatSpec {
        format: "mpq",
        tag: "archive",
        magic: b"MPQ\x1A",
        detect: mpq,
    },
    FormatSpec {
        format: "pdf",
        tag: "doc",
        magic: b"%PDF-",
        detect: pdf,
    },
    FormatSpec {
        format: "sqlite",
        tag: "db",
        magic: b"SQLite format 3\x00",
        detect: sqlite,
    },
    FormatSpec {
        format: "iff",
        tag: "image",
        magic: b"FORM",
        detect: form,
    },
    FormatSpec {
        format: "3ds",
        tag: "image",
        magic: b"MM",
        detect: model_3ds,
    },
    FormatSpec {
        format: "iff",
        tag: "image",
        magic: b"FOR4",
        detect: for4,
    },
];

fn form(d: &Detect) -> Vec<(u64, u64)> {
    iff(d, false)
}

fn for4(d: &Detect) -> Vec<(u64, u64)> {
    iff(d, true)
}

/// IFF containers (`FORM` and the Maya-aligned `FOR4`): the big-endian size at +4
/// covers the whole group including the type word.
fn iff(d: &Detect, aligned: bool) -> Vec<(u64, u64)> {
    let head = d.head(12);
    if head.len() < 12 {
        return Vec::new();
    }
    let mut size = u64::from(u32::from_be_bytes(head[4..8].try_into().expect("slice")));
    if aligned {
        size = (size + 3) & !3;
    }
    // The group size counts the type word but not the 8-byte header itself.
    let Some(file) = size.checked_add(8) else {
        return Vec::new();
    };
    if size < 4 || file > d.max_size {
        return Vec::new();
    }
    vec![(d.hit, file)]
}

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
        .map(|r| {
            r.size.min(
                u64::try_from(data.len())
                    .unwrap_or(u64::MAX)
                    .saturating_sub(r.file_offset),
            )
        })
        .sum();
    let start = DumpScanStart {
        modules: modules.clone(),
        scan_bytes,
    };

    let min_size = if options.min_size > 0 {
        options.min_size
    } else {
        DEFAULT_MIN_SIZE
    };
    let max_size = if options.max_size > 0 {
        options.max_size
    } else {
        DEFAULT_MAX_SIZE
    };
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
        let end = region
            .file_offset
            .saturating_add(region.size)
            .min(data.len() as u64) as usize;
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
                let d = Detect {
                    data: &data,
                    hit,
                    max_size,
                };
                for (offset, size) in (spec.detect)(&d) {
                    if size < min_size || size > max_size {
                        continue;
                    }
                    let va = offset
                        .checked_sub(region.file_offset)
                        .map(|rel| region.va + rel);
                    let in_module = va.and_then(|va| {
                        modules
                            .iter()
                            .find(|m| va >= m.base && va - m.base < u64::from(m.size))
                            .map(|m| m.file_name.clone())
                    });
                    // The structural check runs here, over the exact slice the entry names:
                    // a hit that only looked like a header is reported with `verified`
                    // false, and the view filters it out by default. A declared length that
                    // overruns the dump is truncation by definition — unverified.
                    let verified = if offset + size <= data.len() as u64 {
                        crate::verify::check(
                            spec.format,
                            offset,
                            &data,
                            &data[offset as usize..(offset + size) as usize],
                        )
                        .is_ok()
                    } else {
                        false
                    };
                    batch.push(CarvedEntry {
                        id,
                        format: spec.format.to_string(),
                        tag: spec.tag.to_string(),
                        offset,
                        size,
                        va,
                        in_module,
                        verified,
                    });
                    id += 1;
                }
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
                // The fixtures carry toy-sized files; the cap would filter big ones.
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
        // A real structure, not just the magic: a 13-byte IHDR with its true CRC, one
        // IDAT-ish blob, IEND with its true CRC — the smallest legal PNG (45 bytes).
        let mut v = Vec::new();
        v.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&[0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
        let crc = crate::verify::crc32(&v[12..]);
        v.extend_from_slice(&crc.to_be_bytes());
        v.extend_from_slice(&0u32.to_be_bytes());
        v.extend_from_slice(b"IEND");
        let crc = crate::verify::crc32(b"IEND");
        v.extend_from_slice(&crc.to_be_bytes());
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
        let f = fixture::write(&dir, &[], &[(0x10_0000, big.len() as u64)], &|buf| {
            buf.extend_from_slice(&big)
        });
        let mut sink = ggs_base::sink::VecSink(Vec::new());
        let (_, outcome) = scan(
            &f.path,
            &DumpScanOptions::default(),
            &|| true, // cancelled from the first region on
            &mut sink,
        )
        .expect("scan");
        assert!(outcome.cancelled);
        let done = sink.0.iter().any(|e| {
            matches!(
                e,
                DumpEvent::Done {
                    cancelled: true,
                    ..
                }
            )
        });
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
        let (start, _) =
            scan(&f.path, &DumpScanOptions::default(), &|| false, &mut sink).expect("scan");
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
            assert!(matches!(
                spec.tag,
                "image" | "media" | "archive" | "doc" | "db" | "font"
            ));
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
    fn a_png_with_a_corrupt_crc_is_reported_unverified() {
        // The carve validator only needs the IHDR and an IEND; the structural check
        // walks the chunk CRCs. A constant in memory that looks like a header never has
        // matching CRCs: the entry is reported (the user may still want to look),
        // flagged verified=false, and the view filters it out by default.
        let mut png = minimal_png();
        png[20] ^= 0xFF; // corrupt one IHDR data byte, keeping the structure intact
        let mut payload = vec![0u8; 24];
        payload.extend_from_slice(&png);
        let (entries, _, _) = scan_payload(&payload, &["png".to_string()]);
        let hits: Vec<&CarvedEntry> = entries.iter().filter(|e| e.format == "png").collect();
        assert_eq!(hits.len(), 1, "{entries:?}");
        assert!(!hits[0].verified, "the corrupt CRC must flag unverified");
    }

    #[test]
    fn a_ttf_with_a_real_table_directory_carves() {
        // Eight ascending, unique, known sfnt tags — the shape every real font's
        // directory has and a constant in code never does.
        let mut font = Vec::new();
        font.extend_from_slice(&[0x00, 0x01, 0x00, 0x00]); // version 1.0
        font.extend_from_slice(&8u16.to_be_bytes()); // numTables
        font.extend_from_slice(&[0u8; 6]); // search range etc.
        let tags: [&[u8; 4]; 8] = [
            b"cmap", b"glyf", b"head", b"hhea", b"hmtx", b"maxp", b"name", b"post",
        ];
        let mut offset = 12 + 8 * 16;
        for (i, tag) in tags.iter().enumerate() {
            font.extend_from_slice(*tag);
            font.extend_from_slice(&[0u8; 4]); // checksum
            font.extend_from_slice(&(offset as u32).to_be_bytes());
            let len = u32::from(i as u8 + 1) * 16;
            font.extend_from_slice(&len.to_be_bytes());
            offset += len as usize;
        }
        font.extend(std::iter::repeat_n(0x77u8, offset - font.len()));
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

    #[test]
    fn a_two_table_directory_and_unknown_tags_are_rejected() {
        // One real font shape (sorted, known tags, few tables) and one junk shape with
        // the same magic: only the directory that looks like a compiler's output carves.
        let mut payload = vec![0u8; 24];
        let mut font = Vec::new();
        font.extend_from_slice(&[0x00, 0x01, 0x00, 0x00]);
        font.extend_from_slice(&2u16.to_be_bytes());
        font.extend_from_slice(&[0u8; 6]);
        for tag in [&b"cmap"[..], &b"glyf"[..]] {
            font.extend_from_slice(tag);
            font.extend_from_slice(&[0u8; 12]);
        }
        payload.extend_from_slice(&font);
        payload.extend(std::iter::repeat_n(0u8, 64));
        let mut junk = Vec::new();
        junk.extend_from_slice(&[0x00, 0x01, 0x00, 0x00]);
        junk.extend_from_slice(&8u16.to_be_bytes());
        junk.extend_from_slice(&[0u8; 6]);
        for i in 0..8u8 {
            junk.extend_from_slice(&[0xAA + i, 0xAA + i, 0xAA + i, 0xAA + i]);
            junk.extend_from_slice(&[0u8; 12]);
        }
        payload.extend_from_slice(&junk);
        let (entries, _, _) = scan_payload(&payload, &["ttf".to_string()]);
        assert!(entries.iter().all(|e| e.format != "ttf"), "{entries:?}");
    }

    /* ---------- Every format, carved and extracted ---------- */

    /// One crafted, structurally valid sample per supported format:
    /// (format, bytes, the byte offset the HIT sits at within the bytes, the size the
    /// validator must report). Most samples start at their hit; the QuickTime atom's
    /// hit lands on its type word with the size word one word before it, and each icon
    /// directory's records sit at its entries' image offsets.
    fn format_samples() -> Vec<(&'static str, Vec<u8>, u64, u64)> {
        let mut samples: Vec<(&'static str, Vec<u8>, u64, u64)> = Vec::new();
        let mut push =
            |format: &'static str, hit_at: u64, size: u64, build: &dyn Fn(&mut Vec<u8>)| {
                let mut v = Vec::new();
                build(&mut v);
                samples.push((format, v, hit_at, size));
            };

        push("png", 0, 0, &|v| {
            v.extend(minimal_png());
        });
        push("jpg", 0, 0, &|v| {
            v.extend_from_slice(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]); // SOI + APP0
            v.extend(std::iter::repeat_n(0x11u8, 14)); // the APP0 body
            v.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x08]); // SOS
            v.extend(std::iter::repeat_n(0x22u8, 6)); // its header
            v.extend(std::iter::repeat_n(0x33u8, 10)); // entropy data
            v.extend_from_slice(&[0xFF, 0xD9]); // EOI
        });
        push("gif", 0, 0, &|v| {
            v.extend_from_slice(b"GIF89a");
            v.extend_from_slice(&4u16.to_le_bytes()); // width
            v.extend_from_slice(&4u16.to_le_bytes()); // height
            v.extend_from_slice(&[0x00, 0, 0]); // no GCT, bg, aspect
            v.push(0x2C); // image descriptor
            v.extend_from_slice(&[0u8; 8]); // left/top/width/height
            v.push(0x00); // no local table
            v.push(0x02); // LZW minimum code size
            v.extend_from_slice(&[0x02, 0x44, 0x01]); // one data sub-block: len, bytes
            v.push(0x00); // block terminator
            v.push(0x3B); // trailer
        });
        push("bmp", 0, 0, &|v| {
            v.extend_from_slice(b"BM");
            v.extend_from_slice(&102u32.to_le_bytes()); // bfSize = 54 + 48 pixels
            v.extend_from_slice(&[0u8; 4]); // reserved
            v.extend_from_slice(&54u32.to_le_bytes()); // bfOffBits
            v.extend_from_slice(&40u32.to_le_bytes()); // BITMAPINFOHEADER size
            v.extend_from_slice(&4u32.to_le_bytes()); // width
            v.extend_from_slice(&4i32.to_le_bytes()); // height
            v.extend_from_slice(&1u16.to_le_bytes()); // planes
            v.extend_from_slice(&24u16.to_le_bytes()); // bpp
            v.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
            v.extend_from_slice(&48u32.to_le_bytes()); // sizeImage = 4 rows * 12 bytes
            v.extend_from_slice(&[0u8; 16]); // resolutions, colours
            v.extend(std::iter::repeat_n(0x33u8, 48)); // the pixels
        });
        let icon_bitmap = |w: u32| {
            let xor = 4 * w * w;
            let and_row = w.div_ceil(32) * 4;
            let and = and_row * w;
            let mut v = Vec::new();
            v.extend_from_slice(&40u32.to_le_bytes()); // BITMAPINFOHEADER size
            v.extend_from_slice(&w.to_le_bytes()); // width
            v.extend_from_slice(&((w * 2) as i32).to_le_bytes()); // height = 2 * width
            v.extend_from_slice(&1u16.to_le_bytes()); // planes
            v.extend_from_slice(&32u16.to_le_bytes()); // bpp
            v.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
            v.extend_from_slice(&[0u8; 16]); // sizeImage etc.
            v.extend(std::iter::repeat_n(0u8, (xor + and) as usize));
            v
        };
        push("ico", 0, 1128, &|v| {
            v.extend_from_slice(&[0, 0, 1, 0, 1, 0]); // ICONDIR, 1 image
            v.extend_from_slice(&[16, 16, 0, 0]); // 16x16, no colours
            v.extend_from_slice(&1u16.to_le_bytes()); // planes
            v.extend_from_slice(&32u16.to_le_bytes()); // bpp
            v.extend_from_slice(&1128u32.to_le_bytes()); // bytes in resource
            v.extend_from_slice(&22u32.to_le_bytes()); // image offset
            let bmp = icon_bitmap(16);
            v.extend_from_slice(&bmp[..40]); // the entry's own header lives at 22…
            v.extend(std::iter::repeat_n(0u8, (1128 - 40) as usize)); // …the planes after
        });
        push("cur", 0, 4264, &|v| {
            v.extend_from_slice(&[0, 0, 2, 0, 1, 0]); // CURDIR, 1 image
            v.extend_from_slice(&[32, 32, 0, 0]); // 32x32
            v.extend_from_slice(&1u16.to_le_bytes());
            v.extend_from_slice(&32u16.to_le_bytes());
            v.extend_from_slice(&4264u32.to_le_bytes()); // bytes in resource
            v.extend_from_slice(&22u32.to_le_bytes()); // image offset
            let bmp = icon_bitmap(32);
            v.extend_from_slice(&bmp[..40]);
            v.extend(std::iter::repeat_n(0u8, (4264 - 40) as usize));
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
            v.extend_from_slice(&232u32.to_le_bytes()); // file - 8
            v.extend_from_slice(b"AVI ");
            v.extend_from_slice(b"LIST"); // the hdrl list
            v.extend_from_slice(&4u32.to_le_bytes());
            v.extend_from_slice(b"hdrl");
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
            v.extend_from_slice(&[0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // no ID, no cmap, type 2
            v.extend_from_slice(&16u16.to_le_bytes()); // width
            v.extend_from_slice(&16u16.to_le_bytes()); // height
            v.push(24); // depth
            v.push(0); // descriptor
            v.extend(std::iter::repeat_n(0x88u8, 16 * 16 * 3)); // the pixels
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
        push("wmf", 0, 24, &|v| {
            v.extend_from_slice(&[1, 0]); // type: in memory
            v.extend_from_slice(&9u16.to_le_bytes()); // header size, words
            v.extend_from_slice(&0x100u16.to_le_bytes()); // version 1.00
            v.extend_from_slice(&12u32.to_le_bytes()); // mtSize, words: 9 header + 3 record
            v.extend_from_slice(&0u16.to_le_bytes()); // no objects
            v.extend_from_slice(&6u32.to_le_bytes()); // max record
            v.extend_from_slice(&0u16.to_le_bytes()); // no parameters
            v.extend_from_slice(&3u32.to_le_bytes()); // one record, 3 words
            v.extend_from_slice(&0u16.to_le_bytes()); // its function
            v.extend_from_slice(&0u16.to_le_bytes()); // its parameter
        });
        push("ttf", 0, 0, &|v| {
            let tags: [&[u8; 4]; 8] = [
                b"cmap", b"glyf", b"head", b"hhea", b"hmtx", b"maxp", b"name", b"post",
            ];
            v.extend_from_slice(&[0x00, 0x01, 0x00, 0x00]);
            v.extend_from_slice(&8u16.to_be_bytes());
            v.extend_from_slice(&[0u8; 6]);
            let mut offset = 12 + 8 * 16;
            for (i, tag) in tags.iter().enumerate() {
                v.extend_from_slice(*tag);
                v.extend_from_slice(&[0u8; 4]); // checksum
                v.extend_from_slice(&(offset as u32).to_be_bytes());
                let len = u32::from(i as u8 + 1) * 16;
                v.extend_from_slice(&len.to_be_bytes());
                offset += len as usize;
            }
            v.extend(std::iter::repeat_n(0x77u8, offset - v.len()));
        });
        push("ttc", 0, 104, &|v| {
            v.extend_from_slice(b"ttcf");
            v.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // version
            v.extend_from_slice(&1u32.to_be_bytes()); // one font
            v.extend_from_slice(&16u32.to_be_bytes()); // its offset (past the 16-byte header)
                                                       // the sfnt at 16: one table whose extent reaches the file's end
            v.extend_from_slice(&[0x00, 0x01, 0x00, 0x00]);
            v.extend_from_slice(&1u16.to_be_bytes());
            v.extend_from_slice(&[0u8; 6]);
            v.extend_from_slice(b"glyf");
            v.extend_from_slice(&[0u8; 4]);
            v.extend_from_slice(&28u32.to_be_bytes()); // offset within the sfnt
            v.extend_from_slice(&60u32.to_be_bytes()); // length
            v.extend(std::iter::repeat_n(0x77u8, 60));
        });
        push("mp3", 0, 1678, &|v| {
            v.extend_from_slice(b"ID3\x04\x00\x00\x00\x00\x00\x00"); // v2.4 tag, size 0
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
            v.extend(std::iter::repeat_n(0x22u8, 72));
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
            v.extend_from_slice(
                b"\x30\x26\xB2\x75\x8E\x66\xCF\x11\xA6\xD9\x00\xAA\x00\x62\xCE\x6C",
            );
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
            // the central directory the EOCD's offset names
            let local_len = v.len() as u32;
            v.extend_from_slice(b"PK\x01\x02");
            v.extend_from_slice(&[20, 0, 20, 0]); // versions
            v.extend_from_slice(&[0u8; 12]); // flags through CRC
            v.extend_from_slice(&10u32.to_le_bytes()); // compressed size
            v.extend_from_slice(&10u32.to_le_bytes()); // uncompressed size
            v.extend_from_slice(&4u16.to_le_bytes()); // name length
            v.extend_from_slice(&[0u8; 12]); // extra, comment, disk, attrs
            v.extend_from_slice(&0u16.to_le_bytes());
            v.extend_from_slice(&local_len.to_le_bytes()); // local header offset
            v.extend_from_slice(b"file");
            let cd_size = (v.len() - 44) as u32;
            v.extend_from_slice(b"PK\x05\x06"); // EOCD
            v.extend_from_slice(&[0u8; 4]); // disk numbers
            v.extend_from_slice(&1u16.to_le_bytes()); // entries here
            v.extend_from_slice(&1u16.to_le_bytes()); // entries total
            v.extend_from_slice(&cd_size.to_le_bytes());
            v.extend_from_slice(&local_len.to_le_bytes()); // cd offset
            v.extend_from_slice(&0u16.to_le_bytes()); // comment length
        });
        push("rar", 0, 46, &|v| {
            v.extend_from_slice(b"Rar!\x1A\x07\x00");
            // each block states a 13-byte total: the 7-byte header plus a 6-byte body
            v.extend_from_slice(&[0u8, 0, 0x73, 0x00, 0x00, 13, 0]); // main header
            v.extend(std::iter::repeat_n(0u8, 6));
            v.extend_from_slice(&[0u8, 0, 0x74, 0x00, 0x00, 13, 0]); // a file block
            v.extend(std::iter::repeat_n(0u8, 6));
            v.extend_from_slice(&[0u8, 0, 0x7B, 0x00, 0x00, 13, 0]); // the END block
            v.extend(std::iter::repeat_n(0u8, 6));
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
            v.extend_from_slice(b"\n%%EOF\n"); // the EOF comment and its newline
        });
        push("sqlite", 0, 2048, &|v| {
            v.extend_from_slice(b"SQLite format 3\x00");
            v.extend_from_slice(&1024u16.to_be_bytes()); // page size (big-endian)
            v.extend_from_slice(&[0u8; 10]); // write/read versions, reserved bytes
            v.extend_from_slice(&2u32.to_be_bytes()); // page count (big-endian)
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
    /// own bytes. The icon directories carve at their entries' image offsets.
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
            let carve_at = match format {
                // The icon directories carve at their entries' image offsets (22).
                "ico" | "cur" => start + hit_at + 22,
                _ => start + hit_at,
            };
            expected.push((format.to_string(), start + hit_at, size, carve_at));
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
                .filter(|e| e.format == *format && e.offset == f.base_rva + carve_at)
                .collect();
            assert_eq!(
                hits.len(),
                1,
                "format {format} at {hit_at}: expected exactly one hit, got {hits:?} ({} entries total)",
                entries.len()
            );
            assert_eq!(hits[0].size, *size, "format {format}: size mismatch");
            assert_eq!(
                hits[0].offset,
                f.base_rva + carve_at,
                "format {format}: carve start"
            );
        }
        // And nothing was invented beyond the catalogue's formats — every crafted
        // sample passes its structural check.
        let supported = supported_formats();
        for entry in &entries {
            assert!(
                supported.iter().any(|s| *s == entry.format),
                "unknown format {} reported",
                entry.format
            );
            assert!(
                entry.verified,
                "{} failed the structural check (offset {}, size {})",
                entry.format, entry.offset, entry.size
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
        let result = crate::extract_all(&f.path, &requests, &out_dir, &|| false, &mut progress)
            .expect("extract");
        assert!(
            result.items.iter().all(|i| i.error.is_none()),
            "{:?}",
            result.items
        );
        assert_eq!(result.items.len(), expected.len());
        for (item, (format, _hit_at, size, carve_at)) in result.items.iter().zip(&expected) {
            assert!(
                item.error.is_none(),
                "{format}: {}",
                item.error.as_deref().unwrap_or("")
            );
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
