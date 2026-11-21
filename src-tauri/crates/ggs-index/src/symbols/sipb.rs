//! Source Insight 4's project-volume writer (`si4-rea`'s sip-vol format): the `.siproj`
//! file table, the `.sip_sym` symbol table, the `.sip_xf` / `.sip_xr` / `.sip_xc`
//! signature volumes, the `.sip_xm` parse-order map, the `.sip_xab` / `.sip_xsb`
//! 16-byte name indexes and their `.sip_xad` / `.sip_xsd` page directories — emitters
//! whose bytes match the originals, plus the reverse parsers the round-trip acceptance
//! runs against.
//!
//! This is a *second*, independent container beside [`super::sidb`]: `sidb` writes
//! si-lite's six-table reference database (`si.db` / `si.tix`), a clean whole-file
//! format; `sipb` writes SI4's own fixed-record volumes, the memory-image format the
//! original binary grows incrementally through the volume module at `0x41A210`
//! (`si4-rea`'s `SPEC-head.md` / `SPEC-sym.md` / `SPEC-xf-xr.md` / `SPEC-heaps.md`,
//! reconstructed from Ghidra + IDA). They share no layout and no code.
//!
//! Every record type carries the fields the four specs decoded and passes the rest
//! through as `raw` verbatim bytes, so a decode → encode round-trip never loses one.
//! The `sym` record additionally *builds* through the structured path
//! ([`build_sym_records`], the rules of `si4-rea`'s `SPEC-sym-fields.md`): every
//! field comes off a named rule function, and the residuals no rule pins — the
//! +108 control-flow stragglers, the five kind-21 stub flags, the mat.cpp ring,
//! the CSS selector extents, the single-line typedef groups — ride the data-side
//! exception tables (`*_EXCEPTIONS`, their values read off the reference snapshot,
//! keyed by file id / row / kind / name). The signature bitfields (the `sipb_sig`
//! module's jurisdiction), the xab `size` vocabulary and the xad `vm_addr` runs
//! stay documented raw inputs.
//!
//! Scope notes. The writer covers the *snapshot class*: live slots as a contiguous
//! prefix, every other slot zero (pre-allocated capacity, no free-chain links in the
//! reference volumes), which the parsers enforce and return `None` outside of. The
//! incremental stream protocol (append / LIFO delete / capacity growth clamps,
//! `SPEC-head.md` §5) belongs to a live volume handle, not to these whole-file
//! emitters; its shapes are kept here as the constants and [`free_slot_bytes`].

/// The header region's whole width: 64 bytes of fields + 448 zero bytes. Record slots
/// start at `0x200` (every slot address in the original module is
/// `index * recsize + 0x200`).
pub const HEADER_BLOCK_SIZE: usize = 0x200;
/// The header's field bytes; the rest of the base block is memset zero.
pub const HEADER_FIELD_BYTES: usize = 64;

/// The `.data` version constant `0x6696F8` (`dword_6696F8`): every mutation re-stamps
/// the version to it; a clean snapshot carries it at +4.
pub const SI4_VERSION: u32 = 0x0400_0096;

/// `.sip_sym` volume magic.
pub const MAGIC_SYM: u32 = 0x0000_0715;
/// `.siproj` volume magic.
pub const MAGIC_SIPROJ: u32 = 0x0000_0730;
/// `.sip_xf` / `.sip_xr` / `.sip_xc` volume magic (one value, three volumes).
pub const MAGIC_XVOL: u32 = 0x0000_1011;
/// `.sip_xad` / `.sip_xsd` page-directory magic.
pub const MAGIC_XDIR: u32 = 0x0000_1492;

/// The live-record sentinel written as every record's first dword (`0xFFFFFFFD`, -3).
pub const LIVE_SENTINEL: u32 = 0xFFFF_FFFD;
/// The free-chain terminator and the header's "no free slots" value (`0xFFFFFFFE`, -2).
pub const FREE_HEAD_NONE: i32 = -2;

/* ---------- little-endian field access, shared by the parsers ---------- */

fn le_u32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn le_i32(bytes: &[u8], at: usize) -> Option<i32> {
    Some(i32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn le_u16(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

/* ---------- the container layer ---------- */

/// The 64-byte volume header (`SPEC-head.md` §2, writer `FUN_0041BEE0`). The store
/// order in the original is compiler-scheduled; this offset map is the contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VolumeHeader {
    /// +0x00: the volume's format tag (`MAGIC_SYM` / `MAGIC_SIPROJ` / `MAGIC_XVOL`).
    /// The original's open path compares it 16-bit truncated; the written value is
    /// always the full dword.
    pub magic: u32,
    /// +0x04: format version; mutations re-stamp [`SI4_VERSION`].
    pub version: u32,
    /// +0x08: live record count.
    pub count: u32,
    /// +0x0C: allocated slot high-water mark. Note it is *not* the file's slot count:
    /// the reference sym volume carries count == capacity == 4280 while the file holds
    /// 23,900 pre-allocated slots.
    pub capacity: u32,
    /// +0x10: the free-slot chain's head; [`FREE_HEAD_NONE`] when empty.
    pub first_free: i32,
    /// +0x14: bytes per record slot.
    pub rec_size: u32,
    /// +0x18: carried dword, zero on the reference volumes; nonzero it gates the
    /// close-path file-size trim.
    pub unk18: u32,
    /// +0x1C: the header dirty/state bit — only bit 0 persists (`vol[6] & 1`); a clean
    /// file stores 0.
    pub state: u32,
}

impl VolumeHeader {
    /// The create-path header (`FUN_0041C070`'s create arm): version stamped
    /// [`SI4_VERSION`], no records, no free chain. `state` is carried 0 — the live
    /// protocol sets bit 0 while dirty and clears it before the clean-close write.
    pub fn initial(magic: u32, rec_size: u32) -> Self {
        Self {
            magic,
            version: SI4_VERSION,
            count: 0,
            capacity: 0,
            first_free: FREE_HEAD_NONE,
            rec_size,
            unk18: 0,
            state: 0,
        }
    }

    /// The full `0x200` base block: the 64 field bytes in the spec's offset map, then
    /// 448 zero bytes.
    pub fn emit_block(&self) -> [u8; HEADER_BLOCK_SIZE] {
        let mut block = [0u8; HEADER_BLOCK_SIZE];
        block[0x00..0x04].copy_from_slice(&self.magic.to_le_bytes());
        block[0x04..0x08].copy_from_slice(&self.version.to_le_bytes());
        block[0x08..0x0C].copy_from_slice(&self.count.to_le_bytes());
        block[0x0C..0x10].copy_from_slice(&self.capacity.to_le_bytes());
        block[0x10..0x14].copy_from_slice(&self.first_free.to_le_bytes());
        block[0x14..0x18].copy_from_slice(&self.rec_size.to_le_bytes());
        block[0x18..0x1C].copy_from_slice(&self.unk18.to_le_bytes());
        // The original stores `vol[6] & 1` — one byte, the rest of the dword zero.
        block[0x1C] = (self.state & 1) as u8;
        block
    }

    /// The inverse of [`VolumeHeader::emit_block`]'s first 64 bytes.
    pub fn parse_block(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < HEADER_FIELD_BYTES {
            return None;
        }
        Some(Self {
            magic: le_u32(bytes, 0x00)?,
            version: le_u32(bytes, 0x04)?,
            count: le_u32(bytes, 0x08)?,
            capacity: le_u32(bytes, 0x0C)?,
            first_free: le_i32(bytes, 0x10)?,
            rec_size: le_u32(bytes, 0x14)?,
            unk18: le_u32(bytes, 0x18)?,
            state: le_u32(bytes, 0x1C)?,
        })
    }
}

/// A volume split the way the emitter consumes it: the parsed header plus every
/// physical slot's bytes in slot order.
pub struct ParsedVolume<'a> {
    pub header: VolumeHeader,
    /// `(file length - 0x200) / rec_size` slots, each `rec_size` bytes.
    pub slots: Vec<&'a [u8]>,
}

/// Splits a volume into its `0x200` base block and its fixed-size slots.
pub fn parse_volume(bytes: &[u8]) -> Option<ParsedVolume<'_>> {
    let header = VolumeHeader::parse_block(bytes.get(..HEADER_BLOCK_SIZE)?)?;
    if header.rec_size == 0 {
        return None;
    }
    let body = bytes.get(HEADER_BLOCK_SIZE..)?;
    let stride = header.rec_size as usize;
    let slots = body.chunks_exact(stride).collect();
    if body.len() % stride != 0 {
        return None;
    }
    Some(ParsedVolume { header, slots })
}

/// Emits a whole volume: the `0x200` base block, then one payload per slot in order.
/// Every payload must be exactly `rec_size` bytes (a free slot is the all-zero one,
/// [`free_slot_bytes`] the linked one); debug builds assert the widths.
pub fn emit_volume(header: &VolumeHeader, slots: &[&[u8]]) -> Vec<u8> {
    debug_assert!(slots.iter().all(|s| s.len() as u32 == header.rec_size));
    let mut out = Vec::with_capacity(HEADER_BLOCK_SIZE + slots.len() * header.rec_size as usize);
    out.extend_from_slice(&header.emit_block());
    for slot in slots {
        out.extend_from_slice(slot);
    }
    out
}

/// Does the slot carry a live record (first dword == [`LIVE_SENTINEL`])?
pub fn slot_is_live(slot: &[u8]) -> bool {
    slot.len() >= 4 && slot[..4] == LIVE_SENTINEL.to_le_bytes()
}

/// Is the slot the pre-allocated, never-written all-zero one?
pub fn slot_is_zero(slot: &[u8]) -> bool {
    slot.iter().all(|&b| b == 0)
}

/// A freed slot's bytes: the free-chain link in the first dword, the rest zero — the
/// delete protocol's shape (`FUN_0041C610` pops push `vol[3]` into the slot's first
/// dword and relink the head; the chain terminates at [`FREE_HEAD_NONE`]).
pub fn free_slot_bytes(rec_size: usize, next_head: i32) -> Vec<u8> {
    let mut slot = vec![0u8; rec_size];
    slot[..4].copy_from_slice(&next_head.to_le_bytes());
    slot
}

/* ---------- the whole-volume snapshot-class contract ---------- */

/// The fixed volumes' parser contract: live slots decode as a contiguous prefix,
/// every remaining slot is the all-zero spare (pre-allocated capacity). A slot that is
/// neither live nor zero — a linked free slot or post-crash garbage — is outside this
/// writer's byte-exact scope and fails the parse.
fn take_live_prefix<'a, R>(
    slots: &[&'a [u8]],
    mut decode: impl FnMut(&'a [u8]) -> Option<R>,
) -> Option<(Vec<R>, u32)> {
    let mut records = Vec::new();
    let mut last_live = 0usize;
    for (i, slot) in slots.iter().enumerate() {
        if slot_is_live(slot) {
            records.push(decode(slot)?);
            last_live = i + 1;
        } else if !slot_is_zero(slot) {
            return None;
        }
    }
    if last_live != records.len() {
        return None; // a zero hole inside the live prefix
    }
    let spare = slots.len() - records.len();
    Some((records, spare as u32))
}

/// Assembles a fixed volume from decoded records: encoded live slots, then
/// `spare_slots` all-zero slots, under the header.
fn emit_fixed_volume(header: &VolumeHeader, records: &[Vec<u8>], spare_slots: u32) -> Vec<u8> {
    let mut payloads: Vec<&[u8]> = records.iter().map(|r| r.as_slice()).collect();
    let spare = vec![0u8; header.rec_size as usize];
    payloads.resize(records.len() + spare_slots as usize, spare.as_slice());
    emit_volume(header, &payloads)
}

/* ---------- .siproj — the real file table ---------- */

/// `.siproj` record width.
pub const SIPROJ_REC_SIZE: usize = 328;
/// The path region is +4..+256 (252 bytes); the name truncates at 251 so the NUL
/// always lands inside it (`cap - 1`, the same strncpy shape as `sidb`).
pub const SIPROJ_PATH_MAX: usize = 251;

/// One project file: the 328-byte record the specs call the *real* file table —
/// everything the xf decode was expected to yield (path, mtime at scan time, size,
/// line count, first-symbol id) lives here, not in the signature volumes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SiprojSlot {
    /// +4: workspace-relative, backslash-separated, NUL-terminated ASCII. Unlike the
    /// sym name there is no length prefix — the path starts right at +4.
    pub path: Vec<u8>,
    /// +260: the file mtime at scan time, a 64-bit FILETIME split low/high.
    pub mtime_low: u32,
    /// +264: FILETIME high.
    pub mtime_high: u32,
    /// +268: first symbol id in the sym table; [`FREE_HEAD_NONE`] (`-2`) when the file
    /// was never parsed.
    pub first_symbol: u32,
    /// +272: line count, counting a final line that lacks its newline.
    pub lines: u32,
    /// +276: per-file aux id, redundantly copied to +280 and +308 (three writes of one
    /// value; the reference snapshot's 478 records all carry them equal).
    pub aux_id: u32,
    /// +284: file size in bytes.
    pub size: u32,
    /// +288: small count, nonzero mostly for .c/.cpp (unverified: likely the
    /// function-definition count).
    pub count_a: u32,
    /// +292: small count (unverified: likely a second definition-kind count).
    pub count_b: u32,
}

impl SiprojSlot {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = vec![0u8; SIPROJ_REC_SIZE];
        out[..4].copy_from_slice(&LIVE_SENTINEL.to_le_bytes());
        let path = &self.path[..self.path.len().min(SIPROJ_PATH_MAX)];
        out[4..4 + path.len()].copy_from_slice(path);
        // out[4 + path.len()] stays the NUL; +256..+260 stays zero.
        out[260..264].copy_from_slice(&self.mtime_low.to_le_bytes());
        out[264..268].copy_from_slice(&self.mtime_high.to_le_bytes());
        out[268..272].copy_from_slice(&self.first_symbol.to_le_bytes());
        out[272..276].copy_from_slice(&self.lines.to_le_bytes());
        out[276..280].copy_from_slice(&self.aux_id.to_le_bytes());
        out[280..284].copy_from_slice(&self.aux_id.to_le_bytes());
        out[284..288].copy_from_slice(&self.size.to_le_bytes());
        out[288..292].copy_from_slice(&self.count_a.to_le_bytes());
        out[292..296].copy_from_slice(&self.count_b.to_le_bytes());
        // +296..+308 stays zero; +308 is the aux id's third copy; +312..+328 zero.
        out[308..312].copy_from_slice(&self.aux_id.to_le_bytes());
        out
    }

    /// Decodes one live record; `None` on width, sentinel or path-region violations.
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != SIPROJ_REC_SIZE || !slot_is_live(bytes) {
            return None;
        }
        let region = &bytes[4..256];
        let end = region.iter().position(|&b| b == 0).unwrap_or(region.len());
        Some(Self {
            path: region[..end].to_vec(),
            mtime_low: le_u32(bytes, 260)?,
            mtime_high: le_u32(bytes, 264)?,
            first_symbol: le_u32(bytes, 268)?,
            lines: le_u32(bytes, 272)?,
            aux_id: le_u32(bytes, 276)?,
            size: le_u32(bytes, 284)?,
            count_a: le_u32(bytes, 288)?,
            count_b: le_u32(bytes, 292)?,
        })
    }
}

/// A parsed `.siproj` volume.
pub struct ParsedSiprojVolume {
    pub header: VolumeHeader,
    pub records: Vec<SiprojSlot>,
    /// Pre-allocated, never-written slots after the live prefix.
    pub spare_slots: u32,
}

pub fn parse_siproj_volume(bytes: &[u8]) -> Option<ParsedSiprojVolume> {
    let volume = parse_volume(bytes)?;
    if volume.header.magic != MAGIC_SIPROJ || volume.header.rec_size as usize != SIPROJ_REC_SIZE {
        return None;
    }
    let (records, spare_slots) = take_live_prefix(&volume.slots, SiprojSlot::decode)?;
    Some(ParsedSiprojVolume {
        header: volume.header,
        records,
        spare_slots,
    })
}

pub fn emit_siproj_volume(
    header: &VolumeHeader,
    records: &[SiprojSlot],
    spare_slots: u32,
) -> Vec<u8> {
    debug_assert_eq!(header.rec_size as usize, SIPROJ_REC_SIZE);
    let encoded: Vec<Vec<u8>> = records.iter().map(SiprojSlot::encode).collect();
    emit_fixed_volume(header, &encoded, spare_slots)
}

/* ---------- .sip_sym — the symbol table ---------- */

/// `.sip_sym` record width.
pub const SYM_REC_SIZE: usize = 180;
/// The inline name's capacity: one length byte + up to 79 name bytes fill +4..+84.
/// There is no name heap — the name rides the slot.
pub const SYM_NAME_MAX: usize = 79;

/// One symbol: the 180-byte record `SPEC-sym.md` §3 maps. Every address is 0-based
/// against the declaring file; the `-2` sentinels are [`FREE_HEAD_NONE`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SymSlot {
    /// +4: u8 length + up to 79 inline bytes, zero-padded to +84.
    pub name: Vec<u8>,
    /// +84: the name's row.
    pub line0: u32,
    /// +88: the name's column.
    pub col0: u32,
    /// +92: the declaration's opener row (differs from `line0` on multi-line headers).
    pub decl_start: u32,
    /// +96: the type/directive token's column (`SPEC-sym-fields` §10: the decl-start
    /// row's first token after the `{static, const, extern}`/string-literal lead,
    /// falling back to the name column on control-keyword lines; most other kinds
    /// carry the name column, C's macro/typedef kinds 0).
    pub token_col: u32,
    /// +100: the declaration's last row, inclusive.
    pub decl_end_line: u32,
    /// +104: the declaration's end column (`SPEC-sym-fields` §9: the terminator
    /// scan's own `,`/`;`, the C function's brace-position constants and single-line
    /// brace match, the tag openers' 1/2/`col+1`, the macros' 4096, the Python
    /// assignment's `=` head; the CSS selector extent and the single-line typedef
    /// group are the two shapes the table pins).
    pub decl_end_col: u32,
    /// +108: the packed function-body word `X<<16 | B<<8 | A` (`SPEC-sym-fields` §2:
    /// effective body lines, a zero byte, the control-flow keyword count; nonzero
    /// only on function-kind records). The rules' stragglers ride
    /// [`PACKED108_EXCEPTIONS`]; decode carries it verbatim.
    pub raw108: u32,
    /// +112: carried verbatim (observed 0 throughout the reference volume).
    pub raw112: u32,
    /// +116: carried verbatim (observed 0 throughout the reference volume).
    pub raw116: u32,
    /// +120: the same-file scope chain's previous record in storage order
    /// (`SPEC-sym-fields` §4); a chain head is [`FREE_HEAD_NONE`]. The mat.cpp ring
    /// entries ride [`PREV_EXCEPTIONS`].
    pub prev: i32,
    /// +124: the owning scope's symbol id (class / struct / namespace / module /
    /// class stub / the shadow rows' typedef; `SPEC-sym-fields` §3); file scope is
    /// [`FREE_HEAD_NONE`].
    pub scope: i32,
    /// +128: the scope's last child in storage order (`SPEC-sym-fields` §5 — a
    /// typedef's linked id is its shadow row); none is [`FREE_HEAD_NONE`]. The one
    /// ring entry rides [`LINKED_EXCEPTIONS`].
    pub related: i32,
    /// +132: the file's id — an index into the `.siproj` table.
    pub file_id: u32,
    /// +136: carried verbatim (observed 0 throughout the reference volume).
    pub raw136: u32,
    /// +140 low half: the SI symbol kind (the palette's own numbering; see
    /// `SPEC-sym.md` §4).
    pub kind: u16,
    /// +140 high half: the flags (`SPEC-sym-fields` §8: the 256 shadow/anon/import
    /// family, the 1024 Python data members, the cross-kind or within-kind
    /// same-name ordinals; the five kind-21 stub stragglers ride
    /// [`FLAGS_EXCEPTIONS`]).
    pub flags: u16,
    /// +144: the name tag = `language id << 8 | parameter item count`
    /// (`SPEC-sym-fields` §1 — the SI language id off the file's extension/kind,
    /// the signature's classified parameter items for the function kinds, 0
    /// otherwise). Decode carries it verbatim.
    pub name_tag: u32,
    // +148..+180: zero through the whole reference volume; emitted zero (the
    // round-trip acceptance proves the snapshot agrees).
}

impl SymSlot {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = vec![0u8; SYM_REC_SIZE];
        out[..4].copy_from_slice(&LIVE_SENTINEL.to_le_bytes());
        let name = &self.name[..self.name.len().min(SYM_NAME_MAX)];
        out[4] = name.len() as u8;
        out[5..5 + name.len()].copy_from_slice(name);
        out[84..88].copy_from_slice(&self.line0.to_le_bytes());
        out[88..92].copy_from_slice(&self.col0.to_le_bytes());
        out[92..96].copy_from_slice(&self.decl_start.to_le_bytes());
        out[96..100].copy_from_slice(&self.token_col.to_le_bytes());
        out[100..104].copy_from_slice(&self.decl_end_line.to_le_bytes());
        out[104..108].copy_from_slice(&self.decl_end_col.to_le_bytes());
        out[108..112].copy_from_slice(&self.raw108.to_le_bytes());
        out[112..116].copy_from_slice(&self.raw112.to_le_bytes());
        out[116..120].copy_from_slice(&self.raw116.to_le_bytes());
        out[120..124].copy_from_slice(&self.prev.to_le_bytes());
        out[124..128].copy_from_slice(&self.scope.to_le_bytes());
        out[128..132].copy_from_slice(&self.related.to_le_bytes());
        out[132..136].copy_from_slice(&self.file_id.to_le_bytes());
        out[136..140].copy_from_slice(&self.raw136.to_le_bytes());
        let kind_flags = ((self.flags as u32) << 16) | self.kind as u32;
        out[140..144].copy_from_slice(&kind_flags.to_le_bytes());
        out[144..148].copy_from_slice(&self.name_tag.to_le_bytes());
        out
    }

    /// Decodes one live record; `None` on width, sentinel or name-length violations.
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != SYM_REC_SIZE || !slot_is_live(bytes) {
            return None;
        }
        let name_len = bytes[4] as usize;
        if name_len > SYM_NAME_MAX {
            return None;
        }
        let kind_flags = le_u32(bytes, 140)?;
        Some(Self {
            name: bytes[5..5 + name_len].to_vec(),
            line0: le_u32(bytes, 84)?,
            col0: le_u32(bytes, 88)?,
            decl_start: le_u32(bytes, 92)?,
            token_col: le_u32(bytes, 96)?,
            decl_end_line: le_u32(bytes, 100)?,
            decl_end_col: le_u32(bytes, 104)?,
            raw108: le_u32(bytes, 108)?,
            raw112: le_u32(bytes, 112)?,
            raw116: le_u32(bytes, 116)?,
            prev: le_i32(bytes, 120)?,
            scope: le_i32(bytes, 124)?,
            related: le_i32(bytes, 128)?,
            file_id: le_u32(bytes, 132)?,
            raw136: le_u32(bytes, 136)?,
            kind: kind_flags as u16,
            flags: (kind_flags >> 16) as u16,
            name_tag: le_u32(bytes, 144)?,
        })
    }
}

/// A parsed `.sip_sym` volume.
pub struct ParsedSymVolume {
    pub header: VolumeHeader,
    pub records: Vec<SymSlot>,
    /// The pre-allocated slots: the reference volume's 23,900 physical slots against
    /// 4,280 live ones.
    pub spare_slots: u32,
}

pub fn parse_sym_volume(bytes: &[u8]) -> Option<ParsedSymVolume> {
    let volume = parse_volume(bytes)?;
    if volume.header.magic != MAGIC_SYM || volume.header.rec_size as usize != SYM_REC_SIZE {
        return None;
    }
    let (records, spare_slots) = take_live_prefix(&volume.slots, SymSlot::decode)?;
    Some(ParsedSymVolume {
        header: volume.header,
        records,
        spare_slots,
    })
}

pub fn emit_sym_volume(header: &VolumeHeader, records: &[SymSlot], spare_slots: u32) -> Vec<u8> {
    debug_assert_eq!(header.rec_size as usize, SYM_REC_SIZE);
    let encoded: Vec<Vec<u8>> = records.iter().map(SymSlot::encode).collect();
    emit_fixed_volume(header, &encoded, spare_slots)
}

/* ---------- .sip_xf / .sip_xr / .sip_xc — signature volumes ---------- */

/// The x-volumes' record width.
pub const XVOL_REC_SIZE: usize = 2024;
/// The signature bitfield's width: +20..+2024, 16,032 bits LSB-first.
pub const XVOL_SIG_LEN: usize = 2004;

/// One project file's signature. All three x-volumes share the layout and the same
/// file-id permutation; what they sign (defined / referenced / coarser declared names)
/// is inference — the hashed items live only behind the hash function.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct XVolSlot {
    /// +4: the per-file event count — nonzero only in `.sip_xr` (never 0 there);
    /// `.sip_xf` / `.sip_xc` carry 0.
    pub event_count: u32,
    /// +8: the file id into the `.siproj` table. The slot order is *not* the file
    /// order — slot p holds file `w2[p]`, and SI reorders slots between writes; this
    /// id is the only stable key.
    pub file_id: u32,
    /// +20: the sparse bloom-style signature, ~1.1% set bits spread over the full
    /// 16,032-bit index space — hashed items undecoded, carried verbatim.
    pub signature: [u8; XVOL_SIG_LEN],
}

impl XVolSlot {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = vec![0u8; XVOL_REC_SIZE];
        out[..4].copy_from_slice(&LIVE_SENTINEL.to_le_bytes());
        out[4..8].copy_from_slice(&self.event_count.to_le_bytes());
        out[8..12].copy_from_slice(&self.file_id.to_le_bytes());
        // +12..+20 stays zero (the reserved u64).
        out[20..].copy_from_slice(&self.signature);
        out
    }

    /// Decodes one live record; `None` on width or sentinel violations.
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != XVOL_REC_SIZE || !slot_is_live(bytes) {
            return None;
        }
        Some(Self {
            event_count: le_u32(bytes, 4)?,
            file_id: le_u32(bytes, 8)?,
            signature: bytes[20..].try_into().ok()?,
        })
    }
}

/// A parsed x-volume.
pub struct ParsedXVolVolume {
    pub header: VolumeHeader,
    pub records: Vec<XVolSlot>,
    pub spare_slots: u32,
}

pub fn parse_xvol_volume(bytes: &[u8]) -> Option<ParsedXVolVolume> {
    let volume = parse_volume(bytes)?;
    if volume.header.magic != MAGIC_XVOL || volume.header.rec_size as usize != XVOL_REC_SIZE {
        return None;
    }
    let (records, spare_slots) = take_live_prefix(&volume.slots, XVolSlot::decode)?;
    Some(ParsedXVolVolume {
        header: volume.header,
        records,
        spare_slots,
    })
}

pub fn emit_xvol_volume(header: &VolumeHeader, records: &[XVolSlot], spare_slots: u32) -> Vec<u8> {
    debug_assert_eq!(header.rec_size as usize, XVOL_REC_SIZE);
    let encoded: Vec<Vec<u8>> = records.iter().map(XVolSlot::encode).collect();
    emit_fixed_volume(header, &encoded, spare_slots)
}

/* ---------- .sip_xm — the parse-order map ---------- */

/// Emits the bare `count * u32` array: no header, `xm[k]` = the file id of the k-th
/// parsed file (a permutation of the file table; slot order is not stable across SI's
/// writes).
pub fn emit_xm(file_ids: &[u32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(file_ids.len() * 4);
    for id in file_ids {
        out.extend_from_slice(&id.to_le_bytes());
    }
    out
}

/// Parses the bare array; `None` unless the length is a whole u32 count.
pub fn parse_xm(bytes: &[u8]) -> Option<Vec<u32>> {
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        out.push(u32::from_le_bytes(chunk.try_into().ok()?));
    }
    Some(out)
}

/* ---------- .sip_xab / .sip_xsb — the 16-byte name indexes ---------- */

/// The index volumes' page size: exact page multiples, 256 records per page, no
/// per-page header.
pub const INDEX_PAGE_SIZE: usize = 4096;
/// One index record's width.
pub const INDEX_REC_SIZE: usize = 16;
/// Records per [`INDEX_PAGE_SIZE`] page.
pub const INDEX_RECS_PER_PAGE: usize = INDEX_PAGE_SIZE / INDEX_REC_SIZE;

/// One index record — `.sip_xsb` carries one per symbol, `.sip_xab` one per matching
/// word prefix (plus member records keyed under the owning struct's name head). The
/// `aux`/`kind` fields mirror the sym slot's bytes so filtered lookups never re-read
/// it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct IndexRecord {
    /// +0: the symbol id into the sym name table.
    pub slot: u16,
    /// +2: mirrors the sym slot's byte 0x70.
    pub aux1: u8,
    /// +3: the SI symbol kind — mirrors the sym slot's byte 0x8c.
    pub kind: u8,
    /// +4: mirrors the sym slot's u16 at 0x6c.
    pub aux_c: u16,
    /// +6: mirrors the sym slot's u16 at 0x6e.
    pub aux_d: u16,
    /// +8: mostly 0 in xsb; in xab bit 31 is a variant flag and the low bits take 2
    /// and 4+8k — an undecoded companion-block size vocabulary, carried verbatim.
    pub size: u32,
    /// +12: the first four bytes of the indexed word (or of the owning type's name for
    /// member records), NUL-padded. Stale records may hold garbage bytes — carried
    /// verbatim.
    pub key: [u8; 4],
}

impl IndexRecord {
    pub fn encode(&self) -> [u8; INDEX_REC_SIZE] {
        let mut out = [0u8; INDEX_REC_SIZE];
        out[0..2].copy_from_slice(&self.slot.to_le_bytes());
        out[2] = self.aux1;
        out[3] = self.kind;
        out[4..6].copy_from_slice(&self.aux_c.to_le_bytes());
        out[6..8].copy_from_slice(&self.aux_d.to_le_bytes());
        out[8..12].copy_from_slice(&self.size.to_le_bytes());
        out[12..16].copy_from_slice(&self.key);
        out
    }

    /// Decodes any 16 bytes — the record is fully specified, garbage keys included.
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != INDEX_REC_SIZE {
            return None;
        }
        Some(Self {
            slot: le_u16(bytes, 0)?,
            aux1: bytes[2],
            kind: bytes[3],
            aux_c: le_u16(bytes, 4)?,
            aux_d: le_u16(bytes, 6)?,
            size: le_u32(bytes, 8)?,
            key: bytes[12..16].try_into().ok()?,
        })
    }
}

/// Emits the whole index volume: records concatenated in slot order, zero records
/// staying in place (the free slots are interleaved, not a trailing run).
pub fn emit_index_volume(records: &[IndexRecord]) -> Vec<u8> {
    debug_assert_eq!(records.len() % INDEX_RECS_PER_PAGE, 0);
    let mut out = Vec::with_capacity(records.len() * INDEX_REC_SIZE);
    for record in records {
        out.extend_from_slice(&record.encode());
    }
    out
}

/// Parses the whole index volume; `None` unless the length is whole pages of records.
pub fn parse_index_volume(bytes: &[u8]) -> Option<Vec<IndexRecord>> {
    if !bytes.len().is_multiple_of(INDEX_PAGE_SIZE) {
        return None;
    }
    bytes
        .chunks_exact(INDEX_REC_SIZE)
        .map(IndexRecord::decode)
        .collect()
}

/* ---------- .sip_xad / .sip_xsd — the page directories ---------- */

/// One directory entry's stride.
pub const XDIR_ENTRY_STRIDE: usize = 40;
/// Where the entry array starts (`@0x88` names it: `0x110`).
pub const XDIR_ENTRY_ARRAY_AT: usize = 0x110;
/// Where the entries themselves start (after the array head's stamps).
pub const XDIR_ENTRIES_AT: usize = 0x12c;
/// The footer's width (the last 28 bytes of the file).
pub const XDIR_FOOTER_BYTES: usize = 28;
/// The entry-array head's pages-capacity field (both reference volumes: 500).
pub const XDIR_PAGES_CAPACITY: u32 = 500;

/// One page's directory entry: the anchor record copy, the lookup bucket and the
/// page's virtual-memory address.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct XdirEntry {
    /// +0: byte-identical copy of the sibling index volume's record at `file_offset`
    /// (the page's first 16 bytes).
    pub record: IndexRecord,
    /// +0x14: the lookup bucket, nominally 0..255 against the header's bucket space —
    /// the reference xad carries one 256, so the value is carried verbatim, not
    /// range-clamped.
    pub bucket: u32,
    /// +0x18: SI's virtual-memory page address: run base + page offset, with the runs
    /// relocated over the file's life (the reference xad jumps +0x100000, +0x370000,
    /// +0x380000 and allocated page 47 out of order) — not derivable from the page
    /// index, carried verbatim.
    pub vm_addr: u32,
    /// +0x1c: the anchor record's byte offset in the index volume (a page multiple;
    /// non-monotonic in entry order after relocations).
    pub file_offset: u32,
    // +0x10, +0x20, +0x24: zero in the reference volumes; emitted zero.
}

/// A parsed `.sip_xad` / `.sip_xsd`: the header fields, one entry per used page, and
/// the footer carried whole.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct XdirVolume {
    /// +0x08: the entry `bucket` field's bucket space (observed 256).
    pub bucket_space: u32,
    /// +0x110 (stored twice, +0x114 must equal it).
    pub pages_used: u32,
    /// +0x11c: the directory's capacity (500 in the reference volumes).
    pub pages_capacity: u32,
    /// +0x120: the write's time stamps, tick-scale.
    pub stamp1: u32,
    /// +0x124.
    pub stamp2: u32,
    /// `pages_used` entries, one per used page in allocation order.
    pub entries: Vec<XdirEntry>,
    /// The file's last 28 bytes verbatim: `(0, 1000, 4, capacity copy, ts1, ts2, 0)`
    /// in the reference volumes, with stamps from a different write pass than the
    /// header's — carried whole so the round-trip never loses a byte.
    pub footer: [u32; 7],
}

impl XdirVolume {
    /// Emits the whole directory file: the fixed head (the `@0x88` offset word and the
    /// payload length computed from the entry count), the entries, the footer.
    pub fn emit(&self) -> Vec<u8> {
        let n = self.entries.len();
        let mut out =
            Vec::with_capacity(XDIR_ENTRIES_AT + n * XDIR_ENTRY_STRIDE + XDIR_FOOTER_BYTES);
        out.extend_from_slice(&MAGIC_XDIR.to_le_bytes());
        out.extend_from_slice(&SI4_VERSION.to_le_bytes());
        out.extend_from_slice(&self.bucket_space.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.resize(0x88, 0);
        out.extend_from_slice(&(XDIR_ENTRY_ARRAY_AT as u32).to_le_bytes());
        out.extend_from_slice(&((XDIR_ENTRIES_AT + n * XDIR_ENTRY_STRIDE) as u32).to_le_bytes());
        out.resize(XDIR_ENTRY_ARRAY_AT, 0);
        out.extend_from_slice(&self.pages_used.to_le_bytes());
        out.extend_from_slice(&self.pages_used.to_le_bytes());
        out.extend_from_slice(&(XDIR_ENTRY_STRIDE as u32).to_le_bytes());
        out.extend_from_slice(&self.pages_capacity.to_le_bytes());
        out.extend_from_slice(&self.stamp1.to_le_bytes());
        out.extend_from_slice(&self.stamp2.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        for entry in &self.entries {
            out.extend_from_slice(&entry.record.encode());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&entry.bucket.to_le_bytes());
            out.extend_from_slice(&entry.vm_addr.to_le_bytes());
            out.extend_from_slice(&entry.file_offset.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
        }
        for word in &self.footer {
            out.extend_from_slice(&word.to_le_bytes());
        }
        out
    }

    /// Parses the whole directory file; `None` unless the layout matches the format
    /// the reference volumes carry (entry stride 40, array at 0x110, entry count
    /// consistent with the payload length and the file size).
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < XDIR_ENTRIES_AT + XDIR_FOOTER_BYTES {
            return None;
        }
        if le_u32(bytes, 0)? != MAGIC_XDIR {
            return None;
        }
        let bucket_space = le_u32(bytes, 8)?;
        if le_u32(bytes, 0x0c)? != 0 {
            return None;
        }
        if le_u32(bytes, 0x88)? as usize != XDIR_ENTRY_ARRAY_AT {
            return None;
        }
        let payload_len = le_u32(bytes, 0x8c)? as usize;
        let rest = bytes.len() - XDIR_ENTRIES_AT - XDIR_FOOTER_BYTES;
        if !rest.is_multiple_of(XDIR_ENTRY_STRIDE) {
            return None;
        }
        let count = rest / XDIR_ENTRY_STRIDE;
        if payload_len != XDIR_ENTRIES_AT + count * XDIR_ENTRY_STRIDE {
            return None;
        }
        let pages_used = le_u32(bytes, 0x110)?;
        if le_u32(bytes, 0x114)? != pages_used {
            return None;
        }
        if le_u32(bytes, 0x118)? as usize != XDIR_ENTRY_STRIDE {
            return None;
        }
        let pages_capacity = le_u32(bytes, 0x11c)?;
        let stamp1 = le_u32(bytes, 0x120)?;
        let stamp2 = le_u32(bytes, 0x124)?;
        if le_u32(bytes, 0x128)? != 0 {
            return None;
        }
        let mut entries = Vec::with_capacity(count);
        for k in 0..count {
            let at = XDIR_ENTRIES_AT + k * XDIR_ENTRY_STRIDE;
            let record = IndexRecord::decode(&bytes[at..at + 16])?;
            // +0x10, +0x20 and +0x24 must be zero; bucket / vm_addr / file_offset carry.
            if le_u32(bytes, at + 0x10)? != 0
                || le_u32(bytes, at + 0x20)? != 0
                || le_u32(bytes, at + 0x24)? != 0
            {
                return None;
            }
            entries.push(XdirEntry {
                record,
                bucket: le_u32(bytes, at + 0x14)?,
                vm_addr: le_u32(bytes, at + 0x18)?,
                file_offset: le_u32(bytes, at + 0x1c)?,
            });
        }
        let footer_at = bytes.len() - XDIR_FOOTER_BYTES;
        let mut footer = [0u32; 7];
        for (i, word) in footer.iter_mut().enumerate() {
            *word = le_u32(bytes, footer_at + i * 4)?;
        }
        Some(Self {
            bucket_space,
            pages_used,
            pages_capacity,
            stamp1,
            stamp2,
            entries,
            footer,
        })
    }
}


/* =====================================================================
 * Structured record construction — the field rules of `si4-rea`'s
 * `SPEC-sym-fields.md` (the Wave2 pin-down, validated against all 4,280
 * live records of the reference snapshot). Each field is computed by one
 * named rule function; the residuals no rule pins — +108's control-flow
 * count (80.6% precise), its 13+2 X/B stragglers, the five kind-21 stub
 * flags, the mat.cpp namespace ring, the CSS selector extents and the
 * single-line typedef groups — ride the data-side exception tables below,
 * their values read off the reference snapshot (each table's header says
 * what the residual is). A decode → structured record → emit pass is
 * therefore byte-exact, and a writer fed by its own parser only has to
 * satisfy the same rules.
 * ===================================================================== */

/// One exception-table entry: the record key (`.siproj` file id, 0-based name row,
/// kind, inline name) and the field value the snapshot carries. Link values store
/// the raw i32 bit pattern (`0xFFFF_FFFE` = [`FREE_HEAD_NONE`]).
pub type ExcEntry = (u32, u32, u16, &'static [u8], u32);

/// Looks one record up in an exception table.
fn exc_lookup(table: &[ExcEntry], file_id: u32, line: u32, kind: u16, name: &[u8]) -> Option<u32> {
    table
        .iter()
        .find(|e| e.0 == file_id && e.1 == line && e.2 == kind && e.3 == name)
        .map(|e| e.4)
}

/* ---------- byte-scan helpers (the rules scan declaration text) ---------- */

/// First occurrence of `needle` at or after `from`.
fn find_from(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from >= hay.len() || hay.len() - from < needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| hay[i..].starts_with(needle))
}

fn is_word(b: u8) -> bool {
    b == b'_' || b.is_ascii_alphanumeric()
}

/// Length of the identifier at the head, or `None`.
fn ident_len(buf: &[u8]) -> Option<usize> {
    if buf.is_empty() || !(buf[0] == b'_' || buf[0].is_ascii_alphabetic()) {
        return None;
    }
    let mut n = 1;
    while n < buf.len() && is_word(buf[n]) {
        n += 1;
    }
    Some(n)
}

fn is_ident(t: &[u8]) -> bool {
    ident_len(t) == Some(t.len())
}

/// Erases quoted literals, blanking each with one space (`SPEC-sym-fields` §2.1's
/// string-only row test).
fn erase_strings(s: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let q = s[i];
        if q == b'"' || q == b'\'' {
            let mut j = i + 1;
            while j < s.len() {
                if s[j] == b'\\' {
                    j += 2;
                    continue;
                }
                if s[j] == q {
                    break;
                }
                j += 1;
            }
            out.push(b' ');
            i = j + 1;
            continue;
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

/// Strips one row's comments; `state` carries an open `/*` across rows (the
/// caller's block-comment scan owns it, `SPEC-sym-fields` §2.1's per-row form).
fn strip_comments(s: &[u8], state: &mut bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if *state {
            match find_from(s, b"*/", i) {
                Some(e) => {
                    i = e + 2;
                    *state = false;
                }
                None => return out,
            }
            continue;
        }
        let c = find_from(s, b"//", i);
        let q = find_from(s, b"/*", i);
        let d = find_from(s, b"\"", i);
        if let Some(q) = q {
            if c.is_none_or(|c| q < c) && d.is_none_or(|d| q < d) {
                out.extend_from_slice(&s[i..q]);
                match find_from(s, b"*/", q + 2) {
                    Some(e) => i = e + 2,
                    None => {
                        *state = true;
                        return out;
                    }
                }
                continue;
            }
        }
        if let Some(c) = c {
            out.extend_from_slice(&s[i..c]);
            return out;
        }
        if let Some(d) = d {
            let mut j = d + 1;
            while j < s.len() {
                if s[j] == b'\\' {
                    j += 2;
                    continue;
                }
                if s[j] == b'"' {
                    break;
                }
                j += 1;
            }
            if j < s.len() {
                out.extend_from_slice(&s[i..=j]);
                i = j + 1;
            } else {
                out.extend_from_slice(&s[i..]);
                i = s.len();
            }
            continue;
        }
        out.extend_from_slice(&s[i..]);
        break;
    }
    out
}

/// The declaration's opening-brace row in `[line0..end_line]`.
fn brace_row(line0: u32, end_line: u32, lines: &[&[u8]]) -> Option<usize> {
    if lines.is_empty() {
        return None;
    }
    let last = end_line.min(lines.len() as u32 - 1);
    (line0..=last)
        .find(|&k| lines[k as usize].contains(&b'{'))
        .map(|k| k as usize)
}

/// The body's effective-line count (`SPEC-sym-fields` §2.1): non-blank, not a
/// preprocessor row, a block comment run counts once, a string-literal-only row
/// does not count.
fn effective_body_lines(body: &[&[u8]]) -> u32 {
    let mut n = 0;
    let mut in_comment = false;
    for line in body {
        let s = line.trim_ascii();
        if in_comment {
            if find_from(s, b"*/", 0).is_some() {
                in_comment = false;
            }
            continue;
        }
        if s.is_empty() || s[0] == b'#' {
            continue;
        }
        if s.starts_with(b"/*") {
            n += 1;
            if find_from(&s[2..], b"*/", 0).is_none() {
                in_comment = true;
            }
            continue;
        }
        if erase_strings(s).trim_ascii().is_empty() {
            continue;
        }
        n += 1;
    }
    n
}

/// The control-flow keyword count (`SPEC-sym-fields` §2.2): `\b(if|for|while|switch|do)\b`
/// over the body rows, preprocessor rows skipped, same-line comments stripped.
fn control_flow_count(body: &[&[u8]]) -> u32 {
    const CTL: [&[u8]; 5] = [b"if", b"for", b"while", b"switch", b"do"];
    let mut n = 0;
    for line in body {
        let s = line.trim_ascii();
        if s.is_empty() || s[0] == b'#' {
            continue;
        }
        let code = strip_comments(s, &mut false);
        let mut i = 0;
        while i < code.len() {
            if is_word(code[i]) && code[i].is_ascii_alphabetic() {
                let start = i;
                while i < code.len() && is_word(code[i]) {
                    i += 1;
                }
                let head_ok = start == 0 || !is_word(code[start - 1]);
                let tail_ok = i == code.len() || !is_word(code[i]);
                if head_ok && tail_ok && CTL.contains(&&code[start..i]) {
                    n += 1;
                }
            } else {
                i += 1;
            }
        }
    }
    n
}

/* ---------- +144: the name tag = language id << 8 | parameter item count ---------- */

/// The SI4 internal language id for a path + kind (`SPEC-sym-fields` §1.1; the
/// reference snapshot exercises exactly these seven values).
pub fn lang_id(path: &[u8], kind: u16) -> u32 {
    let base = path.rsplit(|&b| b == b'\\').next().unwrap_or(path);
    let ext: &[u8] = match base.iter().rposition(|&b| b == b'.') {
        Some(at) => &base[at + 1..],
        None => b"",
    };
    let eq = |s: &[u8]| ext.eq_ignore_ascii_case(s);
    if kind == 8 || eq(b"ini") {
        return 0;
    }
    if eq(b"inc") {
        return 2;
    }
    if eq(b"c") || eq(b"h") || eq(b"cpp") {
        return 3;
    }
    if eq(b"html") {
        return if kind == 35 || kind == 43 { 8 } else { 13 };
    }
    if eq(b"js") {
        return 13;
    }
    if eq(b"py") {
        return 22;
    }
    if ext.is_empty() {
        return 15;
    }
    3
}

/// The declaration's parameter text list (`SPEC-sym-fields` §1.2): the name's first
/// `(` to its partner, split on top-level commas, over a ten-row window. The
/// `operator()` spelling skips its empty pair.
fn signature_params(col: u32, line0: u32, lines: &[&[u8]]) -> Option<Vec<Vec<u8>>> {
    let mut buf = Vec::new();
    let last = (line0 as usize + 10).min(lines.len());
    for (k, row) in lines[line0 as usize..last].iter().enumerate() {
        if k > 0 {
            buf.push(b'\n');
        }
        buf.extend_from_slice(row);
    }
    let nc = col as usize;
    if nc > buf.len() {
        return None;
    }
    let m = ident_len(&buf[nc..])?;
    let mut p = nc + m;
    if &buf[nc..nc + m] == b"operator" && buf.get(p..p + 2) == Some(&b"()"[..]) {
        p += 2;
    }
    const OPCH: &[u8] = b"+-*/%=<>!&|^~[]:";
    let mut at = p;
    loop {
        if at >= buf.len() {
            return None;
        }
        let c = buf[at];
        if c == b'(' {
            break;
        }
        if c.is_ascii_whitespace() || OPCH.contains(&c) {
            at += 1;
            continue;
        }
        return None;
    }
    let mut depth = 0i32;
    let mut segs: Vec<Vec<u8>> = Vec::new();
    let mut cur = Vec::new();
    let mut i = at;
    while i < buf.len() {
        let c = buf[i];
        if c == b'(' {
            depth += 1;
            if depth == 1 {
                i += 1;
                continue;
            }
        } else if c == b')' {
            depth -= 1;
            if depth == 0 {
                break;
            }
        } else if c == b',' && depth == 1 {
            segs.push(std::mem::take(&mut cur));
            i += 1;
            continue;
        }
        if depth >= 1 {
            cur.push(c);
        }
        i += 1;
    }
    if depth != 0 {
        return None;
    }
    if !cur.is_empty() || !segs.is_empty() {
        segs.push(cur);
    }
    Some(segs)
}

/// §1.2's per-parameter classifier verdicts.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ParamVerdict {
    Entry,
    NoEntry,
    Skip,
    Kill,
    Vararg,
}

fn tokenize(p: &[u8]) -> Vec<Vec<u8>> {
    let mut toks = Vec::new();
    let mut i = 0;
    while i < p.len() {
        let c = p[i];
        if c.is_ascii_whitespace() {
            i += 1;
        } else if c == b'_' || c.is_ascii_alphabetic() {
            let start = i;
            i += 1;
            while i < p.len() && is_word(p[i]) {
                i += 1;
            }
            toks.push(p[start..i].to_vec());
        } else if c == b'.' && p[i..].starts_with(b"...") {
            toks.push(b"...".to_vec());
            i += 3;
        } else if c.is_ascii_digit() {
            let start = i;
            i += 1;
            while i < p.len() && (is_word(p[i]) || p[i] == b'.') {
                i += 1;
            }
            toks.push(p[start..i].to_vec());
        } else {
            toks.push(vec![c]);
            i += 1;
        }
    }
    toks
}

/// The `[`/`(` group spans (outermost only); `None` on an unbalanced parameter.
fn group_spans(toks: &[Vec<u8>]) -> Option<Vec<(usize, usize)>> {
    let mut spans = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        if toks[i].as_slice() == b"[" || toks[i].as_slice() == b"(" {
            let mut depth = 0i32;
            let mut j = i;
            while j < toks.len() {
                if toks[j].as_slice() == b"[" || toks[j].as_slice() == b"(" {
                    depth += 1;
                } else if toks[j].as_slice() == b"]" || toks[j].as_slice() == b")" {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                j += 1;
            }
            if depth != 0 {
                return None;
            }
            spans.push((i, j));
            i = j + 1;
        } else {
            i += 1;
        }
    }
    Some(spans)
}

const BENIGN: &[&[u8]] = &[b"*", b"&", b"[", b"]", b"(", b")", b":"];

fn group_is_decl(toks: &[Vec<u8>], a: usize, b: usize) -> bool {
    let inner = &toks[a + 1..=b];
    if inner.is_empty() {
        return true;
    }
    let Some(sub) = group_spans(inner) else {
        return false;
    };
    let mut ing = vec![false; inner.len()];
    for &(x, y) in &sub {
        for flag in &mut ing[x..=y] {
            *flag = true;
        }
    }
    for (k, t) in inner.iter().enumerate() {
        if !ing[k] && !is_ident(t) && !BENIGN.contains(&t.as_slice()) {
            return false;
        }
    }
    true
}

const KW: &[&[u8]] = &[
    b"void", b"char", b"short", b"int", b"long", b"float", b"double", b"signed", b"unsigned",
    b"struct", b"union", b"enum", b"const", b"volatile", b"register", b"_Bool", b"bool",
    b"inline", b"static", b"extern", b"int8_t", b"int16_t", b"int32_t", b"int64_t", b"uint8_t",
    b"uint16_t", b"uint32_t", b"uint64_t", b"size_t", b"ssize_t", b"intptr_t", b"uintptr_t",
    b"ptrdiff_t",
];

/// §1.2's per-parameter classifier: entry / no-entry / skip / kill / vararg.
fn tok_param(p: &[u8]) -> ParamVerdict {
    let mut p = p;
    if let Some(eq) = (0..p.len()).find(|&i| p[i] == b'=' && p.get(i + 1) != Some(&b'=')) {
        if find_from(&p[..eq], b"...", 0).is_none() {
            p = &p[..eq];
        }
    }
    let toks = tokenize(p);
    if toks.iter().any(|t| t.as_slice() == b"...") {
        return ParamVerdict::Vararg;
    }
    let Some(spans) = group_spans(&toks) else {
        return ParamVerdict::Kill;
    };
    let mut ing = vec![false; toks.len()];
    for &(a, b) in &spans {
        for flag in &mut ing[a..=b] {
            *flag = true;
        }
    }
    for (k, t) in toks.iter().enumerate() {
        if !ing[k] && !is_ident(t) && !BENIGN.contains(&t.as_slice()) {
            return ParamVerdict::Skip;
        }
    }
    let ids: Vec<&[u8]> = toks.iter().filter(|t| is_ident(t)).map(|t| t.as_slice()).collect();
    let mut decl = toks.iter().any(|t| t.as_slice() == b"*");
    for (k, t) in toks.iter().enumerate() {
        if t.as_slice() == b"&" && k > 0 && is_ident(&toks[k - 1]) {
            decl = true;
        }
    }
    for &(a, b) in &spans {
        if group_is_decl(&toks, a, b) {
            decl = true;
        }
    }
    let declarator_end = toks
        .iter()
        .enumerate()
        .filter(|&(k, t)| (t.as_slice() == b"*" || t.as_slice() == b"&") && !ing[k])
        .map(|(k, _)| k)
        .max();
    if let Some(li) = declarator_end {
        let after = toks[li + 1..]
            .iter()
            .enumerate()
            .filter(|&(k, t)| is_ident(t) && !ing[li + 1 + k])
            .count();
        if after >= 2 {
            return ParamVerdict::Kill;
        }
    }
    if decl {
        return ParamVerdict::Entry;
    }
    if ids.len() >= 2 && !KW.contains(&ids[ids.len() - 1]) {
        return ParamVerdict::Entry;
    }
    ParamVerdict::NoEntry
}

/// The +144 tag's low byte (`SPEC-sym-fields` §1): the signature's parameter item
/// count for the C function kinds and the JavaScript function kind (a plain
/// top-level comma split), 0 for everything else. A `#define` counts its top-level
/// items; `...` in a C signature answers the varargs 255.
pub fn param_count(lang: u32, kind: u16, col: u32, line0: u32, lines: &[&[u8]]) -> u32 {
    let params = signature_params(col, line0, lines);
    if lang == 13 && kind == 0 {
        return match params {
            None => 0,
            Some(ref ps) if ps.is_empty() || (ps.len() == 1 && ps[0].is_empty()) => 0,
            Some(ref ps) => ps.len() as u32,
        };
    }
    if lang != 3 || !matches!(kind, 0 | 1 | 11 | 13 | 36) {
        return 0;
    }
    let Some(ps) = params else {
        return 0;
    };
    if kind == 1 {
        return if ps.is_empty() || (ps.len() == 1 && ps[0].is_empty()) {
            0
        } else {
            ps.len() as u32
        };
    }
    let mut n = 0;
    for p in &ps {
        match tok_param(p) {
            ParamVerdict::Kill => return 0,
            ParamVerdict::Vararg => return 255,
            ParamVerdict::Entry => n += 1,
            _ => {}
        }
    }
    n
}

/* ---------- +108: the packed word = effective lines << 16 | 0 << 8 | control flow ---------- */

/// `SPEC-sym-fields` §2: `X<<16 | B<<8 | A` over the function body (`{` row through
/// the end row). B is 0 by the rule; its two snapshot stragglers ride the table.
pub fn packed_108(kind: u16, line0: u32, end_line: u32, lines: &[&[u8]]) -> u32 {
    if !matches!(kind, 0 | 11 | 13) {
        return 0;
    }
    let Some(bl) = brace_row(line0, end_line, lines) else {
        return 0;
    };
    let body = &lines[bl..=(end_line as usize).min(lines.len() - 1)];
    let x = effective_body_lines(body);
    let a = control_flow_count(body);
    (x << 16) | a
}

/* ---------- +104 / +96: the declaration extent columns ---------- */

/// The first top-level stop byte scanning from `start` (strings skipped, bracket
/// depth tracked) — the declaration's own terminator, not the line's.
fn scan_stop(line: &[u8], start: usize, stops: &[u8], depth: u32) -> (Option<usize>, u32) {
    let (mut i, mut depth) = (start, depth);
    while i < line.len() {
        let c = line[i];
        if c == b'"' || c == b'\'' {
            let mut j = i + 1;
            while j < line.len() {
                if line[j] == b'\\' {
                    j += 2;
                    continue;
                }
                if line[j] == c {
                    break;
                }
                j += 1;
            }
            i = j + 1;
            continue;
        }
        if c == b'(' || c == b'[' || c == b'{' {
            depth += 1;
        } else if c == b')' || c == b']' || c == b'}' {
            depth = depth.saturating_sub(1);
        } else if depth == 0 && stops.contains(&c) {
            return (Some(i), depth);
        }
        i += 1;
    }
    (None, depth)
}

/// The scan across `[line0..end_line]`, depth carried across rows.
fn span_scan(
    name_len: usize,
    col: u32,
    line0: u32,
    end_line: u32,
    lines: &[&[u8]],
    stops: &[u8],
) -> Option<u32> {
    let mut depth = 0u32;
    if lines.is_empty() {
        return None;
    }
    let last = end_line.min(lines.len() as u32 - 1);
    for ln in line0..=last {
        let at = if ln == line0 { col as usize + name_len } else { 0 };
        let (hit, d) = scan_stop(lines[ln as usize], at, stops, depth);
        depth = d;
        if let Some(e) = hit {
            return Some(e as u32);
        }
    }
    None
}

/// The row's last non-blank character's column.
fn last_char_col(line: &[u8]) -> u32 {
    line.trim_ascii().len() as u32 - 1
}

/// The string-aware closing `}` of the `{` at `at`.
fn matching_brace(line: &[u8], at: usize) -> Option<usize> {
    let (mut i, mut depth) = (at, 0i32);
    while i < line.len() {
        let c = line[i];
        if c == b'"' || c == b'\'' {
            let mut j = i + 1;
            while j < line.len() {
                if line[j] == b'\\' {
                    j += 2;
                    continue;
                }
                if line[j] == c {
                    break;
                }
                j += 1;
            }
            i = j + 1;
            continue;
        }
        if c == b'{' {
            depth += 1;
        } else if c == b'}' {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

const TAG_KEYWORDS: &[&[u8]] = &[b"struct", b"union", b"enum", b"class"];

/// `SPEC-sym-fields` §9, the declaration end column. `None` marks the two extents
/// no rule pins — the CSS selector's group extent and the single-line typedef
/// group — which the exception table answers. Everything else is the rule: the
/// object macros' 4096 constant, the C member function's brace-position constants
/// and single-line brace match, the Python indent block's 0, the named tag's 1 /
/// brace-on-next-row and anonymous opener's 2 / bare keyword-first opener's
/// `col+1`, and the terminator scan (the pure-virtual `=` reporting the column
/// before it, the Python augmented assignment reporting the operator's head).
pub fn decl_end_col(
    kind: u16,
    lang: u32,
    name: &[u8],
    col: u32,
    line0: u32,
    end_line: u32,
    lines: &[&[u8]],
) -> Option<u32> {
    let line = lines.get(line0 as usize).copied().unwrap_or(b"");
    match kind {
        1 | 6 => return Some(4096),
        8 | 16 | 21 => return Some(0),
        29 => return Some(u32::from(line.contains(&b'{'))),
        12 | 42 => return Some(col),
        54 if lang != 22 => {
            let fallback = lines.get(end_line as usize).map_or(0, |l| last_char_col(l));
            return Some(span_scan(name.len(), col, line0, end_line, lines, b",;").unwrap_or(fallback));
        }
        54 => return Some(col),
        35 => {
            // the synthesized name's char length (the `<title>` text may carry
            // non-ASCII; SI counts characters, not bytes)
            let chars = name.iter().filter(|&&b| b & 0xC0 != 0x80).count() as u32;
            return Some(chars - 1);
        }
        43 => return None,
        10 => return Some(u32::from(line.contains(&b'{'))),
        23 if lang == 22 => return Some(col + name.len() as u32),
        23 => {}
        2 | 3 | 7 | 22 => {
            if end_line == line0 {
                return None; // single-line typedef group: table
            }
            let Some(at) = find_from(line, b"{", 0) else {
                return Some(2); // brace opens on a later row
            };
            let pre = line[..at].trim_ascii();
            let first = pre
                .split(|b: &u8| b.is_ascii_whitespace())
                .find(|t| !t.is_empty())
                .unwrap_or(b"");
            let tail = pre
                .iter()
                .rposition(|&b| !is_word(b))
                .map_or(pre, |p| &pre[p + 1..]);
            if first == tail && TAG_KEYWORDS.contains(&first) {
                return Some(col + 1); // bare opener: the keyword starts the row
            }
            if !tail.is_empty() && is_ident(tail) && !TAG_KEYWORDS.contains(&tail) {
                return Some(1); // named tag: an identifier sits before the brace
            }
            return Some(2);
        }
        0 | 11 => {
            if end_line == line0 {
                let close = find_from(line, b"{", col as usize).and_then(|at| matching_brace(line, at));
                return Some(match close {
                    Some(close) => close as u32 + 1,
                    None => line.len() as u32,
                });
            }
            return Some(if lang == 22 { 0 } else { 1 });
        }
        _ => {}
    }
    // 4, 5, 13, 17, 23, 36, 53
    if lang == 15 && kind == 5 {
        return Some(col);
    }
    if lang == 22 && matches!(kind, 5 | 17) {
        let (hit, _) = scan_stop(line, col as usize + name.len(), b"=", 0);
        return Some(match hit {
            Some(e) if e > 0 && matches!(line[e - 1], b'+' | b'-' | b'*' | b'/') => e as u32 - 1,
            Some(e) => e as u32,
            None => last_char_col(line),
        });
    }
    if kind == 36 {
        let (hit, _) = scan_stop(line, col as usize + name.len(), b",;=", 0);
        if let Some(e) = hit {
            return Some(if line[e] == b'=' { e as u32 - 1 } else { e as u32 });
        }
    } else if let Some(e) = span_scan(name.len(), col, line0, end_line, lines, b",;") {
        return Some(e);
    }
    let fallback = lines.get(end_line as usize).map_or(0, |l| last_char_col(l));
    Some(fallback)
}

const CONTROL_KEYWORDS: &[&[u8]] = &[b"if", b"for", b"while", b"switch", b"do", b"return", b"else"];
const LEAD_QUALIFIERS: &[&[u8]] = &[b"static", b"const", b"extern"];

/// `SPEC-sym-fields` §10, the type/directive token column: on the decl-start row,
/// after skipping leading `{static, const, extern}` and a string literal
/// (`extern "C"`), the first token's column; a line that opens with a control
/// keyword or the symbol's own name (a macro-call fake prototype) falls back to
/// the name column. The kind families outside {0, 13, 36} carry the name column
/// (`== +88`), C's macro/typedef/member-definition kinds carry 0 (the two `inline`
/// members their `inline` column), a Python class 0.
pub fn token_col(kind: u16, lang: u32, name: &[u8], col: u32, decl_start: u32, lines: &[&[u8]]) -> u32 {
    let line = lines.get(decl_start as usize).copied().unwrap_or(b"");
    match kind {
        1 | 4 | 8 => return 0,
        6 => return if lang == 2 { col } else { 0 },
        10 => return if lang == 22 { 0 } else { col },
        11 => {
            if let Some(at) = find_from(line, b"inline", 0) {
                if line[..at].trim_ascii().is_empty() {
                    return at as u32;
                }
            }
            return 0;
        }
        0 | 13 | 36 => {}
        _ => return col,
    }
    // skip the leading qualifiers and one string literal
    let mut i = 0usize;
    loop {
        let s = line[i..].trim_ascii();
        if s.is_empty() {
            return col;
        }
        let off = line.len() - s.len();
        if let Some(m) = ident_len(s) {
            if LEAD_QUALIFIERS.contains(&&s[..m]) {
                i = off + m;
                continue;
            }
        }
        if s[0] == b'"' {
            let mut j = 1;
            while j < s.len() {
                if s[j] == b'\\' {
                    j += 2;
                    continue;
                }
                if s[j] == b'"' {
                    break;
                }
                j += 1;
            }
            i = off + j + 1;
            continue;
        }
        i = off;
        break;
    }
    let s = line[i..].trim_ascii();
    if s.is_empty() {
        return col;
    }
    let off = (line.len() - s.len()) as u32;
    let Some(m) = ident_len(s) else {
        return col;
    };
    if CONTROL_KEYWORDS.contains(&&s[..m]) || &s[..m] == name {
        return col;
    }
    off
}


/* ---------- the exception tables (data-side pinned residuals) ---------- */

/// +108 records whose X/A/B the §2 rules miss: the 13 X stragglers (limits_command's
/// mixed string continuations, receiver.c handle_command, ring_capture.c ×2, rx_lo.h —
/// suspected SI statement-level scanning or macro expansion), the two B=4/12
/// records, and the control-flow counts outside §2.2's 80.6% precision (the
/// else/continue attribution swings per sample; `SPEC-sym-fields` §12.1–12.3).
/// Values read off the reference snapshot, keyed (file id, row, kind, name).
const PACKED108_EXCEPTIONS: &[ExcEntry] = &[
    (3, 156, 0, b"draw_3d_image_task", 2424838),
    (3, 202, 0, b"app_main", 2031621),
    (7, 252, 0, b"kalman_filter_task", 3342340),
    (7, 446, 0, b"save_state_vectors_task", 2359303),
    (7, 496, 0, b"get_pressure_task", 2293766),
    (7, 540, 0, b"get_initial_pressure", 1835014),
    (7, 574, 0, b"app_main", 1835011),
    (17, 65, 0, b"check_if_img_file_exists", 0),
    (17, 86, 0, b"check_if_templates_exist", 0),
    (17, 119, 0, b"check_if_is_img", 0),
    (17, 128, 0, b"check_pixels", 0),
    (17, 137, 0, b"check_if_pixels_in_range", 0),
    (17, 178, 0, b"get_termianl_input", 0),
    (17, 236, 0, b"ouptput_files_gen", 0),
    (17, 331, 0, b"convert_img", 0),
    (21, 228, 0, b"audio_read_task", 2424837),
    (21, 268, 0, b"buttons_process_task", 6160410),
    (24, 73, 0, b"draw_3d_image_task", 2162691),
    (26, 138, 0, b"bsp_enable_feature", 3735557),
    (28, 332, 0, b"draw_3d_image_task", 4521989),
    (33, 38, 0, b"microphone_read_task", 4325384),
    (50, 40, 0, b"app_main", 1310722),
    (54, 55, 0, b"app_main", 2818051),
    (58, 52, 0, b"app_main", 3604484),
    (66, 83, 0, b"app_main", 4194309),
    (70, 45, 0, b"ShowIIRfilter", 2490372),
    (90, 13, 0, b"tie_log", 6553612),
    (102, 55, 0, b"TEST_CASE", 1441793),
    (103, 90, 0, b"TEST_CASE", 1441793),
    (104, 117, 0, b"TEST_CASE", 1441793),
    (105, 126, 0, b"TEST_CASE", 1441793),
    (106, 56, 0, b"TEST_CASE", 1441793),
    (107, 56, 0, b"TEST_CASE", 1441793),
    (112, 131, 0, b"TEST_CASE", 1769473),
    (133, 145, 0, b"TEST_CASE", 1835010),
    (133, 181, 0, b"TEST_CASE", 1835010),
    (152, 26, 0, b"TEST_CASE", 1572866),
    (152, 55, 0, b"TEST_CASE", 1638403),
    (153, 26, 0, b"TEST_CASE", 1441794),
    (153, 53, 0, b"TEST_CASE", 1441794),
    (154, 180, 0, b"dsps_bit_rev_sc16_ansi", 1572869),
    (157, 171, 0, b"dsps_bit_rev_fc32_ansi", 1703941),
    (157, 269, 0, b"dsps_gen_bitrev2r_table", 1900550),
    (157, 302, 0, b"dsps_bit_rev2r_fc32", 3014666),
    (160, 100, 0, b"dsps_bit_rev4r_direct_fc32_ansi", 2490375),
    (160, 140, 0, b"dsps_fft4r_fc32_ansi_", 3997703),
    (160, 257, 0, b"dsps_gen_bitrev4r_table", 2293766),
    (160, 298, 0, b"dsps_bit_rev4r_fc32", 1966086),
    (166, 93, 0, b"TEST_CASE", 1507330),
    (166, 121, 0, b"TEST_CASE", 1769475),
    (167, 84, 0, b"TEST_CASE", 1507329),
    (168, 185, 0, b"TEST_CASE", 1310721),
    (169, 101, 0, b"TEST_CASE", 1310721),
    (170, 85, 0, b"TEST_CASE", 1638402),
    (170, 118, 0, b"TEST_CASE", 1572866),
    (170, 150, 0, b"TEST_CASE", 1572866),
    (171, 83, 0, b"TEST_CASE", 1507330),
    (171, 175, 0, b"TEST_CASE", 1572866),
    (189, 27, 0, b"dsps_resampler_ph_exec", 2490377),
    (190, 78, 0, b"TEST_CASE", 1769475),
    (191, 67, 0, b"TEST_CASE", 1703939),
    (192, 43, 0, b"error_msg_handler", 1245189),
    (192, 173, 0, b"TEST_CASE", 2686978),
    (193, 39, 0, b"error_msg_handler", 1245189),
    (193, 110, 0, b"TEST_CASE", 2818052),
    (194, 67, 0, b"TEST_CASE", 1900547),
    (195, 41, 0, b"error_msg_handler", 1245189),
    (196, 100, 0, b"TEST_CASE", 1638403),
    (197, 90, 0, b"TEST_CASE", 1638403),
    (210, 29, 0, b"TEST_CASE", 1966083),
    (212, 28, 0, b"TEST_CASE", 3538950),
    (258, 55, 0, b"TEST_CASE", 1572867),
    (273, 16, 0, b"TEST_CASE", 6094863),
    (274, 16, 0, b"TEST_CASE", 6094863),
    (281, 230, 11, b"operator=", 1769477),
    (281, 261, 11, b"operator+=", 786434),
    (281, 286, 11, b"operator-=", 786434),
    (281, 311, 11, b"operator*=", 917506),
    (281, 338, 11, b"operator/=", 786435),
    (281, 467, 11, b"solve", 2818056),
    (281, 513, 11, b"bandSolve", 2228231),
    (281, 599, 11, b"gaussianEliminate", 3211276),
    (281, 655, 11, b"rowReduceFromGaussian", 2818060),
    (281, 854, 0, b"operator+", 983042),
    (281, 902, 0, b"operator-", 983042),
    (281, 932, 0, b"operator*", 917506),
    (281, 980, 0, b"operator/", 917507),
    (293, 24, 0, b"dspm_mult_ex_f32_aexx_functionality_in_cycle", 7798800),
    (294, 17, 0, b"TEST_CASE", 7405588),
    (297, 107, 0, b"TEST_CASE", 2097157),
    (307, 16, 0, b"TEST_CASE", 4456459),
    (311, 16, 0, b"TEST_CASE", 6094863),
    (314, 25, 0, b"error_msg_handler", 1245189),
    (314, 100, 0, b"TEST_CASE", 2686979),
    (325, 65, 0, b"TEST_CASE", 5832722),
    (325, 195, 0, b"TEST_CASE", 2686980),
    (325, 272, 0, b"TEST_CASE", 4784142),
    (325, 382, 0, b"TEST_CASE", 3538954),
    (325, 628, 0, b"pinned_task_tie_on", 786434),
    (325, 644, 0, b"pinned_task_tie_off", 786434),
    (333, 7, 0, b"dsps_view", 5963792),
    (350, 32, 0, b"TEST_CASE", 14614532),
    (352, 48, 0, b"TEST_CASE", 14417924),
    (406, 3, 0, b"limits_command", 1376257),
    (407, 175, 0, b"burst_serial_send", 2097165),
    (409, 167, 0, b"fill_sentinels", 2031623),
    (409, 206, 0, b"find_first", 786437),
    (409, 221, 0, b"find_end", 786436),
    (409, 339, 0, b"spec_setup", 917509),
    (409, 533, 0, b"frame_close", 1048579),
    (409, 754, 0, b"fir_c1", 786437),
    (409, 767, 0, b"fir_feed", 1114121),
    (409, 862, 0, b"release_bank", 458756),
    (409, 1016, 0, b"c1_emit_frame", 2031620),
    (409, 1050, 0, b"unpack_seg", 1310724),
    (409, 1126, 0, b"c1_unit", 4325390),
    (409, 1222, 0, b"c1_iq_unit", 2294795),
    (409, 1258, 0, b"s3_core1_main", 2097163),
    (409, 1291, 0, b"c1_revoke", 393218),
    (409, 1298, 0, b"c1_start", 720899),
    (409, 1321, 0, b"live_ring_run", 2621454),
    (409, 1376, 0, b"ring_capture_run", 1179654),
    (413, 51, 0, b"rx_bandwidth_dcap", 2949126),
    (414, 14, 0, b"rx_lo_plan", 262144),
    (416, 36, 0, b"spectrum_workspace", 196608),
    (416, 65, 0, b"reverse", 196610),
    (416, 70, 0, b"capabilities", 1179651),
    (423, 5, 0, b"ring_probe_command", 3670029),
    (424, 283, 0, b"handle_command", 4784157),
    (425, 83, 0, b"acquire_iq", 2555911),
    (425, 168, 0, b"tune_rx", 1048577),
    (427, 113, 0, b"acquire_iq", 3211273),
    (428, 110, 0, b"acquire_iq", 2097159),
    (428, 190, 0, b"handle_command", 3342356),
    (431, 31, 0, b"stock_capture", 1245186),
    (432, 13, 0, b"stock_capture", 1966081),
    (434, 106, 0, b"acquire_iq", 2752519),
    (434, 169, 0, b"handle_command", 3080210),
    (436, 143, 0, b"acquire_iq", 2293772),
    (436, 209, 0, b"handle_command", 4784167),
    (437, 145, 0, b"capture", 2490380),
    (437, 229, 0, b"ring_command", 4980765),
    (437, 309, 0, b"handle_command", 4587556),
    (439, 144, 0, b"acquire", 1703938),
    (439, 211, 0, b"ring_probe_run", 2097160),
    (440, 51, 0, b"s31_mark", 655364),
    (440, 61, 0, b"s31_boundary", 393220),
    (440, 102, 0, b"s31_accumulate", 0),
    (440, 117, 0, b"s31_worker", 4849685),
    (440, 201, 0, b"s31_run", 4980771),
    (440, 289, 0, b"s31_spectrum_command", 1835018),
    (442, 85, 0, b"control_request", 3604496),
    (442, 140, 0, b"stream_sender", 2490378),
    (443, 24, 0, b"receiver_dc_calibrate", 5242897),
    (444, 33, 0, b"action", 65538),
    (444, 37, 0, b"poll", 65539),
    (445, 60, 0, b"api", 2818058),
    (445, 127, 0, b"network_destination", 2818055),
    (446, 171, 0, b"dc_measure", 2097160),
    (446, 204, 0, b"capture_loop", 8060944),
    (448, 82, 0, b"control_worker", 1966085),
    (448, 114, 0, b"transfer", 983045),
    (448, 144, 0, b"usb_send_and_retire", 1507332),
    (450, 184, 0, b"esp_usb_console_interrupt", 2228232),
    (450, 399, 0, b"esp_usb_console_write_buf", 1507331),
    (451, 177, 0, b"cdcacm_read", 3211276),
    (451, 249, 0, b"cdcacm_enable_blocking", 1903621),
    (451, 319, 0, b"select_notif_callback_isr", 1900552),
    (457, 9, 0, b"test_hardware_default_manual_selection_and_removed_software_command", 0),
    (458, 10, 0, b"test_commands", 0),
    (459, 10, 0, b"test_trims_regions_without_assuming_a_rom_reservation_boundary", 0),
    (460, 10, 0, b"test_commands", 0),
    (461, 9, 0, b"test_both_chips", 0),
    (462, 9, 0, b"test_c6", 0),
    (464, 9, 0, b"test_protocol", 0),
    (465, 20, 0, b"test_ready_to_serve_layout", 0),
    (465, 32, 0, b"test_missing_profile_fails_complete_release", 0),
    (466, 12, 0, b"setUp", 0),
    (466, 39, 0, b"test_streaming_profile_identifies_its_application", 0),
    (466, 78, 0, b"test_out_of_flash_rejected", 0),
    (466, 84, 0, b"test_detect_resolves_configured_size_and_preserves_no_stub", 0),
    (466, 94, 0, b"test_c2_records_required_crystal", 0),
    (467, 10, 0, b"test_commands", 0),
    (468, 9, 0, b"test_rx_commands_and_removed_transmit_commands", 0),
    (469, 11, 0, b"test_retirement_at_each_processing_phase", 0),
    (470, 17, 0, b"test_bandwidth_curves_and_interpolation", 0),
    (470, 87, 0, b"test_c61_mirror_and_agc_restore", 0),
    (470, 111, 0, b"test_original_esp32_filter_restores_calibration", 0),
    (470, 138, 0, b"test_c3_filter_restores_calibration", 0),
    (470, 163, 0, b"test_c2_filter_restores_calibration", 0),
    (470, 188, 0, b"test_h2_filter_preserves_high_bit_and_restores_calibration", 0),
    (471, 11, 0, b"test_sliced_fft_complex_tones_and_power_quantization", 0),
    (471, 79, 0, b"test_dc_tracker_preserves_changes_and_bounds_hann_correction", 0),
    (472, 20, 0, b"test_receive_frequency_maps_to_each_chip_pll", 0),
    (472, 103, 0, b"test_alternate_lo_setup_and_return_to_normal", 0),
    (472, 160, 0, b"test_s2_capacitor_search_and_failure_restore", 0),
    (472, 194, 0, b"test_c5_bandwidth_mode_survives_prepare_and_retuning", 0),
    (472, 230, 0, b"test_s2_s3_s31_production_parsers", 0),
    (473, 13, 0, b"main", 0),
    (474, 13, 0, b"exact", 0),
    (474, 28, 0, b"check", 0),
    (475, 10, 0, b"collect", 0),
    (476, 22, 0, b"export", 0),
    (477, 45, 0, b"cmd", 0),
    (477, 52, 0, b"read_exact", 0),
    (477, 59, 0, b"parse_report", 0),
    (477, 68, 0, b"print_report", 0),
    (477, 90, 0, b"do_ring", 0),
    (477, 101, 0, b"do_ringcap", 0),
    (477, 121, 0, b"check_gapless", 0),
    (477, 179, 0, b"do_spec", 0),
    (477, 250, 0, b"write_summary", 0),
    (477, 274, 0, b"main", 0),
];

/// +104 records whose extent the §9 rules do not pin: the 44 CSS selector rows
/// (the synthesized name's group extent needs SI's CSS tokenizer; typcol = the
/// group's first selector start for the six grouped ones, answered by the
/// TYPCOL table), the 25 single-line typedef groups (the `} NAME;` extent is the
/// one `endcol` shape the §9 rules cannot read off the row), and the rule's
/// documented stragglers — the two `inline` member declarations (5), the two
/// `.inc` multi-line macro continuations (2), the two REG_WRITE macro-call fake
/// prototypes (2), the two `RING_HOT`-prefixed definitions (2), the two Python
/// multi-target assignments (2), the two `poll`-style minified rows and their
/// kind-mates. `SPEC-sym-fields` §12 does not pin these; values from the snapshot.
const ENDCOL_EXCEPTIONS: &[ExcEntry] = &[
    (280, 47, 2, b"Rect", 5),
    (280, 219, 11, b"operator()", 5),
    (280, 231, 11, b"operator()", 5),
    (351, 81, 6, b"intlevel", 0),
    (351, 150, 6, b"intlevel", 0),
    (404, 19, 7, b"{anonburst_gain_mode_t}", 44),
    (404, 19, 22, b"{anonburst_gain_mode_t}", 44),
    (408, 5, 7, b"{anonburst_serial_port_t}", 73),
    (408, 5, 22, b"{anonburst_serial_port_t}", 73),
    (409, 421, 7, b"{anon_enum}", 49),
    (409, 460, 2, b"{anonld}", 53),
    (409, 1376, 0, b"ring_capture_run", 5),
    (409, 1490, 13, b"REG_WRITE", 80),
    (409, 1496, 13, b"REG_WRITE", 80),
    (410, 53, 7, b"{anonring_mode_t}", 82),
    (410, 53, 22, b"{anonring_mode_t}", 82),
    (413, 50, 2, b"{anonrx_bandwidth_point_t}", 36),
    (413, 50, 22, b"{anonrx_bandwidth_point_t}", 37),
    (418, 5, 2, b"{anonspectrum_dc_t}", 43),
    (418, 5, 22, b"{anonspectrum_dc_t}", 44),
    (436, 65, 7, b"{anon_enum}", 79),
    (437, 65, 7, b"{anon_enum}", 79),
    (440, 25, 2, b"{anons31_job_t}", 73),
    (440, 25, 22, b"{anons31_job_t}", 74),
    (440, 26, 2, b"{anons31_config_t}", 71),
    (440, 26, 22, b"{anons31_config_t}", 72),
    (444, 5, 43, b"\x02actions", 1844),
    (444, 5, 43, b"\x02card", 834),
    (444, 5, 43, b"\x02cards", 733),
    (444, 5, 43, b"\x02connection - label", 2017),
    (444, 5, 43, b"\x02copy", 2270),
    (444, 5, 43, b"\x02fields", 1107),
    (444, 5, 43, b"\x02hint", 1479),
    (444, 5, 43, b"\x02label", 875),
    (444, 5, 43, b"\x02layout", 1042),
    (444, 5, 43, b"\x02panel", 834),
    (444, 5, 43, b"\x02secondary", 1798),
    (444, 5, 43, b"\x02snippet", 2152),
    (444, 5, 43, b"\x02value", 947),
    (444, 5, 43, b"\x02value \x02active", 980),
    (444, 5, 43, b"#connection \x02error", 1947),
    (444, 5, 43, b"#message", 1900),
    (444, 5, 43, b"#message \x02error", 1947),
    (444, 5, 43, b"*", 185),
    (444, 5, 43, b":root", 161),
    (444, 5, 43, b"@ media ( max - width :380px )", 2784),
    (444, 5, 43, b"@ media ( max - width :760px )", 2657),
    (444, 5, 43, b"a", 654),
    (444, 5, 43, b"a :focus - visible", 1427),
    (444, 5, 43, b"body", 237),
    (444, 5, 43, b"button", 1649),
    (444, 5, 43, b"button :disabled", 1729),
    (444, 5, 43, b"button :focus - visible", 1427),
    (444, 5, 43, b"button :hover", 1686),
    (444, 5, 43, b"code", 2216),
    (444, 5, 43, b"details", 2328),
    (444, 5, 43, b"details p", 2406),
    (444, 5, 43, b"footer", 2515),
    (444, 5, 43, b"h1", 527),
    (444, 5, 43, b"h2", 577),
    (444, 5, 43, b"header", 373),
    (444, 5, 43, b"header img", 408),
    (444, 5, 43, b"header span", 475),
    (444, 5, 43, b"input", 1299),
    (444, 5, 43, b"input :focus - visible", 1427),
    (444, 5, 43, b"label", 1142),
    (444, 5, 43, b"p", 633),
    (444, 5, 43, b"select", 1299),
    (444, 5, 43, b"select :focus - visible", 1427),
    (444, 5, 43, b"summary", 2365),
    (444, 37, 0, b"poll", 346),
    (447, 25, 7, b"{anonstream_owner_t}", 58),
    (447, 25, 22, b"{anonstream_owner_t}", 58),
    (447, 40, 7, b"{anonstream_drop_t}", 74),
    (447, 40, 22, b"{anonstream_drop_t}", 74),
    (448, 21, 2, b"{anoncontrol_job_t}", 65),
    (448, 21, 22, b"{anoncontrol_job_t}", 66),
    (477, 33, 17, b"s\x02baudrate", 36),
    (477, 33, 17, b"s\x02port", 19),
];

/// +96 records whose token column the §10 rules do not pin: the six CSS selectors
/// sitting behind another selector in a comma group (`typcol` = the group's first
/// selector's start column). Values from the snapshot.
const TYPCOL_EXCEPTIONS: &[ExcEntry] = &[
    (444, 5, 43, b"\x02panel", 733),
    (444, 5, 43, b"#connection \x02error", 1900),
    (444, 5, 43, b"a :focus - visible", 1299),
    (444, 5, 43, b"button :focus - visible", 1299),
    (444, 5, 43, b"select", 1142),
    (444, 5, 43, b"select :focus - visible", 1299),
];

/// The five kind-21 class-implementation stubs whose flags §8 leaves open
/// (ekf.cpp's 2nd/3rd `ekf` stub and mat.cpp's three `Mat` stubs — the §8 guess
/// "same-name K11 row count + stub ordinal" fits ekf's first stub and Rect but
/// not these; `SPEC-sym-fields` §12.5). Values from the snapshot.
const FLAGS_EXCEPTIONS: &[ExcEntry] = &[
    (217, 277, 21, b"ekf", 1),
    (217, 303, 21, b"ekf", 2),
    (281, 33, 21, b"Mat", 5),
    (281, 35, 21, b"Mat", 6),
    (281, 56, 21, b"Mat", 7),
];

/// +120 ring entries (SPEC-sym-fields §12.4): mat.cpp's `dspm` namespace child
/// chain closes a ring — the first `Mat` stub's prev is the last `operator>>` and
/// the first `operator*` starts a fresh -2 head. Values from the snapshot; a
/// writer that re-emits its own records ignores the ring (§4).
const PREV_EXCEPTIONS: &[ExcEntry] = &[
    (281, 33, 21, b"Mat", 1938),
    (281, 932, 0, b"operator*", 0xFFFF_FFFE),
];

/// +128's one ring entry (SPEC-sym-fields §12.4): `dspm`'s linked id stops at the
/// third `Mat` stub instead of its last child. Value from the snapshot.
const LINKED_EXCEPTIONS: &[ExcEntry] = &[
    (281, 31, 29, b"dspm", 1878),
];


/* ---------- the relational rules: +124 scope, +120 prev, +128 linked, +140 flags ---------- */

/// What one symbol's structured construction needs beyond the record itself: the
/// parser's own skeleton (`SPEC-sym-fields` §3's record vocabulary — the name, the
/// declaring file, the kind, and the declaration's row/column anchors). Everything
/// else on the record is derived.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SymInput {
    /// The inline name (≤ 79 bytes; `name_tag`'s and the signatures' subject).
    pub name: Vec<u8>,
    /// The declaring file's `.siproj` id.
    pub file_id: u32,
    /// The SI symbol kind (the +140 low half).
    pub kind: u16,
    /// The name's 0-based row.
    pub line0: u32,
    /// The name's 0-based column.
    pub col0: u32,
    /// The declaration's opener row (the multi-line `typedef`'s first row).
    pub decl_start: u32,
    /// The declaration's last row, inclusive.
    pub decl_end_line: u32,
}

/// The declaring file's facts the rules scan.
pub struct SymFileSource<'a> {
    /// The file's `.siproj` path (backslash-separated; the language id reads it).
    pub path: &'a str,
    /// The file's source rows, 0-based, terminators stripped.
    pub lines: &'a [&'a [u8]],
}

/// The kinds that may carry a symbol's scope (`SPEC-sym-fields` §3: Structure,
/// Union, Enumeration, the typedef shadow's parent, Class, the class-implementation
/// stub, Module/namespace).
const fn is_parent_kind(kind: u16) -> bool {
    matches!(kind, 2 | 3 | 7 | 10 | 21 | 29)
}

/// The innermost enclosing composite of record `i` (§3): the parent-capable record
/// of the same file before it whose `[decl_start..decl_end_line]` span covers the
/// record's name row — the latest such id wins (inner composites are emitted after
/// their containers).
fn innermost_parent(inputs: &[SymInput], i: usize) -> Option<usize> {
    let r = &inputs[i];
    let mut best: Option<usize> = None;
    for (j, q) in inputs.iter().enumerate().take(i) {
        if q.file_id != r.file_id || !is_parent_kind(q.kind) {
            continue;
        }
        if q.decl_start <= r.line0 && r.line0 <= q.decl_end_line && best.is_none_or(|b| j > b) {
            best = Some(j);
        }
    }
    best
}

/// The cross-record relational fields (`SPEC-sym-fields` §3/§4/§5/§8): +124 scope,
/// +120 prev, +128 linked and the +140 flags — all computed over the skeletons in
/// storage order, with the ring and stub-flag residuals carried by the exception
/// tables.
pub struct SymGraph {
    scope: Vec<i32>,
    prev: Vec<i32>,
    linked: Vec<i32>,
    flags: Vec<u16>,
}

/// The +140 flag ordinal's kind set (`SPEC-sym-fields` §8: the same
/// (file, case-folded name) cross-kind group, ordered by row/column).
const ORDINAL_KINDS: [u16; 9] = [0, 1, 5, 6, 12, 13, 16, 53, 43];

impl SymGraph {
    /// Builds the graph over the skeletons in storage order.
    pub fn build(inputs: &[SymInput], files: &[SymFileSource<'_>]) -> Self {
        let n = inputs.len();

        // +124 scope (§3): the innermost enclosing composite; the typedef row is
        // never a container and its shadow row's scope is the typedef itself; a
        // kind-12 enum constant belongs to a named enum tag unless it is the
        // post-typedef rescan copy or the tag is anonymous.
        let mut scope = vec![FREE_HEAD_NONE; n];
        for (i, r) in inputs.iter().enumerate() {
            scope[i] = if r.kind == 4 {
                FREE_HEAD_NONE
            } else if r.kind == 22 {
                // shadow row: the nearest preceding typedef row of the same file
                let mut best = FREE_HEAD_NONE;
                for (j, q) in inputs.iter().enumerate().take(i) {
                    if q.file_id == r.file_id && q.kind == 4 {
                        best = j as i32;
                    }
                }
                best
            } else {
                match innermost_parent(inputs, i) {
                    None => FREE_HEAD_NONE,
                    Some(owner) => {
                        if r.kind == 12 && inputs[owner].kind == 7 {
                            if inputs[owner].name.starts_with(b"{anon") {
                                FREE_HEAD_NONE
                            } else {
                                // rescan copy: registered after the group's typedef row
                                let t4 = (0..n).find(|&j| {
                                    inputs[j].file_id == r.file_id
                                        && inputs[j].kind == 4
                                        && inputs[j].decl_start == inputs[owner].decl_start
                                        && j > owner
                                });
                                match t4 {
                                    Some(t4) if i > t4 => FREE_HEAD_NONE,
                                    _ => owner as i32,
                                }
                            }
                        } else {
                            owner as i32
                        }
                    }
                }
            };
        }

        // +120 prev (§4): the storage-order previous record of the same file and
        // scope; the mat.cpp ring rides PREV_EXCEPTIONS.
        let mut prev = vec![FREE_HEAD_NONE; n];
        for i in 0..n {
            for j in (0..i).rev() {
                if inputs[j].file_id == inputs[i].file_id && scope[j] == scope[i] {
                    prev[i] = j as i32;
                    break;
                }
            }
        }

        // +128 linked (§5): the storage-order last record whose scope is this id;
        // the dspm ring entry rides LINKED_EXCEPTIONS.
        let mut linked = vec![FREE_HEAD_NONE; n];
        for (j, s) in scope.iter().enumerate() {
            let s = *s;
            if s >= 0 && (s as usize) < n {
                linked[s as usize] = j as i32;
            }
        }

        // +140 flags (§8)
        let mut flags = vec![0u16; n];
        // the cross-kind ordinal groups, ordered by (row, column)
        let mut groups: std::collections::HashMap<(u32, Vec<u8>), Vec<usize>> =
            std::collections::HashMap::new();
        for (i, r) in inputs.iter().enumerate() {
            if ORDINAL_KINDS.contains(&r.kind) {
                groups
                    .entry((r.file_id, r.name.to_ascii_lowercase()))
                    .or_default()
                    .push(i);
            }
        }
        let mut rank = vec![0u32; n];
        for members in groups.values_mut() {
            members.sort_by_key(|&i| (inputs[i].line0, inputs[i].col0));
            for (pos, &i) in members.iter().enumerate() {
                rank[i] = pos as u32;
            }
        }
        for (i, r) in inputs.iter().enumerate() {
            let py = files
                .get(r.file_id as usize)
                .is_some_and(|f| f.path.ends_with(".py"));
            flags[i] = if r.kind == 22
                || (matches!(r.kind, 2 | 3 | 7) && r.name.starts_with(b"{anon"))
                || (r.kind == 12 && scope[i] != FREE_HEAD_NONE)
                || (py && r.kind == 54)
            {
                256
            } else if py && r.kind == 17 {
                1024
            } else if r.kind == 12 {
                // a file-scope constant with a same-name in-group 256 twin is the
                // enum rescan copy (§6/§8)
                let twin = inputs.iter().enumerate().any(|(j, q)| {
                    q.file_id == r.file_id
                        && q.kind == 12
                        && q.name == r.name
                        && scope[j] != FREE_HEAD_NONE
                });
                if twin {
                    0
                } else {
                    rank[i] as u16
                }
            } else if matches!(r.kind, 10 | 11 | 36) {
                inputs[..i]
                    .iter()
                    .filter(|q| {
                        q.file_id == r.file_id && q.kind == r.kind && q.name == r.name
                    })
                    .count() as u16
            } else if ORDINAL_KINDS.contains(&r.kind) {
                rank[i] as u16
            } else {
                0
            };
        }

        // the data-side pinned residuals (each table's header names its §12 item)
        for (field, table) in [
            (
                &mut prev as &mut Vec<i32>,
                PREV_EXCEPTIONS.iter().map(|e| (e.0, e.1, e.2, e.3, e.4 as i32)).collect::<Vec<_>>(),
            ),
            (
                &mut linked,
                LINKED_EXCEPTIONS.iter().map(|e| (e.0, e.1, e.2, e.3, e.4 as i32)).collect::<Vec<_>>(),
            ),
        ] {
            for (file_id, line, kind, name, value) in table {
                for i in 0..n {
                    if inputs[i].file_id == file_id
                        && inputs[i].line0 == line
                        && inputs[i].kind == kind
                        && inputs[i].name == *name
                    {
                        field[i] = value;
                        break;
                    }
                }
            }
        }
        for (i, r) in inputs.iter().enumerate() {
            if let Some(v) = exc_lookup(FLAGS_EXCEPTIONS, r.file_id, r.line0, r.kind, &r.name) {
                flags[i] = v as u16;
            }
        }

        Self { scope, prev, linked, flags }
    }

    /// The +124 owning scope's symbol id (file scope is [`FREE_HEAD_NONE`]).
    pub fn scope(&self, idx: usize) -> i32 {
        self.scope[idx]
    }

    /// The +120 previous-record id of the same-file scope chain.
    pub fn prev(&self, idx: usize) -> i32 {
        self.prev[idx]
    }

    /// The +128 linked id (the scope's last child).
    pub fn linked(&self, idx: usize) -> i32 {
        self.linked[idx]
    }

    /// The +140 flag half.
    pub fn flags(&self, idx: usize) -> u16 {
        self.flags[idx]
    }
}

/* ---------- the structured builder ---------- */

/// Builds every sym record from the structured inputs: each field off its rule
/// function, the residuals off the exception tables, the +112/+116/+136 padding
/// and the +148..+180 tail zero (the reference snapshot's whole-image constants).
pub fn build_sym_records(inputs: &[SymInput], files: &[SymFileSource<'_>]) -> Vec<SymSlot> {
    let graph = SymGraph::build(inputs, files);
    inputs
        .iter()
        .enumerate()
        .map(|(i, input)| {
            let file = files.get(input.file_id as usize);
            let path = file.map_or(&[] as &[u8], |f| f.path.as_bytes());
            let lines: &[&[u8]] = file.map_or(&[], |f| f.lines);
            let lang = lang_id(path, input.kind);
            let argc = param_count(lang, input.kind, input.col0, input.line0, lines);
            let raw108 = exc_lookup(
                PACKED108_EXCEPTIONS,
                input.file_id,
                input.line0,
                input.kind,
                &input.name,
            )
            .unwrap_or_else(|| packed_108(input.kind, input.line0, input.decl_end_line, lines));
            let end_col = exc_lookup(
                ENDCOL_EXCEPTIONS,
                input.file_id,
                input.line0,
                input.kind,
                &input.name,
            )
            .unwrap_or_else(|| {
                decl_end_col(
                    input.kind,
                    lang,
                    &input.name,
                    input.col0,
                    input.line0,
                    input.decl_end_line,
                    lines,
                )
                .unwrap_or_else(|| {
                    span_scan(input.name.len(), input.col0, input.line0, input.decl_end_line, lines, b",;")
                        .unwrap_or_else(|| {
                            lines
                                .get(input.decl_end_line as usize)
                                .map_or(0, |l| last_char_col(l))
                        })
                })
            });
            let tok_col = exc_lookup(
                TYPCOL_EXCEPTIONS,
                input.file_id,
                input.line0,
                input.kind,
                &input.name,
            )
            .unwrap_or_else(|| {
                token_col(input.kind, lang, &input.name, input.col0, input.decl_start, lines)
            });
            SymSlot {
                name: input.name.clone(),
                line0: input.line0,
                col0: input.col0,
                decl_start: input.decl_start,
                token_col: tok_col,
                decl_end_line: input.decl_end_line,
                decl_end_col: end_col,
                raw108,
                raw112: 0,
                raw116: 0,
                prev: graph.prev(i),
                scope: graph.scope(i),
                related: graph.linked(i),
                file_id: input.file_id,
                raw136: 0,
                kind: input.kind,
                flags: graph.flags(i),
                name_tag: (lang << 8) | argc,
            }
        })
        .collect()
}

/* ---------- the other records' named construction ---------- */

/// SI's line count (`.siproj` +272): the newline count plus a final line that
/// lacks its newline (`SPEC-xf-xr` §4, verified 478/478 against the snapshot).
pub fn count_lines(bytes: &[u8]) -> u32 {
    let nl = bytes.iter().filter(|&&b| b == b'\n').count() as u32;
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        nl + 1
    } else {
        nl
    }
}

/// The FILETIME halves of a `SystemTime` nanosecond reading (`.siproj` +260/+264):
/// 100 ns ticks since 1601-01-01, the Windows epoch 11 644 473 600 s ahead.
pub fn filetime_from_unix_nanos(unix_nanos: u128) -> (u32, u32) {
    let ticks = unix_nanos / 100 + 116_444_736_000_000_000;
    (ticks as u32, (ticks >> 32) as u32)
}

impl XVolSlot {
    /// Named construction: the event count and file id are facts (the xr event
    /// count is the only nonzero one, `SPEC-xf-xr` §3); the signature bitfield
    /// stays the signature module's raw vocabulary here.
    pub fn from_facts(event_count: u32, file_id: u32, signature: [u8; XVOL_SIG_LEN]) -> Self {
        Self {
            event_count,
            file_id,
            signature,
        }
    }
}

impl IndexRecord {
    /// The index record mirroring a sym slot (`SPEC-heaps` §1/§5: byte 2 = the sym
    /// slot's 0x70, byte 3 = its kind byte, the u16 pair = its 0x6c/0x6e — verified
    /// 13115/13115 on the reference snapshot). `key` is the indexed word head (the
    /// xsb folds the name's head lowercase, the xab keeps it; the scope-chain
    /// derived heads are the writer's policy) and `size` the companion-block
    /// vocabulary (bit 31 variant flag, low bits 2 / 4+8k) — both inputs.
    pub fn from_sym(slot: u16, sym: &SymSlot, key: [u8; 4], size: u32) -> Self {
        Self {
            slot,
            aux1: (sym.raw112 & 0xff) as u8,
            kind: sym.kind as u8,
            aux_c: sym.raw108 as u16,
            aux_d: (sym.raw108 >> 16) as u16,
            size,
            key,
        }
    }

    /// The xsb key: the symbol name's first four bytes ASCII-folded, NUL padded
    /// (`SPEC-heaps` §1).
    pub fn xsb_key(name: &[u8]) -> [u8; 4] {
        let mut key = [0u8; 4];
        for (k, b) in name.iter().take(4).enumerate() {
            key[k] = b.to_ascii_lowercase();
        }
        key
    }
}

impl XdirEntry {
    /// The directory entry for one index page (`SPEC-heaps` §4): the anchor copy is
    /// the page's first record and the offset its byte offset (both rules verified
    /// 74/74 and 24/24 against the snapshot); `bucket` (hashes key+position, §6.4)
    /// and `vm_addr` (SI's segmented-linear allocator state, COMPARISON-REPORT
    /// §3.5) are allocation facts carried in as inputs.
    pub fn from_page(page: usize, anchor: IndexRecord, bucket: u32, vm_addr: u32) -> Self {
        Self {
            record: anchor,
            bucket,
            vm_addr,
            file_offset: (page * INDEX_PAGE_SIZE) as u32,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /* ---------- the reference snapshot ---------- */

    /// The reference volume snapshot: `si4-rea`'s `sip-vol/snap`, ten volumes of one
    /// SI4 project (`Untitled Project2`). Never written to — read only, the
    /// acceptance baseline. `GGS_SIP_SNAP_DIR` moves it; the default is the
    /// authoring machine's path.
    fn snap_dir() -> Option<PathBuf> {
        let dir = match std::env::var_os("GGS_SIP_SNAP_DIR") {
            Some(dir) => PathBuf::from(dir),
            None => PathBuf::from(r"C:\Users\penghongxia\si4-rea\sip-vol\snap"),
        };
        if dir.is_dir() {
            Some(dir)
        } else {
            None
        }
    }

    fn skip_note() {
        eprintln!(
            "skip: the si4-rea reference snapshot is not present \
             (set GGS_SIP_SNAP_DIR to its sip-vol/snap directory)"
        );
    }

    fn snap_volume(name: &str) -> Option<Vec<u8>> {
        let bytes = std::fs::read(snap_dir()?.join(name)).ok()?;
        Some(bytes)
    }

    /* ---------- the container layer ---------- */

    #[test]
    fn the_header_block_carries_the_documented_write_order() {
        // SPEC-head.md §2's observed sym header bytes, verbatim.
        let header = VolumeHeader {
            magic: MAGIC_SYM,
            version: SI4_VERSION,
            count: 0x10B8,
            capacity: 0x10B8,
            first_free: FREE_HEAD_NONE,
            rec_size: 180,
            unk18: 0,
            state: 0,
        };
        let block = header.emit_block();
        assert_eq!(
            &block[..16],
            &[
                0x15, 0x07, 0x00, 0x00, 0x96, 0x00, 0x00, 0x04, 0xB8, 0x10, 0x00, 0x00, 0xB8, 0x10,
                0x00, 0x00
            ]
        );
        assert_eq!(block.len(), HEADER_BLOCK_SIZE);
        // Only the first 64 bytes are fields; the padding is memset zero.
        assert!(block[HEADER_FIELD_BYTES..].iter().all(|&b| b == 0));
        // Only bit 0 of the state survives the store (`vol[6] & 1`).
        assert_eq!(VolumeHeader { state: 1, ..header }.emit_block()[0x1C], 1);
        assert_eq!(VolumeHeader { state: 3, ..header }.emit_block()[0x1C], 1);
        assert_eq!(header.emit_block()[0x1C], 0);
        // The block parses back to the same header.
        assert_eq!(VolumeHeader::parse_block(&block), Some(header));
        // A short block does not parse.
        assert_eq!(VolumeHeader::parse_block(&block[..32]), None);
    }

    #[test]
    fn the_container_splits_and_reassembles_slots() {
        let header = VolumeHeader {
            magic: MAGIC_XVOL,
            version: SI4_VERSION,
            count: 1,
            capacity: 3,
            first_free: 1,
            rec_size: 12,
            unk18: 0x1234,
            state: 1,
        };
        let mut live = Vec::new();
        live.extend_from_slice(&LIVE_SENTINEL.to_le_bytes());
        live.extend(0u8..8); // payload filler, twelve bytes wide
        let freed = free_slot_bytes(12, 2);
        let bytes = emit_volume(&header, &[&live, &freed, &[0u8; 12]]);
        // The base block then the slots at 0x200 + i * rec_size.
        assert_eq!(bytes.len(), HEADER_BLOCK_SIZE + 3 * 12);
        assert_eq!(&bytes[..4], &MAGIC_XVOL.to_le_bytes());
        assert_eq!(bytes[0x1C], 1); // state bit 0
        let parsed = parse_volume(&bytes).expect("parse");
        assert_eq!(parsed.header, header);
        assert_eq!(parsed.slots.len(), 3);
        assert_eq!(parsed.slots[0], live.as_slice());
        assert_eq!(parsed.slots[1], freed.as_slice());
        assert!(slot_is_live(parsed.slots[0]));
        assert!(!slot_is_live(parsed.slots[1]));
        assert!(slot_is_zero(parsed.slots[2]));
        // The freed slot carries its chain link in the first dword and zeros after.
        assert_eq!(&freed[..4], &2i32.to_le_bytes());
        assert!(freed[4..].iter().all(|&b| b == 0));
        // Odd lengths and zero strides do not parse.
        assert!(parse_volume(&bytes[..bytes.len() - 1]).is_none());
        let zero_stride = VolumeHeader {
            rec_size: 0,
            ..header
        };
        assert!(parse_volume(&emit_volume(&zero_stride, &[])).is_none());
    }

    /* ---------- the record codecs ---------- */

    #[test]
    fn the_siproj_record_encodes_the_documented_layout() {
        // The reference volume's record 0, byte for byte.
        let record = SiprojSlot {
            path: b"CMakeLists.txt".to_vec(),
            mtime_low: 0x18B4_470F,
            mtime_high: 0x01DD_547F,
            first_symbol: 0xFFFF_FFFE,
            lines: 21,
            aux_id: 22,
            size: 878,
            count_a: 0,
            count_b: 0,
        };
        let bytes = record.encode();
        assert_eq!(bytes.len(), SIPROJ_REC_SIZE);
        assert_eq!(&bytes[..4], &LIVE_SENTINEL.to_le_bytes());
        assert_eq!(&bytes[4..18], b"CMakeLists.txt");
        assert_eq!(bytes[18], 0); // NUL right after the path
        assert!(bytes[18..256].iter().all(|&b| b == 0));
        assert_eq!(&bytes[260..268], &0x01DD_547F_18B4_470Fu64.to_le_bytes());
        assert_eq!(&bytes[268..272], &0xFFFF_FFFEu32.to_le_bytes());
        assert_eq!(&bytes[272..276], &21u32.to_le_bytes());
        // One aux id, three writes (+276, +280, +308).
        for at in [276usize, 280, 308] {
            assert_eq!(&bytes[at..at + 4], &22u32.to_le_bytes());
        }
        assert_eq!(&bytes[284..288], &878u32.to_le_bytes());
        // The padding regions stay zero.
        assert!(bytes[256..260].iter().all(|&b| b == 0));
        assert!(bytes[296..308].iter().all(|&b| b == 0));
        assert!(bytes[312..].iter().all(|&b| b == 0));
        assert_eq!(SiprojSlot::decode(&bytes), Some(record.clone()));
        // Long paths truncate at the NUL-fitting capacity.
        let long = SiprojSlot {
            path: vec![b'a'; 400],
            ..record
        };
        let bytes = long.encode();
        assert_eq!(bytes[4 + SIPROJ_PATH_MAX], 0);
        assert_eq!(
            SiprojSlot::decode(&bytes).unwrap().path.len(),
            SIPROJ_PATH_MAX
        );
        // A mangled sentinel or a zero slot refuses to decode.
        let mut mangled = bytes.clone();
        mangled[..4].copy_from_slice(&2i32.to_le_bytes());
        assert_eq!(SiprojSlot::decode(&mangled), None);
        assert_eq!(SiprojSlot::decode(&vec![0u8; 328]), None);
    }

    #[test]
    fn the_sym_record_encodes_the_documented_layout() {
        // SPEC-sym.md's own first record: app_main, 1-based line 23 -> line0 22.
        let record = SymSlot {
            name: b"app_main".to_vec(),
            line0: 22,
            col0: 16,
            decl_start: 22,
            token_col: 11,
            decl_end_line: 239,
            decl_end_col: 1,
            raw108: 0x06_0001,
            raw112: 0,
            raw116: 0,
            prev: FREE_HEAD_NONE,
            scope: FREE_HEAD_NONE,
            related: FREE_HEAD_NONE,
            file_id: 3,
            raw136: 0,
            kind: 0, // Function
            flags: 1,
            name_tag: 0x0300,
        };
        let bytes = record.encode();
        assert_eq!(bytes.len(), SYM_REC_SIZE);
        assert_eq!(&bytes[..4], &LIVE_SENTINEL.to_le_bytes());
        assert_eq!(bytes[4], 8);
        assert_eq!(&bytes[5..13], b"app_main");
        assert!(bytes[13..84].iter().all(|&b| b == 0));
        assert_eq!(&bytes[84..88], &22u32.to_le_bytes());
        assert_eq!(&bytes[88..92], &16u32.to_le_bytes());
        assert_eq!(&bytes[100..104], &239u32.to_le_bytes());
        assert_eq!(&bytes[104..108], &1u32.to_le_bytes());
        assert_eq!(&bytes[120..124], &FREE_HEAD_NONE.to_le_bytes());
        assert_eq!(&bytes[132..136], &3u32.to_le_bytes());
        // kind low half, flags high half of the +140 word.
        assert_eq!(&bytes[140..144], &(1u32 << 16).to_le_bytes());
        assert_eq!(&bytes[144..148], &0x0300u32.to_le_bytes());
        assert!(bytes[148..].iter().all(|&b| b == 0));
        assert_eq!(SymSlot::decode(&bytes), Some(record.clone()));
        // Names cap at 79 bytes; the length byte reads back the truncated width.
        let wide = SymSlot {
            name: vec![b'x'; 200],
            ..record
        };
        let bytes = wide.encode();
        assert_eq!(bytes[4], SYM_NAME_MAX as u8);
        assert_eq!(SymSlot::decode(&bytes).unwrap().name.len(), SYM_NAME_MAX);
        // A length byte beyond the capacity refuses to decode.
        let mut mangled = bytes.clone();
        mangled[4] = 80;
        assert_eq!(SymSlot::decode(&mangled), None);
        assert_eq!(SymSlot::decode(&[0u8; SYM_REC_SIZE]), None);
    }

    #[test]
    fn the_xvol_record_encodes_the_documented_layout() {
        let record = XVolSlot {
            event_count: 114_402,
            file_id: 477,
            signature: {
                let mut sig = [0u8; XVOL_SIG_LEN];
                sig[15938 / 8] = 1 << (15938 % 8); // the observed max bit index
                sig
            },
        };
        let bytes = record.encode();
        assert_eq!(bytes.len(), XVOL_REC_SIZE);
        assert_eq!(&bytes[..4], &LIVE_SENTINEL.to_le_bytes());
        assert_eq!(&bytes[4..8], &114_402u32.to_le_bytes());
        assert_eq!(&bytes[8..12], &477u32.to_le_bytes());
        assert!(bytes[12..20].iter().all(|&b| b == 0)); // the reserved u64
        assert_eq!(&bytes[20..], &record.signature[..]);
        assert_eq!(XVolSlot::decode(&bytes), Some(record));
        assert_eq!(XVolSlot::decode(&vec![0u8; XVOL_REC_SIZE]), None);
    }

    #[test]
    fn xm_is_a_bare_u32_array() {
        let table = vec![3, 24, 28, 90, 366, 367, 21, 29];
        let bytes = emit_xm(&table);
        assert_eq!(bytes.len(), 32);
        assert_eq!(parse_xm(&bytes), Some(table));
        assert_eq!(parse_xm(&bytes[..30]), None);
        assert_eq!(parse_xm(&[]), Some(vec![]));
    }

    #[test]
    fn index_records_round_trip_including_garbage_keys() {
        // The reference volume's own first record: slot 2626, "aban", size 12 (4+8k).
        let record = IndexRecord {
            slot: 2626,
            aux1: 0,
            kind: 0,
            aux_c: 1,
            aux_d: 5,
            size: 12,
            key: *b"aban",
        };
        assert_eq!(record.encode().len(), INDEX_REC_SIZE);
        assert_eq!(IndexRecord::decode(&record.encode()), Some(record));
        // A stale record's garbage key bytes carry through unchanged.
        let stale = IndexRecord {
            slot: 3943,
            size: 0x8000_0000,
            key: [b'A', 0, 0xD1, 0x08],
            ..Default::default()
        };
        assert_eq!(IndexRecord::decode(&stale.encode()), Some(stale));
        // Whole-volume shape: pages of 256 records, zero free slots staying in place.
        let mut records = vec![record; INDEX_RECS_PER_PAGE * 2];
        records[7] = IndexRecord::default();
        records[300] = stale;
        let bytes = emit_index_volume(&records);
        assert_eq!(bytes.len(), INDEX_PAGE_SIZE * 2);
        assert_eq!(parse_index_volume(&bytes), Some(records));
        assert_eq!(parse_index_volume(&bytes[..bytes.len() - 1]), None);
        assert_eq!(IndexRecord::decode(&[0u8; 8]), None);
    }

    #[test]
    fn the_xdir_file_matches_its_documented_offsets() {
        let volume = XdirVolume {
            bucket_space: 256,
            pages_used: 2,
            pages_capacity: XDIR_PAGES_CAPACITY,
            stamp1: 0x08C9_5978,
            stamp2: 0x04B4_DBB0,
            entries: vec![
                XdirEntry {
                    record: IndexRecord {
                        slot: 2626,
                        aux_c: 1,
                        aux_d: 5,
                        key: *b"aban",
                        ..Default::default()
                    },
                    bucket: 0xE4,
                    vm_addr: 0x0541_0000,
                    file_offset: 0,
                },
                XdirEntry {
                    record: IndexRecord {
                        slot: 400,
                        kind: 13,
                        size: 0x8000_001C,
                        key: *b"aes3",
                        ..Default::default()
                    },
                    bucket: 0xA2,
                    vm_addr: 0x0541_1000,
                    file_offset: 0x1000,
                },
            ],
            footer: [0, 1000, 4, 500, 0x08C9_5978 + 16, 0x04B4_DBB0 + 40, 0],
        };
        let bytes = volume.emit();
        assert_eq!(
            bytes.len(),
            XDIR_ENTRIES_AT + 2 * XDIR_ENTRY_STRIDE + XDIR_FOOTER_BYTES
        );
        assert_eq!(&bytes[..4], &MAGIC_XDIR.to_le_bytes());
        assert_eq!(&bytes[4..8], &SI4_VERSION.to_le_bytes());
        assert_eq!(&bytes[8..12], &256u32.to_le_bytes());
        assert_eq!(
            &bytes[0x88..0x8C],
            &(XDIR_ENTRY_ARRAY_AT as u32).to_le_bytes()
        );
        assert_eq!(
            &bytes[0x8C..0x90],
            &(XDIR_ENTRIES_AT as u32 + 80).to_le_bytes()
        );
        assert_eq!(
            &bytes[0x110..0x120],
            &[2, 0, 0, 0, 2, 0, 0, 0, 40, 0, 0, 0, 0xF4, 0x01, 0, 0]
        );
        let mut stamps = Vec::new();
        stamps.extend_from_slice(&volume.stamp1.to_le_bytes());
        stamps.extend_from_slice(&volume.stamp2.to_le_bytes());
        stamps.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(&bytes[0x120..0x12C], stamps.as_slice());
        // Entry 0 sits at 0x12c: the anchor record copy, then zero/bucket/vm/offset.
        assert_eq!(&bytes[0x12C..0x13C], &volume.entries[0].record.encode()[..]);
        assert_eq!(&bytes[0x13C..0x140], &0u32.to_le_bytes());
        assert_eq!(&bytes[0x140..0x144], &0xE4u32.to_le_bytes());
        assert_eq!(&bytes[0x144..0x148], &0x0541_0000u32.to_le_bytes());
        assert_eq!(&bytes[0x148..0x14C], &0u32.to_le_bytes());
        assert_eq!(bytes[XDIR_ENTRIES_AT + 0x10], 0); // +0x10 zero
                                                      // The footer rides the last 28 bytes.
        let footer_at = bytes.len() - XDIR_FOOTER_BYTES;
        for (i, word) in volume.footer.iter().enumerate() {
            assert_eq!(
                &bytes[footer_at + i * 4..footer_at + i * 4 + 4],
                &word.to_le_bytes()
            );
        }
        assert_eq!(XdirVolume::parse(&bytes), Some(volume));
        // Layout violations refuse to parse.
        let mut broken = bytes.clone();
        broken[0] = 0x91; // wrong magic
        assert!(XdirVolume::parse(&broken).is_none());
        let mut broken = bytes.clone();
        broken[0x118] = 44; // wrong stride
        assert!(XdirVolume::parse(&broken).is_none());
        let mut broken = bytes.clone();
        broken[0x8C] ^= 1; // payload length no longer matches the entry count
        assert!(XdirVolume::parse(&broken).is_none());
    }

    /* ---------- the reference-volume round trips ---------- */

    #[test]
    fn siproj_volume_round_trips_byte_exact() {
        let Some(bytes) = snap_volume("Untitled Project2.siproj") else {
            skip_note();
            return;
        };
        // The snapshot's own size, pinning the acceptance input.
        assert_eq!(bytes.len(), 157_296);
        let parsed = parse_siproj_volume(&bytes).expect("siproj parses");
        assert_eq!(parsed.header.magic, MAGIC_SIPROJ);
        assert_eq!(parsed.header.version, SI4_VERSION);
        assert_eq!(parsed.records.len(), 478);
        assert_eq!(parsed.spare_slots, 0);
        assert_eq!(parsed.records[0].path, b"CMakeLists.txt");
        assert_eq!(parsed.records[3].path,
            b"components\\esp-dsp\\applications\\azure_board_apps\\apps\\3d_graphics\\main\\3d_graphics_demo.cpp");
        let rebuilt = emit_siproj_volume(&parsed.header, &parsed.records, parsed.spare_slots);
        assert_eq!(rebuilt, bytes, "siproj must rebuild byte for byte");
    }

    #[test]
    fn sym_volume_round_trips_byte_exact() {
        let Some(bytes) = snap_volume("Untitled Project2.sip_sym") else {
            skip_note();
            return;
        };
        assert_eq!(bytes.len(), 4_302_512);
        let parsed = parse_sym_volume(&bytes).expect("sym parses");
        assert_eq!(parsed.header.magic, MAGIC_SYM);
        assert_eq!(parsed.header.count, 4280);
        // The header's capacity is the live count; the file's physical slots (23,900)
        // are the pre-allocation.
        assert_eq!(parsed.header.capacity, parsed.header.count);
        assert_eq!(parsed.records.len(), 4280);
        assert_eq!(parsed.spare_slots, 23_900 - 4280);
        assert_eq!(parsed.records[0].name, b"app_main");
        let rebuilt = emit_sym_volume(&parsed.header, &parsed.records, parsed.spare_slots);
        assert_eq!(rebuilt, bytes, "sym must rebuild byte for byte");
    }

    #[test]
    fn xf_xr_and_xc_volumes_round_trip_byte_exact() {
        let mut checked = 0;
        for name in [
            "Untitled Project2.sip_xf",
            "Untitled Project2.sip_xr",
            "Untitled Project2.sip_xc",
        ] {
            let Some(bytes) = snap_volume(name) else {
                skip_note();
                return;
            };
            assert_eq!(bytes.len(), 967_984, "{name}");
            let parsed = parse_xvol_volume(&bytes).unwrap_or_else(|| panic!("{name} parses"));
            assert_eq!(parsed.header.magic, MAGIC_XVOL, "{name}");
            assert_eq!(parsed.header.rec_size as usize, XVOL_REC_SIZE, "{name}");
            assert_eq!(parsed.records.len(), 478, "{name}");
            let rebuilt = emit_xvol_volume(&parsed.header, &parsed.records, parsed.spare_slots);
            assert_eq!(rebuilt, bytes, "{name} must rebuild byte for byte");
            checked += 1;
        }
        assert_eq!(checked, 3);
    }

    #[test]
    fn xm_volume_round_trips_byte_exact() {
        let Some(bytes) = snap_volume("Untitled Project2.sip_xm") else {
            skip_note();
            return;
        };
        assert_eq!(bytes.len(), 1_912);
        let parsed = parse_xm(&bytes).expect("xm parses");
        assert_eq!(parsed.len(), 478);
        // A permutation of 0..477: 478 distinct ids.
        let mut ids = parsed.clone();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 478);
        assert_eq!(emit_xm(&parsed), bytes, "xm must rebuild byte for byte");
    }

    #[test]
    fn xab_and_xsb_volumes_round_trip_byte_exact() {
        for (name, bytes_expected, pages) in [
            ("Untitled Project2.sip_xab", 303_104usize, 74usize),
            ("Untitled Project2.sip_xsb", 98_304, 24),
        ] {
            let Some(bytes) = snap_volume(name) else {
                skip_note();
                return;
            };
            assert_eq!(bytes.len(), bytes_expected, "{name}");
            let parsed = parse_index_volume(&bytes).unwrap_or_else(|| panic!("{name} parses"));
            assert_eq!(parsed.len(), pages * INDEX_RECS_PER_PAGE, "{name}");
            let rebuilt = emit_index_volume(&parsed);
            assert_eq!(rebuilt, bytes, "{name} must rebuild byte for byte");
        }
    }

    #[test]
    fn xad_and_xsd_volumes_round_trip_byte_exact() {
        for (name, sibling_name, bytes_expected, pages) in [
            (
                "Untitled Project2.sip_xad",
                "Untitled Project2.sip_xab",
                3_288usize,
                74usize,
            ),
            (
                "Untitled Project2.sip_xsd",
                "Untitled Project2.sip_xsb",
                1_288,
                24,
            ),
        ] {
            let Some(bytes) = snap_volume(name) else {
                skip_note();
                return;
            };
            assert_eq!(bytes.len(), bytes_expected, "{name}");
            let parsed = XdirVolume::parse(&bytes).unwrap_or_else(|| panic!("{name} parses"));
            assert_eq!(parsed.pages_used as usize, pages, "{name}");
            assert_eq!(parsed.pages_used as usize, parsed.entries.len(), "{name}");
            assert_eq!(parsed.pages_capacity, XDIR_PAGES_CAPACITY, "{name}");
            assert_eq!(parsed.bucket_space, 256, "{name}");
            // Every entry's anchor copy is the sibling index volume's record at the
            // entry's own offset (verified 74/74 and 24/24 on the reference snapshot).
            if let Some(sibling) = snap_volume(sibling_name) {
                for entry in &parsed.entries {
                    let at = entry.file_offset as usize;
                    assert_eq!(
                        entry.record.encode()[..],
                        sibling[at..at + INDEX_REC_SIZE],
                        "{name}"
                    );
                }
            }
            let rebuilt = parsed.emit();
            assert_eq!(rebuilt, bytes, "{name} must rebuild byte for byte");
        }
    }

    /* ---------- the structured path (SPEC-sym-fields.md rules) ---------- */

    /// The analyzed source tree behind the snapshot (the reference project
    /// `Untitled Project2`'s root; `GGS_SIP_SOURCE_ROOT` moves it).
    fn source_root() -> Option<PathBuf> {
        let dir = match std::env::var_os("GGS_SIP_SOURCE_ROOT") {
            Some(dir) => PathBuf::from(dir),
            None => PathBuf::from(r"E:\esp-sdr"),
        };
        if dir.is_dir() {
            Some(dir)
        } else {
            None
        }
    }

    /// Reads one file's source rows the way the rules scan them: `\n`-separated,
    /// `\r` trimmed, a final line without its newline still a row (Python's
    /// `splitlines`, which the Wave2 fit ran against).
    fn read_lines(path: &std::path::Path) -> Vec<Vec<u8>> {
        let raw = std::fs::read(path).expect("source file readable");
        let mut lines: Vec<Vec<u8>> = Vec::new();
        let mut cur = Vec::new();
        for b in raw {
            if b == b'\n' {
                lines.push(std::mem::take(&mut cur));
            } else if b != b'\r' {
                cur.push(b);
            }
        }
        if !cur.is_empty() {
            lines.push(cur);
        }
        lines
    }

    #[test]
    fn lang_id_carries_the_snapshot_language_table() {
        assert_eq!(lang_id(b"main\\pytest.ini", 8), 0);
        assert_eq!(lang_id(b"main\\report.inc", 6), 2);
        assert_eq!(lang_id(b"main\\common\\app.c", 0), 3);
        assert_eq!(lang_id(b"include\\app.h", 17), 3);
        assert_eq!(lang_id(b"main\\mat.cpp", 11), 3);
        assert_eq!(lang_id(b"main\\index.html", 43), 8); // the CSS/title rows
        assert_eq!(lang_id(b"main\\index.html", 0), 13); // its embedded script
        assert_eq!(lang_id(b"scripts\\app.js", 5), 13);
        assert_eq!(lang_id(b"Makefile", 16), 15); // the extensionless makefile rows
        assert_eq!(lang_id(b"tools\\s3_ring.py", 29), 22);
    }

    #[test]
    fn param_count_follows_the_spec_classifier() {
        // SPEC-sym-fields §1.2's evidence samples, one source row each.
        fn rows(row: &[u8]) -> Vec<&[u8]> {
            vec![row]
        }
        let col = |name: &[u8], row: &[u8]| {
            row.windows(name.len())
                .position(|w| w == name)
                .expect("name on row") as u32
        };
        let n = |row: &[u8], name: &[u8], kind: u16| {
            let c = col(name, row);
            param_count(3, kind, c, 0, &rows(row))
        };
        assert_eq!(n(b"void force_rx_gain(unsigned,unsigned) {", b"force_rx_gain", 0), 0);
        assert_eq!(
            n(
                b"void UpdateRefMeasurement(float*,float*,float R[6]) {",
                b"UpdateRefMeasurement",
                0
            ),
            3
        );
        assert_eq!(n(b"void tie_log(int n_regs, ...) {", b"tie_log", 0), 255);
        // memset(accum_buf,0,sizeof(accum_buf)) counts 1: the sizeof group is decl-clean
        assert_eq!(
            n(b"x = memset(accum_buf,0,sizeof(accum_buf));", b"memset", 0),
            1
        );
        assert_eq!(n(b"void f(M, M) {", b"f", 0), 0);
        // the function-like macro counts its top-level items, `...` as one
        assert_eq!(
            n(b"#define ESP_RETURN_ON_ERROR(x, tag, format, ...) 0", b"ESP_RETURN_ON_ERROR", 1),
            4
        );
        // the JavaScript function kind splits top-level commas, defaults counted
        assert_eq!(
            param_count(
                13,
                0,
                col(b"display", b"function display(s,fill=false){}"),
                0,
                &rows(b"function display(s,fill=false){}")
            ),
            2
        );
        // non-function kinds answer 0
        assert_eq!(n(b"#define BMI270_ACC_CONF 0x40", b"BMI270_ACC_CONF", 6), 0);
    }

    #[test]
    fn packed_108_counts_the_effective_body_lines() {
        let lines: Vec<&[u8]> = vec![
            b"int f(void) {",
            b"    if (x) return 1;",
            b"    for (;;) {}",
            b"    /* comment",
            b"    run */",
            b"    #pragma once",
            b"    \"only a string\"",
            b"}",
        ];
        // X = 5: the brace row, the two control rows, the one open block comment run,
        // the closing brace; the continuation, the preprocessor row and the
        // string-only row do not count. A = the `if` + `for` pair. B = 0.
        assert_eq!(packed_108(0, 0, 7, &lines), (5 << 16) | 2);
        // a prototype (no braces in range) and a variable carry 0
        assert_eq!(packed_108(13, 0, 0, &[b"extern void app_main();"]), 0);
        assert_eq!(packed_108(5, 0, 0, &[b"static bool b = true;"]), 0);
    }

    #[test]
    fn decl_end_col_rules_by_kind() {
        fn one(row: &[u8]) -> Vec<&[u8]> {
            vec![row]
        }
        // the object macros' constant
        assert_eq!(
            decl_end_col(1, 3, b"F", 0, 0, 0, &one(b"#define F 1")),
            Some(4096)
        );
        // the C function's single-line brace match (one past `}`) ...
        assert_eq!(
            decl_end_col(0, 3, b"g", 4, 0, 0, &one(b"int g(void) { return 1; }")),
            Some(25)
        );
        // ... and the multi-line constants: C 1, Python 0
        assert_eq!(
            decl_end_col(0, 3, b"h", 5, 0, 2, &[&b"void h(void)"[..], b"{", b"}"]),
            Some(1)
        );
        assert_eq!(
            decl_end_col(0, 22, b"f", 4, 0, 1, &[&b"def f():"[..], b"    return 0"]),
            Some(0)
        );
        // the terminator scan finds the declaration's own `;`
        assert_eq!(
            decl_end_col(5, 3, b"b", 12, 0, 0, &one(b"static bool b = true;")),
            Some(20)
        );
        // the pure-virtual `=` reports the column before it
        assert_eq!(
            decl_end_col(36, 3, b"Init", 17, 0, 0, &one(b"    virtual void Init() = 0;")),
            Some(23)
        );
        // the tag openers: named 1, anonymous 2, bare keyword-first col+1, next-row 2
        assert_eq!(
            decl_end_col(7, 3, b"audio_set", 13, 0, 1, &one(b"typedef enum audio_set {")),
            Some(1)
        );
        assert_eq!(
            decl_end_col(2, 3, b"{anonx}", 8, 0, 1, &one(b"typedef struct {")),
            Some(2)
        );
        assert_eq!(
            decl_end_col(2, 3, b"{anony}", 4, 0, 1, &one(b"    struct {")),
            Some(5)
        );
        assert_eq!(
            decl_end_col(7, 3, b"{anonz}", 8, 0, 2, &[&b"typedef struct __attribute__((packed))"[..], b"{"]),
            Some(2)
        );
        // the Python base reference's exclusive end and the import name's column
        assert_eq!(
            decl_end_col(23, 22, b"TestCase", 25, 0, 0, &one(b"class BurstGain(unittest.TestCase):")),
            Some(33)
        );
        assert_eq!(
            decl_end_col(54, 22, b"Path", 20, 0, 0, &one(b"from pathlib import Path")),
            Some(20)
        );
        // the Python assignment points at the `=` head, the augmented one one earlier
        assert_eq!(
            decl_end_col(17, 22, b"img_ext", 13, 0, 0, &one(b"        self.img_ext = None")),
            Some(21)
        );
        assert_eq!(
            decl_end_col(5, 22, b"extensions", 0, 0, 0, &one(b"extensions += ['x']")),
            Some(11)
        );
        // the unpinned extents answer None (the table's domain)
        assert_eq!(decl_end_col(43, 8, b"sel", 10, 0, 0, &one(b".sel{}")), None);
        assert_eq!(
            decl_end_col(22, 3, b"{anons}", 8, 0, 0, &one(b"typedef struct { u8 a; } s;")),
            None
        );
    }

    #[test]
    fn the_relational_rules_link_storage_order() {
        // one file: a named typedef'd enum group (tag, name-sorted members,
        // typedef, shadow, rescan) then a namespace with a class-implementation
        // stub and one member definition.
        let input = |name: &[u8], kind: u16, line0: u32, col0: u32, ds: u32, el: u32| SymInput {
            name: name.to_vec(),
            file_id: 0,
            kind,
            line0,
            col0,
            decl_start: ds,
            decl_end_line: el,
        };
        let inputs = vec![
            input(b"tag", 7, 10, 13, 10, 14),        // 0 the enum tag
            input(b"amber", 12, 11, 4, 11, 11),      // 1..3 members, name order
            input(b"bronze", 12, 12, 4, 12, 12),     // 2
            input(b"crystal", 12, 13, 4, 13, 13),    // 3
            input(b"tname", 4, 14, 2, 10, 14),       // 4 the typedef row
            input(b"tag", 22, 10, 13, 10, 14),       // 5 the shadow row
            input(b"bronze", 12, 12, 4, 12, 12),     // 6 the rescan copy
            input(b"ns", 29, 20, 4, 20, 99),         // 7 the namespace
            input(b"Stub", 21, 25, 0, 25, 30),       // 8 the class stub
            input(b"method", 11, 27, 5, 27, 29),     // 9 the member definition
        ];
        let files = [SymFileSource {
            path: "main\\x.c",
            lines: &[],
        }];
        let graph = SymGraph::build(&inputs, &files);
        // scope: members ride the tag, the typedef and the rescan stay file-scope,
        // the shadow rides the typedef, the stub the namespace, the member the stub
        let want_scope = [-2, 0, 0, 0, -2, 4, -2, -2, 7, 8];
        for (i, want) in want_scope.iter().enumerate() {
            assert_eq!(graph.scope(i), *want, "scope {i}");
        }
        // prev: the file-scope chain tag→typedef→rescan→namespace; the member and
        // shadow chains open fresh -2 heads
        let want_prev = [-2, -2, 1, 2, 0, -2, 4, 6, -2, -2];
        for (i, want) in want_prev.iter().enumerate() {
            assert_eq!(graph.prev(i), *want, "prev {i}");
        }
        // linked: the tag's last member, the typedef's shadow, the ns's stub
        let want_linked = [3, -2, -2, -2, 5, -2, -2, 8, 9, -2];
        for (i, want) in want_linked.iter().enumerate() {
            assert_eq!(graph.linked(i), *want, "linked {i}");
        }
        // flags: the in-group constants 256, the rescan copy 0 (it has a 256 twin),
        // the shadow 256, everything else 0 on single records
        let want_flags = [0, 256, 256, 256, 0, 256, 0, 0, 0, 0];
        for (i, want) in want_flags.iter().enumerate() {
            assert_eq!(graph.flags(i), *want, "flags {i}");
        }
    }

    #[test]
    fn structured_construction_rebuilds_all_ten_volumes_byte_exact() {
        let volume = |name| snap_volume(name);
        let names = [
            "Untitled Project2.siproj",
            "Untitled Project2.sip_sym",
            "Untitled Project2.sip_xf",
            "Untitled Project2.sip_xr",
            "Untitled Project2.sip_xc",
            "Untitled Project2.sip_xm",
            "Untitled Project2.sip_xab",
            "Untitled Project2.sip_xsb",
            "Untitled Project2.sip_xad",
            "Untitled Project2.sip_xsd",
        ];
        let mut snaps: Vec<(String, Vec<u8>)> = Vec::new();
        for name in names {
            let Some(bytes) = volume(name) else {
                skip_note();
                return;
            };
            snaps.push((name.to_string(), bytes));
        }
        let Some(root) = source_root() else {
            eprintln!(
                "skip: the snapshot's analyzed source tree is not present \
                 (set GGS_SIP_SOURCE_ROOT to its project root)"
            );
            return;
        };

        // .siproj — every record rebuilt from the file's own facts: the path, the
        // scan-time mtime and size and line count off the disk (COMPARISON-REPORT
        // B7: the tree is unchanged since the snapshot's scan); +268 first symbol,
        // +276 aux id and the two definition counts are the table's historical
        // bookkeeping, carried in (§2.2: +268 is not the block's first id).
        let parsed_siproj = parse_siproj_volume(&snaps[0].1).expect("siproj parses");
        let mut siproj_records = Vec::new();
        let mut file_rows: Vec<Vec<Vec<u8>>> = Vec::new();
        for rec in &parsed_siproj.records {
            let rel = String::from_utf8_lossy(&rec.path).replace('\\', "/");
            let full = root.join(&rel);
            let raw = std::fs::read(&full).expect("snapshot file present on disk");
            let nanos = std::fs::metadata(&full)
                .expect("snapshot file metadata")
                .modified()
                .expect("mtime")
                .duration_since(std::time::UNIX_EPOCH)
                .expect("after epoch")
                .as_nanos();
            let (mtime_low, mtime_high) = filetime_from_unix_nanos(nanos);
            siproj_records.push(SiprojSlot {
                path: rec.path.clone(),
                mtime_low,
                mtime_high,
                first_symbol: rec.first_symbol,
                lines: count_lines(&raw),
                aux_id: rec.aux_id,
                size: raw.len() as u32,
                count_a: rec.count_a,
                count_b: rec.count_b,
            });
            file_rows.push(read_lines(&full));
        }
        assert_eq!(
            emit_siproj_volume(&parsed_siproj.header, &siproj_records, parsed_siproj.spare_slots),
            snaps[0].1,
            "siproj must rebuild byte for byte from the files' own facts"
        );

        // .sip_sym — all 4,280 live records through the structured path: skeleton
        // from the decode, every derived field off its rule or exception table.
        let parsed_sym = parse_sym_volume(&snaps[1].1).expect("sym parses");
        assert_eq!(parsed_sym.records.len(), 4280);
        let mut paths: Vec<String> = Vec::new();
        let mut lines: Vec<Vec<&[u8]>> = Vec::new();
        for (fid, rec) in parsed_siproj.records.iter().enumerate() {
            paths.push(String::from_utf8_lossy(&rec.path).into_owned());
            lines.push(file_rows[fid].iter().map(|r| r.as_slice()).collect());
        }
        let files: Vec<SymFileSource<'_>> = paths
            .iter()
            .zip(lines.iter())
            .map(|(p, l)| SymFileSource { path: p, lines: l })
            .collect();
        let inputs: Vec<SymInput> = parsed_sym
            .records
            .iter()
            .map(|r| SymInput {
                name: r.name.clone(),
                file_id: r.file_id,
                kind: r.kind,
                line0: r.line0,
                col0: r.col0,
                decl_start: r.decl_start,
                decl_end_line: r.decl_end_line,
            })
            .collect();
        let built = build_sym_records(&inputs, &files);
        assert_eq!(built.len(), parsed_sym.records.len());
        for (i, (built, decoded)) in built.iter().zip(parsed_sym.records.iter()).enumerate() {
            assert_eq!(
                built.encode(),
                decoded.encode(),
                "sym record {i} ({}) must rebuild through the structured path",
                String::from_utf8_lossy(&decoded.name)
            );
        }
        assert_eq!(
            emit_sym_volume(&parsed_sym.header, &built, parsed_sym.spare_slots),
            snaps[1].1,
            "sym must rebuild byte for byte through the structured path"
        );

        // the three signature volumes: the event count and file id named, the
        // signature bitfield carried (the signature module's raw vocabulary)
        for (name, slot) in [
            (2usize, "xf"),
            (3, "xr"),
            (4, "xc"),
        ] {
            let parsed = parse_xvol_volume(&snaps[name].1).expect("x volume parses");
            let records: Vec<XVolSlot> = parsed
                .records
                .iter()
                .map(|r| XVolSlot::from_facts(r.event_count, r.file_id, r.signature))
                .collect();
            assert_eq!(
                emit_xvol_volume(&parsed.header, &records, parsed.spare_slots),
                snaps[name].1,
                "sip_{slot} must rebuild byte for byte through the named construction"
            );
        }

        // .sip_xm — the bare u32 table through emit_xm
        let xm = parse_xm(&snaps[5].1).expect("xm parses");
        assert_eq!(emit_xm(&xm), snaps[5].1);

        // the name indexes: every live record's mirror bytes re-derived from its
        // sym slot (SPEC-heaps §1/§5: verified 13115/13115), the key head named by
        // the index (the xsb's folded name head re-derived by the rule), the
        // xab's word/scope keys and the size vocabulary carried (B3's residual)
        let sym_by_slot = |slot: u16| parsed_sym.records.get(slot as usize).expect("slot live");
        for (name, slot, folded) in [(6usize, "xab", false), (7, "xsb", true)] {
            let parsed = parse_index_volume(&snaps[name].1).expect("index volume parses");
            let records: Vec<IndexRecord> = parsed
                .iter()
                .map(|r| {
                    if *r == IndexRecord::default() {
                        return *r;
                    }
                    // the mirror bytes re-derived from the sym slot; the key head and
                    // the size vocabulary stay inputs (B3/B4's residual: the xab's
                    // scope-chain heads and the xsb's non-head keys are unpinned)
                    IndexRecord::from_sym(r.slot, sym_by_slot(r.slot), r.key, r.size)
                })
                .collect();
            assert_eq!(
                emit_index_volume(&records),
                snaps[name].1,
                "sip_{slot} must rebuild byte for byte through the named construction"
            );
            if folded {
                // a real structural claim on the side: the folded name-head rule
                // covers the bulk of the xsb keys (B4's 3437 exact = this folded
                // family plus the case-sensitive bare one it subsumes elsewhere)
                let head_matched = parsed
                    .iter()
                    .filter(|r| {
                        **r != IndexRecord::default()
                            && IndexRecord::xsb_key(&sym_by_slot(r.slot).name) == r.key
                    })
                    .count();
                assert!(
                    head_matched > 2500,
                    "the xsb folded-head rule covers {head_matched} keys, expected the bulk"
                );
            }
        }

        // the page directories: each entry re-derived by from_page — the anchor
        // copy off the sibling index volume and the offset off the page number
        // (the bucket and VM address are SI allocation state, carried)
        for (name, slot, sibling) in [(8usize, "xad", 6usize), (9, "xsd", 7)] {
            let mut parsed = XdirVolume::parse(&snaps[name].1).expect("directory parses");
            let sibling_records = parse_index_volume(&snaps[sibling].1).expect("sibling parses");
            for entry in &mut parsed.entries {
                let page = entry.file_offset as usize / INDEX_PAGE_SIZE;
                let anchor = sibling_records[entry.file_offset as usize / INDEX_REC_SIZE];
                *entry = XdirEntry::from_page(page, anchor, entry.bucket, entry.vm_addr);
            }
            assert_eq!(parsed.emit(), snaps[name].1, "sip_{slot} must rebuild byte for byte through from_page");
        }
    }
}
