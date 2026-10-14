//! Replace All: the rewrite pass with exactly the search's per-line semantics - `^`/`$`
//! anchor at every line, a pattern containing a newline never matches, and each line's
//! terminator (a kept `\r`, the `\n`) survives untouched.

use std::fs;
use std::path::Path;

use regex::bytes::Regex;
use serde::Serialize;

use rayon::prelude::*;

use crate::scan::{build_matcher, encode_searchable, read_searchable};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOutcome {
    pub files: usize,
    pub replacements: usize,
    pub failed: usize,
}

/// Replace `matcher`'s matches line by line - the semantics `scan_text` searches with, so a
/// Replace All rewrites exactly the set the results listed: `^`/`$` anchor at every line, a
/// pattern containing a newline never matches, and each line's terminator (a kept `\r`, the
/// `\n`) survives untouched.
fn replace_per_line(bytes: &[u8], matcher: &Regex, replacement: &str) -> (Vec<u8>, usize) {
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

/// The rewrite over a file list: every file the matcher touches is rewritten whole, in its
/// own encoding; a failed write is counted rather than silently dropped.
pub fn replace_root(
    files: Vec<String>,
    root: &str,
    query: &str,
    replacement: &str,
    is_regex: bool,
    case_sensitive: bool,
    word_only: bool,
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
            let (replaced, count) = replace_per_line(&text, &matcher, replacement);
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
            replace_root(ggs_fs::walk_files(&root), &root, "^foo", "X", true, false, false)
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
        let outcome =
            replace_root(ggs_fs::walk_files(&root), &root, "a\nb", "x", false, false, false)
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
            replace_root(ggs_fs::walk_files(&root), &root, "", "x", false, false, false)
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
            replace_root(ggs_fs::walk_files(&root), &root, "bar", "qux", false, false, false)
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
}
