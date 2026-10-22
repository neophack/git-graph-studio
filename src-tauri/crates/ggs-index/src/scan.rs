//! The shared vocabulary every scan speaks: the glob filter over the walked file list
//! (the Search view's include / exclude fields), the matcher builder (literal, regex,
//! case, whole-word — one wrapping rule), the searchable-file read (binary sniff, BOM
//! decode), the per-line matcher, and the symbol-source extension table.

use std::path::Path;

use regex::bytes::Regex;

use serde::Serialize;

/// Files up to this size are read whole for the text search; larger ones are streamed line by
/// line (`scan_stream`) instead of skipped, so a multi-gigabyte `.asc` trace is searchable too.
/// (Replace still rewrites whole files and keeps the whole-read limit.)
pub(crate) const MAX_TEXT_FILE: u64 = 2 * 1024 * 1024;

/// One match of the query: 1-based line, 1-based character column, character length, and
/// the line's own text (the results list and the replace preview render it).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line: usize,
    pub column: usize,
    pub length: usize,
    pub text: String,
}

/// One file's matches, the shape every result list (the Search view, Find References, the
/// MCP scans) renders.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: String,
    pub matches: Vec<SearchMatch>,
}

/* ---------- Globs (the Search view's include / exclude fields) ---------- */

/// A glob matcher over the `*` / `?` / `**` vocabulary VS Code's search uses (`**/*.rs`,
/// `src/*`, …), matched against the repo-relative, forward-slashed path. A pattern without a
/// separator (`*.rs`) is matched against the file name anywhere in the tree, as VS Code's
/// search does.
pub fn glob_match(pattern: &str, path: &str) -> bool {
    fn m(p: &[char], s: &[char]) -> bool {
        if p.is_empty() {
            return s.is_empty();
        }
        match p[0] {
            '*' => {
                let mut rest = 1;
                while rest < p.len() && p[rest] == '*' {
                    rest += 1;
                }
                let double = rest > 1;
                // `**/` also matches zero folders, so `**/*.rs` hits `a.rs` as well as `s/a.rs`.
                if double && rest < p.len() && p[rest] == '/' {
                    if m(&p[rest + 1..], s) {
                        return true;
                    }
                    return (0..s.len()).any(|k| s[k] == '/' && m(&p[rest + 1..], &s[k + 1..]));
                }
                let tail = &p[rest..];
                for skip in 0..=s.len() {
                    if m(tail, &s[skip..]) {
                        return true;
                    }
                    if !double && skip < s.len() && s[skip] == '/' {
                        return false; // a single `*` never crosses a separator
                    }
                }
                false
            }
            '?' => !s.is_empty() && s[0] != '/' && m(&p[1..], &s[1..]),
            c => !s.is_empty() && s[0] == c && m(&p[1..], &s[1..]),
        }
    }
    let pattern: Vec<char> = pattern.chars().collect();
    let path: Vec<char> = path.chars().collect();
    if !pattern.contains(&'/') {
        let name: Vec<char> = path
            .iter()
            .copied()
            .rev()
            .take_while(|c| *c != '/')
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return m(&pattern, &name);
    }
    m(&pattern, &path)
}

/// The include/exclude fields: comma-separated globs matched against the repo-relative path
/// (a bare `*.rs` matches anywhere, like VS Code's search). Patterns keep their spaces -
/// `my docs/**` is one pattern.
pub fn filter_paths(files: Vec<String>, include: &str, exclude: &str) -> Vec<String> {
    let selects = selector(include, exclude);
    files.into_iter().filter(|file| selects(file)).collect()
}

/// [`filter_paths`] over a borrowed list (the shared cached walk): only the selected
/// paths are copied out.
pub fn select_paths(files: &[String], include: &str, exclude: &str) -> Vec<String> {
    let selects = selector(include, exclude);
    files.iter().filter(|file| selects(file)).cloned().collect()
}

fn selector(include: &str, exclude: &str) -> impl Fn(&str) -> bool {
    let split = |s: &str| -> Vec<String> {
        s.split(',')
            .map(|part| part.trim().to_owned())
            .filter(|p| !p.is_empty())
            .collect()
    };
    let includes = split(include);
    let excludes = split(exclude);
    move |file: &str| {
        (includes.is_empty() || includes.iter().any(|p| pattern_selects(p, file)))
            && !excludes.iter().any(|p| pattern_selects(p, file))
    }
}

/// Does `pattern` select `file`? Besides the file's own path, a pattern matching any
/// directory above the file selects the whole subtree, as VS Code's search (and gitignore)
/// treat a bare directory name: excluding `vendor` or `src/generated` prunes everything
/// under it.
fn pattern_selects(pattern: &str, file: &str) -> bool {
    if glob_match(pattern, file) {
        return true;
    }
    file.match_indices('/')
        .any(|(at, _)| glob_match(pattern, &file[..at]))
}

/* ---------- The matcher ---------- */

/// Wrap a query body in the whole-word boundaries, VS Code / CodeMirror style: a `\b` only
/// where the query's own edge character is a word character, so a query with non-word edges
/// (`->`, `(int)`) keeps no boundary to demand there and still matches `a -> b`.
fn whole_word_wrap(query: &str, body: &str) -> String {
    let word_edge = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    let start = if word_edge(query.chars().next()) {
        r"\b"
    } else {
        ""
    };
    let end = if word_edge(query.chars().next_back()) {
        r"\b"
    } else {
        ""
    };
    format!("{start}(?:{body}){end}")
}

/// The matcher behind every text query (the search, the replace, the reference scans):
/// a literal or regex body, optional case folding, optional whole-word boundaries.
pub fn build_matcher(
    query: &str,
    is_regex: bool,
    case_sensitive: bool,
    word_only: bool,
) -> Result<Regex, String> {
    let body = if is_regex {
        query.to_owned()
    } else {
        regex::escape(query)
    };
    // The edge-character rule looks at the raw query, for a regex the same as for a literal.
    let body = if word_only {
        whole_word_wrap(query, &body)
    } else {
        body
    };
    let pattern = if case_sensitive {
        body
    } else {
        format!("(?i){body}")
    };
    Regex::new(&pattern).map_err(|e| format!("Invalid pattern: {e}"))
}

/* ---------- Reading a searchable file ---------- */

/// Read a file as bytes for the search: `None` for binary files (the shared
/// [`ggs_text::encoding::looks_binary`] rule, so a BOM-marked UTF-16 file is not mistaken for
/// one), oversized files, and read errors (a vanished file is simply not searchable). A
/// UTF-16 file arrives decoded to UTF-8 with its encoding id remembered, so its matches are
/// found at all and a replace can write it back the way it was; anything else stays the raw
/// bytes, which are never decoded wholesale - only matched lines are.
pub fn read_searchable(path: &Path) -> Option<(Vec<u8>, &'static str)> {
    if std::fs::metadata(path).map(|m| m.len()).unwrap_or(u64::MAX) > MAX_TEXT_FILE {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if ggs_text::encoding::looks_binary(&bytes) {
        return None;
    }
    if let Some((encoding, bom_len)) = encoding_rs::Encoding::for_bom(&bytes) {
        let id = if encoding == encoding_rs::UTF_16LE {
            "utf-16le"
        } else if encoding == encoding_rs::UTF_16BE {
            "utf-16be"
        } else {
            ""
        };
        if !id.is_empty() {
            let (text, had_errors) = encoding.decode_without_bom_handling(&bytes[bom_len..]);
            // Malformed UTF-16 cannot round-trip a replace; such a file stays unsearchable.
            return (!had_errors).then(|| (text.into_owned().into_bytes(), id));
        }
    }
    Some((bytes, "utf8"))
}

/// The write half of [`read_searchable`]: bytes decoded from a BOM-marked UTF-16 file go
/// back out in the same encoding; anything else is written as the raw bytes it was.
pub(crate) fn encode_searchable(text: Vec<u8>, encoding: &str) -> Vec<u8> {
    match encoding {
        "utf-16le" | "utf-16be" => {
            ggs_text::encoding::encode(&String::from_utf8_lossy(&text), encoding, "lf")
        }
        _ => text,
    }
}

/* ---------- The per-line matcher ---------- */

/// Scan raw bytes, decoding only the lines that have at least one hit. Columns and lengths are
/// character counts, so byte offsets are mapped through the decoded line.
pub fn scan_text(bytes: &[u8], matcher: &Regex) -> Vec<SearchMatch> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut line_no = 0usize;
    loop {
        line_no += 1;
        let end = match bytes[start..].iter().position(|&b| b == b'\n') {
            Some(p) => start + p,
            None => bytes.len(),
        };
        let mut line_end = end;
        if line_end > start && bytes[line_end - 1] == b'\r' {
            line_end -= 1;
        }
        let line = &bytes[start..line_end];
        let mut text: Option<String> = None;
        for hit in matcher.find_iter(line) {
            let text = text.get_or_insert_with(|| String::from_utf8_lossy(line).into_owned());
            let column = text
                .char_indices()
                .take_while(|(i, _)| *i < hit.start())
                .count()
                + 1;
            let length = String::from_utf8_lossy(&line[hit.start()..hit.end()])
                .chars()
                .count();
            out.push(SearchMatch {
                line: line_no,
                column,
                length,
                text: text.clone(),
            });
        }
        if end == bytes.len() {
            return out;
        }
        start = end + 1;
    }
}

/* ---------- The symbol-source table ---------- */

/// The extensions the outline extractor can parse; everything else is skipped.
pub const SYMBOL_EXTENSIONS: &[&str] = &[
    "rs", "py", "go", "ts", "tsx", "js", "jsx", "java", "c", "h", "cpp", "hpp", "cs",
];

/// Whether a repo-relative path is one the symbol index reads (by extension).
pub fn is_symbol_source(path: &str) -> bool {
    match path.rsplit_once('.') {
        Some((_, ext)) => SYMBOL_EXTENSIONS.contains(&ext),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globs_match_paths_like_vs_code_search() {
        assert!(glob_match("**/*.rs", "main.rs"));
        assert!(glob_match("**/*.rs", "src/lib.rs"));
        assert!(!glob_match("**/*.rs", "src/lib.ts"));
        assert!(glob_match("src/*", "src/a.rs"));
        assert!(!glob_match("src/*", "src/sub/a.rs"));
        assert!(glob_match("src/**", "src/sub/a.rs"));
        assert!(glob_match("*.ts", "app/main.ts"));
        assert!(glob_match("a?c.txt", "abc.txt"));
    }

    #[test]
    fn filter_paths_applies_include_and_exclude() {
        let files = vec!["a.rs".to_owned(), "src/b.rs".to_owned(), "c.ts".to_owned()];
        assert_eq!(
            filter_paths(files.clone(), "*.rs", ""),
            ["a.rs", "src/b.rs"]
        );
        assert_eq!(filter_paths(files.clone(), "", "src/*"), ["a.rs", "c.ts"]);
        assert_eq!(filter_paths(files, "**/*.rs", "src/**"), ["a.rs"]);
    }

    #[test]
    fn scan_text_reports_line_column_and_length_in_characters() {
        let matcher = Regex::new("fn").unwrap();
        let hits = scan_text("alpha fn beta\nfn gamma\n".as_bytes(), &matcher);
        assert_eq!(hits.len(), 2);
        assert_eq!((hits[0].line, hits[0].column, hits[0].length), (1, 7, 2));
        assert_eq!((hits[1].line, hits[1].column), (2, 1));
        assert_eq!(hits[0].text, "alpha fn beta");
    }

    #[test]
    fn whole_word_demands_boundaries_only_at_word_character_edges() {
        let word = |query: &str| build_matcher(query, false, true, true).unwrap();
        // Word-character edges keep their boundaries.
        assert_eq!(
            scan_text("a foo b afoo foob\n".as_bytes(), &word("foo")).len(),
            1
        );
        // A non-word edge has no boundary to demand: `->` matches spaced too, and `(int)`
        // matches at a line start.
        assert_eq!(scan_text("a -> b\n".as_bytes(), &word("->")).len(), 1);
        assert_eq!(scan_text("(int) x\n".as_bytes(), &word("(int)")).len(), 1);
        // The same edge rule applies to the raw text of a regex query.
        let regex = build_matcher(r"\(int\)", true, true, true).unwrap();
        assert_eq!(scan_text("(int) x\n".as_bytes(), &regex).len(), 1);
    }

    #[test]
    fn binary_files_stay_invisible_to_the_search() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("b.bin"), b"foo\0bar\n").unwrap();
        assert!(read_searchable(&dir.path().join("b.bin")).is_none());
    }

    #[test]
    fn a_pattern_also_matches_directories_pruning_their_subtrees() {
        let files = vec![
            "src/a.rs".to_owned(),
            "vendor/lib.js".to_owned(),
            "src/generated/g.rs".to_owned(),
            "vendorized/x.js".to_owned(),
        ];
        // A bare name prunes a directory at any depth; a path prefix prunes its subtree.
        assert_eq!(
            filter_paths(files.clone(), "", "vendor"),
            ["src/a.rs", "src/generated/g.rs", "vendorized/x.js"]
        );
        assert_eq!(
            filter_paths(files.clone(), "", "src/generated"),
            ["src/a.rs", "vendor/lib.js", "vendorized/x.js"]
        );
        // As an include, a directory name selects its subtree.
        assert_eq!(filter_paths(files, "vendor", ""), ["vendor/lib.js"]);
    }

    #[test]
    fn include_patterns_split_on_commas_only_keeping_spaces() {
        let files = vec!["my docs/a.txt".to_owned(), "src/b.txt".to_owned()];
        assert_eq!(filter_paths(files, "my docs/**", ""), ["my docs/a.txt"]);
        let files = vec!["a.rs".to_owned(), "b.txt".to_owned()];
        assert_eq!(filter_paths(files, "*.rs, *.txt", ""), ["a.rs", "b.txt"]);
    }
}
