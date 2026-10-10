//! The glob matcher every pattern surface shares: pathname expansion (`*.rs`), `case`
//! arms, `[[ str == pat ]]` and `find -name`. The pattern language is POSIX fnmatch's
//! core — `*`, `?`, `[...]` with ranges and negation — plus the two bash realities:
//! `*` does not match a leading dot, and the match is per path component (the caller
//! splits on `/`), never across a separator.

/// Does `name` match `pattern`? A leading-dot name only matches a pattern that starts
/// with a literal dot — the caller keeps bash's "hidden files stay hidden" rule by
/// testing it first (`*` alone reaching here is fine: the dot check lives below).
pub fn glob_match(pattern: &str, name: &str) -> bool {
    if name.starts_with('.') && !pattern.starts_with('.') {
        return false;
    }
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    match_here(&p, 0, &n, 0)
}

/// [`glob_match`] without the leading-dot rule: the `${x#pat}` / `${x/pat/rep}` family
/// matches arbitrary text, where `.` is an ordinary character and `*` crosses `/`.
pub fn glob_match_raw(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = text.chars().collect();
    match_here(&p, 0, &n, 0)
}

/// Pathname expansion: expand one glob pattern against the filesystem, `cwd`-relative.
/// Returns the sorted matches (POSIX order: byte-wise), or `None` when nothing matches —
/// bash's rule that an unmatched pattern stays literal, never vanishes. A relative
/// pattern answers in its own terms (`echo *.rs` prints `only.rs`, never the
/// cwd-joined path); an absolute one answers in the MSYS print dialect.
pub fn glob_expand(pattern: &str, cwd: &std::path::Path) -> Option<Vec<String>> {
    let has_meta = pattern.chars().any(|c| matches!(c, '*' | '?' | '['));
    if !has_meta {
        return None;
    }
    // Both separators are normalised, and an MSYS absolute (`/c/...`) crosses to its
    // drive before the component split, so the walk and the answers agree.
    let pattern = pattern.replace('\\', "/");
    let pattern = if cfg!(windows) && super::msys::is_msys_shape(&pattern) {
        super::msys::from_msys(&pattern)
    } else {
        pattern
    };
    let absolute = pattern.starts_with('/')
        || (cfg!(windows) && pattern.len() > 1 && pattern.as_bytes()[1] == b':');
    let components: Vec<&str> = pattern.split('/').filter(|part| !part.is_empty()).collect();
    if components.is_empty() {
        return None;
    }
    // Windows absolute paths lose their drive when split on '/', so the drive prefix
    // is re-rooted here — with its slash, `C:` alone is drive-RELATIVE (C:/x → C:\).
    let (root, start) = if absolute && cfg!(windows) && components[0].ends_with(':') {
        (
            std::path::PathBuf::from(format!(r"{}\", components[0])),
            1usize,
        )
    } else if absolute {
        (std::path::PathBuf::from("/"), 0)
    } else {
        (cwd.to_path_buf(), 0)
    };
    // Each candidate carries its display form beside the filesystem path, built from
    // the pattern's own components.
    let mut current: Vec<(std::path::PathBuf, String)> = vec![(root, String::new())];
    for component in &components[start..] {
        if *component == "." || *component == ".." {
            let parent = component.to_string();
            current = current
                .into_iter()
                .map(|(dir, shown)| (dir.join(&parent), join_shown(&shown, &parent)))
                .collect::<Vec<_>>();
            continue;
        }
        if !component.chars().any(|c| matches!(c, '*' | '?' | '[')) {
            current = current
                .into_iter()
                .map(|(dir, shown)| (dir.join(component), join_shown(&shown, component)))
                .collect::<Vec<_>>();
            continue;
        }
        let mut next = Vec::new();
        for (dir, shown) in &current {
            let entries = match std::fs::read_dir(dir) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let file_name = entry.file_name().to_string_lossy().into_owned();
                if glob_match(component, &file_name) {
                    next.push((dir.join(&file_name), join_shown(shown, &file_name)));
                }
            }
        }
        current = next;
    }
    if current.is_empty() {
        return None;
    }
    let mut names: Vec<String> = current
        .into_iter()
        .map(|(path, shown)| {
            if absolute {
                super::msys::to_msys(&path)
            } else {
                shown
            }
        })
        .collect();
    names.sort();
    Some(names)
}

fn join_shown(shown: &str, part: &str) -> String {
    if shown.is_empty() {
        part.to_owned()
    } else {
        format!("{shown}/{part}")
    }
}

fn match_here(p: &[char], mut pi: usize, n: &[char], mut ni: usize) -> bool {
    while pi < p.len() {
        match p[pi] {
            '*' => {
                // Collapse consecutive stars, then try every rest position (shortest first
                // — the classic fnmatch order).
                while pi < p.len() && p[pi] == '*' {
                    pi += 1;
                }
                if pi == p.len() {
                    return true;
                }
                let mut try_at = ni;
                while try_at <= n.len() {
                    if match_here(p, pi, n, try_at) {
                        return true;
                    }
                    try_at += 1;
                }
                return false;
            }
            '?' => {
                if ni >= n.len() {
                    return false;
                }
                pi += 1;
                ni += 1;
            }
            '[' => {
                if ni >= n.len() {
                    return false;
                }
                match match_class(p, pi, n[ni]) {
                    Some((matched, next_pi)) => {
                        if !matched {
                            return false;
                        }
                        pi = next_pi;
                        ni += 1;
                    }
                    None => {
                        // An unterminated class is a literal '['.
                        if n[ni] != '[' {
                            return false;
                        }
                        pi += 1;
                        ni += 1;
                    }
                }
            }
            expected => {
                if ni >= n.len() || n[ni] != expected {
                    return false;
                }
                pi += 1;
                ni += 1;
            }
        }
    }
    ni == n.len()
}

/// One `[...]` class starting at `p[start] == '['`. Answers whether `c` is a member and
/// where the class ends. A malformed class (no closing `]`) is a literal `[`.
fn match_class(p: &[char], start: usize, c: char) -> Option<(bool, usize)> {
    let mut index = start + 1;
    let mut negate = false;
    if index < p.len() && (p[index] == '!' || p[index] == '^') {
        negate = true;
        index += 1;
    }
    let mut matched = false;
    let mut first = true;
    while index < p.len() {
        if p[index] == ']' && !first {
            return Some((matched != negate, index + 1));
        }
        first = false;
        // a-z style ranges; a trailing '-' before ']' is literal.
        if index + 2 < p.len() && p[index + 1] == '-' && p[index + 2] != ']' {
            if p[index] <= c && c <= p[index + 2] {
                matched = true;
            }
            index += 3;
            continue;
        }
        if p[index] == c {
            matched = true;
        }
        index += 1;
    }
    // No closing bracket: treat as a literal '[' and let the caller retry past it.
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stars_question_and_classes_match() {
        assert!(glob_match("*.rs", "main.rs"));
        assert!(!glob_match("*.rs", "main.ts"));
        assert!(glob_match("a?c", "abc"));
        assert!(glob_match("[a-c]x", "bx"));
        assert!(!glob_match("[!a-c]x", "bx"));
        assert!(glob_match("[!a-c]x", "dx"));
        assert!(glob_match("a*b*c", "a-b--c"));
        assert!(!glob_match("a*b*c", "a-c"));
    }

    #[test]
    fn a_star_does_not_cross_a_hidden_name() {
        assert!(!glob_match("*", ".gitignore"));
        assert!(glob_match(".g*", ".gitignore"));
        assert!(glob_match("*", "src"));
    }

    #[test]
    fn an_open_class_is_a_literal_bracket() {
        assert!(glob_match("a[b", "a[b"));
        assert!(!glob_match("a[b", "ab"));
    }

    #[test]
    fn a_trailing_hyphen_is_literal() {
        assert!(glob_match("[a-]", "-"));
        assert!(glob_match("[-a]", "-"));
    }

    #[test]
    fn expansion_sorts_and_keeps_unmatched_patterns() {
        let dir = tempfile::TempDir::new().unwrap();
        for name in ["b.txt", "a.txt", "c.md"] {
            std::fs::write(dir.path().join(name), "").unwrap();
        }
        // A relative pattern answers in its own terms.
        let matches = glob_expand("*.txt", dir.path()).unwrap();
        assert_eq!(matches, vec!["a.txt", "b.txt"]);
        assert!(glob_expand("*.missing", dir.path()).is_none());
        // Hidden files need an explicit dot.
        std::fs::write(dir.path().join(".hidden"), "").unwrap();
        let matches = glob_expand(".*", dir.path()).unwrap();
        assert_eq!(matches, vec![".hidden"]);
        // An absolute pattern answers in the MSYS print dialect.
        let absolute = format!("{}/*.txt", super::super::msys::to_msys(dir.path()));
        let matches = glob_expand(&absolute, dir.path()).unwrap();
        let prefix = super::super::msys::to_msys(dir.path());
        assert_eq!(
            matches,
            vec![format!("{prefix}/a.txt"), format!("{prefix}/b.txt")]
        );
    }

    #[test]
    fn expansion_walks_subdirectories_component_wise() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src").join("one.rs"), "").unwrap();
        std::fs::write(dir.path().join("two.rs"), "").unwrap();
        let matches = glob_expand("*.rs", dir.path()).unwrap();
        assert_eq!(matches, vec!["two.rs"]);
        let matches = glob_expand("*/*.rs", dir.path()).unwrap();
        assert_eq!(matches, vec!["src/one.rs"]);
    }
}
