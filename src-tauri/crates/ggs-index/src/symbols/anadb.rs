//! The analysis database's six tables — modules, symbols, call edges, syllable
//! fragments, type definitions and code positions — serialized in a fixed flat-file
//! layout: a little-endian header followed by the six fixed-width record arrays, plus
//! a sorted syllable index beside it. External tooling that understands the same layout
//! reads ggs's database back, and a delete-and-rebuild regenerates the same bytes.
//!
//! The owner's direction, 2026-11-21: the analyzed folder carries a hidden code-analysis
//! database whose shape is stable across rebuilds. Every record's field order and width
//! is fixed on x64 (no padding: every field is 4-byte aligned):
//! `Module { char name[260]; int sym_count; }`,
//! `Symbol { int id; char name[128]; SymType type; int mod; int line; }`,
//! `CallEdge { int caller, callee, line; }`, `SylEntry { char frag[64]; int sym; }`,
//! `TdrRec { char name[128]; SymType type; int mod; int line; }`,
//! `SirCodeRec { int sym, mod, line, is_def, enc; }`. Strings truncate one byte short of
//! the capacity and NUL-fill the rest (`strncpy` on a zeroed record). Lines are 1-based
//! (the reference tokenizer counts from one); ggs's 0-based rows are shifted on the way
//! in.

/// The six-table database file, written on every full build.
pub const DB_FILE: &str = "ggs.db";
/// The sorted syllable index file, written beside the database.
pub const TIX_FILE: &str = "ggs.tix";

/// The database file's magic marker.
pub const DB_MAGIC: u32 = 0x5349_4C44;
/// v3: the code-position records carry the `enc` field (the enclosing function of a
/// reference).
pub const DB_VERSION: u32 = 3;

const MOD_NAME_CAP: usize = 260;
const SYM_NAME_CAP: usize = 128;
const FRAG_CAP: usize = 64;

/* ---------- The symbol-kind codes ---------- */

pub const SYM_FUNCTION: i32 = 0;
pub const SYM_PROTOTYPE: i32 = 1;
pub const SYM_CLASS: i32 = 2;
pub const SYM_STRUCT: i32 = 3;
pub const SYM_UNION: i32 = 4;
pub const SYM_ENUM: i32 = 5;
pub const SYM_VARIABLE: i32 = 6;
pub const SYM_TYPEDEF: i32 = 7;
pub const SYM_MACRO: i32 = 8;
pub const SYM_NAMESPACE: i32 = 9;
pub const SYM_INTERFACE: i32 = 10;
pub const SYM_MEMBER: i32 = 11;
pub const SYM_ENUM_MEMBER: i32 = 12;
pub const SYM_UNKNOWN: i32 = 18;

/* ---------- The tables, as ggs assembles them ---------- */

#[derive(Clone, Debug, PartialEq)]
pub struct AnaModule {
    pub name: String,
    pub sym_count: i32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AnaSymbol {
    pub id: i32,
    pub name: String,
    pub type_: i32,
    pub module: i32,
    pub line: i32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AnaEdge {
    pub caller: i32,
    pub callee: i32,
    pub line: i32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AnaSyl {
    pub frag: Vec<u8>,
    pub sym: i32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AnaTdr {
    pub name: String,
    pub type_: i32,
    pub module: i32,
    pub line: i32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AnaCode {
    pub sym: i32,
    pub module: i32,
    pub line: i32,
    pub is_def: i32,
    pub enc: i32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AnaTables {
    pub mods: Vec<AnaModule>,
    pub syms: Vec<AnaSymbol>,
    pub edges: Vec<AnaEdge>,
    pub syls: Vec<AnaSyl>,
    pub tdrs: Vec<AnaTdr>,
    pub code: Vec<AnaCode>,
}

/* ---------- The syllable splitter ---------- */

/// The identifier fragment rules the fragment browse runs on: separators (`_ - . space`)
/// split; a digit run stands alone; an uppercase run stops before an Upper-Lower pair
/// (`HTMLParser` → `html` + `parser`) and keeps the trailing lowercase/digit run; a
/// lowercase/digit run keeps going. Fragments lowercase, at most 16 per name and 63
/// bytes each. Operates on bytes exactly like the C original — non-ASCII bytes ride
/// through unchanged.
pub fn split_syllables(name: &str) -> Vec<Vec<u8>> {
    let bytes = name.as_bytes();
    let is_sep = |b: u8| matches!(b, b'_' | b'-' | b'.' | b' ' | b'\t');
    let is_digit = |b: u8| b.is_ascii_digit();
    let is_upper = |b: u8| b.is_ascii_uppercase();
    let is_lower = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let mut out: Vec<Vec<u8>> = Vec::new();
    let mut p = 0usize;
    while p < bytes.len() && out.len() < 16 {
        while p < bytes.len() && is_sep(bytes[p]) {
            p += 1;
        }
        if p >= bytes.len() {
            break;
        }
        let start = p;
        if is_digit(bytes[p]) {
            while p < bytes.len() && is_digit(bytes[p]) {
                p += 1;
            }
        } else if is_upper(bytes[p]) {
            p += 1;
            while p < bytes.len()
                && is_upper(bytes[p])
                && !(p + 1 < bytes.len() && bytes[p + 1].is_ascii_lowercase())
            {
                p += 1;
            }
            while p < bytes.len() && is_lower(bytes[p]) {
                p += 1;
            }
        } else {
            while p < bytes.len() && is_lower(bytes[p]) {
                p += 1;
            }
        }
        if p == start {
            // Safety: always advance (a non-ASCII byte produces a one-byte fragment,
            // exactly the C original's fallback).
            p += 1;
        }
        if p > start {
            let end = start + 63.min(p - start);
            let mut frag = bytes[start..end].to_vec();
            for b in &mut frag {
                if b.is_ascii_uppercase() {
                    *b += 32;
                }
            }
            out.push(frag);
        }
    }
    out
}

/* ---------- The writers ---------- */

/// One fixed-capacity string field: `strncpy` into a zeroed record — truncate at
/// `cap - 1`, NUL-fill the remainder.
fn push_fixed_str(out: &mut Vec<u8>, text: &[u8], cap: usize) {
    let n = text.len().min(cap - 1);
    out.extend_from_slice(&text[..n]);
    out.resize(out.len() + (cap - n), 0);
}

/// The database bytes: the little-endian header (magic, version, the six counts) and
/// then each table's records whole, in the fixed field order.
pub fn write_db(tables: &AnaTables) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&DB_MAGIC.to_le_bytes());
    out.extend_from_slice(&DB_VERSION.to_le_bytes());
    for count in [
        tables.mods.len(),
        tables.syms.len(),
        tables.edges.len(),
        tables.syls.len(),
        tables.tdrs.len(),
        tables.code.len(),
    ] {
        out.extend_from_slice(&(count as i32).to_le_bytes());
    }
    for module in &tables.mods {
        push_fixed_str(&mut out, module.name.as_bytes(), MOD_NAME_CAP);
        out.extend_from_slice(&module.sym_count.to_le_bytes());
    }
    for sym in &tables.syms {
        out.extend_from_slice(&sym.id.to_le_bytes());
        push_fixed_str(&mut out, sym.name.as_bytes(), SYM_NAME_CAP);
        out.extend_from_slice(&sym.type_.to_le_bytes());
        out.extend_from_slice(&sym.module.to_le_bytes());
        out.extend_from_slice(&sym.line.to_le_bytes());
    }
    for edge in &tables.edges {
        out.extend_from_slice(&edge.caller.to_le_bytes());
        out.extend_from_slice(&edge.callee.to_le_bytes());
        out.extend_from_slice(&edge.line.to_le_bytes());
    }
    for syl in &tables.syls {
        push_fixed_str(&mut out, &syl.frag, FRAG_CAP);
        out.extend_from_slice(&syl.sym.to_le_bytes());
    }
    for tdr in &tables.tdrs {
        push_fixed_str(&mut out, tdr.name.as_bytes(), SYM_NAME_CAP);
        out.extend_from_slice(&tdr.type_.to_le_bytes());
        out.extend_from_slice(&tdr.module.to_le_bytes());
        out.extend_from_slice(&tdr.line.to_le_bytes());
    }
    for code in &tables.code {
        out.extend_from_slice(&code.sym.to_le_bytes());
        out.extend_from_slice(&code.module.to_le_bytes());
        out.extend_from_slice(&code.line.to_le_bytes());
        out.extend_from_slice(&code.is_def.to_le_bytes());
        out.extend_from_slice(&code.enc.to_le_bytes());
    }
    out
}

/// The syllable-index bytes: the `"TIX1"` header (version, count) and the syllable
/// entries sorted by `(frag, sym)` — an index, not a heap dump.
pub fn write_tix(tables: &AnaTables) -> Vec<u8> {
    let mut sorted = tables.syls.clone();
    sorted.sort_by(|a, b| a.frag.cmp(&b.frag).then(a.sym.cmp(&b.sym)));
    let mut out = Vec::new();
    out.extend_from_slice(b"TIX1");
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&(sorted.len() as u32).to_le_bytes());
    for syl in &sorted {
        push_fixed_str(&mut out, &syl.frag, FRAG_CAP);
        out.extend_from_slice(&syl.sym.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn syllables_follow_the_reference_rules() {
        // The reference README's own examples: HTMLParser -> html | parser,
        // ReadFileBuf -> read | file | buf.
        assert_eq!(
            split_syllables("HTMLParser"),
            [b"html".to_vec(), b"parser".to_vec()]
        );
        assert_eq!(
            split_syllables("ReadFileBuf"),
            [b"read".to_vec(), b"file".to_vec(), b"buf".to_vec()]
        );
        assert_eq!(
            split_syllables("pas_post_point"),
            [b"pas".to_vec(), b"post".to_vec(), b"point".to_vec()]
        );
        // A trailing digit/acronym run belongs to the fragment still open
        // (HTTP2xx -> http2xx); a digit starts its own run only at a fragment start
        // (draw2d keeps running, but 2draw splits).
        assert_eq!(split_syllables("HTTP2xx"), [b"http2xx".to_vec()]);
        assert_eq!(split_syllables("draw2d"), [b"draw2d".to_vec()]);
        assert_eq!(
            split_syllables("2draw"),
            [b"2".to_vec(), b"draw".to_vec()]
        );
        // At most sixteen fragments survive.
        let long = "a_a_a_a_a_a_a_a_a_a_a_a_a_a_a_a_z";
        assert_eq!(split_syllables(long).len(), 16);
        // Fragments lowercase and clamp at 63 bytes.
        let wide = "ABC".repeat(40);
        let frags = split_syllables(&wide);
        assert_eq!(frags.len(), 1);
        assert_eq!(frags[0].len(), 63);
        assert!(frags[0].iter().all(|b| b.is_ascii_lowercase()));
    }

    #[test]
    fn the_db_bytes_mirror_the_reference_record_layout() {
        // The exact widths of the reference record layout on x64: header 32, Module 264,
        // Symbol 144, CallEdge 12, SylEntry 68, TdrRec 140, SirCodeRec 20.
        let tables = AnaTables {
            mods: vec![AnaModule {
                name: "src/a.c".to_owned(),
                sym_count: 1,
            }],
            syms: vec![AnaSymbol {
                id: 0,
                name: "draw".to_owned(),
                type_: SYM_FUNCTION,
                module: 0,
                line: 12,
            }],
            edges: vec![AnaEdge {
                caller: 0,
                callee: 0,
                line: 14,
            }],
            syls: vec![AnaSyl {
                frag: b"draw".to_vec(),
                sym: 0,
            }],
            tdrs: vec![AnaTdr {
                name: "Shape".to_owned(),
                type_: SYM_STRUCT,
                module: 0,
                line: 3,
            }],
            code: vec![AnaCode {
                sym: 0,
                module: 0,
                line: 12,
                is_def: 1,
                enc: -1,
            }],
        };
        let bytes = write_db(&tables);
        assert_eq!(bytes.len(), 32 + 264 + 144 + 12 + 68 + 140 + 20);
        assert_eq!(&bytes[0..4], &DB_MAGIC.to_le_bytes());
        assert_eq!(&bytes[4..8], &3u32.to_le_bytes());
        assert_eq!(&bytes[8..12], &1i32.to_le_bytes()); // nmods
        assert_eq!(&bytes[32..36], b"src/"); // Module.name head
        assert_eq!(bytes[32 + 259], 0); // the name truncates one byte short
        // Symbol: id, name[128], type, mod, line.
        let sym_at = 32 + 264;
        assert_eq!(&bytes[sym_at..sym_at + 4], &0i32.to_le_bytes());
        assert_eq!(&bytes[sym_at + 4..sym_at + 8], b"draw");
        assert_eq!(&bytes[sym_at + 132..sym_at + 136], &SYM_FUNCTION.to_le_bytes());
        // The record's last field is the line.
        assert_eq!(&bytes[sym_at + 140..sym_at + 144], &12i32.to_le_bytes());
        // The tix sorts by (frag, sym) under the same 8-byte header.
        let tix = write_tix(&tables);
        assert_eq!(&tix[0..4], b"TIX1");
        assert_eq!(&tix[4..8], &1u32.to_le_bytes());
        assert_eq!(&tix[8..12], &1u32.to_le_bytes());
        assert_eq!(tix.len(), 12 + 68);
        assert_eq!(&tix[12..16], b"draw");
    }

    #[test]
    fn long_names_truncate_like_strncpy_into_a_zeroed_record() {
        let tables = AnaTables {
            mods: vec![AnaModule {
                name: "x".repeat(400),
                sym_count: 0,
            }],
            syms: vec![AnaSymbol {
                id: 0,
                name: "y".repeat(200),
                type_: 0,
                module: 0,
                line: 0,
            }],
            edges: vec![],
            syls: vec![],
            tdrs: vec![],
            code: vec![],
        };
        let bytes = write_db(&tables);
        assert_eq!(bytes.len(), 32 + 264 + 144);
        // The module name caps at 259 bytes; the symbol name at 127 (after its id field).
        assert_eq!(&bytes[32..35], b"xxx");
        assert_eq!(bytes[32 + 259], 0);
        assert!(bytes[32 + 268..32 + 264 + 4 + 127].iter().all(|&b| b == b'y'));
        assert_eq!(bytes[32 + 264 + 4 + 127], 0);
    }
}
