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
//! The comparison normalizes every line's copy: a carriage return never makes a line
//! differ (CRLF/LF-only rewrites diff empty, the editor's own behaviour), and the
//! ignore options (whitespace, case) apply to the comparison only — a hunk's lines
//! carry the texts as they are in the file.

use gix_diff::blob::{diff_with_slider_heuristics, Algorithm, InternedInput, TokenSource};
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

/// One changed line of a hunk, its text as the file carries it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub text: String,
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
    for hunk in diff.hunks() {
        let (before, after) = (hunk.before, hunk.after);
        let mut lines = Vec::with_capacity(before.len() + after.len());
        for index in old_lines.get(before.start as usize..before.end as usize).unwrap_or(&[]) {
            lines.push(DiffLine {
                kind: DiffLineKind::Deleted,
                text: (*index).to_owned(),
            });
        }
        for index in new_lines.get(after.start as usize..after.end as usize).unwrap_or(&[]) {
            lines.push(DiffLine {
                kind: DiffLineKind::Added,
                text: (*index).to_owned(),
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
                    text: "const a = 1;".into()
                },
                DiffLine {
                    kind: DiffLineKind::Added,
                    text: "const a = 10;".into()
                },
            ]
        );
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
