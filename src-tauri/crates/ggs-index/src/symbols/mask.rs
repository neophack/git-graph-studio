//! The comment/string mask behind the relation queries' reference quality: a single pass
//! over one file's text that records which character
//! ranges a `//` line comment, a `/* */` block comment, a string literal or a character
//! literal occupies. A reference hit landing inside a masked range is the comment's or
//! the string's own words, not code, and the relation engine drops it.
//!
//! The rules: an escape (`\`) skips the next character inside a
//! string, an unterminated string runs to end of file (tolerant, never a panic), and the
//! scan is one loop — no recursion, so a file of a hundred thousand comment lines costs
//! the same as any other text. One deliberate addition: the C++ raw string `R"delim(…)delim"`
//! is recognized when its delimiters resolve; when they do not (or the prefix is really an
//! identifier named `R` beside a quote), the quote degrades to a plain string literal and
//! the scan stays correct for everything else. Offsets are in **characters**, not bytes,
//! because the callers speak character columns (`SearchMatch`'s column, a word scan's
//! index) and one non-ASCII character would otherwise shift every later column.

/// The masked character ranges and the per-line start offsets of one text.
/// `spans` are inclusive-start, exclusive-end character offsets; `line_starts[i]` is
/// the character offset of line `i`'s first character (lines split on `\n`, matching
/// `str::lines`'s 0-based indexing).
pub struct CodeMask {
    pub spans: Vec<(usize, usize)>,
    pub line_starts: Vec<usize>,
    /// Total characters — the bound `is_masked` clamps against.
    char_len: usize,
}

/// A UTF-8 continuation byte never starts a character, so counting non-continuation
/// bytes counts characters — the mask walks bytes for speed but answers in characters.
fn starts_char(b: u8) -> bool {
    b & 0xC0 != 0x80
}

/// Compute the mask of `text`. O(n), one allocation per span and per line.
pub fn mask(text: &str) -> CodeMask {
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut line_starts: Vec<usize> = vec![0];
    // Character offset of byte position `b`; a newline steps it like any other char.
    let mut char_pos = 0usize;
    // One step of the scan: consume the byte at `b`, keeping the char counter and the
    // line starts current — inside comments and strings too, whose newlines still open
    // lines the callers may ask about.
    fn step(bytes: &[u8], b: &mut usize, char_pos: &mut usize, line_starts: &mut Vec<usize>) {
        if bytes[*b] == b'\n' {
            *b += 1;
            *char_pos += 1;
            if *b < bytes.len() {
                line_starts.push(*char_pos);
            }
        } else {
            if starts_char(bytes[*b]) {
                *char_pos += 1;
            }
            *b += 1;
        }
    }

    let mut b = 0usize;
    while b < len {
        // `//` to end of line; the newline itself stays unmasked (the line break is not
        // the comment's content, and the next line's start must register).
        if bytes[b] == b'/' && b + 1 < len && bytes[b + 1] == b'/' {
            let start = char_pos;
            while b < len && bytes[b] != b'\n' {
                step(bytes, &mut b, &mut char_pos, &mut line_starts);
            }
            spans.push((start, char_pos));
            continue;
        }
        // `/* */` across lines; unterminated runs to end of file.
        if bytes[b] == b'/' && b + 1 < len && bytes[b + 1] == b'*' {
            let start = char_pos;
            step(bytes, &mut b, &mut char_pos, &mut line_starts);
            step(bytes, &mut b, &mut char_pos, &mut line_starts);
            while b + 1 < len && !(bytes[b] == b'*' && bytes[b + 1] == b'/') {
                step(bytes, &mut b, &mut char_pos, &mut line_starts);
            }
            if b + 1 < len {
                step(bytes, &mut b, &mut char_pos, &mut line_starts); // '*'
                step(bytes, &mut b, &mut char_pos, &mut line_starts); // '/'
            } else {
                while b < len {
                    step(bytes, &mut b, &mut char_pos, &mut line_starts);
                }
            }
            spans.push((start, char_pos));
            continue;
        }
        // C++ raw string `R"delim(...)delim"` — recognized when a `(` closes the
        // delimiter within a short prefix and the matching `)delim"` comes back; any
        // other spelling (an identifier `R` beside a quote, no closing arm) degrades to
        // the plain-quote path one character later, which stays tolerant.
        if (bytes[b] == b'R' || bytes[b] == b'r') && b + 1 < len && bytes[b + 1] == b'"' {
            if let Some(end) = raw_string_end(bytes, b + 2) {
                let start = char_pos;
                while b < end {
                    step(bytes, &mut b, &mut char_pos, &mut line_starts);
                }
                spans.push((start, char_pos));
                continue;
            }
            // Degrade: step the prefix character, then the quote below handles the rest.
            step(bytes, &mut b, &mut char_pos, &mut line_starts);
        }
        // String or character literal: to the closing quote, `\` skipping the next
        // character; unterminated, to end of file (tolerant — the escape and
        // the newline inside are literal text, newlines still open lines).
        if bytes[b] == b'"' || bytes[b] == b'\'' {
            let quote = bytes[b];
            let start = char_pos;
            step(bytes, &mut b, &mut char_pos, &mut line_starts);
            while b < len && bytes[b] != quote {
                if bytes[b] == b'\\' && b + 1 < len {
                    step(bytes, &mut b, &mut char_pos, &mut line_starts);
                }
                step(bytes, &mut b, &mut char_pos, &mut line_starts);
            }
            if b < len {
                step(bytes, &mut b, &mut char_pos, &mut line_starts);
            }
            spans.push((start, char_pos));
            continue;
        }
        step(bytes, &mut b, &mut char_pos, &mut line_starts);
    }

    CodeMask {
        spans,
        line_starts,
        char_len: char_pos,
    }
}

/// The byte position just past a raw string starting at `bytes[from]` (the byte after the
/// opening quote), or `None` when the `delim( … )delim"` arms do not resolve there.
fn raw_string_end(bytes: &[u8], from: usize) -> Option<usize> {
    let mut d = from;
    while d < bytes.len() && bytes[d] != b'(' {
        let c = bytes[d];
        // A delimiter carries identifier and `#` characters only; anything else (a quote,
        // a newline, whitespace, a second opening quote) is not a raw-string head.
        if !(c.is_ascii_alphanumeric() || c == b'_' || c == b'#') {
            return None;
        }
        d += 1;
        if d - from > 32 {
            return None;
        }
    }
    if d >= bytes.len() {
        return None;
    }
    let delim = &bytes[from..d]; // may be empty: R"(...)"
    d += 1; // past '('
    while d + delim.len() + 2 <= bytes.len() {
        if bytes[d] == b')' {
            let tail = &bytes[d + 1..d + 1 + delim.len()];
            if tail == delim && bytes[d + 1 + delim.len()] == b'"' {
                return Some(d + delim.len() + 2);
            }
        }
        d += 1;
    }
    None
}

impl CodeMask {
    /// Whether the character at 0-based `line`, `col` sits inside a comment or string.
    /// Off the text (a line or column past its end) is never masked.
    pub fn is_masked(&self, line: usize, col: usize) -> bool {
        let Some(&start) = self.line_starts.get(line) else {
            return false;
        };
        let offset = start + col;
        if offset >= self.char_len {
            return false;
        }
        // The last span beginning at or before the offset decides: a span the offset
        // falls inside masks it, an earlier-ended span leaves it unmasked.
        let at = self.spans.partition_point(|&(s, _)| s <= offset);
        at > 0 && offset < self.spans[at - 1].1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offsets_of(text: &str, needle: &str) -> Vec<(usize, usize)> {
        // Every (line, col) the needle's first character sits at.
        let mut hits = Vec::new();
        for (line_no, line) in text.split('\n').enumerate() {
            let mut rest = line;
            let mut col = 0usize;
            while let Some(at) = rest.find(needle) {
                hits.push((line_no, col + at));
                rest = &rest[at + needle.len()..];
                col += at + needle.len();
            }
        }
        hits
    }

    #[test]
    fn line_comment_masks_to_end_of_line_only() {
        let text = "int alpha(int x); // calls alpha(x) here\nalpha(1);\n";
        let m = mask(text);
        assert!(m.is_masked(0, 21));
        assert!(!m.is_masked(0, 4), "the declaration itself stays unmasked");
        assert!(!m.is_masked(1, 0));
    }

    #[test]
    fn block_comment_masks_across_lines() {
        let text = "int a;\n/* alpha(x)\n   beta(y) */\nalpha(2);\n";
        let m = mask(text);
        assert!(!m.is_masked(0, 4));
        assert!(m.is_masked(1, 3));
        assert!(m.is_masked(2, 3), "the second comment line stays masked");
        assert!(!m.is_masked(3, 0), "code after the close is live again");
    }

    #[test]
    fn string_with_escaped_quote_masks_the_whole_literal() {
        let text = r#"char *s = "he said \"alpha\" loudly"; alpha(1);"#;
        let m = mask(text);
        // The escaped quotes must not end the literal: the in-string alpha masks, the
        // trailing call after the real close does not.
        for (line, col) in offsets_of(text, "alpha") {
            if col < 30 {
                assert!(m.is_masked(line, col), "in-string alpha at {col} masks");
            } else {
                assert!(!m.is_masked(line, col), "real call at {col} stays");
            }
        }
    }

    #[test]
    fn char_literal_masks_but_escapes_do_not_leak() {
        let text = r#"int c = '\''; alpha(1); d = 'x';"#;
        let m = mask(text);
        assert!(m.is_masked(0, 9), "the escaped quote sits in the literal");
        assert!(!m.is_masked(0, 14), "the call after the literal is live");
        assert!(m.is_masked(0, 28), "the 'x' literal masks");
        assert!(!m.is_masked(0, 31));
    }

    #[test]
    fn unterminated_string_runs_to_end_of_file_without_panicking() {
        let text = "int a = 1;\nchar *s = \"never closed\nalpha(1);\n";
        let m = mask(text);
        assert!(!m.is_masked(0, 4));
        assert!(m.is_masked(1, 12));
        assert!(m.is_masked(2, 0), "everything after the open quote is string");
    }

    #[test]
    fn qualified_and_arrow_operators_stay_live() {
        let text = "Alpha::Beta g = h->make();\n";
        let m = mask(text);
        for (line, col) in offsets_of(text, "Beta") {
            assert!(!m.is_masked(line, col));
        }
        assert!(!m.is_masked(0, 17));
        assert_eq!(m.line_starts.len(), 1, "no trailing empty line");
    }

    #[test]
    fn crlf_text_keeps_line_starts_aligned() {
        let text = "// alpha\r\nalpha(1);\r\n/* x */\r\nalpha(2);\r\n";
        let m = mask(text);
        let hits = offsets_of(text, "alpha");
        assert_eq!(hits.len(), 3);
        assert!(m.is_masked(hits[0].0, hits[0].1), "the commented one masks");
        assert!(!m.is_masked(hits[1].0, hits[1].1));
        assert!(!m.is_masked(hits[2].0, hits[2].1));
        assert_eq!(m.line_starts[1], 10, "line 1 starts after the CRLF");
    }

    #[test]
    fn raw_string_recognized_and_degrades_when_unarmed() {
        // A recognized raw string masks its whole body, newlines included.
        let text = "static char *p = R\"json({\"alpha\": 1})json\";\nalpha(1);\n";
        let m = mask(text);
        assert!(m.is_masked(0, 24), "the raw string body masks");
        assert!(!m.is_masked(1, 0));
        // An `R` beside a quote that never arms degrades to a plain string: the code
        // before the comment stays live, the comment masks, and the next line is code.
        let text = "int R = 0; alpha(R); // R\"(unclosed\nalpha(2);\n";
        let m = mask(text);
        assert!(!m.is_masked(0, 11), "the plain call before the comment is live");
        assert!(m.is_masked(0, 21), "the // comment masks");
        assert!(!m.is_masked(1, 0), "the line comment never leaks into line 1");
    }

    #[test]
    fn line_starts_cover_every_line_inside_comments_and_strings() {
        let text = "/* one\ntwo\nthree */\nlast;\n";
        let m = mask(text);
        assert_eq!(m.line_starts, vec![0, 7, 11, 20]);
        assert!(m.is_masked(1, 0) && m.is_masked(2, 0));
        assert!(!m.is_masked(3, 0));
    }
}
