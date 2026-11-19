//! The symbol rename engine: a preview of every affected location, and an apply that
//! rewrites them. The preview is the index's own answer — every declaration of the old
//! name plus every whole-word reference the reference scan finds, the hits the file's
//! comment/string mask covers ([`crate::symbols::mask`]) dropped — so a plan is exactly
//! the positions the workspace's own tools point at, sorted by path, line, column. The
//! apply is word-boundary and line-accurate: only the recorded lines are rewritten, and
//! only whole identifier occurrences of the old name, never a substring of a longer name
//! (`Draw` never touches `DrawFoo` or `MyDraw`). Each file is decoded in its detected
//! encoding (BOM, UTF-16, GB18030 and the rest, via `ggs_text::encoding`), rewritten,
//! and written back atomically in the same encoding with its line endings and BOM
//! byte-exact — then read back and re-scanned to verify: an old-name occurrence left in
//! code, or a new-name count shorter than the rewrite, restores the original bytes and
//! reports the file. One file's failure — vanished, an encoding that does not round-trip,
//! a recorded site whose line no longer holds the old name — costs that file alone; the
//! others still apply, and the outcome carries each failure by path. Refusals are
//! all-or-nothing: the same old and new name, an invalid new name, an old name the index
//! never declared, a new name a different declaration already owns, and a site count
//! over the ceiling all leave every file untouched.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Serialize;

use crate::scan::read_searchable;
use crate::symbols::index::scan_references_bounded;
use crate::symbols::mask::{mask, CodeMask};
use crate::symbols::store::SymbolStore;
use crate::symbols::WorkspaceSymbol;
use ggs_text::encoding::{decode, encode};

/// The site count above which a rename refuses outright: a hub name's rewrite is
/// all-or-nothing, so an oversized family is never partially applied.
pub const MAX_RENAME_SITES: usize = 5000;

/// One position a rename would rewrite: the identifier occurrence at a 0-based line and
/// character column of a repo-relative file.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct RenameSite {
    pub path: String,
    pub line: usize,
    pub column: usize,
}

/// What the preview answers: the subject's name, every affected site, how many files it
/// spans, and the reasons the rename must not run — an empty `conflicts` means the apply
/// is safe. The sites still arrive when a conflict stands, so the dialog can show the
/// impact while the apply stays disabled.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenamePlan {
    pub name: String,
    pub sites: Vec<RenameSite>,
    pub files: usize,
    pub conflicts: Vec<String>,
}

/// One file the apply could not rewrite, with the reason.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenameFileError {
    pub path: String,
    pub message: String,
}

/// What the apply answers: how many occurrences were rewritten, which files changed,
/// and the per-file failures.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RenameOutcome {
    pub applied: usize,
    pub files: Vec<String>,
    pub errors: Vec<RenameFileError>,
}

/// A legal name is one or more identifier segments joined by `::`: `Draw` and
/// `Widget::Draw` pass; `::x`, `x::`, `a::::b`, `9x`, `bad name` and the empty string
/// do not.
fn valid_name(name: &str) -> bool {
    let is_start = |c: char| c.is_alphabetic() || c == '_';
    let is_cont = |c: char| c.is_alphanumeric() || c == '_';
    let mut rest = name;
    loop {
        let Some(c) = rest.chars().next() else {
            return false;
        };
        if !is_start(c) {
            return false;
        }
        let after = rest.find(|c: char| !is_cont(c)).unwrap_or(rest.len());
        rest = &rest[after..];
        match rest.strip_prefix("::") {
            Some(tail) => rest = tail,
            None => return rest.is_empty(),
        }
    }
}

/// The plan: validation conflicts plus the site list — the old name's declarations
/// (the store's lookup, every overload family member) folded together with its
/// whole-word references (the occurrence-narrowed scan, mask-filtered), one site per
/// position, sorted by path, line, column. The declarations' byte columns convert to
/// character columns through the same lines the scan already reads.
pub fn rename_plan(
    root: &str,
    store: &SymbolStore,
    old_name: &str,
    new_name: &str,
) -> Result<RenamePlan, String> {
    let mut conflicts = Vec::new();
    if !valid_name(new_name) {
        conflicts.push(format!(
            "\"{new_name}\" is not a valid name — use one or more identifier segments joined by \"::\""
        ));
    }
    if old_name.is_empty() {
        conflicts.push("The old name is empty".to_owned());
        return Ok(RenamePlan {
            name: old_name.to_owned(),
            sites: Vec::new(),
            files: 0,
            conflicts,
        });
    }
    if old_name == new_name {
        conflicts.push(format!(
            "The old and new names are the same ({old_name}); nothing was renamed"
        ));
    }
    let defs = store.lookup(old_name);
    if defs.is_empty() {
        conflicts.push(format!(
            "\"{old_name}\" is not declared anywhere in the index"
        ));
    }
    if !store.lookup(new_name).is_empty() {
        conflicts.push(format!(
            "\"{new_name}\" is already declared in the workspace; renaming over it would merge two symbols"
        ));
    }

    // The references first: their columns are character columns, and a declaration on a
    // line the scan covers folds into it.
    let (files, _) = scan_references_bounded(
        root,
        old_name,
        store.files_containing(old_name),
        usize::MAX,
        "",
    )?;
    let mut sites: Vec<RenameSite> = Vec::new();
    let mut masks: HashMap<String, Option<CodeMask>> = HashMap::new();
    let mut ref_lines: HashSet<(String, usize)> = HashSet::new();
    for file in files {
        for hit in &file.matches {
            let (line, column) = (hit.line - 1, hit.column - 1);
            if file_mask_of(root, &file.path, &mut masks).is_some_and(|m| m.is_masked(line, column))
            {
                continue;
            }
            ref_lines.insert((file.path.clone(), line));
            sites.push(RenameSite {
                path: file.path.clone(),
                line,
                column,
            });
        }
    }

    // The declarations on lines the scan never covered: one read per file converts the
    // parser's byte column to the character column the sites speak.
    let mut def_only: Vec<&WorkspaceSymbol> = defs
        .iter()
        .filter(|def| !ref_lines.contains(&(def.path.clone(), def.line)))
        .collect();
    def_only.sort_by(|a, b| (&a.path, a.line).cmp(&(&b.path, b.line)));
    let mut texts: HashMap<String, Option<String>> = HashMap::new();
    for def in def_only {
        let column = texts
            .entry(def.path.clone())
            .or_insert_with(|| {
                read_searchable(&Path::new(root).join(&def.path))
                    .map(|(bytes, _)| String::from_utf8_lossy(&bytes).into_owned())
            })
            .as_deref()
            .and_then(|text| line_at(text, def.line).map(|line| char_column(line, def.column)))
            .unwrap_or(def.column);
        sites.push(RenameSite {
            path: def.path.clone(),
            line: def.line,
            column,
        });
    }

    sites.sort();
    sites.dedup();
    if sites.len() > MAX_RENAME_SITES {
        conflicts.push(format!(
            "The rename would touch {} locations, above the {MAX_RENAME_SITES}-site ceiling — refusing to rewrite part of them",
            sites.len()
        ));
    }
    let file_count = sites
        .iter()
        .map(|site| site.path.as_str())
        .collect::<HashSet<_>>()
        .len();
    Ok(RenamePlan {
        name: old_name.to_owned(),
        sites,
        files: file_count,
        conflicts,
    })
}

/// The apply: a fresh plan (a stale preview never drives a rewrite), the conflicts
/// refused as one error, then file by file — each failure recorded, the rest going on.
pub fn rename_apply(
    root: &str,
    store: &SymbolStore,
    old_name: &str,
    new_name: &str,
) -> Result<RenameOutcome, String> {
    let plan = rename_plan(root, store, old_name, new_name)?;
    if !plan.conflicts.is_empty() {
        return Err(plan.conflicts.join("; "));
    }
    let mut per_file: std::collections::BTreeMap<String, Vec<RenameSite>> =
        std::collections::BTreeMap::new();
    for site in plan.sites {
        per_file.entry(site.path.clone()).or_default().push(site);
    }
    let mut outcome = RenameOutcome::default();
    for (path, sites) in per_file {
        match apply_file(root, &path, &sites, old_name, new_name) {
            Ok(replaced) => {
                outcome.applied += replaced;
                outcome.files.push(path);
            }
            Err(message) => outcome.errors.push(RenameFileError { path, message }),
        }
    }
    Ok(outcome)
}

/// Rewrite one file at its recorded lines: whole-word, mask-checked occurrences of the
/// old name become the new name; the encoding, BOM and line endings come back byte-exact;
/// a post-write re-scan verifies and restores on failure. `Ok` carries the replacement
/// count.
fn apply_file(
    root: &str,
    path: &str,
    sites: &[RenameSite],
    old_name: &str,
    new_name: &str,
) -> Result<usize, String> {
    let abs = Path::new(root).join(path);
    let bytes = std::fs::read(&abs).map_err(|e| format!("{path}: {e}"))?;
    let decoded = decode(&bytes, None);
    // The rewrite must survive a decode/encode round trip in the detected encoding; a
    // file whose bytes do not come back identical is left alone.
    if encode(&decoded.text, decoded.encoding, "lf") != bytes {
        return Err(format!(
            "{path}: its detected encoding ({}) does not round-trip; the file was left unchanged",
            decoded.encoding
        ));
    }
    let file_mask = mask(&decoded.text);
    let lines: Vec<&str> = decoded.text.split('\n').collect();
    let recorded: HashSet<usize> = sites.iter().map(|site| site.line).collect();
    let mut by_line: HashMap<usize, String> = HashMap::new();
    let mut replaced = 0usize;
    for &line_no in &recorded {
        let Some(line) = lines.get(line_no) else {
            continue;
        };
        let (rewritten, n) = rewrite_line(line, old_name, new_name, line_no, &file_mask);
        if n > 0 {
            by_line.insert(line_no, rewritten);
            replaced += n;
        }
    }
    if replaced == 0 {
        return Err(format!(
            "{path}: none of the recorded sites still holds \"{old_name}\"; the file was left unchanged"
        ));
    }
    // The separators are copied as they are: a `\r` before a `\n` is not a word
    // character, so LF, CRLF and the mixed shapes between them survive untouched.
    let mut text = String::with_capacity(decoded.text.len() + 64);
    for (line_no, line) in lines.iter().enumerate() {
        if line_no > 0 {
            text.push('\n');
        }
        match by_line.get(&line_no) {
            Some(rewritten) => text.push_str(rewritten),
            None => text.push_str(line),
        }
    }
    let out = encode(&text, decoded.encoding, "lf");
    ggs_base::fsx::atomic_write(&abs, &out).map_err(|e| format!("{path}: {e}"))?;
    if let Err(message) = verify_file(&abs, old_name, new_name, replaced, decoded.encoding) {
        // Never leave it half-renamed: the original bytes go back.
        let _ = std::fs::write(&abs, &bytes);
        return Err(format!("{path}: {message}; the original file was restored"));
    }
    Ok(replaced)
}

/// The post-write check: the written bytes decode as the original encoding again, no
/// old-name word remains live outside a new-name occurrence (a qualified new name keeps
/// the old leaf as a word — that one is the rewrite itself), and the new name occurs at
/// least as often as the rewrite replaced it.
fn verify_file(
    abs: &Path,
    old_name: &str,
    new_name: &str,
    replaced: usize,
    encoding: &str,
) -> Result<(), String> {
    let bytes =
        std::fs::read(abs).map_err(|e| format!("the written file could not be read back: {e}"))?;
    let decoded = decode(&bytes, None);
    if decoded.encoding != encoding {
        return Err("the written file no longer decodes as its original encoding".to_owned());
    }
    let file_mask = mask(&decoded.text);
    let lines: Vec<&str> = decoded.text.split('\n').collect();
    let mut new_spans: Vec<(usize, usize, usize)> = Vec::new();
    for (byte_at, _) in decoded.text.match_indices(new_name) {
        let mut base = 0usize;
        for (line_no, line) in lines.iter().enumerate() {
            if byte_at < base + line.len() {
                let column = char_column(line, byte_at - base);
                new_spans.push((line_no, column, column + new_name.chars().count()));
                break;
            }
            base += line.len() + 1;
        }
    }
    let mut leftover = 0usize;
    for (line_no, line) in lines.iter().enumerate() {
        for (_, column, word) in words_of(line) {
            if word != old_name || file_mask.is_masked(line_no, column) {
                continue;
            }
            let end = column + word.chars().count();
            let covered = new_spans
                .iter()
                .any(|&(at, from, to)| at == line_no && from <= column && end <= to);
            if !covered {
                leftover += 1;
            }
        }
    }
    if leftover > 0 {
        return Err(format!(
            "the old name still occurs at {leftover} live location(s) after the rewrite"
        ));
    }
    if decoded.text.matches(new_name).count() < replaced {
        return Err("the new name occurs fewer times than the rewrite replaced".to_owned());
    }
    Ok(())
}

/// One line rewritten: every maximal word run equal to `old_name` that the mask leaves
/// live becomes `new_name`.
fn rewrite_line(
    line: &str,
    old_name: &str,
    new_name: &str,
    line_no: usize,
    file_mask: &CodeMask,
) -> (String, usize) {
    let mut out = String::with_capacity(line.len() + 16);
    let mut replaced = 0usize;
    let mut copied = 0usize;
    for (byte_at, column, word) in words_of(line) {
        out.push_str(&line[copied..byte_at]);
        copied = byte_at + word.len();
        if word == old_name && !file_mask.is_masked(line_no, column) {
            out.push_str(new_name);
            replaced += 1;
        } else {
            out.push_str(word);
        }
    }
    out.push_str(&line[copied..]);
    (out, replaced)
}

/// The maximal word runs of one line, as (byte start, character column, word). Maximal
/// munch makes every run a whole word by construction — a rewrite taken from these can
/// never land inside a longer identifier.
fn words_of(line: &str) -> Vec<(usize, usize, &str)> {
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let mut hits = Vec::new();
    let mut column = 0usize;
    let mut rest = line;
    while let Some(c) = rest.chars().next() {
        if is_word(c) {
            let len: usize = rest
                .chars()
                .take_while(|w| is_word(*w))
                .map(char::len_utf8)
                .sum();
            hits.push((line.len() - rest.len(), column, &rest[..len]));
            column += rest[..len].chars().count();
            rest = &rest[len..];
        } else {
            column += 1;
            rest = &rest[c.len_utf8()..];
        }
    }
    hits
}

/// The comment/string mask of one file, computed once per plan (`masks` caches across
/// the site collection); a vanished or binary file answers no mask and no filtering.
fn file_mask_of<'a>(
    root: &str,
    path: &str,
    masks: &'a mut HashMap<String, Option<CodeMask>>,
) -> Option<&'a CodeMask> {
    masks
        .entry(path.to_owned())
        .or_insert_with(|| {
            read_searchable(&Path::new(root).join(path))
                .map(|(bytes, _)| mask(&String::from_utf8_lossy(&bytes)))
        })
        .as_ref()
}

/// Line `line_no` of a `\n`-split text.
fn line_at(text: &str, line_no: usize) -> Option<&str> {
    text.split('\n').nth(line_no)
}

/// A byte offset within a line, as a character column; an offset inside a multi-byte
/// character falls back to the character it starts.
fn char_column(line: &str, byte_col: usize) -> usize {
    let mut at = byte_col.min(line.len());
    while at > 0 && !line.is_char_boundary(at) {
        at -= 1;
    }
    line[..at].chars().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, path: &str, bytes: &[u8]) {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap_or(root)).unwrap();
        std::fs::write(file, bytes).unwrap();
    }

    fn write_str(root: &Path, path: &str, text: &str) {
        write(root, path, text.as_bytes());
    }

    fn seeded(files: &[(&str, &str)]) -> (tempfile::TempDir, SymbolStore) {
        let dir = tempfile::tempdir().unwrap();
        for (path, text) in files {
            write_str(dir.path(), path, text);
        }
        let root = dir.path().display().to_string();
        let store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();
        (dir, store)
    }

    fn read(dir: &tempfile::TempDir, path: &str) -> Vec<u8> {
        std::fs::read(dir.path().join(path)).unwrap()
    }

    /// The preview folds the declarations and the references of the name into one
    /// sorted site list across every file, and answers the file count and no conflicts.
    #[test]
    fn preview_collects_definitions_and_references_across_files() {
        let (_dir, store) = seeded(&[
            ("src/a.c", "int alpha(int x)\n{\n    return x;\n}\n"),
            (
                "src/b.c",
                "#include \"util.h\"\nint beta(int n)\n{\n    return alpha(n);\n}\n",
            ),
            ("src/util.h", "int alpha(int x);\n"),
        ]);
        let plan = rename_plan(store.root(), &store, "alpha", "gamma").unwrap();
        assert_eq!(plan.name, "alpha");
        assert!(plan.conflicts.is_empty());
        assert_eq!(plan.files, 3);
        assert_eq!(
            plan.sites,
            vec![
                RenameSite {
                    path: "src/a.c".into(),
                    line: 0,
                    column: 4
                },
                RenameSite {
                    path: "src/b.c".into(),
                    line: 3,
                    column: 11
                },
                RenameSite {
                    path: "src/util.h".into(),
                    line: 0,
                    column: 4
                },
            ]
        );
    }

    /// A mention inside a comment or a string is the prose's own word, not a site.
    #[test]
    fn commented_and_string_occurrences_are_not_sites() {
        let (_dir, store) = seeded(&[
            ("src/a.c", "int alpha(int x)\n{\n    return x;\n}\n"),
            (
                "src/b.c",
                "int beta(int n)\n{\n    // alpha(n) in prose\n    log(\"alpha was called\");\n    /* alpha\n       again */\n    return alpha(n);\n}\n",
            ),
        ]);
        let plan = rename_plan(store.root(), &store, "alpha", "gamma").unwrap();
        assert_eq!(
            plan.sites,
            vec![
                RenameSite {
                    path: "src/a.c".into(),
                    line: 0,
                    column: 4
                },
                RenameSite {
                    path: "src/b.c".into(),
                    line: 6,
                    column: 11
                },
            ]
        );
    }

    /// The refusals: the same old and new name, a new name another declaration owns, an
    /// old name nothing declares, and each invalid new-name spelling. Sites still arrive
    /// beside the conflicts so a dialog can show the impact.
    #[test]
    fn rename_conflicts_refuse_the_plan() {
        let (_dir, store) = seeded(&[("a.c", "int alpha;\nint gamma;\n"), ("b.c", "int alpha;\n")]);
        let root = store.root().to_owned();

        let plan = rename_plan(&root, &store, "alpha", "alpha").unwrap();
        assert!(plan.conflicts.iter().any(|c| c.contains("the same")));

        let plan = rename_plan(&root, &store, "alpha", "gamma").unwrap();
        assert!(
            plan.conflicts
                .iter()
                .any(|c| c.contains("already declared")),
            "{:?}",
            plan.conflicts
        );
        assert!(!plan.sites.is_empty(), "the impact still shows");

        let plan = rename_plan(&root, &store, "nosuch", "other").unwrap();
        assert!(plan.conflicts.iter().any(|c| c.contains("not declared")));
        assert!(plan.sites.is_empty());

        for bad in ["::x", "x::", "a::::b", "9x", "bad name", ""] {
            let plan = rename_plan(&root, &store, "alpha", bad).unwrap();
            assert!(
                plan.conflicts
                    .iter()
                    .any(|c| c.contains("not a valid name")),
                "{bad:?}: {:?}",
                plan.conflicts
            );
        }
        // A legal qualified name passes.
        let plan = rename_plan(&root, &store, "alpha", "Widget::Draw").unwrap();
        assert!(plan.conflicts.is_empty(), "{:?}", plan.conflicts);
    }

    /// Above the site ceiling the rename refuses all-or-nothing: nothing is rewritten.
    #[test]
    fn an_oversized_family_refuses_all_or_nothing() {
        let mut text = String::from("int hub;\n");
        for _ in 0..MAX_RENAME_SITES {
            text.push_str("use hub;\n");
        }
        let (dir, store) = seeded(&[("hub.c", text.as_str())]);
        let original = read(&dir, "hub.c");
        let plan = rename_plan(store.root(), &store, "hub", "cog").unwrap();
        assert_eq!(plan.sites.len(), MAX_RENAME_SITES + 1);
        assert!(
            plan.conflicts.iter().any(|c| c.contains("ceiling")),
            "{:?}",
            plan.conflicts
        );
        assert!(rename_apply(store.root(), &store, "hub", "cog").is_err());
        assert_eq!(read(&dir, "hub.c"), original, "not one site was rewritten");
    }

    /// The apply rewrites whole words only: `Draw` moves, `DrawFoo` and `MyDraw` keep
    /// their names, and the outcome counts exactly what changed.
    #[test]
    fn apply_rewrites_word_boundaries_across_files() {
        let text = "void Draw(void) {}\nvoid DrawFoo(void) {}\nvoid MyDraw(void) {\n    Draw();\n    DrawFoo();\n    MyDraw();\n}\n";
        let (dir, store) = seeded(&[("draw.c", text)]);
        let outcome = rename_apply(store.root(), &store, "Draw", "Render").unwrap();
        assert_eq!(outcome.applied, 2);
        assert_eq!(outcome.files, vec!["draw.c".to_owned()]);
        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        assert_eq!(
            String::from_utf8(read(&dir, "draw.c")).unwrap(),
            "void Render(void) {}\nvoid DrawFoo(void) {}\nvoid MyDraw(void) {\n    Render();\n    DrawFoo();\n    MyDraw();\n}\n"
        );
    }

    /// The write is byte-faithful: CRLF and mixed endings survive exactly, and a BOM
    /// comes back in place.
    #[test]
    fn apply_preserves_encoding_endings_and_bom() {
        let dir = tempfile::tempdir().unwrap();
        write_str(
            dir.path(),
            "w.c",
            "int alpha;\r\n// alpha in a note\r\nvalue = alpha;\n",
        );
        write(
            dir.path(),
            "bom.c",
            &encode("int alpha;\n中文 alpha;\n", "utf8bom", "lf"),
        );
        let root = dir.path().display().to_string();
        let store = SymbolStore::build(&root, 4, &|_, _| {}, &|| false).unwrap();

        let outcome = rename_apply(&root, &store, "alpha", "beta").unwrap();
        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        assert_eq!(outcome.files.len(), 2);
        assert_eq!(
            read(&dir, "w.c"),
            b"int beta;\r\n// alpha in a note\r\nvalue = beta;\n".to_vec(),
            "every ending byte-exact, the comment untouched"
        );
        let back = read(&dir, "bom.c");
        assert!(back.starts_with(&[0xEF, 0xBB, 0xBF]), "the BOM came back");
        let decoded = decode(&back, None);
        assert_eq!(decoded.encoding, "utf8bom");
        assert_eq!(decoded.text, "int beta;\n中文 beta;\n");
    }

    /// A GB18030 (GBK) file round-trips as GB18030: the Chinese comment survives byte
    /// for byte and only the identifier moves. The store cannot read such a file (it is
    /// not UTF-8), so the name's occurrence list is untrusted and the plan's full scan
    /// is what finds it.
    #[test]
    fn a_gbk_file_round_trips_as_gbk() {
        let (dir, mut store) = seeded(&[("a.rs", "fn beta() {}\n")]);
        write_str(dir.path(), "u.rs", "fn alpha() { beta(); }\n");
        store.apply_changes(&["u.rs".to_owned()]);
        let gbk = encode("中文注释 alpha 提示\nint alpha = 0;\n", "gb18030", "lf");
        write(dir.path(), "gbk.c", &gbk);

        let outcome = rename_apply(store.root(), &store, "alpha", "gamma").unwrap();
        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        assert_eq!(
            String::from_utf8(read(&dir, "u.rs")).unwrap(),
            "fn gamma() { beta(); }\n"
        );
        let back = read(&dir, "gbk.c");
        let decoded = decode(&back, None);
        assert_eq!(decoded.encoding, "gb18030");
        assert_eq!(decoded.text, "中文注释 gamma 提示\nint gamma = 0;\n");
        assert_eq!(outcome.applied, 3);
    }

    /// A recorded site whose line no longer holds the old name (a stale index entry
    /// over an edited file) fails that file and restores nothing — the other files
    /// still apply.
    #[test]
    fn a_stale_site_fails_its_file_and_the_rest_still_apply() {
        let (dir, store) = seeded(&[
            ("a.c", "int alpha;\nint use_alpha(void) { return alpha; }\n"),
            ("b.c", "int alpha;\n"),
        ]);
        // The store now lies about a.c: the file on disk lost the name entirely.
        write_str(
            dir.path(),
            "a.c",
            "int betamax;\nint gone(void) { return 1; }\n",
        );

        let outcome = rename_apply(store.root(), &store, "alpha", "gamma").unwrap();
        assert_eq!(outcome.errors.len(), 1);
        assert_eq!(outcome.errors[0].path, "a.c");
        assert_eq!(
            read(&dir, "a.c"),
            b"int betamax;\nint gone(void) { return 1; }\n".to_vec()
        );
        assert_eq!(outcome.files, vec!["b.c".to_owned()]);
        assert_eq!(outcome.applied, 1);
        assert_eq!(read(&dir, "b.c"), b"int gamma;\n".to_vec());
    }

    /// The word scanner speaks maximal runs: every hit is a whole word by construction,
    /// columns are characters, and the `\r` of a CRLF line is not part of any word.
    #[test]
    fn words_of_walks_maximal_runs_in_characters() {
        let hits = words_of("int alpha_x, alpha;\r\n");
        assert_eq!(
            hits.iter()
                .map(|(_, col, word)| (*col, *word))
                .collect::<Vec<_>>(),
            vec![(0, "int"), (4, "alpha_x"), (13, "alpha")]
        );
    }

    /// The name validation accepts bare and `::`-joined identifiers and nothing else.
    #[test]
    fn valid_name_takes_identifier_segments_only() {
        for good in ["Draw", "Widget::Draw", "_x", "x9_y"] {
            assert!(valid_name(good), "{good:?} is a name");
        }
        for bad in ["", "::x", "x::", "a::::b", "9x", "bad name", "x:::y"] {
            assert!(!valid_name(bad), "{bad:?} is not a name");
        }
    }
}
