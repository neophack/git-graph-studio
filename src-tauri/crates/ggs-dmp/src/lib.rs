//! The Memory Dump Viewer's engine (module 21): a Windows user-mode minidump (the `MDMP`
//! format Task Manager's "Create dump file" writes and crash handlers save) opened like
//! a CAN trace — the header and its stream directory are parsed on open, the module list
//! and the memory map become the overview, and the carve pass (`carve.rs`) scans the
//! dumped memory regions for embedded files by magic signature while `pe.rs` rebuilds a
//! loaded module's image back into a disk-layout PE. The crate is pure Rust: the
//! `dump_commands.rs` adapters are the only file that may name tauri.
//!
//! Parsing notes the live msedge 456 MiB dump taught us (2026-11-14): the header's
//! `Version` field is NOT the spec constant in every dumper (this build writes
//! 0xA0F4A793), so it is never a validation condition — `MDMP` plus a parseable directory
//! is the contract. The directory RVA is u32 in the classic layout and u64 in the newer
//! `MINIDUMP_HEADER64` variant, where the same header offset carries eight bytes: the
//! parser reads the classic twelve-byte entries first and falls back to the wide form
//! whenever the classic read yields nothing sane.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ggs_base::cancel::Generation;
use ggs_base::sink::BatchSink;
use serde::{Deserialize, Serialize};

pub mod carve;
pub mod pe;
pub mod verify;

/// The dump header magic, as the u32 the file starts with ("MDMP" little-endian).
const MINIDUMP_SIGNATURE: u32 = 0x504D_444D;
/// The classic header is exactly 32 bytes; the wide-directory variant reads past it.
const HEADER_SIZE: u64 = 32;

/// One directory row: the stream's type code, its payload size and where it sits.
#[derive(Clone, Copy, Debug)]
struct DirEntry {
    kind: u32,
    size: u32,
    rva: u64,
}

/// The stream type codes the viewer names. Unlisted kinds render by their number.
fn stream_name(kind: u32) -> &'static str {
    match kind {
        3 => "ThreadList",
        4 => "ModuleList",
        5 => "MemoryList",
        6 => "Exception",
        7 => "SystemInfo",
        8 => "ThreadExList",
        9 => "Memory64List",
        10 => "CommentA",
        11 => "CommentW",
        12 => "HandleData",
        13 => "FunctionTable",
        14 => "UnloadedModuleList",
        15 => "MiscInfo",
        16 => "MemoryInfoList",
        17 => "ThreadInfoList",
        18 => "HandleOperationList",
        19 => "Token",
        21 => "SystemMemoryInfo",
        22 => "ProcessVmCounters",
        24 => "ThreadNames",
        _ => "",
    }
}

/// One stream in the overview's table — kind code, resolved name, payload size.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub kind: u32,
    pub name: String,
    pub size: u32,
}

/// One loaded module as the dump's ModuleList records it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModuleInfo {
    pub base: u64,
    pub size: u32,
    /// The PE header's TimeDateStamp — the build stamp most tools print.
    pub timestamp: u32,
    /// The recorded path (a MINIDUMP_STRING at ModuleNameRva).
    pub name: String,
    /// The path's last component — the extract's file name and the attribution label.
    pub file_name: String,
}

/// One dumped memory region: where the bytes sat in the process (`va`), and where they
/// sit in the dump file (`file_offset`). The VA→file map every carve attribution and
/// module reconstruction rides.
#[derive(Clone, Copy, Debug)]
pub struct Region {
    pub va: u64,
    pub size: u64,
    pub file_offset: u64,
}

/// The system row of the overview (SystemInfo stream).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DumpOs {
    /// "x64" / "x86" / "ARM64" / "ARM" / "unknown" when the stream is absent.
    pub arch: String,
    pub version: String,
    pub build: u32,
    pub processors: u8,
    pub product_type: u8,
}

/// Everything the viewer's header strip shows, read once at open. The stream list is the
/// dump's own table of contents; the memory row is the carve's canvas.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpOverview {
    pub path: String,
    pub size: u64,
    /// Unix seconds — the dump's wall-clock stamp.
    pub time_date_stamp: u64,
    pub flags: u64,
    /// The well-known flag bits resolved to names, in bit order.
    pub flag_names: Vec<String>,
    pub os: DumpOs,
    /// The MiscInfo stream's process id; 0 when the dump carries none.
    pub pid: u32,
    /// The ThreadList stream's count; 0 when absent.
    pub threads: u32,
    /// Whether an Exception stream exists — a crash dump rather than a live capture.
    pub has_exception: bool,
    pub modules: Vec<ModuleInfo>,
    pub module_total_bytes: u64,
    pub memory_regions: u64,
    pub memory_total_bytes: u64,
    pub streams: Vec<StreamInfo>,
}

/// The long-task state the app manages: the scan and the extract share one cancellation
/// generation — a new scan retires the old one, `dump_cancel` retires both. The Arc lets
/// the command adapters move the handle into their blocking closures.
#[derive(Default)]
pub struct DumpState {
    pub cancel: Arc<Generation>,
}

/// An open dump: the parsed header and stream directory over a file handle every later
/// read shares. Parsing touches at most the first kilobytes plus the directory.
#[derive(Debug)]
pub struct Dump {
    file: File,
    pub size: u64,
    time_date_stamp: u32,
    flags: u64,
    streams: Vec<DirEntry>,
}

impl Dump {
    /// Opens and parses a minidump. Any structurally wrong byte is an error — a wrong
    /// magic, an unreadable directory, a directory row pointing past the file.
    pub fn open(path: &Path) -> Result<Dump, String> {
        let file = File::open(path).map_err(|e| format!("{}: {}", path.display(), e))?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        let mut dump = Dump {
            file,
            size,
            time_date_stamp: 0,
            flags: 0,
            streams: Vec::new(),
        };
        let head = dump.read_vec_at(0, 32.min(dump.size as usize).max(4))?;
        if head.len() < 4 {
            return Err(format!("{}: empty file", path.display()));
        }
        let sig = u32::from_le_bytes([head[0], head[1], head[2], head[3]]);
        if sig != MINIDUMP_SIGNATURE {
            return Err(format!(
                "{}: not a Windows minidump (magic {sig:#010x}, expected MDMP)",
                path.display()
            ));
        }
        if head.len() < 32 {
            return Err(format!("{}: the header is truncated", path.display()));
        }
        let stream_count = u32::from_le_bytes([head[8], head[9], head[10], head[11]]);
        let dir_u32 = u64::from(u32::from_le_bytes([head[12], head[13], head[14], head[15]]));
        dump.time_date_stamp = u32::from_le_bytes([head[20], head[21], head[22], head[23]]);
        dump.flags = u64::from_le_bytes([
            head[24], head[25], head[26], head[27], head[28], head[29], head[30], head[31],
        ]);

        // Classic first: the twelve-byte entries at the u32 RVA. The wide variant's u64
        // RVA lives over the same bytes (12..20), and a wide dump whose RVA lands below
        // 4 GiB parses its FIRST row identically under both strides — but its later rows
        // misalign and drop. So both layouts are decoded and the one that recovers more
        // valid rows wins; a zero-row classic (untenable RVA, or a Header64 whose low
        // u32 sits out of bounds) falls straight to the wide read.
        let entries_bytes = u64::from(stream_count) * 12;
        let mut streams = Vec::new();
        if stream_count > 0
            && dir_u32 >= HEADER_SIZE
            && dir_u32
                .checked_add(entries_bytes)
                .is_some_and(|end| end <= size)
        {
            streams = dump.read_dir(dir_u32, stream_count, 12);
        }
        let mut wide_rva = [0u8; 8];
        if !dump.read_exact_at(12, &mut wide_rva)? {
            return Err(format!(
                "{}: the stream directory is unreadable",
                path.display()
            ));
        }
        let wide = dump.read_dir(u64::from_le_bytes(wide_rva), stream_count, 16);
        if wide.len() > streams.len() {
            streams = wide;
        }
        if streams.is_empty() {
            return Err(format!(
                "{}: the stream directory is unreadable",
                path.display()
            ));
        }
        dump.streams = streams;
        Ok(dump)
    }

    /// Decodes `count` directory entries of `entry_size` bytes at `rva`. Rows that are
    /// padding (the dumper pads the directory to a power of two with zeroed slots), carry
    /// an unknown type code, or point past the file are skipped; a fully unsane table
    /// comes back empty. The type-code range check is what keeps a mis-strided read of
    /// the other layout from inventing streams out of payload bytes.
    fn read_dir(&mut self, rva: u64, count: u32, entry_size: usize) -> Vec<DirEntry> {
        let bytes = match u64::from(count).checked_mul(entry_size as u64) {
            Some(b) if b > 0 && rva >= HEADER_SIZE => b,
            _ => return Vec::new(),
        };
        if rva.checked_add(bytes).is_none_or(|end| end > self.size) {
            return Vec::new();
        }
        let mut raw = match self.read_vec_at(rva, bytes as usize) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        raw.shrink_to_fit();
        let wide = entry_size == 16;
        let mut streams = Vec::new();
        for i in 0..count as usize {
            let o = i * entry_size;
            let u32_at = |k: usize| -> u32 {
                let s = o + k;
                u32::from_le_bytes(raw[s..s + 4].try_into().expect("slice"))
            };
            let (kind, size) = (u32_at(0), u32_at(4));
            let rva = if wide {
                u64::from_le_bytes(raw[o + 8..o + 16].try_into().expect("slice"))
            } else {
                u64::from(u32_at(8))
            };
            if !(3..=25).contains(&kind) {
                continue;
            }
            if rva == 0
                || rva
                    .checked_add(u64::from(size))
                    .is_none_or(|end| end > self.size)
            {
                continue;
            }
            streams.push(DirEntry { kind, size, rva });
        }
        streams
    }

    /// Reads exactly `buf.len()` bytes at a file offset. `Ok(false)` is a read past the
    /// end — callers decide whether that is an error or a hole.
    fn read_exact_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<bool, String> {
        if buf.is_empty() {
            return Ok(true);
        }
        if offset
            .checked_add(buf.len() as u64)
            .is_none_or(|end| end > self.size)
        {
            return Ok(false);
        }
        self.file
            .seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        self.file.read_exact(buf).map_err(|e| e.to_string())?;
        Ok(true)
    }

    /// Reads up to `len` bytes at an offset (short read past the end allowed).
    fn read_vec_at(&mut self, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        if offset
            .checked_add(len as u64)
            .is_none_or(|end| end > self.size)
        {
            return Ok(Vec::new());
        }
        self.file
            .seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; len];
        let mut filled = 0;
        loop {
            let n = self
                .file
                .read(&mut buf[filled..])
                .map_err(|e| e.to_string())?;
            if n == 0 {
                buf.truncate(filled);
                return Ok(buf);
            }
            filled += n;
            if filled == len {
                return Ok(buf);
            }
        }
    }

    /// The file handle, cursor positioned by the caller (the carve pass owns it).
    pub(crate) fn file(&mut self) -> &mut File {
        &mut self.file
    }

    fn stream(&self, kind: u32) -> Option<&DirEntry> {
        self.streams.iter().find(|s| s.kind == kind)
    }

    /// One MINIDUMP_STRING at an RVA: u32 byte length + UTF-16LE + NUL. A bad RVA or a
    /// bad length reads as an empty string — module names are cosmetic, never fatal.
    fn string_at(&mut self, rva: u32) -> String {
        let mut len = [0u8; 4];
        if !self
            .read_exact_at(u64::from(rva), &mut len)
            .unwrap_or(false)
        {
            return String::new();
        }
        let bytes = u32::from_le_bytes(len) as usize;
        if bytes == 0 || bytes > 32 * 1024 {
            return String::new();
        }
        let raw = match self.read_vec_at(u64::from(rva) + 4, bytes) {
            Ok(v) if v.len() == bytes => v,
            _ => return String::new(),
        };
        let units: Vec<u16> = raw
            .chunks_exact(2)
            .map(|p| u16::from_le_bytes([p[0], p[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    }

    /// The module list (stream 4): u32 count, then count × the fixed 108-byte entry.
    pub fn modules(&mut self) -> Result<Vec<ModuleInfo>, String> {
        let Some(s) = self.stream(4) else {
            return Ok(Vec::new());
        };
        let raw = self.read_vec_at(s.rva, s.size as usize)?;
        if raw.len() < 4 {
            return Ok(Vec::new());
        }
        let count =
            usize::try_from(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]])).unwrap_or(0);
        const ENTRY: usize = 108;
        let mut modules = Vec::with_capacity(count.min(4096));
        for i in 0..count {
            let o = 4 + i * ENTRY;
            if o + ENTRY > raw.len() {
                break;
            }
            let u32_at =
                |k: usize| u32::from_le_bytes(raw[o + k..o + k + 4].try_into().expect("slice"));
            let u64_at =
                |k: usize| u64::from_le_bytes(raw[o + k..o + k + 8].try_into().expect("slice"));
            let name = self.string_at(u32_at(0x14));
            let file_name = name
                .rsplit(['\\', '/'])
                .find(|p| !p.is_empty())
                .unwrap_or("")
                .to_string();
            modules.push(ModuleInfo {
                base: u64_at(0x00),
                size: u32_at(0x08),
                timestamp: u32_at(0x10),
                name,
                file_name,
            });
        }
        Ok(modules)
    }

    /// The memory map: Memory64List (count u64 + BaseRva u64 + count × {start, size},
    /// payload contiguous from BaseRva) when the dump carries one, else MemoryList
    /// (count u32 + count × {start u64, size u32, rva u32}). Empty is legal — some
    /// minimal dumps carry no memory at all.
    pub fn regions(&mut self) -> Result<Vec<Region>, String> {
        if let Some(s) = self.stream(9) {
            let raw = self.read_vec_at(s.rva, s.size as usize)?;
            if raw.len() < 16 {
                return Ok(Vec::new());
            }
            let count = usize::try_from(u64::from_le_bytes(raw[0..8].try_into().expect("slice")))
                .unwrap_or(0);
            let base_rva = u64::from_le_bytes(raw[8..16].try_into().expect("slice"));
            let need = 16usize
                .checked_add(count.checked_mul(16).ok_or("memory map size overflow")?)
                .ok_or("memory map size overflow")?;
            if raw.len() < need {
                return Err("the Memory64List stream is truncated".to_string());
            }
            let mut out = Vec::with_capacity(count);
            let mut file_off = base_rva;
            for i in 0..count {
                let o = 16 + i * 16;
                let va = u64::from_le_bytes(raw[o..o + 8].try_into().expect("slice"));
                let size = u64::from_le_bytes(raw[o + 8..o + 16].try_into().expect("slice"));
                if file_off.checked_add(size).is_none_or(|end| end > self.size) {
                    return Err("the memory payload runs past the file".to_string());
                }
                out.push(Region {
                    va,
                    size,
                    file_offset: file_off,
                });
                file_off += size;
            }
            return Ok(out);
        }
        if let Some(s) = self.stream(5) {
            let raw = self.read_vec_at(s.rva, s.size as usize)?;
            if raw.len() < 4 {
                return Ok(Vec::new());
            }
            let count = usize::try_from(u32::from_le_bytes(raw[0..4].try_into().expect("slice")))
                .unwrap_or(0);
            const ENTRY: usize = 16;
            let mut out = Vec::new();
            for i in 0..count {
                let o = 4 + i * ENTRY;
                if o + ENTRY > raw.len() {
                    break;
                }
                let va = u64::from_le_bytes(raw[o..o + 8].try_into().expect("slice"));
                let size = u64::from(u32::from_le_bytes(
                    raw[o + 8..o + 12].try_into().expect("slice"),
                ));
                let rva = u64::from(u32::from_le_bytes(
                    raw[o + 12..o + 16].try_into().expect("slice"),
                ));
                if rva == 0 || rva.checked_add(size).is_none_or(|end| end > self.size) {
                    continue;
                }
                out.push(Region {
                    va,
                    size,
                    file_offset: rva,
                });
            }
            return Ok(out);
        }
        Ok(Vec::new())
    }

    /// The system row: SystemInfo's fixed 56-byte block. An absent stream keeps the
    /// viewer honest with an "unknown" arch rather than a guess.
    fn system_info(&mut self) -> Result<DumpOs, String> {
        let Some(s) = self.stream(7) else {
            return Ok(DumpOs {
                arch: "unknown".to_string(),
                version: String::new(),
                build: 0,
                processors: 0,
                product_type: 0,
            });
        };
        let raw = self.read_vec_at(s.rva, s.size as usize)?;
        let u16_at = |k: usize| {
            u16::from_le_bytes(
                raw.get(k..k + 2)
                    .map_or([0; 2], |b| b.try_into().expect("slice")),
            )
        };
        let u32_at = |k: usize| {
            u32::from_le_bytes(
                raw.get(k..k + 4)
                    .map_or([0; 4], |b| b.try_into().expect("slice")),
            )
        };
        let arch = match u16_at(0) {
            0 => "x86",
            5 => "ARM",
            9 => "x64",
            12 => "ARM64",
            _ => "arch?",
        };
        Ok(DumpOs {
            arch: arch.to_string(),
            version: format!("{}.{}.{}", u32_at(8), u32_at(12), u32_at(16)),
            build: u32_at(16),
            processors: raw.get(6).copied().unwrap_or(0),
            product_type: raw.get(7).copied().unwrap_or(0),
        })
    }

    /// The well-known MiniDump flag bits, in bit order (MiniDumpWithFullMemory first).
    fn flag_names(&self) -> Vec<String> {
        const NAMED: &[(u64, &str)] = &[
            (0x1, "WithDataSegs"),
            (0x2, "WithFullMemory"),
            (0x4, "WithHandleData"),
            (0x20, "WithUnloadedModules"),
            (0x40, "WithIndirectlyReferencedMemory"),
            (0x100, "WithProcessThreadData"),
            (0x200, "WithPrivateReadWriteMemory"),
            (0x800, "WithFullMemoryInfo"),
            (0x1000, "WithThreadInfo"),
            (0x2000, "WithCodeSegs"),
            (0x20000, "IgnoreInaccessibleMemory"),
            (0x40000, "WithToken"),
            (0x200000, "WithAvxState"),
            (0x400000, "WithXState"),
        ];
        NAMED
            .iter()
            .filter(|(bit, _)| self.flags & bit != 0)
            .map(|(_, name)| name.to_string())
            .collect()
    }

    /// One u32 from a stream's body (a fixed offset in), 0 when the stream is absent.
    fn stream_word(&mut self, stream: Option<DirEntry>, at: u64) -> u32 {
        stream
            .and_then(|s| self.read_vec_at(s.rva + at, 4).ok())
            .filter(|b| b.len() == 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .unwrap_or(0)
    }

    /// Everything the header strip shows, in one blocking pass (a few kilobytes of reads).
    pub fn overview(&mut self, path: &Path) -> Result<DumpOverview, String> {
        let modules = self.modules()?;
        let regions = self.regions()?;
        let os = self.system_info()?;
        let pid = self.stream_word(self.stream(15).copied(), 8);
        let threads = self.stream_word(self.stream(3).copied(), 0);
        let streams = self
            .streams
            .iter()
            .map(|s| StreamInfo {
                kind: s.kind,
                name: {
                    let n = stream_name(s.kind);
                    if n.is_empty() {
                        format!("stream {}", s.kind)
                    } else {
                        n.to_string()
                    }
                },
                size: s.size,
            })
            .collect();
        Ok(DumpOverview {
            path: path.display().to_string(),
            size: self.size,
            time_date_stamp: u64::from(self.time_date_stamp),
            flags: self.flags,
            flag_names: self.flag_names(),
            os,
            pid,
            threads,
            has_exception: self.stream(6).is_some(),
            module_total_bytes: modules.iter().map(|m| u64::from(m.size)).sum(),
            memory_regions: regions.len() as u64,
            memory_total_bytes: regions.iter().map(|r| r.size).sum(),
            modules,
            streams,
        })
    }

    /// Translates a virtual address to its file offset through the region map — the
    /// mapping the carve's VA attribution and the module reconstruction share. `None` is
    /// a hole (the dumper skipped the page), never a guess.
    pub fn file_offset_for(&self, regions: &[Region], va: u64) -> Option<u64> {
        if regions.is_empty() {
            return None;
        }
        let idx = regions.partition_point(|r| r.va <= va);
        if idx == 0 {
            return None;
        }
        let r = &regions[idx - 1];
        if va - r.va < r.size {
            Some(r.file_offset + (va - r.va))
        } else {
            None
        }
    }
}

/* ---------- The bridge shapes ---------- */

/// One carved file the scan reported. `offset`/`size` are dump-file coordinates (the
/// extract reads exactly this range); `va` is where the bytes lived in the process, and
/// `in_module` names the module image they sat inside — a heap cluster versus a module's
/// static data is the first triage signal.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CarvedEntry {
    pub id: u64,
    /// The format's extension, as the extract names the file ("png").
    pub format: String,
    /// The format family the list filters and colors by: image, media, archive, doc, db.
    pub tag: String,
    pub offset: u64,
    pub size: u64,
    pub va: Option<u64>,
    pub in_module: Option<String>,
    /// The structural check passed (the chunk chain / declared lengths / end marker all
    /// hold over the carved bytes). A false hit passes the carve validator but fails
    /// here — the view filters those out by default.
    pub verified: bool,
}

/// The scan's synchronous answer: the module list (delivered up front — it is one small
/// stream read) and how many bytes the carve pass will walk.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpScanStart {
    pub modules: Vec<ModuleInfo>,
    pub scan_bytes: u64,
}

/// The user's scan knobs. `formats` empty scans every supported format.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DumpScanOptions {
    pub formats: Vec<String>,
    pub min_size: u64,
    pub max_size: u64,
}

/// The scan's channel events: periodic progress, the entries in batches, and one done.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DumpEvent {
    Progress {
        scanned: u64,
        total: u64,
        entries: u64,
    },
    Batch {
        entries: Vec<CarvedEntry>,
    },
    /// The variant's own `rename_all` renames its fields — the enum-level attribute
    /// names the variants only, and `elapsed_ms` crossed as snake_case where the
    /// view read `elapsedMs` (the "elapsed NaNs" the done line printed, 2026-11-15).
    #[serde(rename_all = "camelCase")]
    Done {
        entries: u64,
        elapsed_ms: u64,
        cancelled: bool,
    },
}

/// One extract request: a carved file (its dump-file range) or a module (its image base
/// and size). The frontend sends back what the scan delivered.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtractRequest {
    /// "file" or "module".
    pub kind: String,
    pub format: String,
    pub name: String,
    /// File-kind only: the carved range in dump-file coordinates.
    #[serde(default)]
    pub offset: u64,
    #[serde(default)]
    pub size: u64,
    /// Module-kind only: the image base and size from the dump's module list.
    #[serde(default)]
    pub base: u64,
    #[serde(default)]
    pub module_size: u32,
}

/// One extract step's progress (per item, bytes copied so far overall).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtractProgress {
    pub done: u64,
    pub total: u64,
    pub bytes: u64,
    pub name: String,
}

/// One extract item's answer: where the file landed and how big it is, or why it failed.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtractItemResult {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub error: Option<String>,
}

/// The extract's final answer: every item, and the directory they landed in.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpExtractResult {
    pub items: Vec<ExtractItemResult>,
    pub out_dir: String,
    pub total_bytes: u64,
}

/// Copies one carved byte range out of the dump, chunked (a carved ZIP inside a 456 MiB
/// dump can be tens of megabytes). Returns the bytes written.
pub fn extract_range(dump: &mut Dump, offset: u64, size: u64, out: &Path) -> Result<u64, String> {
    if offset.checked_add(size).is_none_or(|end| end > dump.size) {
        return Err("the carved range runs past the dump file".to_string());
    }
    use std::io::Write;
    let mut file = File::create(out).map_err(|e| format!("{}: {}", out.display(), e))?;
    const CHUNK: u64 = 1024 * 1024;
    let mut buf = vec![0u8; CHUNK as usize];
    let mut done = 0u64;
    dump.file
        .seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    while done < size {
        let want = (size - done).min(CHUNK) as usize;
        dump.file
            .read_exact(&mut buf[..want])
            .map_err(|e| e.to_string())?;
        file.write_all(&buf[..want]).map_err(|e| e.to_string())?;
        done += want as u64;
    }
    Ok(size)
}

/// A file name worth writing: the path's last component, the separators and reserved
/// characters flattened, length-capped, never empty.
fn sanitize_name(raw: &str) -> String {
    let base = raw
        .rsplit(['\\', '/'])
        .find(|p| !p.is_empty())
        .unwrap_or(raw);
    let cleaned: String = base
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c| c == '.' || c == ' ');
    let mut s: String = trimmed.chars().take(120).collect();
    if s.is_empty() {
        s = "carved".to_string();
    }
    s
}

/// A destination that does not exist yet: `name (2)` beside the collision, and so on.
fn unique_path(target: PathBuf) -> PathBuf {
    if !target.exists() {
        return target;
    }
    let stem = target
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let ext = target
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    for i in 2..1000 {
        let name = if ext.is_empty() {
            format!("{stem} ({i})")
        } else {
            format!("{stem} ({i}).{ext}")
        };
        let candidate = target.with_file_name(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    target
}

/// Extracts carved files and rebuilt modules into `out_dir` — carved files flat,
/// modules under `modules/` — streaming one progress event per item and stopping the
/// moment `cancel` answers true. An item's failure is recorded per item, never fatal:
/// a rebuild whose base page the dumper skipped must not lose the other twenty.
pub fn extract_all(
    path: &Path,
    entries: &[ExtractRequest],
    out_dir: &Path,
    cancel: &dyn Fn() -> bool,
    progress: &mut dyn BatchSink<ExtractProgress>,
) -> Result<DumpExtractResult, String> {
    std::fs::create_dir_all(out_dir).map_err(|e| format!("{}: {}", out_dir.display(), e))?;
    let mut dump = Dump::open(path)?;
    let regions = dump.regions()?;
    let modules = dump.modules()?;
    let total = entries.len() as u64;
    let mut items: Vec<ExtractItemResult> = Vec::with_capacity(entries.len());
    let mut total_bytes = 0u64;
    for (i, req) in entries.iter().enumerate() {
        if cancel() {
            break;
        }
        let clean = sanitize_name(&req.name);
        let target = match req.kind.as_str() {
            "module" => out_dir.join("modules").join(&clean),
            _ => out_dir.join(&clean),
        };
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let target = unique_path(target);
        let result = match req.kind.as_str() {
            "module" => modules
                .iter()
                .find(|m| m.base == req.base)
                .ok_or_else(|| "this module is not in the dump's module list".to_string())
                .and_then(|m| pe::extract_module(&mut dump, &regions, m, &target)),
            _ => extract_range(&mut dump, req.offset, req.size, &target),
        };
        let name = target
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| clean.clone());
        match result {
            Ok(bytes) => {
                total_bytes += bytes;
                items.push(ExtractItemResult {
                    name: name.clone(),
                    path: target.display().to_string(),
                    bytes,
                    error: None,
                });
            }
            Err(e) => {
                let _ = std::fs::remove_file(&target);
                items.push(ExtractItemResult {
                    name: name.clone(),
                    path: String::new(),
                    bytes: 0,
                    error: Some(e),
                });
            }
        }
        progress.send(ExtractProgress {
            done: i as u64 + 1,
            total,
            bytes: total_bytes,
            name,
        });
    }
    Ok(DumpExtractResult {
        items,
        out_dir: out_dir.display().to_string(),
        total_bytes,
    })
}

/* ---------- Tests ---------- */

#[cfg(test)]
pub(crate) mod fixture {
    //! Builds synthetic minidumps in a tempdir: a classic header, a directory, a module
    //! list and a Memory64List whose payload the caller fills — every parser and the
    //! carve pass test against these, never against a real dump.

    use std::io::Write;
    use std::path::PathBuf;

    pub struct Fixture {
        pub path: PathBuf,
        /// The file offset the Memory64List's payload starts at (its BaseRva).
        pub base_rva: u64,
    }

    /// Writes a dump with one module per `(base, size, path)` and memory regions laid
    /// out in order; `fill` appends each region's bytes in the same order.
    pub fn write(
        dir: &tempfile::TempDir,
        modules: &[(u64, u32, &str)],
        regions: &[(u64, u64)],
        fill: &dyn Fn(&mut Vec<u8>),
    ) -> Fixture {
        // Layout: header 32 | directory | SystemInfo 56 | ModuleList | names | Memory64List | payload.
        let mut payload = Vec::new();
        fill(&mut payload);
        let header_size = 32u64;
        let dir_entries = 4u64;
        let dir_size = dir_entries * 12;
        let sys_rva = header_size + dir_size;
        let module_count = modules.len() as u32;
        let module_list_rva = sys_rva + 56;
        let module_list_size = 4 + module_count * 108;
        let name_block_rva = module_list_rva + u64::from(module_list_size);
        let mut name_block = Vec::new();
        let mut name_offsets = Vec::new();
        for (_, _, name) in modules {
            name_offsets.push(name_block.len() as u32);
            let mut units: Vec<u16> = name.encode_utf16().collect();
            name_block.extend_from_slice(&(units.len() as u32 * 2).to_le_bytes());
            units.push(0);
            for u in &units {
                name_block.extend_from_slice(&u.to_le_bytes());
            }
        }
        let mem64_rva = name_block_rva + name_block.len() as u64;
        let mem64_size = 16 + regions.len() as u64 * 16;
        let base_rva = mem64_rva + mem64_size;
        // A minimal Exception body parked behind the payload — its presence alone marks
        // the dump as a crash dump (the parser never reads into it).
        let exception_rva = base_rva + payload.len() as u64;

        let mut module_list = Vec::new();
        module_list.extend_from_slice(&module_count.to_le_bytes());
        for (i, (base, size, _)) in modules.iter().enumerate() {
            module_list.extend_from_slice(&base.to_le_bytes());
            module_list.extend_from_slice(&size.to_le_bytes());
            module_list.extend_from_slice(&0u32.to_le_bytes()); // checksum
            module_list.extend_from_slice(&0x5D7F_1000u32.to_le_bytes()); // timestamp
            module_list.extend_from_slice(&(name_block_rva as u32 + name_offsets[i]).to_le_bytes());
            module_list.extend_from_slice(&[0u8; 52]); // VS_FIXEDFILEINFO
            module_list.extend_from_slice(&0u32.to_le_bytes()); // CvDataSize
            module_list.extend_from_slice(&0u32.to_le_bytes()); // CvRecordRva
            module_list.extend_from_slice(&0u32.to_le_bytes()); // MiscDataSize
            module_list.extend_from_slice(&0u32.to_le_bytes()); // MiscRecordRva
            module_list.extend_from_slice(&0u64.to_le_bytes()); // Reserved0
            module_list.extend_from_slice(&0u64.to_le_bytes()); // Reserved1
        }

        let mut mem64 = Vec::new();
        mem64.extend_from_slice(&(regions.len() as u64).to_le_bytes());
        mem64.extend_from_slice(&base_rva.to_le_bytes());
        for (va, size) in regions {
            mem64.extend_from_slice(&va.to_le_bytes());
            mem64.extend_from_slice(&size.to_le_bytes());
        }

        let mut out = Vec::new();
        // header
        out.extend_from_slice(&0x504D_444Du32.to_le_bytes());
        out.extend_from_slice(&44959u32.to_le_bytes());
        out.extend_from_slice(&(dir_entries as u32).to_le_bytes());
        out.extend_from_slice(&(header_size as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes()); // checksum
        out.extend_from_slice(&0x6700_0000u32.to_le_bytes()); // timestamp
        out.extend_from_slice(&0x2u64.to_le_bytes()); // MiniDumpWithFullMemory
                                                      // directory: SystemInfo(7), ModuleList(4), Memory64List(9), Exception(6)
        for (kind, size, rva) in [
            (7u32, 56u32, sys_rva as u32),
            (4, module_list_size, module_list_rva as u32),
            (9, mem64_size as u32, mem64_rva as u32),
            (6, 8u32, exception_rva as u32), // a present Exception marks a crash dump
        ] {
            out.extend_from_slice(&kind.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&rva.to_le_bytes());
        }
        out.extend_from_slice(&[0u8; 56]); // SystemInfo body (arch unknown)
        out.extend_from_slice(&module_list);
        out.extend_from_slice(&name_block);
        out.extend_from_slice(&mem64);
        out.extend_from_slice(&payload);
        out.extend_from_slice(&[0u8; 8]); // the Exception body
        let path = dir.path().join("test.dmp");
        let mut file = std::fs::File::create(&path).expect("create fixture");
        file.write_all(&out).expect("write fixture");
        Fixture { path, base_rva }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_synthetic_dump_parses_end_to_end() {
        let dir = tempfile::tempdir().expect("tempdir");
        let payload_len = 64u64;
        let f = crate::fixture::write(
            &dir,
            &[(
                0x7FF0_0000_0000,
                0x1000,
                r"C:\Windows\System32\kernel32.dll",
            )],
            &[(0x7FF0_0000_0000, payload_len)],
            &|buf| buf.extend_from_slice(&vec![0xABu8; payload_len as usize]),
        );
        let mut dump = Dump::open(&f.path).expect("open");
        let overview = dump.overview(&f.path).expect("overview");
        // The fixture appends the 8-byte Exception body behind the payload.
        assert_eq!(overview.size, f.base_rva + payload_len + 8);
        assert!(
            overview.has_exception,
            "the fixture carries an Exception stream row"
        );
        assert_eq!(overview.flag_names, vec!["WithFullMemory"]);
        assert_eq!(overview.modules.len(), 1);
        let m = &overview.modules[0];
        assert_eq!(m.base, 0x7FF0_0000_0000);
        assert_eq!(m.file_name, "kernel32.dll");
        assert_eq!(overview.memory_regions, 1);
        assert_eq!(overview.memory_total_bytes, payload_len);
        let regions = dump.regions().expect("regions");
        assert_eq!(regions[0].file_offset, f.base_rva);
        assert_eq!(
            dump.file_offset_for(&regions, 0x7FF0_0000_0010),
            Some(f.base_rva + 0x10)
        );
        assert_eq!(
            dump.file_offset_for(&regions, 0x7FF0_0000_1000),
            None,
            "past the region"
        );
        assert_eq!(
            dump.file_offset_for(&regions, 0x7FEF_FFFF_FFFF),
            None,
            "below the region"
        );
    }

    #[test]
    fn a_non_minidump_file_is_rejected_by_its_magic() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("no.dmp");
        std::fs::write(&path, b"MZ\x90\x00not a dump at all").expect("write");
        let err = Dump::open(&path).expect_err("rejected");
        assert!(err.contains("not a Windows minidump"), "{err}");
    }

    #[test]
    fn the_wide_directory_variant_wins_when_the_classic_stride_drops_rows() {
        // A hand-built MINIDUMP_HEADER64 dump with TWO streams: under the classic
        // twelve-byte stride the second row misaligns and drops, so the wide
        // sixteen-byte decode (which recovers both) must win the row count.
        let dir = tempfile::tempdir().expect("tempdir");
        let mut out = Vec::new();
        out.extend_from_slice(&0x504D_444Du32.to_le_bytes()); // sig
        out.extend_from_slice(&44959u32.to_le_bytes()); // version
        out.extend_from_slice(&2u32.to_le_bytes()); // two streams
        out.extend_from_slice(&36u64.to_le_bytes()); // wide directory RVA at 12..20
        out.extend_from_slice(&0u32.to_le_bytes()); // checksum
        out.extend_from_slice(&0u32.to_le_bytes()); // timestamp
        out.extend_from_slice(&0x2u64.to_le_bytes()); // flags
        assert_eq!(out.len(), 36);
        // wide directory at 36: SystemInfo at 68, Memory64List at 124
        out.extend_from_slice(&7u32.to_le_bytes());
        out.extend_from_slice(&56u32.to_le_bytes());
        out.extend_from_slice(&68u64.to_le_bytes());
        out.extend_from_slice(&9u32.to_le_bytes());
        out.extend_from_slice(&32u32.to_le_bytes());
        out.extend_from_slice(&124u64.to_le_bytes());
        assert_eq!(out.len(), 68);
        // SystemInfo body (56 bytes): ProcessorArchitecture = AMD64
        out.extend_from_slice(&9u16.to_le_bytes());
        out.extend_from_slice(&[0u8; 54]);
        assert_eq!(out.len(), 124);
        // Memory64List at 124: one region (va 0x1000, 32 bytes), payload at 156
        out.extend_from_slice(&1u64.to_le_bytes());
        out.extend_from_slice(&156u64.to_le_bytes());
        out.extend_from_slice(&0x1000u64.to_le_bytes());
        out.extend_from_slice(&32u64.to_le_bytes());
        assert_eq!(out.len(), 156);
        out.extend_from_slice(&[0xEEu8; 32]);
        let path = dir.path().join("wide.dmp");
        std::fs::write(&path, &out).expect("write");
        let mut dump = Dump::open(&path).expect("open (wide)");
        assert_eq!(
            dump.streams.len(),
            2,
            "both streams must survive the wide decode"
        );
        let overview = dump.overview(&path).expect("overview");
        assert_eq!(overview.os.arch, "x64");
        let regions = dump.regions().expect("regions");
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].va, 0x1000);
        assert_eq!(regions[0].file_offset, 156);
    }

    #[test]
    fn the_classic_memorylist_fallback_maps_by_its_own_rvas() {
        // A dump with MemoryList (stream 5) instead of Memory64List: entries carry their
        // own file RVAs, non-contiguous by design.
        let dir = tempfile::tempdir().expect("tempdir");
        let mut out = Vec::new();
        out.extend_from_slice(&0x504D_444Du32.to_le_bytes());
        out.extend_from_slice(&44959u32.to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&32u32.to_le_bytes()); // classic dir RVA
        out.extend_from_slice(&0u32.to_le_bytes()); // checksum
        out.extend_from_slice(&0u32.to_le_bytes()); // timestamp
        out.extend_from_slice(&0u64.to_le_bytes()); // flags
        out.extend_from_slice(&5u32.to_le_bytes()); // stream 5 MemoryList
        out.extend_from_slice(&(4 + 16u32).to_le_bytes());
        out.extend_from_slice(&44u32.to_le_bytes());
        // MemoryList at 44: one region (va 0x2000, 16 bytes) whose payload sits at 64
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&0x2000u64.to_le_bytes());
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&64u32.to_le_bytes());
        out.extend_from_slice(&[0x11u8; 16]);
        let path = dir.path().join("memlist.dmp");
        std::fs::write(&path, &out).expect("write");
        let mut dump = Dump::open(&path).expect("open");
        let regions = dump.regions().expect("regions");
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].va, 0x2000);
        assert_eq!(regions[0].size, 16);
        assert_eq!(regions[0].file_offset, 64);
    }
}
