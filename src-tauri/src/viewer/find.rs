//! Whole-file find and replace over a viewer document's rope: one query model (literal or
//! regex, case and word options) shared by `viewer_find` and `viewer_replace`. Matches are
//! single-line — the unit the windowed surfaces navigate by — with columns in code points,
//! the document's own addressing unit.

use std::borrow::Cow;

use serde::Serialize;

use ropey::Rope;

/// The most matches `viewer_find` reports (and `viewer_replace` applies in one call). A
/// query with more matches is reported `capped`; the widget shows the cap and navigates
/// within the reported list.
pub const MAX_FIND_MATCHES: usize = 50_000;

/// A cancellation point runs this often, so a superseded scan of a huge file stops soon
/// after its replacement starts rather than after the whole file.
const CANCEL_CHECK_LINES: usize = 512;

/// One single-line match: the 0-based line and `[start, end)` code-point columns.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatchLoc {
    pub line: usize,
    pub start_col: usize,
    pub end_col: usize,
}

/// The query options the find widget's toggles produce.
#[derive(Debug, Clone, Copy, Default)]
pub struct FindOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regexp: bool,
}

/// The compiled form of a find query.
#[derive(Debug)]
pub enum Matcher {
    Literal {
        needle: Vec<char>,
        case_sensitive: bool,
    },
    Regex(fancy_regex::Regex),
}

impl Matcher {
    pub fn compile(search: &str, options: &FindOptions) -> Result<Matcher, String> {
        if options.regexp {
            // Case-insensitivity rides as an inline group prefix — the toggle means the
            // same for regex queries as it does for literal ones (VS Code does the same).
            let pattern = if options.case_sensitive {
                search.to_owned()
            } else {
                format!("(?i){search}")
            };
            let regex = fancy_regex::Regex::new(&pattern)
                .map_err(|e| format!("Invalid regular expression: {e}"))?;
            Ok(Matcher::Regex(regex))
        } else {
            Ok(Matcher::Literal {
                needle: search.chars().collect(),
                case_sensitive: options.case_sensitive,
            })
        }
    }

    /// The matches on one line's text (its newline already stripped) as `[start, end)`
    /// code-point ranges. An empty query and empty matches never match; matches never
    /// overlap.
    pub fn matches_in(&self, text: &str, whole_word: bool) -> Vec<(usize, usize)> {
        match self {
            // The literal scan walks chars so case-insensitive matching stays correct on
            // text whose lowered form changes length (İ, ß…), where byte offsets into a
            // lowered copy would not map back to the original.
            Matcher::Literal {
                needle,
                case_sensitive,
            } => {
                let mut out = Vec::new();
                if needle.is_empty() {
                    return out;
                }
                let chars: Vec<char> = text.chars().collect();
                let lowered: Vec<char> = needle.iter().map(|c| lower_char(*c)).collect();
                let mut at = 0usize;
                while at + needle.len() <= chars.len() {
                    let hit = if *case_sensitive {
                        chars[at..at + needle.len()] == needle[..]
                    } else {
                        chars[at..at + needle.len()]
                            .iter()
                            .map(|c| lower_char(*c))
                            .eq(lowered.iter().copied())
                    };
                    if hit {
                        let end = at + needle.len();
                        if !whole_word
                            || whole_at(
                                chars.get(at.wrapping_sub(1)).copied(),
                                chars.get(end).copied(),
                            )
                        {
                            out.push((at, end));
                            at = end;
                        } else {
                            at += 1;
                        }
                    } else {
                        at += 1;
                    }
                }
                out
            }
            // The regex core lives in `hits_in`; the find path just drops the expansions.
            Matcher::Regex(_) => self
                .hits_in(text, whole_word, "")
                .into_iter()
                .map(|(range, _)| range)
                .collect(),
        }
    }

    /// The matches on one line with the replacement each would insert. `$1`-style group
    /// references expand for regex queries; a literal query inserts the replacement
    /// verbatim (VS Code does not expand references without a regex either).
    pub fn hits_in(
        &self,
        text: &str,
        whole_word: bool,
        replacement: &str,
    ) -> Vec<((usize, usize), String)> {
        match self {
            Matcher::Literal { .. } => self
                .matches_in(text, whole_word)
                .into_iter()
                .map(|range| (range, replacement.to_owned()))
                .collect(),
            Matcher::Regex(regex) => regex
                .captures_iter(text)
                .filter_map(|caps| caps.ok())
                .filter_map(|caps| {
                    let whole = caps.get(0).expect("group 0 always participates");
                    if whole.as_str().is_empty() {
                        return None;
                    }
                    if whole_word
                        && !whole_at(
                            text[..whole.start()].chars().next_back(),
                            text[whole.end()..].chars().next(),
                        )
                    {
                        return None;
                    }
                    let mut expanded = String::new();
                    caps.expand(replacement, &mut expanded);
                    Some((
                        (cp_offset(text, whole.start()), cp_offset(text, whole.end())),
                        expanded,
                    ))
                })
                .collect(),
        }
    }
}

/// Scan a rope's lines for the matcher's query, stopping at `cap` matches (the flag says
/// so). `alive` runs every [`CANCEL_CHECK_LINES`] lines and aborts the scan when it turns
/// false — a newer `viewer_find` on the same document has superseded this one.
pub fn scan_rope(
    rope: &Rope,
    matcher: &Matcher,
    whole_word: bool,
    cap: usize,
    mut alive: impl FnMut() -> bool,
) -> Result<(Vec<MatchLoc>, bool), String> {
    let mut matches = Vec::new();
    let mut capped = false;
    for (line, chunk) in rope.lines().enumerate() {
        if line % CANCEL_CHECK_LINES == 0 && !alive() {
            return Err("superseded by a newer find".to_owned());
        }
        // A rope line usually borrows straight from its chunk; one that straddles a chunk
        // boundary is copied (the highlight path does the same per line).
        let text = match chunk.as_str() {
            Some(s) => Cow::Borrowed(s),
            None => Cow::Owned(chunk.to_string()),
        };
        for (start, end) in matcher.matches_in(strip_newline(&text), whole_word) {
            matches.push(MatchLoc {
                line,
                start_col: start,
                end_col: end,
            });
            if matches.len() == cap {
                capped = true;
                return Ok((matches, capped));
            }
        }
    }
    Ok((matches, capped))
}

/// Collect replacement sites from `from_line`/`from_col` (0-based, absolute) onward —
/// on the first line only matches at or after `from_col` count — applying at most `max`.
/// The sites are `(char_start, char_end, replacement)` in document order, absolute rope
/// char offsets, ready for `ViewerDoc::replace_sites`.
pub fn replacement_sites(
    rope: &Rope,
    matcher: &Matcher,
    whole_word: bool,
    replacement: &str,
    from_line: usize,
    from_col: usize,
    max: usize,
) -> Vec<(usize, usize, String)> {
    if max == 0 {
        return Vec::new();
    }
    let mut sites = Vec::new();
    let start_line = from_line.min(rope.len_lines().saturating_sub(1));
    let mut base = rope.line_to_char(start_line);
    for (offset, chunk) in rope.lines_at(start_line).enumerate() {
        let line = start_line + offset;
        let text = match chunk.as_str() {
            Some(s) => Cow::Borrowed(s),
            None => Cow::Owned(chunk.to_string()),
        };
        for ((start, end), expanded) in
            matcher.hits_in(strip_newline(&text), whole_word, replacement)
        {
            if line == start_line && start < from_col {
                continue;
            }
            sites.push((base + start, base + end, expanded));
            if sites.len() == max || sites.len() == MAX_FIND_MATCHES {
                return sites;
            }
        }
        base += chunk.chars().count();
    }
    sites
}

/// A rope line chunk without its trailing newline, in the viewer's line model.
fn strip_newline(chunk: &str) -> &str {
    chunk
        .strip_suffix('\n')
        .map(|t| t.strip_suffix('\r').unwrap_or(t))
        .unwrap_or(chunk)
}

fn lower_char(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// VS Code's word definition for "Match Whole Word": alphanumeric or underscore.
fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Whether a `[start, end)` match sits between non-word chars (or the line's edges).
fn whole_at(before: Option<char>, after: Option<char>) -> bool {
    before.is_none_or(|c| !is_word(c)) && after.is_none_or(|c| !is_word(c))
}

/// A byte offset on a line to its code-point column (regex matches report bytes).
fn cp_offset(text: &str, byte: usize) -> usize {
    text[..byte].chars().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(case: bool, word: bool, regex: bool) -> FindOptions {
        FindOptions {
            case_sensitive: case,
            whole_word: word,
            regexp: regex,
        }
    }

    fn rope(text: &str) -> Rope {
        Rope::from(text)
    }

    fn matches_of(text: &str, search: &str, opts: FindOptions) -> Vec<(usize, usize)> {
        Matcher::compile(search, &opts)
            .unwrap()
            .matches_in(text, opts.whole_word)
    }

    #[test]
    fn literal_matches_respect_case_and_word_options() {
        assert_eq!(
            matches_of("Cat catalog CAT", "cat", options(false, false, false)),
            [(0, 3), (4, 7), (12, 15)]
        );
        assert_eq!(
            matches_of("Cat catalog CAT", "cat", options(true, false, false)),
            [(4, 7)]
        );
        // Whole word: "catalog" is not an occurrence of "cat".
        assert_eq!(
            matches_of("Cat catalog cat.", "cat", options(false, true, false)),
            [(0, 3), (12, 15)]
        );
        // Underscore counts as a word char, like VS Code: "my_cat" is not an occurrence.
        assert_eq!(
            matches_of("my_cat, cat", "cat", options(false, true, false)),
            [(8, 11)]
        );
        // An empty query never matches.
        assert_eq!(matches_of("anything", "", options(false, false, false)), []);
        // Matches do not overlap: "aaaa" holds two "aa"s.
        assert_eq!(
            matches_of("aaaa", "aa", options(false, false, false)),
            [(0, 2), (2, 4)]
        );
    }

    #[test]
    fn regex_matches_report_code_point_columns() {
        let matches = matches_of(
            "const x = \"日本語\";",
            "\".+\"",
            options(false, false, true),
        );
        assert_eq!(
            matches,
            [(10, 15)],
            "columns are code points, not bytes or UTF-16 units"
        );
        // Case and word options apply to regex queries too.
        assert_eq!(
            matches_of("foo FOO", "foo", options(true, false, true)),
            [(0, 3)]
        );
        assert_eq!(
            matches_of("foo foobar", "foo", options(false, true, true)),
            [(0, 3)]
        );
        // Empty regex matches are skipped: "x*" matches everywhere but yields nothing.
        assert_eq!(matches_of("abc", "x*", options(false, false, true)), []);
    }

    #[test]
    fn an_invalid_regex_is_a_user_error() {
        let err = Matcher::compile("([unclosed", &options(false, false, true)).unwrap_err();
        assert!(err.contains("Invalid regular expression"), "{err}");
    }

    #[test]
    fn scan_rope_reports_lines_and_caps() {
        let text = "alpha\nbeta alpha\ngamma\n";
        let matcher = Matcher::compile("alpha", &options(false, false, false)).unwrap();
        let (matches, capped) =
            scan_rope(&rope(text), &matcher, false, MAX_FIND_MATCHES, || true).unwrap();
        assert_eq!(
            matches,
            [
                MatchLoc {
                    line: 0,
                    start_col: 0,
                    end_col: 5
                },
                MatchLoc {
                    line: 1,
                    start_col: 5,
                    end_col: 10
                }
            ]
        );
        assert!(!capped);
        // A cap below the match count reports exactly the cap and says so.
        let (two, capped) = scan_rope(&rope(text), &matcher, false, 2, || true).unwrap();
        assert_eq!(two.len(), 2);
        assert!(capped);
        // A dead liveness check aborts the scan instead of finishing it.
        assert!(scan_rope(&rope(text), &matcher, false, MAX_FIND_MATCHES, || false).is_err());
        // CRLF line endings strip both characters before matching.
        let (matches, _) = scan_rope(
            &rope("alpha\r\nx\r\n"),
            &matcher,
            false,
            MAX_FIND_MATCHES,
            || true,
        )
        .unwrap();
        assert_eq!(
            matches,
            [MatchLoc {
                line: 0,
                start_col: 0,
                end_col: 5
            }]
        );
    }

    #[test]
    fn replacement_sites_start_from_the_from_position() {
        let text = "one two one two one";
        let matcher = Matcher::compile("two", &options(false, false, false)).unwrap();
        let sites = replacement_sites(&rope(text), &matcher, false, "2", 0, 9, usize::MAX);
        assert_eq!(
            sites,
            [(12, 15, "2".to_owned())] // the second "two" only — from (0, 9) skips the first
        );
        // max = 1 replaces just the next match at/after the from position.
        let sites = replacement_sites(&rope(text), &matcher, false, "2", 0, 0, 1);
        assert_eq!(sites, [(4, 7, "2".to_owned())]);
        // The from position is (line, col): line 1, col 0 skips line 0 entirely.
        let text = "two\nthree two";
        let sites = replacement_sites(&rope(text), &matcher, false, "2", 1, 0, usize::MAX);
        assert_eq!(sites, [(10, 13, "2".to_owned())]);
    }

    #[test]
    fn regex_replacements_expand_groups_literals_do_not() {
        let matcher = Matcher::compile(r"(\w+)=(\w+)", &options(false, false, true)).unwrap();
        let sites = replacement_sites(
            &rope("a=1 b=22"),
            &matcher,
            false,
            "$2=$1",
            0,
            0,
            usize::MAX,
        );
        assert_eq!(
            sites,
            [
                (0, 3, "1=a".to_owned()),  // "a=1" → "1=a"
                (4, 8, "22=b".to_owned())  // "b=22" → "22=b"
            ]
        );
        // A literal query inserts the replacement verbatim — "$1" stays "$1".
        let matcher = Matcher::compile("a=1", &options(false, false, false)).unwrap();
        let sites = replacement_sites(&rope("a=1"), &matcher, false, "$1", 0, 0, usize::MAX);
        assert_eq!(sites, [(0, 3, "$1".to_owned())]);
    }
}
