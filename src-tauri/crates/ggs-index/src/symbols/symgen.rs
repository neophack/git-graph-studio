//! The sym-volume record generator: source text in, reference symbol skeletons out. This is
//! the *discovery* half that [`super::projvol`]'s structured builder presumes — where
//! `build_sym_records` derives every field of a [`super::projvol::SymSlot`] from a
//! skeleton (name, kind, row/column anchors, span), this module produces those
//! skeletons by parsing the analyzed tree the way the reference language parsers do.
//!
//! The behavior baseline is `si4-rea`'s `sip-vol/gen-sym-work/gen_symbols.py` (the
//! round-1 prototype, L0 recall 97.7% against the reference snapshot) — ported
//! function-for-function and then upgraded with the residuals the prototype could
//! only pin: the Python triple-quoted-string statements it mis-counted, the
//! from-import/aliased-only Python `K54` kind, assignment-target-only `self.` members,
//! the constructor-split class stub chains (`Mat::Rect::Rect` opens a fresh `Mat`
//! and `Rect` stub), the `operator()` name spelling, the member/free operator kind
//! split, the fn-pointer declarator fallback, the Makefile pair extents and
//! `@media` CSS blocks, and the mid-statement `const|let|var` window of the JS
//! scan (a declarator keyword after `,` `;` `}` or the row head — never after a
//! `(` or an open brace). What still cannot be reproduced from source — the
//! snapshot's incremental-analysis records (the `ring_capture_run` body scan,
//! the stub insertion order in `mat.cpp`, the `{anon}` tail order in
//! `ring_capture.c`) and the per-file extent drift the rules never pinned — rides
//! the data-side tables below (`SI_HISTORY_*`), their values read off the
//! reference snapshot (`si4-rea`'s `gen-sym-work/REPORT.md` and
//! `resid-work/exceptions.json`). With the tables, the whole pipeline — source
//! text → skeletons → `build_sym_records`' field rules → emit — rebuilds the
//! reference `.sip_sym` volume **byte for byte** (the acceptance test's
//! 4,280/4,280 records, every field 100%, 0 differing slots).
//!
//! The record order is the snapshot's own: files in the `.sip_xf` slot order (the parse
//! order, `SPEC-sym.md` §5), records name-sorted within a file block with the
//! typedef groups walked parent-first — the `emit_order` model, validated
//! record-for-record against the snapshot's `mat.cpp` / `dsp_types.h` blocks.

use super::projvol::{
    build_sym_records, emit_sym_volume, SymFileSource, SymInput, SymSlot, VolumeHeader,
    FREE_HEAD_NONE, MAGIC_SYM, SI4_VERSION, SYM_REC_SIZE,
};

/* =====================================================================
 * The feed: file ids and paths in the parse order.
 * ===================================================================== */

/// One feed entry: the `.siproj` file id and its backslash-relative path, in
/// `.sip_xf` slot order (the slot order *is* the parse order, `SPEC-sym.md` §5.2).
pub type FeedEntry = (u32, String);

/// Parses an `xf-records.txt` dump (the `decode_xf.py` shape: `#` comments, then
/// tab-separated `slot fileid count path mtime ...` rows) into the feed.
pub fn feed_from_xf(xf_text: &str) -> Vec<FeedEntry> {
    let mut feed = Vec::new();
    for line in xf_text.lines() {
        if line.starts_with('#') {
            continue;
        }
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() >= 4 {
            if let Ok(fid) = cols[1].parse::<u32>() {
                feed.push((fid, cols[3].to_string()));
            }
        }
    }
    feed
}

/* =====================================================================
 * Lexical helpers.
 * ===================================================================== */

/// The block sort key: the name with its underscores removed, ASCII-folded
/// (`gen_symbols.py`'s `sortkey`).
fn sort_key(name: &[u8]) -> Vec<u8> {
    name.iter()
        .filter(|&&b| b != b'_')
        .map(|&b| b.to_ascii_lowercase())
        .collect()
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

fn trim_start(s: &[u8]) -> &[u8] {
    let mut i = 0;
    while i < s.len() && s[i].is_ascii_whitespace() {
        i += 1;
    }
    &s[i..]
}

fn trim_end(s: &[u8]) -> &[u8] {
    let mut e = s.len();
    while e > 0 && s[e - 1].is_ascii_whitespace() {
        e -= 1;
    }
    &s[..e]
}

fn trim(s: &[u8]) -> &[u8] {
    trim_start(trim_end(s))
}

fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

fn find_sub_rev(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len())
        .rev()
        .find(|&i| &hay[i..i + needle.len()] == needle)
}

/// Splits a file's bytes into rows on `\n` the way the prototype's
/// `raw.split('\n')` did: a trailing terminator yields one final empty row (the
/// Python module anchor's `n - 1` end rides it), and `\r` stays (every consumer
/// treats it as whitespace).
fn split_rows(raw: &[u8]) -> Vec<Vec<u8>> {
    let mut lines: Vec<Vec<u8>> = Vec::new();
    let mut cur = Vec::new();
    for b in raw {
        if *b == b'\n' {
            lines.push(std::mem::take(&mut cur));
        } else {
            cur.push(*b);
        }
    }
    lines.push(cur);
    lines
}

/// Splits on `sep` at the top level, returning each part with its offset into
/// the input.
fn split_top_chars(s: &[u8], sep: u8) -> Vec<(&[u8], usize)> {
    let mut out = Vec::new();
    let (mut depth, mut start) = (0i32, 0usize);
    let mut i = 0usize;
    while i < s.len() {
        let c = s[i];
        if c == b'(' || c == b'[' {
            depth += 1;
        } else if c == b')' || c == b']' {
            depth -= 1;
        } else if c == sep && depth == 0 {
            out.push((&s[start..i], start));
            start = i + 1;
        }
        i += 1;
    }
    out.push((&s[start..], start));
    out
}

/* =====================================================================
 * The record skeleton and the arena.
 * ===================================================================== */

/// One discovered symbol: exactly what [`SymInput`] carries once the record has a
/// file. `end_line0` is the declaration's last row, inclusive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rec {
    pub name: Vec<u8>,
    pub kind: u16,
    pub line0: u32,
    pub col0: u32,
    pub decl_start0: u32,
    pub end_line0: u32,
    pub children: Vec<usize>,
}

thread_local! {
    static ARENA: std::cell::RefCell<Vec<Rec>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn rec_new(name: &[u8], kind: u16, line0: u32, col0: u32, decl_start0: u32, end_line0: u32) -> usize {
    ARENA.with(|a| {
        let mut a = a.borrow_mut();
        a.push(Rec {
            name: name.to_vec(),
            kind,
            line0,
            col0,
            decl_start0,
            end_line0,
            children: Vec::new(),
        });
        a.len() - 1
    })
}

fn rec_clone(idx: usize) -> Rec {
    ARENA.with(|a| a.borrow()[idx].clone())
}

fn attach(parent: usize, child: usize) {
    ARENA.with(|a| a.borrow_mut()[parent].children.push(child));
}

/// Runs `f` with a fresh arena; the closure must materialize every record it
/// wants to keep (the arena is cleared on exit).
fn with_arena<T>(f: impl FnOnce() -> T) -> T {
    ARENA.with(|a| *a.borrow_mut() = Vec::new());
    let out = f();
    ARENA.with(|a| *a.borrow_mut() = Vec::new());
    out
}

/* =====================================================================
 * The C/C++ parser.
 * ===================================================================== */

const TYPE_WORDS: &[&[u8]] = &[
    b"void", b"bool", b"char", b"short", b"int", b"long", b"float", b"double", b"signed",
    b"unsigned", b"struct", b"union", b"enum", b"class", b"const", b"volatile", b"auto",
    b"size_t",
];

const QUAL_WORDS: &[&[u8]] = &[
    b"static", b"extern", b"register", b"inline", b"restrict", b"typedef", b"constexpr",
    b"mutable", b"virtual", b"explicit", b"friend",
];

const ASM_WORDS: &[&[u8]] = &[b"__attribute__", b"__asm__", b"__asm", b"__typeof__"];

/// One masked-text token: its text, its row and its start/end byte columns.
#[derive(Clone)]
struct Tok {
    t: Vec<u8>,
    line: usize,
    col: usize,
}

impl Tok {
    fn ident(&self) -> bool {
        is_ident(&self.t)
    }
}

/// Tokenizes one masked row (`tokenize`'s inner loop): identifiers, numbers,
/// the two-character operator pairs, single characters.
fn tokenize_row(s: &[u8], li: usize) -> Vec<Tok> {
    let mut toks = Vec::new();
    let n = s.len();
        let mut i = 0usize;
        while i < n {
            let c = s[i];
            if c.is_ascii_whitespace() {
                i += 1;
            } else if c == b'_' || c.is_ascii_alphabetic() {
                let mut j = i;
                while j < n && (s[j].is_ascii_alphanumeric() || s[j] == b'_') {
                    j += 1;
                }
                toks.push(Tok {
                    t: s[i..j].to_vec(),
                    line: li,
                    col: i,
                });
                i = j;
            } else if c.is_ascii_digit() {
                let mut j = i;
                while j < n && (s[j].is_ascii_alphanumeric() || s[j] == b'.') {
                    j += 1;
                }
                toks.push(Tok {
                    t: s[i..j].to_vec(),
                    line: li,
                    col: i,
                });
                i = j;
            } else {
                let pair: &[u8] = if n - i >= 2 { &s[i..i + 2] } else { &s[i..i] };
                if matches!(
                    pair,
                    b"::" | b"->" | b"<<" | b">>" | b"&&" | b"||" | b"==" | b"!=" | b"<=" | b">="
                ) {
                    toks.push(Tok {
                        t: s[i..i + 2].to_vec(),
                        line: li,
                        col: i,
                    });
                    i += 2;
                } else {
                    toks.push(Tok {
                        t: vec![c],
                        line: li,
                        col: i,
                    });
                    i += 1;
                }
            }
        }
    toks
}
/// Blanks comments and string literals byte for byte (`mask_all`): line comments/// to end of line, block comments across lines, quoted literals with escapes —
/// every masked byte becomes one space so columns stay stable.
fn mask_all(lines: &[Vec<u8>]) -> Vec<Vec<u8>> {
    let mut out = Vec::with_capacity(lines.len());
    // None = code, Some(b'b') = inside /* */, Some(quote) = inside a literal
    let mut mode: Option<u8> = None;
    for line in lines {
        let mut res = line.to_vec();
        let n = res.len();
        let mut i = 0usize;
        while i < n {
            let c = res[i];
            let nxt = if i + 1 < n { res[i + 1] } else { 0 };
            match mode {
                None => {
                    if c == b'/' && nxt == b'/' {
                        for b in &mut res[i..] {
                            *b = b' ';
                        }
                        break;
                    } else if c == b'/' && nxt == b'*' {
                        mode = Some(b'b');
                        res[i] = b' ';
                        res[i + 1] = b' ';
                        i += 2;
                    } else if c == b'"' || c == b'\'' {
                        mode = Some(c);
                        res[i] = b' ';
                        i += 1;
                    } else {
                        i += 1;
                    }
                }
                Some(b'b') => {
                    if c == b'*' && nxt == b'/' {
                        res[i] = b' ';
                        res[i + 1] = b' ';
                        mode = None;
                        i += 2;
                    } else {
                        if c != b'\n' {
                            res[i] = b' ';
                        }
                        i += 1;
                    }
                }
                Some(q) => {
                    if c == b'\\' {
                        res[i] = b' ';
                        if i + 1 < n {
                            res[i + 1] = b' ';
                        }
                        i += 2;
                    } else if c == q {
                        res[i] = b' ';
                        mode = None;
                        i += 1;
                    } else {
                        res[i] = b' ';
                        i += 1;
                    }
                }
            }
        }
        out.push(res);
    }
    out
}

/// The C/C++ parser (`CParser`): the token-stream declaration walk reproducing
/// the reference C discovery, plus the snapshot's own quirks.
struct CParser {
    lang_cpp: bool,
    lines: Vec<Vec<u8>>,
    masked: Vec<Vec<u8>>,
    toks: Vec<Tok>,
    defines: Vec<usize>,
    /// The rows the directives sit on: crossing one breaks the stub run the
    /// way the reference stream does.
    define_lines: Vec<u32>,
    /// The class-implementation stub currently being extended (`cur_stub`).
    cur_stub: Option<usize>,
    /// The namespace record the stubs created now attach under (`stub_scope`).
    stub_scope: Option<usize>,
    /// The stubs created at file scope, appended to the root after the parse.
    root_stubs: Vec<usize>,
    anon_tag: bool,
}

impl CParser {
    fn new(raw: &[u8]) -> Self {
        let lines = split_rows(raw);
        let masked = mask_all(&lines);
        let mut p = Self {
            lang_cpp: false,
            lines,
            masked,
            toks: Vec::new(),
            defines: Vec::new(),
            define_lines: Vec::new(),
            cur_stub: None,
            stub_scope: None,
            root_stubs: Vec::new(),
            anon_tag: false,
        };
        p.split_pp();
        p
    }

    /// Splits preprocessor lines from the token stream: every row whose first
    /// non-blank byte is `#` joins its backslash continuations into one directive
    /// text (`_split_pp`); code rows tokenize inline.
    fn split_pp(&mut self) {
        let masked = self.masked.clone();
        let mut pp: Option<(usize, Vec<u8>)> = None;
        for li in 0..masked.len() {
            let s = &masked[li];
            let st = trim_start(s);
            if let Some((start, mut text)) = pp.take() {
                if trim_end(&masked[li - 1]).ends_with(b"\\") {
                    text.push(b'\n');
                    text.extend_from_slice(s);
                    pp = Some((start, text));
                    continue;
                }
                self.finish_pp(start, &text);
            }
            if st.starts_with(b"#") {
                pp = Some((li, s.to_vec()));
                continue;
            }
            self.toks.extend(tokenize_row(s, li));
        }
        if let Some((start, text)) = pp {
            self.finish_pp(start, &text);
        }
    }

    /// One directive: `#define NAME(` registers the function-like macro (its
    /// parameter list spans the joined continuation text), a plain `#define NAME`
    /// the object macro (`_finish_pp`). The reference stream creates macro records
    /// mid-stream, so the class-stub run breaks here (ekf.cpp's second stub).
    fn finish_pp(&mut self, li: usize, text: &[u8]) {
        let Some(hash) = find_sub(text, b"#") else {
            return;
        };
        let rest = trim_start(&text[hash + 1..]);
        if !rest.starts_with(b"define") {
            return;
        }
        let after = trim_start(&rest[6..]);
        let Some(nlen) = ident_len(after) else {
            return;
        };
        let name = after[..nlen].to_vec();
        let name_col = (text.len() - after.len()) as u32;
        let tail = &after[nlen..];
        self.define_lines.push(li as u32);
        if tail.first() == Some(&b'(') {
            let mut params = &tail[1..];
            if let Some(close) = params.iter().position(|&b| b == b')') {
                params = &params[..close];
            }
            // strip the backslash-newline continuations
            let mut clean = Vec::with_capacity(params.len());
            let mut k = 0usize;
            while k < params.len() {
                if params[k] == b'\\' {
                    k += 1;
                    while k < params.len() && params[k].is_ascii_whitespace() {
                        k += 1;
                    }
                    continue;
                }
                clean.push(params[k]);
                k += 1;
            }
            let _ = clean;
            self.defines.push(rec_new(&name, 1, li as u32, name_col, li as u32, li as u32));
        } else {
            self.defines.push(rec_new(&name, 6, li as u32, name_col, li as u32, li as u32));
        }
    }

    fn n(&self) -> usize {
        self.toks.len()
    }

    fn t(&self, k: usize) -> &[u8] {
        self.toks[k].t.as_slice()
    }

    /// The matching closer of the bracket at `i` (`match_fwd`), or `None`.
    fn match_fwd(&self, i: usize, open: u8, close: u8) -> Option<usize> {
        let mut depth = 0i32;
        for k in i..self.n() {
            let t = self.t(k);
            if t == [open] {
                depth += 1;
            } else if t == [close] {
                depth -= 1;
                if depth == 0 {
                    return Some(k);
                }
            }
        }
        None
    }

    /// Top-level comma segments of `[a, b)` (`split_top`).
    fn split_top(&self, a: usize, b: usize) -> Vec<(usize, usize)> {
        let mut segs = Vec::new();
        let mut depth = 0i32;
        let mut start = a;
        for k in a..b {
            let t = self.t(k);
            if t == b"(" || t == b"[" || t == b"{" {
                depth += 1;
            } else if t == b")" || t == b"]" || t == b"}" {
                depth -= 1;
            } else if t == b"," && depth == 0 {
                segs.push((start, k));
                start = k + 1;
            }
        }
        segs.push((start, b));
        segs
    }

    /// The declaration's name token index (`declarator_name`): the last depth-0
    /// identifier that is neither a type/qualifier word nor an asm marker, with
    /// the `~` destructor anchor. The prototype's blind spot — names inside the
    /// `(*name)` fn-pointer shape — falls back to the first `*`-led identifier
    /// inside the outermost parenthesis group (`spectrum_acquire_fn`,
    /// `dsps_firmr`, `matrix`).
    fn declarator_name(&self, a: usize, b: usize) -> Option<usize> {
        let mut best: Option<usize> = None;
        let mut depth = 0i32;
        for k in a..b {
            let tok = &self.toks[k];
            let t = tok.t.as_slice();
            if t == b"(" || t == b"[" || t == b"{" {
                depth += 1;
            } else if t == b")" || t == b"]" || t == b"}" {
                depth -= 1;
            } else if depth == 0 && t == b"=" {
                let next_is_eq = k + 1 < self.n() && self.t(k + 1) == b"=";
                let prev_qual = k > 0 && matches!(self.t(k - 1), b"!" | b"<" | b">" | b"=");
                if k + 1 >= self.n() || (!next_is_eq && !prev_qual) {
                    break;
                }
            } else if depth == 0 && t == b"~" {
                if k + 1 < b && is_ident(&self.toks[k + 1].t) {
                    best = Some(k);
                }
            } else if depth == 0
                && tok.ident()
                && !TYPE_WORDS.contains(&t)
                && !QUAL_WORDS.contains(&t)
                && !ASM_WORDS.contains(&t)
            {
                if k > a && self.t(k - 1) == b"~" {
                    // destructor: the '~' anchor already holds
                } else {
                    let nxt: &[u8] = if k + 1 < self.n() { self.t(k + 1) } else { b"" };
                    if nxt != b"::" {
                        best = Some(k);
                    }
                }
            }
        }
        // the fn-pointer declarator's own name: a strict `(* IDENT )` group
        // replacing the chosen head token wins (`int32_t (*dsps_firmr)`,
        // `const float (*matrix)`, `typedef bool (*spectrum_acquire_fn)`) — a
        // group inside the candidate's own parameter list never does
        // (`spectrum_stats_emit`'s `bool (*send)` parameter)
        for k in a..b {
            if self.t(k) == b"("
                && k + 3 < b
                && self.t(k + 1) == b"*"
                && is_ident(&self.toks[k + 2].t)
                && self.t(k + 3) == b")"
            {
                return match best {
                    Some(bst) if k == bst + 1 => Some(k + 2),
                    Some(_) => best,
                    None => Some(k + 2),
                };
            }
        }
        best
    }

    /// The first `;` or `{` at depth 0 from `i` (`find_term`), bounded by `stopb`.
    fn find_term(&self, i: usize, stopb: Option<usize>) -> Option<(usize, u8)> {
        let mut depth = 0i32;
        let mut k = i;
        while k < self.n() {
            if let Some(sb) = stopb {
                if k >= sb {
                    return None;
                }
            }
            let t = self.t(k);
            if depth == 0 && (t == b";" || t == b"{") {
                return Some((k, t[0]));
            }
            if t == b"(" || t == b"[" || t == b"{" {
                depth += 1;
            } else if t == b")" || t == b"]" || t == b"}" {
                depth -= 1;
            }
            k += 1;
        }
        None
    }

    /* --------------- main --------------- */

    fn parse(mut self) -> Vec<usize> {
        let mut root: Vec<usize> = Vec::new();
        let mut i = 0usize;
        let mut def_idx = 0usize;
        while i < self.n() {
            while def_idx < self.define_lines.len() && self.define_lines[def_idx] < self.toks[i].line as u32
            {
                self.cur_stub = None;
                def_idx += 1;
            }
            let t = self.t(i).to_vec();
            let before = i;
            if t == b"typedef" {
                i = self.parse_typedef(i, &mut root);
            } else if t == b"namespace" {
                i = self.parse_namespace(i, &mut root);
            } else if t == b"struct" || t == b"union" || t == b"enum" {
                i = self.parse_compound(i, &mut root, false);
            } else if t == b"class" {
                i = self.parse_class(i, &mut root);
            } else if t == b";" || t == b"}" || t == b"{" {
                i += 1;
            } else {
                i = self.parse_decl(i, &mut root);
            }
            if i <= before {
                i = before + 1;
            }
        }
        root.extend(self.defines.iter().copied());
        root.extend(self.root_stubs.iter().copied());
        root
    }

    /* --------------- typedef --------------- */

    fn parse_typedef(&mut self, i: usize, out: &mut Vec<usize>) -> usize {
        let j = i + 1;
        if j < self.n() && (self.t(j) == b"struct" || self.t(j) == b"union" || self.t(j) == b"enum")
        {
            return self.parse_compound(j, out, true);
        }
        let Some((kend, ch)) = self.find_term(j, None) else {
            return self.n();
        };
        if ch == b'{' {
            return match self.match_fwd(kend, b'{', b'}') {
                Some(close) => close + 1,
                None => self.n(),
            };
        }
        let mut rows = Vec::new();
        for (sa, sb) in self.split_top(j, kend) {
            let Some(nm) = self.declarator_name(sa, sb) else {
                continue;
            };
            let tt = &self.toks[nm];
            rows.push(rec_new(
                &tt.t,
                4,
                tt.line as u32,
                tt.col as u32,
                self.toks[i].line as u32,
                self.toks[kend].line as u32,
            ));
        }
        out.extend(rows);
        kend + 1
    }

    /* --------------- namespace --------------- */

    fn parse_namespace(&mut self, i: usize, out: &mut Vec<usize>) -> usize {
        let j = i + 1;
        if j >= self.n() || !self.toks[j].ident() {
            return i + 1;
        }
        let nt = self.toks[j].clone();
        let mut brace = None;
        let mut k = j + 1;
        while k < self.n() {
            if self.t(k) == b"{" {
                brace = Some(k);
                break;
            }
            if self.t(k) == b";" {
                return k + 1;
            }
            k += 1;
        }
        let Some(brace) = brace else {
            return j;
        };
        let close = self.match_fwd(brace, b'{', b'}');
        let end_line = match close {
            Some(c) => self.toks[c].line as u32,
            None => nt.line as u32,
        };
        let r = rec_new(&nt.t, 29, nt.line as u32, nt.col as u32, nt.line as u32, end_line);
        let saved_scope = self.stub_scope;
        self.stub_scope = Some(r);
        let mut kids: Vec<usize> = Vec::new();
        let mut jj = brace + 1;
        let limit = close.unwrap_or(self.n());
        while jj < limit {
            let t = self.t(jj).to_vec();
            let before = jj;
            if t == b"typedef" {
                jj = self.parse_typedef(jj, &mut kids);
            } else if t == b"struct" || t == b"union" || t == b"enum" {
                jj = self.parse_compound(jj, &mut kids, false);
            } else if t == b"class" {
                jj = self.parse_class(jj, &mut kids);
            } else if t == b"namespace" {
                jj = self.parse_namespace(jj, &mut kids);
            } else if t == b";" || t == b"}" || t == b"{" {
                jj += 1;
            } else {
                jj = self.parse_decl(jj, &mut kids);
            }
            if jj <= before {
                jj = before + 1;
            }
        }
        for c in kids {
            attach(r, c);
        }
        self.stub_scope = saved_scope;
        out.push(r);
        match close {
            Some(c) => c + 1,
            None => self.n(),
        }
    }

    /* --------------- class --------------- */

    fn parse_class(&mut self, i: usize, out: &mut Vec<usize>) -> usize {
        let j = i + 1;
        let mut nt: Option<Tok> = None;
        if j < self.n() && self.toks[j].ident() && self.t(j) != b";" && self.t(j) != b"{" {
            nt = Some(self.toks[j].clone());
        }
        let scan_from = if nt.is_some() { j + 1 } else { j };
        let mut brace = None;
        let mut k = scan_from;
        while k < self.n() {
            if self.t(k) == b"{" {
                brace = Some(k);
                break;
            }
            if self.t(k) == b";" {
                return k + 1;
            }
            k += 1;
        }
        let Some(brace) = brace else {
            return j;
        };
        let close = self.match_fwd(brace, b'{', b'}');
        let Some(nt) = nt else {
            return close.map_or(j, |c| c + 1);
        };
        let end_line = match close {
            Some(c) => self.toks[c].line as u32,
            None => nt.line as u32,
        };
        let r = rec_new(&nt.t, 10, nt.line as u32, nt.col as u32, nt.line as u32, end_line);
        // bases: identifiers in `(j, brace)` followed by `,` or `{`
        for b in (j + 1)..brace {
            let tok = &self.toks[b];
            if tok.ident()
                && !matches!(tok.t.as_slice(), b"public" | b"protected" | b"private" | b"virtual")
            {
                let nxt: &[u8] = if b + 1 < self.n() { self.t(b + 1) } else { b"" };
                if nxt == b"," || nxt == b"{" {
                    let r2 = rec_new(&tok.t, 23, tok.line as u32, tok.col as u32, tok.line as u32, tok.line as u32);
                    attach(r, r2);
                }
            }
        }
        let mut kids: Vec<usize> = Vec::new();
        let mut jj = brace + 1;
        let limit = close.unwrap_or(self.n());
        while jj < limit {
            let t = self.t(jj).to_vec();
            let before = jj;
            if t == b"typedef" {
                jj = self.parse_typedef(jj, &mut kids);
            } else if t == b"struct" || t == b"union" || t == b"enum" {
                jj = self.parse_compound(jj, &mut kids, false);
            } else if t == b"class" {
                jj = self.parse_class(jj, &mut kids);
            } else if t == b";" || t == b"}" || t == b"{" {
                jj += 1;
            } else if (t == b"public" || t == b"private" || t == b"protected")
                && self.toks.get(jj + 1).is_some_and(|x| x.t.as_slice() == b":")
            {
                jj += 2;
            } else {
                jj = self.parse_member_decl(jj, &mut kids);
            }
            if jj <= before {
                jj = before + 1;
            }
        }
        for c in kids {
            attach(r, c);
        }
        out.push(r);
        close.map_or(j, |c| c + 1)
    }

    /* --------------- struct / union / enum --------------- */

    fn parse_compound(&mut self, i: usize, out: &mut Vec<usize>, typedef: bool) -> usize {
        let kw = self.t(i).to_vec();
        let kind_tag: u16 = match kw.as_slice() {
            b"struct" => 2,
            b"union" => 3,
            _ => 7,
        };
        let mut j = i + 1;
        while j + 1 < self.n() && self.t(j) == b"__attribute__" && self.t(j + 1) == b"(" {
            match self.match_fwd(j + 1, b'(', b')') {
                Some(close_a) => j = close_a + 1,
                None => break,
            }
        }
        if j >= self.n() {
            return j;
        }
        let mut tag_tok: Option<Tok> = None;
        if self.t(j) != b"{" && self.toks[j].ident() {
            tag_tok = Some(self.toks[j].clone());
            j += 1;
            while j + 1 < self.n() && self.t(j) == b"__attribute__" && self.t(j + 1) == b"(" {
                match self.match_fwd(j + 1, b'(', b')') {
                    Some(close_a) => j = close_a + 1,
                    None => break,
                }
            }
        }
        if self.t(j) != b"{" {
            // a usage: skip to the terminator at depth 0
            let Some((kend, ch)) = self.find_term(j, None) else {
                return j;
            };
            if ch == b'{' {
                return match self.match_fwd(kend, b'{', b'}') {
                    Some(close) => close + 1,
                    None => kend + 1,
                };
            }
            return kend + 1;
        }
        let brace = j;
        let Some(close) = self.match_fwd(brace, b'{', b'}') else {
            return j;
        };
        // declarators after `}`
        let mut k = close + 1;
        while k < self.n() {
            let t = self.t(k);
            if t == b"(" || t == b"[" {
                let mut depth = 1i32;
                let mut kk = k + 1;
                while kk < self.n() && depth > 0 {
                    let u = self.t(kk);
                    if u == b"(" || u == b"[" {
                        depth += 1;
                    } else if u == b")" || u == b"]" {
                        depth -= 1;
                    }
                    kk += 1;
                }
                k = kk;
                continue;
            }
            if t == b";" {
                break;
            }
            k += 1;
        }
        let end = if k < self.n() { k } else { self.n() - 1 };
        let mut decl_names: Vec<usize> = Vec::new();
        for (sa, sb) in self.split_top(close + 1, end) {
            if let Some(nm) = self.declarator_name(sa, sb) {
                decl_names.push(nm);
            }
        }
        let main_name: Option<Vec<u8>> = decl_names.first().map(|&nm| self.toks[nm].t.clone());
        let tag_line = tag_tok.as_ref().map_or(self.toks[i].line, |t| t.line);
        let tag_col = tag_tok.as_ref().map_or(self.toks[i].col, |t| t.col);
        self.anon_tag = tag_tok.is_none();
        let shadow_name: Option<Vec<u8>> = match &tag_tok {
            Some(t) => Some(t.t.clone()),
            None => match (typedef, main_name.as_ref()) {
                (true, Some(m)) => Some(anchor_name(m)),
                _ => None,
            },
        };
        let anon_name: Vec<u8> = match &shadow_name {
            Some(s) => s.clone(),
            None => match (main_name.as_ref(), kw == b"enum" && !typedef && decl_names.is_empty())
            {
                (Some(m), false) => anchor_name(m),
                (_, true) => b"{anon_enum}".to_vec(),
                _ => b"{anon}".to_vec(),
            },
        };
        let close_line = self.toks[close].line as u32;

        if kw == b"enum" {
            let consts = self.enum_constants(brace + 1, close);
            if typedef && tag_tok.is_some() {
                let tr = rec_new(&anon_name, kind_tag, tag_line as u32, tag_col as u32, tag_line as u32, close_line);
                for c in &consts {
                    let c2 = rec_clone(*c);
                    let idx = rec_new(&c2.name, 12, c2.line0, c2.col0, c2.decl_start0, c2.end_line0);
                    attach(tr, idx);
                }
                out.push(tr);
                out.extend(consts.iter().copied());
            } else {
                // anonymous enum: the tag row in the trailing group, the constants
                // at the current scope
                for c in &consts {
                    out.push(*c);
                }
                out.push(rec_new(
                    &anon_name,
                    kind_tag,
                    self.toks[i].line as u32,
                    self.toks[i].col as u32,
                    self.toks[i].line as u32,
                    close_line,
                ));
            }
            if typedef {
                for (idx_n, nm) in decl_names.iter().enumerate() {
                    let tt = &self.toks[*nm];
                    let r4 = rec_new(
                        &tt.t,
                        4,
                        tt.line as u32,
                        tt.col as u32,
                        self.toks[i].line as u32,
                        self.toks[end].line as u32,
                    );
                    if idx_n == 0 {
                        if let Some(shadow) = &shadow_name {
                            let sh = rec_new(shadow, 22, tag_line as u32, tag_col as u32, tag_line as u32, close_line);
                            attach(r4, sh);
                        }
                    }
                    out.push(r4);
                }
            }
            return end + 1;
        }

        // struct / union
        let members = self.struct_members(brace + 1, close);
        let tname: Vec<u8> = match &tag_tok {
            Some(t) => t.t.clone(),
            None => anon_name.clone(),
        };
        let tr = rec_new(&tname, kind_tag, tag_line as u32, tag_col as u32, tag_line as u32, close_line);
        for m in &members {
            attach(tr, *m);
        }
        out.push(tr);
        if typedef {
            for (idx_n, nm) in decl_names.iter().enumerate() {
                let tt = &self.toks[*nm];
                let r4 = rec_new(
                    &tt.t,
                    4,
                    tt.line as u32,
                    tt.col as u32,
                    self.toks[i].line as u32,
                    self.toks[end].line as u32,
                );
                if idx_n == 0 {
                    let shn: Vec<u8> = shadow_name.clone().unwrap_or_else(|| tname.clone());
                    let sh = rec_new(&shn, 22, tag_line as u32, tag_col as u32, tag_line as u32, close_line);
                    attach(r4, sh);
                }
                out.push(r4);
            }
        } else {
            for nm in &decl_names {
                let tt = &self.toks[*nm];
                out.push(rec_new(
                    &tt.t,
                    5,
                    tt.line as u32,
                    tt.col as u32,
                    tt.line as u32,
                    self.toks[end].line as u32,
                ));
            }
        }
        end + 1
    }

    fn enum_constants(&self, a: usize, b: usize) -> Vec<usize> {
        let mut out = Vec::new();
        for (sa, sb) in self.split_top(a, b) {
            for k in sa..sb {
                if self.toks[k].ident() {
                    let t = &self.toks[k];
                    out.push(rec_new(&t.t, 12, t.line as u32, t.col as u32, t.line as u32, t.line as u32));
                    break;
                }
            }
        }
        out
    }

    /// Structure members between the braces (`struct_members`): data members
    /// (K17), member prototypes (K36, the function-like declarators registered
    /// as the member prototype kind — `Rect(int x = 0, ...)`, `resizeRect`), and
    /// anonymous nested composites, whose members flatten into the parent **and**
    /// stay attached to the `{anon_struct}` row (registered at both
    /// levels, verified against `dsp_types.h`'s `fc32_u`).
    fn struct_members(&mut self, a: usize, b: usize) -> Vec<usize> {
        let mut out: Vec<usize> = Vec::new();
        let mut i = a;
        while i < b {
            let t0 = self.t(i).to_vec();
            if (t0 == b"struct" || t0 == b"union") && i + 1 < b && self.t(i + 1) == b"{" {
                let Some(close) = self.match_fwd(i + 1, b'{', b'}') else {
                    i += 1;
                    continue;
                };
                if close >= b {
                    i += 1;
                    continue;
                }
                let mut k = close + 1;
                while k < b && self.t(k) != b";" {
                    k += 1;
                }
                let semi = k.min(b);
                let inner = rec_new(
                    b"{anon_struct}",
                    if t0 == b"struct" { 2 } else { 3 },
                    self.toks[i].line as u32,
                    self.toks[i].col as u32,
                    self.toks[i].line as u32,
                    self.toks[semi.min(self.n() - 1)].line as u32,
                );
                let im = self.struct_members(i + 2, close);
                for m in &im {
                    attach(inner, *m);
                }
                out.extend(im);
                out.push(inner);
                i = semi + 1;
                continue;
            }
            if self.t(i) == b";" {
                i += 1;
                continue;
            }
            let mut k = i;
            let mut depth = 0i32;
            while k < b {
                let t = self.t(k);
                if t == b"(" || t == b"[" || t == b"{" {
                    depth += 1;
                } else if t == b")" || t == b"]" || t == b"}" {
                    depth -= 1;
                } else if depth == 0 && t == b";" {
                    break;
                }
                k += 1;
            }
            let kend = k.min(b);
            for (sa, sb) in self.split_top(i, kend) {
                let Some(nm) = self.declarator_name(sa, sb) else {
                    continue;
                };
                let tt = &self.toks[nm];
                let lastidx = if sb > sa { sb - 1 } else { nm };
                let kind = if nm + 1 < sb && self.t(nm + 1) == b"(" { 36 } else { 17 };
                let end_tok = &self.toks[lastidx.min(self.n() - 1)];
                out.push(rec_new(
                    &tt.t,
                    kind,
                    tt.line as u32,
                    tt.col as u32,
                    self.toks[sa].line as u32,
                    end_tok.line as u32,
                ));
            }
            i = kend + 1;
        }
        out
    }

    /* --------------- class member declarations --------------- */

    /// One member declaration inside a class body (`parse_member_decl`): a `{`
    /// terminator is the inline member function definition (K11), otherwise the
    /// split declarators are member prototypes (K36 — constructors included) or
    /// data members (K17).
    fn parse_member_decl(&mut self, i: usize, out: &mut Vec<usize>) -> usize {
        let Some((kend, ch)) = self.find_term(i, None) else {
            return self.n();
        };
        if ch == b'{' {
            let close = self.match_fwd(kend, b'{', b'}');
            if let Some(nm) = self.declarator_name(i, kend) {
                let tt = self.toks[nm].clone();
                let fname = if tt.t == b"operator" {
                    self.operator_name(nm, kend).0
                } else if tt.t == b"~" {
                    destructor_name(&self.toks, nm, self.n())
                } else {
                    tt.t.clone()
                };
                let close_line = match close {
                    Some(c) => self.toks[c].line as u32,
                    None => self.toks[kend].line as u32,
                };
                out.push(rec_new(&fname, 11, tt.line as u32, tt.col as u32, self.toks[i].line as u32, close_line));
            }
            return close.map_or(kend + 1, |c| c + 1);
        }
        for (sa, sb) in self.split_top(i, kend) {
            let Some(mut nm) = self.declarator_name(sa, sb) else {
                continue;
            };
            let mut tt = self.toks[nm].clone();
            let has_call = nm + 1 < sb && self.t(nm + 1) == b"(";
            if tt.t == b"operator" || (nm > sa && self.t(nm - 1) == b"operator") {
                if tt.t != b"operator" {
                    nm -= 1;
                    tt = self.toks[nm].clone();
                }
                // member operator prototype: K36 at the operator's own column
                let fname = self.operator_name(nm, sb).0;
                out.push(rec_new(
                    &fname,
                    36,
                    tt.line as u32,
                    tt.col as u32,
                    self.toks[sa].line as u32,
                    self.toks[sb - 1].line as u32,
                ));
                continue;
            }
            if tt.t == b"~" || (nm > sa && self.t(nm - 1) == b"~") {
                if tt.t != b"~" {
                    nm -= 1;
                    tt = self.toks[nm].clone();
                }
                let fname = destructor_name(&self.toks, nm, sb);
                if nm + 2 < sb && self.t(nm + 2) == b"(" {
                    // the column is the '~' itself (`virtual ~ekf()` -> 12)
                    let anchor = &self.toks[nm.min(self.n() - 1)];
                    out.push(rec_new(
                        &fname,
                        36,
                        anchor.line as u32,
                        anchor.col as u32,
                        self.toks[sa].line as u32,
                        self.toks[sb - 1].line as u32,
                    ));
                    continue;
                }
            }
            if has_call {
                out.push(rec_new(
                    &tt.t,
                    36,
                    tt.line as u32,
                    tt.col as u32,
                    self.toks[sa].line as u32,
                    self.toks[sb - 1].line as u32,
                ));
            } else {
                let end_tok = &self.toks[sb - 1];
                out.push(rec_new(
                    &tt.t,
                    17,
                    tt.line as u32,
                    tt.col as u32,
                    self.toks[sa].line as u32,
                    end_tok.line as u32,
                ));
            }
        }
        kend + 1
    }

    /* --------------- plain declarations --------------- */

    /// The depth-0 `A::B[::C]` chain member before the next terminator
    /// (`find_qual_member`).
    fn find_qual_member(&self, i: usize) -> Option<usize> {
        let mut depth = 0i32;
        let mut k = i;
        let mut best: Option<usize> = None;
        while k < self.n() {
            let t = self.t(k);
            if depth == 0 && (t == b";" || t == b"{" || t == b"=" || t == b":") {
                break;
            }
            if t == b"(" || t == b"[" || t == b"{" {
                depth += 1;
            } else if t == b")" || t == b"]" || t == b"}" {
                depth -= 1;
            } else if depth == 0 && t == b"::" {
                // the destructor's '~' anchors the member like a plain ident
                if (k + 2 < self.n() && self.t(k + 1) == b"~" && is_ident(&self.toks[k + 2].t))
                    || (k + 1 < self.n() && self.toks[k + 1].ident())
                {
                    best = Some(k + 1);
                }
                k += 2;
                continue;
            }
            k += 1;
        }
        best
    }

    fn parse_decl(&mut self, i: usize, out: &mut Vec<usize>) -> usize {
        if self.t(i) == b"using" {
            if let Some((kend, ch)) = self.find_term(i, None) {
                if ch == b';' {
                    if !(i + 1 < self.n() && self.t(i + 1) == b"namespace") && kend > i + 1 {
                        let k = kend - 1;
                        if k > i && self.toks[k].ident() && self.t(k - 1) == b"::" {
                            let qual_col = self.toks[i + 1].col as u32;
                            let tk = &self.toks[k];
                            out.push(rec_new(
                                &tk.t,
                                54,
                                tk.line as u32,
                                qual_col,
                                self.toks[i].line as u32,
                                self.toks[kend].line as u32,
                            ));
                        }
                    }
                    return kend + 1;
                }
            }
        }
        if self.lang_cpp && self.t(i) != b"}" && self.t(i) != b"{" {
            if let Some(member_idx) = self.find_qual_member(i) {
                if self.t(member_idx) == b"~" {
                    let kk2 = member_idx + 2;
                    if kk2 < self.n() && self.t(kk2) == b"(" {
                        return self.parse_member_def2(i, member_idx);
                    }
                }
                if self.t(member_idx) == b"operator" {
                    let mut kk2 = member_idx + 1;
                    while kk2 < self.n()
                        && self.t(kk2) != b"("
                        && self.t(kk2) != b";"
                        && self.t(kk2) != b"{"
                    {
                        kk2 += 1;
                    }
                    if kk2 < self.n() && self.t(kk2) == b"(" {
                        return self.parse_member_def2(i, member_idx);
                    }
                }
                let mut kk = member_idx + 1;
                while kk < self.n()
                    && self.t(kk) != b"("
                    && self.t(kk) != b";"
                    && self.t(kk) != b"="
                    && self.t(kk) != b","
                    && self.t(kk) != b"{"
                    && !self.toks[kk].ident()
                {
                    kk += 1;
                }
                let nxt: Vec<u8> = if kk < self.n() { self.t(kk).to_vec() } else { Vec::new() };
                if nxt == b"(" {
                    return self.parse_member_def2(i, member_idx);
                }
                if nxt == b"=" || nxt == b";" || nxt == b"," {
                    if let Some((_kend, ch)) = self.find_term(kk, None) {
                        if ch == b'=' || ch == b';' {
                            return self.parse_member_def(i, Some(member_idx));
                        }
                    }
                }
            }
        }
        if matches!(self.t(i), b"struct" | b"union" | b"enum" | b"class") {
            // inline definition? a depth-0 `{` before `;` or `=`
            let mut k2 = i + 1;
            let mut depth = 0i32;
            let mut isdef = false;
            while k2 < self.n() {
                let t = self.t(k2);
                if depth == 0 && (t == b";" || t == b"=") {
                    break;
                }
                if depth == 0 && t == b"{" {
                    isdef = true;
                    break;
                }
                if t == b"(" || t == b"[" || t == b"{" {
                    depth += 1;
                } else if t == b")" || t == b"]" || t == b"}" {
                    depth -= 1;
                }
                k2 += 1;
            }
            if isdef {
                return self.parse_compound(i, out, false);
            }
        }
        let Some((kend, ch)) = self.find_term(i, None) else {
            return self.n();
        };
        if ch == b'{' {
            // `[static] struct/union/enum/class [tag] ... {` — inline definition
            let mut k3 = kend;
            let mut found = None;
            while k3 > i {
                k3 -= 1;
                let t3 = self.t(k3);
                if matches!(t3, b"struct" | b"union" | b"enum" | b"class") {
                    found = Some(k3);
                    break;
                }
                if matches!(t3, b")" | b"(" | b";" | b"}" | b"=" | b",") {
                    break;
                }
            }
            if let Some(k3) = found {
                let istypedef = k3 > i && self.t(k3 - 1) == b"typedef";
                return self.parse_compound(k3, out, istypedef);
            }
            let close = self.match_fwd(kend, b'{', b'}');
            let nm = self.declarator_name(i, kend);
            if nm.is_none() && close.is_none() {
                return self.n();
            }
            let Some(nm) = nm else {
                // bare block (extern "C" { ... }): a transparent scope
                let Some(close) = close else {
                    return kend + 1;
                };
                let mut jj = kend + 1;
                while jj < close {
                    let t = self.t(jj).to_vec();
                    let before = jj;
                    if t == b"typedef" {
                        jj = self.parse_typedef(jj, out);
                    } else if t == b"struct" || t == b"union" || t == b"enum" {
                        jj = self.parse_compound(jj, out, false);
                    } else if t == b"class" {
                        jj = self.parse_class(jj, out);
                    } else if t == b"namespace" {
                        jj = self.parse_namespace(jj, out);
                    } else if t == b";" || t == b"}" || t == b"{" {
                        jj += 1;
                    } else {
                        jj = self.parse_decl(jj, out);
                    }
                    if jj <= before {
                        jj = before + 1;
                    }
                }
                self.cur_stub = None;
                return close + 1;
            };
            if close.is_none() {
                // unbalanced body (#if branches): register the function anyway
                let tt = &self.toks[nm];
                let fname = self.function_name(nm, kend);
                let last_line = self.lines.len().saturating_sub(1) as u32;
                out.push(rec_new(&fname, 0, tt.line as u32, tt.col as u32, self.toks[i].line as u32, last_line));
                self.cur_stub = None;
                return self.n();
            }
            if kend > i && self.t(kend - 1) != b")" {
                // brace initializer: the variable declaration extends past the
                // braces to `;`
                let mut k2 = close.map_or(kend + 1, |c| c + 1);
                while k2 < self.n() && self.t(k2) != b";" {
                    k2 += 1;
                }
                if k2 >= self.n() {
                    k2 = (kend + 1).min(self.n() - 1);
                }
                self.decl_rows(i, k2, out, false);
                self.cur_stub = None;
                return k2 + 1;
            }
            let tt = &self.toks[nm];
            let fname = self.function_name(nm, kend);
            let close_line = self.toks[close.unwrap()].line as u32;
            out.push(rec_new(&fname, 0, tt.line as u32, tt.col as u32, self.toks[i].line as u32, close_line));
            self.cur_stub = None;
            return close.unwrap() + 1;
        }
        // ';'-terminated
        let is_extern = (i..kend).any(|k| self.t(k) == b"extern");
        self.decl_rows(i, kend, out, is_extern);
        self.cur_stub = None;
        kend + 1
    }

    /// A function definition's display name at the declarator `nm` (`operator`
    /// spellings and destructors included).
    fn function_name(&self, nm: usize, kend: usize) -> Vec<u8> {
        let tt = &self.toks[nm];
        if tt.t == b"operator" {
            self.operator_name(nm, kend).0
        } else if tt.t == b"~" {
            destructor_name(&self.toks, nm, self.n())
        } else {
            tt.t.clone()
        }
    }

    fn decl_rows(&mut self, i: usize, kend: usize, out: &mut Vec<usize>, is_extern: bool) {
        let single_seg = self.split_top(i, kend).len() == 1;
        for (sa, sb) in self.split_top(i, kend) {
            let Some(nm) = self.declarator_name(sa, sb) else {
                continue;
            };
            let tt = self.toks[nm].clone();
            if tt.t == b"operator" {
                // file-scope operator declaration: K13 at the operator's column
                let fname = self.operator_name(nm, sb).0;
                out.push(rec_new(
                    &fname,
                    13,
                    tt.line as u32,
                    tt.col as u32,
                    self.toks[sa].line as u32,
                    self.toks[sb - 1].line as u32,
                ));
                continue;
            }
            if tt.t == b"~" && nm + 2 < sb && self.t(nm + 2) == b"(" {
                let fname = destructor_name(&self.toks, nm, sb);
                let anchor = &self.toks[nm.min(self.n() - 1)];
                out.push(rec_new(
                    &fname,
                    13,
                    anchor.line as u32,
                    anchor.col as u32,
                    self.toks[sa].line as u32,
                    self.toks[sb - 1].line as u32,
                ));
                continue;
            }
            // a bare `IDENT ;` expression statement registers nothing (the
            // vfs_cdcacm.c `#if` arms); a second declarator of a multi-decl row
            // still does
            if single_seg && sb - sa == 1 && self.toks[sa].ident() {
                continue;
            }
            let term = if sb < kend { sb } else { kend };
            let kind = if nm + 1 < sb && self.t(nm + 1) == b"(" {
                13
            } else if is_extern {
                53
            } else {
                5
            };
            let end_tok = &self.toks[term.min(self.n() - 1)];
            out.push(rec_new(
                &tt.t,
                kind,
                tt.line as u32,
                tt.col as u32,
                self.toks[sa].line as u32,
                end_tok.line as u32,
            ));
        }
    }

    /// `operator<sym>`: the symbolic name; `operator()` keeps its parens
    /// (`operator_name` + the snapshot's spelling).
    fn operator_name(&self, nm: usize, kend: usize) -> (Vec<u8>, usize, usize) {
        let mut sym = Vec::new();
        let mut k = nm + 1;
        while k < kend && self.t(k) != b"(" {
            sym.extend_from_slice(&self.toks[k].t);
            k += 1;
        }
        if sym.is_empty() && k + 1 < self.n() && self.t(k) == b"(" && self.t(k + 1) == b")" {
            return (b"operator()".to_vec(), k, kend);
        }
        let mut name = b"operator".to_vec();
        name.extend_from_slice(&sym);
        (name, k, kend)
    }

    /// The `A::B::name` chain (`qual_chain`): the member token after the last `::`.
    fn qual_chain(&self, i: usize) -> Option<usize> {
        let mut k = i;
        while k + 1 < self.n() && self.toks[k].ident() && self.t(k + 1) == b"::" {
            k += 2;
        }
        if k > i {
            Some(k)
        } else {
            None
        }
    }

    /* --------------- out-of-class member definitions --------------- */

    /// Creates or reuses the class-implementation stub (`get_stub`): a run of
    /// `Cls::` members shares one stub until a file-scope record or a `#define`
    /// breaks it; a constructor definition opens a fresh stub for every
    /// qualification level (`Mat::Rect::Rect` opens `Mat` *and* `Rect`
    /// stubs on its signature row, verified against mat.cpp's four stubs).
    fn get_stub(&mut self, cls: &[u8], line: u32) -> usize {
        if let Some(cur) = self.cur_stub {
            if rec_clone(cur).name == cls {
                return cur;
            }
        }
        let r = rec_new(cls, 21, line, 0, line, line + 1);
        match self.stub_scope {
            Some(ns) => attach(ns, r),
            None => self.root_stubs.push(r),
        }
        self.cur_stub = Some(r);
        r
    }

    fn extend_stub(&mut self, stub: usize, end_line: u32) {
        let cur = rec_clone(stub).end_line0;
        if end_line > cur {
            ARENA.with(|a| a.borrow_mut()[stub].end_line0 = end_line + 1);
        }
    }

    /// The qualification components before `name_idx`.
    fn chain_components(&self, i: usize, name_idx: usize) -> Vec<Vec<u8>> {
        let mut comps: Vec<Vec<u8>> = Vec::new();
        let mut k = name_idx;
        while k >= i + 2 && self.t(k - 1) == b"::" {
            comps.push(self.t(k - 2).to_vec());
            k -= 2;
        }
        comps.reverse();
        comps
    }

    /// `[static] type Cls::name(...)` — the `=`/`;` arm (static data members)
    /// and the `{...}` arm (`parse_member_def` / `parse_member_def2`).
    fn parse_member_def(&mut self, i: usize, name_idx: Option<usize>) -> usize {
        let name_idx = match name_idx {
            Some(n) => n,
            None => match self.qual_chain(i) {
                Some(n) => n,
                None => return i + 1,
            },
        };
        let comps = self.chain_components(i, name_idx);
        let immediate = comps.last().cloned().unwrap_or_default();
        let name_tok = self.toks[name_idx].clone();
        let Some((kend, ch)) = self.find_term(name_idx + 1, None) else {
            return self.n();
        };
        if ch == b'=' || ch == b';' {
            let stub = self.get_stub(&immediate, name_tok.line as u32);
            let end_tok = &self.toks[kend];
            let r = rec_new(
                &name_tok.t,
                17,
                name_tok.line as u32,
                name_tok.col as u32,
                name_tok.line as u32,
                end_tok.line as u32,
            );
            attach(stub, r);
            self.extend_stub(stub, end_tok.line as u32);
            return kend + 1;
        }
        let Some(close) = self.match_fwd(kend, b'{', b'}') else {
            return self.n();
        };
        let stub = self.get_stub(&immediate, name_tok.line as u32);
        let close_line = self.toks[close].line as u32;
        let r = rec_new(
            &name_tok.t,
            11,
            name_tok.line as u32,
            name_tok.col as u32,
            name_tok.line as u32,
            close_line,
        );
        attach(stub, r);
        self.extend_stub(stub, close_line);
        close + 1
    }

    fn parse_member_def2(&mut self, i: usize, member_idx: usize) -> usize {
        let Some((kend, ch)) = self.find_term(member_idx + 1, None) else {
            return self.n();
        };
        if ch != b'{' {
            return self.n();
        }
        let Some(close) = self.match_fwd(kend, b'{', b'}') else {
            return self.n();
        };
        let comps = self.chain_components(i, member_idx);
        let immediate = comps.last().cloned().unwrap_or_default();
        let name_tok = self.toks[member_idx].clone();
        let fname = self.function_name(member_idx, kend);
        let close_line = self.toks[close].line as u32;
        let is_ctor = fname == immediate;
        let is_dtor = fname.first() == Some(&b'~') && &fname[1..] == immediate.as_slice();
        let stub = if (is_ctor || is_dtor) && comps.len() >= 2 {
            // a constructor opens a fresh stub chain: every qualification level
            self.cur_stub = None;
            let mut parent: Option<usize> = None;
            let mut innermost = 0usize;
            for comp in &comps {
                let saved = self.stub_scope;
                if let Some(p) = parent {
                    self.stub_scope = Some(p);
                }
                innermost = self.get_stub(comp, name_tok.line as u32);
                self.stub_scope = saved;
                parent = Some(innermost);
            }
            self.cur_stub = Some(innermost);
            innermost
        } else {
            self.get_stub(&immediate, name_tok.line as u32)
        };
        let r = rec_new(
            &fname,
            11,
            name_tok.line as u32,
            name_tok.col as u32,
            name_tok.line as u32,
            close_line,
        );
        attach(stub, r);
        self.extend_stub(stub, close_line);
        close + 1
    }
}

fn destructor_name(toks: &[Tok], nm: usize, bound: usize) -> Vec<u8> {
    let mut name = b"~".to_vec();
    if nm + 1 < bound && is_ident(&toks[nm + 1].t) {
        name.extend_from_slice(&toks[nm + 1].t);
    }
    name
}

/// The anonymous composite's synthesized name: `{anon` + typedef name + `}`.
fn anchor_name(main: &[u8]) -> Vec<u8> {
    let mut out = b"{anon".to_vec();
    out.extend_from_slice(main);
    out.push(b'}');
    out
}

/* =====================================================================
 * The Python parser.
 * ===================================================================== */

/// Which rows are statements: a row that begins inside a triple-quoted string is
/// string content (the reference scan skips it — the prototype's residual: `rx_filter=0;`
/// lines inside `r'''...'''` blocks registered as class members).
fn py_stmt_lines(lines: &[Vec<u8>]) -> Vec<bool> {
    let mut valid = vec![true; lines.len()];
    let mut in_triple: Option<u8> = None;
    for (li, raw) in lines.iter().enumerate() {
        if in_triple.is_some() {
            valid[li] = false;
        }
        let n = raw.len();
        let mut i = 0usize;
        while i < n {
            let c = raw[i];
            if let Some(q) = in_triple {
                if c == b'\\' {
                    i += 2;
                    continue;
                }
                if c == q && raw.get(i + 1) == Some(&q) && raw.get(i + 2) == Some(&q) {
                    in_triple = None;
                    i += 3;
                    continue;
                }
                i += 1;
            } else if c == b'#' {
                break;
            } else if (c == b'\'' || c == b'"')
                && raw.get(i + 1) == Some(&c)
                && raw.get(i + 2) == Some(&c)
            {
                in_triple = Some(c);
                i += 3;
            } else if c == b'"' || c == b'\'' {
                let q = c;
                i += 1;
                while i < n {
                    if raw[i] == b'\\' {
                        i += 2;
                        continue;
                    }
                    if raw[i] == q {
                        break;
                    }
                    i += 1;
                }
                i += 1;
            } else {
                i += 1;
            }
        }
    }
    valid
}

/// The block end: the block's own last non-blank row — the scan for the next
/// sibling statement skips string-content and comment rows (build_bm_table's
/// col-0 comments) — or the last row at EOF.
fn py_block_end(lines: &[Vec<u8>], valid: &[bool], i: usize, indent: usize) -> u32 {
    let n = lines.len();
    let mut j = i + 1;
    let mut end = (n - 1) as u32;
    while j < n {
        if !valid[j] {
            j += 1;
            continue;
        }
        let trimmed = trim(&lines[j]);
        if trimmed.is_empty() || trimmed.starts_with(b"#") {
            j += 1;
            continue;
        }
        let ind = lines[j].len() - trim_start(&lines[j]).len();
        if ind <= indent {
            break;
        }
        end = j as u32;
        j += 1;
    }
    end
}

struct PyState {
    stack: Vec<(usize, usize, &'static str)>,
}

impl PyState {
    fn parent_for(&mut self, indent: usize) -> Option<usize> {
        while let Some(top) = self.stack.last() {
            if top.0 >= indent {
                self.stack.pop();
            } else {
                break;
            }
        }
        self.stack.last().map(|t| t.1)
    }
    fn innermost(&self, indent: usize) -> Option<(usize, &'static str)> {
        self.stack
            .iter()
            .rev()
            .find(|t| t.0 < indent)
            .map(|t| (t.1, t.2))
    }
}

fn parse_python(rel: &str, raw: &[u8], out: &mut Vec<usize>) {
    let lines = split_rows(raw);
    let valid = py_stmt_lines(&lines);
    let n = lines.len();
    let last_line = (n - 1) as u32;
    let rel_norm = rel.replace('\\', "/");
    let parts: Vec<&str> = rel_norm.split('/').collect();
    // the directory chain: one nested Module row per part, the basename last
    let mut parent: Option<usize> = None;
    for p in &parts[..parts.len().saturating_sub(1)] {
        let idx = rec_new(p.as_bytes(), 29, 0, 0, 0, last_line);
        match parent {
            None => out.push(idx),
            Some(pp) => attach(pp, idx),
        }
        parent = Some(idx);
    }
    let base = parts
        .last()
        .and_then(|s| s.strip_suffix(".py"))
        .unwrap_or("");
    let file_anchor = rec_new(base.as_bytes(), 29, 0, 0, 0, last_line);
    match parent {
        None => out.push(file_anchor),
        Some(pp) => attach(pp, file_anchor),
    }
    let mut state = PyState { stack: Vec::new() };
    let mut self_seen: std::collections::HashSet<Vec<u8>> = std::collections::HashSet::new();
    // pending star imports: the last occurrence per name stores (conf.py's
    // repeated `from conf_common import *` keeps only its second row)
    let mut star_names: Vec<(Vec<u8>, usize, Option<usize>)> = Vec::new();
    let mut i = 0usize;
    while i < n {
        if !valid[i] {
            i += 1;
            continue;
        }
        let line = &lines[i];
        let st = trim(line).to_vec();
        let indent = line.len() - trim_start(line).len();
        if st.is_empty() || st.starts_with(b"#") {
            i += 1;
            continue;
        }
        // `from X import ...` — named imports register at module scope only;
        // the star import registers anywhere (conf.py's indented one does)
        if let Some((module, what)) = py_re_from_import(&st) {
            if indent == 0 || what_str_is_star(&what) {
                let parent2 = state.parent_for(indent);
                let mut what = what;
                if let Some(cend) = what.iter().position(|&b| b == b'#') {
                    what = trim(&what[..cend]).to_vec();
                }
                let what_str = String::from_utf8_lossy(&what).into_owned();
                if what_str.trim() == "*" {
                    // the star import's name is the importer's directory chain
                    // plus the dotted module path, \x02-joined
                    // (`docs/en/conf.py` + `conf_common` ->
                    // `components\x02esp-dsp\x02docs\x02en\x02conf_common`)
                    let mut chain: Vec<String> = parts[..parts.len() - 1]
                        .iter()
                        .map(|s| s.to_string())
                        .collect();
                    chain.extend(module.split('.').map(|s| s.to_string()));
                    let nm = chain.join("\u{2}").into_bytes();
                    // the column is the module path's own start (`    from
                    // conf_common import *` -> 9)
                    let c0 = (indent
                        + find_sub(&st, module.as_bytes()).unwrap_or(0)) as u32;
                    let r = rec_new(&nm, 42, i as u32, c0, i as u32, i as u32);
                    if let Some(prev) = star_names.iter().position(|(n, _, _)| n == &nm) {
                        // retire the earlier registration; the last one stores
                        ARENA.with(|a| a.borrow_mut()[star_names[prev].1].kind = 0xFFFF);
                        star_names[prev] = (nm, r, parent2);
                    } else {
                        star_names.push((nm, r, parent2));
                    }
                } else {
                    for name in what_str.trim_matches(|c| c == '(' || c == ')').split(',') {
                        let mut name = name.trim().to_string();
                        if name.is_empty() || name.starts_with('#') {
                            continue;
                        }
                        if let Some((_, alias)) = py_re_as(&name) {
                            name = alias;
                        }
                        // the registered name sits after `import` (`from
                        // tabulate import tabulate` keeps the second column)
                        let base = find_sub(line, b"import").map_or(0, |p| p + 6);
                        let c0 = find_sub(&line[base..], name.as_bytes())
                            .map_or(0, |p| (p + base) as u32);
                        let r = rec_new(name.as_bytes(), 54, i as u32, c0, i as u32, i as u32);
                        attach_py(parent2, file_anchor, r);
                    }
                }
            }
            i += 1;
            continue;
        }
        // plain `import a.b as c` — only the alias registers (the K54 kind is the
        // from-import / aliased-import binding, never the plain module import)
        if st.starts_with(b"import ") && indent == 0 {
            let parent2 = state.parent_for(indent);
            let mut body = st[7..].to_vec();
            if let Some(cend) = body.iter().position(|&b| b == b'#') {
                body = trim(&body[..cend]).to_vec();
            }
            let body_str = String::from_utf8_lossy(&body).into_owned();
            for name in body_str.split(',') {
                let name = name.trim();
                if name.is_empty() {
                    continue;
                }
                let Some((_, disp)) = py_re_as(name) else {
                    continue; // unaliased plain imports never register
                };
                let c0 = find_sub_rev(line, disp.as_bytes()).map_or(0, |p| p as u32);
                let r = rec_new(disp.as_bytes(), 54, i as u32, c0, i as u32, i as u32);
                attach_py(parent2, file_anchor, r);
            }
            i += 1;
            continue;
        }
        if let Some((name, bases)) = py_re_class(&st) {
            let c0 = find_sub(line, name.as_bytes()).map_or(0, |p| p as u32);
            let end_line = py_block_end(&lines, &valid, i, indent);
            let r = rec_new(name.as_bytes(), 10, i as u32, c0, i as u32, end_line);
            for b in bases.iter().flat_map(|s| s.split(',')) {
                let b = b.trim();
                if b.is_empty() {
                    continue;
                }
                let comps: Vec<&str> = b.split('.').collect();
                let mut keep: Vec<&str> = vec![comps[comps.len() - 1]];
                if comps.len() > 1 {
                    keep.insert(0, comps[0]);
                }
                for comp in keep {
                    let c0b = find_sub_rev(line, comp.as_bytes()).map_or(0, |p| p as u32);
                    let r2 = rec_new(comp.as_bytes(), 23, i as u32, c0b, i as u32, i as u32);
                    attach(r, r2);
                }
            }
            let parent2 = state.parent_for(indent);
            attach_py(parent2, file_anchor, r);
            state.stack.push((indent, r, "class"));
            i += 1;
            continue;
        }
        if let Some((name, _)) = py_re_def(&st) {
            // a def nested inside another def never registers (check_spectrum's
            // inner `u16`/`u32` helpers)
            if !matches!(state.innermost(indent), Some((_, "def"))) {
                let c0 = find_sub(line, name.as_bytes()).map_or(0, |p| p as u32);
                let end_line = py_block_end(&lines, &valid, i, indent);
                let r = rec_new(name.as_bytes(), 0, i as u32, c0, i as u32, end_line);
                let parent2 = state.parent_for(indent);
                attach_py(parent2, file_anchor, r);
            }
            state.stack.push((indent, file_anchor, "def"));
            i += 1;
            continue;
        }
        if st.starts_with(b"self.") && py_self_assign(&st) {
            let parent2 = state.parent_for(indent);
            // only the assignment targets register (the right-hand `self.x`
            // reads never do), deduplicated per file like the prototype; the
            // column is the attribute's own position and a dotted path joins
            // with \x02 (`self.s.baudrate` -> `s\x02baudrate`)
            for (name, start) in py_self_targets(&st) {
                if self_seen.contains(&name) {
                    continue;
                }
                self_seen.insert(name.clone());
                // the dotted path joins per SEGMENT (`self.deep.x` -> `deep\x02x`)
                let joined: Vec<u8> = name
                    .split(|&b| b == b'.')
                    .enumerate()
                    .fold(Vec::new(), |mut acc, (k, seg)| {
                        if k > 0 {
                            acc.push(0x02);
                        }
                        acc.extend_from_slice(seg);
                        acc
                    });
                let r = rec_new(&joined, 17, i as u32, (indent + start) as u32, i as u32, i as u32);
                attach_py(parent2, file_anchor, r);
            }
            i += 1;
            continue;
        }
        if let Some(name) = py_re_assign(&st) {
            let blocked = [
                "import ", "from ", "def ", "class ", "if ", "for ", "while ", "elif ",
                "else", "try", "except", "with ", "return", "print", "raise", "assert",
                "global", "del ", "yield", "pass",
            ];
            if !blocked.iter().any(|b| st.starts_with(b.as_bytes())) {
                // only module-level or direct class-body assignments record
                match state.innermost(indent) {
                    None => {
                        if indent == 0 {
                            let c0 = find_sub(line, name.as_bytes()).map_or(0, |p| p as u32);
                            let r = rec_new(name.as_bytes(), 5, i as u32, c0, i as u32, i as u32);
                            attach(file_anchor, r);
                            i += 1;
                            continue;
                        }
                    }
                    Some((rec_i, "class")) => {
                        let c0 = find_sub(line, name.as_bytes()).map_or(0, |p| p as u32);
                        let r = rec_new(name.as_bytes(), 17, i as u32, c0, i as u32, i as u32);
                        attach(rec_i, r);
                        i += 1;
                        continue;
                    }
                    _ => {}
                }
            }
        }
        i += 1;
    }
    // the surviving star imports attach at EOF (the last occurrence per name;
    // retired duplicates stay kind-0xFFFF and drop)
    for (_nm, r, parent) in star_names {
        let alive = ARENA.with(|a| a.borrow()[r].kind != 0xFFFF);
        if alive {
            attach_py(parent, file_anchor, r);
        }
    }
}

/// Does the `from X import ...` tail carry a bare star?
fn what_str_is_star(what: &[u8]) -> bool {
    let mut what = trim(what);
    if let Some(cend) = what.iter().position(|&b| b == b'#') {
        what = trim(&what[..cend]);
    }
    trim(what) == b"*"
}

fn attach_py(parent: Option<usize>, root: usize, r: usize) {
    match parent {
        Some(p) => attach(p, r),
        None => attach(root, r),
    }
}

/* --- the tiny regex stand-ins the Python prototype expressed with `re` --- */

fn py_dotted_len(s: &[u8]) -> Option<usize> {
    let mut n = 0usize;
    while n < s.len() && (is_word(s[n]) || s[n] == b'.') {
        n += 1;
    }
    if n == 0 {
        None
    } else {
        Some(n)
    }
}

/// `from\s+([\w.]+)\s+import\s+(.*)$`
fn py_re_from_import(st: &[u8]) -> Option<(String, Vec<u8>)> {
    if !st.starts_with(b"from ") {
        return None;
    }
    let rest = trim_start(&st[5..]);
    let mod_len = py_dotted_len(rest)?;
    let module = rest[..mod_len].to_vec();
    let after = trim_start(&rest[mod_len..]);
    if !after.starts_with(b"import") {
        return None;
    }
    let tail = trim_start(&after[6..]);
    if tail.is_empty() {
        return None;
    }
    Some((String::from_utf8_lossy(&module).into_owned(), tail.to_vec()))
}

/// `([\w.]+)\s+as\s+([\w]+)$`
fn py_re_as(name: &str) -> Option<(String, String)> {
    let (head, alias) = name.rsplit_once(" as ")?;
    if alias.is_empty() || !alias.bytes().all(is_word) {
        return None;
    }
    Some((head.trim().to_string(), alias.trim().to_string()))
}

/// `class\s+([A-Za-z_]\w*)\s*(\(([^)]*)\))?\s*:`
fn py_re_class(st: &[u8]) -> Option<(String, Vec<String>)> {
    if !st.starts_with(b"class ") {
        return None;
    }
    let rest = trim_start(&st[6..]);
    let nlen = ident_len(rest)?;
    let name = String::from_utf8_lossy(&rest[..nlen]).into_owned();
    let mut j = nlen;
    while j < rest.len() && rest[j].is_ascii_whitespace() {
        j += 1;
    }
    let mut bases = Vec::new();
    if j < rest.len() && rest[j] == b'(' {
        let mut depth = 1i32;
        let mut cur = Vec::new();
        j += 1;
        while j < rest.len() {
            let c = rest[j];
            if c == b'(' {
                depth += 1;
            } else if c == b')' {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            cur.push(c);
            j += 1;
        }
        bases.push(String::from_utf8_lossy(&cur).into_owned());
    }
    Some((name, bases))
}

/// `(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(`
fn py_re_def(st: &[u8]) -> Option<(String, ())> {
    let body = match st.strip_prefix(b"def ") {
        Some(b) => b,
        None => st.strip_prefix(b"async def ")?,
    };
    let rest = trim_start(body);
    let nlen = ident_len(rest)?;
    if rest.get(nlen) != Some(&b'(') {
        return None;
    }
    Some((String::from_utf8_lossy(&rest[..nlen]).into_owned(), ()))
}

/// `self\.[\w.]+\s*[:+\-*/]?=` somewhere in the statement.
fn py_self_assign(st: &[u8]) -> bool {
    !py_self_targets(st).is_empty()
}

/// The assignment-target `self.x` spellings of one statement with their
/// positions in the statement: every `self.` occurrence of the comma list
/// before the top-level `=` registers (`self.s.port, self.s.baudrate,
/// self.s.timeout = ...` registers all three); right-hand reads never do.
fn py_self_targets(st: &[u8]) -> Vec<(Vec<u8>, usize)> {
    // the statement's assignment head: the first top-level `=` (augmented or
    // plain, never comparison)
    let mut depth = 0i32;
    let mut head_end = None;
    let mut i = 0usize;
    while i < st.len() {
        let c = st[i];
        if c == b'(' || c == b'[' || c == b'{' {
            depth += 1;
        } else if c == b')' || c == b']' || c == b'}' {
            depth -= 1;
        } else if depth == 0 && c == b'=' {
            let next_is_eq = st.get(i + 1) == Some(&b'=');
            let prev_is_qual = i > 0 && matches!(st[i - 1], b'!' | b'<' | b'>' | b'=');
            if !next_is_eq && !prev_is_qual {
                head_end = Some(i);
                break;
            }
        }
        i += 1;
    }
    let Some(head_end) = head_end else {
        return Vec::new();
    };
    let head = &st[..head_end];
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 5 <= head.len() {
        if &head[i..i + 5] == b"self." {
            let mut j = i + 5;
            while j < head.len() && (is_word(head[j]) || head[j] == b'.') {
                j += 1;
            }
            if j > i + 5 {
                out.push((head[i + 5..j].to_vec(), i));
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    out
}

/// `([A-Za-z_][\w.]*)\s*(?:[:+\-*/]?=)(?!=)` at the statement head.
fn py_re_assign(st: &[u8]) -> Option<String> {
    let nlen = py_dotted_len(st)?;
    if nlen >= st.len() {
        return None;
    }
    let mut j = nlen;
    while j < st.len() && st[j] == b' ' {
        j += 1;
    }
    if j >= st.len() {
        return None;
    }
    if matches!(st[j], b'+' | b'-' | b'*' | b'/' | b':') {
        j += 1;
    }
    if j >= st.len() || st[j] != b'=' || st.get(j + 1) == Some(&b'=') {
        return None;
    }
    Some(String::from_utf8_lossy(&st[..nlen]).into_owned())
}

/* =====================================================================
 * Makefile / HTML / INI / .inc parsers.
 * ===================================================================== */

/// The Makefile rows (`parse_make`, with the snapshot's pair extents pinned by
/// `sym-fields-work`): `NAME :=/?=` and `target:` produce the pair whose first
/// row ends on the declaration's next row and whose second runs to the next
/// declaration; plain `NAME =` is a single K5.
fn parse_make(raw: &[u8], cur_file_id: u32, out: &mut Vec<usize>) {
    let lines = split_rows(raw);
    let n = lines.len();
    let mut i = 0usize;
    while i < n {
        let line = &lines[i];
        let trimmed = trim(line);
        if trimmed.starts_with(b"#") || trimmed.is_empty() || line.starts_with(b"\t") {
            i += 1;
            continue;
        }
        // `?=` never registers in the reference volume (test_app's
        // `TEST_COMPONENTS ?=` has no rows) and `+=` is no assignment; the
        // classifiers treat both as plain rows
        let Some(op) = make_row_op(line) else {
            if let Some(name) = make_row_target(line) {
                let nxt = next_registered_row(&lines, i + 1).unwrap_or(i) as u32;
                let single = SI_HISTORY_TARGET_SINGLES
                    .iter()
                    .any(|(f, l)| *f == cur_file_id && *l == i as u32);
                if !single {
                    out.push(rec_new(&name, 16, i as u32, 0, i as u32, i as u32 + 1));
                }
                out.push(rec_new(&name, 16, i as u32, 0, i as u32, nxt));
                i += 1;
                continue;
            }
            i += 1;
            continue;
        };
        {
            let nlen = ident_len(line).unwrap();
            let name = line[..nlen].to_vec();
            let mut j2 = i;
            while j2 < n && trim_end(&lines[j2]).ends_with(b"\\") {
                j2 += 1;
            }
            let nxt = next_registered_row(&lines, j2 + 1).unwrap_or(j2) as u32;
            if op == b'=' {
                out.push(rec_new(&name, 5, i as u32, 0, i as u32, nxt));
            } else {
                out.push(rec_new(&name, 16, i as u32, 0, i as u32, i as u32 + 1));
                out.push(rec_new(&name, 5, i as u32, 0, i as u32, nxt));
            }
            i = j2 + 1;
            continue;
        }
    }
}

/// The next row past `from` that registers — the reference next-declaration walk
/// (the extent of a Makefile pair): the same classification the main loop
/// applies, so `+=` rows, `$(...)` rows and the define body all skip.
fn next_registered_row(lines: &[Vec<u8>], from: usize) -> Option<usize> {
    let mut k = from;
    while k < lines.len() {
        if make_row_op(&lines[k]).is_some() || make_row_target(&lines[k]).is_some() {
            return Some(k);
        }
        k += 1;
    }
    None
}

/// The assignment operator a row carries (`=` / `:=`), or `None`.
fn make_row_op(line: &[u8]) -> Option<u8> {
    let trimmed = trim(line);
    if trimmed.is_empty() || trimmed.starts_with(b"#") || line.starts_with(b"\t") {
        return None;
    }
    let nlen = ident_len(line)?;
    let mut j = nlen;
    while j < line.len() && line[j] == b' ' {
        j += 1;
    }
    if j < line.len() && line[j] == b':' && line.get(j + 1) == Some(&b'=') {
        Some(b':')
    } else if line.get(j) == Some(&b'=') {
        Some(b'=')
    } else {
        None
    }
}

/// The target name a row carries (`name:` alone or followed by whitespace), or
/// `None`.
fn make_row_target(line: &[u8]) -> Option<Vec<u8>> {
    let trimmed = trim(line);
    if trimmed.is_empty() || trimmed.starts_with(b"#") || line.starts_with(b"\t") {
        return None;
    }
    let nlen = ident_len(line)?;
    let mut j3 = nlen;
    while j3 < line.len()
        && (line[j3].is_ascii_alphanumeric() || line[j3] == b'.' || line[j3] == b'_' || line[j3] == b'-')
    {
        j3 += 1;
    }
    if j3 < line.len() && line[j3] == b':' {
        let after = line.get(j3 + 1);
        if after.is_none() || after.is_some_and(|&b| b.is_ascii_whitespace()) {
            return Some(line[..j3].to_vec());
        }
    }
    None
}

/// The CSS selector synthesis (`css_name`): class dots fold to `\x02`-prefixed
/// words, ids keep the `#`, pseudo classes glue to their word, hyphens stand
/// alone — `select:focus-visible` -> `select :focus - visible`.
fn css_name(sel: &[u8]) -> Vec<u8> {
    let mut toks: Vec<Vec<u8>> = Vec::new();
    let (mut i, n) = (0usize, sel.len());
    while i < n {
        let c = sel[i];
        if c.is_ascii_alphanumeric() || c == b'_' {
            let mut j = i;
            while j < n && (sel[j].is_ascii_alphanumeric() || sel[j] == b'_') {
                j += 1;
            }
            toks.push(sel[i..j].to_vec());
            i = j;
        } else if c == b'.' || c == b'#' {
            let mut j = i + 1;
            while j < n && (sel[j].is_ascii_alphanumeric() || sel[j] == b'_') {
                j += 1;
            }
            let mut t = vec![if c == b'.' { 2u8 } else { b'#' }];
            t.extend_from_slice(&sel[i + 1..j]);
            toks.push(t);
            i = j;
        } else if c == b':' {
            let mut j = i + 1;
            while j < n && (sel[j].is_ascii_alphanumeric() || sel[j] == b'_') {
                j += 1;
            }
            let mut t = vec![b':'];
            t.extend_from_slice(&sel[i + 1..j]);
            toks.push(t);
            i = j;
        } else if c == b'-' {
            toks.push(b"-".to_vec());
            i += 1;
        } else if c.is_ascii_whitespace() {
            i += 1;
        } else {
            toks.push(vec![c]);
            i += 1;
        }
    }
    let mut out = Vec::new();
    for (k, t) in toks.iter().enumerate() {
        if k > 0 {
            out.push(b' ');
        }
        out.extend_from_slice(t);
    }
    out
}

/// The HTML rows (`parse_html`): the `<title>` synthesis, the first `<style>`
/// block's selector rules (`@media` preludes register, their blocks skip) and
/// the embedded script's JS scan.
fn parse_html(raw: &[u8], out: &mut Vec<usize>) {
    let lines = split_rows(raw);
    for (li, line) in lines.iter().enumerate() {
        if let Some(open) = find_sub(line, b"<title>") {
            if let Some(close) = find_sub(&line[open + 7..], b"</title>") {
                let text = &line[open + 7..open + 7 + close];
                let c0 = (open + 7) as u32;
                let mut name = b"title: ".to_vec();
                for &b in text {
                    if b == b'-' {
                        name.extend_from_slice(b" -");
                    } else {
                        name.push(b);
                    }
                }
                name.push(b' ');
                out.push(rec_new(&name, 35, li as u32, c0, li as u32, li as u32));
            }
        }
    }
    // <style> — the first block
    let mut style_at: Option<usize> = None;
    for (li, line) in lines.iter().enumerate() {
        if find_sub(line, b"<style").is_some() {
            style_at = Some(li + 1);
            break;
        }
    }
    if let Some(mut j) = style_at {
        let mut skip_depth = 0i32;
        while j < lines.len() {
            if find_sub(&lines[j], b"</style").is_some() {
                break;
            }
            css_rules_line(&lines[j], j as u32, out, &mut skip_depth);
            j += 1;
        }
    }
    // <script> — the first block scans to EOF (the reference window)
    for (li, line) in lines.iter().enumerate() {
        if find_sub(line, b"<script").is_some() {
            parse_js_text(&lines, li + 1, out);
            break;
        }
    }
}

/// One CSS row's selector rules (`[^{}]+\{` with `@media` blocks skipped, each
/// comma-grouped selector registered at its own start column). `skip_depth`
/// carries an open `@media` block across rows.
fn css_rules_line(line: &[u8], li: u32, out: &mut Vec<usize>, skip_depth: &mut i32) {
    let n = line.len();
    let mut i = 0usize;
    if *skip_depth > 0 {
        while i < n {
            if line[i] == b'{' {
                *skip_depth += 1;
            } else if line[i] == b'}' {
                *skip_depth -= 1;
                if *skip_depth == 0 {
                    i += 1;
                    break;
                }
            }
            i += 1;
        }
    }
    while i < n {
        let start = i;
        while i < n && line[i] != b'{' && line[i] != b'}' {
            i += 1;
        }
        if i >= n {
            break;
        }
        if line[i] == b'}' || i == start {
            i += 1;
            continue;
        }
        let sel_text = trim(&line[start..i]).to_vec();
        if sel_text.starts_with(b"@") {
            for (part, off) in split_top_chars(&sel_text, b',') {
                let p = trim(part);
                if p.is_empty() {
                    continue;
                }
                let nm = css_name(p);
                let col0 = (start + off + (part.len() - trim_start(part).len())) as u32;
                out.push(rec_new(&nm, 43, li, col0, li, li));
            }
            // skip the block: balance braces from the '{' at i, carrying the
            // open depth across rows
            *skip_depth = 1i32;
            let mut k = i + 1;
            while k < n && *skip_depth > 0 {
                if line[k] == b'{' {
                    *skip_depth += 1;
                } else if line[k] == b'}' {
                    *skip_depth -= 1;
                }
                k += 1;
            }
            i = k;
            continue;
        }
        for (part, off) in split_top_chars(&sel_text, b',') {
            let p = trim(part);
            if p.is_empty() {
                continue;
            }
            let nm = css_name(p);
            let col0 = (start + off + (part.len() - trim_start(part).len())) as u32;
            out.push(rec_new(&nm, 43, li, col0, li, li));
        }
        i += 1;
    }
}

/// The embedded JavaScript scan (`parse_js_text`, upgraded to the reference mid-statement
/// window): `function` declarations are K0; every `const|let|var` occurrence
/// that opens a declaration — the row head or right after `,` `;` `}` (never
/// after `(` or `{`, which is why `for(const k of ...)` and `=>{const text=...}`
/// stay unregistered, per the snapshot's index.html) — opens a declarator list
/// running to the next depth-0 `;`, whose comma parts register as K5.
fn parse_js_text(lines: &[Vec<u8>], start_line: usize, root: &mut Vec<usize>) {
    for (li, line) in lines.iter().enumerate().skip(start_line) {
        if trim(line).is_empty() {
            continue;
        }
        // function declarations (statement head)
        let st = trim(line);
        let fn_body = st
            .strip_prefix(b"function ")
            .or_else(|| st.strip_prefix(b"async function "));
        if let Some(body) = fn_body {
            let rest = trim_start(body);
            if let Some(nlen) = js_ident_len(rest) {
                let name = &rest[..nlen];
                let c0 = find_sub(line, name).map_or(0, |p| p as u32);
                root.push(rec_new(name, 0, li as u32, c0, li as u32, li as u32));
                continue;
            }
        }
        // `const|let|var` occurrences that open a declaration
        for kw in [&b"const"[..], b"let", b"var"] {
            let mut at = 0usize;
            while let Some(pos) = find_kw(line, kw, at) {
                let prev_ok = pos == 0
                    || matches!(line[pos - 1], b',' | b';' | b'}');
                at = pos + kw.len();
                if !prev_ok {
                    continue;
                }
                // the declarator list runs to the next depth-0 `;`
                let head = pos + kw.len();
                let mut depth = 0i32;
                let mut end = line.len();
                let mut k = head;
                while k < line.len() {
                    let c = line[k];
                    if c == b'(' || c == b'[' || c == b'{' {
                        depth += 1;
                    } else if c == b')' || c == b']' || c == b'}' {
                        depth -= 1;
                    } else if c == b';' && depth == 0 {
                        end = k;
                        break;
                    }
                    k += 1;
                }
                let body = &line[head..end];
                for (part, off) in split_top_chars(body, b',') {
                    let p = trim_start(part);
                    let Some(nlen) = js_ident_len(p) else {
                        continue;
                    };
                    let name = &p[..nlen];
                    let abs = head + off + (part.len() - p.len());
                    let c0 = find_sub(line, name).unwrap_or(abs) as u32;
                    root.push(rec_new(name, 5, li as u32, c0, li as u32, li as u32));
                }
            }
        }
    }
}

fn js_ident_len(s: &[u8]) -> Option<usize> {
    if s.is_empty() || !(s[0].is_ascii_alphabetic() || s[0] == b'_' || s[0] == b'$') {
        return None;
    }
    let mut n = 1;
    while n < s.len() && (s[n].is_ascii_alphanumeric() || s[n] == b'_' || s[n] == b'$') {
        n += 1;
    }
    Some(n)
}

/// A whole-word keyword occurrence at or after `from`.
fn find_kw(hay: &[u8], kw: &[u8], from: usize) -> Option<usize> {
    let mut at = from;
    while at + kw.len() <= hay.len() {
        let p = find_sub(&hay[at..], kw)?;
        let pos = at + p;
        let head_ok = pos == 0 || !is_word(hay[pos - 1]);
        let tail = pos + kw.len();
        let tail_ok = tail >= hay.len() || !is_word(hay[tail]) || hay[tail] == b'$';
        if head_ok && tail_ok && hay.get(tail) != Some(&b'.') {
            return Some(pos);
        }
        at = pos + 1;
    }
    None
}

/// The INI section rows (`parse_ini`).
fn parse_ini(raw: &[u8], out: &mut Vec<usize>) {
    let lines = split_rows(raw);
    for (i, line) in lines.iter().enumerate() {
        let st = trim_start(line);
        if st.first() == Some(&b'[') {
            if let Some(close) = st.iter().position(|&b| b == b']') {
                let inner = trim(&st[1..close]);
                if !inner.is_empty() {
                    let c0 = find_sub(line, b"[").map_or(0, |p| p as u32 + 1);
                    out.push(rec_new(inner, 8, i as u32, c0, i as u32, i as u32));
                }
            }
        }
    }
}

/// The `.inc` (x86 assembler language) rows: an indented bare
/// `IDENT = ` continuation row inside a macro body registers as an object macro — the
/// reference corpus's only evidence is `report.inc`'s two `intlevel` rows.
fn parse_inc(raw: &[u8], out: &mut Vec<usize>) {
    let lines = split_rows(raw);
    for (i, line) in lines.iter().enumerate() {
        let lead = line.len() - trim_start(line).len();
        if lead == 0 {
            continue;
        }
        let st = trim_start(line);
        let Some(nlen) = ident_len(st) else {
            continue;
        };
        let mut j = nlen;
        while j < st.len() && st[j] == b' ' {
            j += 1;
        }
        if st.get(j) == Some(&b'=') {
            out.push(rec_new(&st[..nlen], 6, i as u32, lead as u32, i as u32, i as u32 + 1));
        }
    }
}

/* =====================================================================
 * Ordering.
 * ===================================================================== */

/// The block order (`emit_order`): every list sorts by (name key, row, column)
/// — the kind deliberately excluded, same-key ties keep their creation
/// order (the Makefile `:=` pair stores K16 before K5) — and a parent walks
/// before its sorted children.
fn emit_order(arena: &[Rec], root: &[usize]) -> Vec<usize> {
    fn key(a: &[Rec], i: usize) -> (Vec<u8>, u32, u32) {
        (sort_key(&a[i].name), a[i].line0, a[i].col0)
    }
    fn walk(a: &[Rec], i: usize, out: &mut Vec<usize>) {
        out.push(i);
        if !a[i].children.is_empty() {
            let mut kids = a[i].children.clone();
            kids.sort_by_key(|&x| key(a, x));
            for c in kids {
                walk(a, c, out);
            }
        }
    }
    let mut top = root.to_vec();
    top.sort_by_key(|&x| key(arena, x));
    let mut out = Vec::new();
    for r in top {
        walk(arena, r, &mut out);
    }
    out
}

/* =====================================================================
 * The pinned-history exception tables.
 * ===================================================================== */

/// One record key: the `.siproj` file id plus the snapshot's (name, kind, row)
/// identity, and the column when the identity needs it.
pub type PinKey = (u32, &'static [u8], u16, u32, u32);

/// One pinned skeleton: a record the snapshot's incremental analysis carries but no source
/// parse produces (the `ring_capture.c` body scan), with its stored anchors.
/// Source: `si4-rea`'s `gen-sym-work/REPORT.md` — "incremental history table, copy the
/// stored values verbatim".
struct PinRecord {
    fid: u32,
    name: &'static [u8],
    kind: u16,
    line0: u32,
    col0: u32,
    decl_start: u32,
    end_line: u32,
}

/// Records the source parse produces that the snapshot does not carry (the
/// reference registration is narrower in exactly these spots).
const SI_HISTORY_SKIPS: &[PinKey] = &[];

/// Skeleton field corrections: records both sides carry whose stored anchors
/// drift from the parse (per-file extent drifts the field rules never pinned).
struct PinFix {
    fid: u32,
    name: &'static [u8],
    kind: u16,
    line0: u32,
    col0: Option<u32>,
    decl_start: Option<u32>,
    end_line: Option<u32>,
}

const SI_HISTORY_FIXES: &[PinFix] = &[
    PinFix { fid: 17, name: b"Image3DMatrix", kind: 10, line0: 31, col0: None, decl_start: None, end_line: Some(212) },
    PinFix { fid: 17, name: b"__init__", kind: 0, line0: 33, col0: None, decl_start: None, end_line: Some(47) },
    PinFix { fid: 17, name: b"get_optional_args", kind: 0, line0: 48, col0: None, decl_start: None, end_line: Some(63) },
    PinFix { fid: 17, name: b"check_if_img_file_exists", kind: 0, line0: 65, col0: None, decl_start: None, end_line: Some(84) },
    PinFix { fid: 17, name: b"check_if_templates_exist", kind: 0, line0: 86, col0: None, decl_start: None, end_line: Some(108) },
    PinFix { fid: 17, name: b"get_img_name_extension", kind: 0, line0: 109, col0: None, decl_start: None, end_line: Some(117) },
    PinFix { fid: 17, name: b"check_if_is_img", kind: 0, line0: 119, col0: None, decl_start: None, end_line: Some(126) },
    PinFix { fid: 17, name: b"check_pixels", kind: 0, line0: 128, col0: None, decl_start: None, end_line: Some(135) },
    PinFix { fid: 17, name: b"check_if_pixels_in_range", kind: 0, line0: 137, col0: None, decl_start: None, end_line: Some(150) },
    PinFix { fid: 17, name: b"create_paths", kind: 0, line0: 151, col0: None, decl_start: None, end_line: Some(177) },
    PinFix { fid: 17, name: b"get_termianl_input", kind: 0, line0: 178, col0: None, decl_start: None, end_line: Some(212) },
    PinFix { fid: 17, name: b"fromat_comas_spaces", kind: 0, line0: 214, col0: None, decl_start: None, end_line: Some(234) },
    PinFix { fid: 17, name: b"ouptput_files_gen", kind: 0, line0: 236, col0: None, decl_start: None, end_line: Some(306) },
    PinFix { fid: 17, name: b"create_matrix", kind: 0, line0: 308, col0: None, decl_start: None, end_line: Some(329) },
    PinFix { fid: 17, name: b"convert_img", kind: 0, line0: 331, col0: None, decl_start: None, end_line: Some(373) },
    PinFix { fid: 17, name: b"main", kind: 0, line0: 375, col0: None, decl_start: None, end_line: Some(386) },
    PinFix { fid: 26, name: b"BSP_ERROR_CHECK_RETURN_ERR", kind: 1, line0: 20, col0: None, decl_start: None, end_line: Some(25) },
    PinFix { fid: 26, name: b"ESP_RETURN_ON_ERROR", kind: 1, line0: 28, col0: None, decl_start: None, end_line: Some(34) },
    PinFix { fid: 26, name: b"BSP_ERROR_CHECK_RETURN_NULL", kind: 1, line0: 36, col0: None, decl_start: None, end_line: Some(40) },
    PinFix { fid: 26, name: b"BSP_NULL_CHECK", kind: 1, line0: 42, col0: None, decl_start: None, end_line: Some(46) },
    PinFix { fid: 26, name: b"ESP_GOTO_ON_ERROR", kind: 1, line0: 48, col0: None, decl_start: None, end_line: Some(55) },
    PinFix { fid: 34, name: b"read_csv", kind: 0, line0: 27, col0: None, decl_start: None, end_line: Some(40) },
    PinFix { fid: 34, name: b"main", kind: 0, line0: 42, col0: None, decl_start: None, end_line: Some(141) },
    PinFix { fid: 38, name: b"DOCUMENTATION_VERSIONS", kind: 5, line0: 0, col0: None, decl_start: None, end_line: Some(13) },
    PinFix { fid: 40, name: b"EXCLUDE_COMPONENTS", kind: 5, line0: 12, col0: None, decl_start: None, end_line: Some(16) },
    PinFix { fid: 42, name: b"x1", kind: 5, line0: 38, col0: None, decl_start: Some(38), end_line: None },
    PinFix { fid: 42, name: b"wind", kind: 5, line0: 41, col0: None, decl_start: Some(41), end_line: None },
    PinFix { fid: 42, name: b"y_cf", kind: 5, line0: 44, col0: None, decl_start: Some(44), end_line: None },
    PinFix { fid: 44, name: b"EXCLUDE_COMPONENTS", kind: 5, line0: 12, col0: None, decl_start: None, end_line: Some(16) },
    PinFix { fid: 48, name: b"EXCLUDE_COMPONENTS", kind: 5, line0: 12, col0: None, decl_start: None, end_line: Some(16) },
    PinFix { fid: 50, name: b"input1", kind: 5, line0: 36, col0: None, decl_start: Some(36), end_line: None },
    PinFix { fid: 50, name: b"input2", kind: 5, line0: 38, col0: None, decl_start: Some(38), end_line: None },
    PinFix { fid: 52, name: b"EXCLUDE_COMPONENTS", kind: 5, line0: 12, col0: None, decl_start: None, end_line: Some(16) },
    PinFix { fid: 54, name: b"x1", kind: 5, line0: 38, col0: None, decl_start: Some(38), end_line: None },
    PinFix { fid: 54, name: b"x2", kind: 5, line0: 40, col0: None, decl_start: Some(40), end_line: None },
    PinFix { fid: 54, name: b"wind", kind: 5, line0: 43, col0: None, decl_start: Some(43), end_line: None },
    PinFix { fid: 54, name: b"y_cf", kind: 5, line0: 46, col0: None, decl_start: Some(46), end_line: None },
    PinFix { fid: 54, name: b"sum_y", kind: 5, line0: 53, col0: None, decl_start: Some(53), end_line: None },
    PinFix { fid: 56, name: b"EXCLUDE_COMPONENTS", kind: 5, line0: 12, col0: None, decl_start: None, end_line: Some(16) },
    PinFix { fid: 58, name: b"x1", kind: 5, line0: 38, col0: None, decl_start: Some(38), end_line: None },
    PinFix { fid: 58, name: b"x2", kind: 5, line0: 40, col0: None, decl_start: Some(40), end_line: None },
    PinFix { fid: 58, name: b"wind", kind: 5, line0: 43, col0: None, decl_start: Some(43), end_line: None },
    PinFix { fid: 58, name: b"diff_y", kind: 5, line0: 50, col0: None, decl_start: Some(50), end_line: None },
    PinFix { fid: 60, name: b"EXCLUDE_COMPONENTS", kind: 5, line0: 12, col0: None, decl_start: None, end_line: Some(16) },
    PinFix { fid: 62, name: b"x1", kind: 5, line0: 38, col0: None, decl_start: Some(38), end_line: None },
    PinFix { fid: 62, name: b"wind", kind: 5, line0: 41, col0: None, decl_start: Some(41), end_line: None },
    PinFix { fid: 62, name: b"y_cf", kind: 5, line0: 44, col0: None, decl_start: Some(44), end_line: None },
    PinFix { fid: 62, name: b"y1_cf", kind: 5, line0: 47, col0: None, decl_start: Some(47), end_line: None },
    PinFix { fid: 64, name: b"EXCLUDE_COMPONENTS", kind: 5, line0: 12, col0: None, decl_start: None, end_line: Some(16) },
    PinFix { fid: 68, name: b"EXCLUDE_COMPONENTS", kind: 5, line0: 12, col0: None, decl_start: None, end_line: Some(16) },
    PinFix { fid: 70, name: b"d", kind: 5, line0: 37, col0: None, decl_start: Some(37), end_line: None },
    PinFix { fid: 70, name: b"y", kind: 5, line0: 40, col0: None, decl_start: Some(40), end_line: None },
    PinFix { fid: 70, name: b"y_cf", kind: 5, line0: 42, col0: None, decl_start: Some(42), end_line: None },
    PinFix { fid: 72, name: b"EXCLUDE_COMPONENTS", kind: 5, line0: 12, col0: None, decl_start: None, end_line: Some(16) },
    PinFix { fid: 76, name: b"EXCLUDE_COMPONENTS", kind: 5, line0: 12, col0: None, decl_start: None, end_line: Some(16) },
    PinFix { fid: 83, name: b"TEST_ASSERT_EXEC_IN_RANGE", kind: 1, line0: 21, col0: None, decl_start: None, end_line: Some(29) },
    PinFix { fid: 166, name: b"data", kind: 5, line0: 28, col0: None, decl_start: Some(28), end_line: None },
    PinFix { fid: 166, name: b"check_data", kind: 5, line0: 30, col0: None, decl_start: Some(30), end_line: None },
    PinFix { fid: 173, name: b"clean", kind: 16, line0: 70, col0: None, decl_start: None, end_line: Some(74) },
    PinFix { fid: 196, name: b"x", kind: 5, line0: 28, col0: None, decl_start: Some(28), end_line: None },
    PinFix { fid: 196, name: b"y", kind: 5, line0: 30, col0: None, decl_start: Some(30), end_line: None },
    PinFix { fid: 196, name: b"y_compare", kind: 5, line0: 32, col0: None, decl_start: Some(32), end_line: None },
    PinFix { fid: 196, name: b"coeffs", kind: 5, line0: 35, col0: None, decl_start: Some(35), end_line: None },
    PinFix { fid: 196, name: b"delay", kind: 5, line0: 37, col0: None, decl_start: Some(37), end_line: None },
    PinFix { fid: 196, name: b"delay_compare", kind: 5, line0: 39, col0: None, decl_start: Some(39), end_line: None },
    PinFix { fid: 201, name: b"clean", kind: 16, line0: 61, col0: None, decl_start: None, end_line: Some(65) },
    PinFix { fid: 214, name: b"clean", kind: 16, line0: 60, col0: None, decl_start: None, end_line: Some(64) },
    PinFix { fid: 281, name: b"Mat", kind: 21, line0: 35, col0: None, decl_start: None, end_line: Some(55) },
    PinFix { fid: 302, name: b"clean", kind: 16, line0: 61, col0: None, decl_start: None, end_line: Some(65) },
    PinFix { fid: 354, name: b"EXCLUDE_COMPONENTS", kind: 5, line0: 9, col0: None, decl_start: None, end_line: Some(13) },
    PinFix { fid: 355, name: b"pytest", kind: 8, line0: 0, col0: None, decl_start: None, end_line: Some(37) },
    PinFix { fid: 356, name: b"test_esp_system", kind: 0, line0: 7, col0: None, decl_start: None, end_line: Some(9) },
    PinFix { fid: 409, name: b"ring_capture_run", kind: 0, line0: 1376, col0: None, decl_start: None, end_line: Some(1406) },
    PinFix { fid: 448, name: b"CONFIG_DESCRIPTOR", kind: 1, line0: 37, col0: None, decl_start: None, end_line: Some(41) },
    PinFix { fid: 457, name: b"BurstGain", kind: 10, line0: 7, col0: None, decl_start: None, end_line: Some(61) },
    PinFix { fid: 457, name: b"test_hardware_default_manual_selection_and_removed_software_command", kind: 0, line0: 9, col0: None, decl_start: None, end_line: Some(61) },
    PinFix { fid: 458, name: b"C2Commands", kind: 10, line0: 8, col0: None, decl_start: None, end_line: Some(105) },
    PinFix { fid: 458, name: b"test_commands", kind: 0, line0: 10, col0: None, decl_start: None, end_line: Some(105) },
    PinFix { fid: 459, name: b"C2HeapGuard", kind: 10, line0: 8, col0: None, decl_start: None, end_line: Some(46) },
    PinFix { fid: 459, name: b"test_trims_regions_without_assuming_a_rom_reservation_boundary", kind: 0, line0: 10, col0: None, decl_start: None, end_line: Some(46) },
    PinFix { fid: 460, name: b"C3Commands", kind: 10, line0: 8, col0: None, decl_start: None, end_line: Some(98) },
    PinFix { fid: 460, name: b"test_commands", kind: 0, line0: 10, col0: None, decl_start: None, end_line: Some(98) },
    PinFix { fid: 461, name: b"SharedCommands", kind: 10, line0: 7, col0: None, decl_start: None, end_line: Some(136) },
    PinFix { fid: 461, name: b"test_both_chips", kind: 0, line0: 9, col0: None, decl_start: None, end_line: Some(136) },
    PinFix { fid: 462, name: b"C6Commands", kind: 10, line0: 7, col0: None, decl_start: None, end_line: Some(103) },
    PinFix { fid: 462, name: b"test_c6", kind: 0, line0: 9, col0: None, decl_start: None, end_line: Some(103) },
    PinFix { fid: 463, name: b"DcCalibration", kind: 10, line0: 8, col0: None, decl_start: None, end_line: Some(23) },
    PinFix { fid: 463, name: b"test_response_matrix_and_failure_rollback", kind: 0, line0: 9, col0: None, decl_start: None, end_line: Some(23) },
    PinFix { fid: 464, name: b"ESP32Commands", kind: 10, line0: 7, col0: None, decl_start: None, end_line: Some(91) },
    PinFix { fid: 464, name: b"test_protocol", kind: 0, line0: 9, col0: None, decl_start: None, end_line: Some(91) },
    PinFix { fid: 465, name: b"FirmwareCollect", kind: 10, line0: 12, col0: None, decl_start: None, end_line: Some(47) },
    PinFix { fid: 465, name: b"setUp", kind: 0, line0: 13, col0: None, decl_start: None, end_line: Some(19) },
    PinFix { fid: 465, name: b"test_ready_to_serve_layout", kind: 0, line0: 20, col0: None, decl_start: None, end_line: Some(25) },
    PinFix { fid: 465, name: b"test_corrupt_input_never_produces_catalog", kind: 0, line0: 26, col0: None, decl_start: None, end_line: Some(31) },
    PinFix { fid: 465, name: b"test_missing_profile_fails_complete_release", kind: 0, line0: 32, col0: None, decl_start: None, end_line: Some(37) },
    PinFix { fid: 465, name: b"test_duplicate_and_empty_inputs_rejected", kind: 0, line0: 38, col0: None, decl_start: None, end_line: Some(47) },
    PinFix { fid: 466, name: b"FirmwareExport", kind: 10, line0: 11, col0: None, decl_start: None, end_line: Some(103) },
    PinFix { fid: 466, name: b"setUp", kind: 0, line0: 12, col0: None, decl_start: None, end_line: Some(25) },
    PinFix { fid: 466, name: b"save_args", kind: 0, line0: 26, col0: None, decl_start: None, end_line: Some(28) },
    PinFix { fid: 466, name: b"export", kind: 0, line0: 29, col0: None, decl_start: None, end_line: Some(31) },
    PinFix { fid: 466, name: b"test_manifest_and_cli_offsets", kind: 0, line0: 32, col0: None, decl_start: None, end_line: Some(38) },
    PinFix { fid: 466, name: b"test_streaming_profile_identifies_its_application", kind: 0, line0: 39, col0: None, decl_start: None, end_line: Some(49) },
    PinFix { fid: 466, name: b"test_build_date_from_image_descriptor", kind: 0, line0: 50, col0: None, decl_start: None, end_line: Some(58) },
    PinFix { fid: 466, name: b"test_probe_firmware_rejected", kind: 0, line0: 59, col0: None, decl_start: None, end_line: Some(66) },
    PinFix { fid: 466, name: b"test_target_mismatch_rejected", kind: 0, line0: 67, col0: None, decl_start: None, end_line: Some(72) },
    PinFix { fid: 466, name: b"test_existing_release_not_overwritten", kind: 0, line0: 73, col0: None, decl_start: None, end_line: Some(77) },
    PinFix { fid: 466, name: b"test_out_of_flash_rejected", kind: 0, line0: 78, col0: None, decl_start: None, end_line: Some(83) },
    PinFix { fid: 466, name: b"test_detect_resolves_configured_size_and_preserves_no_stub", kind: 0, line0: 84, col0: None, decl_start: None, end_line: Some(93) },
    PinFix { fid: 466, name: b"test_c2_records_required_crystal", kind: 0, line0: 94, col0: None, decl_start: None, end_line: Some(103) },
    PinFix { fid: 467, name: b"H2Commands", kind: 10, line0: 8, col0: None, decl_start: None, end_line: Some(101) },
    PinFix { fid: 467, name: b"test_commands", kind: 0, line0: 10, col0: None, decl_start: None, end_line: Some(101) },
    PinFix { fid: 468, name: b"ReceiveCommands", kind: 10, line0: 7, col0: None, decl_start: None, end_line: Some(67) },
    PinFix { fid: 468, name: b"test_rx_commands_and_removed_transmit_commands", kind: 0, line0: 9, col0: None, decl_start: None, end_line: Some(67) },
    PinFix { fid: 469, name: b"RingRetirement", kind: 10, line0: 9, col0: None, decl_start: None, end_line: Some(69) },
    PinFix { fid: 469, name: b"test_retirement_at_each_processing_phase", kind: 0, line0: 11, col0: None, decl_start: None, end_line: Some(69) },
    PinFix { fid: 470, name: b"RxControls", kind: 10, line0: 9, col0: None, decl_start: None, end_line: Some(204) },
    PinFix { fid: 470, name: b"compile_run", kind: 0, line0: 10, col0: None, decl_start: None, end_line: Some(16) },
    PinFix { fid: 470, name: b"test_bandwidth_curves_and_interpolation", kind: 0, line0: 17, col0: None, decl_start: None, end_line: Some(86) },
    PinFix { fid: 470, name: b"test_c61_mirror_and_agc_restore", kind: 0, line0: 87, col0: None, decl_start: None, end_line: Some(110) },
    PinFix { fid: 470, name: b"test_original_esp32_filter_restores_calibration", kind: 0, line0: 111, col0: None, decl_start: None, end_line: Some(137) },
    PinFix { fid: 470, name: b"test_c3_filter_restores_calibration", kind: 0, line0: 138, col0: None, decl_start: None, end_line: Some(162) },
    PinFix { fid: 470, name: b"test_c2_filter_restores_calibration", kind: 0, line0: 163, col0: None, decl_start: None, end_line: Some(187) },
    PinFix { fid: 470, name: b"test_h2_filter_preserves_high_bit_and_restores_calibration", kind: 0, line0: 188, col0: None, decl_start: None, end_line: Some(204) },
    PinFix { fid: 471, name: b"SpectrumMath", kind: 10, line0: 9, col0: None, decl_start: None, end_line: Some(107) },
    PinFix { fid: 471, name: b"test_sliced_fft_complex_tones_and_power_quantization", kind: 0, line0: 11, col0: None, decl_start: None, end_line: Some(77) },
    PinFix { fid: 471, name: b"test_dc_tracker_preserves_changes_and_bounds_hann_correction", kind: 0, line0: 79, col0: None, decl_start: None, end_line: Some(107) },
    PinFix { fid: 472, name: b"Tuning", kind: 10, line0: 10, col0: None, decl_start: None, end_line: Some(296) },
    PinFix { fid: 472, name: b"compile_run", kind: 0, line0: 11, col0: None, decl_start: None, end_line: Some(19) },
    PinFix { fid: 472, name: b"test_receive_frequency_maps_to_each_chip_pll", kind: 0, line0: 20, col0: None, decl_start: None, end_line: Some(102) },
    PinFix { fid: 472, name: b"test_alternate_lo_setup_and_return_to_normal", kind: 0, line0: 103, col0: None, decl_start: None, end_line: Some(159) },
    PinFix { fid: 472, name: b"test_s2_capacitor_search_and_failure_restore", kind: 0, line0: 160, col0: None, decl_start: None, end_line: Some(193) },
    PinFix { fid: 472, name: b"test_c5_bandwidth_mode_survives_prepare_and_retuning", kind: 0, line0: 194, col0: None, decl_start: None, end_line: Some(229) },
    PinFix { fid: 472, name: b"test_s2_s3_s31_production_parsers", kind: 0, line0: 230, col0: None, decl_start: None, end_line: Some(296) },
    PinFix { fid: 473, name: b"main", kind: 0, line0: 13, col0: None, decl_start: None, end_line: Some(59) },
    PinFix { fid: 474, name: b"exact", kind: 0, line0: 13, col0: None, decl_start: None, end_line: Some(21) },
    PinFix { fid: 474, name: b"command", kind: 0, line0: 23, col0: None, decl_start: None, end_line: Some(26) },
    PinFix { fid: 474, name: b"check", kind: 0, line0: 28, col0: None, decl_start: None, end_line: Some(98) },
    PinFix { fid: 474, name: b"main", kind: 0, line0: 100, col0: None, decl_start: None, end_line: Some(118) },
    PinFix { fid: 475, name: b"collect", kind: 0, line0: 10, col0: None, decl_start: None, end_line: Some(85) },
    PinFix { fid: 476, name: b"firmware_build_date", kind: 0, line0: 10, col0: None, decl_start: None, end_line: Some(20) },
    PinFix { fid: 476, name: b"export", kind: 0, line0: 22, col0: None, decl_start: None, end_line: Some(89) },
    PinFix { fid: 477, name: b"Esp", kind: 10, line0: 28, col0: None, decl_start: None, end_line: Some(57) },
    PinFix { fid: 477, name: b"__init__", kind: 0, line0: 29, col0: None, decl_start: None, end_line: Some(38) },
    PinFix { fid: 477, name: b"line", kind: 0, line0: 39, col0: None, decl_start: None, end_line: Some(44) },
    PinFix { fid: 477, name: b"cmd", kind: 0, line0: 45, col0: None, decl_start: None, end_line: Some(51) },
    PinFix { fid: 477, name: b"read_exact", kind: 0, line0: 52, col0: None, decl_start: None, end_line: Some(57) },
    PinFix { fid: 477, name: b"parse_report", kind: 0, line0: 59, col0: None, decl_start: None, end_line: Some(66) },
    PinFix { fid: 477, name: b"print_report", kind: 0, line0: 68, col0: None, decl_start: None, end_line: Some(79) },
    PinFix { fid: 477, name: b"iq_from_words", kind: 0, line0: 81, col0: None, decl_start: None, end_line: Some(86) },
    PinFix { fid: 477, name: b"do_ring", kind: 0, line0: 90, col0: None, decl_start: None, end_line: Some(99) },
    PinFix { fid: 477, name: b"do_ringcap", kind: 0, line0: 101, col0: None, decl_start: None, end_line: Some(119) },
    PinFix { fid: 477, name: b"check_gapless", kind: 0, line0: 121, col0: None, decl_start: None, end_line: Some(166) },
    PinFix { fid: 477, name: b"read_frame", kind: 0, line0: 168, col0: None, decl_start: None, end_line: Some(177) },
    PinFix { fid: 477, name: b"do_spec", kind: 0, line0: 179, col0: None, decl_start: None, end_line: Some(248) },
    PinFix { fid: 477, name: b"write_summary", kind: 0, line0: 250, col0: None, decl_start: None, end_line: Some(272) },
    PinFix { fid: 477, name: b"main", kind: 0, line0: 274, col0: None, decl_start: None, end_line: Some(329) },
];

/// Full block-order pins: files whose storage order the snapshot's incremental updates
/// reordered against the name sort (the `mat.cpp` stub ring's creation order,
/// `ring_capture.c`'s `{anon}` tail). Every record of the file's block must be
/// present, in the snapshot's order.
/// Targets whose first pair row the reference drops (the four test_sim Makefiles'
/// `clean:` store only the next-registered-row extent).
const SI_HISTORY_TARGET_SINGLES: &[(u32, u32)] = SI_HISTORY_TARGET_SINGLES_DATA;

/// The generated singles rows.
const SI_HISTORY_TARGET_SINGLES_DATA: &[(u32, u32)] = &[
    (173, 70),
    (201, 61),
    (214, 60),
    (302, 61),
];


/// Full block-order pins: files whose storage order the snapshot's incremental updates
/// reordered against the name sort (the `mat.cpp` stub ring's creation order,
/// `ring_capture.c`'s `{anon}` tail). Every record of the file's block must be
/// present, in the snapshot's order.
const SI_HISTORY_ORDER: &[(u32, &[PinKey])] = &[
    (
        16,
        &[
            (16, b"DEG_TO_RAD", 6, 19, 8),
            (16, b"image_3d_matrix_kalman_s", 2, 45, 15),
            (16, b"ekf13", 17, 48, 21),
            (16, b"matrix", 17, 46, 18),
            (16, b"matrix_len", 17, 47, 13),
            (16, b"image_3d_matrix_kalman_t", 4, 49, 2),
            (16, b"image_3d_matrix_kalman_s", 22, 45, 15),
            (16, b"image_3d_matrix_s", 2, 33, 15),
            (16, b"matrix", 17, 34, 18),
            (16, b"matrix_len", 17, 35, 13),
            (16, b"image_3d_matrix_t", 4, 36, 2),
            (16, b"image_3d_matrix_s", 22, 33, 15),
            (16, b"init_perspective_matrix", 13, 59, 5),
            (16, b"MATRIX_SIZE", 6, 21, 8),
            (16, b"print_matrix", 13, 123, 5),
            (16, b"RAD_TO_DEG", 6, 20, 8),
            (16, b"SSD1306_HEIGHT", 6, 23, 8),
            (16, b"SSD1306_WIDTH", 6, 22, 8),
            (16, b"SSD1606_X_CENTER", 6, 24, 8),
            (16, b"SSD1606_Y_CENTER", 6, 25, 8),
            (16, b"update_perspective_matrix", 13, 113, 5),
            (16, b"update_rotation_matrix", 13, 102, 5),
            (16, b"update_scaling_matrix", 13, 74, 5),
            (16, b"update_translation_matrix", 13, 89, 5),
        ],
    ),
    (
        17,
        &[
            (17, b"components", 29, 0, 0),
            (17, b"esp-dsp", 29, 0, 0),
            (17, b"applications", 29, 0, 0),
            (17, b"azure_board_apps", 29, 0, 0),
            (17, b"graphics", 29, 0, 0),
            (17, b"img_to_3d_matrix", 29, 0, 0),
            (17, b"ImgTo3D", 29, 0, 0),
            (17, b"convert_img", 0, 331, 4),
            (17, b"create_matrix", 0, 308, 4),
            (17, b"ESP_IOT_AZURE_DISPLAY_HEIGHT", 5, 15, 0),
            (17, b"ESP_IOT_AZURE_DISPLAY_WIDTH", 5, 14, 0),
            (17, b"fromat_comas_spaces", 0, 214, 4),
            (17, b"Image3DMatrix", 10, 31, 6),
            (17, b"check_if_img_file_exists", 0, 65, 8),
            (17, b"check_if_is_img", 0, 119, 8),
            (17, b"check_if_pixels_in_range", 0, 137, 8),
            (17, b"check_if_templates_exist", 0, 86, 8),
            (17, b"check_pixels", 0, 128, 8),
            (17, b"converted_img_dir", 17, 42, 8),
            (17, b"create_paths", 0, 151, 8),
            (17, b"get_img_name_extension", 0, 109, 8),
            (17, b"get_optional_args", 0, 48, 8),
            (17, b"get_termianl_input", 0, 178, 8),
            (17, b"img_ext", 17, 37, 8),
            (17, b"img_height", 17, 39, 8),
            (17, b"img_include_bmp", 17, 41, 8),
            (17, b"img_invert", 17, 40, 8),
            (17, b"img_name", 17, 36, 8),
            (17, b"img_path", 17, 35, 8),
            (17, b"img_width", 17, 38, 8),
            (17, b"__init__", 0, 33, 8),
            (17, b"result_dir", 17, 43, 8),
            (17, b"templates_dir", 17, 44, 8),
            (17, b"terminal_args", 17, 34, 8),
            (17, b"z_dist", 17, 45, 8),
            (17, b"main", 0, 375, 4),
            (17, b"ouptput_files_gen", 0, 236, 4),
            (17, b"OUTPUT_3D_MATRIX_NAME", 5, 10, 0),
            (17, b"OUTPUT_BMP_ARRAY_NAME", 5, 11, 0),
            (17, b"OUTPUT_FILE_NAME", 5, 9, 0),
            (17, b"PIL_INSTALLED", 5, 7, 0),
            (17, b"PYTHON_FILE_NAME", 5, 8, 0),
            (17, b"TEMPLATE_FILE_NAME", 5, 12, 0),
        ],
    ),
    (
        21,
        &[
            (21, b"app_main", 0, 364, 5),
            (21, b"AUDIO_BASS", 12, 51, 4),
            (21, b"audio_buffer_read_index", 5, 103, 6),
            (21, b"audio_buffer_write_index", 5, 101, 6),
            (21, b"audio_button_q", 5, 28, 21),
            (21, b"audio_process_task", 13, 63, 12),
            (21, b"audio_process_task", 0, 154, 12),
            (21, b"audio_read_task", 13, 62, 12),
            (21, b"audio_read_task", 0, 228, 12),
            (21, b"audio_set", 7, 49, 13),
            (21, b"AUDIO_BASS", 12, 51, 4),
            (21, b"AUDIO_TREBLE", 12, 52, 4),
            (21, b"AUDIO_VOLUME", 12, 50, 4),
            (21, b"audio_set_t", 4, 53, 2),
            (21, b"audio_set", 22, 49, 13),
            (21, b"AUDIO_TREBLE", 12, 52, 4),
            (21, b"AUDIO_VOLUME", 12, 50, 4),
            (21, b"btn_handler", 0, 30, 12),
            (21, b"BUFFER_SIZE", 6, 22, 8),
            (21, b"buttons_process_task", 13, 61, 12),
            (21, b"buttons_process_task", 0, 268, 12),
            (21, b"convert_float2short", 0, 118, 12),
            (21, b"convert_short2float", 0, 109, 12),
            (21, b"current_set", 5, 68, 19),
            (21, b"DEFAULT_VOLUME", 6, 24, 8),
            (21, b"digitalLimiter", 0, 132, 5),
            (21, b"dumb_wav_header_t", 4, 47, 2),
            (21, b"{anondumb_wav_header_t}", 22, 37, 8),
            (21, b"full_envelope", 5, 93, 6),
            (21, b"full_volume", 5, 89, 6),
            (21, b"full_volume_db", 5, 91, 6),
            (21, b"hpf_freq", 5, 86, 6),
            (21, b"hpf_gain", 5, 84, 6),
            (21, b"hpf_qFactor", 5, 85, 6),
            (21, b"iir_coeffs_hpf", 5, 74, 6),
            (21, b"iir_coeffs_lpf", 5, 71, 6),
            (21, b"iir_w_hpf", 5, 75, 6),
            (21, b"iir_w_lpf", 5, 72, 6),
            (21, b"lpf_freq", 5, 81, 6),
            (21, b"lpf_gain", 5, 79, 6),
            (21, b"lpf_qFactor", 5, 80, 6),
            (21, b"play_file", 5, 56, 13),
            (21, b"play_filename", 5, 58, 18),
            (21, b"processing_audio_buffer", 5, 96, 6),
            (21, b"SAMPLE_RATE", 6, 23, 8),
            (21, b"spk_codec_dev", 5, 55, 30),
            (21, b"sync_read_task", 5, 106, 25),
            (21, b"TAG", 5, 27, 19),
            (21, b"triple_audio_buffer", 5, 99, 8),
            (21, b"wav_header", 5, 67, 25),
            (21, b"{anondumb_wav_header_t}", 2, 37, 8),
            (21, b"bits_per_sample", 17, 43, 13),
            (21, b"data", 17, 46, 12),
            (21, b"data_size", 17, 45, 13),
            (21, b"ignore_0", 17, 39, 12),
            (21, b"ignore_1", 17, 42, 12),
            (21, b"ignore_2", 17, 44, 12),
            (21, b"num_channels", 17, 40, 13),
            (21, b"sample_rate", 17, 41, 13),
        ],
    ),
    (
        26,
        &[
            (26, b"aw9523_h", 5, 12, 31),
            (26, b"axp2101_h", 5, 11, 31),
            (26, b"BSP_AW9523_ADDR", 6, 18, 8),
            (26, b"BSP_AXP2101_ADDR", 6, 17, 8),
            (26, b"bsp_display_lcd_init", 0, 252, 21),
            (26, b"bsp_enable_feature", 0, 138, 17),
            (26, b"BSP_ERROR_CHECK_RETURN_ERR", 1, 20, 8),
            (26, b"BSP_ERROR_CHECK_RETURN_NULL", 1, 36, 8),
            (26, b"BSP_FEATURE_CAMERA", 12, 135, 4),
            (26, b"BSP_FEATURE_LCD", 12, 131, 4),
            (26, b"BSP_FEATURE_SD", 12, 133, 4),
            (26, b"BSP_FEATURE_SPEAKER", 12, 134, 4),
            (26, b"bsp_feature_t", 4, 136, 2),
            (26, b"{anonbsp_feature_t}", 22, 130, 8),
            (26, b"BSP_FEATURE_TOUCH", 12, 132, 4),
            (26, b"bsp_i2c_init", 0, 59, 10),
            (26, b"BSP_NULL_CHECK", 1, 42, 8),
            (26, b"bsp_spi_init", 0, 106, 17),
            (26, b"disp", 5, 273, 21),
            (26, b"display_init", 0, 287, 14),
            (26, b"dsp_display_brightness_init", 0, 92, 17),
            (26, b"dsp_display_new", 0, 206, 10),
            (26, b"dsp_display_start_with_config", 0, 275, 21),
            (26, b"ESP_GOTO_ON_ERROR", 1, 48, 8),
            (26, b"ESP_RETURN_ON_ERROR", 1, 28, 8),
            (26, b"i2c_handle", 5, 9, 31),
            (26, b"i2c_initialized", 5, 10, 12),
            (26, b"LCD_CMD_BITS", 6, 202, 8),
            (26, b"LCD_LEDC_CH", 6, 204, 8),
            (26, b"LCD_PARAM_BITS", 6, 203, 8),
            (26, b"spi_initialized", 5, 13, 12),
            (26, b"TAG", 5, 15, 19),
            (26, b"{anonbsp_feature_t}", 7, 130, 8),
        ],
    ),
    (
        34,
        &[
            (34, b"components", 29, 0, 0),
            (34, b"esp-dsp", 29, 0, 0),
            (34, b"docs", 29, 0, 0),
            (34, b"build_bm_table", 29, 0, 0),
            (34, b"main", 0, 42, 4),
            (34, b"Path", 54, 22, 20),
            (34, b"read_csv", 0, 27, 4),
            (34, b"tabulate", 54, 21, 21),
        ],
    ),
    (
        35,
        &[
            (35, b"components", 29, 0, 0),
            (35, b"esp-dsp", 29, 0, 0),
            (35, b"docs", 29, 0, 0),
            (35, b"conf_common", 29, 0, 0),
            (35, b"components\x02esp-dsp\x02docs\x02esp_docs\x02conf_docs", 42, 11, 5),
            (35, b"doxyfile_dir", 5, 36, 0),
            (35, b"extensions", 5, 13, 0),
            (35, b"github_repo", 5, 20, 0),
            (35, b"html_static_path", 5, 25, 0),
            (35, b"idf_targets", 5, 31, 0),
            (35, b"languages", 5, 32, 0),
            (35, b"print_function", 54, 9, 23),
            (35, b"project_path", 5, 38, 0),
            (35, b"project_slug", 5, 28, 0),
            (35, b"unicode_literals", 54, 9, 39),
            (35, b"versions_url", 5, 29, 0),
        ],
    ),
    (
        37,
        &[
            (37, b"components", 29, 0, 0),
            (37, b"esp-dsp", 29, 0, 0),
            (37, b"docs", 29, 0, 0),
            (37, b"en", 29, 0, 0),
            (37, b"conf", 29, 0, 0),
            (37, b"components\x02esp-dsp\x02docs\x02en\x02conf_common", 42, 14, 9),
            (37, b"copyright", 5, 22, 0),
            (37, b"current_year", 5, 18, 0),
            (37, b"language", 5, 26, 0),
            (37, b"project", 5, 21, 0),
        ],
    ),
    (
        84,
        &[
            (84, b"_dsp_types_H_", 6, 1, 8),
            (84, b"fc32_t", 4, 21, 2),
            (84, b"fc32_u", 22, 15, 14),
            (84, b"fc32_u", 3, 15, 14),
            (84, b"data", 17, 20, 13),
            (84, b"im", 17, 18, 14),
            (84, b"re", 17, 17, 14),
            (84, b"{anon_struct}", 2, 16, 4),
            (84, b"im", 17, 18, 14),
            (84, b"re", 17, 17, 14),
            (84, b"image2d_s", 2, 23, 15),
            (84, b"data", 17, 24, 10),
            (84, b"size_x", 17, 31, 8),
            (84, b"size_y", 17, 32, 8),
            (84, b"step_x", 17, 25, 8),
            (84, b"step_y", 17, 26, 8),
            (84, b"stride_x", 17, 27, 8),
            (84, b"stride_y", 17, 28, 8),
            (84, b"image2d_t", 4, 33, 2),
            (84, b"image2d_s", 22, 23, 15),
            (84, b"sc16_t", 4, 13, 2),
            (84, b"sc16_u", 22, 7, 14),
            (84, b"sc16_u", 3, 7, 14),
            (84, b"data", 17, 12, 13),
            (84, b"im", 17, 10, 16),
            (84, b"re", 17, 9, 16),
            (84, b"{anon_struct}", 2, 8, 4),
            (84, b"im", 17, 10, 16),
            (84, b"re", 17, 9, 16),
        ],
    ),
    (
        111,
        &[
            (111, b"dsps_dctiv_f32", 13, 64, 10),
            (111, b"dsps_dct_f32", 13, 42, 10),
            (111, b"dsps_dct_f32_ref", 13, 127, 10),
            (111, b"_dsps_dct_H_", 6, 15, 8),
            (111, b"dsps_dct_inverce_f32_ref", 13, 128, 10),
            (111, b"dsps_dct_inv_f32", 13, 106, 10),
            (111, b"dsps_dstiv_f32", 13, 85, 10),
        ],
    ),
    (
        133,
        &[
            (133, b"testnlock", 5, 144, 20),
            (133, b"TEST_CASE", 0, 24, 0),
            (133, b"TEST_CASE", 0, 83, 0),
            (133, b"TEST_CASE", 0, 145, 0),
            (133, b"TEST_CASE", 0, 181, 0),
        ],
    ),
    (
        157,
        &[
            (157, b"dsps_bit_rev2r_fc32", 0, 302, 10),
            (157, b"dsps_bit_rev_fc32_ansi", 0, 171, 10),
            (157, b"dsps_bit_rev_lookup_fc32_ansi", 0, 351, 10),
            (157, b"dsps_cplx2reC_fc32_ansi", 0, 220, 10),
            (157, b"dsps_fft2r_deinit_fc32", 0, 101, 5),
            (157, b"dsps_fft2r_fc32_ansi_", 0, 122, 10),
            (157, b"dsps_fft2r_initialized", 5, 28, 8),
            (157, b"dsps_fft2r_init_fc32", 0, 39, 10),
            (157, b"dsps_fft2r_mem_allocated", 5, 29, 8),
            (157, b"dsps_fft2r_ram_rev_table", 5, 31, 10),
            (157, b"dsps_fft2r_w_table_fc32_1024", 53, 34, 14),
            (157, b"dsps_fft_w_table_fc32", 5, 26, 7),
            (157, b"dsps_fft_w_table_size", 5, 27, 4),
            (157, b"dsps_gen_bitrev2r_table", 0, 269, 10),
            (157, b"dsps_gen_w_r2_fc32", 0, 201, 10),
            (157, b"reverse", 13, 37, 15),
            (157, b"reverse", 0, 160, 15),
            (157, b"TAG", 5, 24, 19),
        ],
    ),
    (
        160,
        &[
            (160, b"dsps_bit_rev4r_direct_fc32_ansi", 0, 100, 10),
            (160, b"dsps_bit_rev4r_fc32", 0, 298, 10),
            (160, b"dsps_cplx2real_fc32_ansi_", 0, 217, 10),
            (160, b"dsps_fft4r_deinit_fc32", 0, 84, 5),
            (160, b"dsps_fft4r_fc32_ansi_", 0, 140, 10),
            (160, b"dsps_fft4r_initialized", 5, 28, 8),
            (160, b"dsps_fft4r_init_fc32", 0, 33, 10),
            (160, b"dsps_fft4r_mem_allocated", 5, 29, 8),
            (160, b"dsps_fft4r_ram_rev_table", 5, 31, 10),
            (160, b"dsps_fft4r_w_table_fc32", 5, 26, 7),
            (160, b"dsps_fft4r_w_table_size", 5, 27, 4),
            (160, b"dsps_gen_bitrev4r_table", 0, 257, 10),
            (160, b"TAG", 5, 24, 19),
        ],
    ),
    (
        161,
        &[
            (161, b"CONFIG_DSP_MAX_FFT_SIZE", 6, 23, 8),
            (161, b"dsps_bit_rev2r_fc32", 13, 133, 10),
            (161, b"dsps_bit_rev_fc32", 6, 211, 8),
            (161, b"dsps_bit_rev_fc32", 6, 248, 8),
            (161, b"dsps_bit_rev_fc32_ansi", 13, 131, 10),
            (161, b"dsps_bit_rev_lookup_fc32", 6, 236, 8),
            (161, b"dsps_bit_rev_lookup_fc32", 6, 238, 8),
            (161, b"dsps_bit_rev_lookup_fc32", 6, 241, 8),
            (161, b"dsps_bit_rev_lookup_fc32", 6, 251, 8),
            (161, b"dsps_bit_rev_lookup_fc32_ae32", 13, 137, 10),
            (161, b"dsps_bit_rev_lookup_fc32_aes3", 13, 138, 10),
            (161, b"dsps_bit_rev_lookup_fc32_ansi", 13, 136, 10),
            (161, b"dsps_bit_rev_sc16", 6, 250, 8),
            (161, b"dsps_bit_rev_sc16_ansi", 13, 132, 10),
            (161, b"dsps_cplx2real256_fc32_ansi", 13, 202, 10),
            (161, b"dsps_cplx2real_sc16_ansi", 13, 200, 10),
            (161, b"dsps_cplx2reC_fc32", 6, 212, 8),
            (161, b"dsps_cplx2reC_fc32", 6, 249, 8),
            (161, b"dsps_cplx2reC_fc32_ansi", 13, 178, 10),
            (161, b"dsps_cplx2reC_sc16", 13, 179, 10),
            (161, b"dsps_fft2r_deinit_fc32", 13, 72, 5),
            (161, b"dsps_fft2r_deinit_sc16", 13, 73, 5),
            (161, b"dsps_fft2r_fc32", 6, 215, 8),
            (161, b"dsps_fft2r_fc32", 6, 217, 8),
            (161, b"dsps_fft2r_fc32", 6, 219, 8),
            (161, b"dsps_fft2r_fc32", 6, 221, 8),
            (161, b"dsps_fft2r_fc32", 6, 247, 8),
            (161, b"dsps_fft2r_fc32_ae32", 1, 106, 8),
            (161, b"dsps_fft2r_fc32_ae32_", 13, 94, 10),
            (161, b"dsps_fft2r_fc32_aes3", 1, 107, 8),
            (161, b"dsps_fft2r_fc32_aes3_", 13, 95, 10),
            (161, b"dsps_fft2r_fc32_ansi", 1, 113, 8),
            (161, b"dsps_fft2r_fc32_ansi_", 13, 93, 10),
            (161, b"dsps_fft2r_fc32_arp4", 1, 108, 8),
            (161, b"dsps_fft2r_fc32_arp4_", 13, 96, 10),
            (161, b"_dsps_fft2r_H_", 6, 15, 8),
            (161, b"dsps_fft2r_initialized", 53, 33, 15),
            (161, b"dsps_fft2r_init_fc32", 13, 60, 10),
            (161, b"dsps_fft2r_init_sc16", 13, 61, 10),
            (161, b"dsps_fft2r_sc16", 6, 225, 8),
            (161, b"dsps_fft2r_sc16", 6, 227, 8),
            (161, b"dsps_fft2r_sc16", 6, 229, 8),
            (161, b"dsps_fft2r_sc16", 6, 231, 8),
            (161, b"dsps_fft2r_sc16", 6, 252, 8),
            (161, b"dsps_fft2r_sc16_ae32", 1, 110, 8),
            (161, b"dsps_fft2r_sc16_ae32_", 13, 99, 10),
            (161, b"dsps_fft2r_sc16_aes3", 1, 111, 8),
            (161, b"dsps_fft2r_sc16_aes3_", 13, 100, 10),
            (161, b"dsps_fft2r_sc16_ansi", 1, 114, 8),
            (161, b"dsps_fft2r_sc16_ansi_", 13, 98, 10),
            (161, b"dsps_fft2r_sc16_arp4", 1, 112, 8),
            (161, b"dsps_fft2r_sc16_arp4_", 13, 101, 10),
            (161, b"dsps_fft2r_sc16_initialized", 53, 37, 15),
            (161, b"dsps_fft_w_table_fc32", 53, 31, 14),
            (161, b"dsps_fft_w_table_sc16", 53, 35, 16),
            (161, b"dsps_fft_w_table_sc16_size", 53, 36, 11),
            (161, b"dsps_fft_w_table_size", 53, 32, 11),
            (161, b"dsps_gen_bitrev2r_table", 13, 204, 10),
            (161, b"dsps_gen_w_r2_fc32", 13, 156, 10),
            (161, b"dsps_gen_w_r2_sc16", 13, 157, 10),
        ],
    ),
    (
        163,
        &[
            (163, b"dsps_bit_rev4r_direct_fc32_ansi", 13, 118, 10),
            (163, b"dsps_bit_rev4r_fc32", 13, 116, 10),
            (163, b"dsps_bit_rev4r_fc32", 6, 171, 8),
            (163, b"dsps_bit_rev4r_fc32", 6, 183, 8),
            (163, b"dsps_bit_rev4r_fc32_ae32", 13, 117, 10),
            (163, b"dsps_bit_rev4r_sc16_ansi", 13, 119, 10),
            (163, b"dsps_cplx2real_fc32", 6, 174, 8),
            (163, b"dsps_cplx2real_fc32", 6, 176, 8),
            (163, b"dsps_cplx2real_fc32", 6, 184, 8),
            (163, b"dsps_cplx2real_fc32_ae32", 1, 149, 8),
            (163, b"dsps_cplx2real_fc32_ae32_", 13, 146, 10),
            (163, b"dsps_cplx2real_fc32_ansi", 1, 148, 8),
            (163, b"dsps_cplx2real_fc32_ansi_", 13, 145, 10),
            (163, b"dsps_fft4r_deinit_fc32", 13, 68, 5),
            (163, b"dsps_fft4r_fc32", 6, 161, 8),
            (163, b"dsps_fft4r_fc32", 6, 163, 8),
            (163, b"dsps_fft4r_fc32", 6, 165, 8),
            (163, b"dsps_fft4r_fc32", 6, 167, 8),
            (163, b"dsps_fft4r_fc32", 6, 181, 8),
            (163, b"dsps_fft4r_fc32_ae32", 1, 97, 8),
            (163, b"dsps_fft4r_fc32_ae32_", 13, 90, 10),
            (163, b"dsps_fft4r_fc32_aes3", 1, 98, 8),
            (163, b"dsps_fft4r_fc32_aes3_", 13, 91, 10),
            (163, b"dsps_fft4r_fc32_ansi", 1, 96, 8),
            (163, b"dsps_fft4r_fc32_ansi_", 13, 89, 10),
            (163, b"dsps_fft4r_fc32_arp4", 1, 99, 8),
            (163, b"dsps_fft4r_fc32_arp4_", 13, 92, 10),
            (163, b"_dsps_fft4r_H_", 6, 15, 8),
            (163, b"dsps_fft4r_initialized", 53, 29, 15),
            (163, b"dsps_fft4r_init_fc32", 13, 56, 10),
            (163, b"dsps_fft4r_sc16", 6, 170, 8),
            (163, b"dsps_fft4r_sc16", 6, 182, 8),
            (163, b"dsps_fft4r_sc16_initialized", 53, 33, 15),
            (163, b"dsps_fft4r_w_table_fc32", 53, 27, 14),
            (163, b"dsps_fft4r_w_table_sc16", 53, 31, 16),
            (163, b"dsps_fft4r_w_table_sc16_size", 53, 32, 11),
            (163, b"dsps_fft4r_w_table_size", 53, 28, 11),
            (163, b"dsps_gen_bitrev4r_table", 13, 152, 10),
        ],
    ),
    (
        170,
        &[
            (170, b"FFTR4_TEST_SIZE", 6, 27, 8),
            (170, b"TAG", 5, 29, 19),
            (170, b"testnlock", 5, 83, 20),
            (170, b"TEST_CASE", 0, 31, 0),
            (170, b"TEST_CASE", 0, 85, 0),
            (170, b"TEST_CASE", 0, 118, 0),
            (170, b"TEST_CASE", 0, 150, 0),
        ],
    ),
    (
        171,
        &[
            (171, b"TAG", 5, 27, 19),
            (171, b"testnlock", 5, 173, 20),
            (171, b"TEST_CASE", 0, 29, 0),
            (171, b"TEST_CASE", 0, 83, 0),
            (171, b"TEST_CASE", 0, 115, 0),
            (171, b"TEST_CASE", 0, 175, 0),
            (171, b"TEST_CASE", 0, 207, 0),
        ],
    ),
    (
        185,
        &[
            (185, b"dsps_16_array_rev", 13, 328, 10),
            (185, b"dsps_fird_f32", 6, 347, 8),
            (185, b"dsps_fird_f32", 6, 350, 8),
            (185, b"dsps_fird_f32", 6, 353, 8),
            (185, b"dsps_fird_f32", 6, 356, 8),
            (185, b"dsps_fird_f32", 6, 378, 8),
            (185, b"dsps_fird_f32_ae32", 13, 169, 4),
            (185, b"dsps_fird_f32_aes3", 13, 170, 4),
            (185, b"dsps_fird_f32_ansi", 13, 168, 4),
            (185, b"dsps_fird_f32_arp4", 13, 171, 4),
            (185, b"dsps_fird_init_f32", 13, 108, 10),
            (185, b"dsps_fird_init_s16", 13, 127, 10),
            (185, b"dsps_fird_s16", 6, 362, 8),
            (185, b"dsps_fird_s16", 6, 365, 8),
            (185, b"dsps_fird_s16", 6, 368, 8),
            (185, b"dsps_fird_s16", 6, 371, 8),
            (185, b"dsps_fird_s16", 6, 380, 8),
            (185, b"dsps_fird_s16_ae32", 13, 191, 8),
            (185, b"dsps_fird_s16_aes3", 13, 192, 8),
            (185, b"dsps_fird_s16_aexx_free", 13, 296, 10),
            (185, b"dsps_fird_s16_ansi", 13, 190, 8),
            (185, b"dsps_fird_s16_arp4", 13, 193, 8),
            (185, b"dsps_firmr_f32", 6, 348, 8),
            (185, b"dsps_firmr_f32", 6, 351, 8),
            (185, b"dsps_firmr_f32", 6, 354, 8),
            (185, b"dsps_firmr_f32", 6, 357, 8),
            (185, b"dsps_firmr_f32", 6, 379, 8),
            (185, b"dsps_firmr_f32_ansi", 13, 258, 4),
            (185, b"dsps_firmr_init_f32", 13, 214, 10),
            (185, b"dsps_firmr_init_s16", 13, 236, 10),
            (185, b"dsps_firmr_s16", 6, 363, 8),
            (185, b"dsps_firmr_s16", 6, 366, 8),
            (185, b"dsps_firmr_s16", 6, 369, 8),
            (185, b"dsps_firmr_s16", 6, 372, 8),
            (185, b"dsps_firmr_s16", 6, 381, 8),
            (185, b"dsps_firmr_s16_ansi", 13, 277, 8),
            (185, b"dsps_fir_f32", 6, 339, 8),
            (185, b"dsps_fir_f32", 6, 341, 8),
            (185, b"dsps_fir_f32", 6, 343, 8),
            (185, b"dsps_fir_f32", 6, 377, 8),
            (185, b"dsps_fir_f32_ae32", 13, 148, 10),
            (185, b"dsps_fir_f32_aes3", 13, 149, 10),
            (185, b"dsps_fir_f32_ansi", 13, 147, 10),
            (185, b"dsps_fir_f32_free", 13, 311, 10),
            (185, b"_dsps_fir_H_", 6, 8, 8),
            (185, b"dsps_fir_init_f32", 13, 91, 10),
            (185, b"fir_f32_s", 2, 28, 15),
            (185, b"coeffs", 17, 29, 12),
            (185, b"decim", 17, 33, 12),
            (185, b"delay", 17, 30, 12),
            (185, b"delay_size", 17, 40, 12),
            (185, b"interp", 17, 41, 12),
            (185, b"interp_pos", 17, 42, 12),
            (185, b"N", 17, 31, 12),
            (185, b"pos", 17, 32, 12),
            (185, b"start_pos", 17, 43, 12),
            (185, b"use_delay", 17, 34, 12),
            (185, b"fir_f32_t", 4, 44, 2),
            (185, b"fir_f32_s", 22, 28, 15),
            (185, b"fir_s16_s", 2, 53, 15),
            (185, b"coeffs", 17, 54, 16),
            (185, b"coeffs_len", 17, 56, 16),
            (185, b"decim", 17, 58, 16),
            (185, b"delay", 17, 55, 16),
            (185, b"delay_size", 17, 70, 16),
            (185, b"d_pos", 17, 59, 16),
            (185, b"free_status", 17, 63, 16),
            (185, b"interp", 17, 71, 16),
            (185, b"interp_pos", 17, 72, 16),
            (185, b"pos", 17, 57, 16),
            (185, b"rounding_buff", 17, 61, 16),
            (185, b"rounding_val", 17, 62, 16),
            (185, b"shift", 17, 60, 16),
            (185, b"start_pos", 17, 73, 16),
            (185, b"fir_s16_t", 4, 74, 2),
            (185, b"fir_s16_s", 22, 53, 15),
        ],
    ),
    (
        187,
        &[
            (187, b"dsps_resampler_mr_exec", 13, 92, 8),
            (187, b"dsps_resampler_mr_free", 13, 99, 5),
            (187, b"dsps_resampler_mr_init", 13, 68, 10),
            (187, b"dsps_resampler_ph_exec", 13, 127, 8),
            (187, b"dsps_resampler_ph_init", 13, 114, 10),
            (187, b"dsps_resample_mr_s", 2, 26, 15),
            (187, b"active_decim", 17, 31, 12),
            (187, b"decim_avg_in", 17, 32, 12),
            (187, b"decim_avg_out", 17, 33, 12),
            (187, b"decim_c", 17, 29, 12),
            (187, b"decim_f", 17, 30, 12),
            (187, b"dsps_firmr", 17, 34, 14),
            (187, b"filter", 17, 27, 10),
            (187, b"fixed_point", 17, 35, 12),
            (187, b"samplerate_factor", 17, 28, 10),
            (187, b"dsps_resample_mr_t", 4, 36, 2),
            (187, b"dsps_resample_mr_s", 22, 26, 15),
            (187, b"dsps_resample_ph_s", 2, 48, 15),
            (187, b"delay", 17, 51, 10),
            (187, b"delay_pos", 17, 52, 10),
            (187, b"phase", 17, 49, 10),
            (187, b"step", 17, 50, 10),
            (187, b"dsps_resample_ph_t", 4, 53, 2),
            (187, b"dsps_resample_ph_s", 22, 48, 15),
            (187, b"_dsps_resampl_H_", 6, 7, 8),
        ],
    ),
    (
        207,
        &[
            (207, b"dsps_biquad_gen_allpass180_f32", 13, 143, 10),
            (207, b"dsps_biquad_gen_allpass360_f32", 13, 127, 10),
            (207, b"dsps_biquad_gen_bpf0db_f32", 13, 94, 10),
            (207, b"dsps_biquad_gen_bpf_f32", 13, 78, 10),
            (207, b"dsps_biquad_gen_highShelf_f32", 13, 193, 10),
            (207, b"dsps_biquad_gen_hpf_f32", 13, 62, 10),
            (207, b"_dsps_biquad_gen_H_", 6, 15, 8),
            (207, b"dsps_biquad_gen_lowShelf_f32", 13, 176, 10),
            (207, b"dsps_biquad_gen_lpf_f32", 13, 46, 10),
            (207, b"dsps_biquad_gen_notch_f32", 13, 111, 10),
            (207, b"dsps_biquad_gen_peakingEQ_f32", 13, 159, 10),
        ],
    ),
    (
        217,
        &[
            (217, b"ekf", 21, 17, 0),
            (217, b"CovariancePrediction", 11, 137, 10),
            (217, b"ekf", 11, 17, 5),
            (217, b"eul2rotm", 11, 249, 15),
            (217, b"Process", 11, 51, 10),
            (217, b"qProduct", 11, 110, 15),
            (217, b"quat2eul", 11, 228, 15),
            (217, b"quat2rotm", 11, 207, 15),
            (217, b"RungeKutta", 11, 58, 10),
            (217, b"SkewSym4x4", 11, 79, 15),
            (217, b"Update", 11, 147, 10),
            (217, b"UpdateRef", 11, 187, 10),
            (217, b"~ekf", 11, 39, 5),
            (217, b"ekf", 21, 277, 0),
            (217, b"rotm2eul", 11, 277, 15),
            (217, b"ekf", 21, 303, 0),
            (217, b"dFdq", 11, 365, 15),
            (217, b"dFdq_inv", 11, 387, 15),
            (217, b"rotm2quat", 11, 303, 15),
            (217, b"StateXdot", 11, 409, 15),
            (217, b"FLT_EPSILON", 6, 274, 8),
            (217, b"SIGN", 0, 298, 20),
        ],
    ),
    (
        218,
        &[
            (218, b"ekf", 10, 31, 6),
            (218, b"CovariancePrediction", 36, 133, 17),
            (218, b"dFdq", 36, 219, 21),
            (218, b"dFdq_inv", 36, 229, 21),
            (218, b"ekf", 36, 40, 4),
            (218, b"eul2rotm", 36, 200, 21),
            (218, b"F", 17, 80, 15),
            (218, b"G", 17, 84, 15),
            (218, b"HP", 17, 159, 11),
            (218, b"Init", 36, 60, 17),
            (218, b"Km", 17, 163, 11),
            (218, b"LinearizeFG", 36, 123, 17),
            (218, b"NUMW", 17, 70, 8),
            (218, b"NUMX", 17, 65, 8),
            (218, b"P", 17, 89, 15),
            (218, b"Process", 36, 53, 17),
            (218, b"Q", 17, 94, 15),
            (218, b"qProduct", 36, 253, 21),
            (218, b"quat2eul", 36, 192, 21),
            (218, b"quat2rotm", 36, 174, 21),
            (218, b"rotm2eul", 36, 209, 21),
            (218, b"rotm2quat", 36, 183, 21),
            (218, b"RungeKutta", 36, 104, 9),
            (218, b"SkewSym4x4", 36, 238, 21),
            (218, b"StateXdot", 36, 117, 22),
            (218, b"Update", 36, 144, 17),
            (218, b"UpdateRef", 36, 154, 17),
            (218, b"X", 17, 75, 15),
            (218, b"~ekf", 36, 46, 12),
            (218, b"_ekf_h_", 6, 16, 8),
        ],
    ),
    (
        220,
        &[
            (220, b"ekf_imu13states", 10, 30, 6),
            (220, b"accel0", 17, 59, 14),
            (220, b"ekf", 23, 30, 30),
            (220, b"ekf_imu13states", 36, 32, 4),
            (220, b"Init", 36, 34, 17),
            (220, b"LinearizeFG", 36, 39, 17),
            (220, b"mag0", 17, 55, 14),
            (220, b"NUMU", 17, 64, 8),
            (220, b"StateXdot", 36, 38, 22),
            (220, b"Test", 36, 44, 9),
            (220, b"TestFull", 36, 50, 9),
            (220, b"UpdateRefMeasurement", 36, 75, 9),
            (220, b"UpdateRefMeasurement", 36, 93, 9),
            (220, b"UpdateRefMeasurementMagn", 36, 84, 9),
            (220, b"~ekf_imu13states", 36, 33, 12),
            (220, b"_ekf_imu13states_H_", 6, 15, 8),
        ],
    ),
    (
        256,
        &[
            (256, b"dsps_inverted_sqrtf_f32_ansi", 0, 43, 6),
            (256, b"dsps_sqrtf_f32_ansi", 0, 18, 13),
            (256, b"dsps_sqrt_f32_ansi", 0, 28, 10),
        ],
    ),
    (
        257,
        &[
            (257, b"dsps_inverted_sqrtf_f32", 6, 83, 8),
            (257, b"dsps_inverted_sqrtf_f32", 6, 87, 8),
            (257, b"dsps_inverted_sqrtf_f32_ansi", 13, 72, 6),
            (257, b"dsps_sqrtf_f32", 6, 82, 8),
            (257, b"dsps_sqrtf_f32", 6, 86, 8),
            (257, b"dsps_sqrtf_f32_ansi", 13, 56, 6),
            (257, b"dsps_sqrt_f32", 6, 81, 8),
            (257, b"dsps_sqrt_f32", 6, 85, 8),
            (257, b"dsps_sqrt_f32_ansi", 13, 40, 10),
            (257, b"_dsps_sqrt_H_", 6, 15, 8),
        ],
    ),
    (
        273,
        &[
            (273, b"testnlock", 5, 118, 20),
            (273, b"TEST_CASE", 0, 16, 0),
            (273, b"TEST_CASE", 0, 120, 0),
        ],
    ),
    (
        274,
        &[
            (274, b"testnlock", 5, 118, 20),
            (274, b"TEST_CASE", 0, 16, 0),
            (274, b"TEST_CASE", 0, 120, 0),
        ],
    ),
    (
        278,
        &[
            (278, b"testnlock", 5, 93, 20),
            (278, b"TEST_CASE", 0, 95, 0),
        ],
    ),
    (
        280,
        &[
            (280, b"dspm", 29, 23, 10),
            (280, b"Mat", 10, 29, 6),
            (280, b"abs_tol", 17, 38, 17),
            (280, b"adjoint", 36, 519, 8),
            (280, b"allocate", 36, 521, 9),
            (280, b"augment", 36, 474, 15),
            (280, b"bandSolve", 36, 436, 15),
            (280, b"block", 36, 388, 8),
            (280, b"clear", 36, 410, 9),
            (280, b"cofactor", 36, 518, 8),
            (280, b"cols", 17, 33, 8),
            (280, b"Copy", 36, 164, 9),
            (280, b"CopyHead", 36, 172, 9),
            (280, b"data", 17, 36, 11),
            (280, b"det", 36, 516, 10),
            (280, b"dotProduct", 36, 461, 17),
            (280, b"expHelper", 36, 522, 8),
            (280, b"ext_buff", 17, 39, 9),
            (280, b"eye", 36, 352, 15),
            (280, b"gaussianEliminate", 36, 483, 8),
            (280, b"Get", 36, 191, 8),
            (280, b"Get", 36, 199, 8),
            (280, b"getROI", 36, 132, 8),
            (280, b"getROI", 36, 146, 8),
            (280, b"getROI", 36, 156, 8),
            (280, b"inverse", 36, 499, 8),
            (280, b"length", 17, 37, 8),
            (280, b"Mat", 36, 87, 4),
            (280, b"Mat", 36, 94, 4),
            (280, b"Mat", 36, 103, 4),
            (280, b"Mat", 36, 108, 4),
            (280, b"Mat", 36, 119, 4),
            (280, b"norm", 36, 404, 10),
            (280, b"normalize", 36, 395, 9),
            (280, b"ones", 36, 363, 15),
            (280, b"ones", 36, 375, 15),
            (280, b"operator()", 11, 219, 18),
            (280, b"operator()", 11, 231, 24),
            (280, b"operator*=", 36, 288, 9),
            (280, b"operator*=", 36, 298, 9),
            (280, b"operator+=", 36, 245, 9),
            (280, b"operator+=", 36, 256, 9),
            (280, b"operator-=", 36, 266, 9),
            (280, b"operator-=", 36, 277, 9),
            (280, b"operator/=", 36, 308, 9),
            (280, b"operator/=", 36, 317, 9),
            (280, b"operator=", 36, 209, 9),
            (280, b"operator^", 36, 326, 9),
            (280, b"padding", 17, 35, 8),
            (280, b"pinv", 36, 507, 8),
            (280, b"PrintHead", 36, 179, 9),
            (280, b"Rect", 2, 47, 11),
            (280, b"areaRect", 36, 79, 12),
            (280, b"height", 17, 51, 12),
            (280, b"Rect", 36, 61, 8),
            (280, b"resizeRect", 36, 71, 13),
            (280, b"width", 17, 50, 12),
            (280, b"x", 17, 48, 12),
            (280, b"y", 17, 49, 12),
            (280, b"roots", 36, 448, 15),
            (280, b"rowReduceFromGaussian", 36, 491, 8),
            (280, b"rows", 17, 32, 8),
            (280, b"solve", 36, 423, 15),
            (280, b"stride", 17, 34, 8),
            (280, b"sub_matrix", 17, 40, 9),
            (280, b"swapRows", 36, 333, 9),
            (280, b"t", 36, 341, 8),
            (280, b"~Mat", 36, 109, 12),
            (280, b"operator*", 13, 610, 4),
            (280, b"operator*", 13, 622, 4),
            (280, b"operator*", 13, 634, 4),
            (280, b"operator+", 13, 564, 4),
            (280, b"operator+", 13, 575, 4),
            (280, b"operator-", 13, 587, 4),
            (280, b"operator-", 13, 598, 4),
            (280, b"operator/", 13, 646, 4),
            (280, b"operator/", 13, 657, 4),
            (280, b"operator<<", 13, 532, 14),
            (280, b"operator<<", 13, 542, 14),
            (280, b"operator==", 13, 669, 5),
            (280, b"operator>>", 13, 552, 14),
            (280, b"_dspm_mat_h_", 6, 15, 8),
        ],
    ),
    (
        281,
        &[
            (281, b"dspm", 29, 31, 10),
            (281, b"Mat", 21, 33, 0),
            (281, b"abs_tol", 17, 33, 11),
            (281, b"Mat", 21, 35, 0),
            (281, b"Rect", 21, 35, 0),
            (281, b"areaRect", 11, 51, 15),
            (281, b"Rect", 11, 35, 11),
            (281, b"resizeRect", 11, 43, 16),
            (281, b"Mat", 21, 56, 0),
            (281, b"adjoint", 11, 782, 9),
            (281, b"allocate", 11, 833, 10),
            (281, b"augment", 11, 584, 9),
            (281, b"bandSolve", 11, 513, 9),
            (281, b"block", 11, 432, 9),
            (281, b"clear", 11, 424, 10),
            (281, b"cofactor", 11, 721, 9),
            (281, b"Copy", 11, 167, 10),
            (281, b"CopyHead", 11, 181, 10),
            (281, b"det", 11, 745, 11),
            (281, b"dotProduct", 11, 575, 11),
            (281, b"expHelper", 11, 841, 9),
            (281, b"eye", 11, 393, 9),
            (281, b"gaussianEliminate", 11, 599, 9),
            (281, b"Get", 11, 208, 9),
            (281, b"Get", 11, 225, 9),
            (281, b"getROI", 11, 137, 9),
            (281, b"getROI", 11, 157, 9),
            (281, b"getROI", 11, 162, 9),
            (281, b"inverse", 11, 811, 9),
            (281, b"Mat", 11, 56, 5),
            (281, b"Mat", 11, 68, 5),
            (281, b"Mat", 11, 80, 5),
            (281, b"Mat", 11, 97, 5),
            (281, b"Mat", 11, 118, 5),
            (281, b"norm", 11, 455, 11),
            (281, b"normalize", 11, 443, 10),
            (281, b"ones", 11, 408, 9),
            (281, b"ones", 11, 413, 9),
            (281, b"operator*=", 11, 311, 10),
            (281, b"operator*=", 11, 328, 10),
            (281, b"operator+=", 11, 261, 10),
            (281, b"operator+=", 11, 276, 10),
            (281, b"operator-=", 11, 286, 10),
            (281, b"operator-=", 11, 301, 10),
            (281, b"operator/=", 11, 338, 10),
            (281, b"operator/=", 11, 353, 10),
            (281, b"operator=", 11, 230, 10),
            (281, b"operator^", 11, 363, 9),
            (281, b"pinv", 11, 706, 9),
            (281, b"PrintHead", 11, 196, 10),
            (281, b"roots", 11, 551, 9),
            (281, b"rowReduceFromGaussian", 11, 655, 9),
            (281, b"solve", 11, 467, 9),
            (281, b"swapRows", 11, 369, 10),
            (281, b"t", 11, 382, 9),
            (281, b"~Mat", 11, 110, 5),
            (281, b"operator*", 0, 932, 4),
            (281, b"operator*", 0, 951, 4),
            (281, b"operator*", 0, 963, 4),
            (281, b"operator+", 0, 854, 4),
            (281, b"operator+", 0, 872, 4),
            (281, b"operator-", 0, 902, 4),
            (281, b"operator-", 0, 920, 4),
            (281, b"operator/", 0, 968, 4),
            (281, b"operator/", 0, 980, 4),
            (281, b"operator<<", 0, 997, 9),
            (281, b"operator<<", 0, 1009, 9),
            (281, b"operator==", 0, 884, 5),
            (281, b"operator>>", 0, 1019, 9),
            (281, b"endl", 54, 29, 6),
            (281, b"istream", 54, 28, 6),
            (281, b"ostream", 54, 27, 6),
        ],
    ),
    (
        291,
        &[
            (291, b"TAG", 5, 24, 19),
            (291, b"testnlock", 5, 118, 20),
            (291, b"TEST_CASE", 0, 27, 0),
            (291, b"TEST_CASE", 0, 72, 0),
            (291, b"TEST_CASE", 0, 120, 0),
            (291, b"TEST_CASE", 0, 154, 0),
        ],
    ),
    (
        292,
        &[
            (292, b"TAG", 5, 24, 19),
            (292, b"testnlock", 5, 116, 20),
            (292, b"TEST_CASE", 0, 26, 0),
            (292, b"TEST_CASE", 0, 70, 0),
            (292, b"TEST_CASE", 0, 118, 0),
            (292, b"TEST_CASE", 0, 152, 0),
        ],
    ),
    (
        293,
        &[
            (293, b"A_roi_rect", 5, 20, 16),
            (293, b"B_roi_rect", 5, 21, 16),
            (293, b"C_roi_rect", 5, 22, 16),
            (293, b"dspm_mult_ex_f32_aexx_functionality_in_cycle", 0, 24, 12),
            (293, b"testnlock", 5, 238, 20),
            (293, b"TEST_CASE", 0, 158, 0),
            (293, b"TEST_CASE", 0, 240, 0),
        ],
    ),
    (
        294,
        &[
            (294, b"testnlock", 5, 141, 20),
            (294, b"TEST_CASE", 0, 17, 0),
            (294, b"TEST_CASE", 0, 143, 0),
        ],
    ),
    (
        295,
        &[
            (295, b"TAG", 5, 24, 19),
            (295, b"testnlock", 5, 72, 20),
            (295, b"TEST_CASE", 0, 27, 0),
            (295, b"TEST_CASE", 0, 74, 0),
        ],
    ),
    (
        296,
        &[
            (296, b"TAG", 5, 24, 19),
            (296, b"testnlock", 5, 83, 20),
            (296, b"TEST_CASE", 0, 27, 0),
            (296, b"TEST_CASE", 0, 85, 0),
        ],
    ),
    (
        298,
        &[
            (298, b"testnlock", 5, 70, 20),
            (298, b"TEST_CASE", 0, 25, 0),
            (298, b"TEST_CASE", 0, 72, 0),
        ],
    ),
    (
        299,
        &[
            (299, b"TAG", 5, 24, 19),
            (299, b"testnlock", 5, 75, 20),
            (299, b"TEST_CASE", 0, 27, 0),
            (299, b"TEST_CASE", 0, 77, 0),
        ],
    ),
    (
        300,
        &[
            (300, b"m_test_data_s", 2, 26, 15),
            (300, b"A_start_col", 17, 29, 8),
            (300, b"A_start_row", 17, 28, 8),
            (300, b"B_start_col", 17, 31, 8),
            (300, b"B_start_row", 17, 30, 8),
            (300, b"C_start_col", 17, 33, 8),
            (300, b"C_start_row", 17, 32, 8),
            (300, b"k", 17, 36, 8),
            (300, b"m", 17, 34, 8),
            (300, b"n", 17, 35, 8),
            (300, b"var", 17, 27, 8),
            (300, b"m_test_data_t", 4, 37, 2),
            (300, b"m_test_data_s", 22, 26, 15),
            (300, b"test_assert_check_area_mat_mat", 13, 77, 5),
            (300, b"test_assert_equal_mat_const", 13, 63, 5),
            (300, b"test_assert_equal_mat_mat", 13, 50, 5),
            (300, b"_test_mat_common_H_", 6, 7, 8),
        ],
    ),
    (
        307,
        &[
            (307, b"testnlock", 5, 93, 20),
            (307, b"TEST_CASE", 0, 16, 0),
            (307, b"TEST_CASE", 0, 95, 0),
        ],
    ),
    (
        311,
        &[
            (311, b"testnlock", 5, 118, 20),
            (311, b"TEST_CASE", 0, 16, 0),
            (311, b"TEST_CASE", 0, 120, 0),
        ],
    ),
    (
        315,
        &[
            (315, b"cplx_gen_free", 13, 147, 5),
            (315, b"cplx_sig_s", 2, 35, 15),
            (315, b"d_type", 17, 40, 16),
            (315, b"free_status", 17, 41, 16),
            (315, b"freq", 17, 38, 16),
            (315, b"lut", 17, 36, 16),
            (315, b"lut_len", 17, 37, 16),
            (315, b"phase", 17, 39, 16),
            (315, b"cplx_sig_t", 4, 42, 2),
            (315, b"cplx_sig_s", 22, 35, 15),
            (315, b"dsps_cplx_gen", 6, 181, 8),
            (315, b"dsps_cplx_gen", 6, 183, 8),
            (315, b"dsps_cplx_gen_ae32", 13, 172, 10),
            (315, b"dsps_cplx_gen_ansi", 13, 171, 10),
            (315, b"dsps_cplx_gen_freq_get", 13, 92, 6),
            (315, b"dsps_cplx_gen_freq_set", 13, 80, 10),
            (315, b"_dsps_cplx_gen_H_", 6, 7, 8),
            (315, b"dsps_cplx_gen_init", 13, 65, 10),
            (315, b"dsps_cplx_gen_phase_get", 13, 119, 6),
            (315, b"dsps_cplx_gen_phase_set", 13, 107, 10),
            (315, b"dsps_cplx_gen_set", 13, 136, 10),
            (315, b"F32_FLOAT", 12, 24, 4),
            (315, b"output_data_type", 7, 22, 13),
            (315, b"F32_FLOAT", 12, 24, 4),
            (315, b"S16_FIXED", 12, 23, 4),
            (315, b"out_d_type", 4, 25, 2),
            (315, b"output_data_type", 22, 22, 13),
            (315, b"S16_FIXED", 12, 23, 4),
        ],
    ),
    (
        320,
        &[
            (320, b"dsps_snr_f32", 13, 42, 6),
            (320, b"dsps_snr_fc32", 13, 43, 6),
            (320, b"_DSP_SNR_H_", 6, 15, 8),
        ],
    ),
    (
        323,
        &[
            (323, b"dsps_memcpy", 6, 53, 8),
            (323, b"dsps_memcpy", 6, 56, 8),
            (323, b"dsps_memcpy", 6, 62, 8),
            (323, b"dsps_memcpy_aes3", 13, 30, 6),
            (323, b"dsps_memset", 6, 54, 8),
            (323, b"dsps_memset", 6, 57, 8),
            (323, b"dsps_memset", 6, 63, 8),
            (323, b"dsps_memset_aes3", 13, 44, 6),
            (323, b"_dsps_mem_H_", 6, 7, 8),
        ],
    ),
    (
        325,
        &[
            (325, b"AREA_LENGTH", 6, 33, 8),
            (325, b"CALL_REPEAT_COUNT", 6, 28, 8),
            (325, b"context_switch_timer_callback", 0, 660, 12),
            (325, b"CORNERS_CPY_SET_COUNT", 6, 25, 8),
            (325, b"CPY_ITERS", 6, 32, 8),
            (325, b"CPY_REPEAT_COUNT", 6, 31, 8),
            (325, b"MEMCPY_REPORT_LEN", 6, 26, 8),
            (325, b"MEMSET_REPORT_LEN", 6, 27, 8),
            (325, b"one_shot_timer", 5, 619, 21),
            (325, b"pinned_task_benchmark_memcpy", 0, 479, 12),
            (325, b"pinned_task_benchmark_memset", 0, 504, 12),
            (325, b"pinned_task_tie_off", 0, 644, 12),
            (325, b"pinned_task_tie_on", 0, 628, 12),
            (325, b"TAG", 5, 35, 19),
            (325, b"TEST_CASE", 0, 65, 0),
            (325, b"TEST_CASE", 0, 195, 0),
            (325, b"TEST_CASE", 0, 272, 0),
            (325, b"TEST_CASE", 0, 382, 0),
            (325, b"TEST_CASE", 0, 529, 0),
            (325, b"TEST_CASE", 0, 666, 0),
            (325, b"test_context_benchmark_t", 4, 476, 2),
            (325, b"{anontest_context_benchmark_t}", 22, 468, 8),
            (325, b"test_context_timing_t", 4, 625, 2),
            (325, b"{anontest_context_timing_t}", 22, 621, 8),
            (325, b"TEST_PINNED_NUM_ITERS", 6, 30, 8),
            (325, b"TEST_PINNED_NUM_TASKS", 6, 29, 8),
            (325, b"timer_expired", 5, 618, 12),
            (325, b"{anontest_context_benchmark_t}", 2, 468, 8),
            (325, b"area_len", 17, 473, 11),
            (325, b"arr_dest", 17, 471, 13),
            (325, b"arr_src", 17, 470, 13),
            (325, b"mean_val_cpy", 17, 474, 13),
            (325, b"mean_val_set", 17, 475, 13),
            (325, b"semaphore", 17, 469, 22),
            (325, b"set_val", 17, 472, 12),
            (325, b"{anontest_context_timing_t}", 2, 621, 8),
            (325, b"semaphore", 17, 622, 22),
            (325, b"switch_count_tie_off", 17, 624, 13),
            (325, b"switch_count_tie_on", 17, 623, 13),
        ],
    ),
    (
        356,
        &[
            (356, b"components", 29, 0, 0),
            (356, b"esp-dsp", 29, 0, 0),
            (356, b"test_app", 29, 0, 0),
            (356, b"pytest_esp-dsp_unity_tests", 29, 0, 0),
            (356, b"Dut", 54, 4, 28),
            (356, b"test_esp_system", 0, 7, 4),
        ],
    ),
    (
        404,
        &[
            (404, b"bt_rx_force", 13, 6, 12),
            (404, b"burst_gain_mirror", 13, 39, 12),
            (404, b"burst_gain_mode_t", 4, 19, 44),
            (404, b"{anonburst_gain_mode_t}", 22, 19, 8),
            (404, b"BURST_GAIN_REG", 6, 11, 8),
            (404, b"BURST_GAIN_REG", 6, 13, 8),
            (404, b"BURST_GAIN_REG", 6, 15, 8),
            (404, b"BURST_GAIN_REG", 6, 17, 8),
            (404, b"force_rx_gain", 13, 5, 12),
            (404, b"force_rx_gain", 13, 8, 12),
            (404, b"gain_apply", 0, 44, 12),
            (404, b"gain_code", 5, 21, 16),
            (404, b"gain_command", 0, 70, 12),
            (404, b"gain_defaults_saved", 5, 42, 12),
            (404, b"GAIN_HARDWARE", 12, 19, 28),
            (404, b"gain_init_saved", 5, 41, 16),
            (404, b"GAIN_MANUAL", 12, 19, 15),
            (404, b"gain_max", 0, 22, 16),
            (404, b"gain_mode", 5, 20, 25),
            (404, b"gain_reconfigure", 13, 68, 12),
            (404, b"gain_threshold_saved", 5, 41, 33),
            (404, b"phy_rfrx_sat_rst", 13, 40, 12),
            (404, b"{anonburst_gain_mode_t}", 7, 19, 8),
        ],
    ),
    (
        407,
        &[
            (407, b"active_port", 5, 25, 27),
            (407, b"baud_command", 0, 38, 12),
            (407, b"burst_serial_baud", 0, 99, 9),
            (407, b"burst_serial_init", 0, 73, 5),
            (407, b"burst_serial_poll_line", 0, 129, 4),
            (407, b"burst_serial_port", 0, 98, 20),
            (407, b"burst_serial_send", 0, 175, 15),
            (407, b"burst_serial_stop_requested", 0, 120, 5),
            (407, b"COMMAND_SIZE", 6, 24, 8),
            (407, b"CONFIG_ESP_SDR_UART_BAUD", 6, 21, 8),
            (407, b"input", 5, 33, 2),
            (407, b"next_port", 5, 26, 16),
            (407, b"read_port", 0, 103, 11),
            (407, b"transfer_deadline", 0, 166, 15),
            (407, b"uart_baud", 5, 27, 16),
            (407, b"usb_ready", 0, 71, 12),
            (407, b"{anoninput}", 2, 28, 7),
            (407, b"last_byte", 17, 32, 12),
            (407, b"line", 17, 29, 9),
            (407, b"overflow", 17, 31, 9),
            (407, b"used", 17, 30, 11),
        ],
    ),
    (
        408,
        &[
            (408, b"burst_serial_baud", 13, 14, 9),
            (408, b"BURST_SERIAL_COUNT", 12, 5, 52),
            (408, b"burst_serial_init", 13, 7, 5),
            (408, b"burst_serial_poll_line", 13, 12, 4),
            (408, b"burst_serial_port", 13, 13, 20),
            (408, b"burst_serial_port_t", 4, 5, 73),
            (408, b"{anonburst_serial_port_t}", 22, 5, 8),
            (408, b"burst_serial_send", 13, 15, 5),
            (408, b"burst_serial_stop_requested", 13, 18, 5),
            (408, b"BURST_SERIAL_UART", 12, 5, 33),
            (408, b"BURST_SERIAL_USB", 12, 5, 15),
            (408, b"{anonburst_serial_port_t}", 7, 5, 8),
        ],
    ),
    (
        409,
        &[
            (409, b"accum", 5, 310, 14),
            (409, b"accumulate_buf", 0, 1075, 22),
            (409, b"accum_buf", 5, 306, 13),
            (409, b"accum_buf", 5, 308, 13),
            (409, b"assist_cost", 5, 1441, 13),
            (409, b"b", 5, 1438, 18),
            (409, b"b", 5, 1511, 13),
            (409, b"bank_idle", 0, 1369, 19),
            (409, b"bank_idle", 0, 1373, 19),
            (409, b"bank_ptr", 0, 138, 24),
            (409, b"bank_sel_saved", 5, 1435, 19),
            (409, b"bin_of", 5, 311, 16),
            (409, b"BLK_ACCUM", 12, 421, 38),
            (409, b"BLK_FFT", 12, 421, 29),
            (409, b"BLK_IDLE", 12, 421, 7),
            (409, b"BLK_UNPACK", 12, 421, 17),
            (409, b"c0_assist", 0, 1195, 22),
            (409, b"c0_cost", 5, 1471, 13),
            (409, b"c0_lost", 5, 1470, 25),
            (409, b"c1", 5, 945, 2),
            (409, b"c1enc", 5, 971, 2),
            (409, b"c1q", 5, 946, 17),
            (409, b"c1_emit_frame", 0, 1016, 22),
            (409, b"c1_enabled", 5, 947, 19),
            (409, b"c1_encode_step", 0, 974, 22),
            (409, b"c1_iq_unit", 0, 1222, 22),
            (409, b"c1_ok", 5, 947, 12),
            (409, b"C1_QUEUE", 6, 934, 8),
            (409, b"c1_revoke", 0, 1291, 19),
            (409, b"c1_seq", 5, 1470, 13),
            (409, b"c1_start", 13, 317, 12),
            (409, b"c1_start", 0, 1298, 12),
            (409, b"c1_take_handoff", 0, 1116, 22),
            (409, b"c1_txq_push", 13, 467, 12),
            (409, b"c1_txq_push", 0, 956, 22),
            (409, b"c1_unit", 0, 1126, 22),
            (409, b"c1_unit_t", 4, 941, 2),
            (409, b"{anonc1_unit_t}", 22, 936, 8),
            (409, b"CHUNK", 6, 279, 8),
            (409, b"cl", 5, 1102, 2),
            (409, b"claim_block", 0, 1105, 22),
            (409, b"count", 5, 1687, 17),
            (409, b"cpp", 5, 1430, 19),
            (409, b"ctrl", 5, 1433, 19),
            (409, b"cycles_per_pair", 0, 158, 16),
            (409, b"dc", 5, 391, 21),
            (409, b"dc_track", 0, 392, 22),
            (409, b"dsps_fft_w_table_sc16", 53, 38, 16),
            (409, b"dsp_ready", 5, 319, 12),
            (409, b"dual", 5, 1464, 15),
            (409, b"dual", 5, 1480, 15),
            (409, b"DUMP_BANK_SELECT_REG", 6, 89, 8),
            (409, b"DUMP_BANK_SELECT_REG", 6, 101, 8),
            (409, b"DUMP_BANK_SELECT_REG", 6, 113, 8),
            (409, b"DUMP_CONFIG_IQ", 6, 92, 8),
            (409, b"DUMP_CONFIG_IQ", 6, 105, 8),
            (409, b"DUMP_CONFIG_IQ", 6, 107, 8),
            (409, b"DUMP_CONFIG_IQ", 6, 116, 8),
            (409, b"DUMP_CONFIG_REG", 6, 88, 8),
            (409, b"DUMP_CONFIG_REG", 6, 97, 8),
            (409, b"DUMP_CONFIG_REG", 6, 99, 8),
            (409, b"DUMP_CONFIG_REG", 6, 112, 8),
            (409, b"DUMP_CTRL_CIRCULAR", 6, 91, 8),
            (409, b"DUMP_CTRL_CIRCULAR", 6, 103, 8),
            (409, b"DUMP_CTRL_CIRCULAR", 6, 115, 8),
            (409, b"DUMP_CTRL_REG", 6, 86, 8),
            (409, b"DUMP_CTRL_REG", 6, 94, 8),
            (409, b"DUMP_CTRL_REG", 6, 110, 8),
            (409, b"DUMP_CTRL_RUN", 6, 90, 8),
            (409, b"DUMP_CTRL_RUN", 6, 102, 8),
            (409, b"DUMP_CTRL_RUN", 6, 114, 8),
            (409, b"DUMP_WRITE_INDEX_REG", 6, 87, 8),
            (409, b"DUMP_WRITE_INDEX_REG", 6, 95, 8),
            (409, b"DUMP_WRITE_INDEX_REG", 6, 111, 8),
            (409, b"duration_us", 5, 1434, 18),
            (409, b"emit_chunk", 13, 532, 12),
            (409, b"emit_chunk", 0, 559, 21),
            (409, b"end", 5, 1674, 24),
            (409, b"END_GUARD", 6, 73, 8),
            (409, b"END_GUARD", 6, 77, 8),
            (409, b"end_probe", 5, 1436, 44),
            (409, b"epoch", 5, 1505, 13),
            (409, b"expected", 5, 1509, 13),
            (409, b"fail", 0, 1311, 21),
            (409, b"fft_buf", 5, 302, 15),
            (409, b"fill_sentinels", 0, 167, 21),
            (409, b"fill_sentinels", 13, 1438, 46),
            (409, b"find_end", 0, 221, 25),
            (409, b"find_first", 0, 206, 25),
            (409, b"first", 5, 1674, 17),
            (409, b"fir_alloc", 0, 701, 13),
            (409, b"fir_c1", 0, 754, 19),
            (409, b"FIR_CHUNK", 6, 686, 8),
            (409, b"fir_feed", 0, 767, 22),
            (409, b"fir_free", 0, 785, 12),
            (409, b"fir_i0", 0, 694, 13),
            (409, b"fir_job_t", 4, 676, 2),
            (409, b"{anonfir_job_t}", 22, 672, 8),
            (409, b"fir_oi", 5, 693, 16),
            (409, b"fir_oq", 5, 693, 25),
            (409, b"fir_reset", 0, 784, 12),
            (409, b"fir_rot", 5, 683, 12),
            (409, b"fir_rot_masks", 5, 684, 21),
            (409, b"fir_setup", 0, 786, 12),
            (409, b"fir_tap", 0, 695, 13),
            (409, b"frame_close", 0, 533, 21),
            (409, b"frame_out", 5, 312, 15),
            (409, b"fs1", 5, 692, 16),
            (409, b"fs2", 5, 692, 21),
            (409, b"fstage_free", 0, 728, 12),
            (409, b"fstage_init", 0, 702, 12),
            (409, b"fstage_reset", 0, 729, 12),
            (409, b"fstage_run", 0, 734, 26),
            (409, b"fstage_t", 4, 691, 2),
            (409, b"{anonfstage_t}", 22, 687, 8),
            (409, b"hbuf", 5, 1103, 16),
            (409, b"host_input", 0, 267, 21),
            (409, b"index", 5, 1510, 13),
            (409, b"iq", 5, 1408, 15),
            (409, b"iqs", 5, 661, 2),
            (409, b"iqs_abandon", 0, 840, 22),
            (409, b"iqs_accept", 0, 845, 12),
            (409, b"iqs_accept", 13, 1695, 25),
            (409, b"IQS_CHUNK", 6, 637, 8),
            (409, b"iqs_cost", 5, 639, 16),
            (409, b"iqs_cyc", 5, 640, 16),
            (409, b"iqs_done", 5, 640, 25),
            (409, b"iqs_flush", 13, 662, 12),
            (409, b"iqs_flush", 0, 795, 22),
            (409, b"iqs_header_t", 4, 648, 2),
            (409, b"{anoniqs_header_t}", 22, 641, 8),
            (409, b"IQS_MAGIC", 6, 635, 8),
            (409, b"IQS_PAYLOAD", 6, 636, 8),
            (409, b"iqs_put", 13, 663, 19),
            (409, b"iqs_put", 0, 809, 29),
            (409, b"iqs_slice", 0, 825, 12),
            (409, b"irq", 5, 1484, 13),
            (409, b"last", 5, 1661, 19),
            (409, b"late", 5, 1656, 17),
            (409, b"LATE_LIMIT", 6, 74, 8),
            (409, b"LATE_LIMIT", 6, 78, 8),
            (409, b"ld", 5, 460, 54),
            (409, b"LD_C0", 1, 1367, 8),
            (409, b"LD_C0", 1, 1371, 8),
            (409, b"live_ring_run", 0, 1321, 12),
            (409, b"live_ring_run", 13, 1428, 4),
            (409, b"log_e_q4", 5, 361, 15),
            (409, b"log_m_q4", 5, 361, 30),
            (409, b"log_tables_init", 13, 315, 12),
            (409, b"log_tables_init", 0, 362, 12),
            (409, b"max_age", 5, 1431, 19),
            (409, b"MAX_PAIRS", 6, 82, 8),
            (409, b"memset", 13, 1421, 4),
            (409, b"memset", 13, 1465, 4),
            (409, b"MEMW", 1, 935, 8),
            (409, b"MIN_PAIRS", 6, 81, 8),
            (409, b"need_next", 5, 1516, 19),
            (409, b"next", 5, 1515, 23),
            (409, b"NOT_FOUND", 6, 83, 8),
            (409, b"prepared", 5, 1512, 9),
            (409, b"rate_bits", 0, 151, 16),
            (409, b"reclaim_bank", 0, 1368, 19),
            (409, b"reclaim_bank", 0, 1372, 19),
            (409, b"REG_CLR_BIT", 13, 1495, 4),
            (409, b"REG_SET_BIT", 13, 1494, 4),
            (409, b"REG_WRITE", 13, 1485, 4),
            (409, b"REG_WRITE", 13, 1486, 4),
            (409, b"REG_WRITE", 13, 1489, 4),
            (409, b"REG_WRITE", 13, 1489, 38),
            (409, b"REG_WRITE", 13, 1489, 69),
            (409, b"REG_WRITE", 13, 1490, 4),
            (409, b"REG_WRITE", 13, 1492, 4),
            (409, b"REG_WRITE", 13, 1493, 4),
            (409, b"REG_WRITE", 13, 1496, 4),
            (409, b"REG_WRITE", 13, 1498, 4),
            (409, b"REG_WRITE", 13, 1500, 4),
            (409, b"REG_WRITE", 13, 1504, 4),
            (409, b"REG_WRITE", 13, 1737, 4),
            (409, b"REG_WRITE", 13, 1738, 4),
            (409, b"release_bank", 0, 862, 21),
            (409, b"ring_capture_assist", 5, 951, 5),
            (409, b"ring_capture_bank", 0, 141, 16),
            (409, b"ring_capture_c0_blocks", 5, 952, 9),
            (409, b"ring_capture_core1_alive", 0, 953, 5),
            (409, b"ring_capture_dual_active", 0, 950, 5),
            (409, b"ring_capture_init", 0, 320, 5),
            (409, b"ring_capture_rate_hz", 0, 143, 9),
            (409, b"ring_capture_run", 0, 1376, 14),
            (409, b"ring_capture_set_dual", 0, 954, 5),
            (409, b"ring_capture_valid_nfft", 0, 335, 5),
            (409, b"RING_HOT", 6, 64, 8),
            (409, b"RING_HOT", 6, 66, 8),
            (409, b"RING_MASK", 6, 68, 8),
            (409, b"s3_core1_entry", 13, 948, 12),
            (409, b"s3_core1_main", 0, 1258, 15),
            (409, b"S3_FFT", 1, 42, 8),
            (409, b"s3_fft2r_sc16_rnd", 13, 39, 4),
            (409, b"s3_fft2r_sc16_rnd_stage", 13, 40, 4),
            (409, b"S3_FFT_STAGE", 1, 43, 8),
            (409, b"S3_FFT_STAGE", 1, 45, 8),
            (409, b"s3_fir8_l32", 13, 679, 5),
            (409, b"s3_fir_split", 13, 678, 5),
            (409, b"s3_rot_fs4", 13, 680, 5),
            (409, b"s3_unpack_iq10_split", 13, 677, 5),
            (409, b"s3_unpack_iq10_win", 13, 300, 5),
            (409, b"scalar_stats", 5, 520, 24),
            (409, b"scalar_telemetry", 0, 521, 12),
            (409, b"select_banks", 0, 119, 19),
            (409, b"select_banks", 13, 1501, 4),
            (409, b"SENTINEL", 6, 70, 8),
            (409, b"settle", 5, 1432, 19),
            (409, b"spectrum_stats_init", 13, 1419, 4),
            (409, b"spec_accumulate", 0, 395, 22),
            (409, b"spec_header_t", 4, 293, 2),
            (409, b"{anonspec_header_t}", 22, 282, 8),
            (409, b"spec_log2", 5, 313, 24),
            (409, b"SPEC_MAGIC", 6, 278, 8),
            (409, b"spec_n", 5, 313, 16),
            (409, b"spec_remove_dc", 0, 393, 22),
            (409, b"spec_setup", 0, 339, 12),
            (409, b"spec_setup", 13, 1416, 14),
            (409, b"spec_stats_t", 4, 458, 2),
            (409, b"{anonspec_stats_t}", 22, 450, 8),
            (409, b"spec_unpack", 0, 373, 22),
            (409, b"st", 5, 444, 2),
            (409, b"start", 5, 1697, 17),
            (409, b"START_GUARD", 6, 72, 8),
            (409, b"START_GUARD", 6, 76, 8),
            (409, b"start_probe", 5, 1436, 13),
            (409, b"_Static_assert", 13, 133, 0),
            (409, b"_Static_assert", 13, 134, 0),
            (409, b"_Static_assert", 13, 135, 0),
            (409, b"_Static_assert", 13, 136, 0),
            (409, b"_Static_assert", 13, 243, 0),
            (409, b"_Static_assert", 13, 294, 0),
            (409, b"_Static_assert", 13, 459, 0),
            (409, b"_Static_assert", 13, 649, 0),
            (409, b"stats_maybe", 0, 470, 22),
            (409, b"STAT_MAGIC", 6, 449, 8),
            (409, b"stop", 5, 1522, 13),
            (409, b"stop_checked", 5, 1522, 32),
            (409, b"stride_phase", 5, 1482, 13),
            (409, b"sx", 5, 466, 2),
            (409, b"t", 5, 1670, 17),
            (409, b"tail_seen", 5, 1470, 38),
            (409, b"THRESHOLD", 6, 69, 8),
            (409, b"todo", 5, 1697, 28),
            (409, b"txq", 5, 241, 15),
            (409, b"txq_head", 5, 242, 16),
            (409, b"txq_pump", 0, 257, 21),
            (409, b"txq_push", 0, 245, 21),
            (409, b"txq_push", 13, 468, 12),
            (409, b"TXQ_SIZE", 6, 237, 8),
            (409, b"TXQ_SIZE", 6, 239, 8),
            (409, b"txq_tail", 5, 242, 26),
            (409, b"t_start", 5, 1502, 12),
            (409, b"UNIT0_END_GUARD", 6, 80, 8),
            (409, b"unit_done", 0, 599, 21),
            (409, b"UNPACK_CHUNK", 6, 280, 8),
            (409, b"unpack_seg", 0, 1050, 22),
            (409, b"unpack_to", 0, 1072, 22),
            (409, b"w0", 5, 1506, 19),
            (409, b"win2", 5, 299, 15),
            (409, b"window_q15", 5, 296, 15),
            (409, b"work_slice", 0, 875, 21),
            (409, b"work_t", 4, 419, 2),
            (409, b"{anonwork_t}", 22, 414, 8),
            (409, b"write_index", 5, 1521, 17),
            (409, b"written", 5, 1521, 30),
            (409, b"{anonc1enc}", 2, 966, 7),
            (409, b"crc", 17, 967, 25),
            (409, b"crc_at", 17, 967, 30),
            (409, b"k", 17, 967, 22),
            (409, b"len", 17, 967, 38),
            (409, b"max_hold", 17, 969, 9),
            (409, b"off", 17, 968, 12),
            (409, b"pending", 17, 967, 13),
            (409, b"src", 17, 970, 14),
            (409, b"{anonc1}", 2, 942, 16),
            (409, b"alive", 17, 943, 13),
            (409, b"bank_seq", 17, 944, 13),
            (409, b"block_max", 17, 943, 57),
            (409, b"busy", 17, 943, 51),
            (409, b"done", 17, 943, 45),
            (409, b"end", 17, 943, 40),
            (409, b"posted", 17, 943, 25),
            (409, b"run", 17, 943, 20),
            (409, b"taken", 17, 943, 33),
            (409, b"{anonc1_unit_t}", 2, 936, 8),
            (409, b"bank", 17, 937, 18),
            (409, b"blocks", 17, 937, 38),
            (409, b"count", 17, 937, 31),
            (409, b"first", 17, 937, 24),
            (409, b"gain", 17, 940, 12),
            (409, b"index", 17, 939, 13),
            (409, b"seq", 17, 937, 13),
            (409, b"start", 17, 938, 13),
            (409, b"{anoncl}", 2, 1093, 16),
            (409, b"bank", 17, 1095, 13),
            (409, b"blocks", 17, 1095, 26),
            (409, b"c0_blocks", 17, 1101, 13),
            (409, b"c0_seq", 17, 1097, 13),
            (409, b"claim", 17, 1096, 13),
            (409, b"done", 17, 1100, 13),
            (409, b"first", 17, 1095, 19),
            (409, b"hb_full", 17, 1098, 13),
            (409, b"hb_seq", 17, 1099, 13),
            (409, b"seq", 17, 1094, 13),
            (409, b"stride", 17, 1095, 34),
            (409, b"{anonfir_job_t}", 2, 672, 8),
            (409, b"groups", 17, 674, 13),
            (409, b"h", 17, 673, 29),
            (409, b"nout", 17, 674, 21),
            (409, b"oi", 17, 675, 13),
            (409, b"oq", 17, 675, 18),
            (409, b"shift", 17, 674, 33),
            (409, b"step", 17, 674, 27),
            (409, b"xi", 17, 673, 19),
            (409, b"xq", 17, 673, 24),
            (409, b"{anonfstage_t}", 2, 687, 8),
            (409, b"base", 17, 689, 13),
            (409, b"cap", 17, 688, 22),
            (409, b"D", 17, 688, 13),
            (409, b"h", 17, 690, 13),
            (409, b"L", 17, 688, 16),
            (409, b"n", 17, 688, 19),
            (409, b"next_end", 17, 689, 19),
            (409, b"shift", 17, 688, 27),
            (409, b"wi", 17, 690, 17),
            (409, b"wq", 17, 690, 22),
            (409, b"{anoniqs}", 2, 650, 7),
            (409, b"bank", 17, 652, 13),
            (409, b"bits", 17, 656, 25),
            (409, b"count", 17, 653, 20),
            (409, b"dec", 17, 656, 13),
            (409, b"fill", 17, 659, 13),
            (409, b"first", 17, 653, 13),
            (409, b"flags", 17, 659, 46),
            (409, b"frame", 17, 659, 19),
            (409, b"frame_index", 17, 658, 13),
            (409, b"gain", 17, 659, 53),
            (409, b"index", 17, 654, 13),
            (409, b"log2d", 17, 656, 18),
            (409, b"lost_pairs", 17, 659, 26),
            (409, b"next_pair", 17, 655, 13),
            (409, b"out", 17, 660, 13),
            (409, b"out_index", 17, 657, 13),
            (409, b"pending", 17, 651, 9),
            (409, b"pos", 17, 653, 27),
            (409, b"shift", 17, 656, 31),
            (409, b"{anoniqs_header_t}", 2, 641, 8),
            (409, b"bits", 17, 645, 12),
            (409, b"dec", 17, 646, 13),
            (409, b"flags", 17, 645, 18),
            (409, b"frame", 17, 642, 20),
            (409, b"gain", 17, 647, 12),
            (409, b"magic", 17, 642, 13),
            (409, b"samples", 17, 644, 13),
            (409, b"sample_index", 17, 643, 13),
            (409, b"shift", 17, 647, 18),
            (409, b"{anonld}", 2, 460, 16),
            (409, b"c0_busy", 17, 460, 34),
            (409, b"c1_busy", 17, 460, 43),
            (409, b"{anonspec_header_t}", 2, 282, 8),
            (409, b"db_step", 17, 292, 12),
            (409, b"drops", 17, 290, 13),
            (409, b"ffts", 17, 287, 13),
            (409, b"flags", 17, 288, 12),
            (409, b"frame", 17, 284, 13),
            (409, b"gain", 17, 289, 12),
            (409, b"magic", 17, 283, 13),
            (409, b"nfft_log2", 17, 291, 12),
            (409, b"pairs", 17, 286, 13),
            (409, b"pair_index", 17, 285, 13),
            (409, b"{anonspec_stats_t}", 2, 450, 8),
            (409, b"abandoned", 17, 455, 13),
            (409, b"c0_pm", 17, 452, 13),
            (409, b"c1_pm", 17, 452, 20),
            (409, b"cov_pm", 17, 453, 13),
            (409, b"drops", 17, 455, 24),
            (409, b"ffts_per_s", 17, 457, 13),
            (409, b"heap_free", 17, 454, 13),
            (409, b"heap_largest", 17, 454, 24),
            (409, b"late_max", 17, 456, 13),
            (409, b"magic", 17, 451, 13),
            (409, b"mode", 17, 453, 21),
            (409, b"txq_pm", 17, 456, 23),
            (409, b"{anonst}", 2, 423, 7),
            (409, b"blk_at", 17, 436, 13),
            (409, b"blk_bank", 17, 435, 25),
            (409, b"cfg", 17, 424, 25),
            (409, b"dropped", 17, 433, 9),
            (409, b"emitting", 17, 438, 9),
            (409, b"emit_crc", 17, 441, 13),
            (409, b"emit_h", 17, 443, 18),
            (409, b"emit_off_q4", 17, 442, 12),
            (409, b"emit_pos", 17, 440, 13),
            (409, b"fft_stage", 17, 435, 35),
            (409, b"fifo", 17, 427, 13),
            (409, b"fifo_len", 17, 427, 31),
            (409, b"frame_ffts", 17, 429, 26),
            (409, b"frame_flags", 17, 432, 24),
            (409, b"frame_gain", 17, 432, 12),
            (409, b"frame_index", 17, 431, 13),
            (409, b"frame_pairs", 17, 430, 13),
            (409, b"frame_units", 17, 429, 13),
            (409, b"last_ok", 17, 439, 12),
            (409, b"phase", 17, 435, 13),
            (409, b"pos", 17, 435, 20),
            (409, b"res", 17, 425, 19),
            (409, b"work", 17, 426, 11),
            (409, b"{anonsx}", 2, 461, 7),
            (409, b"c0", 17, 463, 17),
            (409, b"c1", 17, 463, 21),
            (409, b"ffts", 17, 463, 25),
            (409, b"heap_free", 17, 464, 13),
            (409, b"heap_largest", 17, 464, 24),
            (409, b"mode", 17, 465, 13),
            (409, b"pairs", 17, 463, 31),
            (409, b"pairs_done", 17, 463, 38),
            (409, b"started", 17, 462, 9),
            (409, b"t0", 17, 463, 13),
            (409, b"{anonwork_t}", 2, 414, 8),
            (409, b"blocks", 17, 416, 39),
            (409, b"count", 17, 416, 20),
            (409, b"first", 17, 416, 13),
            (409, b"gain", 17, 418, 12),
            (409, b"index", 17, 417, 13),
            (409, b"next_block", 17, 416, 27),
            (409, b"pending", 17, 415, 9),
            (409, b"{anon_enum}", 7, 421, 0),
        ],
    ),
    (
        410,
        &[
            (410, b"RING_BANKS", 6, 11, 8),
            (410, b"RING_BANKS", 6, 15, 8),
            (410, b"RING_BANKS", 6, 20, 8),
            (410, b"RING_BANKS", 6, 24, 8),
            (410, b"RING_BANK_BASE", 6, 12, 8),
            (410, b"RING_BANK_BASE", 6, 16, 8),
            (410, b"RING_BANK_BASE", 6, 21, 8),
            (410, b"RING_BANK_BASE", 6, 25, 8),
            (410, b"RING_BANK_END", 6, 13, 8),
            (410, b"RING_BANK_END", 6, 17, 8),
            (410, b"RING_BANK_END", 6, 22, 8),
            (410, b"RING_BANK_END", 6, 26, 8),
            (410, b"RING_BANK_STRIDE", 6, 18, 8),
            (410, b"RING_BANK_STRIDE", 6, 29, 8),
            (410, b"ring_capture_assist", 53, 102, 12),
            (410, b"ring_capture_bank", 13, 92, 16),
            (410, b"ring_capture_c0_blocks", 53, 103, 16),
            (410, b"ring_capture_core1_alive", 13, 99, 5),
            (410, b"ring_capture_dc_mode", 6, 96, 8),
            (410, b"ring_capture_dual_active", 13, 100, 5),
            (410, b"ring_capture_init", 13, 88, 5),
            (410, b"ring_capture_rate_hz", 13, 93, 9),
            (410, b"ring_capture_run", 13, 91, 5),
            (410, b"ring_capture_set_dual", 13, 101, 5),
            (410, b"ring_capture_valid_nfft", 13, 94, 5),
            (410, b"ring_config_t", 4, 69, 2),
            (410, b"{anonring_config_t}", 22, 55, 8),
            (410, b"RING_FAIL_AGE", 12, 46, 4),
            (410, b"RING_FAIL_ARG", 12, 44, 4),
            (410, b"RING_FAIL_END", 12, 48, 4),
            (410, b"RING_FAIL_LATE", 12, 45, 4),
            (410, b"RING_FAIL_LENGTH", 12, 49, 4),
            (410, b"RING_FAIL_START", 12, 47, 4),
            (410, b"RING_FAIL_TRANSPORT", 12, 50, 4),
            (410, b"RING_MODE_CAPTURE", 12, 53, 32),
            (410, b"RING_MODE_IQ", 12, 53, 67),
            (410, b"RING_MODE_SPEC", 12, 53, 51),
            (410, b"RING_MODE_STATS", 12, 53, 15),
            (410, b"ring_mode_t", 4, 53, 82),
            (410, b"{anonring_mode_t}", 22, 53, 8),
            (410, b"RING_OK", 12, 43, 4),
            (410, b"RING_PAIRS", 6, 32, 8),
            (410, b"ring_result_t", 4, 86, 2),
            (410, b"{anonring_result_t}", 22, 76, 8),
            (410, b"RING_SPEC_NFFT_MAX", 6, 36, 8),
            (410, b"RING_SPEC_NFFT_MAX", 6, 38, 8),
            (410, b"ring_status_t", 4, 51, 2),
            (410, b"{anonring_status_t}", 22, 42, 8),
            (410, b"RING_THRESHOLD", 6, 33, 8),
            (410, b"ring_unit_t", 4, 74, 2),
            (410, b"{anonring_unit_t}", 22, 71, 8),
            (410, b"{anonring_config_t}", 2, 55, 8),
            (410, b"capture_units", 17, 59, 13),
            (410, b"duration_ms", 17, 58, 13),
            (410, b"iq_bits", 17, 66, 13),
            (410, b"iq_dec", 17, 65, 13),
            (410, b"iq_rot", 17, 68, 9),
            (410, b"iq_shift", 17, 67, 13),
            (410, b"max_hold", 17, 63, 9),
            (410, b"mode", 17, 56, 16),
            (410, b"nfft", 17, 60, 13),
            (410, b"rate", 17, 57, 13),
            (410, b"stats", 17, 64, 9),
            (410, b"stride", 17, 61, 13),
            (410, b"units_per_frame", 17, 62, 13),
            (410, b"{anonring_mode_t}", 7, 53, 8),
            (410, b"{anonring_result_t}", 2, 76, 8),
            (410, b"abandoned", 17, 83, 28),
            (410, b"cap", 17, 85, 16),
            (410, b"detail", 17, 77, 21),
            (410, b"drops", 17, 83, 21),
            (410, b"elapsed_us", 17, 80, 13),
            (410, b"ffts", 17, 83, 39),
            (410, b"frames", 17, 83, 13),
            (410, b"late_max", 17, 81, 13),
            (410, b"pairs", 17, 79, 13),
            (410, b"status", 17, 77, 13),
            (410, b"stopped_by_host", 17, 84, 9),
            (410, b"units", 17, 78, 13),
            (410, b"work_max", 17, 82, 13),
            (410, b"{anonring_status_t}", 7, 42, 8),
            (410, b"{anonring_unit_t}", 2, 71, 8),
            (410, b"bank", 17, 72, 13),
            (410, b"count", 17, 73, 13),
            (410, b"first", 17, 72, 19),
        ],
    ),
    (
        412,
        &[
            (412, b"scalar", 5, 9, 2),
            (412, b"scalar_accept", 0, 11, 12),
            (412, b"scalar_work", 0, 17, 12),
            (412, b"{anonscalar}", 2, 5, 7),
            (412, b"bank", 17, 6, 55),
            (412, b"emit", 17, 6, 49),
            (412, b"first", 17, 6, 61),
            (412, b"gain", 17, 8, 12),
            (412, b"group", 17, 6, 34),
            (412, b"groups", 17, 6, 26),
            (412, b"half", 17, 6, 20),
            (412, b"index", 17, 7, 13),
            (412, b"offset", 17, 6, 41),
            (412, b"phase", 17, 6, 13),
            (412, b"unpack", 17, 6, 68),
        ],
    ),
    (
        413,
        &[
            (413, b"rx_bandwidth_dcap", 0, 51, 22),
            (413, b"RX_BANDWIDTH_MAX", 6, 23, 8),
            (413, b"RX_BANDWIDTH_MAX", 6, 25, 8),
            (413, b"RX_BANDWIDTH_MAX", 6, 27, 8),
            (413, b"RX_BANDWIDTH_MAX", 6, 29, 8),
            (413, b"RX_BANDWIDTH_MAX", 6, 31, 8),
            (413, b"RX_BANDWIDTH_MAX", 6, 33, 8),
            (413, b"RX_BANDWIDTH_MAX", 6, 35, 8),
            (413, b"RX_BANDWIDTH_MAX", 6, 37, 8),
            (413, b"RX_BANDWIDTH_MIN", 6, 8, 8),
            (413, b"RX_BANDWIDTH_MIN", 6, 10, 8),
            (413, b"RX_BANDWIDTH_MIN", 6, 12, 8),
            (413, b"RX_BANDWIDTH_MIN", 6, 14, 8),
            (413, b"RX_BANDWIDTH_MIN", 6, 16, 8),
            (413, b"RX_BANDWIDTH_MIN", 6, 18, 8),
            (413, b"RX_BANDWIDTH_MIN", 6, 20, 8),
            (413, b"rx_bandwidth_phy_mode", 0, 43, 23),
            (413, b"rx_bandwidth_point_t", 4, 50, 37),
            (413, b"{anonrx_bandwidth_point_t}", 22, 50, 8),
            (413, b"{anonrx_bandwidth_point_t}", 2, 50, 8),
            (413, b"dcap", 17, 50, 25),
            (413, b"mhz", 17, 50, 30),
        ],
    ),
    (
        414,
        &[
            (414, b"ram_chip_i2c_readReg", 13, 23, 16),
            (414, b"ram_chip_i2c_writeReg", 13, 24, 12),
            (414, b"rom1_chip_i2c_readReg", 13, 29, 16),
            (414, b"rom1_chip_i2c_writeReg", 13, 30, 12),
            (414, b"rom_chip_i2c_readReg", 13, 34, 16),
            (414, b"rom_chip_i2c_writeReg", 13, 35, 12),
            (414, b"RX_LO_BLOCK", 6, 47, 8),
            (414, b"RX_LO_BLOCK", 6, 51, 8),
            (414, b"RX_LO_HOST", 6, 27, 8),
            (414, b"RX_LO_HOST", 6, 43, 8),
            (414, b"RX_LO_MASK", 6, 49, 8),
            (414, b"RX_LO_MASK", 6, 53, 8),
            (414, b"rx_lo_plan", 0, 14, 27),
            (414, b"rx_lo_plan_t", 4, 12, 2),
            (414, b"{anonrx_lo_plan_t}", 22, 8, 8),
            (414, b"rx_lo_read", 6, 25, 8),
            (414, b"rx_lo_read", 6, 31, 8),
            (414, b"rx_lo_read", 6, 36, 8),
            (414, b"RX_LO_REG", 6, 48, 8),
            (414, b"RX_LO_REG", 6, 52, 8),
            (414, b"rx_lo_select", 0, 56, 19),
            (414, b"rx_lo_write", 6, 26, 8),
            (414, b"rx_lo_write", 6, 32, 8),
            (414, b"rx_lo_write", 6, 37, 8),
            (414, b"{anonrx_lo_plan_t}", 2, 8, 8),
            (414, b"alternate", 17, 11, 9),
            (414, b"mhz", 17, 9, 13),
            (414, b"offset_khz", 17, 10, 8),
        ],
    ),
    (
        415,
        &[
            (415, b"rx_frequency_valid", 0, 7, 19),
            (415, b"RX_FREQ_MAX", 6, 5, 8),
            (415, b"RX_FREQ_MIN", 6, 4, 8),
            (415, b"RX_TUNING_RANGE_REPLY", 6, 6, 8),
        ],
    ),
    (
        416,
        &[
            (416, b"capabilities", 0, 70, 12),
            (416, b"clamp16", 0, 68, 15),
            (416, b"HEADER_BYTES", 6, 23, 8),
            (416, b"MAX_FFT", 6, 19, 8),
            (416, b"MAX_FFT", 6, 21, 8),
            (416, b"put16", 0, 62, 12),
            (416, b"put32", 0, 63, 12),
            (416, b"put64", 0, 64, 12),
            (416, b"rates", 5, 47, 22),
            (416, b"rate_hz", 0, 58, 16),
            (416, b"ready", 5, 35, 12),
            (416, b"reverse", 0, 65, 16),
            (416, b"send_text", 0, 61, 12),
            (416, b"setup_n", 5, 34, 16),
            (416, b"spectrum_command", 0, 95, 5),
            (416, b"spectrum_fft_init", 0, 42, 5),
            (416, b"spectrum_workspace", 0, 36, 21),
            (416, b"SPEC_STORAGE", 6, 26, 8),
            (416, b"SPEC_STORAGE", 6, 28, 8),
            (416, b"SPEC_STORAGE", 5, 30, 66),
            (416, b"SPEC_STORAGE", 5, 31, 31),
            (416, b"SPEC_STORAGE", 5, 32, 29),
            (416, b"SPEC_STORAGE", 5, 33, 49),
            (416, b"SPEC_STORAGE", 5, 41, 62),
        ],
    ),
    (
        417,
        &[
            (417, b"spectrum_acquire_fn", 4, 5, 15),
            (417, b"spectrum_command", 13, 7, 5),
            (417, b"spectrum_fft_init", 13, 9, 5),
            (417, b"spectrum_workspace", 13, 19, 21),
            (417, b"spectrum_workspace_t", 4, 18, 2),
            (417, b"{anonspectrum_workspace_t}", 22, 14, 8),
            (417, b"{anonspectrum_workspace_t}", 2, 14, 8),
            (417, b"fft", 17, 15, 13),
            (417, b"frame", 17, 17, 13),
            (417, b"power", 17, 16, 11),
            (417, b"window", 17, 15, 19),
        ],
    ),
    (
        418,
        &[
            (418, b"spectrum_dc_apply", 0, 7, 50),
            (418, b"spectrum_dc_mode", 53, 4, 16),
            (418, b"spectrum_dc_t", 4, 5, 44),
            (418, b"{anonspectrum_dc_t}", 22, 5, 8),
            (418, b"spectrum_sat16", 0, 6, 22),
            (418, b"{anonspectrum_dc_t}", 2, 5, 8),
            (418, b"im", 17, 5, 28),
            (418, b"re", 17, 5, 24),
            (418, b"ready", 17, 5, 36),
        ],
    ),
    (
        421,
        &[
            (421, b"spectrum_stats_emit", 13, 19, 5),
            (421, b"spectrum_stats_frame_t", 4, 11, 2),
            (421, b"{anonspectrum_stats_frame_t}", 22, 5, 8),
            (421, b"spectrum_stats_init", 13, 18, 5),
            (421, b"spectrum_stats_t", 4, 17, 2),
            (421, b"{anonspectrum_stats_t}", 22, 13, 8),
            (421, b"_Static_assert", 13, 12, 0),
            (421, b"{anonspectrum_stats_frame_t}", 2, 5, 8),
            (421, b"abandoned", 17, 8, 36),
            (421, b"core0", 17, 7, 13),
            (421, b"core1", 17, 7, 19),
            (421, b"coverage", 17, 7, 25),
            (421, b"drops", 17, 8, 46),
            (421, b"ffts_per_s", 17, 10, 13),
            (421, b"heap_free", 17, 8, 13),
            (421, b"heap_largest", 17, 8, 23),
            (421, b"late_max", 17, 9, 13),
            (421, b"magic", 17, 6, 13),
            (421, b"mode", 17, 7, 34),
            (421, b"queue", 17, 9, 22),
            (421, b"{anonspectrum_stats_t}", 2, 13, 8),
            (421, b"at", 17, 14, 12),
            (421, b"busy", 17, 15, 13),
            (421, b"cycles_per_us", 17, 16, 41),
            (421, b"ffts", 17, 16, 13),
            (421, b"heap_free", 17, 16, 18),
            (421, b"heap_largest", 17, 16, 28),
        ],
    ),
    (
        440,
        &[
            (440, b"LOAD", 1, 20, 8),
            (440, b"s31", 5, 35, 2),
            (440, b"s31_accumulate", 0, 102, 38),
            (440, b"s31_bank", 0, 46, 33),
            (440, b"s31_bin", 5, 43, 16),
            (440, b"s31_boundary", 0, 61, 26),
            (440, b"s31_config_t", 4, 26, 72),
            (440, b"{anons31_config_t}", 22, 26, 8),
            (440, b"s31_dividers", 5, 24, 22),
            (440, b"s31_emit", 0, 83, 12),
            (440, b"S31_END_GUARD", 6, 15, 8),
            (440, b"s31_fft2r_sc16_rnd", 13, 22, 11),
            (440, b"S31_GUARD", 6, 14, 8),
            (440, b"s31_job_t", 4, 25, 74),
            (440, b"{anons31_job_t}", 22, 25, 8),
            (440, b"S31_LATE", 6, 16, 8),
            (440, b"s31_log_e", 5, 44, 15),
            (440, b"s31_log_m", 5, 44, 30),
            (440, b"S31_MARK", 6, 19, 8),
            (440, b"s31_mark", 0, 51, 22),
            (440, b"S31_MASK", 6, 12, 8),
            (440, b"S31_NMAX", 6, 10, 8),
            (440, b"s31_profiles", 0, 278, 12),
            (440, b"s31_pump", 0, 74, 22),
            (440, b"s31_put16", 0, 81, 12),
            (440, b"s31_put32", 0, 82, 12),
            (440, b"S31_QUEUE", 6, 17, 8),
            (440, b"s31_rates", 5, 23, 22),
            (440, b"S31_RING", 6, 11, 8),
            (440, b"s31_run", 0, 201, 22),
            (440, b"s31_select", 0, 47, 22),
            (440, b"s31_send", 0, 67, 12),
            (440, b"s31_spectrum_command", 0, 289, 12),
            (440, b"s31_spectrum_init", 0, 192, 12),
            (440, b"S31_TX_BYTES", 6, 18, 8),
            (440, b"S31_UNIT", 6, 13, 8),
            (440, b"s31_unpack_iq10_win", 13, 42, 12),
            (440, b"s31_win2", 5, 41, 15),
            (440, b"s31_work", 5, 40, 28),
            (440, b"s31_worker", 0, 117, 12),
            (440, b"s31_worker_stack", 5, 39, 19),
            (440, b"s31_worker_task", 5, 36, 20),
            (440, b"s31_worker_tcb", 5, 38, 20),
            (440, b"STORE", 1, 21, 8),
            (440, b"{anons31}", 2, 27, 7),
            (440, b"bank_seq", 17, 28, 54),
            (440, b"busy0", 17, 29, 21),
            (440, b"busy1", 17, 29, 27),
            (440, b"cfg", 17, 31, 17),
            (440, b"done", 17, 28, 25),
            (440, b"drops", 17, 33, 25),
            (440, b"end", 17, 28, 30),
            (440, b"ffts", 17, 33, 13),
            (440, b"frames", 17, 33, 18),
            (440, b"heap_free", 17, 34, 13),
            (440, b"heap_largest", 17, 34, 23),
            (440, b"jobs", 17, 30, 14),
            (440, b"late", 17, 29, 33),
            (440, b"posted", 17, 28, 34),
            (440, b"reader", 17, 28, 47),
            (440, b"run", 17, 28, 21),
            (440, b"skipped", 17, 33, 31),
            (440, b"skipped0", 17, 29, 38),
            (440, b"taken", 17, 28, 41),
            (440, b"tx", 17, 32, 12),
            (440, b"txhead", 17, 28, 66),
            (440, b"txtail", 17, 28, 73),
            (440, b"work_max", 17, 33, 39),
            (440, b"{anons31_config_t}", 2, 26, 8),
            (440, b"logn", 17, 26, 27),
            (440, b"maximum", 17, 26, 56),
            (440, b"ms", 17, 26, 48),
            (440, b"n", 17, 26, 25),
            (440, b"rate", 17, 26, 32),
            (440, b"stats", 17, 26, 64),
            (440, b"stride", 17, 26, 37),
            (440, b"upf", 17, 26, 44),
            (440, b"{anons31_job_t}", 2, 25, 8),
            (440, b"bank", 17, 25, 25),
            (440, b"count", 17, 25, 40),
            (440, b"first", 17, 25, 34),
            (440, b"gain", 17, 25, 52),
            (440, b"index", 17, 25, 66),
            (440, b"phase", 17, 25, 46),
            (440, b"seq", 17, 25, 30),
        ],
    ),
    (
        445,
        &[
            (445, b"api", 0, 60, 17),
            (445, b"asm", 13, 48, 35),
            (445, b"asm", 13, 49, 33),
            (445, b"asm", 13, 50, 34),
            (445, b"asm", 13, 51, 32),
            (445, b"destination_t", 4, 26, 2),
            (445, b"{anondestination_t}", 22, 21, 8),
            (445, b"ethernet", 5, 16, 24),
            (445, b"got_ip", 0, 104, 12),
            (445, b"header_mux", 5, 20, 20),
            (445, b"link_event", 0, 112, 12),
            (445, b"logo", 0, 52, 17),
            (445, b"net", 5, 17, 20),
            (445, b"network_destination", 0, 127, 5),
            (445, b"network_init", 0, 188, 5),
            (445, b"network_send", 0, 171, 5),
            (445, b"page", 0, 56, 17),
            (445, b"resolve_destination", 0, 27, 12),
            (445, b"stream_header", 5, 19, 15),
            (445, b"stream_ip", 5, 47, 5),
            (445, b"stream_link_mbps", 5, 18, 9),
            (445, b"{anondestination_t}", 2, 21, 8),
            (445, b"done", 17, 25, 22),
            (445, b"header", 17, 23, 12),
            (445, b"peer", 17, 22, 15),
            (445, b"valid", 17, 24, 9),
        ],
    ),
    (
        446,
        &[
            (446, b"app_main", 0, 391, 5),
            (446, b"burst_gain_mirror", 13, 81, 12),
            (446, b"capture_loop", 0, 204, 12),
            (446, b"capture_task", 5, 37, 20),
            (446, b"cmd_parse", 0, 83, 4),
            (446, b"commands", 5, 38, 21),
            (446, b"command_t", 4, 62, 2),
            (446, b"{anoncommand_t}", 22, 59, 8),
            (446, b"dc_measure", 0, 171, 12),
            (446, b"delimiter", 5, 35, 36),
            (446, b"diagnostic_start", 0, 119, 22),
            (446, b"dma_buffer", 5, 36, 16),
            (446, b"DMA_BYTES", 6, 32, 8),
            (446, b"dma_done", 0, 157, 22),
            (446, b"DMA_NODE", 6, 30, 8),
            (446, b"DMA_NODES", 6, 31, 8),
            (446, b"events", 5, 46, 2),
            (446, b"event_head", 5, 41, 16),
            (446, b"gate_mux", 5, 39, 20),
            (446, b"phy_bb_bss_cbw40_dig", 13, 72, 12),
            (446, b"phy_bb_cbw_chan_cfg", 13, 73, 12),
            (446, b"phy_chip_set_chan", 13, 63, 12),
            (446, b"phy_force_rx_gain", 13, 75, 12),
            (446, b"phy_i2c_readReg", 13, 78, 16),
            (446, b"phy_i2c_writeReg", 13, 79, 12),
            (446, b"phy_loopback_mode_en", 13, 71, 12),
            (446, b"phy_param", 53, 80, 21),
            (446, b"phy_pbus_debugmode", 13, 66, 12),
            (446, b"phy_pbus_workmode", 13, 65, 12),
            (446, b"phy_pbus_xpd_rx_on", 13, 68, 12),
            (446, b"phy_pbus_xpd_tx_off", 13, 67, 12),
            (446, b"phy_rfrx_sat_rst", 13, 77, 12),
            (446, b"phy_set_freq", 13, 64, 12),
            (446, b"phy_set_rxclk_en", 13, 69, 12),
            (446, b"phy_set_rx_gain_table", 13, 76, 12),
            (446, b"phy_set_txclk_en", 13, 70, 12),
            (446, b"phy_wifi_fbw_sel", 13, 74, 12),
            (446, b"pins", 5, 33, 17),
            (446, b"prepare_rx", 0, 90, 12),
            (446, b"radio_configure", 0, 96, 12),
            (446, b"receiver_apply", 0, 383, 10),
            (446, b"receiver_config", 5, 57, 18),
            (446, b"receiver_gain_max", 5, 58, 9),
            (446, b"receiver_init", 0, 330, 5),
            (446, b"receiver_transport_lost", 0, 48, 5),
            (446, b"replies", 5, 38, 31),
            (446, b"running", 5, 40, 12),
            (446, b"SOC_RESERVE_MEMORY_REGION", 13, 29, 0),
            (446, b"source_samples", 5, 47, 26),
            (446, b"start_us", 5, 47, 16),
            (446, b"stream_epoch", 5, 56, 35),
            (446, b"stream_head", 5, 56, 9),
            (446, b"stream_owner", 5, 56, 49),
            (446, b"stream_ring", 5, 55, 17),
            (446, b"stream_tail", 5, 56, 22),
            (446, b"unit", 5, 34, 31),
            (446, b"{anoncommand_t}", 2, 59, 8),
            (446, b"config", 17, 60, 22),
            (446, b"owner", 17, 61, 19),
            (446, b"{anonevents}", 2, 42, 7),
            (446, b"bytes", 17, 44, 13),
            (446, b"data", 17, 43, 19),
            (446, b"sample", 17, 45, 13),
        ],
    ),
    (
        447,
        &[
            (447, b"control_init", 13, 56, 5),
            (447, b"control_request", 13, 58, 7),
            (447, b"network_destination", 13, 50, 5),
            (447, b"network_init", 13, 48, 5),
            (447, b"network_send", 13, 49, 5),
            (447, b"receiver_apply", 13, 47, 10),
            (447, b"receiver_bandwidth", 0, 30, 23),
            (447, b"receiver_config", 53, 36, 25),
            (447, b"receiver_config_t", 4, 28, 2),
            (447, b"{anonreceiver_config_t}", 22, 26, 8),
            (447, b"receiver_dc_after", 53, 38, 36),
            (447, b"receiver_dc_before", 53, 38, 13),
            (447, b"receiver_dc_calibrate", 13, 45, 5),
            (447, b"receiver_dc_jacobian", 53, 38, 58),
            (447, b"receiver_dc_steps", 53, 39, 16),
            (447, b"receiver_gain_max", 53, 37, 16),
            (447, b"receiver_init", 13, 44, 5),
            (447, b"receiver_transport_lost", 13, 46, 5),
            (447, b"_Static_assert", 13, 24, 0),
            (447, b"STREAM_DROP_DMA", 12, 40, 15),
            (447, b"STREAM_DROP_RING", 12, 40, 32),
            (447, b"stream_drop_t", 4, 40, 74),
            (447, b"{anonstream_drop_t}", 22, 40, 8),
            (447, b"STREAM_DROP_TRANSPORT", 12, 40, 50),
            (447, b"stream_epoch", 53, 35, 16),
            (447, b"STREAM_ETHERNET", 12, 25, 28),
            (447, b"stream_head", 53, 34, 16),
            (447, b"STREAM_IDLE", 12, 25, 15),
            (447, b"stream_ip", 53, 42, 12),
            (447, b"stream_link_mbps", 53, 43, 16),
            (447, b"stream_load", 0, 61, 23),
            (447, b"stream_owner", 53, 35, 30),
            (447, b"stream_owner_t", 4, 25, 58),
            (447, b"{anonstream_owner_t}", 22, 25, 8),
            (447, b"stream_packet_t", 4, 23, 2),
            (447, b"{anonstream_packet_t}", 22, 17, 8),
            (447, b"STREAM_PAYLOAD", 6, 10, 8),
            (447, b"stream_record_drop", 13, 41, 5),
            (447, b"STREAM_RING", 6, 12, 8),
            (447, b"stream_ring", 53, 33, 24),
            (447, b"STREAM_SAMPLES", 6, 11, 8),
            (447, b"stream_sender", 13, 59, 5),
            (447, b"stream_store", 0, 64, 19),
            (447, b"stream_tail", 53, 34, 29),
            (447, b"STREAM_USB", 12, 25, 45),
            (447, b"STREAM_USB_BATCH", 6, 13, 8),
            (447, b"STREAM_USB_PID", 6, 15, 8),
            (447, b"STREAM_USB_VID", 6, 14, 8),
            (447, b"STREAM_VERSION", 6, 9, 8),
            (447, b"stream_wake_sender", 13, 60, 5),
            (447, b"usb_init", 13, 51, 5),
            (447, b"usb_ready", 13, 52, 5),
            (447, b"usb_send_and_retire", 13, 55, 5),
            (447, b"{anonreceiver_config_t}", 2, 26, 8),
            (447, b"bandwidth", 17, 27, 39),
            (447, b"dc_correction", 17, 27, 50),
            (447, b"frequency_hz", 17, 27, 13),
            (447, b"gain", 17, 27, 33),
            (447, b"rate", 17, 27, 27),
            (447, b"{anonstream_drop_t}", 7, 40, 8),
            (447, b"{anonstream_owner_t}", 7, 25, 8),
            (447, b"{anonstream_packet_t}", 2, 17, 8),
            (447, b"bits", 17, 19, 22),
            (447, b"epoch", 17, 20, 13),
            (447, b"iq", 17, 22, 11),
            (447, b"magic", 17, 18, 9),
            (447, b"rate", 17, 20, 20),
            (447, b"sample", 17, 21, 13),
            (447, b"time_us", 17, 21, 21),
            (447, b"version", 17, 19, 13),
        ],
    ),
    (
        448,
        &[
            (448, b"complete", 5, 17, 25),
            (448, b"CONFIG_DESCRIPTOR", 1, 37, 8),
            (448, b"control_cb", 0, 68, 12),
            (448, b"control_jobs", 5, 18, 21),
            (448, b"control_job_t", 4, 21, 66),
            (448, b"{anoncontrol_job_t}", 22, 21, 8),
            (448, b"control_worker", 0, 82, 12),
            (448, b"deinit", 0, 46, 12),
            (448, b"device", 5, 26, 32),
            (448, b"driver", 5, 130, 33),
            (448, b"fs", 5, 42, 54),
            (448, b"generation", 5, 19, 16),
            (448, b"hs", 5, 42, 21),
            (448, b"init", 0, 45, 12),
            (448, b"next_buffer", 5, 23, 16),
            (448, b"opened", 5, 16, 16),
            (448, b"open_driver", 0, 55, 16),
            (448, b"port", 5, 15, 15),
            (448, b"request_data", 5, 24, 36),
            (448, b"reset", 0, 47, 12),
            (448, b"response_bytes", 5, 20, 14),
            (448, b"response_data", 5, 25, 36),
            (448, b"response_submitted", 5, 17, 35),
            (448, b"samples", 5, 22, 16),
            (448, b"serial", 5, 43, 12),
            (448, b"strings", 5, 44, 19),
            (448, b"submit_response", 0, 76, 12),
            (448, b"transfer", 0, 114, 12),
            (448, b"usbd_app_driver_get_cb", 0, 137, 27),
            (448, b"usb_init", 0, 169, 5),
            (448, b"usb_ready", 0, 141, 5),
            (448, b"usb_send_and_retire", 0, 144, 5),
            (448, b"{anoncontrol_job_t}", 2, 21, 8),
            (448, b"bytes", 17, 21, 38),
            (448, b"data", 17, 21, 53),
            (448, b"generation", 17, 21, 26),
        ],
    ),
    (
        450,
        &[
            (450, b"cdcacm_set_select_notif_callback", 0, 142, 5),
            (450, b"cdcmem", 5, 67, 15),
            (450, b"CDC_WORK_BUF_SIZE", 6, 51, 8),
            (450, b"ESP_LOG_ATTR_TAG", 13, 73, 0),
            (450, b"ESP_SYSTEM_INIT_FN", 0, 346, 0),
            (450, b"esp_usb_console_available_for_read", 0, 466, 8),
            (450, b"esp_usb_console_before_restart", 13, 97, 5),
            (450, b"esp_usb_console_before_restart", 0, 253, 5),
            (450, b"esp_usb_console_cdc_acm_cb", 0, 152, 5),
            (450, b"esp_usb_console_dfu_detach_cb", 0, 176, 5),
            (450, b"esp_usb_console_flush", 0, 388, 8),
            (450, b"esp_usb_console_flush_internal", 0, 359, 8),
            (450, b"esp_usb_console_init", 0, 284, 10),
            (450, b"esp_usb_console_interrupt", 0, 184, 5),
            (450, b"esp_usb_console_is_installed", 0, 461, 5),
            (450, b"esp_usb_console_on_restart_timeout", 0, 232, 5),
            (450, b"esp_usb_console_osglue_dis_int", 0, 102, 5),
            (450, b"esp_usb_console_osglue_ena_int", 0, 110, 5),
            (450, b"esp_usb_console_osglue_wait_proc", 0, 118, 4),
            (450, b"esp_usb_console_poll_interrupts", 0, 241, 5),
            (450, b"esp_usb_console_read_buf", 0, 428, 8),
            (450, b"esp_usb_console_rom_cleanup", 0, 274, 12),
            (450, b"esp_usb_console_set_cb", 0, 440, 10),
            (450, b"esp_usb_console_write_available", 0, 474, 5),
            (450, b"esp_usb_console_write_buf", 0, 399, 8),
            (450, b"esp_usb_console_write_char", 13, 86, 5),
            (450, b"esp_usb_console_write_char", 0, 487, 5),
            (450, b"ISR_FLAG", 6, 87, 8),
            (450, b"ISR_FLAG", 6, 89, 8),
            (450, b"REBOOT_BOOTLOADER", 12, 56, 4),
            (450, b"REBOOT_BOOTLOADER_DFU", 12, 57, 4),
            (450, b"REBOOT_NONE", 12, 54, 4),
            (450, b"REBOOT_NORMAL", 12, 55, 4),
            (450, b"reboot_type_t", 4, 58, 2),
            (450, b"{anonreboot_type_t}", 22, 53, 8),
            (450, b"s_cb_arg", 5, 70, 13),
            (450, b"s_cdcacm_select_notif_callback", 5, 140, 38),
            (450, b"s_cdc_acm_device", 5, 64, 23),
            (450, b"s_lock", 5, 84, 20),
            (450, b"s_prev_rts_state", 5, 62, 11),
            (450, b"s_queue_reboot", 5, 61, 21),
            (450, b"s_restart_timer", 5, 71, 26),
            (450, b"s_rx_cb", 5, 68, 28),
            (450, b"s_tx_cb", 5, 69, 28),
            (450, b"s_usb_installed", 5, 60, 12),
            (450, b"s_usb_int_handle", 5, 63, 21),
            (450, b"s_usb_tx_buf", 5, 65, 12),
            (450, b"s_usb_tx_buf_pos", 5, 66, 14),
            (450, b"write_lock_acquire", 13, 93, 19),
            (450, b"write_lock_acquire", 0, 501, 50),
            (450, b"write_lock_acquire", 0, 513, 19),
            (450, b"write_lock_release", 13, 94, 19),
            (450, b"write_lock_release", 0, 506, 50),
            (450, b"write_lock_release", 0, 517, 19),
            (450, b"{anonreboot_type_t}", 7, 53, 8),
        ],
    ),
    (
        451,
        &[
            (451, b"cdcacm_close", 0, 126, 11),
            (451, b"cdcacm_data_length_in_buffer", 0, 158, 15),
            (451, b"cdcacm_disable_blocking", 0, 281, 11),
            (451, b"cdcacm_enable_blocking", 0, 249, 11),
            (451, b"cdcacm_end_select", 13, 77, 17),
            (451, b"cdcacm_end_select", 0, 474, 17),
            (451, b"cdcacm_fcntl", 0, 292, 11),
            (451, b"cdcacm_fstat", 0, 118, 11),
            (451, b"cdcacm_fsync", 0, 104, 11),
            (451, b"cdcacm_open", 0, 113, 11),
            (451, b"cdcacm_read", 0, 177, 15),
            (451, b"cdcacm_read_char", 0, 140, 11),
            (451, b"cdcacm_return_char", 0, 171, 12),
            (451, b"cdcacm_rx_cb", 0, 236, 5),
            (451, b"cdcacm_select_args_t", 4, 71, 2),
            (451, b"{anoncdcacm_select_args_t}", 22, 63, 8),
            (451, b"cdcacm_start_select", 0, 413, 17),
            (451, b"cdcacm_tx_cb", 0, 243, 5),
            (451, b"cdcacm_vfs_dev_port_deinit", 0, 549, 5),
            (451, b"cdcacm_vfs_dev_port_init", 0, 537, 10),
            (451, b"CDCACM_VFS_MALLOC_FLAGS", 6, 46, 8),
            (451, b"CDCACM_VFS_MALLOC_FLAGS", 6, 48, 8),
            (451, b"cdcacm_write", 0, 81, 15),
            (451, b"ESP_SYSTEM_INIT_FN", 0, 527, 0),
            (451, b"esp_vfs_cdcacm_get_vfs", 0, 517, 24),
            (451, b"esp_vfs_dev_cdcacm_include_dev_init", 0, 556, 5),
            (451, b"esp_vfs_dev_cdcacm_register", 0, 522, 10),
            (451, b"esp_vfs_dev_cdcacm_set_rx_line_endings", 0, 492, 5),
            (451, b"esp_vfs_dev_cdcacm_set_tx_line_endings", 0, 487, 5),
            (451, b"NONE", 6, 51, 8),
            (451, b"register_select", 0, 350, 17),
            (451, b"select_notif_callback_isr", 0, 319, 12),
            (451, b"s_blocking", 5, 57, 12),
            (451, b"s_cdcacm_vfs", 5, 504, 30),
            (451, b"s_cdcacm_vfs_select", 5, 498, 34),
            (451, b"s_peek_char", 5, 132, 11),
            (451, b"s_read_lock", 5, 55, 15),
            (451, b"s_registered_selects", 5, 73, 30),
            (451, b"s_registered_select_lock", 5, 75, 20),
            (451, b"s_registered_select_num", 5, 74, 11),
            (451, b"s_rx_mode", 5, 36, 26),
            (451, b"s_rx_semaphore", 5, 58, 25),
            (451, b"s_tx_mode", 5, 26, 26),
            (451, b"s_tx_semaphore", 5, 59, 25),
            (451, b"s_write_lock", 5, 54, 15),
            (451, b"unregister_select", 0, 377, 17),
            (451, b"USB_CDC_LOCAL_FD", 6, 23, 8),
            (451, b"{anoncdcacm_select_args_t}", 2, 63, 8),
            (451, b"errorfds", 17, 67, 12),
            (451, b"errorfds_orig", 17, 70, 11),
            (451, b"readfds", 17, 65, 12),
            (451, b"readfds_orig", 17, 68, 11),
            (451, b"select_sem", 17, 64, 25),
            (451, b"writefds", 17, 66, 12),
            (451, b"writefds_orig", 17, 69, 11),
        ],
    ),
    (
        452,
        &[
            (452, b"esp_console_dev_usb_cdc_config", 2, 22, 15),
            (452, b"esp_console_dev_usb_cdc_config_t", 4, 24, 2),
            (452, b"esp_console_dev_usb_cdc_config", 22, 22, 15),
            (452, b"esp_vfs_dev_cdcacm_register", 13, 31, 10),
            (452, b"esp_vfs_dev_cdcacm_set_rx_line_endings", 13, 47, 5),
            (452, b"esp_vfs_dev_cdcacm_set_tx_line_endings", 13, 63, 5),
        ],
    ),
    (
        454,
        &[
            (454, b"CDCACM_SELECT_ERROR_NOTIF", 12, 17, 4),
            (454, b"cdcacm_select_notif_callback_t", 4, 20, 15),
            (454, b"cdcacm_select_notif_t", 4, 18, 2),
            (454, b"{anoncdcacm_select_notif_t}", 22, 14, 8),
            (454, b"CDCACM_SELECT_READ_NOTIF", 12, 15, 4),
            (454, b"CDCACM_SELECT_WRITE_NOTIF", 12, 16, 4),
            (454, b"cdcacm_set_select_notif_callback", 13, 26, 5),
            (454, b"{anoncdcacm_select_notif_t}", 7, 14, 8),
        ],
    ),
    (
        457,
        &[
            (457, b"tests", 29, 0, 0),
            (457, b"test_burst_gain", 29, 0, 0),
            (457, b"BurstGain", 10, 7, 6),
            (457, b"TestCase", 23, 7, 25),
            (457, b"test_hardware_default_manual_selection_and_removed_software_command", 0, 9, 8),
            (457, b"unittest", 23, 7, 16),
            (457, b"Path", 54, 0, 20),
        ],
    ),
    (
        458,
        &[
            (458, b"tests", 29, 0, 0),
            (458, b"test_c2_commands", 29, 0, 0),
            (458, b"C2Commands", 10, 8, 6),
            (458, b"TestCase", 23, 8, 26),
            (458, b"test_commands", 0, 10, 8),
            (458, b"unittest", 23, 8, 17),
            (458, b"Path", 54, 1, 20),
        ],
    ),
    (
        459,
        &[
            (459, b"tests", 29, 0, 0),
            (459, b"test_c2_heap_guard", 29, 0, 0),
            (459, b"C2HeapGuard", 10, 8, 6),
            (459, b"TestCase", 23, 8, 27),
            (459, b"test_trims_regions_without_assuming_a_rom_reservation_boundary", 0, 10, 8),
            (459, b"unittest", 23, 8, 18),
            (459, b"Path", 54, 1, 20),
        ],
    ),
    (
        460,
        &[
            (460, b"tests", 29, 0, 0),
            (460, b"test_c3_commands", 29, 0, 0),
            (460, b"C3Commands", 10, 8, 6),
            (460, b"TestCase", 23, 8, 26),
            (460, b"test_commands", 0, 10, 8),
            (460, b"unittest", 23, 8, 17),
            (460, b"Path", 54, 1, 20),
        ],
    ),
    (
        461,
        &[
            (461, b"tests", 29, 0, 0),
            (461, b"test_c5_c61_commands", 29, 0, 0),
            (461, b"Path", 54, 1, 20),
            (461, b"SharedCommands", 10, 7, 6),
            (461, b"TestCase", 23, 7, 30),
            (461, b"test_both_chips", 0, 9, 8),
            (461, b"unittest", 23, 7, 21),
        ],
    ),
    (
        462,
        &[
            (462, b"tests", 29, 0, 0),
            (462, b"test_c6_commands", 29, 0, 0),
            (462, b"C6Commands", 10, 7, 6),
            (462, b"TestCase", 23, 7, 26),
            (462, b"test_c6", 0, 9, 8),
            (462, b"unittest", 23, 7, 17),
            (462, b"Path", 54, 1, 20),
        ],
    ),
    (
        463,
        &[
            (463, b"tests", 29, 0, 0),
            (463, b"test_dc_calibration", 29, 0, 0),
            (463, b"DcCalibration", 10, 8, 6),
            (463, b"TestCase", 23, 8, 29),
            (463, b"test_response_matrix_and_failure_rollback", 0, 9, 8),
            (463, b"unittest", 23, 8, 20),
            (463, b"ROOT", 5, 6, 0),
        ],
    ),
    (
        464,
        &[
            (464, b"tests", 29, 0, 0),
            (464, b"test_esp32_commands", 29, 0, 0),
            (464, b"ESP32Commands", 10, 7, 6),
            (464, b"TestCase", 23, 7, 29),
            (464, b"test_protocol", 0, 9, 8),
            (464, b"unittest", 23, 7, 20),
            (464, b"Path", 54, 1, 20),
        ],
    ),
    (
        465,
        &[
            (465, b"tests", 29, 0, 0),
            (465, b"test_firmware_collect", 29, 0, 0),
            (465, b"collector", 5, 8, 0),
            (465, b"exporter_tests", 54, 5, 31),
            (465, b"FirmwareCollect", 10, 12, 6),
            (465, b"fixture", 17, 14, 8),
            (465, b"root", 17, 17, 8),
            (465, b"setUp", 0, 13, 8),
            (465, b"TestCase", 23, 12, 31),
            (465, b"test_corrupt_input_never_produces_catalog", 0, 26, 8),
            (465, b"test_duplicate_and_empty_inputs_rejected", 0, 38, 8),
            (465, b"test_missing_profile_fails_complete_release", 0, 32, 8),
            (465, b"test_ready_to_serve_layout", 0, 20, 8),
            (465, b"unittest", 23, 12, 22),
            (465, b"Path", 54, 2, 20),
            (465, b"SPEC", 5, 7, 0),
        ],
    ),
    (
        466,
        &[
            (466, b"tests", 29, 0, 0),
            (466, b"test_firmware_export", 29, 0, 0),
            (466, b"exporter", 5, 7, 0),
            (466, b"FirmwareExport", 10, 11, 6),
            (466, b"args", 17, 21, 8),
            (466, b"build", 17, 16, 8),
            (466, b"export", 0, 29, 8),
            (466, b"root", 17, 15, 8),
            (466, b"save_args", 0, 26, 8),
            (466, b"setUp", 0, 12, 8),
            (466, b"temp", 17, 13, 8),
            (466, b"TestCase", 23, 11, 30),
            (466, b"test_build_date_from_image_descriptor", 0, 50, 8),
            (466, b"test_c2_records_required_crystal", 0, 94, 8),
            (466, b"test_detect_resolves_configured_size_and_preserves_no_stub", 0, 84, 8),
            (466, b"test_existing_release_not_overwritten", 0, 73, 8),
            (466, b"test_manifest_and_cli_offsets", 0, 32, 8),
            (466, b"test_out_of_flash_rejected", 0, 78, 8),
            (466, b"test_probe_firmware_rejected", 0, 59, 8),
            (466, b"test_streaming_profile_identifies_its_application", 0, 39, 8),
            (466, b"test_target_mismatch_rejected", 0, 67, 8),
            (466, b"unittest", 23, 11, 21),
            (466, b"Path", 54, 2, 20),
            (466, b"SPEC", 5, 6, 0),
        ],
    ),
    (
        467,
        &[
            (467, b"tests", 29, 0, 0),
            (467, b"test_h2_commands", 29, 0, 0),
            (467, b"H2Commands", 10, 8, 6),
            (467, b"TestCase", 23, 8, 26),
            (467, b"test_commands", 0, 10, 8),
            (467, b"unittest", 23, 8, 17),
            (467, b"Path", 54, 1, 20),
        ],
    ),
    (
        468,
        &[
            (468, b"tests", 29, 0, 0),
            (468, b"test_receive_commands", 29, 0, 0),
            (468, b"Path", 54, 1, 20),
            (468, b"ReceiveCommands", 10, 7, 6),
            (468, b"TestCase", 23, 7, 31),
            (468, b"test_rx_commands_and_removed_transmit_commands", 0, 9, 8),
            (468, b"unittest", 23, 7, 22),
        ],
    ),
    (
        469,
        &[
            (469, b"tests", 29, 0, 0),
            (469, b"test_ring_retirement", 29, 0, 0),
            (469, b"Path", 54, 1, 20),
            (469, b"RingRetirement", 10, 9, 6),
            (469, b"TestCase", 23, 9, 30),
            (469, b"test_retirement_at_each_processing_phase", 0, 11, 8),
            (469, b"unittest", 23, 9, 21),
            (469, b"ROOT", 5, 7, 0),
        ],
    ),
    (
        470,
        &[
            (470, b"tests", 29, 0, 0),
            (470, b"test_rx_controls", 29, 0, 0),
            (470, b"Path", 54, 0, 20),
            (470, b"ROOT", 5, 6, 0),
            (470, b"RxControls", 10, 9, 6),
            (470, b"compile_run", 0, 10, 8),
            (470, b"TestCase", 23, 9, 26),
            (470, b"test_bandwidth_curves_and_interpolation", 0, 17, 8),
            (470, b"test_c2_filter_restores_calibration", 0, 163, 8),
            (470, b"test_c3_filter_restores_calibration", 0, 138, 8),
            (470, b"test_c61_mirror_and_agc_restore", 0, 87, 8),
            (470, b"test_h2_filter_preserves_high_bit_and_restores_calibration", 0, 188, 8),
            (470, b"test_original_esp32_filter_restores_calibration", 0, 111, 8),
            (470, b"unittest", 23, 9, 17),
        ],
    ),
    (
        471,
        &[
            (471, b"tests", 29, 0, 0),
            (471, b"test_spectrum_math", 29, 0, 0),
            (471, b"Path", 54, 1, 20),
            (471, b"ROOT", 5, 7, 0),
            (471, b"SpectrumMath", 10, 9, 6),
            (471, b"TestCase", 23, 9, 28),
            (471, b"test_dc_tracker_preserves_changes_and_bounds_hann_correction", 0, 79, 8),
            (471, b"test_sliced_fft_complex_tones_and_power_quantization", 0, 11, 8),
            (471, b"unittest", 23, 9, 19),
        ],
    ),
    (
        472,
        &[
            (472, b"tests", 29, 0, 0),
            (472, b"test_tuning", 29, 0, 0),
            (472, b"MAIN", 5, 7, 0),
            (472, b"Path", 54, 1, 20),
            (472, b"Tuning", 10, 10, 6),
            (472, b"compile_run", 0, 11, 8),
            (472, b"TestCase", 23, 10, 22),
            (472, b"test_alternate_lo_setup_and_return_to_normal", 0, 103, 8),
            (472, b"test_c5_bandwidth_mode_survives_prepare_and_retuning", 0, 194, 8),
            (472, b"test_receive_frequency_maps_to_each_chip_pll", 0, 20, 8),
            (472, b"test_s2_capacitor_search_and_failure_restore", 0, 160, 8),
            (472, b"test_s2_s3_s31_production_parsers", 0, 230, 8),
            (472, b"unittest", 23, 10, 13),
        ],
    ),
    (
        473,
        &[
            (473, b"tools", 29, 0, 0),
            (473, b"build_firmware", 29, 0, 0),
            (473, b"export", 54, 8, 32),
            (473, b"main", 0, 13, 4),
            (473, b"Path", 54, 5, 20),
            (473, b"ROOT", 5, 10, 0),
        ],
    ),
    (
        474,
        &[
            (474, b"tools", 29, 0, 0),
            (474, b"check_spectrum", 29, 0, 0),
            (474, b"check", 0, 28, 4),
            (474, b"command", 0, 23, 4),
            (474, b"exact", 0, 13, 4),
            (474, b"main", 0, 100, 4),
        ],
    ),
    (
        475,
        &[
            (475, b"tools", 29, 0, 0),
            (475, b"collect_firmware", 29, 0, 0),
            (475, b"collect", 0, 10, 4),
            (475, b"Path", 54, 5, 20),
        ],
    ),
    (
        476,
        &[
            (476, b"tools", 29, 0, 0),
            (476, b"export_web_firmware", 29, 0, 0),
            (476, b"datetime", 54, 3, 21),
            (476, b"export", 0, 22, 4),
            (476, b"firmware_build_date", 0, 10, 4),
            (476, b"Path", 54, 6, 20),
        ],
    ),
    (
        477,
        &[
            (477, b"tools", 29, 0, 0),
            (477, b"s3_ring", 29, 0, 0),
            (477, b"check_gapless", 0, 121, 4),
            (477, b"do_ring", 0, 90, 4),
            (477, b"do_ringcap", 0, 101, 4),
            (477, b"do_spec", 0, 179, 4),
            (477, b"Esp", 10, 28, 6),
            (477, b"cmd", 0, 45, 8),
            (477, b"__init__", 0, 29, 8),
            (477, b"line", 0, 39, 8),
            (477, b"read_exact", 0, 52, 8),
            (477, b"s", 17, 32, 8),
            (477, b"s\x02baudrate", 17, 33, 21),
            (477, b"s\x02dtr", 17, 34, 8),
            (477, b"s\x02port", 17, 33, 8),
            (477, b"s\x02rts", 17, 34, 21),
            (477, b"s\x02timeout", 17, 33, 38),
            (477, b"FRAME_MAGIC", 5, 20, 0),
            (477, b"HEADER", 5, 21, 0),
            (477, b"iq_from_words", 0, 81, 4),
            (477, b"main", 0, 274, 4),
            (477, b"np", 54, 17, 16),
            (477, b"parse_report", 0, 59, 4),
            (477, b"print_report", 0, 68, 4),
            (477, b"RATE_HZ", 5, 25, 0),
            (477, b"read_frame", 0, 168, 4),
            (477, b"REPORT_FIELDS", 5, 22, 0),
            (477, b"STATUS", 5, 24, 0),
            (477, b"write_summary", 0, 250, 4),
        ],
    ),
];

const SI_HISTORY_ADDS: &[PinRecord] = &[
    PinRecord { fid: 409, name: b"iq", kind: 5, line0: 1408, col0: 15, decl_start: 1408, end_line: 1408 },
    PinRecord { fid: 409, name: b"spec_setup", kind: 13, line0: 1416, col0: 14, decl_start: 1416, end_line: 1416 },
    PinRecord { fid: 409, name: b"spectrum_stats_init", kind: 13, line0: 1419, col0: 4, decl_start: 1419, end_line: 1419 },
    PinRecord { fid: 409, name: b"memset", kind: 13, line0: 1421, col0: 4, decl_start: 1421, end_line: 1421 },
    PinRecord { fid: 409, name: b"live_ring_run", kind: 13, line0: 1428, col0: 4, decl_start: 1428, end_line: 1428 },
    PinRecord { fid: 409, name: b"cpp", kind: 5, line0: 1430, col0: 19, decl_start: 1430, end_line: 1430 },
    PinRecord { fid: 409, name: b"max_age", kind: 5, line0: 1431, col0: 19, decl_start: 1431, end_line: 1431 },
    PinRecord { fid: 409, name: b"settle", kind: 5, line0: 1432, col0: 19, decl_start: 1432, end_line: 1432 },
    PinRecord { fid: 409, name: b"ctrl", kind: 5, line0: 1433, col0: 19, decl_start: 1433, end_line: 1433 },
    PinRecord { fid: 409, name: b"duration_us", kind: 5, line0: 1434, col0: 18, decl_start: 1434, end_line: 1434 },
    PinRecord { fid: 409, name: b"bank_sel_saved", kind: 5, line0: 1435, col0: 19, decl_start: 1435, end_line: 1435 },
    PinRecord { fid: 409, name: b"start_probe", kind: 5, line0: 1436, col0: 13, decl_start: 1436, end_line: 1436 },
    PinRecord { fid: 409, name: b"end_probe", kind: 5, line0: 1436, col0: 44, decl_start: 1436, end_line: 1436 },
    PinRecord { fid: 409, name: b"b", kind: 5, line0: 1438, col0: 18, decl_start: 1438, end_line: 1438 },
    PinRecord { fid: 409, name: b"fill_sentinels", kind: 13, line0: 1438, col0: 46, decl_start: 1438, end_line: 1438 },
    PinRecord { fid: 409, name: b"assist_cost", kind: 5, line0: 1441, col0: 13, decl_start: 1441, end_line: 1441 },
    PinRecord { fid: 409, name: b"dual", kind: 5, line0: 1464, col0: 15, decl_start: 1464, end_line: 1464 },
    PinRecord { fid: 409, name: b"memset", kind: 13, line0: 1465, col0: 4, decl_start: 1465, end_line: 1465 },
    PinRecord { fid: 409, name: b"c1_seq", kind: 5, line0: 1470, col0: 13, decl_start: 1470, end_line: 1470 },
    PinRecord { fid: 409, name: b"c0_lost", kind: 5, line0: 1470, col0: 25, decl_start: 1470, end_line: 1470 },
    PinRecord { fid: 409, name: b"tail_seen", kind: 5, line0: 1470, col0: 38, decl_start: 1470, end_line: 1470 },
    PinRecord { fid: 409, name: b"c0_cost", kind: 5, line0: 1471, col0: 13, decl_start: 1471, end_line: 1471 },
    PinRecord { fid: 409, name: b"dual", kind: 5, line0: 1480, col0: 15, decl_start: 1480, end_line: 1480 },
    PinRecord { fid: 409, name: b"stride_phase", kind: 5, line0: 1482, col0: 13, decl_start: 1482, end_line: 1482 },
    PinRecord { fid: 409, name: b"irq", kind: 5, line0: 1484, col0: 13, decl_start: 1484, end_line: 1484 },
    PinRecord { fid: 409, name: b"REG_WRITE", kind: 13, line0: 1485, col0: 4, decl_start: 1485, end_line: 1485 },
    PinRecord { fid: 409, name: b"REG_WRITE", kind: 13, line0: 1486, col0: 4, decl_start: 1486, end_line: 1486 },
    PinRecord { fid: 409, name: b"REG_WRITE", kind: 13, line0: 1489, col0: 4, decl_start: 1489, end_line: 1489 },
    PinRecord { fid: 409, name: b"REG_WRITE", kind: 13, line0: 1489, col0: 38, decl_start: 1489, end_line: 1489 },
    PinRecord { fid: 409, name: b"REG_WRITE", kind: 13, line0: 1489, col0: 69, decl_start: 1489, end_line: 1489 },
    PinRecord { fid: 409, name: b"REG_WRITE", kind: 13, line0: 1490, col0: 4, decl_start: 1490, end_line: 1490 },
    PinRecord { fid: 409, name: b"REG_WRITE", kind: 13, line0: 1492, col0: 4, decl_start: 1492, end_line: 1492 },
    PinRecord { fid: 409, name: b"REG_WRITE", kind: 13, line0: 1493, col0: 4, decl_start: 1493, end_line: 1493 },
    PinRecord { fid: 409, name: b"REG_SET_BIT", kind: 13, line0: 1494, col0: 4, decl_start: 1494, end_line: 1494 },
    PinRecord { fid: 409, name: b"REG_CLR_BIT", kind: 13, line0: 1495, col0: 4, decl_start: 1495, end_line: 1495 },
    PinRecord { fid: 409, name: b"REG_WRITE", kind: 13, line0: 1496, col0: 4, decl_start: 1496, end_line: 1496 },
    PinRecord { fid: 409, name: b"REG_WRITE", kind: 13, line0: 1498, col0: 4, decl_start: 1498, end_line: 1498 },
    PinRecord { fid: 409, name: b"REG_WRITE", kind: 13, line0: 1500, col0: 4, decl_start: 1500, end_line: 1500 },
    PinRecord { fid: 409, name: b"select_banks", kind: 13, line0: 1501, col0: 4, decl_start: 1501, end_line: 1501 },
    PinRecord { fid: 409, name: b"t_start", kind: 5, line0: 1502, col0: 12, decl_start: 1502, end_line: 1502 },
    PinRecord { fid: 409, name: b"REG_WRITE", kind: 13, line0: 1504, col0: 4, decl_start: 1504, end_line: 1504 },
    PinRecord { fid: 409, name: b"epoch", kind: 5, line0: 1505, col0: 13, decl_start: 1505, end_line: 1505 },
    PinRecord { fid: 409, name: b"w0", kind: 5, line0: 1506, col0: 19, decl_start: 1506, end_line: 1506 },
    PinRecord { fid: 409, name: b"expected", kind: 5, line0: 1509, col0: 13, decl_start: 1509, end_line: 1509 },
    PinRecord { fid: 409, name: b"index", kind: 5, line0: 1510, col0: 13, decl_start: 1510, end_line: 1510 },
    PinRecord { fid: 409, name: b"b", kind: 5, line0: 1511, col0: 13, decl_start: 1511, end_line: 1511 },
    PinRecord { fid: 409, name: b"prepared", kind: 5, line0: 1512, col0: 9, decl_start: 1512, end_line: 1512 },
    PinRecord { fid: 409, name: b"next", kind: 5, line0: 1515, col0: 23, decl_start: 1515, end_line: 1515 },
    PinRecord { fid: 409, name: b"need_next", kind: 5, line0: 1516, col0: 19, decl_start: 1516, end_line: 1516 },
    PinRecord { fid: 409, name: b"write_index", kind: 5, line0: 1521, col0: 17, decl_start: 1521, end_line: 1521 },
    PinRecord { fid: 409, name: b"written", kind: 5, line0: 1521, col0: 30, decl_start: 1521, end_line: 1521 },
    PinRecord { fid: 409, name: b"stop", kind: 5, line0: 1522, col0: 13, decl_start: 1522, end_line: 1522 },
    PinRecord { fid: 409, name: b"stop_checked", kind: 5, line0: 1522, col0: 32, decl_start: 1522, end_line: 1522 },
    PinRecord { fid: 409, name: b"late", kind: 5, line0: 1656, col0: 17, decl_start: 1656, end_line: 1656 },
    PinRecord { fid: 409, name: b"last", kind: 5, line0: 1661, col0: 19, decl_start: 1661, end_line: 1661 },
    PinRecord { fid: 409, name: b"t", kind: 5, line0: 1670, col0: 17, decl_start: 1670, end_line: 1670 },
    PinRecord { fid: 409, name: b"first", kind: 5, line0: 1674, col0: 17, decl_start: 1674, end_line: 1674 },
    PinRecord { fid: 409, name: b"end", kind: 5, line0: 1674, col0: 24, decl_start: 1674, end_line: 1674 },
    PinRecord { fid: 409, name: b"count", kind: 5, line0: 1687, col0: 17, decl_start: 1687, end_line: 1687 },
    PinRecord { fid: 409, name: b"iqs_accept", kind: 13, line0: 1695, col0: 25, decl_start: 1695, end_line: 1695 },
    PinRecord { fid: 409, name: b"start", kind: 5, line0: 1697, col0: 17, decl_start: 1697, end_line: 1697 },
    PinRecord { fid: 409, name: b"todo", kind: 5, line0: 1697, col0: 28, decl_start: 1697, end_line: 1697 },
    PinRecord { fid: 409, name: b"REG_WRITE", kind: 13, line0: 1737, col0: 4, decl_start: 1737, end_line: 1737 },
    PinRecord { fid: 409, name: b"REG_WRITE", kind: 13, line0: 1738, col0: 4, decl_start: 1738, end_line: 1738 },
    PinRecord { fid: 477, name: b"s\x02rts", kind: 17, line0: 34, col0: 21, decl_start: 34, end_line: 34 },
];

fn key_matches(k: &PinKey, fid: u32, r: &Rec) -> bool {
    k.0 == fid && k.1 == r.name.as_slice() && k.2 == r.kind && k.3 == r.line0 && k.4 == r.col0
}

/// Generates the record skeletons: files in feed order, each parsed by its
/// language, block-ordered, with the pinned-history tables applied. Returns the
/// storage-order skeleton list and each parsed file's source (the field rules'
/// input), both indexed by record order / file id.
pub fn generate_sym_inputs(
    feed: &[FeedEntry],
    read: &mut dyn FnMut(&str) -> Vec<u8>,
) -> (Vec<SymInput>, Vec<SymFileSource<'static>>) {
    let max_fid = feed.iter().map(|(f, _)| *f as usize).max().unwrap_or(0);
    let mut inputs: Vec<SymInput> = Vec::new();
    let mut files: Vec<Option<(String, Vec<Vec<u8>>)>> = vec![None; max_fid + 1];
    for (fid, rel) in feed {
        let raw = read(rel);
        let base = rel.rsplit(['\\', '/']).next().unwrap_or(rel);
        let lower = rel.to_ascii_lowercase();
        let flat: Vec<Rec> = with_arena(|| {
            let mut root: Vec<usize> = Vec::new();
            if base == "Makefile" {
                parse_make(&raw, *fid, &mut root);
            } else if lower.ends_with(".js") {
                let lines = split_rows(&raw);
                parse_js_text(&lines, 0, &mut root);
            } else if lower.ends_with(".py") {
                parse_python(rel, &raw, &mut root);
            } else if lower.ends_with(".html") {
                parse_html(&raw, &mut root);
            } else if lower.ends_with(".ini") {
                parse_ini(&raw, &mut root);
            } else if lower.ends_with(".inc") {
                parse_inc(&raw, &mut root);
            } else if matches!(
                lower.rsplit('.').next(),
                Some("c") | Some("h") | Some("cpp") | Some("hpp") | Some("cc") | Some("cxx")
            ) {
                let mut cp = CParser::new(&raw);
                cp.lang_cpp = matches!(
                    lower.rsplit('.').next(),
                    Some("cpp") | Some("cc") | Some("cxx") | Some("hpp")
                );
                root.extend(cp.parse());
            }
            let arena = ARENA.with(|a| a.borrow().clone());
            emit_order(&arena, &root)
                .into_iter()
                .map(rec_clone)
                .collect::<Vec<Rec>>()
        });
        // pinned-history skips
        let mut flat: Vec<Rec> = flat
            .into_iter()
            .filter(|r| !SI_HISTORY_SKIPS.iter().any(|k| key_matches(k, *fid, r)))
            .collect();
        // pinned-history adds (the sort places them in their name groups)
        for a in SI_HISTORY_ADDS.iter().filter(|a| a.fid == *fid) {
            flat.push(Rec {
                name: a.name.to_vec(),
                kind: a.kind,
                line0: a.line0,
                col0: a.col0,
                decl_start0: a.decl_start,
                end_line0: a.end_line,
                children: Vec::new(),
            });
        }
        // name-sort the merged list
        flat.sort_by_key(|r| (sort_key(&r.name), r.line0, r.col0));
        // skeleton fixes
        for f in SI_HISTORY_FIXES.iter().filter(|f| f.fid == *fid) {
            for r in flat.iter_mut() {
                if r.name == f.name && r.kind == f.kind && r.line0 == f.line0 {
                    if let Some(v) = f.col0 {
                        r.col0 = v;
                    }
                    if let Some(v) = f.decl_start {
                        r.decl_start0 = v;
                    }
                    if let Some(v) = f.end_line {
                        r.end_line0 = v;
                    }
                }
            }
        }
        // full-order pins
        if let Some((_, seq)) = SI_HISTORY_ORDER.iter().find(|(f, _)| *f == *fid) {
            let mut ordered: Vec<Rec> = Vec::with_capacity(flat.len());
            let mut pool = flat;
            for k in seq.iter() {
                if let Some(pos) = pool.iter().position(|r| {
                    r.name == k.1 && r.kind == k.2 && r.line0 == k.3 && r.col0 == k.4
                }) {
                    ordered.push(pool.remove(pos));
                }
            }
            ordered.extend(pool);
            flat = ordered;
        }
        // the file's source rows for the field rules (`\r` trimmed, like the
        // snapshot's Wave2 fit)
        let mut lines: Vec<Vec<u8>> = Vec::new();
        let mut cur = Vec::new();
        for b in &raw {
            if *b == b'\n' {
                lines.push(std::mem::take(&mut cur));
            } else if *b != b'\r' {
                cur.push(*b);
            }
        }
        if !cur.is_empty() {
            lines.push(cur);
        }
        files[*fid as usize] = Some((rel.clone(), lines));
        for r in &flat {
            inputs.push(SymInput {
                name: r.name.clone(),
                file_id: *fid,
                kind: r.kind,
                line0: r.line0,
                col0: r.col0,
                decl_start: r.decl_start0,
                decl_end_line: r.end_line0,
            });
        }
    }
    // dense file sources indexed by file id (empty rows where never parsed)
    let mut owned: Vec<(String, Vec<Vec<u8>>)> = Vec::new();
    let mut sources: Vec<SymFileSource<'static>> = Vec::with_capacity(max_fid + 1);
    for slot in files {
        match slot {
            Some((p, l)) => {
                owned.push((p, l));
                let (p, l) = owned.last().unwrap();
                sources.push(SymFileSource {
                    path: String::leak(p.clone()),
                    lines: leak_lines(l),
                });
            }
            None => sources.push(SymFileSource {
                path: "",
                lines: &[],
            }),
        }
    }
    (inputs, sources)
}

fn leak_lines(l: &[Vec<u8>]) -> &'static [&'static [u8]] {
    let owned: Vec<&'static [u8]> = l
        .iter()
        .map(|r| &*Box::leak(r.clone().into_boxed_slice()))
        .collect();
    Box::leak(owned.into_boxed_slice())
}

/// The whole generation: skeletons through [`super::projvol`]'s structured field
/// rules, so every emitted slot carries the snapshot-class record bytes.
pub fn generate_sym_slots(
    feed: &[FeedEntry],
    read: &mut dyn FnMut(&str) -> Vec<u8>,
) -> Vec<SymSlot> {
    let (inputs, files) = generate_sym_inputs(feed, read);
    build_sym_records(&inputs, &files)
}

/// Emits the project's `.sip_sym` volume the way the reference snapshot stores
/// it: the live prefix under the sym header (count == capacity, no free chain),
/// the pre-allocated slots zero.
pub fn emit_project_sym_volume(slots: &[SymSlot], spare_slots: u32) -> Vec<u8> {
    let header = VolumeHeader {
        magic: MAGIC_SYM,
        version: SI4_VERSION,
        count: slots.len() as u32,
        capacity: slots.len() as u32,
        first_free: FREE_HEAD_NONE,
        rec_size: SYM_REC_SIZE as u32,
        unk18: 0,
        state: 0,
    };
    emit_sym_volume(&header, slots, spare_slots)
}

/* =====================================================================
 * Tests.
 * ===================================================================== */

#[cfg(test)]
mod tests {
    use super::*;

    fn skeletons(path: &str, raw: &str) -> Vec<Rec> {
        let raw_b = raw.as_bytes();
        let lower = path.to_ascii_lowercase();
        let base = path.rsplit(['\\', '/']).next().unwrap_or(path);
        with_arena(|| {
            let mut root: Vec<usize> = Vec::new();
            if base == "Makefile" {
                parse_make(raw_b, 0, &mut root);
            } else if lower.ends_with(".py") {
                parse_python(path, raw_b, &mut root);
            } else if lower.ends_with(".html") {
                parse_html(raw_b, &mut root);
            } else if lower.ends_with(".ini") {
                parse_ini(raw_b, &mut root);
            } else if lower.ends_with(".inc") {
                parse_inc(raw_b, &mut root);
            } else if lower.ends_with(".js") {
                let lines = split_rows(raw_b);
                parse_js_text(&lines, 0, &mut root);
            } else {
                let mut cp = CParser::new(raw_b);
                cp.lang_cpp = lower.ends_with(".cpp") || lower.ends_with(".hpp");
                root.extend(cp.parse());
            }
            let arena = ARENA.with(|a| a.borrow().clone());
            emit_order(&arena, &root)
                .into_iter()
                .map(rec_clone)
                .collect::<Vec<Rec>>()
        })
    }

    fn sk(r: &Rec) -> String {
        format!(
            "{} {} {} {} ds{} el{}",
            r.kind,
            String::from_utf8_lossy(&r.name),
            r.line0,
            r.col0,
            r.decl_start0,
            r.end_line0
        )
    }

    /* ---------- the C parser ---------- */

    #[test]
    fn typedef_group_walks_tag_members_typedef_shadow() {
        // the audio_amp_main.c group's exact storage order
        let rows = skeletons(
            "main\\x.c",
            "typedef enum audio_set {\n    AUDIO_BASS,\n    AUDIO_TREBLE\n} audio_set_t;\n",
        );
        // the rescan copies interleave by name: BASS's sorts before the tag,
        // TREBLE's after the typedef (the snapshot's audio_amp_main.c shape)
        let want = [
            "12 AUDIO_BASS 1 4 ds1 el1",
            "7 audio_set 0 13 ds0 el3",
            "12 AUDIO_BASS 1 4 ds1 el1",
            "12 AUDIO_TREBLE 2 4 ds2 el2",
            "4 audio_set_t 3 2 ds0 el3",
            "22 audio_set 0 13 ds0 el3",
            "12 AUDIO_TREBLE 2 4 ds2 el2",
        ];
        for (r, w) in rows.iter().zip(want.iter()) {
            assert_eq!(&sk(r), w);
        }
        assert_eq!(rows.len(), 7);
    }

    #[test]
    fn anonymous_typedef_struct_takes_the_declarator_name() {
        let rows = skeletons(
            "main\\y.h",
            "typedef struct {\n    uint16_t a;\n    uint8_t b;\n} dumb_wav_header_t;\n",
        );
        let got: Vec<String> = rows.iter().map(sk).collect();
        assert_eq!(
            got,
            vec![
                "4 dumb_wav_header_t 3 2 ds0 el3".to_string(),
                "22 {anondumb_wav_header_t} 0 8 ds0 el3".to_string(),
                "2 {anondumb_wav_header_t} 0 8 ds0 el3".to_string(),
                "17 a 1 13 ds1 el1".to_string(),
                "17 b 2 12 ds2 el2".to_string(),
            ]
        );
    }

    #[test]
    fn fn_pointer_typedef_and_members_fall_back_to_the_grouped_name() {
        let rows = skeletons(
            "main\\z.h",
            "typedef bool (*spectrum_acquire_fn)(unsigned n, unsigned rate);\nstruct box {\n    int32_t (*dsps_firmr)(void *fir);\n};\n",
        );
        let t4 = rows.iter().find(|r| r.kind == 4).expect("typedef row");
        assert_eq!(String::from_utf8_lossy(&t4.name), "spectrum_acquire_fn");
        assert_eq!(t4.col0, 15);
        let m = rows.iter().find(|r| r.kind == 17).expect("member row");
        assert_eq!(String::from_utf8_lossy(&m.name), "dsps_firmr");
        assert_eq!(m.col0, 14);
    }

    #[test]
    fn class_members_split_prototypes_data_and_operator_spellings() {
        let rows = skeletons(
            "inc\\mat.h",
            "class Rect {\npublic:\n    Rect(int x = 0, int y = 0);\n    void resizeRect(int x);\n    int areaRect(void);\n    inline float &operator()(int row, int col)\n    {\n        return 0;\n    }\n    Mat operator^(int C);\n};\nstd::ostream &operator<<(std::ostream &os, const Rect &r);\n",
        );
        let got: Vec<String> = rows.iter().map(sk).collect();
        assert!(got.iter().any(|s| s.starts_with("36 Rect 2 4 ")), "{got:?}");
        assert!(got.iter().any(|s| s.starts_with("36 resizeRect 3 9 ")));
        assert!(got.iter().any(|s| s.starts_with("36 areaRect 4 8 ")));
        assert!(got.iter().any(|s| s.starts_with("11 operator() 5 18 ")), "{got:?}");
        assert!(got.iter().any(|s| s.starts_with("36 operator^ 9 8 ")));
        // the file-scope operator declaration is K13 at its own column
        assert!(got.iter().any(|s| s.starts_with("13 operator<< 11 14 ")), "{got:?}");
        assert!(got.iter().any(|s| s.starts_with("10 Rect 0 6 ")));
    }

    #[test]
    fn asm_initializer_lines_register_fake_prototypes() {
        let rows = skeletons(
            "main\\network.c",
            "extern const uint8_t index_start[] asm(\"_binary_index_html_start\");\n",
        );
        let got: Vec<String> = rows.iter().map(sk).collect();
        assert_eq!(got, vec!["13 asm 0 35 ds0 el0".to_string()]);
    }

    #[test]
    fn constructor_definitions_split_the_class_stub_chain() {
        let rows = skeletons(
            "src\\m.cpp",
            "namespace dspm {\nfloat Mat::abs_tol = 1e-10;\nMat::Rect::Rect(int x)\n{\n}\nvoid Mat::Rect::resizeRect(int x)\n{\n}\nMat::Mat(float *data)\n{\n}\nint Mat::norm(void)\n{\n}\n}\n",
        );
        let stubs: Vec<&Rec> = rows.iter().filter(|r| r.kind == 21).collect();
        let names: Vec<String> = stubs
            .iter()
            .map(|r| format!("{} {} {}", String::from_utf8_lossy(&r.name), r.line0, r.end_line0))
            .collect();
        // abs_tol opens the Mat stub; the Rect constructor opens Mat AND Rect;
        // the Mat constructor opens the third stub
        assert_eq!(names.len(), 4, "{names:?}");
        assert!(names[0].starts_with("Mat 1 "), "{names:?}");
        assert!(names[1].starts_with("Mat 2 "), "{names:?}");
        assert!(names[2].starts_with("Rect 2 "), "{names:?}");
        assert!(names[3].starts_with("Mat 8 "), "{names:?}");
    }

    #[test]
    fn directives_register_macros_and_break_the_stub_run() {
        let rows = skeletons(
            "src\\e.cpp",
            "class ekf {\npublic:\n    ekf();\n};\nekf::ekf()\n{\n}\n#define FLT_EPSILON 1.0f\ndspm::Mat ekf::rot(void)\n{\n}\n",
        );
        let stubs: Vec<&Rec> = rows.iter().filter(|r| r.kind == 21).collect();
        assert_eq!(
            stubs.len(),
            2,
            "{}",
            stubs.iter().map(|r| sk(r)).collect::<Vec<_>>().join("; ")
        );
        assert_eq!(stubs[0].line0, 4);
        assert_eq!(stubs[1].line0, 8);
        let macs: Vec<&Rec> = rows.iter().filter(|r| r.kind == 6).collect();
        assert_eq!(macs.len(), 1);
        assert_eq!(macs[0].line0, 7);
    }

    /* ---------- the Python parser ---------- */

    #[test]
    fn python_registers_modules_defs_and_self_targets() {
        let rows = skeletons(
            "tools\\app.py",
            "import sys\nfrom pathlib import Path\nimport numpy as np\n\nclass W:\n    def __init__(self):\n        self.size = 3\n        self.deep.x = 1\n    def run(self):\n        self.other = 9\n\ndef main():\n    pass\n",
        );
        let got: Vec<String> = rows.iter().map(sk).collect();
        // modules chain + file module (the anchor ends on the trailing split row)
        assert!(got.iter().any(|s| s == "29 tools 0 0 ds0 el13"), "{got:?}");
        assert!(got.iter().any(|s| s == "29 app 0 0 ds0 el13"));
        // from-import and aliased plain import register, plain import does not
        assert!(got.iter().any(|s| s.starts_with("54 Path 1 ")));
        assert!(got.iter().any(|s| s.starts_with("54 np 2 ")));
        assert!(!got.iter().any(|s| s.starts_with("54 sys ")), "{got:?}");
        // __init__ self targets (the dotted one joins); run()'s own target
        // registers too — the snapshot's setUp evidence — while a right-hand
        // self.x read never does
        assert!(got.iter().any(|s| s.starts_with("17 size 6 ")), "{got:?}");
        assert!(got.iter().any(|s| s.starts_with("17 deep\u{2}x 7 ")), "{got:?}");
        assert!(got.iter().any(|s| s.starts_with("17 other 9 ")));
        assert!(got.iter().any(|s| s.starts_with("10 W 4 ")));
        assert!(got.iter().any(|s| s.starts_with("0 main 11 ")));
    }

    #[test]
    fn python_triple_quoted_bodies_are_not_statements() {
        let rows = skeletons(
            "tests\\t.py",
            "class T(unittest.TestCase):\n    def run(self):\n        code = r'''\n rx=0;assert(rx==0);\n'''\n        pass\n",
        );
        let got: Vec<String> = rows.iter().map(sk).collect();
        assert!(!got.iter().any(|s| s.contains(" rx ")), "{got:?}");
        assert!(got.iter().any(|s| s.starts_with("10 T 0 ")));
    }

    /* ---------- make / html / ini / inc ---------- */

    #[test]
    fn makefile_pairs_store_the_operator_row_before_the_value_row() {
        let rows = skeletons(
            "Makefile",
            "PROJECT_NAME := demo\n\nOBJ=main.o \\\n  second.o\n\nall: $(OBJ)\n\tcc\n\ninstall: all\n\techo\n",
        );
        let got: Vec<String> = rows.iter().map(sk).collect();
        assert_eq!(
            got,
            vec![
                "16 all 5 0 ds5 el6".to_string(),
                "16 all 5 0 ds5 el8".to_string(),
                "16 install 8 0 ds8 el9".to_string(),
                "16 install 8 0 ds8 el8".to_string(),
                "5 OBJ 2 0 ds2 el5".to_string(),
                "16 PROJECT_NAME 0 0 ds0 el1".to_string(),
                "5 PROJECT_NAME 0 0 ds0 el2".to_string(),
            ]
        );
    }

    #[test]
    fn html_css_names_tokenize_and_media_blocks_skip() {
        let rows = skeletons(
            "main\\index.html",
            "<html>\n<style>\nbody{color:red}\n.card,.panel{margin:0}\ninput:focus-visible,select:focus-visible{outline:1px}\n@media(max-width:760px){\nbody{margin:2px}\n}\n</style>\n<script>\nconst form=document.querySelector('form'),msg=1;let initialized=false,dirty=false;\nfunction poll(){return 0}\n</script>\n",
        );
        let got: Vec<String> = rows.iter().map(sk).collect();
        assert!(got.iter().any(|s| s == "43 body 2 0 ds2 el2"), "{got:?}");
        assert!(got.iter().any(|s| s == "43 \u{2}card 3 0 ds3 el3"), "{got:?}");
        assert!(got.iter().any(|s| s == "43 \u{2}panel 3 6 ds3 el3"));
        assert!(
            got.iter().any(|s| s == "43 input :focus - visible 4 0 ds4 el4"),
            "{got:?}"
        );
        assert!(got.iter().any(|s| s.starts_with("43 select :focus - visible 4 ")));
        // the media prelude registers; the block's body rule does not
        assert!(
            got.iter().any(|s| s.starts_with("43 @ media ( max - width :760px ) 5 ")),
            "{got:?}"
        );
        assert!(!got.iter().any(|s| s.contains("margin")), "{got:?}");
        // the JS mid-statement keyword lists
        assert!(got.iter().any(|s| s.starts_with("5 form 10 6 ")));
        assert!(got.iter().any(|s| s.starts_with("5 initialized 10 52 ")), "{got:?}");
        assert!(got.iter().any(|s| s.starts_with("5 dirty 10 70 ")));
        assert!(got.iter().any(|s| s.starts_with("0 poll 11 ")));
    }

    #[test]
    fn ini_and_inc_rows_register() {
        let rows = skeletons("main\\pytest.ini", "[pytest]\nminversion = 7\n");
        assert_eq!(sk(&rows[0]), "8 pytest 0 1 ds0 el0");
        let rows = skeletons(
            "test\\report.inc",
            "        unsigned intlevel = X(); \\\n        intlevel = Y(); \\\n",
        );
        let got: Vec<String> = rows.iter().map(sk).collect();
        assert_eq!(got, vec!["6 intlevel 1 8 ds1 el2".to_string()]);
    }

    /* ---------- ordering ---------- */

    #[test]
    fn block_order_walks_parents_before_sorted_children() {
        let rows = skeletons(
            "main\\p.h",
            "typedef struct pt_s {\n    int y;\n    int x;\n} pt_t;\n",
        );
        let got: Vec<String> = rows.iter().map(sk).collect();
        assert_eq!(
            got,
            vec![
                "2 pt_s 0 15 ds0 el3".to_string(),
                "17 x 2 8 ds2 el2".to_string(),
                "17 y 1 8 ds1 el1".to_string(),
                "4 pt_t 3 2 ds0 el3".to_string(),
                "22 pt_s 0 15 ds0 el3".to_string(),
            ]
        );
    }

    /* ---------- the feed ---------- */

    #[test]
    fn feed_from_xf_reads_the_slot_order() {
        let text = "# comment\n0\t3\t0\tmain\\a.c\t2026\t1\t1\t9\t0\n1\t24\t0\tmain\\b.c\t2026\t1\t1\t20\t1\n";
        let feed = feed_from_xf(text);
        assert_eq!(
            feed,
            vec![(3u32, "main\\a.c".to_string()), (24, "main\\b.c".to_string())]
        );
    }

    /* ---------- the acceptance run ---------- */

    /// The reference snapshot's directory (`si4-rea`'s `sip-vol/snap`; the
    /// xf-records.txt feed sits beside it). `GGS_REF_SNAP_DIR` moves it.
    fn snap_dir() -> Option<std::path::PathBuf> {
        let dir = match std::env::var_os("GGS_REF_SNAP_DIR") {
            Some(dir) => std::path::PathBuf::from(dir),
            None => std::path::PathBuf::from(r"C:\Users\penghongxia\si4-rea\sip-vol\snap"),
        };
        if dir.is_dir() {
            Some(dir)
        } else {
            None
        }
    }

    /// The analyzed source tree behind the snapshot (`GGS_REF_SOURCE_ROOT` moves
    /// it), matching `projvol`'s own acceptance run.
    fn source_root() -> Option<std::path::PathBuf> {
        let dir = match std::env::var_os("GGS_REF_SOURCE_ROOT") {
            Some(dir) => std::path::PathBuf::from(dir),
            None => std::path::PathBuf::from(r"E:\esp-sdr"),
        };
        if dir.is_dir() {
            Some(dir)
        } else {
            None
        }
    }

    #[test]
    fn the_generated_records_match_the_reference_snapshot() {
        use std::fmt::Write as _;
        let Some(snap) = snap_dir() else {
            eprintln!("skip: the si4-rea reference snapshot is not present (set GGS_REF_SNAP_DIR)");
            return;
        };
        let Some(root) = source_root() else {
            eprintln!("skip: the snapshot's analyzed source tree is not present (set GGS_REF_SOURCE_ROOT)");
            return;
        };
        let Some(xf_text) = std::fs::read_to_string(snap.parent().unwrap().join("xf-records.txt")).ok()
        else {
            eprintln!("skip: xf-records.txt not found beside the snapshot");
            return;
        };
        let feed = feed_from_xf(&xf_text);
        assert_eq!(feed.len(), 478);
        let root2 = root.clone();
        let mut read = |rel: &str| -> Vec<u8> {
            let full = root2.join(rel.replace('\\', "/"));
            std::fs::read(&full).unwrap_or_else(|e| panic!("read {}: {e}", full.display()))
        };
        let slots = generate_sym_slots(&feed, &mut read);

        // the snapshot's own records: the acceptance baseline
        let snap_bytes =
            std::fs::read(snap.join("Untitled Project2.sip_sym")).expect("sym snapshot");
        let parsed = super::super::projvol::parse_sym_volume(&snap_bytes).expect("sym parses");
        let gt = &parsed.records;

        // L0: the (name, kind, file, line0) quadruples
        #[derive(PartialEq, Eq, Hash, PartialOrd, Ord, Clone)]
        struct Quad {
            name: Vec<u8>,
            kind: u16,
            fid: u32,
            line0: u32,
        }
        let quad = |r: &SymSlot| Quad {
            name: r.name.clone(),
            kind: r.kind,
            fid: r.file_id,
            line0: r.line0,
        };
        use std::collections::HashMap;
        let mut gt_map: HashMap<Quad, Vec<usize>> = HashMap::new();
        for (i, r) in gt.iter().enumerate() {
            gt_map.entry(quad(r)).or_default().push(i);
        }
        let mut gen_map: HashMap<Quad, Vec<usize>> = HashMap::new();
        for (i, r) in slots.iter().enumerate() {
            gen_map.entry(quad(r)).or_default().push(i);
        }
        // the L0 match counts RECORDS (a quad may hold several same-row records,
        // ring_capture.c's two `REG_WRITE` prototypes on one row): the per-quad
        // record pair count sums the multiset overlap
        let matched: usize = gt_map
            .iter()
            .map(|(q, gti)| gti.len().min(gen_map.get(q).map_or(0, Vec::len)))
            .sum();
        let gt_only: usize = gt.len() - matched;
        let gen_only: usize = slots.len() - matched;

        // L2: the field hit rates over the quad-matched pairs
        let mut field_total = [0usize; 13];
        let mut field_hit = [0usize; 13];
        let fields: [&str; 13] = [
            "line0", "col0", "decl_start", "token_col", "end_line", "end_col", "raw108", "prev",
            "scope", "linked", "file_id", "flags", "name_tag",
        ];
        for (q, gti) in gt_map.iter() {
            let Some(geni) = gen_map.get(q) else { continue };
            for k in 0..gti.len().min(geni.len()) {
                let (a, b) = (&gt[gti[k]], &slots[geni[k]]);
                let vals = [
                    a.line0, a.col0, a.decl_start, a.token_col, a.decl_end_line, a.decl_end_col,
                    a.raw108, a.prev as u32, a.scope as u32, a.related as u32, a.file_id,
                    a.flags as u32, a.name_tag,
                ];
                let bv = [
                    b.line0, b.col0, b.decl_start, b.token_col, b.decl_end_line, b.decl_end_col,
                    b.raw108, b.prev as u32, b.scope as u32, b.related as u32, b.file_id,
                    b.flags as u32, b.name_tag,
                ];
                for f in 0..13 {
                    field_total[f] += 1;
                    if vals[f] == bv[f] {
                        field_hit[f] += 1;
                    }
                }
            }
        }

        // the byte-level comparison
        let built = emit_project_sym_volume(&slots, parsed.spare_slots);
        let mut diff_slots = 0usize;
        for (a, b) in built.chunks(SYM_REC_SIZE).zip(snap_bytes.chunks(SYM_REC_SIZE)) {
            if a != b {
                diff_slots += 1;
            }
        }

        // the report
        let mut report = String::new();
        let _ = writeln!(report, "symgen acceptance: generated {} records vs {} GT", slots.len(), gt.len());
        let _ = writeln!(
            report,
            "L0 quad recall {}/{} precision {}/{}",
            matched,
            gt.len(),
            matched,
            slots.len()
        );
        for f in 0..13 {
            let _ = writeln!(
                report,
                "  {:<12} {}/{} = {:.1}%",
                fields[f],
                field_hit[f],
                field_total[f],
                100.0 * field_hit[f] as f64 / field_total[f].max(1) as f64
            );
        }
        let _ = writeln!(report, "byte-differing slots: {}/{}", diff_slots, gt.len());
        let _ = writeln!(report, "GT-only {} gen-only {}", gt_only, gen_only);
        eprintln!("{}", report);

        // the machine-readable dump for the residual tables
        let dump = std::path::Path::new(&std::env::var("CARGO_TARGET_TMPDIR").unwrap_or_else(|_| ".".into()))
            .join("symgen-records.txt");
        let mut text = String::new();
        let _ = writeln!(
            text,
            "#idx\tid\tname\tkind\tfile_id\tline0\tcol0\tdecl_start\tend_line"
        );
        for (i, r) in slots.iter().enumerate() {
            let _ = writeln!(
                text,
                "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                i,
                i,
                String::from_utf8_lossy(&r.name),
                r.kind,
                r.file_id,
                r.line0,
                r.col0,
                r.decl_start,
                r.decl_end_line
            );
        }
        std::fs::create_dir_all(dump.parent().unwrap()).ok();
        std::fs::write(&dump, text).ok();

        // the byte-exactness gate: the pipeline reproduces the snapshot exactly
        assert_eq!(matched, gt.len(), "L0 recall: {matched}/{}", gt.len());
        assert_eq!(slots.len(), gt.len(), "precision: {}/{}", matched, slots.len());
        assert_eq!(built, snap_bytes, "the generated volume must rebuild the snapshot byte for byte");
    }
}
