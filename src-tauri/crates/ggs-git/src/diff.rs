//! ggs-git::diff — git-style line diffs for the workbench's diff editors, computed by the
//! gix engine: `gix_diff::blob::diff_with_slider_heuristics` is git's own diff behaviour
//! (Myers plus the slider heuristics `git diff` applies by default) over gix-imara-diff,
//! so a diff here reads exactly like the same file's `git diff` would.
//!
//! The hunks are git's shape at zero context: maximal runs of changed lines with no
//! unchanged line between them. Line numbers are 1-based the way git's `@@ -l,c +l,c @@`
//! headers spell them — a side with zero lines names the line the change sits after
//! (`@@ -5,0` = an insertion following line 5). Only changed lines cross the wire; the
//! unchanged gaps between hunks belong to the view.
//!
//! Within a hunk, paired lines (the i-th deleted against the i-th added, after the
//! identical edge lines of the two blocks are trimmed away) carry character-level
//! spans of exactly the parts that differ — VS Code's inline word-diff — so a
//! one-character edit highlights that character instead of washing the whole line.
//!
//! The comparison normalizes every line's copy: a carriage return never makes a line
//! differ (CRLF/LF-only rewrites diff empty, the editor's own behaviour), and the
//! ignore options (whitespace, case) apply to the comparison only — a hunk's lines
//! carry the texts as they are in the file.

use std::ops::Range;

use gix_diff::blob::{diff_with_slider_heuristics, Algorithm, Diff, InternedInput, TokenSource};
use serde::Serialize;

/// The comparison's knobs: every line is normalized for equality before the diff, never
/// for display.
#[derive(Clone, Copy, Debug, Default)]
pub struct DiffOptions {
    /// Lines differing in whitespace runs or outer spacing alone compare equal
    /// (`.replace(/\s+/g, ' ').trim()`, the editor's own ignore-whitespace rule).
    pub ignore_whitespace: bool,
    /// Lines differing in case alone compare equal.
    pub ignore_case: bool,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineKind {
    Deleted,
    Added,
}

/// A run of characters within a paired changed line that differs from its twin — the
/// inline highlight VS Code paints inside a changed line, so a one-character edit shows
/// as that character and not a whole-line wash. The offsets are UTF-16 code units into
/// the line's own `text`, the frontend's string coordinates; the spans of a line are
/// sorted, disjoint and never empty.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffSpan {
    pub start: u32,
    pub end: u32,
}

/// One changed line of a hunk, its text as the file carries it. `spans` carries the
/// character-level difference against the line's twin on the other side of the same
/// hunk (empty when the line has no twin, when the pair differs too much to be worth
/// highlighting, or on a pure insertion/deletion side).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub text: String,
    pub spans: Vec<DiffSpan>,
}

/// One change: a run of deleted lines replaced by a run of added ones (either side may
/// be empty). The starts are 1-based; an empty side's start names the line the change
/// sits after, git's `@@ -5,0` spelling.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// The hunk's own lines, deleted ones first then added ones.
    pub lines: Vec<DiffLine>,
}

/// A whole-file text diff: the hunks plus the per-side line totals the diff editor's
/// badge shows. `binary` is set instead of hunks when either side is binary text —
/// the caller routes those to the byte comparison.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LineDiff {
    pub binary: bool,
    pub hunks: Vec<DiffHunk>,
    pub additions: u32,
    pub deletions: u32,
}

/// A text's lines without their terminators: an empty text has no lines, a trailing
/// newline adds none (`"a\nb"` and `"a\nb\n"` are the same two lines).
fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

/// The line's comparison form: the original with its carriage return dropped, then the
/// ignore options folded in. The hunks never carry this form — it exists so whitespace
/// and case differences do not manufacture changes.
fn comparable(line: &str, options: DiffOptions) -> String {
    let stripped = line.strip_suffix('\r').unwrap_or(line);
    if !options.ignore_whitespace && !options.ignore_case {
        return stripped.to_owned();
    }
    let folded = if options.ignore_case {
        stripped.to_lowercase()
    } else {
        stripped.to_owned()
    };
    if options.ignore_whitespace {
        folded.split_whitespace().collect::<Vec<_>>().join(" ")
    } else {
        folded
    }
}

/// A [`TokenSource`] over prepared lines: equality runs on the comparison form, while
/// the caller keeps the original texts the hunks are rendered from.
struct PreparedLines<'a> {
    lines: &'a [String],
}

impl<'a> PreparedLines<'a> {
    fn iter(&self) -> PreparedLinesIter<'a> {
        PreparedLinesIter {
            lines: self.lines,
            pos: 0,
        }
    }
}

struct PreparedLinesIter<'a> {
    lines: &'a [String],
    pos: usize,
}

impl<'a> Iterator for PreparedLinesIter<'a> {
    type Item = &'a str;

    fn next(&mut self) -> Option<Self::Item> {
        let line = self.lines.get(self.pos)?;
        self.pos += 1;
        Some(line.as_str())
    }
}

impl<'a> TokenSource for PreparedLines<'a> {
    type Token = &'a str;
    type Tokenizer = PreparedLinesIter<'a>;

    fn tokenize(&self) -> Self::Tokenizer {
        self.iter()
    }

    fn estimate_tokens(&self) -> u32 {
        self.lines.len() as u32
    }
}

/// A [`TokenSource`] over single characters — the same engine the line diff runs on,
/// one token per character, for the inline spans of a paired line.
struct Chars<'a> {
    chars: &'a [char],
}

struct CharsIter<'a> {
    chars: &'a [char],
    pos: usize,
}

impl<'a> Iterator for CharsIter<'a> {
    type Item = char;

    fn next(&mut self) -> Option<Self::Item> {
        let c = *self.chars.get(self.pos)?;
        self.pos += 1;
        Some(c)
    }
}

impl<'a> TokenSource for Chars<'a> {
    type Token = char;
    type Tokenizer = CharsIter<'a>;

    fn tokenize(&self) -> Self::Tokenizer {
        CharsIter { chars: self.chars, pos: 0 }
    }

    fn estimate_tokens(&self) -> u32 {
        self.chars.len() as u32
    }
}

/// Lines longer than this many characters (either side of a pair) carry no inline
/// spans — a minified bundle's mega-line is a whole-line change however it is painted,
/// and the character diff of two such lines is not worth its cost.
const INLINE_SPAN_MAX_CHARS: usize = 1024;

/// The total character budget one `text_diff` call may spend on inline spans. A huge
/// patch (thousands of paired lines) spends it and the rest render whole-line — the
/// same trade VS Code's word-diff makes, kept from ever making a diff slow.
const INLINE_SPAN_BUDGET: usize = 1_000_000;

/// The character spans in which `old` and `new` differ, as UTF-16 offsets into each
/// text (the frontend's string coordinates). Equal texts and over-cap pairs answer
/// none; a common prefix and suffix are never highlighted, and the middles are diffed
/// character-by-character so a one-character edit highlights exactly that character.
fn inline_spans(old: &str, new: &str) -> (Vec<DiffSpan>, Vec<DiffSpan>) {
    let a: Vec<char> = old.chars().collect();
    let b: Vec<char> = new.chars().collect();
    if a.len() > INLINE_SPAN_MAX_CHARS || b.len() > INLINE_SPAN_MAX_CHARS {
        return (Vec::new(), Vec::new());
    }
    let mut prefix = 0;
    while prefix < a.len() && prefix < b.len() && a[prefix] == b[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < a.len() - prefix && suffix < b.len() - prefix && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix] {
        suffix += 1;
    }
    let mid_a = &a[prefix..a.len() - suffix];
    let mid_b = &b[prefix..b.len() - suffix];
    // A middle empty on one side is the other side's whole span — no engine call.
    if mid_a.is_empty() || mid_b.is_empty() {
        let one = |mid: &[char], at: usize, offsets: &[u32]| {
            (!mid.is_empty()).then(|| vec![DiffSpan { start: offsets[at], end: offsets[at + mid.len()] }])
        };
        let offsets_a = utf16_offsets(&a);
        let offsets_b = utf16_offsets(&b);
        return (one(mid_a, prefix, &offsets_a).unwrap_or_default(), one(mid_b, prefix, &offsets_b).unwrap_or_default());
    }
    let offsets_a = utf16_offsets(&a);
    let offsets_b = utf16_offsets(&b);
    let input = InternedInput::new(Chars { chars: mid_a }, Chars { chars: mid_b });
    // The slider heuristics are line-orientation magic (and demand byte tokens); the
    // plain Myers the engine runs underneath is the whole answer at character level.
    let diff = Diff::compute(Algorithm::Myers, &input);
    let mut spans_a = Vec::new();
    let mut spans_b = Vec::new();
    for hunk in diff.hunks() {
        push_span(&mut spans_a, &offsets_a, prefix, hunk.before.clone());
        push_span(&mut spans_b, &offsets_b, prefix, hunk.after.clone());
    }
    (spans_a, spans_b)
}

/// UTF-16 code-unit offsets of every char boundary of a line (len + 1 entries): index i
/// maps the i-th character's start, so a char range maps onto the string coordinates
/// the frontend slices with.
fn utf16_offsets(chars: &[char]) -> Vec<u32> {
    let mut out = Vec::with_capacity(chars.len() + 1);
    let mut at = 0u32;
    out.push(0);
    for c in chars {
        at += c.len_utf16() as u32;
        out.push(at);
    }
    out
}

/// Appends a token-space range as a UTF-16 span, merging with the previous span when
/// they touch (adjacent changed regions read as one highlight).
fn push_span(spans: &mut Vec<DiffSpan>, offsets: &[u32], at: usize, range: Range<u32>) {
    if range.is_empty() {
        return;
    }
    let span = DiffSpan { start: offsets[at + range.start as usize], end: offsets[at + range.end as usize] };
    match spans.last_mut() {
        Some(last) if last.end == span.start => last.end = span.end,
        _ => spans.push(span),
    }
}

/// The inline spans of every line of a hunk: the deleted block and the added block are
/// trimmed of the identical lines they share at their edges (a line inside both blocks
/// is unchanged and never highlights), and the remaining lines pair up by index — the
/// i-th deleted line against the i-th added line, VS Code's own alignment. Unpaired
/// lines (a block longer than its twin) carry no spans: they have no counterpart to
/// differ from. `budget` bounds the whole call's inline work.
fn pair_inline_spans(deleted: &[&str], added: &[&str], budget: &mut usize) -> (Vec<Vec<DiffSpan>>, Vec<Vec<DiffSpan>>) {
    let mut del_spans = vec![Vec::new(); deleted.len()];
    let mut add_spans = vec![Vec::new(); added.len()];
    let mut head = 0;
    while head < deleted.len() && head < added.len() && deleted[head] == added[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < deleted.len() - head
        && tail < added.len() - head
        && deleted[deleted.len() - 1 - tail] == added[added.len() - 1 - tail]
    {
        tail += 1;
    }
    let pairs = (deleted.len() - head - tail).min(added.len() - head - tail);
    for i in 0..pairs {
        let (old, new) = (&deleted[head + i], &added[head + i]);
        let cost = old.chars().count() + new.chars().count();
        if cost > *budget {
            *budget = 0;
            break;
        }
        *budget -= cost;
        let (spans_a, spans_b) = inline_spans(old, new);
        del_spans[head + i] = spans_a;
        add_spans[head + i] = spans_b;
    }
    (del_spans, add_spans)
}

/// The git-style diff of two texts: every hunk the engine found, each with its original
/// line texts and git's own line numbering.
pub fn text_diff(old: &str, new: &str, options: DiffOptions) -> LineDiff {
    let old_lines = split_lines(old);
    let new_lines = split_lines(new);
    let old_form: Vec<String> = old_lines.iter().map(|l| comparable(l, options)).collect();
    let new_form: Vec<String> = new_lines.iter().map(|l| comparable(l, options)).collect();
    let input = InternedInput::new(
        PreparedLines { lines: &old_form },
        PreparedLines { lines: &new_form },
    );
    let diff = diff_with_slider_heuristics(Algorithm::Myers, &input);
    let mut out = LineDiff::default();
    let mut inline_budget = INLINE_SPAN_BUDGET;
    for hunk in diff.hunks() {
        let (before, after) = (hunk.before, hunk.after);
        let deleted: Vec<&str> = old_lines.get(before.start as usize..before.end as usize).unwrap_or(&[]).to_vec();
        let added: Vec<&str> = new_lines.get(after.start as usize..after.end as usize).unwrap_or(&[]).to_vec();
        let (del_spans, add_spans) = pair_inline_spans(&deleted, &added, &mut inline_budget);
        let mut lines = Vec::with_capacity(deleted.len() + added.len());
        for (index, spans) in deleted.iter().zip(del_spans) {
            lines.push(DiffLine {
                kind: DiffLineKind::Deleted,
                text: (*index).to_owned(),
                spans,
            });
        }
        for (index, spans) in added.iter().zip(add_spans) {
            lines.push(DiffLine {
                kind: DiffLineKind::Added,
                text: (*index).to_owned(),
                spans,
            });
        }
        out.deletions += before.end - before.start;
        out.additions += after.end - after.start;
        // git's numbering: an occupied side counts from its first line; an empty side
        // names the line the insertion or deletion sits after (its 0-based index).
        out.hunks.push(DiffHunk {
            old_start: if before.is_empty() {
                before.start
            } else {
                before.start + 1
            },
            old_lines: before.end - before.start,
            new_start: if after.is_empty() {
                after.start
            } else {
                after.start + 1
            },
            new_lines: after.end - after.start,
            lines,
        });
    }
    out
}

/// git's own binary sniff: a NUL byte in the head marks a side as binary (the same
/// first-8-KiB window `git diff` reads).
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(8000)].contains(&0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diff(old: &str, new: &str) -> LineDiff {
        text_diff(old, new, DiffOptions::default())
    }

    fn starts(d: &LineDiff) -> Vec<(u32, u32, u32, u32)> {
        d.hunks
            .iter()
            .map(|h| (h.old_start, h.old_lines, h.new_start, h.new_lines))
            .collect()
    }

    #[test]
    fn edits_across_blank_lines_stay_separate_hunks() {
        // The shape the diff editor used to glue into one change: edits separated by a
        // blank line are git-separate hunks, not one merged block.
        let old = "const a = 1;\n\nconst b = 2;\n\nconst c = 3;\n";
        let new = "const a = 10;\n\nconst b = 20;\n\nconst c = 30;\n";
        let d = diff(old, new);
        assert_eq!(starts(&d), vec![(1, 1, 1, 1), (3, 1, 3, 1), (5, 1, 5, 1)]);
        assert_eq!((d.additions, d.deletions), (3, 3));
        assert_eq!(
            d.hunks[0].lines,
            vec![
                DiffLine {
                    kind: DiffLineKind::Deleted,
                    text: "const a = 1;".into(),
                    // The old line is a prefix-and-suffix of the new one — the inserted
                    // `0` highlights on the new side alone, exactly VS Code's reading.
                    spans: vec![]
                },
                DiffLine {
                    kind: DiffLineKind::Added,
                    text: "const a = 10;".into(),
                    spans: vec![DiffSpan { start: 11, end: 12 }]
                },
            ]
        );
    }

    #[test]
    fn paired_lines_highlight_the_changed_characters() {
        // The owner's case: one character changed inside a line — exactly that
        // character highlights on each side, never a whole-line wash.
        let d = diff("let value = 1;\n", "let value = 2;\n");
        assert_eq!(starts(&d), vec![(1, 1, 1, 1)]);
        assert_eq!(d.hunks[0].lines[0].spans, vec![DiffSpan { start: 12, end: 13 }]);
        assert_eq!(d.hunks[0].lines[1].spans, vec![DiffSpan { start: 12, end: 13 }]);
    }

    #[test]
    fn spans_are_utf16_offsets() {
        // An emoji costs two UTF-16 units; a span after it must count both, or the
        // frontend highlights one code unit off.
        let d = diff("ok\u{1f600}x\n", "ok\u{1f600}y\n");
        assert_eq!(d.hunks[0].lines[0].spans, vec![DiffSpan { start: 4, end: 5 }]);
        assert_eq!(d.hunks[0].lines[1].spans, vec![DiffSpan { start: 4, end: 5 }]);
    }

    #[test]
    fn a_line_that_only_grew_highlights_the_addition_on_one_side() {
        let d = diff("hello\n", "hello world\n");
        assert_eq!(d.hunks[0].lines[0].spans, vec![]);
        assert_eq!(d.hunks[0].lines[1].spans, vec![DiffSpan { start: 5, end: 11 }]);
    }

    #[test]
    fn pure_insertions_and_deletions_carry_no_spans() {
        // No deleted lines to pair against (and vice versa) — the whole lines are the
        // change.
        let d = diff("a\nb\n", "a\nX\nY\nb\n");
        assert!(d.hunks[0].lines.iter().all(|l| l.spans.is_empty()));
    }

    #[test]
    fn pairing_trims_shared_edge_lines_and_leaves_unpaired_bare() {
        let deleted = ["same", "old mid", "tail", "zzz"];
        let added = ["same", "new mid", "tail2"];
        let mut budget = INLINE_SPAN_BUDGET;
        let (del, add) = pair_inline_spans(&deleted, &added, &mut budget);
        // The shared `same` head never highlights; `old mid`/`new mid` pair on their
        // differing middles; `tail` vs `tail2` highlights the appended character on
        // the new side alone; `zzz` has no twin at all.
        assert_eq!(del[0], vec![]);
        assert_eq!(add[0], vec![]);
        assert_eq!(del[1], vec![DiffSpan { start: 0, end: 3 }]);
        assert_eq!(add[1], vec![DiffSpan { start: 0, end: 3 }]);
        assert_eq!(del[2], vec![]);
        assert_eq!(add[2], vec![DiffSpan { start: 4, end: 5 }]);
        assert_eq!(del[3], vec![]);
    }

    #[test]
    fn over_cap_and_spent_budget_skip_inline_spans() {
        let long_old = "x".repeat(INLINE_SPAN_MAX_CHARS + 1);
        let long_new = "y".repeat(INLINE_SPAN_MAX_CHARS + 1);
        let mut budget = INLINE_SPAN_BUDGET;
        let (del, add) = pair_inline_spans(&[&long_old], &[&long_new], &mut budget);
        assert_eq!(del[0], vec![]);
        assert_eq!(add[0], vec![]);
        // A spent budget stops the whole call's inline work, not just this pair.
        let mut budget = 1;
        let (del, _add) = pair_inline_spans(&["aaaa"], &["bbbb"], &mut budget);
        assert_eq!(del[0], vec![]);
        assert_eq!(budget, 0);
    }

    #[test]
    fn adjacent_line_edits_form_one_hunk() {
        let d = diff("one\ntwo\nthree\n", "ONE\nTWO\nthree\n");
        assert_eq!(starts(&d), vec![(1, 2, 1, 2)]);
    }

    #[test]
    fn a_pure_insertion_names_the_line_it_follows() {
        // git's own spelling: @@ -1,0 +2,2 @@ — the insertion sits after old line 1.
        let d = diff("a\nb\n", "a\nX\nY\nb\n");
        assert_eq!(starts(&d), vec![(1, 0, 2, 2)]);
        assert_eq!(
            d.hunks[0]
                .lines
                .iter()
                .map(|l| (l.kind, l.text.as_str()))
                .collect::<Vec<_>>(),
            vec![(DiffLineKind::Added, "X"), (DiffLineKind::Added, "Y")]
        );
        assert!(d.hunks[0].lines.iter().all(|l| l.spans.is_empty()));
    }

    #[test]
    fn a_pure_deletion_names_where_it_sat() {
        // git's own spelling: @@ -2,2 +1,0 @@ — lines 2-3 gone after new line 1.
        let d = diff("a\nb\nc\nd\n", "a\nd\n");
        assert_eq!(starts(&d), vec![(2, 2, 1, 0)]);
        assert_eq!(
            d.hunks[0]
                .lines
                .iter()
                .map(|l| (l.kind, l.text.as_str()))
                .collect::<Vec<_>>(),
            vec![(DiffLineKind::Deleted, "b"), (DiffLineKind::Deleted, "c")]
        );
    }

    #[test]
    fn an_added_file_diffs_from_line_one() {
        // git's own spelling for a new file: @@ -0,0 +1,2 @@.
        let d = diff("", "x\ny\n");
        assert_eq!(starts(&d), vec![(0, 0, 1, 2)]);
        assert_eq!((d.additions, d.deletions), (2, 0));
        // And its removal: @@ -1,2 +0,0 @@.
        assert_eq!(starts(&diff("x\ny\n", "")), vec![(1, 2, 0, 0)]);
        assert_eq!((diff("x\ny\n", "").additions, diff("x\ny\n", "").deletions), (0, 2));
    }

    #[test]
    fn ignore_whitespace_and_case_fold_the_comparison_but_not_the_texts() {
        let old = "const A  = 1;\n";
        let new = "const a = 1;\n";
        let d = text_diff(
            old,
            new,
            DiffOptions {
                ignore_whitespace: true,
                ignore_case: true,
            },
        );
        assert!(d.hunks.is_empty());
        // The options change equality only — with them off the same texts differ, and
        // the hunk carries the texts as the files hold them.
        let d = diff(old, new);
        assert_eq!(d.hunks.len(), 1);
        assert_eq!(d.hunks[0].lines[0].text, "const A  = 1;");
        assert_eq!(d.hunks[0].lines[1].text, "const a = 1;");
    }

    #[test]
    fn whitespace_only_edits_stay_hunks_when_not_ignored() {
        let d = diff("a  = 1\n", "a =    1\n");
        assert_eq!(d.hunks.len(), 1);
    }

    #[test]
    fn a_carriage_return_never_makes_a_line_differ() {
        assert!(diff("a\r\nb\r\n", "a\nb\n").hunks.is_empty());
        // A real edit between CRLF sides still lands.
        assert_eq!(diff("a\r\nb\r\n", "a\r\nB\r\n").hunks.len(), 1);
    }

    #[test]
    fn identical_texts_and_empties_diff_nothing() {
        assert!(diff("same\nlines\n", "same\nlines\n").hunks.is_empty());
        assert!(diff("", "").hunks.is_empty());
        assert!(diff("only\n", "").deletions == 1);
    }

    #[test]
    fn moved_lines_read_as_git_reads_them() {
        // Reordering two statements: the unchanged `second();` between the two edits
        // keeps the hunks apart at zero context, exactly as `git diff -U0` reports the
        // move — one deletion and one insertion, never a rewrite of the block between.
        let old = "first();\nsecond();\nthird();\n";
        let new = "second();\nfirst();\nthird();\n";
        let d = diff(old, new);
        assert_eq!(starts(&d), vec![(1, 1, 0, 0), (2, 0, 2, 1)]);
        assert_eq!(d.hunks[0].lines[0].text, "first();");
        assert_eq!(d.hunks[1].lines[0].text, "first();");
        assert_eq!((d.additions, d.deletions), (1, 1));
    }

    #[test]
    fn nul_bytes_mark_a_side_binary() {
        assert!(looks_binary(b"ok\x00not"));
        assert!(!looks_binary("plain text\n".as_bytes()));
    }
}
