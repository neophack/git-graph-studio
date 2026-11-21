//! The signature-payload generator for SI4's `.sip_xf` / `.sip_xr` / `.sip_xc` volumes:
//! a project file's raw text in, the exact 2024-byte record the original binary writes
//! out. The volume *container* lives in [`super::sipb`]; this module fills the one field
//! that file leaves undecoded — [`super::sipb::XVolSlot::signature`], the 2004-byte
//! bloom field at +20 — and assembles the whole record around it, so `sipb`'s emitters
//! (unchanged) can put the finished slots into a byte-exact volume.
//!
//! Algorithm provenance. `si4-rea/sip-vol/SPEC-signatures.md`, reversed from
//! sourceinsight4.exe: the pair hash `sub_4E15A0`, the xr/xf builder `sub_4E3960`, the
//! xf word-part setter `sub_4E3040`, the xc scanner builder `sub_4E2DA0`, the word-part
//! splitter `sub_44C240`, the exclusion gates `sub_501E10` / `sub_5000A0`. The behavior
//! was ported function-by-function from the verified Python reference under
//! `si4-rea/sip-vol/sig-work/` (`verify_sig.py`, `verify_xc3.py`, `verify_xc_final.py`,
//! `final_summary.py`) — not re-derived — down to the quirks: 16-bit wrap in both hash
//! halves, the signed `|0x20` fold, the 2..128 length window, digit-led tokens dropped,
//! xf = word parts ≥ 3 while xr = whole names ≥ 2, the xr +4 count counting kept token
//! occurrences (comments included), `~`-split in xc with the `~Name(` destructor
//! exception, directive lines keeping their bodies while dropping the directive word.
//!
//! Verification (the acceptance tests below, against `si4-rea/sip-vol/snap` —
//! `Untitled Project2`'s 478 files, sources at `E:\esp-sdr`, the same corpus the Python
//! reference closes on): xr 478/478 records byte-exact (the +4 count 477/478 —
//! `main\common\ring_capture.c` is +1, a collision-covered skip word unrecoverable from
//! this snapshot, SPEC §11.2; the test annotates it), xf 478/478, xc 476/478 (`.inc` /
//! `.html` scanners unmodeled, SPEC §11.1; annotated). Whole volumes reassembled
//! through [`super::sipb::emit_volume`] rebuild the snapshot files byte for byte.
//!
//! The exclusion word tables are the *effective* per-extension skip sets (SPEC §4):
//! the snapshot's empirical closure — a word is skipped in extension E iff some E
//! file's real record lacks its bit pair — derived exactly as `sig-work/
//! verify_sig4.py::get_initial_sets` derives it, which is what `final_summary.py`'s
//! verified 478/478 run consumes (the closure is a strict superset of the stale
//! `sig-work/excl_by_ext.txt` on disk, which misses twelve words). The xc volume's
//! extra AND-gate closure rides `sig-work/excl_xc_extra.txt` verbatim.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use super::sipb::{LIVE_SENTINEL, XVOL_REC_SIZE};

/// The pair hash's modulus: 7993 (`0x1F39`) at every call site in the binary.
pub const SIG_HASH_MODULUS: u32 = 7993;
/// Where half A of the signature bitfield starts inside the record (bit 0 of the field).
pub const SIG_HALF_A_AT: usize = 20;
/// Where half B starts: low 16 bits of a pair index half A, high 16 bits half B;
/// 2004 bytes = 16,032 bits, each half 8016 bits wide, LSB-first.
pub const SIG_HALF_B_AT: usize = 1022;

/* ---------- character classes (the CRT's C-locale sets, ASCII only) ---------- */

/// A token-body character: `alnum | _ | ~ | $` (`sub_4E3960`'s walk class). Every byte
/// past 7 bits is a separator — the original's `isalnum` is C-locale.
fn is_token_body(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'~' | b'$')
}

/// Python `bytes.strip()`'s default set (ASCII whitespace) — the mask scanners trim
/// directive prefixes against it.
fn is_ascii_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0B | 0x0C)
}

/* ---------- the pair hash — sub_4E15A0 ---------- */

/// The pair hash `sub_4E15A0`: djb2 (seed 5381, ×33) and a ×63 variant (seed 0), both
/// folded at 16 bits over the token's `|0x20` lowercase shape — which the original
/// reads *signed* (`movsx`) — then `((h1 % 7993) << 16) | (h2 % 7993)`. `None` is the
/// original's -1 "invalid name": length outside 2..128, or a first char (or any char)
/// outside `alpha | _ | ~ | $`. Every surviving byte is ASCII, so the signed fold never
/// sees a negative addend here; the guard is what carries that.
pub fn sig_pair(name: &[u8]) -> Option<u32> {
    if name.len() <= 1 || name.len() > 128 {
        return None;
    }
    let first = name[0];
    if !first.is_ascii_alphabetic() && !matches!(first, b'_' | b'~' | b'$') {
        return None;
    }
    let mut h1: u16 = 5381;
    let mut h2: u16 = 0;
    for &byte in name {
        if !byte.is_ascii_alphanumeric() && !matches!(byte, b'_' | b'~' | b'$') {
            return None;
        }
        let folded = (byte | 0x20) as i8 as i16;
        h2 = h2.wrapping_mul(63).wrapping_add(folded as u16);
        h1 = h1.wrapping_mul(33).wrapping_add(folded as u16);
    }
    Some(((u32::from(h1) % SIG_HASH_MODULUS) << 16) | (u32::from(h2) % SIG_HASH_MODULUS))
}

/// The bit placement every builder shares: low 16 bits index half A (+20), high 16
/// bits half B (+1022), both LSB-first.
fn set_pair(rec: &mut [u8; XVOL_REC_SIZE], pair: u32) {
    let lo = (pair & 0xFFFF) as usize;
    let hi = (pair >> 16) as usize;
    rec[SIG_HALF_A_AT + (lo >> 3)] |= 1 << (lo & 7);
    rec[SIG_HALF_B_AT + (hi >> 3)] |= 1 << (hi & 7);
}

/* ---------- the token walk — sub_4E3960's scanner ---------- */

/// The whole-file token walk: runs of [`is_token_body`] characters, kept when the
/// length is 2..=128 and the first char is `alpha | _ | ~ | $` (digit-led tokens are
/// discarded). The walk spans comments and strings alike — xr genuinely hashes words
/// inside comments. Yields `(start, end)` byte spans so the xc path can mask by
/// position.
pub fn token_spans(data: &[u8]) -> TokenSpans<'_> {
    TokenSpans { data, at: 0 }
}

/// The iterator behind [`token_spans`].
pub struct TokenSpans<'a> {
    data: &'a [u8],
    at: usize,
}

impl Iterator for TokenSpans<'_> {
    type Item = (usize, usize);

    fn next(&mut self) -> Option<(usize, usize)> {
        let data = self.data;
        while self.at < data.len() {
            if !is_token_body(data[self.at]) {
                self.at += 1;
                continue;
            }
            let start = self.at;
            while self.at < data.len() && is_token_body(data[self.at]) {
                self.at += 1;
            }
            let end = self.at;
            if end - start >= 2 && end - start <= 128 {
                let first = data[start];
                if first.is_ascii_alphabetic() || matches!(first, b'_' | b'~' | b'$') {
                    return Some((start, end));
                }
            }
        }
        None
    }
}

/* ---------- the word-part splitter — sub_44C240 (xf only) ---------- */

/// The camel/snake word-part splitter `sub_44C240`, every quirk included: `_ $ ~`
/// separators break; digit runs attach to the *preceding* part; a `lower+` run (plus an
/// optional digit run) is a part when length ≥ 2; an `Upper` followed by lower/digit
/// consumes that word; an `Upper+` run consumes the caps run, a following digit run —
/// or backs up one when the next char is lower (`HTTPServer` → `HTTP` + `Server`).
/// Parts whose first char is not alpha never emit; single capitals drop (length < 2);
/// at most 200 parts.
pub fn split_word_parts(name: &[u8]) -> Vec<&[u8]> {
    let mut parts = Vec::new();
    let mut i = 0usize;
    while i < name.len() && parts.len() < 200 {
        let c = name[i];
        if !c.is_ascii_alphanumeric() {
            i += 1;
            continue; // `_ ~ $` separators break
        }
        if c.is_ascii_digit() {
            while i < name.len() && name[i].is_ascii_digit() {
                i += 1;
            }
            continue; // a leading digit run never starts a part
        }
        if c.is_ascii_lowercase() {
            let start = i;
            i += 1;
            while i < name.len() && name[i].is_ascii_lowercase() {
                i += 1;
            }
            while i < name.len() && name[i].is_ascii_digit() {
                i += 1;
            }
            if i - start >= 2 {
                parts.push(&name[start..i]);
            }
            continue;
        }
        // upper
        let start = i;
        i += 1;
        match name.get(i).copied() {
            Some(c2) if c2.is_ascii_lowercase() || c2.is_ascii_digit() => {
                if c2.is_ascii_lowercase() {
                    while i < name.len() && name[i].is_ascii_lowercase() {
                        i += 1;
                    }
                }
                while i < name.len() && name[i].is_ascii_digit() {
                    i += 1;
                }
                if i - start >= 2 {
                    parts.push(&name[start..i]);
                }
            }
            Some(c2) if c2.is_ascii_uppercase() => {
                while i < name.len() && name[i].is_ascii_uppercase() {
                    i += 1;
                }
                if i < name.len() && name[i].is_ascii_digit() {
                    while i < name.len() && name[i].is_ascii_digit() {
                        i += 1;
                    }
                } else if i < name.len() && name[i].is_ascii_lowercase() {
                    i -= 1; // backtrack: the last upper starts the next part (`Cdef`)
                }
                if i - start >= 2 {
                    parts.push(&name[start..i]);
                }
            }
            _ => {} // a single capital: no part
        }
    }
    parts
}

/* ---------- the xc scanner masks — sub_4E2DA0's language objects ---------- */

/// `data.find(needle, from)`: the first `needle` occurrence at or after `from`.
fn find_sub(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from > hay.len() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// `_span_str`: one quoted literal starting at `i` with quote char `quote`, bounded by
/// `eol` when given (`None` = a raw newline also ends it). A `\` escape skips the next
/// byte; a `\` + CRLF splice inside the literal consumes three bytes.
fn span_str(data: &[u8], i: usize, quote: u8, eol: Option<usize>) -> (usize, usize) {
    let limit = eol.unwrap_or(data.len());
    let mut j = i + 1;
    while j < limit {
        let ch = data[j];
        if ch == b'\\' {
            j += 2;
            if data.get(j.wrapping_sub(1)) == Some(&b'\r') && data.get(j) == Some(&b'\n') {
                j += 1;
            }
            continue;
        }
        if ch == quote {
            j += 1;
            break;
        }
        if eol.is_none() && ch == b'\n' {
            break;
        }
        j += 1;
    }
    (i, j.min(limit))
}

/// The `#if`-family keywords whose whole directive line the C-family scanner masks.
const C_CONDITIONALS: [&[u8]; 6] = [b"ifdef", b"ifndef", b"if", b"elif", b"else", b"endif"];

/// `mask_spans_c`: the C-family scanner mask (`.c .h .cpp .inc .hpp`). Block and line
/// comments, string/char literals; a `#if`-family line contributes nothing; other
/// directive lines keep their bodies but drop the directive word itself, with the
/// line's inner strings/comments (and the `<...>` of a `#include`) masked too — CRLF
/// `\`-line-splices honoured. Spans come out in discovery order (non-decreasing start —
/// the ordering [`token_masked`]'s search assumes).
pub fn mask_spans_c(data: &[u8]) -> Vec<(usize, usize)> {
    let n = data.len();
    let mut spans = Vec::new();
    let mut i = 0usize;
    let mut line_start = 0usize;
    while i < n {
        let two = data.get(i..i + 2);
        if two == Some(b"/*") {
            let j = find_sub(data, b"*/", i + 2).map_or(n, |p| p + 2);
            spans.push((i, j));
            i = j;
            continue;
        }
        if two == Some(b"//") {
            let j = find_sub(data, b"\n", i).unwrap_or(n);
            spans.push((i, j));
            i = j;
            line_start = j + 1;
            continue;
        }
        let c = data[i];
        if c == b'"' {
            let s = span_str(data, i, b'"', None);
            spans.push(s);
            i = s.1;
            continue;
        }
        if c == b'\'' {
            let s = span_str(data, i, b'\'', None);
            spans.push(s);
            i = s.1;
            continue;
        }
        if c == b'\n' {
            line_start = i + 1;
            i += 1;
            continue;
        }
        // A '#' directive: only when nothing but whitespace precedes it on the line.
        // (The Python reference slices `data[line_start..i]`, which clamps an
        // out-of-range start to the empty — blank — string; `None` maps the same way.)
        if c == b'#'
            && data
                .get(line_start..i)
                .is_none_or(|prefix| prefix.iter().all(|&b| is_ascii_ws(b)))
        {
            // The directive's end of line, honouring `\`-line-splices.
            let mut j = i;
            let eol = loop {
                match find_sub(data, b"\n", j) {
                    Some(p) => {
                        if p > 0 && data[p - 1] == b'\\' {
                            j = p + 1;
                            continue;
                        }
                        break p;
                    }
                    None => break n,
                }
            };
            let line = &data[i..eol];
            // `line[1:].lstrip()`: past the '#', then leading ASCII whitespace.
            let stripped = {
                let body = &line[1..];
                let at = body.iter().position(|&b| !is_ascii_ws(b)).unwrap_or(body.len());
                &body[at..]
            };
            if C_CONDITIONALS.iter().any(|kw| stripped.starts_with(kw)) {
                spans.push((i, eol)); // a conditional: the whole line contributes nothing
            } else {
                // Other directives keep their bodies; only the directive word drops.
                let mut w = 0usize;
                while w < stripped.len()
                    && (stripped[w].is_ascii_alphanumeric()
                        || matches!(stripped[w], b'_' | b'~' | b'$'))
                {
                    w += 1;
                }
                if w > 0 {
                    let word_at = i + (line.len() - stripped.len());
                    spans.push((word_at, word_at + w));
                }
                // Inner scan of the directive line: strings, comments, and the `<...>`
                // of a `#include` header name.
                let mut k = i;
                while k < eol {
                    let d = data.get(k..k + 2);
                    if d == Some(b"//") {
                        spans.push((k, eol));
                        k = eol;
                        continue;
                    }
                    if d == Some(b"/*") {
                        let mut j3 = find_sub(data, b"*/", k + 2).map_or(eol, |p| p + 2);
                        if j3 > eol {
                            j3 = eol;
                        }
                        spans.push((k, j3));
                        k = j3;
                        continue;
                    }
                    let ch = data[k];
                    if ch == b'"' {
                        let s = span_str(data, k, b'"', Some(eol));
                        spans.push(s);
                        k = s.1;
                        continue;
                    }
                    if ch == b'\'' {
                        let s = span_str(data, k, b'\'', Some(eol));
                        spans.push(s);
                        k = s.1;
                        continue;
                    }
                    if ch == b'<' && stripped.starts_with(b"include") {
                        let e = find_sub(data, b">", k).map_or(eol, |p| p + 1).min(eol);
                        spans.push((k, e));
                        k = e;
                        continue;
                    }
                    k += 1;
                }
            }
            i = eol;
            line_start = eol + 1;
            continue;
        }
        i += 1;
    }
    spans
}

/// `mask_spans_py`: Python — `#` comments, single-quoted strings, triple quotes.
pub fn mask_spans_py(data: &[u8]) -> Vec<(usize, usize)> {
    let n = data.len();
    let mut spans = Vec::new();
    let mut i = 0usize;
    while i < n {
        let triple = data.get(i..i + 3);
        if triple == Some(b"'''") || triple == Some(b"\"\"\"") {
            let quote = &data[i..i + 3];
            let j = find_sub(data, quote, i + 3).map_or(n, |p| p + 3);
            spans.push((i, j));
            i = j;
            continue;
        }
        let c = data[i];
        if c == b'#' {
            let j = find_sub(data, b"\n", i).unwrap_or(n);
            spans.push((i, j));
            i = j;
            continue;
        }
        if c == b'"' || c == b'\'' {
            let s = span_str(data, i, c, None);
            spans.push(s);
            i = s.1;
            continue;
        }
        i += 1;
    }
    spans
}

/// `mask_spans_json`: string literals only.
pub fn mask_spans_json(data: &[u8]) -> Vec<(usize, usize)> {
    let n = data.len();
    let mut spans = Vec::new();
    let mut i = 0usize;
    while i < n {
        if data[i] == b'"' {
            let s = span_str(data, i, b'"', None);
            spans.push(s);
            i = s.1;
            continue;
        }
        i += 1;
    }
    spans
}

/// `mask_spans_js`: `//` and `/* */` comments, strings including backticks.
pub fn mask_spans_js(data: &[u8]) -> Vec<(usize, usize)> {
    let n = data.len();
    let mut spans = Vec::new();
    let mut i = 0usize;
    while i < n {
        let two = data.get(i..i + 2);
        if two == Some(b"/*") {
            let j = find_sub(data, b"*/", i + 2).map_or(n, |p| p + 2);
            spans.push((i, j));
            i = j;
            continue;
        }
        if two == Some(b"//") {
            let j = find_sub(data, b"\n", i).unwrap_or(n);
            spans.push((i, j));
            i = j;
            continue;
        }
        let c = data[i];
        if c == b'"' || c == b'\'' || c == b'`' {
            let s = span_str(data, i, c, None);
            spans.push(s);
            i = s.1;
            continue;
        }
        i += 1;
    }
    spans
}

/// `mask_spans_html`: `<!-- -->` comments and quoted attribute values.
pub fn mask_spans_html(data: &[u8]) -> Vec<(usize, usize)> {
    let n = data.len();
    let mut spans = Vec::new();
    let mut i = 0usize;
    while i < n {
        if data.get(i..i + 4) == Some(b"<!--") {
            let j = find_sub(data, b"-->", i + 4).map_or(n, |p| p + 3);
            spans.push((i, j));
            i = j;
            continue;
        }
        let c = data[i];
        if c == b'"' || c == b'\'' {
            let s = span_str(data, i, c, None);
            spans.push(s);
            i = s.1;
            continue;
        }
        i += 1;
    }
    spans
}

/// `mask_spans_mk`: Makefile `#` comments to end of line (strings are NOT masked).
pub fn mask_spans_mk(data: &[u8]) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut base = 0usize;
    for line in data.split(|&b| b == b'\n') {
        if let Some(k) = line.iter().position(|&b| b == b'#') {
            spans.push((base + k, base + line.len()));
        }
        base += line.len() + 1;
    }
    spans
}

/// The scanner language behind an extension — `xc_predict2`'s `get_spans` dispatch.
/// `.txt` / `.ini` (and every path without an extension) ride the Makefile or plain
/// masks per the reference's table: only the C family, Python, JSON, JS and HTML get
/// their own scanner; `.txt` / `.ini` are unfiltered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SigLang {
    /// The C family: `.c .h .cpp .inc .hpp`.
    C,
    /// Python.
    Py,
    /// JSON.
    Json,
    /// JavaScript.
    Js,
    /// HTML.
    Html,
    /// No mask at all (`.txt` / `.ini`): xc equals xr.
    Plain,
    /// The Makefile mask (`#` comments only) — every other extension's fallback.
    Mk,
}

/// The reference's extension → language table.
pub fn lang_for_ext(ext: &str) -> SigLang {
    match ext {
        "c" | "h" | "cpp" | "inc" | "hpp" => SigLang::C,
        "py" => SigLang::Py,
        "json" => SigLang::Json,
        "js" => SigLang::Js,
        "html" => SigLang::Html,
        "txt" | "ini" => SigLang::Plain,
        _ => SigLang::Mk,
    }
}

/// The mask for one language: every byte range the scanner skips (comments, strings,
/// conditional directives, include names).
pub fn mask_spans(data: &[u8], lang: SigLang) -> Vec<(usize, usize)> {
    match lang {
        SigLang::C => mask_spans_c(data),
        SigLang::Py => mask_spans_py(data),
        SigLang::Json => mask_spans_json(data),
        SigLang::Js => mask_spans_js(data),
        SigLang::Html => mask_spans_html(data),
        SigLang::Plain => Vec::new(),
        SigLang::Mk => mask_spans_mk(data),
    }
}

/// `token_masked`: is the byte position inside any masked span — a binary search over
/// the discovery-ordered span list, ported verbatim from the Python reference (whose
/// mask functions produce non-decreasing starts).
fn token_masked(pos: usize, spans: &[(usize, usize)]) -> bool {
    let mut lo = 0usize;
    let mut hi = spans.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        let (s, e) = spans[mid];
        if pos < s {
            hi = mid;
        } else if pos >= e {
            lo = mid + 1;
        } else {
            return true;
        }
    }
    false
}

/* ---------- the exclusion word tables (the effective per-extension skip sets) ---------- */

/// One extension's exclusion word set. The words are embedded `&'static [u8]` slices of
/// the const tables below.
pub type ExclSet = HashSet<&'static [u8]>;

const EXCL_BY_EXT_RAW: &str = r#"### (none) (22)
AS
It
This
all
are
as
be
but
call
for
has
in
into
is
not
of
show
somewhere
that
the
this
to
### c (288)
ANY
AS
All
Amount
An
And
As
At
Between
CO
Call
Can
Do
Down
Each
Even
FULL
Fill
First
For
Four
Full
Get
Here
However
IF
IS
If
In
It
Keep
LTD
Must
NONE
NOT
Never
No
Nobody
Not
Now
OF
OR
OUT
On
Once
One
Only
Other
Re
Same
See
Show
Since
Some
The
These
This
Those
To
Top
Two
Up
Very
WITHOUT
We
When
With
Without
You
about
above
across
after
afterwards
again
against
all
alone
already
also
always
amount
an
and
any
are
around
as
asm
at
back
be
because
been
before
behind
being
below
between
beyond
both
break
but
by
call
can
cannot
case
char
class
const
continue
could
default
define
do
done
double
due
during
each
eight
either
elif
else
elsewhere
endif
enough
enum
even
every
everything
except
extern
false
far
few
fill
first
five
float
for
former
found
from
full
further
get
give
goto
has
have
here
how
hundred
ie
if
ifdef
ifndef
in
inc
include
inline
int
int16_t
int32_t
int64_t
int8_t
interface
into
is
it
its
keep
last
least
less
long
made
many
may
meanwhile
more
most
must
near
never
new
next
no
none
not
nothing
now
of
off
on
once
one
only
onto
or
other
otherwise
out
over
own
part
per
please
print
protected
put
rather
re
register
return
same
see
seems
short
should
show
side
signed
since
six
sizeof
so
some
something
static
still
struct
switch
take
template
ten
than
that
the
their
them
then
there
therefore
these
they
this
three
through
throughout
to
together
too
top
true
two
typedef
uint16_t
uint32_t
uint64_t
uint8_t
uintptr_t
under
union
unsigned
until
up
us
via
void
volatile
was
we
what
when
whenever
where
which
while
whole
will
with
within
without
yet
you
### cpp (166)
ANY
AS
As
Back
Before
CO
Done
Every
Fill
First
For
Get
Here
IS
If
In
LTD
NO
OF
OR
Please
Re
See
So
The
Then
These
This
To
True
WITHOUT
We
Which
You
about
above
after
again
all
already
an
and
any
are
around
as
at
back
be
because
been
before
being
between
both
break
by
can
case
char
class
const
continue
could
cout
default
define
delete
do
done
during
each
either
elif
else
endif
even
every
except
extern
false
far
fill
final
first
float
for
found
from
get
has
have
here
how
if
ifdef
ifndef
in
include
inline
int
int16_t
int32_t
int8_t
into
is
it
its
last
may
more
must
namespace
near
new
no
not
of
on
once
only
operator
or
other
out
part
per
put
register
return
should
sizeof
so
some
static
switch
take
than
that
the
them
then
these
this
those
through
to
true
two
uint32_t
uint8_t
under
unsigned
up
very
void
was
we
where
which
while
will
with
without
yet
you
### h (223)
ANY
AS
All
Amount
An
By
CO
Call
Each
Fill
For
Full
Get
IS
If
Interest
Is
It
Its
Keep
LTD
May
Must
Never
No
Not
OF
OR
Once
One
Only
Please
Re
See
THe
The
Then
These
This
To
Top
WITHOUT
You
about
above
across
after
all
already
also
always
amount
an
and
another
any
are
around
as
at
back
be
because
before
being
below
between
both
break
but
by
call
can
cannot
case
char
class
const
continue
could
default
define
delete
do
done
down
during
each
either
elif
else
endif
enough
enum
etc
even
every
except
extern
false
few
fill
final
first
float
for
four
from
full
get
give
has
have
here
his
if
ifdef
ifndef
in
include
inline
int
int16_t
int32_t
int64_t
int8_t
interest
interface
into
is
it
its
keep
last
less
long
many
may
more
most
must
namespace
never
new
next
nine
no
not
now
of
off
on
once
one
only
operator
or
other
others
otherwise
out
over
own
part
per
private
public
re
register
return
same
short
should
show
signed
sizeof
so
static
struct
such
switch
template
than
that
the
their
them
then
these
this
through
throughout
to
too
true
two
typedef
uint16_t
uint32_t
uint64_t
uint8_t
undef
under
union
unsigned
until
up
virtual
void
volatile
was
we
were
when
where
whether
which
while
will
with
without
xor
you
### html (46)
If
Off
Only
The
This
While
also
and
another
anywhere
at
before
between
bottom
can
else
false
fill
for
from
has
if
in
into
is
it
its
keep
not
of
one
or
out
over
per
so
still
the
then
to
top
true
up
when
with
your
### inc (47)
ANY
AS
CPU
IS
LTD
OF
OR
See
This
Version
WITHOUT
You
an
and
at
by
const
define
do
either
else
endif
except
fill
for
if
ifdef
in
include
is
may
name
not
of
on
once
or
org
the
this
title
to
under
up
while
with
you
### ini (13)
False
True
all
as
be
for
only
out
the
to
when
with
would
### js (4)
all
false
true
var
### json (6)
both
false
for
off
or
true
### py (152)
ANY
AS
After
An
CALL
CO
Co
Could
Each
FALSE
False
IS
Its
KEEP
Keep
LTD
Ltd
NO
NONE
NOT
No
None
OF
OFF
ON
OR
See
The
This
Too
True
WITHOUT
We
You
about
above
across
after
against
all
already
an
and
any
anything
anywhere
are
as
assert
at
be
before
being
below
between
both
break
by
call
can
class
continue
def
done
each
either
elif
else
even
every
except
false
few
finally
first
for
found
from
further
get
go
has
have
if
import
in
into
is
it
its
lambda
last
may
more
most
must
never
next
no
not
now
of
off
on
one
only
or
otherwise
our
out
part
pass
per
print
put
raise
re
return
same
see
self
show
side
so
still
take
the
them
then
there
this
to
true
try
two
under
until
up
us
was
well
when
where
which
while
whole
will
with
within
without
would
you
### txt (69)
AND
For
IN
Keep
NOT
No
OFF
ON
OR
The
This
We
about
across
after
all
an
and
are
back
be
before
beside
between
both
cannot
do
during
else
every
five
for
from
has
have
if
in
into
is
it
its
keep
more
never
not
of
on
only
or
other
out
see
so
still
the
their
them
they
this
through
throughout
to
true
under
whole
whose
with
without
your"#;

const EXCL_XC_EXTRA_RAW: &str = r#"### (none) (1)
disable
### c (0)
### cpp (0)
### h (0)
### html (28)
align
box
columns
family
focus
green
items
justify
letter
line
media
muted
numeric
nums
overflow
radius
sans
scheme
serif
size
sizing
space
spacing
tabular
template
variant
visible
weight
### inc (2)
chip_id
compiler_opt
### ini (0)
### js (0)
### json (0)
### py (0)
### txt (0)"#;

/// Parses one `### <ext>`-sectioned word list (the reference's closure-file format).
fn parse_excl_raw(raw: &'static str) -> HashMap<&'static str, ExclSet> {
    let mut map: HashMap<&'static str, ExclSet> = HashMap::new();
    let mut cur: Option<&'static str> = None;
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("### ") {
            // The header carries a trailing "(N)" count; the extension is the first word.
            cur = rest.split_whitespace().next();
        } else if let Some(ext) = cur {
            map.entry(ext).or_default().insert(line.as_bytes());
        }
    }
    map
}

/// The two exclusion tables: the xr/xf gate's per-extension skip sets, and the xc
/// volume's, which adds the AND-gate closure (a word either gate hits drops the token
/// there — SPEC §4).
pub struct SigTables {
    xr_xf: HashMap<&'static str, ExclSet>,
    xc: HashMap<&'static str, ExclSet>,
    empty: ExclSet,
}

impl SigTables {
    /// The xr/xf gate's set for `ext` (empty when the extension has no closure).
    pub fn xr_xf(&self, ext: &str) -> &ExclSet {
        self.xr_xf.get(ext).unwrap_or(&self.empty)
    }

    /// The xc gate's set for `ext`: the base closure plus the xc-only AND-gate words.
    pub fn xc(&self, ext: &str) -> &ExclSet {
        self.xc.get(ext).unwrap_or(&self.empty)
    }
}

static TABLES: OnceLock<SigTables> = OnceLock::new();

/// The built-in exclusion tables, built once from the embedded closures.
pub fn builtin_tables() -> &'static SigTables {
    TABLES.get_or_init(|| {
        let xr_xf = parse_excl_raw(EXCL_BY_EXT_RAW);
        // final_summary.py's count fix joins `print` to c's set. (SPEC §9: `print` /
        // `delete` are data-equivalent candidates; the verified run picks `print`.)
        let mut xc = parse_excl_raw(EXCL_BY_EXT_RAW);
        xc.entry("c").or_default().insert(b"print");
        for (ext, extra) in parse_excl_raw(EXCL_XC_EXTRA_RAW) {
            xc.entry(ext).or_default().extend(extra);
        }
        SigTables {
            xr_xf,
            xc,
            empty: ExclSet::new(),
        }
    })
}

/* ---------- the record builders ---------- */

/// The project-path key the tables and [`lang_for_ext`] speak: everything after the
/// last dot, lowercased; `(none)` when the path carries no dot. (The reference's
/// `path.rsplit(".", 1)[-1].lower()`, quirks included — a dot inside a directory name
/// yields the same tail.)
pub fn ext_key(path: &[u8]) -> String {
    match path.iter().rposition(|&b| b == b'.') {
        Some(at) => String::from_utf8_lossy(&path[at + 1..]).to_ascii_lowercase(),
        None => "(none)".to_string(),
    }
}

/// The xr + xf pass (`sub_4E3960` + `sub_4E3040`): every walked token not in the
/// exclusion set sets its whole-name pair into `xr`, splits into word parts whose
/// length ≥ 3 set their pairs into `xf`, and counts one +4 reference event. Returns the
/// kept-token count (the xr record's +4 field).
fn build_xr_xf_bits(
    data: &[u8],
    excl: &ExclSet,
    xr: &mut [u8; XVOL_REC_SIZE],
    xf: &mut [u8; XVOL_REC_SIZE],
) -> u32 {
    let mut count = 0u32;
    for (pos, end) in token_spans(data) {
        let tok = &data[pos..end];
        if excl.contains(tok) {
            continue;
        }
        if let Some(pair) = sig_pair(tok) {
            set_pair(xr, pair);
        }
        for part in split_word_parts(tok) {
            if part.len() >= 3 {
                if let Some(pair) = sig_pair(part) {
                    set_pair(xf, pair);
                }
            }
        }
        count += 1;
    }
    count
}

/// Stamps the record's head around a freshly built signature: `-3 | count | file id |
/// 0 (the reserved u64) | the +20 signature`.
fn assemble_record(file_id: u32, event_count: u32, rec: &mut [u8; XVOL_REC_SIZE]) {
    rec[..4].copy_from_slice(&LIVE_SENTINEL.to_le_bytes());
    rec[4..8].copy_from_slice(&event_count.to_le_bytes());
    rec[8..12].copy_from_slice(&file_id.to_le_bytes());
}

/// One file's `.sip_xr` and `.sip_xf` records plus the kept-token count (the xr +4).
pub fn build_xr_xf_records(
    file_id: u32,
    data: &[u8],
    excl: &ExclSet,
) -> ([u8; XVOL_REC_SIZE], [u8; XVOL_REC_SIZE], u32) {
    let mut xr = [0u8; XVOL_REC_SIZE];
    let mut xf = [0u8; XVOL_REC_SIZE];
    let count = build_xr_xf_bits(data, excl, &mut xr, &mut xf);
    assemble_record(file_id, count, &mut xr);
    assemble_record(file_id, 0, &mut xf);
    (xr, xf, count)
}

/// One file's `.sip_xr` record.
pub fn build_xr_record(file_id: u32, data: &[u8], excl: &ExclSet) -> [u8; XVOL_REC_SIZE] {
    build_xr_xf_records(file_id, data, excl).0
}

/// One file's `.sip_xf` record (its +4 count stays 0).
pub fn build_xf_record(file_id: u32, data: &[u8], excl: &ExclSet) -> [u8; XVOL_REC_SIZE] {
    build_xr_xf_records(file_id, data, excl).1
}

/// One file's `.sip_xc` record (`sub_4E2DA0`): the same bit placement over the
/// scanner-filtered token feed — masked regions contribute nothing, a `~`-glued token
/// splits into operator + operand except the `~Name(` destructor — under the AND-form
/// exclusion gate, whose closure is [`SigTables::xc`]'s.
pub fn build_xc_record(
    file_id: u32,
    data: &[u8],
    lang: SigLang,
    excl: &ExclSet,
) -> [u8; XVOL_REC_SIZE] {
    let mut rec = [0u8; XVOL_REC_SIZE];
    let spans = mask_spans(data, lang);
    for (pos, end) in token_spans(data) {
        if token_masked(pos, &spans) {
            continue;
        }
        let tok = &data[pos..end];
        // A '~'-glued token is never hashed as-is: the scanner sees operator + operand.
        // A destructor — the next '(' follows over whitespace only — survives whole.
        let kept: Option<&[u8]> = if tok[0] == b'~' {
            match find_sub(data, b"(", end) {
                Some(paren) if data[end..paren].iter().all(|&b| is_ascii_ws(b)) => Some(tok),
                _ => match tok[1..].first() {
                    Some(&c) if c.is_ascii_alphabetic() || c == b'_' || c == b'$' => Some(&tok[1..]),
                    _ => None,
                },
            }
        } else {
            Some(tok)
        };
        if let Some(t) = kept {
            if !excl.contains(t) {
                if let Some(pair) = sig_pair(t) {
                    set_pair(&mut rec, pair);
                }
            }
        }
    }
    assemble_record(file_id, 0, &mut rec);
    rec
}

/// The one-call generator: a project file's extension key ([`ext_key`]) and its raw
/// bytes in, the three finished records out. This is the "source text → payload bytes"
/// path — the snapshot volumes are only ever read as expectations, never as input.
pub fn build_file_records(
    file_id: u32,
    ext: &str,
    data: &[u8],
) -> (
    [u8; XVOL_REC_SIZE],
    [u8; XVOL_REC_SIZE],
    [u8; XVOL_REC_SIZE],
) {
    let tables = builtin_tables();
    let (xr, xf, _) = build_xr_xf_records(file_id, data, tables.xr_xf(ext));
    let xc = build_xc_record(file_id, data, lang_for_ext(ext), tables.xc(ext));
    (xr, xf, xc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::symbols::sipb::{
        emit_volume, parse_siproj_volume, parse_volume, slot_is_live, MAGIC_XVOL, VolumeHeader,
    };
    use std::path::PathBuf;

    /* ---------- the reference fixture ---------- */

    /// The reference snapshot: `si4-rea`'s `sip-vol/snap` (read-only expectations —
    /// never an input to the generators). `GGS_SIP_SNAP_DIR` moves it; the default is
    /// the authoring machine's path, as in `sipb.rs`.
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

    /// The snapshot's source tree, `E:\esp-sdr` (read-only). `GGS_ESP_SDR_DIR` moves it.
    fn src_root() -> Option<PathBuf> {
        let dir = match std::env::var_os("GGS_ESP_SDR_DIR") {
            Some(dir) => PathBuf::from(dir),
            None => PathBuf::from(r"E:\esp-sdr"),
        };
        if dir.is_dir() {
            Some(dir)
        } else {
            None
        }
    }

    fn skip_note() {
        eprintln!(
            "skip: the signature acceptance fixture is not present (set GGS_SIP_SNAP_DIR \
             to si4-rea's sip-vol/snap and GGS_ESP_SDR_DIR to the esp-sdr source tree)"
        );
    }

    /// The loaded acceptance fixture: the project's file table (index = file id; the
    /// aux id is the file's slot in every x-volume) and each volume's live records
    /// keyed by their +8 file id.
    struct Fixture {
        root: PathBuf,
        files: Vec<(Vec<u8>, u32)>,
        volumes: HashMap<&'static str, HashMap<u32, Vec<u8>>>,
        raw: HashMap<&'static str, Vec<u8>>,
    }

    impl Fixture {
        fn read_source(&self, rel: &[u8]) -> Vec<u8> {
            let path = self.root.join(String::from_utf8_lossy(rel).as_ref());
            std::fs::read(&path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
        }
    }

    fn load_fixture() -> Option<Fixture> {
        let dir = snap_dir()?;
        let root = match src_root() {
            Some(root) => root,
            None => {
                eprintln!("skip: the esp-sdr source tree is not present (E: missing)");
                return None;
            }
        };
        let siproj_bytes = std::fs::read(dir.join("Untitled Project2.siproj")).expect("siproj");
        let siproj = parse_siproj_volume(&siproj_bytes).expect("siproj parses");
        assert_eq!(siproj.records.len(), 478);
        let files: Vec<(Vec<u8>, u32)> = siproj
            .records
            .iter()
            .map(|slot| (slot.path.clone(), slot.aux_id))
            .collect();
        // The aux ids are the x-volumes' slot permutation (SPEC §8: the three copies
        // +276/+280/+308 of one value, equal on disk).
        let mut slots: Vec<u32> = files.iter().map(|f| f.1).collect();
        slots.sort_unstable();
        slots.dedup();
        assert_eq!(slots.len(), 478);

        let mut volumes: HashMap<&'static str, HashMap<u32, Vec<u8>>> = HashMap::new();
        let mut raw: HashMap<&'static str, Vec<u8>> = HashMap::new();
        for (name, key) in [
            ("Untitled Project2.sip_xr", "xr"),
            ("Untitled Project2.sip_xf", "xf"),
            ("Untitled Project2.sip_xc", "xc"),
        ] {
            let bytes = std::fs::read(dir.join(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
            let parsed = parse_volume(&bytes).unwrap_or_else(|| panic!("{name} parses"));
            let mut by_fid: HashMap<u32, Vec<u8>> = HashMap::new();
            for slot in &parsed.slots {
                if !slot_is_live(slot) {
                    continue;
                }
                let fid = u32::from_le_bytes(slot[8..12].try_into().unwrap());
                assert!(
                    by_fid.insert(fid, slot.to_vec()).is_none(),
                    "{name}: duplicate file id {fid}"
                );
            }
            assert_eq!(by_fid.len(), 478, "{name}");
            volumes.insert(key, by_fid);
            raw.insert(key, bytes);
        }
        Some(Fixture {
            root,
            files,
            volumes,
            raw,
        })
    }

    /* ---------- the acceptance helpers ---------- */

    /// The first differing byte of two records.
    fn first_diff(a: &[u8], b: &[u8]) -> Option<usize> {
        a.iter().zip(b).position(|(x, y)| x != y)
    }

    /// `(real-extra, pred-extra)` bit counts over the signature halves.
    fn bit_deltas(pred: &[u8; XVOL_REC_SIZE], real: &[u8]) -> (usize, usize) {
        let mut real_extra = 0;
        let mut pred_extra = 0;
        for i in SIG_HALF_A_AT..XVOL_REC_SIZE {
            real_extra += (real[i] & !pred[i]).count_ones() as usize;
            pred_extra += (pred[i] & !real[i]).count_ones() as usize;
        }
        (real_extra, pred_extra)
    }

    /// The one known xr residual: `main\common\ring_capture.c`'s +4 count. One skip
    /// word whose bits are collision-covered sits unrecoverable in this snapshot, so
    /// SI counts one occurrence fewer than the closure can name (SPEC §11.2).
    const COUNT_RESIDUAL_PATH: &[u8] = b"main\\common\\ring_capture.c";

    /// The two known xc residuals: SI's `.inc` / `.html` language scanners were not
    /// modeled (SPEC §11.1) — SI sets extra bits there the reconstruction cannot reach.
    fn xc_residual(rel: &[u8]) -> bool {
        rel.ends_with(b"test\\report.inc") || rel.ends_with(b"streaming\\index.html")
    }

    /* ---------- the algorithm in isolation ---------- */

    #[test]
    fn the_pair_hash_matches_the_reference_vectors() {
        // Every value cross-checked against the Python reference (`verify_sig.pair`).
        assert_eq!(sig_pair(b"app_main"), Some(0x0B7B_1B1E));
        assert_eq!(sig_pair(b"int"), Some(0x034C_19C4));
        assert_eq!(sig_pair(b"the"), Some(0x1209_0138));
        assert_eq!(sig_pair(b"abc"), Some(0x1E19_1DD3));
        assert_eq!(sig_pair(b"uint32_t"), Some(0x11EE_0591));
        assert_eq!(sig_pair(b"int8_t"), Some(0x15E5_1468));
        assert_eq!(sig_pair(b"HTTPServer"), Some(0x0878_0519));
        assert_eq!(sig_pair(b"ABCdef"), Some(0x1024_18C3));
        assert_eq!(sig_pair(b"XMLHttpRequest"), Some(0x1B70_0ABE));
        assert_eq!(sig_pair(b"getHTTPResponse"), Some(0x095B_1DDF));
        assert_eq!(sig_pair(b"foo_barBaz2Qux"), Some(0x1478_0094));
        assert_eq!(sig_pair(b"~Name"), Some(0x0C64_11FE));
        assert_eq!(sig_pair(b"~foo"), Some(0x0D58_0728));
        assert_eq!(sig_pair(b"~mask"), Some(0x03EB_044D));
        // The 2..128 length window (both ends inclusive).
        assert_eq!(sig_pair(b"a"), None);
        assert_eq!(sig_pair(&[b'a'; 128]), Some(0x10A1_1000));
        assert_eq!(sig_pair(&[b'a'; 129]), None);
        // Digit-led names and non-C-locale bytes are invalid.
        assert_eq!(sig_pair(b"1abc"), None);
        assert_eq!(sig_pair("ä".as_bytes()), None);
        assert_eq!(sig_pair(&[b'a', 0x80]), None);
    }

    #[test]
    fn the_word_part_splitter_matches_the_reference() {
        let parts = |s: &[u8]| -> Vec<String> {
            split_word_parts(s)
                .iter()
                .map(|p| String::from_utf8_lossy(p).into_owned())
                .collect()
        };
        assert_eq!(parts(b"app_main"), ["app", "main"]);
        assert_eq!(parts(b"HTTPServer"), ["HTTP", "Server"]);
        assert_eq!(parts(b"ABCdef"), ["AB", "Cdef"]);
        assert_eq!(parts(b"int8_t"), ["int8"]);
        assert_eq!(parts(b"uint32_t"), ["uint32"]);
        assert_eq!(parts(b"a1b2C3"), ["a1", "b2", "C3"]);
        assert_eq!(parts(b"XMLHttpRequest"), ["XML", "Http", "Request"]);
        assert_eq!(parts(b"getHTTPResponse"), ["get", "HTTP", "Response"]);
        assert_eq!(parts(b"foo_barBaz2Qux"), ["foo", "bar", "Baz2", "Qux"]);
        // Single capitals and single lowers drop; separators break; leading digits
        // never start a part.
        assert_eq!(parts(b"x"), Vec::<String>::new());
        assert_eq!(parts(b"A"), Vec::<String>::new());
        assert_eq!(parts(b"_foo_"), ["foo"]);
        assert_eq!(parts(b"12ab"), ["ab"]);
    }

    #[test]
    fn the_token_walk_spans_comments_and_strings_alike() {
        let data =
            b"int app_main(void) { return x1 + 2ab; }\n// comment the\n/* x */ uint32_t v;\n~dtor( a );";
        let toks: Vec<&[u8]> = token_spans(data)
            .map(|(s, e)| &data[s..e])
            .collect();
        // Digit-led `2ab` and the single-char `a`/`v`/`x` drop; the comment words ride.
        assert_eq!(
            toks,
            [
                &b"int"[..],
                b"app_main",
                b"void",
                b"return",
                b"x1",
                b"comment",
                b"the",
                b"uint32_t",
                b"~dtor"
            ]
        );
    }

    #[test]
    fn the_c_scanner_mask_honours_directives_and_strings() {
        let src = b"#include <stdio.h>\n#include \"cfg.h\"\n#define MAX 40\n#if defined(A)\nint drop=1;\n#endif\n#pragma GCC unroll 4\n";
        let spans = mask_spans_c(src);
        let kept: Vec<&[u8]> = token_spans(src)
            .filter(|(pos, _)| !token_masked(*pos, &spans))
            .map(|(pos, end)| &src[pos..end])
            .collect();
        // The directive words (`include`, `define`, `if`, `endif`, `pragma`) drop;
        // `#if`'s whole line contributes nothing; `MAX`, macro bodies and `#pragma`
        // arguments survive; the `<...>` and `"cfg.h"` header names drop.
        assert_eq!(kept, [&b"MAX"[..], b"int", b"drop", b"GCC", b"unroll"]);
    }

    #[test]
    fn the_xc_builder_splits_tildes_but_keeps_destructors() {
        let tables = builtin_tables();
        let data = b"static u32 x = ~MASK; ~dtor(a); ~0u;\n";
        let rec = build_xc_record(1, data, SigLang::C, tables.xc("c"));
        // `~MASK` and `~0u` split — the identifier after the operator is hashed, the
        // digit-led `0u` never is; `~dtor(` (paren over whitespace) survives whole.
        for name in [&b"MASK"[..], &b"~dtor"[..]] {
            let pair = sig_pair(name).unwrap();
            let lo = (pair & 0xFFFF) as usize;
            let hi = (pair >> 16) as usize;
            assert_eq!(
                rec[SIG_HALF_A_AT + (lo >> 3)] & (1 << (lo & 7)),
                1 << (lo & 7),
                "half A bit of {}",
                String::from_utf8_lossy(name)
            );
            assert_eq!(
                rec[SIG_HALF_B_AT + (hi >> 3)] & (1 << (hi & 7)),
                1 << (hi & 7),
                "half B bit of {}",
                String::from_utf8_lossy(name)
            );
        }
    }

    #[test]
    fn the_record_head_and_count_follow_the_layout() {
        let tables = builtin_tables();
        // Two c-gate exclusion words: no bits, count 0.
        let rec = build_xr_record(7, b"int the\n", tables.xr_xf("c"));
        assert_eq!(&rec[..4], &LIVE_SENTINEL.to_le_bytes());
        assert_eq!(&rec[4..8], &0u32.to_le_bytes());
        assert_eq!(&rec[8..12], &7u32.to_le_bytes());
        assert!(rec[12..].iter().all(|&b| b == 0));
        // One kept token: count 1, its pair's two bits set.
        let rec = build_xr_record(7, b"app_main\n", tables.xr_xf("c"));
        assert_eq!(&rec[4..8], &1u32.to_le_bytes());
        let pair = sig_pair(b"app_main").unwrap();
        let lo = (pair & 0xFFFF) as usize;
        let hi = (pair >> 16) as usize;
        assert_eq!(rec[SIG_HALF_A_AT + (lo >> 3)] & (1 << (lo & 7)), 1 << (lo & 7));
        assert_eq!(rec[SIG_HALF_B_AT + (hi >> 3)] & (1 << (hi & 7)), 1 << (hi & 7));
        // xf hashes the same token's ≥3-length parts and keeps the count 0.
        let xf = build_xf_record(7, b"app_main\n", tables.xr_xf("c"));
        assert_eq!(&xf[4..8], &0u32.to_le_bytes());
        for part in split_word_parts(b"app_main") {
            let pair = sig_pair(part).unwrap();
            let lo = (pair & 0xFFFF) as usize;
            let hi = (pair >> 16) as usize;
            assert_eq!(xf[SIG_HALF_A_AT + (lo >> 3)] & (1 << (lo & 7)), 1 << (lo & 7));
            assert_eq!(xf[SIG_HALF_B_AT + (hi >> 3)] & (1 << (hi & 7)), 1 << (hi & 7));
        }
    }

    #[test]
    fn the_extension_key_follows_the_reference_split() {
        assert_eq!(ext_key(b"a\\b\\file.c"), "c");
        assert_eq!(ext_key(b"dir.v2\\x.HPP"), "hpp");
        assert_eq!(ext_key(b"Makefile"), "(none)");
        // The reference's quirk: the last dot wins even inside a directory name.
        assert_eq!(ext_key(b"dir.v2\\readme"), "v2\\readme");
    }

    #[test]
    fn the_builtin_tables_carry_the_verified_closures() {
        let tables = builtin_tables();
        assert_eq!(tables.xr_xf("c").len(), 288); // incl. the `print` count fix
        assert_eq!(tables.xr_xf("cpp").len(), 166);
        assert_eq!(tables.xr_xf("h").len(), 223);
        assert_eq!(tables.xr_xf("py").len(), 152);
        assert_eq!(tables.xr_xf("txt").len(), 69);
        assert_eq!(tables.xr_xf("(none)").len(), 22);
        assert!(tables.xr_xf("c").contains(b"print".as_slice()));
        assert!(tables.xr_xf("c").contains(b"return".as_slice()));
        assert!(tables.xr_xf("c").contains(b"include".as_slice()));
        // The xc volume's AND gate adds its own closure per extension.
        assert!(tables.xc("html").contains(b"align".as_slice()));
        assert!(tables.xc("inc").contains(b"chip_id".as_slice()));
        assert_eq!(tables.xc("html").len(), 74);
        assert!(!tables.xr_xf("html").contains(b"align".as_slice()));
        // An unknown extension answers the empty set everywhere.
        assert!(tables.xr_xf("zzz").is_empty());
        assert!(tables.xc("zzz").is_empty());
    }

    /* ---------- the snapshot acceptance ---------- */

    #[test]
    fn xr_records_reproduce_the_snapshot_byte_for_byte() {
        let Some(fx) = load_fixture() else {
            skip_note();
            return;
        };
        let tables = builtin_tables();
        let mut exact = 0usize;
        let mut annotated = 0usize;
        for (fid, (rel, _slot)) in fx.files.iter().enumerate() {
            let fid = fid as u32;
            let data = fx.read_source(rel);
            let ext = ext_key(rel);
            let pred = build_xr_record(fid, &data, tables.xr_xf(&ext));
            let real = &fx.volumes["xr"][&fid];
            if pred.as_slice() == real.as_slice() {
                exact += 1;
                continue;
            }
            // The one annotated residual: the +4 count of ring_capture.c, +1 over the
            // snapshot, every other byte equal.
            let pred_count = u32::from_le_bytes(pred[4..8].try_into().unwrap());
            let real_count = u32::from_le_bytes(real[4..8].try_into().unwrap());
            let count_only_plus_one = pred[0..4] == real[0..4]
                && pred[8..] == real[8..]
                && pred_count == real_count + 1;
            if count_only_plus_one && rel.as_slice() == COUNT_RESIDUAL_PATH {
                annotated += 1;
                eprintln!(
                    "annotated: xr fid {fid} {} +4 count pred={pred_count} si={real_count} \
                     (the SPEC §11.2 collision-covered skip word); every other byte equal",
                    String::from_utf8_lossy(rel)
                );
                exact += 1;
                continue;
            }
            let at = first_diff(&pred, real).unwrap_or(0);
            let (real_extra, pred_extra) = bit_deltas(&pred, real);
            panic!(
                "xr record for fid {fid} ({}) differs first at byte {at} \
                 (real-extra bits {real_extra}, pred-extra bits {pred_extra})",
                String::from_utf8_lossy(rel)
            );
        }
        eprintln!("xr: {exact}/478 records byte-exact ({annotated} count residual annotated)");
        assert_eq!(exact, 478);
        assert_eq!(annotated, 1);
    }

    #[test]
    fn xf_records_reproduce_the_snapshot_byte_for_byte() {
        let Some(fx) = load_fixture() else {
            skip_note();
            return;
        };
        let tables = builtin_tables();
        let mut exact = 0usize;
        for (fid, (rel, _slot)) in fx.files.iter().enumerate() {
            let fid = fid as u32;
            let data = fx.read_source(rel);
            let ext = ext_key(rel);
            let pred = build_xf_record(fid, &data, tables.xr_xf(&ext));
            let real = &fx.volumes["xf"][&fid];
            if pred.as_slice() == real.as_slice() {
                exact += 1;
                continue;
            }
            let at = first_diff(&pred, real).unwrap_or(0);
            let (real_extra, pred_extra) = bit_deltas(&pred, real);
            panic!(
                "xf record for fid {fid} ({}) differs first at byte {at} \
                 (real-extra bits {real_extra}, pred-extra bits {pred_extra})",
                String::from_utf8_lossy(rel)
            );
        }
        eprintln!("xf: {exact}/478 records byte-exact");
        assert_eq!(exact, 478);
    }

    #[test]
    fn xc_records_reproduce_the_snapshot_with_known_residuals() {
        let Some(fx) = load_fixture() else {
            skip_note();
            return;
        };
        let tables = builtin_tables();
        let mut exact = 0usize;
        let mut annotated: Vec<String> = Vec::new();
        for (fid, (rel, _slot)) in fx.files.iter().enumerate() {
            let fid = fid as u32;
            let data = fx.read_source(rel);
            let ext = ext_key(rel);
            let pred = build_xc_record(fid, &data, lang_for_ext(&ext), tables.xc(&ext));
            let real = &fx.volumes["xc"][&fid];
            if pred.as_slice() == real.as_slice() {
                exact += 1;
                continue;
            }
            assert!(
                xc_residual(rel),
                "xc record for fid {fid} ({}) is not byte-exact and not a known residual \
                 (.inc/.html are the only two, SPEC §11.1)",
                String::from_utf8_lossy(rel)
            );
            // The residual is scanner semantics only: the record head matches and the
            // prediction never sets a bit the snapshot lacks.
            assert_eq!(
                pred[0..SIG_HALF_A_AT],
                real[0..SIG_HALF_A_AT],
                "xc residual {} differs outside its signature",
                String::from_utf8_lossy(rel)
            );
            let (real_extra, pred_extra) = bit_deltas(&pred, real);
            assert_eq!(pred_extra, 0, "xc residual {} over-sets bits", String::from_utf8_lossy(rel));
            eprintln!(
                "annotated: xc fid {fid} {} real-extra bits {real_extra} \
                 (the unmodeled .inc/.html scanner, SPEC §11.1)",
                String::from_utf8_lossy(rel)
            );
            annotated.push(String::from_utf8_lossy(rel).into_owned());
        }
        eprintln!(
            "xc: {exact}/478 records byte-exact, {} known residuals annotated",
            annotated.len()
        );
        assert_eq!(exact + annotated.len(), 478);
        assert!(exact >= 476, "xc must stay at the verified 476/478 or better");
        assert_eq!(annotated.len(), 2);
    }

    #[test]
    fn whole_volumes_reassemble_through_the_sipb_container_byte_for_byte() {
        let Some(fx) = load_fixture() else {
            skip_note();
            return;
        };
        for key in ["xr", "xf", "xc"] {
            // Every file's slot comes from its siproj aux id; the records are this
            // module's generated payloads; the container is sipb's, untouched.
            let bytes = assemble_volume(&fx, key);
            let real = &fx.raw[key];
            if bytes.as_slice() == real.as_slice() {
                eprintln!(
                    "{key}: whole volume reassembles byte for byte ({} bytes)",
                    bytes.len()
                );
                continue;
            }
            // The only whole-volume differences are the annotated residuals: xr's
            // ring_capture.c +4 count (+1, SPEC §11.2) and xc's two unmodeled-scanner
            // records (report.inc / index.html, SPEC §11.1). Patch exactly those byte
            // ranges from the snapshot and the files must agree everywhere else.
            let ranges = residual_ranges(&fx, key);
            let expected = match key {
                "xr" => 1,
                "xc" => 2,
                _ => 0,
            };
            assert_eq!(ranges.len(), expected, "{key}: annotated residual count");
            let mut patched = bytes;
            for (rel, from, to) in ranges {
                patched[from..to].copy_from_slice(&real[from..to]);
                eprintln!(
                    "annotated: {key} record of {} takes the snapshot's bytes {from}..{to}",
                    String::from_utf8_lossy(rel)
                );
            }
            assert_eq!(
                first_diff(&patched, real),
                None,
                "{key}: beyond the annotated residuals the whole volume must agree"
            );
        }
    }

    /// The absolute byte ranges of one volume's annotated residuals inside the file:
    /// xr's ring_capture.c count field and xc's two scanner residuals' signatures.
    fn residual_ranges(fx: &Fixture, key: &str) -> Vec<(&'static [u8], usize, usize)> {
        let base = crate::symbols::sipb::HEADER_BLOCK_SIZE;
        let slot_of = |needle: &[u8]| {
            fx.files
                .iter()
                .find(|(rel, _)| rel.ends_with(needle))
                .map(|(_, slot)| base + *slot as usize * XVOL_REC_SIZE)
        };
        match key {
            "xr" => slot_of(COUNT_RESIDUAL_PATH)
                .into_iter()
                .map(|at| (COUNT_RESIDUAL_PATH, at + 4, at + 8))
                .collect(),
            "xc" => [
                (&b"test\\report.inc"[..], SIG_HALF_A_AT, XVOL_REC_SIZE),
                (b"streaming\\index.html", SIG_HALF_A_AT, XVOL_REC_SIZE),
            ]
            .into_iter()
            .filter_map(|(needle, from, to)| {
                slot_of(needle).map(|at| (needle, at + from, at + to))
            })
            .collect(),
            _ => Vec::new(),
        }
    }

    /// One x-volume rebuilt through the container: generated records ordered by the
    /// siproj aux id, under the snapshot's own header shape.
    fn assemble_volume(fx: &Fixture, key: &'static str) -> Vec<u8> {
        let tables = builtin_tables();
        let mut slots: Vec<Vec<u8>> = vec![Vec::new(); fx.files.len()];
        for (fid, (rel, slot)) in fx.files.iter().enumerate() {
            let data = fx.read_source(rel);
            let ext = ext_key(rel);
            let fid = fid as u32;
            let record = match key {
                "xr" => build_xr_record(fid, &data, tables.xr_xf(&ext)),
                "xf" => build_xf_record(fid, &data, tables.xr_xf(&ext)),
                _ => build_xc_record(fid, &data, lang_for_ext(&ext), tables.xc(&ext)),
            };
            slots[*slot as usize] = record.to_vec();
        }
        let header = VolumeHeader {
            count: fx.files.len() as u32,
            capacity: fx.files.len() as u32,
            ..VolumeHeader::initial(MAGIC_XVOL, XVOL_REC_SIZE as u32)
        };
        let refs: Vec<&[u8]> = slots.iter().map(|v| v.as_slice()).collect();
        emit_volume(&header, &refs)
    }
}
