//! ggs-elf (module 21): the ELF Inspector's engine — the header, program headers
//! (segments), section headers and symbol tables of an ELF32 or ELF64 image (either
//! endianness, the embedded toolchains' whole range) read straight off the bytes, plus
//! the rough ROM/RAM split the view's summary card shows: allocated sections without a
//! write flag are the image's read-only footprint, the writable ones its RAM. The
//! crate is pure Rust — no `object`/`goblin` dependency, the format is small and this
//! reader answers only what an inspector shows; `cmd_elf.rs` is the only file that may
//! name tauri.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

/* ---------- Shapes the bridge sees ---------- */

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElfSegment {
    /// `LOAD`, `DYNAMIC`, `INTERP`, `GNU_STACK` … — the PT_* constant, named.
    pub kind: String,
    /// `RWX`-style marks from p_flags.
    pub flags: String,
    pub offset: u64,
    pub vaddr: u64,
    pub file_bytes: u64,
    pub mem_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElfSection {
    pub name: String,
    /// `PROGBITS`, `NOBITS`, `SYMTAB` … — the SHT_* constant, named.
    pub kind: String,
    pub addr: u64,
    pub offset: u64,
    pub size: u64,
    pub alloc: bool,
    pub write: bool,
    pub exec: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElfSymbol {
    pub name: String,
    pub value: u64,
    pub size: u64,
    /// `func`, `object`.
    pub kind: String,
    /// `local`, `global`, `weak`.
    pub bind: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElfDocument {
    /// 32 or 64 — the ELF class.
    pub class_bits: u16,
    pub little_endian: bool,
    /// `EXEC`, `DYN`, `REL`, `CORE` — the ET_* constant, named.
    pub file_type: String,
    pub machine_name: String,
    pub entry: u64,
    pub segments: Vec<ElfSegment>,
    pub sections: Vec<ElfSection>,
    /// Every symbol the tables listed, before the func/object-with-size filter — the
    /// honest total beside `symbols`' kept rows.
    pub symbols_total: usize,
    /// The kept symbols: functions and objects with a size, the largest first — the
    /// question this inspector answers ("what eats my flash") pre-sorted.
    pub symbols: Vec<ElfSymbol>,
    pub needed: Vec<String>,
    /// Allocated, non-writable sections' bytes (text, rodata — the flash-ish footprint).
    pub rom_bytes: u64,
    /// Allocated, writable sections' bytes (data, bss — the RAM footprint).
    pub ram_bytes: u64,
    pub total_bytes: u64,
}

/* ---------- Parsing ---------- */

/// The whole file's bytes (an ELF inspector can read the image whole — firmware images
/// are megabytes; past 256 MiB is refused rather than silently swallowed).
pub const MAX_FILE: u64 = 256 * 1024 * 1024;

/// Symbols the tables keep: functions and objects that carry a size — the raw table's
/// locals, section markers and sizeless imports are the noise an inspector never shows.
const MAX_SYMBOLS: usize = 100_000;

/// The read. `None`-returning readers keep a malformed file an error, never a panic.
pub fn open_doc(path: &Path) -> Result<Arc<ElfDocument>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    let total = bytes.len() as u64;
    if total > MAX_FILE {
        return Err(format!("{}: past the 256 MiB this inspector accepts", path.display()));
    }
    parse(&bytes, total).map(Arc::new)
}

/// One section header's fields, endianness- and width-normalized.
#[derive(Clone, Copy)]
struct SectionHeader {
    name_off: u32,
    kind: u32,
    flags: u64,
    addr: u64,
    offset: u64,
    size: u64,
    link: u32,
}

pub fn parse(bytes: &[u8], total_bytes: u64) -> Result<ElfDocument, String> {
    if bytes.len() < 16 || &bytes[0..4] != b"\x7fELF" {
        return Err("not an ELF image (the \\x7fELF magic is missing)".to_string());
    }
    let class = bytes[4];
    let data = bytes[5];
    if class != 1 && class != 2 {
        return Err(format!("unknown ELF class {class}"));
    }
    let little = data == 1;
    if !little && data != 2 {
        return Err(format!("unknown ELF data encoding {data}"));
    }
    let wide = class == 2;
    let at_u16 = |off: usize| -> Option<u16> {
        let b = bytes.get(off..off + 2)?;
        Some(if little { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) })
    };
    let at_u32 = |off: usize| -> Option<u32> {
        let b = bytes.get(off..off + 4)?;
        Some(if little {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    };
    let at_u64 = |off: usize| -> Option<u64> {
        let b = bytes.get(off..off + 8)?;
        let mut arr = [0u8; 8];
        arr.copy_from_slice(b);
        Some(if little { u64::from_le_bytes(arr) } else { u64::from_be_bytes(arr) })
    };
    // The address type: 4 or 8 bytes, read as u64 either way.
    let at_addr = |off: usize| -> Option<u64> {
        if wide {
            at_u64(off)
        } else {
            at_u32(off).map(|v| v as u64)
        }
    };

    let file_type = at_u16(16).ok_or("truncated ELF header")?;
    let machine = at_u16(18).ok_or("truncated ELF header")?;
    let (entry_off, phoff_off, shoff_off) = if wide { (24, 32, 40) } else { (24, 28, 32) };
    let entry = at_addr(entry_off).ok_or("truncated ELF header")?;
    let phoff = at_addr(phoff_off).ok_or("truncated ELF header")?;
    let shoff = at_addr(shoff_off).ok_or("truncated ELF header")?;
    let (phentsize_off, phnum_off, shentsize_off, shnum_off, shstrndx_off) =
        if wide { (54, 56, 58, 60, 62) } else { (42, 44, 46, 48, 50) };
    let phentsize = at_u16(phentsize_off).unwrap_or(0) as usize;
    let phnum = at_u16(phnum_off).unwrap_or(0) as usize;
    let shentsize = at_u16(shentsize_off).unwrap_or(0) as usize;
    let shnum = at_u16(shnum_off).unwrap_or(0) as usize;
    let shstrndx = at_u16(shstrndx_off).unwrap_or(0) as usize;

    let mut segments = Vec::new();
    let phsize = if wide { 56 } else { 32 };
    if phoff > 0 && phnum > 0 && phentsize >= phsize {
        for i in 0..phnum {
            let base = phoff as usize + i * phentsize;
            if base + phsize > bytes.len() {
                break;
            }
            let Some(kind) = at_u32(base) else { break };
            // Layouts differ past the type field: 32-bit carries offset/vaddr/
            // paddr/filesz/memsz as u32s; 64-bit as u64s (paddr skipped over).
            let (offset, vaddr, file_bytes, mem_bytes, flags) = if wide {
                let flags = at_u32(base + 4).unwrap_or(0);
                let offset = at_u64(base + 8).unwrap_or(0);
                let vaddr = at_u64(base + 16).unwrap_or(0);
                let file_bytes = at_u64(base + 32).unwrap_or(0);
                let mem_bytes = at_u64(base + 40).unwrap_or(0);
                (offset, vaddr, file_bytes, mem_bytes, flags)
            } else {
                let offset = at_u32(base + 4).unwrap_or(0) as u64;
                let vaddr = at_u32(base + 8).unwrap_or(0) as u64;
                let file_bytes = at_u32(base + 16).unwrap_or(0) as u64;
                let mem_bytes = at_u32(base + 20).unwrap_or(0) as u64;
                let flags = at_u32(base + 24).unwrap_or(0);
                (offset, vaddr, file_bytes, mem_bytes, flags)
            };
            let mut marks = String::new();
            if flags & 4 != 0 {
                marks.push('R');
            }
            if flags & 2 != 0 {
                marks.push('W');
            }
            if flags & 1 != 0 {
                marks.push('X');
            }
            segments.push(ElfSegment {
                kind: segment_kind_name(kind),
                flags: marks,
                offset,
                vaddr,
                file_bytes,
                mem_bytes,
            });
        }
    }

    // Section headers, then the shstrtab they cite, then the sections themselves.
    let mut sections: Vec<ElfSection> = Vec::new();
    let mut headers: Vec<SectionHeader> = Vec::new();
    let shsize = if wide { 64 } else { 40 };
    let read_header = |i: usize| -> Option<SectionHeader> {
        let base = (shoff as usize).checked_add(i.checked_mul(shentsize)?)?;
        if base.checked_add(shsize)? > bytes.len() {
            return None;
        }
        let kind = at_u32(base + 4)?;
        Some(SectionHeader {
            name_off: at_u32(base)?,
            kind,
            flags: if wide { at_u64(base + 8)? } else { at_u32(base + 8)? as u64 },
            addr: at_addr(if wide { base + 16 } else { base + 12 })?,
            offset: at_addr(if wide { base + 24 } else { base + 16 })?,
            size: at_addr(if wide { base + 32 } else { base + 20 })?,
            link: at_u32(if wide { base + 40 } else { base + 24 }).unwrap_or(0),
        })
    };
    if shoff > 0 && shentsize >= shsize {
        // ELF extended section numbering: when shnum == 0, section 0's sh_size holds the true count;
        // when shstrndx == SHN_XINDEX (0xffff), section 0's sh_link holds the true shstrtab index.
        let (effective_shnum, effective_shstrndx) = if let Some(sh0) = read_header(0) {
            let n = if shnum == 0 { (sh0.size as usize).min(65536 * 4) } else { shnum };
            let strndx = if shstrndx == 0xffff { sh0.link as usize } else { shstrndx };
            (n, strndx)
        } else {
            (shnum, shstrndx)
        };
        for i in 0..effective_shnum {
            let Some(h) = read_header(i) else { break };
            headers.push(h);
        }
        // The string table the headers name themselves by (shstrndx), as name → offset
        // map: a fallback for tables a symbol section's link misses.
        let mut names: HashMap<u64, String> = HashMap::new();
        if let Some(sh) = headers.get(effective_shstrndx) {
            if sh.kind == 3 {
                let from = sh.offset as usize;
                let to = sh.offset.saturating_add(sh.size).min(bytes.len() as u64) as usize;
                if from <= to && to <= bytes.len() {
                    let mut k = from;
                    while k < to {
                        let end = bytes[k..to].iter().position(|&b| b == 0).map(|p| k + p).unwrap_or(to);
                        names.insert((k - from) as u64, String::from_utf8_lossy(&bytes[k..end]).into_owned());
                        k = end + 1;
                    }
                }
            }
        }
        for (i, h) in headers.iter().enumerate().skip(1) {
            let name = sym_string(bytes, h.link, i, &headers, h.name_off, &names);
            sections.push(ElfSection {
                name,
                kind: section_kind_name(h.kind),
                addr: h.addr,
                offset: h.offset,
                size: h.size,
                alloc: h.flags & 0x2 != 0,
                write: h.flags & 0x1 != 0,
                exec: h.flags & 0x4 != 0,
            });
        }
    }

    // The symbol tables: .symtab first (a debug build's full set), .dynsym beside it —
    // every FUNC/OBJECT with a size, the largest first.
    let mut symbols: Vec<ElfSymbol> = Vec::new();
    let mut symbols_total = 0usize;
    let mut needed: Vec<String> = Vec::new();
    let entsize = if wide { 24 } else { 16 };
    for kind_wanted in ["SYMTAB", "DYNSYM"] {
        let Some(si) = sections.iter().position(|s| s.kind == kind_wanted) else { continue };
        let sec = &sections[si];
        let strings = |name_off: u32| -> String {
            sym_string(bytes, headers[si + 1].link, si + 1, &headers, name_off, &HashMap::new())
        };
        let from = sec.offset as usize;
        let count = (sec.size as usize) / entsize;
        for k in 0..count {
            let base = from + k * entsize;
            if base + entsize > bytes.len() {
                break;
            }
            let (name_off, value, size, info) = if wide {
                let name_off = at_u32(base).unwrap_or(0);
                let info = bytes.get(base + 4).copied().unwrap_or(0);
                let value = at_u64(base + 8).unwrap_or(0);
                let size = at_u64(base + 16).unwrap_or(0);
                (name_off, value, size, info)
            } else {
                let name_off = at_u32(base).unwrap_or(0);
                let value = at_u32(base + 4).unwrap_or(0) as u64;
                let size = at_u32(base + 8).unwrap_or(0) as u64;
                let info = bytes.get(base + 12).copied().unwrap_or(0);
                (name_off, value, size, info)
            };
            symbols_total += 1;
            let stt = info & 0xf;
            if stt != 1 && stt != 2 {
                continue; // objects and functions only
            }
            if size == 0 {
                continue; // sizeless imports and declarations carry no footprint
            }
            if symbols.len() >= MAX_SYMBOLS {
                continue;
            }
            let bind = info >> 4;
            symbols.push(ElfSymbol {
                name: strings(name_off),
                value,
                size,
                kind: if stt == 2 { "func".into() } else { "object".into() },
                bind: match bind {
                    0 => "local".into(),
                    1 => "global".into(),
                    2 => "weak".into(),
                    other => format!("0x{other:x}"),
                },
            });
        }
        // DT_NEEDED once, off the dynamic section's entries.
        if kind_wanted == "DYNSYM" {
            needed = dynamic_needed(bytes, wide, little, &sections);
        }
    }
    symbols.sort_by(|a, b| b.size.cmp(&a.size).then(a.name.cmp(&b.name)));

    let mut rom_bytes = 0u64;
    let mut ram_bytes = 0u64;
    for s in &sections {
        if !s.alloc {
            continue;
        }
        if s.write {
            ram_bytes += s.size;
        } else {
            rom_bytes += s.size;
        }
    }

    Ok(ElfDocument {
        class_bits: if wide { 64 } else { 32 },
        little_endian: little,
        file_type: file_type_name(file_type),
        machine_name: machine_name(machine),
        entry,
        segments,
        sections,
        symbols_total,
        symbols,
        needed,
        rom_bytes,
        ram_bytes,
        total_bytes,
    })
}

/// One string out of the string table a header's `link` names (the symbol tables' and
/// sections' names live there); `fallback` is the shstrtab map the sections cite.
fn sym_string(
    bytes: &[u8],
    link: u32,
    header_index: usize,
    headers: &[SectionHeader],
    name_off: u32,
    fallback: &HashMap<u64, String>,
) -> String {
    // The named header's own string table first (sh_link of the citing header).
    let table: Option<(usize, usize)> = headers
        .get(link as usize)
        .filter(|sh| sh.kind == 3)
        .map(|sh| {
            let from = sh.offset as usize;
            let to = sh.offset.saturating_add(sh.size).min(bytes.len() as u64) as usize;
            (from, to)
        })
        .filter(|(from, to)| from <= to && *to <= bytes.len() && header_index != link as usize);
    if let Some((from, to)) = table {
        let at = from.saturating_add(name_off as usize);
        if at < to {
            let end = bytes[at..to].iter().position(|&b| b == 0).map(|p| at + p).unwrap_or(to);
            return String::from_utf8_lossy(&bytes[at..end]).into_owned();
        }
    }
    fallback.get(&(name_off as u64)).cloned().unwrap_or_default()
}

/// The dynamic section's DT_NEEDED entries — each `d_val` an offset into `.dynstr`,
/// the section whose name every linker writes.
fn dynamic_needed(bytes: &[u8], wide: bool, little: bool, sections: &[ElfSection]) -> Vec<String> {
    let Some(dynstr) = sections.iter().find(|s| s.name == ".dynstr") else { return Vec::new() };
    let Some(dyn_sec) = sections.iter().find(|s| s.name == ".dynamic") else { return Vec::new() };
    let entsize = if wide { 16 } else { 8 };
    let from = dyn_sec.offset as usize;
    let count = (dyn_sec.size as usize) / entsize;
    let read_u64 = |off: usize| -> Option<u64> {
        let b = bytes.get(off..off + 8)?;
        let mut arr = [0u8; 8];
        arr.copy_from_slice(b);
        Some(if little { u64::from_le_bytes(arr) } else { u64::from_be_bytes(arr) })
    };
    let read_u32 = |off: usize| -> Option<u32> {
        let b = bytes.get(off..off + 4)?;
        Some(if little { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) })
    };
    let mut out = Vec::new();
    for k in 0..count {
        let base = from + k * entsize;
        if base + entsize > bytes.len() {
            break;
        }
        let tag = if wide {
            read_u64(base).unwrap_or(0) as i64
        } else {
            read_u32(base).unwrap_or(0) as i32 as i64
        };
        if tag == 0 {
            break;
        }
        if tag != 1 {
            continue; // DT_NEEDED only
        }
        let val = if wide {
            read_u64(base + 8).unwrap_or(0)
        } else {
            read_u32(base + 4).unwrap_or(0) as u64
        };
        // The value indexes .dynstr.
        let at = (dynstr.offset as usize).saturating_add(val as usize);
        let to = dynstr.offset.saturating_add(dynstr.size).min(bytes.len() as u64) as usize;
        if at >= to {
            continue;
        }
        let end = bytes[at..to].iter().position(|&b| b == 0).map(|p| at + p).unwrap_or(to);
        out.push(String::from_utf8_lossy(&bytes[at..end]).into_owned());
    }
    out
}

fn segment_kind_name(kind: u32) -> String {
    match kind {
        0 => "NULL".into(),
        1 => "LOAD".into(),
        2 => "DYNAMIC".into(),
        3 => "INTERP".into(),
        4 => "NOTE".into(),
        5 => "SHLIB".into(),
        6 => "PHDR".into(),
        7 => "TLS".into(),
        0x6474e550 => "GNU_EH_FRAME".into(),
        0x6474e551 => "GNU_STACK".into(),
        0x6474e552 => "GNU_RELRO".into(),
        0x6474e553 => "GNU_PROPERTY".into(),
        other => format!("0x{other:x}"),
    }
}

fn section_kind_name(kind: u32) -> String {
    match kind {
        0 => "NULL".into(),
        1 => "PROGBITS".into(),
        2 => "SYMTAB".into(),
        3 => "STRTAB".into(),
        4 => "RELA".into(),
        5 => "HASH".into(),
        6 => "DYNAMIC".into(),
        7 => "NOTE".into(),
        8 => "NOBITS".into(),
        9 => "REL".into(),
        10 => "SHLIB".into(),
        11 => "DYNSYM".into(),
        14 => "INIT_ARRAY".into(),
        15 => "FINI_ARRAY".into(),
        16 => "PREINIT_ARRAY".into(),
        17 => "GROUP".into(),
        18 => "SYMTAB_SHNDX".into(),
        0x6ffffff6 => "GNU_HASH".into(),
        0x6ffffffd => "GNU_VERDEF".into(),
        0x6ffffffe => "GNU_VERNEED".into(),
        0x6fffffff => "GNU_VERSYM".into(),
        other => format!("0x{other:x}"),
    }
}

fn file_type_name(kind: u16) -> String {
    match kind {
        1 => "REL".into(),
        2 => "EXEC".into(),
        3 => "DYN".into(),
        4 => "CORE".into(),
        other => format!("0x{other:x}"),
    }
}

fn machine_name(machine: u16) -> String {
    match machine {
        0 => "None".into(),
        3 => "x86".into(),
        8 => "MIPS".into(),
        20 => "PowerPC".into(),
        21 => "PowerPC64".into(),
        40 => "ARM".into(),
        50 => "IA-64".into(),
        62 => "x86-64".into(),
        83 => "AVR".into(),
        88 => "MSP430".into(),
        92 => "OpenRISC".into(),
        94 => "XTENSA".into(),
        113 => "ARM64 (ILP32)".into(),
        183 => "AArch64".into(),
        190 => "TI C6000".into(),
        224 => "eBPF".into(),
        243 => "RISC-V".into(),
        247 => "BPF".into(),
        252 => "LoongArch".into(),
        other => format!("machine 0x{other:x}"),
    }
}

/* ---------- The document store ---------- */

/// The open images — `elf_open` registering, the symbol window reads and `elf_close`
/// releasing.
#[derive(Default)]
pub struct ElfState {
    next_id: AtomicU32,
    docs: Mutex<HashMap<u32, Arc<ElfDocument>>>,
}

impl ElfState {
    pub fn register(&self, doc: Arc<ElfDocument>) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.docs.lock().unwrap().insert(id, doc);
        id
    }

    pub fn get(&self, doc_id: u32) -> Option<Arc<ElfDocument>> {
        self.docs.lock().unwrap().get(&doc_id).map(Arc::clone)
    }

    pub fn release(&self, doc_id: u32) {
        self.docs.lock().unwrap().remove(&doc_id);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolWindow {
    /// How many symbols the current filter matches — the scroll range's length.
    pub total: usize,
    pub lines: Vec<ElfSymbol>,
}

/// A window of the symbols in the order the document keeps (largest first), narrowed
/// by a case-insensitive substring filter when one is given.
pub fn symbols_of(doc: &ElfDocument, start: usize, end: usize, filter: Option<&str>) -> SymbolWindow {
    let matched: Vec<&ElfSymbol> = match filter {
        Some(f) if !f.is_empty() => {
            let f = f.to_lowercase();
            doc.symbols.iter().filter(|s| s.name.to_lowercase().contains(&f)).collect()
        }
        _ => doc.symbols.iter().collect(),
    };
    let total = matched.len();
    let start = start.min(total);
    let end = end.min(total).max(start);
    let lines = matched[start..end].iter().map(|s| (*s).clone()).collect();
    SymbolWindow { total, lines }
}

/* ---------- Tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a minimal 64-bit LE EXEC: two PT_LOADs (RX text, RW data), eleven sections
    /// (null, shstrtab, text, rodata, data, bss, symtab, strtab, dynsym, dynstr,
    /// dynamic), a symtab with sized symbols, and a dynamic pair carrying one DT_NEEDED.
    fn elf64_image() -> Vec<u8> {
        let mut b: Vec<u8> = Vec::new();
        let push = |b: &mut Vec<u8>, v: &[u8]| b.extend_from_slice(v);
        let u16le = |v: u16| v.to_le_bytes().to_vec();
        let u32le = |v: u32| v.to_le_bytes().to_vec();
        let u64le = |v: u64| v.to_le_bytes().to_vec();

        // ---- header (64 bytes) ----
        push(&mut b, b"\x7fELF\x02\x01\x01\x00");
        push(&mut b, &[0u8; 8]); // padding
        push(&mut b, &u16le(2)); // ET_EXEC
        push(&mut b, &u16le(62)); // x86-64
        push(&mut b, &u32le(1)); // version
        push(&mut b, &u64le(0x1000)); // entry
        push(&mut b, &u64le(64)); // phoff (right after the header)
        push(&mut b, &u64le(0)); // shoff — patched once the headers sit at the end
        push(&mut b, &u32le(0)); // flags
        push(&mut b, &u16le(64)); // ehsize
        push(&mut b, &u16le(56)); // phentsize
        push(&mut b, &u16le(2)); // phnum
        push(&mut b, &u16le(64)); // shentsize
        push(&mut b, &u16le(11)); // shnum
        push(&mut b, &u16le(1)); // shstrndx

        // ---- program headers (2 × 56) ----
        // PT_LOAD RX: offset 0x1000, vaddr 0x1000, filesz 0x20
        push(&mut b, &u32le(1)); // LOAD
        push(&mut b, &u32le(5)); // R+X
        push(&mut b, &u64le(0x1000));
        push(&mut b, &u64le(0x1000));
        push(&mut b, &u64le(0x1000)); // paddr
        push(&mut b, &u64le(0x20));
        push(&mut b, &u64le(0x20));
        push(&mut b, &u64le(0x1000)); // align
        // PT_LOAD RW: offset 0x2000, vaddr 0x2000, filesz 0x10, memsz 0x30 (bss)
        push(&mut b, &u32le(1));
        push(&mut b, &u32le(6)); // R+W
        push(&mut b, &u64le(0x2000));
        push(&mut b, &u64le(0x2000));
        push(&mut b, &u64le(0x2000));
        push(&mut b, &u64le(0x10));
        push(&mut b, &u64le(0x30));
        push(&mut b, &u64le(0x1000));

        // Body layout:
        //   0x1000 .text (0x20)   0x1200 .rodata (0x10)
        //   0x2000 .data (0x10)   0x2100 .bss (0x20, NOBITS)
        //   0x2200 symtab         0x2300 strtab
        //   0x2400 dynsym         0x2500 dynstr
        //   0x2600 dynamic        then .shstrtab, then the section headers.
        while b.len() < 0x1000 {
            b.push(0);
        }
        push(&mut b, &[0x90u8; 0x20]); // .text
        while b.len() < 0x1200 {
            b.push(0);
        }
        push(&mut b, &[0xABu8; 0x10]); // .rodata
        while b.len() < 0x2000 {
            b.push(0);
        }
        push(&mut b, &[0x11u8; 0x10]); // .data
        while b.len() < 0x2200 {
            b.push(0);
        }
        // symtab: 4 entries × 24 (null, big_func, big_table, a sizeless local)
        let sym = |name: u32, info: u8, value: u64, size: u64| -> Vec<u8> {
            let mut v = Vec::new();
            v.extend_from_slice(&name.to_le_bytes());
            v.push(info);
            v.push(0); // other
            v.extend_from_slice(&u16le(2)); // shndx: .text
            v.extend_from_slice(&value.to_le_bytes());
            v.extend_from_slice(&size.to_le_bytes());
            v
        };
        // The name fields cite the strtab's real offsets: "big_func" at 1,
        // "big_table" at 10, "sizeless" at 20.
        push(&mut b, &sym(0, 0, 0, 0));
        push(&mut b, &sym(1, 0x12, 0x1000, 0x10)); // global FUNC "big_func"
        push(&mut b, &sym(10, 0x11, 0x2000, 0x8)); // global OBJECT "big_table"
        push(&mut b, &sym(20, 0x10, 0x1000, 0x0)); // local FUNC sizeless — filtered
        while b.len() < 0x2300 {
            b.push(0);
        }
        // strtab: "\0big_func\0big_table\0sizeless\0" (29 bytes)
        push(&mut b, b"\0big_func\0big_table\0sizeless\0");
        while b.len() < 0x2400 {
            b.push(0);
        }
        // dynsym: the null entry + a sizeless unnamed import (counted, not kept)
        push(&mut b, &sym(0, 0, 0, 0));
        push(&mut b, &sym(0, 0x12, 0, 0));
        while b.len() < 0x2500 {
            b.push(0);
        }
        // dynstr: "\0libc.so.6\0" (11 bytes)
        push(&mut b, b"\0libc.so.6\0");
        while b.len() < 0x2600 {
            b.push(0);
        }
        // dynamic: DT_NEEDED → dynstr offset 1; DT_NULL
        push(&mut b, &u64le(1)); // DT_NEEDED
        push(&mut b, &u64le(1)); // → "libc.so.6"
        push(&mut b, &u64le(0));
        push(&mut b, &u64le(0));
        while b.len() < 0x2700 {
            b.push(0);
        }
        // shstrtab, then the section headers; shoff patches once its offset is known.
        let shstr_start = b.len();
        push(&mut b, b"\0.text\0.rodata\0.data\0.bss\0.symtab\0.strtab\0.dynsym\0.dynstr\0.dynamic\0.shstrtab\0");
        let shstr_len = b.len() - shstr_start;
        let sh = |name: u32, kind: u32, flags: u64, addr: u64, offset: u64, size: u64, link: u32| -> Vec<u8> {
            let mut v = Vec::new();
            v.extend_from_slice(&name.to_le_bytes());
            v.extend_from_slice(&kind.to_le_bytes());
            v.extend_from_slice(&flags.to_le_bytes());
            v.extend_from_slice(&addr.to_le_bytes());
            v.extend_from_slice(&offset.to_le_bytes());
            v.extend_from_slice(&size.to_le_bytes());
            v.extend_from_slice(&u32le(link));
            v.extend_from_slice(&u32le(0)); // info
            v.extend_from_slice(&u64le(0)); // addralign
            v.extend_from_slice(&u64le(0)); // entsize
            v
        };
        let names: Vec<u32> = {
            let table = b[shstr_start..].to_vec();
            let find = |s: &str| -> u32 {
                table.windows(s.len() + 1)
                    .position(|w| w.starts_with(&[0u8]) && &w[1..] == s.as_bytes())
                    .map(|p| (p + 1) as u32)
                    .unwrap_or(0)
            };
            vec![
                find(".text"), find(".rodata"), find(".data"), find(".bss"),
                find(".symtab"), find(".strtab"), find(".dynsym"), find(".dynstr"), find(".dynamic"),
            ]
        };
        let shoff_pos = b.len();
        push(&mut b, &sh(0, 0, 0, 0, 0, 0, 0)); // null
        push(&mut b, &sh(0, 3, 0, 0, shstr_start as u64, shstr_len as u64, 0)); // .shstrtab
        push(&mut b, &sh(names[0], 1, 0x6, 0x1000, 0x1000, 0x20, 0)); // .text A X
        push(&mut b, &sh(names[1], 1, 0x2, 0x1200, 0x1200, 0x10, 0)); // .rodata A
        push(&mut b, &sh(names[2], 1, 0x3, 0x2000, 0x2000, 0x10, 0)); // .data A W
        push(&mut b, &sh(names[3], 8, 0x3, 0x2100, 0x2100, 0x20, 0)); // .bss A W NOBITS
        push(&mut b, &sh(names[4], 2, 0, 0, 0x2200, 4 * 24, 7)); // .symtab → .strtab
        push(&mut b, &sh(names[5], 3, 0, 0, 0x2300, 29, 0)); // .strtab
        push(&mut b, &sh(names[6], 11, 0, 0, 0x2400, 2 * 24, 9)); // .dynsym → .dynstr
        push(&mut b, &sh(names[7], 3, 0, 0, 0x2500, 11, 0)); // .dynstr
        push(&mut b, &sh(names[8], 6, 0, 0, 0x2600, 2 * 16, 0)); // .dynamic (no ALLOC here)
        // Patch the header: shoff (bytes 40..48).
        b[40..48].copy_from_slice(&(shoff_pos as u64).to_le_bytes());
        b
    }

    #[test]
    fn reads_the_header() {
        let img = elf64_image();
        let doc = parse(&img, img.len() as u64).unwrap();
        assert_eq!(doc.class_bits, 64);
        assert!(doc.little_endian);
        assert_eq!(doc.file_type, "EXEC");
        assert_eq!(doc.machine_name, "x86-64");
        assert_eq!(doc.entry, 0x1000);
    }

    #[test]
    fn reads_segments_and_sections() {
        let img = elf64_image();
        let doc = parse(&img, img.len() as u64).unwrap();
        assert_eq!(doc.segments.len(), 2);
        let text_seg = &doc.segments[0];
        assert_eq!(text_seg.kind, "LOAD");
        assert_eq!(text_seg.flags, "RX");
        assert_eq!(text_seg.vaddr, 0x1000);
        assert_eq!(text_seg.file_bytes, 0x20);
        let data_seg = &doc.segments[1];
        assert_eq!(data_seg.flags, "RW");
        assert_eq!(data_seg.mem_bytes, 0x30);

        let text = doc.sections.iter().find(|s| s.name == ".text").expect(".text header");
        assert!(text.alloc && !text.write && text.exec);
        assert_eq!(text.size, 0x20);
        let bss = doc.sections.iter().find(|s| s.name == ".bss").expect(".bss header");
        assert_eq!(bss.kind, "NOBITS");
        assert!(bss.alloc && bss.write);
    }

    #[test]
    fn sums_the_rom_and_ram_footprint() {
        let img = elf64_image();
        let doc = parse(&img, img.len() as u64).unwrap();
        // ROM: .text 0x20 + .rodata 0x10; RAM: .data 0x10 + .bss 0x20.
        assert_eq!(doc.rom_bytes, 0x30);
        assert_eq!(doc.ram_bytes, 0x30);
    }

    #[test]
    fn keeps_the_sized_functions_and_objects_largest_first() {
        let img = elf64_image();
        let doc = parse(&img, img.len() as u64).unwrap();
        // symtab 4 + dynsym 2 = 6 listed; kept: big_func (0x10), big_table (0x8) —
        // the sizeless local and the unnamed import dropped, the largest first.
        assert_eq!(doc.symbols_total, 6);
        assert_eq!(doc.symbols.len(), 2);
        assert_eq!(doc.symbols[0].name, "big_func");
        assert_eq!(doc.symbols[0].size, 0x10);
        assert_eq!(doc.symbols[0].kind, "func");
        assert_eq!(doc.symbols[1].name, "big_table");
        assert_eq!(doc.symbols[1].kind, "object");
        assert_eq!(doc.symbols[1].bind, "global");
    }

    #[test]
    fn names_the_dynamic_dependencies() {
        let img = elf64_image();
        let doc = parse(&img, img.len() as u64).unwrap();
        assert_eq!(doc.needed, vec!["libc.so.6".to_string()]);
    }

    #[test]
    fn symbol_windows_filter_and_slice() {
        let img = elf64_image();
        let doc = parse(&img, img.len() as u64).unwrap();
        let all = symbols_of(&doc, 0, 100, None);
        assert_eq!(all.total, 2);
        let one = symbols_of(&doc, 1, 2, None);
        assert_eq!(one.lines.len(), 1);
        assert_eq!(one.lines[0].name, "big_table");
        let hit = symbols_of(&doc, 0, 100, Some("TABLE"));
        assert_eq!(hit.total, 1);
        assert_eq!(hit.lines[0].name, "big_table");
        let none = symbols_of(&doc, 0, 100, Some("zzz"));
        assert_eq!(none.total, 0);
        assert!(none.lines.is_empty());
    }

    #[test]
    fn junk_is_an_error_not_a_panic() {
        assert!(parse(b"not an elf at all", 16).is_err());
        assert!(parse(&[], 0).is_err());
        // The magic with a nonsense class refuses cleanly.
        let mut bad = elf64_image();
        bad[4] = 9;
        assert!(parse(&bad, bad.len() as u64).is_err());
    }

    #[test]
    fn a_truncated_image_is_an_error_not_a_panic() {
        let img = elf64_image();
        assert!(parse(&img[..20], 20).is_err());
    }

    #[test]
    fn the_state_registers_and_releases() {
        let state = ElfState::default();
        let img = elf64_image();
        let doc = Arc::new(parse(&img, img.len() as u64).unwrap());
        let id = state.register(Arc::clone(&doc));
        assert!(state.get(id).is_some());
        state.release(id);
        assert!(state.get(id).is_none());
    }

    #[test]
    fn open_doc_reads_a_file_and_refuses_others() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("firmware.elf");
        std::fs::write(&path, elf64_image()).unwrap();
        let doc = open_doc(&path).unwrap();
        assert_eq!(doc.machine_name, "x86-64");
        let text = dir.path().join("note.txt");
        std::fs::write(&text, b"hello").unwrap();
        assert!(open_doc(&text).is_err());
    }
}
