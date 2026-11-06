//! Replace All: the rewrite pass with exactly the search's per-line semantics - `^`/`$`
//! anchor at every line, a pattern containing a newline never matches, and each line's
//! terminator (a kept `\r`, the `\n`) survives untouched.

use std::fs;
use std::path::Path;

use regex::bytes::Regex;
use serde::Serialize;

use rayon::prelude::*;

use crate::scan::{build_matcher, encode_searchable, read_searchable, SearchMatch};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOutcome {
    pub files: usize,
    pub replacements: usize,
    pub failed: usize,
}

/// One per-result replace's answer: the replaced line's remaining matches, recomputed —
/// the view updates its row locally instead of re-running the whole search.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOneOutcome {
    pub matches: Vec<SearchMatch>,
}

/// Derive a replacement's casing from the match it replaces — the Workspace Search
/// Preserve Case toggle's mapping (VS Code's `preserveCaseReplace`): an all-lowercase
/// match lowers the replacement, an ALL-UPPERCASE one raises it, a Title-case one
/// capitalizes the replacement's first letter and lowers the rest. A match with no
/// cased characters at all (CJK, digits, symbols) and a mixed-case match leave the
/// replacement exactly as typed — there is no shape worth copying.
pub fn apply_preserved_case(matched: &str, replacement: &str) -> String {
    if !matched.chars().any(|c| c.is_uppercase() || c.is_lowercase()) {
        return replacement.to_owned();
    }
    if matched.chars().all(|c| !c.is_uppercase()) {
        return replacement.to_lowercase();
    }
    if matched.chars().all(|c| !c.is_lowercase()) {
        return replacement.to_uppercase();
    }
    let mut chars = matched.chars();
    let title = chars
        .next()
        .is_some_and(|first| first.is_uppercase())
        && chars.all(|rest| !rest.is_uppercase());
    if title {
        let lowered = replacement.to_lowercase();
        let mut rest = lowered.chars();
        match rest.next() {
            Some(first) => first.to_uppercase().collect::<String>() + rest.as_str(),
            None => lowered,
        }
    } else {
        replacement.to_owned()
    }
}

/// Replace `matcher`'s matches line by line - the semantics `scan_text` searches with, so a
/// Replace All rewrites exactly the set the results listed: `^`/`$` anchor at every line, a
/// pattern containing a newline never matches, and each line's terminator (a kept `\r`, the
/// `\n`) survives untouched. With `preserve_case`, every replacement's casing derives from
/// its own match.
fn replace_per_line(bytes: &[u8], matcher: &Regex, replacement: &str, preserve_case: bool) -> (Vec<u8>, usize) {
    let mut out = Vec::with_capacity(bytes.len());
    let mut count = 0usize;
    let mut start = 0usize;
    loop {
        let end = match bytes[start..].iter().position(|&b| b == b'\n') {
            Some(p) => start + p,
            None => bytes.len(),
        };
        let mut line_end = end;
        if line_end > start && bytes[line_end - 1] == b'\r' {
            line_end -= 1;
        }
        let replaced =
            matcher.replace_all(&bytes[start..line_end], |caps: &regex::bytes::Captures| {
                count += 1;
                let mut expanded = Vec::new();
                caps.expand(replacement.as_bytes(), &mut expanded);
                if preserve_case {
                    let matched = String::from_utf8_lossy(&caps[0]).into_owned();
                    let expanded = String::from_utf8_lossy(&expanded).into_owned();
                    return apply_preserved_case(&matched, &expanded).into_bytes();
                }
                expanded
            });
        out.extend_from_slice(&replaced);
        out.extend_from_slice(&bytes[line_end..end]);
        if end == bytes.len() {
            return (out, count);
        }
        out.push(b'\n');
        start = end + 1;
    }
}

/// One line's matches, recomputed over the (possibly rewritten) line bytes — the same
/// columns/lengths convention `scan_text` reports, so a replaced row updates locally.
fn line_matches(bytes: &[u8], matcher: &Regex, line_no: usize) -> Vec<SearchMatch> {
    let text = String::from_utf8_lossy(bytes).into_owned();
    let mut out = Vec::new();
    for caps in matcher.captures_iter(bytes) {
        let Some(whole) = caps.get(0) else { continue };
        let column = text
            .char_indices()
            .take_while(|(i, _)| *i < whole.start())
            .count()
            + 1;
        let length = String::from_utf8_lossy(&bytes[whole.start()..whole.end()])
            .chars()
            .count();
        out.push(SearchMatch {
            line: line_no,
            column,
            length,
            text: text.clone(),
        });
    }
    out
}

/// Replace exactly one match — the search result's own file, line and character column.
/// The line is re-matched with the search's own matcher, the occurrence sitting at
/// `column` is replaced (capture expansion included), the file is written back in its own
/// encoding, and the line's remaining matches are recomputed for the row's local update.
/// A match that has changed on disk since the search ran is an error, never a silent
/// wrong-place rewrite.
#[allow(clippy::too_many_arguments)]
pub fn replace_one_in_file(
    path: &Path,
    line_no: usize,
    column: usize,
    query: &str,
    replacement: &str,
    is_regex: bool,
    case_sensitive: bool,
    word_only: bool,
    preserve_case: bool,
) -> Result<ReplaceOneOutcome, String> {
    if query.is_empty() {
        return Err("an empty query replaces nothing".into());
    }
    let matcher = build_matcher(query, is_regex, case_sensitive, word_only)?;
    let Some((text, encoding)) = read_searchable(path) else {
        return Err(format!(
            "{}: the file is not searchable (binary, unreadable, or too large)",
            path.display()
        ));
    };
    let mut start = 0usize;
    let mut current_line = 0usize;
    loop {
        current_line += 1;
        let end = match text[start..].iter().position(|&b| b == b'\n') {
            Some(p) => start + p,
            None => text.len(),
        };
        let mut line_end = end;
        if line_end > start && text[line_end - 1] == b'\r' {
            line_end -= 1;
        }
        if current_line == line_no {
            let line = &text[start..line_end];
            let line_text = String::from_utf8_lossy(line).into_owned();
            for caps in matcher.captures_iter(line) {
                let Some(whole) = caps.get(0) else { continue };
                let hit_column = line_text
                    .char_indices()
                    .take_while(|(i, _)| *i < whole.start())
                    .count()
                    + 1;
                if hit_column != column {
                    continue;
                }
                let matched = String::from_utf8_lossy(&line[whole.start()..whole.end()]).into_owned();
                let mut expanded = Vec::new();
                caps.expand(replacement.as_bytes(), &mut expanded);
                let expanded = String::from_utf8_lossy(&expanded).into_owned();
                let done = if preserve_case {
                    apply_preserved_case(&matched, &expanded)
                } else {
                    expanded
                };
                let mut new_line =
                    Vec::with_capacity(line.len() - (whole.end() - whole.start()) + done.len());
                new_line.extend_from_slice(&line[..whole.start()]);
                new_line.extend_from_slice(done.as_bytes());
                new_line.extend_from_slice(&line[whole.end()..]);
                let remaining = line_matches(&new_line, &matcher, line_no);
                let mut bytes = Vec::with_capacity(text.len() - line.len() + new_line.len());
                bytes.extend_from_slice(&text[..start]);
                bytes.extend_from_slice(&new_line);
                bytes.extend_from_slice(&text[line_end..]);
                fs::write(path, encode_searchable(bytes, encoding))
                    .map_err(|e| format!("{}: {e}", path.display()))?;
                return Ok(ReplaceOneOutcome { matches: remaining });
            }
            return Err(format!(
                "the match at line {line_no}, column {column} is no longer on disk — run the search again"
            ));
        }
        if end == text.len() {
            break;
        }
        start = end + 1;
    }
    Err(format!(
        "the match at line {line_no} is no longer on disk — run the search again"
    ))
}

/// The rewrite over a file list: every file the matcher touches is rewritten whole, in its
/// own encoding; a failed write is counted rather than silently dropped.
#[allow(clippy::too_many_arguments)]
pub fn replace_root(
    files: Vec<String>,
    root: &str,
    query: &str,
    replacement: &str,
    is_regex: bool,
    case_sensitive: bool,
    word_only: bool,
    preserve_case: bool,
) -> Result<ReplaceOutcome, String> {
    // An empty query would match the empty string at every byte position; like the search,
    // it is a no-op.
    if query.is_empty() {
        return Ok(ReplaceOutcome {
            files: 0,
            replacements: 0,
            failed: 0,
        });
    }
    let matcher = build_matcher(query, is_regex, case_sensitive, word_only)?;
    let results: Vec<Option<(usize, bool)>> = files
        .into_par_iter()
        .map(|relative| {
            let path = Path::new(root).join(&relative);
            let (text, encoding) = read_searchable(&path)?;
            let (replaced, count) = replace_per_line(&text, &matcher, replacement, preserve_case);
            // Report a failed write instead of discarding the count, which would make the
            // replace look like it never matched anything.
            let failed =
                count > 0 && fs::write(&path, encode_searchable(replaced, encoding)).is_err();
            Some((count, failed))
        })
        .collect();
    let replacements: usize = results.iter().flatten().map(|(c, _)| *c).sum();
    let files = results.iter().flatten().filter(|(c, _)| *c > 0).count();
    let failed = results.iter().flatten().filter(|(_, f)| *f).count();
    Ok(ReplaceOutcome {
        files,
        replacements,
        failed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_rewrites_files_and_counts() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x y x\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "z\n").unwrap();
        let root = dir.path().display().to_string();
        let outcome = replace_root(
            crate::scan::filter_paths(ggs_fs::walk_files(&root), "", ""),
            &root,
            "x",
            "w",
            false,
            false,
            false,
            false,
        )
        .unwrap();
        assert_eq!((outcome.files, outcome.replacements), (1, 2));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "w y w\n"
        );
    }

    #[test]
    fn replace_counts_unwritable_files_instead_of_dropping_them() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x y\n").unwrap();
        let locked = dir.path().join("b.txt");
        std::fs::write(&locked, "x z\n").unwrap();
        let mut perms = std::fs::metadata(&locked).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&locked, perms).unwrap();
        let root = dir.path().display().to_string();

        let outcome = replace_root(
            crate::scan::filter_paths(ggs_fs::walk_files(&root), "", ""),
            &root,
            "x",
            "w",
            false,
            false,
            false,
            false,
        )
        .unwrap();
        // The writable file is replaced normally; the locked one is reported, not silently
        // dropped from the counts.
        assert_eq!(
            (outcome.files, outcome.replacements, outcome.failed),
            (2, 2, 1)
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "w y\n"
        );

        // Clearing the read-only bit so the temp dir can be removed (clippy warns that on Unix
        // this alone does not make a file world-writable; here it only undoes the line above).
        #[allow(clippy::permissions_set_readonly_false)]
        {
            let mut perms = std::fs::metadata(&locked).unwrap().permissions();
            perms.set_readonly(false);
            std::fs::set_permissions(&locked, perms).unwrap();
        }
    }

    #[test]
    fn replace_uses_the_searchs_per_line_semantics() {
        // `^` anchors at a line start for the per-line search, so Replace All must rewrite
        // every line the search listed - not just the first line of the file.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "foo one\nbar\nfoo two\n").unwrap();
        let root = dir.path().display().to_string();
        let outcome =
            replace_root(ggs_fs::walk_files(&root), &root, "^foo", "X", true, false, false, false)
                .unwrap();
        assert_eq!(outcome.replacements, 2);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "X one\nbar\nX two\n"
        );
    }

    #[test]
    fn replace_never_matches_across_lines_like_the_search() {
        // A pattern containing a newline can never match the per-line search, so Replace All
        // must not rewrite text the results never listed.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "a\nb\n").unwrap();
        let root = dir.path().display().to_string();
        let outcome = replace_root(
            ggs_fs::walk_files(&root),
            &root,
            "a\nb",
            "x",
            false,
            false,
            false,
            false,
        )
        .unwrap();
        assert_eq!(outcome.replacements, 0);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "a\nb\n");
    }

    #[test]
    fn an_empty_replace_query_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "hello\n").unwrap();
        let root = dir.path().display().to_string();
        let outcome =
            replace_root(ggs_fs::walk_files(&root), &root, "", "x", false, false, false, false)
                .unwrap();
        assert_eq!(
            (outcome.files, outcome.replacements, outcome.failed),
            (0, 0, 0)
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello\n");
    }

    #[test]
    fn utf16_files_with_a_bom_are_replaced_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "foo bar\nbaz\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let file = dir.path().join("u.txt");
        std::fs::write(&file, &bytes).unwrap();
        let root = dir.path().display().to_string();
        let outcome =
            replace_root(ggs_fs::walk_files(&root), &root, "bar", "qux", false, false, false, false)
                .unwrap();
        assert_eq!(outcome.replacements, 1);
        // A replace writes the file back as UTF-16, not as re-encoded UTF-8.
        let written = std::fs::read(&file).unwrap();
        let decoded = ggs_text::encoding::decode(&written, None);
        assert_eq!(
            (decoded.text.as_str(), decoded.encoding),
            ("foo qux\nbaz\n", "utf-16le")
        );
    }

    #[test]
    fn preserved_case_derives_each_replacement_from_its_match() {
        // All-lower, ALL-UPPER and Title shapes copy themselves onto the replacement;
        // a mixed-case match and a match with no cased characters leave it as typed.
        assert_eq!(apply_preserved_case("foo", "Bar"), "bar");
        assert_eq!(apply_preserved_case("FOO", "Bar"), "BAR");
        assert_eq!(apply_preserved_case("Foo", "bar"), "Bar");
        assert_eq!(apply_preserved_case("Foo", "BAR"), "Bar");
        assert_eq!(apply_preserved_case("fOo", "qux"), "qux");
        assert_eq!(apply_preserved_case("变量123", "abc"), "abc");
        assert_eq!(apply_preserved_case("ÄÖU", "neu"), "NEU");
        assert_eq!(apply_preserved_case("Äu", "NEU"), "Neu");
        // An empty replacement stays empty whatever casing the match wears.
        assert_eq!(apply_preserved_case("FOO", ""), "");
    }

    #[test]
    fn replace_all_with_preserve_case_rewrites_each_match_by_its_own_shape() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "Foo value\nFOO value\nfoo value\nmixed Foo\n").unwrap();
        let root = dir.path().display().to_string();
        let outcome = replace_root(
            ggs_fs::walk_files(&root),
            &root,
            "foo",
            "bar",
            false,
            false,
            false,
            true,
        )
        .unwrap();
        assert_eq!(outcome.replacements, 4);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "Bar value\nBAR value\nbar value\nmixed Bar\n"
        );
    }

    #[test]
    fn replace_one_replaces_exactly_the_listed_occurrence() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "one two one\nthree one\n").unwrap();
        // The line's second `one` (column 9): only that occurrence goes.
        let outcome = replace_one_in_file(&file, 1, 9, "one", "X", false, false, false, false)
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "one two X\nthree one\n"
        );
        // The line's remaining matches come back recomputed, for the row's local update.
        assert_eq!(outcome.matches.len(), 1);
        assert_eq!(outcome.matches[0].column, 1);
        assert_eq!(outcome.matches[0].text, "one two X");

        // A second replace on the same line clears it entirely: no matches left.
        let outcome = replace_one_in_file(&file, 1, 1, "one", "Y", false, false, false, false)
            .unwrap();
        assert!(outcome.matches.is_empty());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "Y two X\nthree one\n");

        // The other line's occurrence still answers, at its own line.
        let outcome = replace_one_in_file(&file, 2, 7, "one", "Z", false, false, false, false)
            .unwrap();
        assert!(outcome.matches.is_empty());
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "Y two X\nthree Z\n"
        );
    }

    #[test]
    fn replace_one_keeps_terminators_and_refuses_a_changed_disk() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("crlf.txt");
        std::fs::write(&file, "alpha beta\r\nbeta\r\n").unwrap();
        let outcome =
            replace_one_in_file(&file, 1, 7, "beta", "B", false, false, false, false).unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "alpha B\r\nbeta\r\n",
            "the CRLF terminator survives the splice"
        );
        // The replaced line holds no `beta` any more — the other line's match is not this
        // line's remaining, so the row's update is an empty list.
        assert!(outcome.matches.is_empty());

        // The match changed on disk since the search listed it: refused, never a wrong-place
        // rewrite; an empty query and a past-the-end line refuse the same way.
        std::fs::write(&file, "gamma\n").unwrap();
        let err = replace_one_in_file(&file, 1, 7, "beta", "B", false, false, false, false)
            .unwrap_err();
        assert!(err.contains("no longer on disk"), "{err}");
        let err = replace_one_in_file(&file, 9, 1, "gamma", "G", false, false, false, false)
            .unwrap_err();
        assert!(err.contains("no longer on disk"), "{err}");
        let err = replace_one_in_file(&file, 1, 1, "", "G", false, false, false, false).unwrap_err();
        assert!(err.contains("empty query"), "{err}");
    }

    #[test]
    fn replace_one_expands_captures_and_preserves_case() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "value: Foo\n").unwrap();
        // The regex match STARTS at column 1 (`value: …` is the whole match).
        let outcome = replace_one_in_file(&file, 1, 1, r"value: (\w+)", "<$1>", true, false, false, false)
            .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "<Foo>\n");
        assert!(outcome.matches.is_empty());

        // Preserve Case derives the spliced replacement from the match's own shape; the
        // literal `foo` sits at column 8.
        std::fs::write(&file, "value: FOO\nvalue: foo\n").unwrap();
        replace_one_in_file(&file, 1, 8, "foo", "bar", false, false, false, true).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "value: BAR\nvalue: foo\n");
        replace_one_in_file(&file, 2, 8, "foo", "bar", false, false, false, true).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "value: BAR\nvalue: bar\n");
    }

    #[test]
    fn replace_one_writes_utf16_back_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "first second\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let file = dir.path().join("u.txt");
        std::fs::write(&file, &bytes).unwrap();
        replace_one_in_file(&file, 1, 7, "second", "2nd", false, false, false, false).unwrap();
        let written = std::fs::read(&file).unwrap();
        let decoded = ggs_text::encoding::decode(&written, None);
        assert_eq!(
            (decoded.text.as_str(), decoded.encoding),
            ("first 2nd\n", "utf-16le")
        );
    }
}
