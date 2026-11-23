//! The `.sip_xab` / `.sip_xsb` index-volume generator, plus the `.sip_xad` / `.sip_xsd`
//! page directories they imply — `si4-rea`'s Wave3 generation model
//! (`sip-vol/MODEL-xab-generation.md`) ported from the Python prototype
//! (`xab-gen-work/gen_xab_xsb.py`; record-set agreement 99.64% xab / 95.89% xsb, key
//! agreement 99.64% / 99.91% against the reference snapshot).
//!
//! The model, condensed. There is **no bucket hash**: both volumes are key-ordered
//! paged sequential files (B-tree leaf-page shape) sorted by the byte-wise `c | 0x20`
//! fold. A page is a 256-record slice of the sorted record stream (16 B per record,
//! 4096 B per page); filling a page splits it; a deletion decrements the page's count
//! without clearing bytes, so live snapshots carry stale garbage past `count` and a
//! run of all-zero slots to the page's end. The directory (`MODEL` §5) carries one
//! 40 B entry per page whose `+0x14` field is the page's *valid record count* (the
//! "bucket" reading of Wave1 is dead — `MODEL` §0's IDA proof), the anchor record is
//! the page's first 16 bytes and the file offset is the page's own.
//!
//! Record sets, per symbol slot of a [`SymSlot`] table (`MODEL` §1):
//!
//! - **xsb** — exactly one record per symbol. The key token is chosen by the arm
//!   table of [`xsb_key_token`] (shadow/baseref rows their own name, Python module
//!   anchors the path's first segment, stub-chain / named-C++-class members the
//!   owning file's basename, other members the outermost scope ancestor, top-level
//!   symbols the own name); rows with `flags & 0x100` write the lowercase variant.
//!   `size = 0`, `flag31 = len(token) <= 4` (the *written token's* length, not the
//!   symbol name's).
//! - **xab** — one record per kept camel-split word (kind 22 shadow / 23 baseref rows
//!   produce none): kept token #i (0-based over the scope ancestors' words outermost
//!   first, then the own name's words) gets `size = 4 + 8*i` and
//!   `flag31 = len(word) <= 4`; a member (scope >= 0, kind outside {21, 22, 23, 42})
//!   appends one raw-name record `size = 2` after the word records.
//!
//! The key bytes ride the **dirty buffer** (`MODEL` §1.3): one shared 4-byte buffer
//! per volume, `min(len, 4)` bytes copied in, an explicit NUL at `[len]` when the
//! token is shorter than 4, everything beyond left as the previous write's tail. The
//! buffer resets at each file batch (the prototype's approximation of the reference parse
//! batches; `MODEL` §9.1 lists the residual).
//!
//! Clean-rebuild stream order (`MODEL` §3): xab by (folded token, folded own name,
//! slot, word index, raw record last), xsb by (folded key token, slot). The snapshot's
//! actual order interleaves per-file insertion batches on top of this — history, not
//! derivable from the sym table (57.2% / 89.0% of key groups reproduce; `MODEL` §3).
//!
//! The residuals the rules cannot reach ride the two exception tables below
//! (`MODEL` §6/§7: dirty-buffer batch-boundary state, stack-pointer fragments, the
//! degraded whole-file parse of a few Python/test/tool trees, the `dspm` flag
//! relicts of mat.cpp's re-parse era) — all of them the snapshot's incremental history,
//! values read off the reference snapshot. They apply only under
//! [`IndexGenOptions::reference_history`]; a clean rebuild of other data ignores them.

use std::collections::HashMap;

use super::projvol::{
    IndexRecord, SymSlot, XdirEntry, XdirVolume, INDEX_PAGE_SIZE, INDEX_REC_SIZE,
    INDEX_RECS_PER_PAGE,
};

/// The kind of a shadow row (a typedef's alternate identity): no xab records at all,
/// xsb keyed by the own name (`MODEL` §1.1/§1.2).
pub const SHADOW_KIND: u16 = 22;
/// The kind of a base-class reference row: no xab records, xsb keyed by the own name.
pub const BASEREF_KIND: u16 = 23;
/// The synthetic member kinds without a raw-name xab record (`MODEL` §1.1: 21 stub,
/// 22 shadow, 23 baseref, 42).
const NO_RAW_KINDS: [u16; 4] = [21, 22, 23, 42];
/// The scope-chain top kinds whose members key xsb by the owning file's basename
/// (`MODEL` §1.2: 21 class-implementation stub, 11 method, 36 property).
const FILE_KEY_CHAIN_KINDS: [u16; 3] = [21, 11, 36];
/// The kind of a C++ class; a *named* one (not the `{anon` spelling) keys its members
/// by the file basename too.
const CPP_CLASS_KIND: u16 = 10;
/// The anonymous-tag prefix that keeps a kind-10 chain in the ancestor-name arm.
const ANON_TAG_PREFIX: &[u8] = b"{anon}";
/// The Python module-anchor kind.
const PY_MODULE_KIND: u16 = 29;
/// The sym `flags` bit that switches the xsb key to its lowercase variant
/// (`MODEL` §1.2: typedef-group enum constants, shadows, anon tags).
pub const FLAGS_FOLD_KEY: u16 = 0x100;

/// The xab word record's size base and step: kept token #i carries `4 + 8*i`
/// (`MODEL` §1.1).
const WORD_SIZE_BASE: u32 = 4;
const WORD_SIZE_STEP: u32 = 8;
/// The raw-name record's size (`MODEL` §1.1).
const RAW_NAME_SIZE: u32 = 2;
/// The raw-name record's word index for the sort key (it sorts last for its key).
const RAW_NAME_WI: u16 = 99;
/// The clean-rebuild VM arena's linear base (`MODEL` §5: generated volumes allocate
/// linearly from `0x5410000`; the snapshot's segment bases and relocations are
/// allocator history).
pub const VM_BASE_DEFAULT: u32 = 0x0541_0000;

/* =====================================================================
 * Exception tables — snapshot incremental history, not rules. Every entry's
 * value was read off the reference snapshot (`si4-rea`'s sip-vol/snap);
 * each documents the update state the snapshot carries that a clean
 * rebuild cannot derive (MODEL-xab-generation §6/§7/§9). Applied only
 * under `IndexGenOptions::reference_history`.
 * ===================================================================== */

/// xab records whose 4-byte key is a dirty-buffer batch-boundary state the
/// prototype's per-file zeroing cannot reproduce (`MODEL` §9.1: 47 residual tails).
/// Keyed `(slot, size, flag)` — unique over the generated stream — to the key bytes
/// the snapshot carries; the override replaces the emitted key only and leaves the
/// buffer chain untouched.
const XAB_KEY_EXCEPTIONS: &[(u16, u32, bool, [u8; 4])] = &[
    (57, 4, true, *b"i2\x00k"),
    (154, 4, true, *b"bt\x00\x01"),
    (154, 12, true, *b"rx\x00\x01"),
    (266, 2, true, *b"en\x00\x00"),
    (924, 12, true, *b"cf\x00P"),
    (924, 4, true, *b"y1\x00P"),
    (925, 12, true, *b"cf\x00P"),
    (925, 4, true, *b"y2\x00P"),
    (981, 12, true, *b"cf\x00\x00"),
    (981, 4, true, *b"y1\x00\x00"),
    (982, 12, true, *b"cf\x00\x00"),
    (982, 4, true, *b"y2\x00\x00"),
    (983, 4, true, *b"cf\x00\x00"),
    (1080, 2, true, *b"N\x00s\x00"),
    (1156, 4, true, *b"cf\x00l"),
    (1165, 12, true, *b"cf\x00w"),
    (1165, 4, true, *b"y1\x00w"),
    (1166, 4, true, *b"cf\x00w"),
    (1327, 12, true, *b"cf\x00w"),
    (1327, 4, true, *b"y1\x00w"),
    (1328, 4, true, *b"cf\x00w"),
    (1380, 2, true, *b"im\x00a"),
    (1383, 2, true, *b"im\x00v"),
    (1399, 2, true, *b"im\x00a"),
    (1432, 2, true, *b"F\x00tm"),
    (1436, 2, true, *b"Km\x00t"),
    (1440, 2, true, *b"P\x00MX"),
    (1442, 2, true, *b"Q\x00oc"),
    (1924, 2, true, *b"t\x00ws"),
    (1999, 2, true, *b"x\x00dt"),
    (2008, 2, true, *b"t\x00ws"),
    (2778, 2, true, *b"k\x00\x00\x00"),
    (2817, 2, true, *b"h\x00ou"),
    (2819, 2, true, *b"oi\x00t"),
    (2823, 2, true, *b"xi\x00p"),
    (2828, 2, true, *b"D\x00p\x00"),
    (2834, 2, true, *b"wi\x00f"),
    (2918, 2, true, *b"c0\x00k"),
    (2927, 2, true, *b"t0\x00r"),
    (3159, 2, true, *b"tx\x00e"),
    (3166, 2, true, *b"ms\x00i"),
    (3167, 2, true, *b"n\x00\x00f"),
    (3201, 2, true, *b"np\x00n"),
    (3251, 2, true, *b"im\x00\x00"),
    (3279, 2, true, *b"at\x00u"),
    (3349, 2, true, *b"iq\x00c"),
    (3901, 2, true, *b"k\x00w\x00"),
];

/// xsb rows the rules cannot reach, keyed by slot (one xsb record per slot, so the
/// key is unambiguous). Each entry carries the full vocabulary the snapshot's row
/// holds — key bytes, `size` and the `flag31` bit — replacing the generated row's.
/// Three classes (`MODEL` §6, xsb act-only 176):
///
/// - 4 stack/heap-pointer fragments (`A\0\xd1\x08` shape — `MODEL` §9.2: the dirty
///   buffer's pre-batch content is unrecoverable from the data);
/// - 24 degraded whole-file parse rows (the ImgTo3D.py / test / tool trees keyed by
///   their path's first segment with the degraded `size = 1` parse-state marker);
/// - 148 `dspm` rows of mat.cpp's re-parse era: same key and size the rule derives,
///   but `flag31` clear — the era's written token was the >4-char scope spelling.
const XSB_ROW_EXCEPTIONS: &[(u16, [u8; 4], u32, bool)] = &[
    (1601, *b"comp", 1, false),
    (1606, *b"comp", 1, false),
    (1607, *b"comp", 1, false),
    (1608, *b"comp", 1, false),
    (1609, *b"comp", 1, false),
    (1610, *b"comp", 1, false),
    (1611, *b"comp", 1, false),
    (1612, *b"comp", 1, false),
    (1614, *b"comp", 1, false),
    (1615, *b"comp", 1, false),
    (1616, *b"comp", 1, false),
    (1617, *b"comp", 1, false),
    (1871, *b"dspm", 0, false),
    (1872, *b"dspm", 0, false),
    (1873, *b"dspm", 0, false),
    (1874, *b"dspm", 0, false),
    (1875, *b"dspm", 0, false),
    (1876, *b"dspm", 0, false),
    (1877, *b"dspm", 0, false),
    (1878, *b"dspm", 0, false),
    (1879, *b"dspm", 0, false),
    (1880, *b"dspm", 0, false),
    (1881, *b"dspm", 0, false),
    (1882, *b"dspm", 0, false),
    (1883, *b"dspm", 0, false),
    (1884, *b"dspm", 0, false),
    (1885, *b"dspm", 0, false),
    (1886, *b"dspm", 0, false),
    (1887, *b"dspm", 0, false),
    (1888, *b"dspm", 0, false),
    (1889, *b"dspm", 0, false),
    (1890, *b"dspm", 0, false),
    (1891, *b"dspm", 0, false),
    (1892, *b"dspm", 0, false),
    (1893, *b"dspm", 0, false),
    (1894, *b"dspm", 0, false),
    (1895, *b"dspm", 0, false),
    (1896, *b"dspm", 0, false),
    (1897, *b"dspm", 0, false),
    (1898, *b"dspm", 0, false),
    (1899, *b"dspm", 0, false),
    (1900, *b"dspm", 0, false),
    (1901, *b"dspm", 0, false),
    (1902, *b"dspm", 0, false),
    (1903, *b"dspm", 0, false),
    (1904, *b"dspm", 0, false),
    (1905, *b"dspm", 0, false),
    (1906, *b"dspm", 0, false),
    (1907, *b"dspm", 0, false),
    (1908, *b"dspm", 0, false),
    (1909, *b"dspm", 0, false),
    (1910, *b"dspm", 0, false),
    (1911, *b"dspm", 0, false),
    (1912, *b"dspm", 0, false),
    (1913, *b"dspm", 0, false),
    (1914, *b"dspm", 0, false),
    (1915, *b"dspm", 0, false),
    (1916, *b"dspm", 0, false),
    (1917, *b"dspm", 0, false),
    (1918, *b"dspm", 0, false),
    (1919, *b"dspm", 0, false),
    (1920, *b"dspm", 0, false),
    (1921, *b"dspm", 0, false),
    (1922, *b"dspm", 0, false),
    (1923, *b"dspm", 0, false),
    (1924, *b"dspm", 0, false),
    (1925, *b"dspm", 0, false),
    (1926, *b"dspm", 0, false),
    (1927, *b"dspm", 0, false),
    (1928, *b"dspm", 0, false),
    (1929, *b"dspm", 0, false),
    (1930, *b"dspm", 0, false),
    (1931, *b"dspm", 0, false),
    (1932, *b"dspm", 0, false),
    (1933, *b"dspm", 0, false),
    (1934, *b"dspm", 0, false),
    (1935, *b"dspm", 0, false),
    (1936, *b"dspm", 0, false),
    (1937, *b"dspm", 0, false),
    (1938, *b"dspm", 0, false),
    (1943, *b"dspm", 0, false),
    (1944, *b"dspm", 0, false),
    (1945, *b"dspm", 0, false),
    (1946, *b"dspm", 0, false),
    (1947, *b"dspm", 0, false),
    (1948, *b"dspm", 0, false),
    (1949, *b"dspm", 0, false),
    (1950, *b"dspm", 0, false),
    (1951, *b"dspm", 0, false),
    (1952, *b"dspm", 0, false),
    (1953, *b"dspm", 0, false),
    (1954, *b"dspm", 0, false),
    (1955, *b"dspm", 0, false),
    (1956, *b"dspm", 0, false),
    (1957, *b"dspm", 0, false),
    (1958, *b"dspm", 0, false),
    (1959, *b"dspm", 0, false),
    (1960, *b"dspm", 0, false),
    (1961, *b"dspm", 0, false),
    (1962, *b"dspm", 0, false),
    (1963, *b"dspm", 0, false),
    (1964, *b"dspm", 0, false),
    (1965, *b"dspm", 0, false),
    (1966, *b"dspm", 0, false),
    (1967, *b"dspm", 0, false),
    (1968, *b"dspm", 0, false),
    (1969, *b"dspm", 0, false),
    (1970, *b"dspm", 0, false),
    (1971, *b"dspm", 0, false),
    (1972, *b"dspm", 0, false),
    (1973, *b"dspm", 0, false),
    (1974, *b"dspm", 0, false),
    (1975, *b"dspm", 0, false),
    (1976, *b"dspm", 0, false),
    (1977, *b"dspm", 0, false),
    (1978, *b"dspm", 0, false),
    (1979, *b"dspm", 0, false),
    (1980, *b"dspm", 0, false),
    (1981, *b"dspm", 0, false),
    (1982, *b"dspm", 0, false),
    (1983, *b"dspm", 0, false),
    (1984, *b"dspm", 0, false),
    (1985, *b"dspm", 0, false),
    (1986, *b"dspm", 0, false),
    (1987, *b"dspm", 0, false),
    (1988, *b"dspm", 0, false),
    (1989, *b"dspm", 0, false),
    (1990, *b"dspm", 0, false),
    (1991, *b"dspm", 0, false),
    (1992, *b"dspm", 0, false),
    (1993, *b"dspm", 0, false),
    (1994, *b"dspm", 0, false),
    (1995, *b"dspm", 0, false),
    (1996, *b"dspm", 0, false),
    (1997, *b"dspm", 0, false),
    (1998, *b"dspm", 0, false),
    (1999, *b"dspm", 0, false),
    (2000, *b"dspm", 0, false),
    (2001, *b"dspm", 0, false),
    (2002, *b"dspm", 0, false),
    (2003, *b"dspm", 0, false),
    (2004, *b"dspm", 0, false),
    (2005, *b"dspm", 0, false),
    (2006, *b"dspm", 0, false),
    (2007, *b"dspm", 0, false),
    (2008, *b"dspm", 0, false),
    (2009, *b"dspm", 0, false),
    (2010, *b"dspm", 0, false),
    (2011, *b"dspm", 0, false),
    (2012, *b"dspm", 0, false),
    (2013, *b"dspm", 0, false),
    (2014, *b"dspm", 0, false),
    (2015, *b"dspm", 0, false),
    (2016, *b"dspm", 0, false),
    (2017, *b"dspm", 0, false),
    (2018, *b"dspm", 0, false),
    (2019, *b"dspm", 0, false),
    (2020, *b"dspm", 0, false),
    (2021, *b"dspm", 0, false),
    (2022, *b"dspm", 0, false),
    (3191, *b"tool", 1, false),
    (3192, *b"tool", 1, false),
    (3193, *b"tool", 1, false),
    (3194, *b"tool", 1, false),
    (3195, *b"tool", 1, false),
    (3196, *b"tool", 1, false),
    (3840, *b"test", 1, false),
    (3841, *b"test", 1, false),
    (3855, *b"test", 1, false),
    (3856, *b"test", 1, false),
    (3858, *b"test", 1, false),
    (3861, *b"test", 1, false),
    (3882, *b"d\x00\xd1\x08", 0, true),
    (3943, *b"A\x00\xd1\x08", 0, true),
    (3944, *b"B\x00\xd1\x08", 0, true),
    (3945, *b"C\x00\xd1\x08", 0, true),
];

/* =====================================================================
 * Options and the generated bundle
 * ===================================================================== */

/// The generator's knobs. The defaults produce the clean-rebuild conventions
/// (`MODEL` §5): a zeroed timestamp pair and the linear VM arena; the reference
/// snapshot's clock reads and segment bases are allocation state, passed in when a
/// byte-level reproduction is wanted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexGenOptions {
    /// The page directory's linear VM arena base.
    pub vm_base: u32,
    /// The directory head's first stamp (`XdirVolume::stamp1`).
    pub stamp1: u32,
    /// The directory head's second stamp (`XdirVolume::stamp2`).
    pub stamp2: u32,
    /// The footer's first stamp.
    pub footer_stamp1: u32,
    /// The footer's second stamp.
    pub footer_stamp2: u32,
    /// Applies [`XAB_KEY_EXCEPTIONS`] / [`XSB_ROW_EXCEPTIONS`] — the reference
    /// snapshot's incremental-history residuals. Off by default: a clean rebuild of
    /// other data must not inherit this snapshot's slot-keyed history.
    pub reference_history: bool,
}

impl Default for IndexGenOptions {
    fn default() -> Self {
        Self {
            vm_base: VM_BASE_DEFAULT,
            stamp1: 0,
            stamp2: 0,
            footer_stamp1: 0,
            footer_stamp2: 0,
            reference_history: false,
        }
    }
}

/// The four generated files: the two index volumes (whole 4096 B pages, trailing
/// zero slots included) and the two page directories ([`XdirVolume::emit`] bytes).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IndexVolumes {
    /// The word-prefix index volume (`.sip_xab`).
    pub xab: Vec<u8>,
    /// The name index volume (`.sip_xsb`).
    pub xsb: Vec<u8>,
    /// The xab's page directory (`.sip_xad`).
    pub xad: Vec<u8>,
    /// The xsb's page directory (`.sip_xsd`).
    pub xsd: Vec<u8>,
}

/* =====================================================================
 * Lexical helpers — the fold, the lowercase variant, the camel splitter
 * and the dirty buffer (MODEL §1.3 / §2)
 * ===================================================================== */

/// The sort/compare fold: every byte OR `0x20` (`MODEL` §0 — '_' 0x5F folds to 0x7F
/// past the letters, '@' 0x40 folds to 0x60 between ':' and 'a'; the same fold the
/// djb2 hash family at `sub_4493C0` uses).
pub fn fold(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().map(|&b| b | 0x20).collect()
}

/// The `flags & 0x100` key variant: `A`..`Z` shifted to lowercase, all else verbatim.
pub fn tolower_bytes(bytes: &[u8]) -> Vec<u8> {
    bytes
        .iter()
        .map(|&b| if b.is_ascii_uppercase() { b + 32 } else { b })
        .collect()
}

/// The shared 4-byte key buffer (`MODEL` §1.3): `min(len, 4)` bytes in, an explicit
/// NUL at `[len]` when the token is shorter than 4, the rest left as the previous
/// write's tail. One instance per volume; reset at each file batch.
#[derive(Clone, Debug)]
struct DirtyBuf([u8; 4]);

impl DirtyBuf {
    fn new() -> Self {
        Self([0; 4])
    }

    fn reset(&mut self) {
        self.0 = [0; 4];
    }

    fn write(&mut self, token: &[u8]) -> [u8; 4] {
        let head = token.len().min(4);
        self.0[..head].copy_from_slice(&token[..head]);
        if token.len() < 4 {
            self.0[token.len()] = 0;
        }
        self.0
    }
}

/// The camel splitter (`MODEL` §2, `xab-gen-work/model_xab.py: si_split`): separators
/// break; digit-led parts vanish entirely (no record, no word index); an upper run
/// followed by a lower run backs one character off the caps run (HTTPServer → HTTP +
/// Server) and trailing digits attach to the word (BMI270, C2, AW9523); a lower run
/// takes its trailing digits (fft2r → fft2); parts under two characters drop. ASCII
/// names only — the name byte is ASCII throughout the format.
pub fn si_split(name: &[u8]) -> Vec<Vec<u8>> {
    let mut parts: Vec<Vec<u8>> = Vec::new();
    let n = name.len();
    let mut i = 0;
    while i < n {
        let c = name[i];
        if !c.is_ascii_alphanumeric() {
            i += 1;
            continue;
        }
        if c.is_ascii_digit() {
            // digit-led part: dropped entirely
            while i < n && name[i].is_ascii_digit() {
                i += 1;
            }
            continue;
        }
        if c.is_ascii_uppercase() {
            let mut j = i;
            while j < n && name[j].is_ascii_uppercase() {
                j += 1;
            }
            if j < n && name[j].is_ascii_lowercase() {
                // U + L word: the caps run minus its last character is its own part
                if j - 1 > i {
                    let cand = &name[i..j - 1];
                    if cand.len() >= 2 {
                        parts.push(cand.to_vec());
                    }
                    i = j - 1;
                }
                let mut k = j;
                while k < n && name[k].is_ascii_lowercase() {
                    k += 1;
                }
                while k < n && name[k].is_ascii_digit() {
                    k += 1;
                }
                let cand = &name[i..k];
                if cand.len() >= 2 {
                    parts.push(cand.to_vec());
                }
                i = k;
            } else {
                // caps run + trailing digits
                let mut k = j;
                while k < n && name[k].is_ascii_digit() {
                    k += 1;
                }
                let cand = &name[i..k];
                if cand.len() >= 2 {
                    parts.push(cand.to_vec());
                }
                i = k;
            }
            continue;
        }
        // lower run + trailing digits
        let mut j = i;
        while j < n && name[j].is_ascii_lowercase() {
            j += 1;
        }
        while j < n && name[j].is_ascii_digit() {
            j += 1;
        }
        let cand = &name[i..j];
        if cand.len() >= 2 {
            parts.push(cand.to_vec());
        }
        i = j;
    }
    parts
}

/* =====================================================================
 * Scope chains and the xsb key-token arm table (MODEL §1.2)
 * ===================================================================== */

/// The symbol's same-table scope chain, innermost first (`+124` links; cycle-guarded).
fn scope_chain(sym: &[SymSlot], slot: usize) -> Vec<usize> {
    let mut chain = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut p = sym[slot].scope;
    while p >= 0 {
        let idx = p as usize;
        if idx >= sym.len() || !seen.insert(idx) {
            break;
        }
        chain.push(idx);
        p = sym[idx].scope;
    }
    chain
}

/// The path's first (`last == false`) or last segment, split on either separator
/// (Python's `re.split(r'[\\/]+', file)` head / tail).
fn path_segment(path: &[u8], last: bool) -> &[u8] {
    let cut = if last {
        path.iter().rposition(|&b| b == b'\\' || b == b'/')
    } else {
        path.iter().position(|&b| b == b'\\' || b == b'/')
    };
    match cut {
        Some(at) if last => &path[at + 1..],
        Some(at) => &path[..at],
        None => path,
    }
}

/// The `.py` suffix test (case-insensitive, `MODEL` §1.2's module-anchor arm).
fn ends_with_py(path: &[u8]) -> bool {
    path.len() >= 3
        && path[path.len() - 3..]
            .iter()
            .zip(b".py")
            .all(|(a, b)| a.eq_ignore_ascii_case(b))
}

/// The xsb key token for one symbol slot — the arm table of `MODEL` §1.2, in the
/// table's own precedence order: shadow/baseref rows their own name; a Python module
/// anchor the owning path's first segment; a member whose scope-chain top is a stub
/// chain (kinds 21/11/36) or a *named* C++ class the owning file's basename (with
/// extension); any other member the outermost scope ancestor's name; a top-level
/// symbol its own name. Rows with `flags & 0x100` return the lowercase variant.
/// `files` is the `.siproj` path table indexed by the record's `file_id`.
pub fn xsb_key_token(sym: &[SymSlot], slot: usize, files: &[&[u8]]) -> Vec<u8> {
    let s = &sym[slot];
    let name = &s.name;
    let path: &[u8] = files.get(s.file_id as usize).copied().unwrap_or(&[]);
    let chain = scope_chain(sym, slot);
    let top = chain.last().copied();
    let raw = if s.kind == SHADOW_KIND || s.kind == BASEREF_KIND {
        name.clone()
    } else if s.kind == PY_MODULE_KIND && ends_with_py(path) {
        path_segment(path, false).to_vec()
    } else if let Some(top) = top {
        let top_kind = sym[top].kind;
        if FILE_KEY_CHAIN_KINDS.contains(&top_kind)
            || (top_kind == CPP_CLASS_KIND && !sym[top].name.starts_with(ANON_TAG_PREFIX))
        {
            path_segment(path, true).to_vec()
        } else {
            sym[top].name.clone()
        }
    } else {
        name.clone()
    };
    if s.flags & FLAGS_FOLD_KEY != 0 {
        tolower_bytes(&raw)
    } else {
        raw
    }
}

/* =====================================================================
 * Stream generation and the clean-rebuild order (MODEL §1 / §3)
 * ===================================================================== */

/// The xab stream's sort key: folded token, folded own name, slot, word index, raw
/// record last (`MODEL` §3).
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct XabSortKey {
    tok: Vec<u8>,
    name: Vec<u8>,
    slot: u16,
    raw_last: u8,
    wi: u16,
}

/// The xsb stream's sort key: folded key token, slot (`MODEL` §3).
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct XsbSortKey {
    token: Vec<u8>,
    slot: u16,
}

/// Generates both record streams in the clean-rebuild order: `(xab, xsb)`. This is
/// the record layer of [`from_sym_records_with`] — the pages and directories are
/// assembled from it by [`build_index_volume`] / [`build_index_directory`].
pub fn gen_index_streams(
    sym: &[SymSlot],
    files: &[&[u8]],
    options: &IndexGenOptions,
) -> (Vec<IndexRecord>, Vec<IndexRecord>) {
    let xab_exceptions: HashMap<(u16, u32, bool), [u8; 4]> = XAB_KEY_EXCEPTIONS
        .iter()
        .map(|&(slot, size, flag, key)| ((slot, size, flag), key))
        .collect();
    let xsb_exceptions: HashMap<u16, ([u8; 4], u32, bool)> = XSB_ROW_EXCEPTIONS
        .iter()
        .map(|&(slot, key, size, flag)| (slot, (key, size, flag)))
        .collect();

    let mut abuf = DirtyBuf::new();
    let mut xbuf = DirtyBuf::new();
    let mut prev_path: Option<&[u8]> = None;
    let mut xab: Vec<(XabSortKey, IndexRecord)> = Vec::new();
    let mut xsb: Vec<(XsbSortKey, IndexRecord)> = Vec::new();

    // The volume's slot field is u16; a table beyond 65 536 slots is outside the
    // format's own addressing.
    let count = sym.len().min(usize::from(u16::MAX) + 1);
    for slot in 0..count {
        let s = &sym[slot];
        let path: &[u8] = files.get(s.file_id as usize).copied().unwrap_or(&[]);
        if prev_path == Some(path) {
            // same file batch: the buffer chains continue
        } else if prev_path.is_some() {
            abuf.reset();
            xbuf.reset();
        }
        prev_path = Some(path);

        // ---- xsb: one record per symbol (written before the xab exclusion) ----
        let token = xsb_key_token(sym, slot, files);
        let mut key = xbuf.write(&token);
        let mut size = 0u32;
        let mut flag = token.len() <= 4;
        if options.reference_history {
            if let Some(&(ekey, esize, eflag)) = xsb_exceptions.get(&(slot as u16)) {
                key = ekey;
                size = esize;
                flag = eflag;
            }
        }
        xsb.push((
            XsbSortKey {
                token: fold(&token),
                slot: slot as u16,
            },
            IndexRecord::from_sym(slot as u16, s, key, size | ((flag as u32) << 31)),
        ));

        // kind 22 shadow / 23 baseref rows produce no xab records at all
        if s.kind == SHADOW_KIND || s.kind == BASEREF_KIND {
            continue;
        }

        // ---- xab: the scope ancestors' words outermost first, then the own name's ----
        let chain = scope_chain(sym, slot);
        let mut tokens: Vec<Vec<u8>> = Vec::new();
        for ancestor in chain.iter().rev() {
            tokens.extend(si_split(&sym[*ancestor].name));
        }
        tokens.extend(si_split(&s.name));
        let kept: Vec<&Vec<u8>> = tokens.iter().filter(|t| t.len() >= 2).collect();
        let fname = fold(&s.name);
        for (i, token) in kept.iter().enumerate() {
            let size = WORD_SIZE_BASE + WORD_SIZE_STEP * i as u32;
            let flag = token.len() <= 4;
            let mut key = abuf.write(token);
            if options.reference_history {
                if let Some(&ekey) = xab_exceptions.get(&(slot as u16, size, flag)) {
                    key = ekey;
                }
            }
            xab.push((
                XabSortKey {
                    tok: fold(token),
                    name: fname.clone(),
                    slot: slot as u16,
                    raw_last: 0,
                    wi: i as u16,
                },
                IndexRecord::from_sym(slot as u16, s, key, size | ((flag as u32) << 31)),
            ));
        }
        // the raw-name record: members only, after the word records
        if s.scope >= 0 && !NO_RAW_KINDS.contains(&s.kind) {
            let flag = s.name.len() <= 4;
            let mut key = abuf.write(&s.name);
            if options.reference_history {
                if let Some(&ekey) = xab_exceptions.get(&(slot as u16, RAW_NAME_SIZE, flag)) {
                    key = ekey;
                }
            }
            xab.push((
                XabSortKey {
                    tok: fold(&s.name),
                    name: fname,
                    slot: slot as u16,
                    raw_last: 1,
                    wi: RAW_NAME_WI,
                },
                IndexRecord::from_sym(
                    slot as u16,
                    s,
                    key,
                    RAW_NAME_SIZE | ((flag as u32) << 31),
                ),
            ));
        }
    }

    xab.sort_by(|a, b| a.0.cmp(&b.0));
    xsb.sort_by(|a, b| a.0.cmp(&b.0));
    (
        xab.into_iter().map(|(_, r)| r).collect(),
        xsb.into_iter().map(|(_, r)| r).collect(),
    )
}

/* =====================================================================
 * Page and directory assembly (MODEL §4 / §5)
 * ===================================================================== */

/// The page count of a record stream.
fn page_count(records: usize) -> usize {
    records.div_ceil(INDEX_RECS_PER_PAGE)
}

/// Emits the whole index volume: 256-record pages, every page zero-filled past the
/// stream's tail slice (`MODEL` §4's empty-slot model — clean rebuilds carry no
/// stale bytes).
pub fn build_index_volume(stream: &[IndexRecord]) -> Vec<u8> {
    let mut out = vec![0u8; page_count(stream.len()) * INDEX_PAGE_SIZE];
    for (i, record) in stream.iter().enumerate() {
        let at = i * INDEX_REC_SIZE;
        out[at..at + INDEX_REC_SIZE].copy_from_slice(&record.encode());
    }
    out
}

/// Assembles the page directory of a record stream: one entry per page whose anchor
/// is the page's first record, whose count field is the page's valid-record count
/// (the `+0x14` semantics, `MODEL` §0) and whose file offset is the page's own; the
/// VM addresses run linearly from the options' base (`MODEL` §5's clean-rebuild
/// convention — the snapshot's segments and relocations are allocator history).
pub fn build_index_directory(stream: &[IndexRecord], options: &IndexGenOptions) -> XdirVolume {
    let pages = page_count(stream.len());
    let mut entries = Vec::with_capacity(pages);
    for page in 0..pages {
        let base = page * INDEX_RECS_PER_PAGE;
        let count = (stream.len() - base).min(INDEX_RECS_PER_PAGE);
        entries.push(XdirEntry {
            record: stream[base],
            bucket: count as u32,
            vm_addr: options.vm_base + (page * INDEX_PAGE_SIZE) as u32,
            file_offset: (page * INDEX_PAGE_SIZE) as u32,
        });
    }
    XdirVolume {
        bucket_space: 256,
        pages_used: pages as u32,
        pages_capacity: 500,
        stamp1: options.stamp1,
        stamp2: options.stamp2,
        entries,
        footer: [
            0,
            1000,
            4,
            500,
            options.footer_stamp1,
            options.footer_stamp2,
            0,
        ],
    }
}

/// The full generation entry point: a sym record table plus its `.siproj` path table
/// (indexed by `file_id`) produce the four index files. The defaults are the
/// clean-rebuild conventions; pass [`IndexGenOptions::reference_history`] to apply
/// the reference snapshot's exception tables.
pub fn from_sym_records_with(
    sym: &[SymSlot],
    files: &[&[u8]],
    options: &IndexGenOptions,
) -> IndexVolumes {
    let (xab, xsb) = gen_index_streams(sym, files, options);
    IndexVolumes {
        xab: build_index_volume(&xab),
        xsb: build_index_volume(&xsb),
        xad: build_index_directory(&xab, options).emit(),
        xsd: build_index_directory(&xsb, options).emit(),
    }
}

/// [`from_sym_records_with`] under the default (clean-rebuild) options.
pub fn from_sym_records(sym: &[SymSlot], files: &[&[u8]]) -> IndexVolumes {
    from_sym_records_with(sym, files, &IndexGenOptions::default())
}

/* =====================================================================
 * Tests
 * ===================================================================== */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::symbols::projvol::{
        parse_index_volume, parse_siproj_volume, parse_sym_volume, XDIR_PAGES_CAPACITY,
    };
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    /* ---------- the reference snapshot (the projvol.rs conventions) ---------- */

    fn snap_dir() -> Option<PathBuf> {
        let dir = match std::env::var_os("GGS_REF_SNAP_DIR") {
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
             (set GGS_REF_SNAP_DIR to its sip-vol/snap directory)"
        );
    }

    fn snap_volume(name: &str) -> Option<Vec<u8>> {
        std::fs::read(snap_dir()?.join(name)).ok()
    }

    /// The snapshot's sym table plus its path table (the `from_sym_records` inputs).
    fn snap_inputs() -> Option<(Vec<SymSlot>, Vec<Vec<u8>>)> {
        let sym = parse_sym_volume(&snap_volume("Untitled Project2.sip_sym")?).expect("sym parses")
            .records;
        let siproj =
            parse_siproj_volume(&snap_volume("Untitled Project2.siproj")?).expect("siproj parses");
        let files = siproj
            .records
            .iter()
            .map(|r| r.path.clone())
            .collect::<Vec<_>>();
        Some((sym, files))
    }

    fn files_refs(files: &[Vec<u8>]) -> Vec<&[u8]> {
        files.iter().map(|p| p.as_slice()).collect()
    }

    /// The snapshot volume's live records through its own directory: the `count`
    /// records of every page are the valid ones, any nonzero record past `count` is
    /// stale garbage (`MODEL` §4).
    fn snap_active(volume: &[u8], dir: &[u8]) -> (Vec<IndexRecord>, Vec<IndexRecord>) {
        let parsed = XdirVolume::parse(dir).expect("directory parses");
        let records = parse_index_volume(volume).expect("index volume parses");
        let mut valid = Vec::new();
        let mut stale = Vec::new();
        for entry in &parsed.entries {
            let base = (entry.file_offset as usize / INDEX_PAGE_SIZE) * INDEX_RECS_PER_PAGE;
            for j in 0..INDEX_RECS_PER_PAGE {
                let record = records[base + j];
                if j < entry.bucket as usize {
                    valid.push(record);
                } else if record != IndexRecord::default() {
                    stale.push(record);
                }
            }
        }
        (valid, stale)
    }

    /// The `(slot, size-with-flag, key)` multiset over a record list.
    fn multiset(records: &[IndexRecord]) -> BTreeMap<(u16, u32, [u8; 4]), i64> {
        let mut map = BTreeMap::new();
        for r in records {
            *map.entry((r.slot, r.size, r.key)).or_insert(0i64) += 1;
        }
        map
    }

    /// The `(slot, key)` multiset — the key-derivation layer (sizes ignored).
    fn key_multiset(records: &[IndexRecord]) -> BTreeMap<(u16, [u8; 4]), i64> {
        let mut map = BTreeMap::new();
        for r in records {
            *map.entry((r.slot, r.key)).or_insert(0i64) += 1;
        }
        map
    }

    fn multiset_diff(
        gen: &BTreeMap<(u16, u32, [u8; 4]), i64>,
        act: &BTreeMap<(u16, u32, [u8; 4]), i64>,
    ) -> (i64, i64, i64) {
        let exact: i64 = gen
            .iter()
            .map(|(k, &g)| g.min(*act.get(k).unwrap_or(&0)))
            .sum();
        let gen_only: i64 = gen.values().sum::<i64>() - exact;
        let act_only: i64 = act.values().sum::<i64>() - exact;
        (exact, gen_only, act_only)
    }

    /* ---------- the lexical layer ---------- */

    #[test]
    fn si_split_follows_the_model_examples() {
        // MODEL-xab-generation §2's fitted examples.
        let split = |s: &[u8]| -> Vec<String> {
            si_split(s)
                .into_iter()
                .map(|p| String::from_utf8(p).unwrap())
                .collect()
        };
        assert_eq!(split(b"Image3DMatrix"), ["Image3", "Matrix"]);
        assert_eq!(split(b"ImgTo3D"), ["Img", "To3"]); // the trailing D drops
        assert_eq!(split(b"HTTPServer"), ["HTTP", "Server"]); // backup-one rule
        assert_eq!(split(b"BMI270"), ["BMI270"]); // trailing digits attach
        assert_eq!(split(b"fft2r"), ["fft2"]); // the trailing r drops
        assert_eq!(split(b"AW9523"), ["AW9523"]);
        assert!(split(b"3D").is_empty()); // digit-led part dropped
        assert!(split(b"A").is_empty()); // single character dropped
        assert_eq!(split(b"ImgTo3D_matrix"), ["Img", "To3", "matrix"]);
        assert_eq!(split(b"si_split_x"), ["si", "split"]); // separators break
    }

    #[test]
    fn the_dirty_buffer_writes_the_documented_tails() {
        // MODEL §1.3's examples: the NUL lands at [len], the rest keeps the
        // previous write's tail.
        let mut buf = DirtyBuf::new();
        assert_eq!(buf.write(b"fail"), *b"fail");
        assert_eq!(buf.write(b"at"), *b"at\x00l"); // 'fail' tail
        buf.reset();
        assert_eq!(buf.write(b"at"), *b"at\x00\x00");
        let mut buf = DirtyBuf::new();
        assert_eq!(buf.write(b"retirement"), *b"reti");
        assert_eq!(buf.write(b"at"), *b"at\x00i");
        buf.reset();
        assert_eq!(buf.write(b"stats"), *b"stat");
        assert_eq!(buf.write(b"at"), *b"at\x00t");
        // a >= 4-char token writes all four bytes, no NUL
        assert_eq!(buf.write(b"atlas"), *b"atla");
    }

    #[test]
    fn the_fold_and_tolower_helpers_match_the_model() {
        assert_eq!(fold(b"aZ_9"), *b"az\x7f9"); // '_' folds to 0x7f past letters
        assert_eq!(fold(b"@:"), *b"`:"); // '@' 0x40 folds to 0x60
        assert_eq!(tolower_bytes(b"AUDIO_BASS"), *b"audio_bass");
        assert_eq!(tolower_bytes(b"at\0l"), *b"at\0l");
    }

    /* ---------- the xsb key-token arms ---------- */

    #[test]
    fn xsb_key_tokens_follow_the_documented_arms() {
        let Some((sym, files)) = snap_inputs() else {
            skip_note();
            return;
        };
        let files = files_refs(&files);
        // token #0 of every stream is the first slot's; check the arm table on
        // snapshot anchors instead: slot 3943 ('A', top-level, test_mmult.c) and
        // slot 1601 (converted_img_dir, the ImgTo3D.py module anchor).
        assert_eq!(xsb_key_token(&sym, 3943, &files), b"A");
        assert_eq!(xsb_key_token(&sym, 1601, &files), b"components");
        // the flags-256 rows write the lowercase variant: every kind-22 shadow row
        // with the bit set must equal the lowercased own name
        let folded = sym
            .iter()
            .enumerate()
            .filter(|(_, s)| s.kind == SHADOW_KIND && s.flags & FLAGS_FOLD_KEY != 0)
            .filter(|&(slot, _)| xsb_key_token(&sym, slot, &files) == tolower_bytes(&sym[slot].name))
            .count();
        let total = sym
            .iter()
            .filter(|s| s.kind == SHADOW_KIND && s.flags & FLAGS_FOLD_KEY != 0)
            .count();
        assert_eq!(folded, total, "every flagged shadow row folds its key token");
        // the volume format's own flag31: the written token's length, not the
        // name's — slot 1601's token is 10 chars (flag 0) while its name is
        // 17 chars, and both exceed 4 either way; assert the discriminator pair:
        // a name over 4 chars with a token at most 4.
        let short_token_long_name = sym
            .iter()
            .enumerate()
            .any(|(slot, s)| s.name.len() > 4 && xsb_key_token(&sym, slot, &files).len() <= 4);
        assert!(short_token_long_name, "flag31 keys off the token, not the name");
    }

    /* ---------- the record-set acceptance (the model's headline numbers) ---------- */

    /// The snapshot's sym table drives the generator; the generated streams compare
    /// against the snapshot's valid records (directory counts) at the record-set and
    /// key-derivation layers. Expectations = the Python prototype's quantification
    /// (`MODEL` §6): xab 12912/12959 exact (99.64%), 47 act-only (dirty tails), 836
    /// gen-only (instance-selection history); xsb 4104/4280 exact (95.89%), 4
    /// key-level misses (stack fragments). The exception tables close the act side
    /// to zero (and xsb to an exact multiset).
    #[test]
    fn indexgen_reproduces_the_snapshot_record_sets() {
        let Some((sym, files)) = snap_inputs() else {
            skip_note();
            return;
        };
        let files = files_refs(&files);
        let Some(act_xab_vol) = snap_volume("Untitled Project2.sip_xab") else {
            skip_note();
            return;
        };
        let Some(act_xsb_vol) = snap_volume("Untitled Project2.sip_xsb") else {
            skip_note();
            return;
        };
        let act_xad = snap_volume("Untitled Project2.sip_xad").expect("xad present");
        let act_xsd = snap_volume("Untitled Project2.sip_xsd").expect("xsd present");
        let (act_xab, _) = snap_active(&act_xab_vol, &act_xad);
        let (act_xsb, _) = snap_active(&act_xsb_vol, &act_xsd);
        assert_eq!(act_xab.len(), 12959, "xab valid records (sum of counts)");
        assert_eq!(act_xsb.len(), 4280, "xsb valid records (one per symbol)");

        // ---- rules only (clean rebuild) ----
        let (gen_xab, gen_xsb) = gen_index_streams(&sym, &files, &IndexGenOptions::default());
        assert_eq!(gen_xab.len(), 13748, "xab stream (the prototype's count)");
        assert_eq!(gen_xsb.len(), 4280, "xsb stream (one per symbol)");

        let (exact, gen_only, act_only) = multiset_diff(&multiset(&gen_xab), &multiset(&act_xab));
        eprintln!(
            "[xab rules] record set: exact {exact}/{} ({:.2}%), gen-only {gen_only}, act-only {act_only}",
            act_xab.len(),
            100.0 * exact as f64 / act_xab.len() as f64
        );
        assert_eq!(exact, 12912, "xab exact record-set match");
        assert_eq!(gen_only, 836, "xab gen-only (instance-selection history)");
        assert_eq!(act_only, 47, "xab act-only (dirty-buffer batch boundaries)");
        let gkeys = key_multiset(&gen_xab);
        let akeys = key_multiset(&act_xab);
        let key_exact: i64 = gkeys
            .iter()
            .map(|(k, &g)| g.min(*akeys.get(k).unwrap_or(&0)))
            .sum();
        eprintln!(
            "[xab rules] key layer: {key_exact}/{} ({:.2}%)",
            act_xab.len(),
            100.0 * key_exact as f64 / act_xab.len() as f64
        );
        assert_eq!(key_exact, 12912, "xab key-level match");

        let (exact, gen_only, act_only) = multiset_diff(&multiset(&gen_xsb), &multiset(&act_xsb));
        eprintln!(
            "[xsb rules] record set: exact {exact}/{} ({:.2}%), gen-only {gen_only}, act-only {act_only}",
            act_xsb.len(),
            100.0 * exact as f64 / act_xsb.len() as f64
        );
        assert_eq!(exact, 4104, "xsb exact record-set match");
        assert_eq!(gen_only, 176, "xsb gen-only");
        assert_eq!(act_only, 176, "xsb act-only (stack fragments + parse-state history)");
        let gkey_set: std::collections::HashSet<(u16, [u8; 4])> =
            gen_xsb.iter().map(|r| (r.slot, r.key)).collect();
        let key_misses = act_xsb
            .iter()
            .filter(|r| !gkey_set.contains(&(r.slot, r.key)))
            .count();
        eprintln!(
            "[xsb rules] key layer: {}/{} ({:.2}%)",
            act_xsb.len() - key_misses,
            act_xsb.len(),
            100.0 * (act_xsb.len() - key_misses) as f64 / act_xsb.len() as f64
        );
        assert_eq!(key_misses, 4, "xsb key-level misses (the stack fragments)");

        // ---- with the reference-history exceptions ----
        let history = IndexGenOptions {
            reference_history: true,
            ..IndexGenOptions::default()
        };
        let (gen_xab_h, gen_xsb_h) = gen_index_streams(&sym, &files, &history);
        let (_, _, act_only_h) = multiset_diff(&multiset(&gen_xab_h), &multiset(&act_xab));
        assert_eq!(act_only_h, 0, "xab act-only closes under the exception table");
        let (exact_h, gen_only_h, act_only_h) =
            multiset_diff(&multiset(&gen_xsb_h), &multiset(&act_xsb));
        eprintln!(
            "[xsb + exceptions] record set: exact {exact_h}/{}, gen-only {gen_only_h}, act-only {act_only_h}",
            act_xsb.len()
        );
        assert_eq!(exact_h, 4280, "xsb multiset closes to an exact match");
        assert_eq!((gen_only_h, act_only_h), (0, 0));
    }

    /* ---------- the page / directory layer ---------- */

    /// The snapshot's page facts (`MODEL` §4) and the generated volumes' clean-rebuild
    /// page facts: empty slots only past `count`, stale bytes enumerated, page counts
    /// 54/17 against the snapshot's history-heavy 74/24.
    #[test]
    fn indexgen_page_layer_matches_the_model() {
        let Some((sym, files)) = snap_inputs() else {
            skip_note();
            return;
        };
        let files = files_refs(&files);
        let act_xab = snap_volume("Untitled Project2.sip_xab").expect("xab present");
        let act_xsb = snap_volume("Untitled Project2.sip_xsb").expect("xsb present");
        let act_xad = snap_volume("Untitled Project2.sip_xad").expect("xad present");
        let act_xsd = snap_volume("Untitled Project2.sip_xsd").expect("xsd present");

        // snapshot facts
        let xad = XdirVolume::parse(&act_xad).expect("xad parses");
        let xsd = XdirVolume::parse(&act_xsd).expect("xsd parses");
        assert_eq!((xad.entries.len(), xsd.entries.len()), (74, 24));
        assert_eq!(xad.pages_capacity, XDIR_PAGES_CAPACITY);
        assert_eq!(xad.bucket_space, 256);
        for (dir, volume, expect_valid, expect_stale) in [
            (&xad, &act_xab, 12959usize, 156usize),
            (&xsd, &act_xsb, 4280, 32),
        ] {
            let records = parse_index_volume(volume).expect("index volume parses");
            let mut valid = 0usize;
            let mut stale = 0usize;
            let mut empty = 0usize;
            let mut violations = 0usize;
            for entry in &dir.entries {
                let base = (entry.file_offset as usize / INDEX_PAGE_SIZE) * INDEX_RECS_PER_PAGE;
                for j in 0..INDEX_RECS_PER_PAGE {
                    let record = &records[base + j];
                    if j < entry.bucket as usize {
                        valid += 1;
                        if *record == IndexRecord::default() {
                            violations += 1;
                        }
                    } else if *record == IndexRecord::default() {
                        empty += 1;
                    } else {
                        stale += 1;
                    }
                }
            }
            eprintln!(
                "[snapshot] valid {valid}, stale {stale}, empty {empty}, zero-inside-count {violations}"
            );
            assert_eq!(valid, expect_valid, "sum of counts");
            assert_eq!(stale, expect_stale, "stale records past count");
            assert_eq!(violations, 0, "no all-zero record inside any count (MODEL §4)");
            assert_eq!(
                empty,
                records.len() - valid - stale,
                "every non-count slot is either zero (empty) or stale"
            );
        }

        // generated volumes: the clean-rebuild page layer
        let volumes = from_sym_records(&sym, &files);
        let gen_xab = parse_index_volume(&volumes.xab).expect("generated xab parses");
        let gen_xsb = parse_index_volume(&volumes.xsb).expect("generated xsb parses");
        assert_eq!(gen_xab.len(), 54 * INDEX_RECS_PER_PAGE, "xab slots (54 pages)");
        assert_eq!(gen_xsb.len(), 17 * INDEX_RECS_PER_PAGE, "xsb slots (17 pages)");
        // the streams' live counts (a generated record is never all-zero — the
        // snapshot's own zero-inside-count check above holds for the rules too)
        let live_xab = gen_xab.iter().filter(|r| **r != IndexRecord::default()).count();
        let live_xsb = gen_xsb.iter().filter(|r| **r != IndexRecord::default()).count();
        assert_eq!(live_xab, 13748, "xab live records (the prototype's count)");
        assert_eq!(live_xsb, 4280);
        let gen_xad = XdirVolume::parse(&volumes.xad).expect("generated xad parses");
        let gen_xsd = XdirVolume::parse(&volumes.xsd).expect("generated xsd parses");
        assert_eq!((gen_xad.entries.len(), gen_xsd.entries.len()), (54, 17));
        for (dir, bytes, records, live) in [
            (&gen_xad, volumes.xad.as_slice(), gen_xab.as_slice(), live_xab),
            (&gen_xsd, volumes.xsd.as_slice(), gen_xsb.as_slice(), live_xsb),
        ] {
            let mut sum = 0usize;
            for (page, entry) in dir.entries.iter().enumerate() {
                assert_eq!(
                    entry.bucket as usize,
                    (live - page * INDEX_RECS_PER_PAGE).min(INDEX_RECS_PER_PAGE),
                    "count"
                );
                assert_eq!(
                    entry.record.encode()[..],
                    records[page * INDEX_RECS_PER_PAGE].encode()[..],
                    "anchor == page's first record"
                );
                assert_eq!(entry.file_offset, (page * INDEX_PAGE_SIZE) as u32);
                sum += entry.bucket as usize;
                // every slot past the page's count is the all-zero spare
                let base = page * INDEX_RECS_PER_PAGE;
                for j in entry.bucket as usize..INDEX_RECS_PER_PAGE {
                    assert_eq!(records[base + j], IndexRecord::default(), "zero past count");
                }
            }
            assert_eq!(sum, live, "sum of counts == the stream");
            // the directory round-trips byte for byte through the container parser
            assert_eq!(dir.emit(), bytes, "directory emits its own parse");
        }
    }

    /* ---------- the whole-file byte comparison (layered) ---------- */

    /// The four generated files against the snapshot's four: byte equality is the
    /// history question, so the test prints the layered account — sizes, page
    /// counts, record-set overlap, stale bytes, empty slots, and the directory
    /// entries' per-field agreement — and asserts the structural identity of the
    /// generated side plus the documented inequality of the whole files.
    #[test]
    fn indexgen_volume_bytes_report_against_the_snapshot() {
        let Some((sym, files)) = snap_inputs() else {
            skip_note();
            return;
        };
        let files = files_refs(&files);
        let names = [
            ("Untitled Project2.sip_xab", "Untitled Project2.sip_xad"),
            ("Untitled Project2.sip_xsb", "Untitled Project2.sip_xsd"),
        ];
        let act: Vec<(Vec<u8>, Vec<u8>)> = names
            .iter()
            .map(|(v, d)| {
                (
                    snap_volume(v).expect("index volume present"),
                    snap_volume(d).expect("directory present"),
                )
            })
            .collect();
        let volumes = from_sym_records(&sym, &files);
        let gen: Vec<(Vec<u8>, Vec<u8>)> = vec![
            (volumes.xab, volumes.xad),
            (volumes.xsb, volumes.xsd),
        ];

        for (tag, (gv, gd), (av, ad)) in
            [("xab", &gen[0], &act[0]), ("xsb", &gen[1], &act[1])]
        {
            let gpages = gv.len() / INDEX_PAGE_SIZE;
            let apages = av.len() / INDEX_PAGE_SIZE;
            // whole-file byte diff over the aligned prefix
            let shared = gv.len().min(av.len());
            let byte_diffs = gv[..shared]
                .iter()
                .zip(av[..shared].iter())
                .filter(|(a, b)| a != b)
                .count();
            eprintln!(
                "[{tag}] whole file: gen {} bytes/{} pages vs act {} bytes/{} pages; \
                 byte-equal = {}; differing bytes over the shared prefix = {} (+{} tail bytes)",
                gv.len(),
                gpages,
                av.len(),
                apages,
                *gv == *av,
                byte_diffs,
                av.len().abs_diff(gv.len())
            );
            assert_ne!(*gv, *av, "{tag}: the snapshot's pages carry insertion history");

            // directory entries over the common page count: anchors (page content),
            // counts (page fill), file offsets, VM addresses
            let gdir = XdirVolume::parse(gd).expect("generated directory parses");
            let adir = XdirVolume::parse(ad).expect("snapshot directory parses");
            let common = gdir.entries.len().min(adir.entries.len());
            let (mut anchors, mut counts, mut offsets, mut vms) =
                (0usize, 0usize, 0usize, 0usize);
            for k in 0..common {
                let (g, a) = (&gdir.entries[k], &adir.entries[k]);
                if g.record.encode()[..] == a.record.encode()[..] {
                    anchors += 1;
                }
                if g.bucket == a.bucket {
                    counts += 1;
                }
                if g.file_offset == a.file_offset {
                    offsets += 1;
                }
                if g.vm_addr == a.vm_addr {
                    vms += 1;
                }
            }
            eprintln!(
                "[{tag}] directory over the first {common} pages: anchors {anchors}/{common}, \
                 counts {counts}/{common}, offsets {offsets}/{common}, vm {vms}/{common}; \
                 stamps gen {:#x}/{:#x} vs act {:#x}/{:#x} (clock history)",
                gdir.stamp1,
                gdir.stamp2,
                adir.stamp1,
                adir.stamp2
            );
            eprintln!(
                "[{tag}] vm: gen linear from {:#x}; act {} vm runs in entry order \
                 (allocator history, entry order not page order: B5's relocations)",
                IndexGenOptions::default().vm_base,
                segment_count(&adir.entries)
            );
            assert!(
                anchors < common,
                "anchors diverge past page 0 — the snapshot's pages pack insertion history"
            );
        }

        // the generated directories round-trip byte for byte
        for (_, gd) in &gen {
            let parsed = XdirVolume::parse(gd).expect("generated directory parses");
            assert_eq!(parsed.emit(), *gd);
        }
    }

    /// The number of distinct VM run bases in a directory's entry order.
    fn segment_count(entries: &[XdirEntry]) -> usize {
        let mut count = 0usize;
        let mut last: Option<u32> = None;
        for entry in entries {
            let expected = last.map(|base| base + INDEX_PAGE_SIZE as u32);
            if expected != Some(entry.vm_addr) {
                count += 1;
            }
            last = Some(entry.vm_addr);
        }
        count
    }
}
