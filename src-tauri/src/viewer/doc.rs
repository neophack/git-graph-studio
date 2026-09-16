//! The viewer's document: a ropey `Rope` plus the syntect parse/highlight state checkpoints
//! that make random-access highlighting of huge files cheap.

use std::collections::HashMap;
use std::path::PathBuf;

use ropey::Rope;
use syntect::parsing::{ParseState, ScopeStack, SyntaxReference, SyntaxSet};

/// Highlighting resumes from a checkpoint every `BLOCK` lines, so jumping to line 400_000 of a
/// million-line file costs at most one block of catch-up work, not a full re-parse.
pub const BLOCK: usize = 256;

/// One highlighted token: `[start, end)` in code points plus the syntect scope stack it landed
/// on (e.g. `source.rust keyword.other.fn.rust`); the frontend maps scopes to theme colors.
pub type Token = (usize, usize, String);
pub type HighlightedLine = (String, Vec<Token>);

/// One undo step. A single `edit` is one contiguous replacement; a find/replace "Replace
/// All" is several non-overlapping sites that undo and redo as one step (VS Code treats
/// them the same way). Line granularity is what the frontend needs to re-window afterwards.
#[derive(Clone)]
enum UndoEntry {
    Single {
        start_char: usize,
        removed: String,
        inserted: String,
    },
    /// `(start_char, removed, inserted)` per site, in document order.
    Multi(Vec<(usize, String, String)>),
}

/// Undo steps kept per document — enough for a long editing session, bounded so a huge
/// file's steps (each holding its removed text) cannot grow without limit.
const UNDO_LIMIT: usize = 500;

pub struct ViewerDoc {
	pub path: PathBuf,
	pub rope: Rope,
	/// Extension used to pick the syntax definition and the outline extractor.
	pub language: String,
	pub syntax_name: String,
	/// The encoding id and line endings the file was read with (`crate::encoding`).
	pub encoding: String,
	pub eol: String,
	syntax: SyntaxReference,
	checkpoints: HashMap<usize, Checkpoint>,
	undo_stack: Vec<UndoEntry>,
	redo_stack: Vec<UndoEntry>,
	/// The background tail build that still owes this document its remainder: while `Some`,
	/// `line_count` reports the estimate and lines past the rope wait for the landing. The
	/// id is checked on landing — a document replaced by a reload never receives a stale tail.
	pub tail_id: Option<u64>,
	/// `Some` exactly while `tail_id` is: the approximate total line count (the head's line
	/// density extrapolated over the file's size) the scroller shows until the exact count.
	pub line_estimate: Option<usize>,
	/// Set when the tail build failed: the document serves its head, but a save must refuse
	/// (writing the head alone would truncate the file) and whole-document scans report it.
	pub tail_error: Option<String>,
	/// The file's `size:mtime` as it was read (and as `viewer_save` last wrote it): the
	/// cheap half of "did the file change on disk", so a save's own watcher echo never
	/// reloads the document out from under the editor's cursor.
	pub fingerprint: String,
}

#[derive(Clone)]
struct Checkpoint {
    parse: ParseState,
    stack: ScopeStack,
}

pub fn syntax_set() -> &'static SyntaxSet {
    static SET: std::sync::OnceLock<SyntaxSet> = std::sync::OnceLock::new();
    SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

/// The syntax definition's name for a file extension, without building a document — the
/// indexed viewer reports a language for the status bar without any rope.
pub fn syntax_name_for(language: &str) -> String {
    let set = syntax_set();
    set.find_syntax_by_extension(language)
        .filter(|s| s.name != "Plain Text")
        .or_else(|| set.find_syntax_by_extension(fallback_extension(language)))
        .filter(|s| s.name != "Plain Text")
        .or_else(|| set.find_syntax_by_extension("txt"))
        .expect("syntect always ships a plain-text syntax")
        .name
        .to_owned()
}

impl ViewerDoc {
    /// Build a document from already-decoded text. `language` is the file extension, used to
    /// pick a syntax definition (falling back to syntect's plain-text one).
    pub fn new(path: PathBuf, text: &str, language: &str) -> ViewerDoc {
        let set = syntax_set();
        let syntax = set
            .find_syntax_by_extension(language)
            .filter(|s| s.name != "Plain Text")
            .or_else(|| set.find_syntax_by_extension(fallback_extension(language)))
            .filter(|s| s.name != "Plain Text")
            .or_else(|| set.find_syntax_by_extension("txt"))
            .expect("syntect always ships a plain-text syntax")
            .clone();
        ViewerDoc {
            path,
            rope: Rope::from(text),
            language: language.to_owned(),
            syntax_name: syntax.name.to_owned(),
            encoding: "utf8".to_owned(),
            eol: "lf".to_owned(),
            syntax,
            checkpoints: HashMap::new(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            tail_id: None,
            line_estimate: None,
            tail_error: None,
            fingerprint: String::new(),
        }
    }

    /// The line count the frontend sees: the estimate while the tail is still building,
    /// the rope's exact count once it lands.
    pub fn line_count(&self) -> usize {
        self.line_estimate.unwrap_or_else(|| self.rope.len_lines())
    }

    /// The line count the rope actually holds — the clamp every rope indexing uses, so an
    /// estimate beyond the loaded head can never walk the rope out of bounds.
    pub fn rope_lines(&self) -> usize {
        self.rope.len_lines()
    }

    /// The text of a 0-based line, without its trailing newline. ropey's `line()` keeps the
    /// newline; the viewer's line model excludes it.
    #[cfg(test)]
    pub fn line_text(&self, line: usize) -> String {
        self.rope
            .line(line.min(self.line_count().saturating_sub(1)))
            .to_string()
            .trim_end_matches(['\n', '\r'])
            .to_owned()
    }

    pub fn full_text(&self) -> String {
        self.rope.to_string()
    }

    /// Translate a 0-based line + code-point column to a rope char offset.
    pub fn offset_of(&self, line: usize, col: usize) -> usize {
        // A past-the-end line is the document's end, whatever the last line holds: the
        // windowed editor addresses "through the end of the file" as `(line_count, 0)`, and
        // collapsing that onto the last line's start would splice an edit into its text.
        // The rope's own bounds decide — during a staged open the estimate can name lines
        // the rope does not hold yet.
        if line >= self.rope_lines() {
            return self.rope.len_chars();
        }
        let base = self.rope.line_to_char(line);
        let line_len = self.rope.line(line).len_chars();
        let last = line + 1 >= self.rope_lines();
        (base + col.min(line_len - usize::from(!last))).min(self.rope.len_chars())
    }

    /// Apply a replacement of the `start..end` char range (rope chars = Unicode code points) and
    /// drop every checkpoint at or after the edit so stale states can never be resumed from.
    /// Returns the 0-based line the edit starts on.
    pub fn edit(&mut self, start_char: usize, end_char: usize, text: &str) -> usize {
        let (lo, hi) = (start_char.min(end_char), end_char.max(start_char));
        let removed = self
            .rope
            .get_slice(lo..hi)
            .map(|s| s.to_string())
            .unwrap_or_default();
        let first_line = self.apply_edit(lo, hi, text);
        self.push_undo(UndoEntry::Single {
            start_char: lo,
            removed,
            inserted: text.to_owned(),
        });
        first_line
    }

    /// Apply several non-overlapping replacements as one undo step — find/replace's "Replace
    /// All". Sites are `(start_char, end_char, replacement)` in document order, absolute rope
    /// char offsets into the *current* rope; they land bottom-up so the earlier sites'
    /// offsets stay valid. Returns the first changed line.
    pub fn replace_sites(&mut self, sites: Vec<(usize, usize, String)>) -> usize {
        let mut first_line = usize::MAX;
        // The undo entry records each site at its position in the *final* rope: its start
        // plus the length deltas of the sites before it. Undo rewinds bottom-up and redo
        // replays top-down, and both find every site exactly there — the sites after it do
        // not move it, and by redo time the ones before it have shifted it already.
        let mut shift: isize = 0;
        let mut undo: Vec<(usize, String, String)> = Vec::with_capacity(sites.len());
        for (start, end, replacement) in &sites {
            let at = (*start as isize + shift).max(0) as usize;
            let removed = self
                .rope
                .get_slice(*start..*end)
                .map(|s| s.to_string())
                .unwrap_or_default();
            undo.push((at, removed, replacement.clone()));
            shift += replacement.chars().count() as isize - (*end - *start) as isize;
        }
        for (start, end, replacement) in sites.iter().rev() {
            first_line = first_line.min(self.apply_edit(*start, *end, replacement));
        }
        let first_line = if first_line == usize::MAX {
            0
        } else {
            first_line
        };
        if !undo.is_empty() {
            self.push_undo(UndoEntry::Multi(undo));
        }
        first_line
    }

    fn push_undo(&mut self, entry: UndoEntry) {
        self.undo_stack.push(entry);
        if self.undo_stack.len() > UNDO_LIMIT {
            self.undo_stack.remove(0);
        }
        self.redo_stack.clear();
    }

    /// The rope/checkpoint half of an edit, without touching the undo stacks — the path
    /// `undo` and `redo` take, swapping the recorded text back in.
    fn apply_edit(&mut self, lo: usize, hi: usize, text: &str) -> usize {
        self.rope.remove(lo..hi);
        self.rope.insert(lo, text);
        let first_line = self.rope.try_char_to_line(lo).unwrap_or(0);
        self.checkpoints.retain(|&line, _| line <= first_line);
        first_line
    }

    /// Swap the most recent edit back out. Returns the 0-based line the change lands on and
    /// the new line count, so the caller can re-window around it.
    pub fn undo(&mut self) -> Option<(usize, usize)> {
        let entry = self.undo_stack.pop()?;
        let first_line = match &entry {
            UndoEntry::Single {
                start_char,
                removed,
                inserted,
            } => {
                let end = start_char + inserted.chars().count();
                self.apply_edit(*start_char, end, removed)
            }
            // Rewind bottom-up: a site's recorded position is unaffected by the sites
            // after it.
            UndoEntry::Multi(sites) => {
                let mut first = usize::MAX;
                for (at, removed, inserted) in sites.iter().rev() {
                    let end = at + inserted.chars().count();
                    first = first.min(self.apply_edit(*at, end, removed));
                }
                first.min(self.line_count().saturating_sub(1))
            }
        };
        self.redo_stack.push(entry);
        Some((first_line, self.line_count()))
    }

    /// Re-apply the most recently undone edit, mirroring `undo`.
    pub fn redo(&mut self) -> Option<(usize, usize)> {
        let entry = self.redo_stack.pop()?;
        let first_line = match &entry {
            UndoEntry::Single {
                start_char,
                removed,
                inserted,
            } => {
                let end = start_char + removed.chars().count();
                self.apply_edit(*start_char, end, inserted)
            }
            // Replay top-down: each site's recorded position already carries the deltas of
            // the sites before it — exactly the ones already replayed when its turn comes.
            UndoEntry::Multi(sites) => {
                let mut first = usize::MAX;
                for (at, removed, inserted) in sites {
                    let end = at + removed.chars().count();
                    first = first.min(self.apply_edit(*at, end, inserted));
                }
                first.min(self.line_count().saturating_sub(1))
            }
        };
        self.undo_stack.push(entry);
        Some((first_line, self.line_count()))
    }

    /// The line the nearest checkpoint at or before `line`'s block sits on (0 when none
    /// exists) — the answer to "how far is the catch-up from here", without cloning any
    /// parse state. `resume_before` resumes from the checkpoint this names.
    pub fn resume_line(&self, line: usize) -> usize {
        let start = line - (line % BLOCK);
        let mut probe = start;
        loop {
            if self.checkpoints.contains_key(&probe) {
                return probe;
            }
            if probe == 0 {
                return 0;
            }
            probe -= BLOCK.min(probe);
        }
    }

    /// The state to resume from: the latest checkpoint at or before `line`'s block, or a fresh
    /// state at the top of the file.
    fn resume_before(&self, line: usize) -> (usize, Checkpoint) {
        let start = line - (line % BLOCK);
        let mut probe = start;
        loop {
            if let Some(cp) = self.checkpoints.get(&probe) {
                return (probe, cp.clone());
            }
            if probe == 0 {
                return (
                    0,
                    Checkpoint {
                        parse: ParseState::new(&self.syntax),
                        stack: ScopeStack::new(),
                    },
                );
            }
            probe -= BLOCK.min(probe);
        }
    }

    /// Highlight lines `start..=end` (0-based, inclusive), checkpointing every block boundary
    /// crossed on the way so later windows resume closer to where they need.
    pub fn highlight_lines(&mut self, start: usize, end: usize) -> Vec<HighlightedLine> {
        let total = self.rope_lines();
        if total == 0 {
            return vec![(String::new(), Vec::new())];
        }
        let start = start.min(total - 1);
        let end = end.min(total - 1);
        let (mut line_no, mut cp) = self.resume_before(start);
        let set = syntax_set();
        let mut new_checkpoints: Vec<(usize, Checkpoint)> = Vec::new();
        let mut out = Vec::with_capacity(end.saturating_sub(start) + 1);
        while line_no <= end {
            if line_no > 0 && line_no % BLOCK == 0 && !self.checkpoints.contains_key(&line_no) {
                new_checkpoints.push((line_no, cp.clone()));
            }
            let text = self.rope.line(line_no).to_string();
            let text = text
                .strip_suffix('\n')
                .map(|t| t.strip_suffix('\r').unwrap_or(t))
                .unwrap_or(&text);
            let parsed = cp.parse.parse_line(text, set).unwrap_or_default();
            // The lines before `start` exist only to advance the parse state: skipping their
            // token extraction (a scope-string clone per span) keeps a long catch-up walk
            // close to the cost of the parse itself.
            let collect = line_no >= start;
            let mut tokens: Vec<Token> = Vec::new();
            // `parse_line` yields `(byte_offset, op)` pairs; the text between two offsets
            // belongs to the stack state *after* the earlier op was applied.
            let mut byte = 0usize;
            let mut cp_offset = 0usize;
            for (pos, op) in parsed {
                if collect && pos > byte {
                    push_token(&mut tokens, &text[byte..pos], cp_offset, &cp.stack);
                    cp_offset += text[byte..pos].chars().count();
                    byte = pos;
                }
                cp.stack.apply(&op).ok();
            }
            if collect && byte < text.len() {
                push_token(&mut tokens, &text[byte..], cp_offset, &cp.stack);
            }
            if collect {
                out.push((text.to_owned(), tokens));
            }
            line_no += 1;
        }
        for (line, checkpoint) in new_checkpoints {
            self.checkpoints.insert(line, checkpoint);
        }
        out
    }
}

/// syntect's default syntax set ships with Sublime's default packages, which have no TypeScript
/// grammar; the TS family falls back to the (shipped) JavaScript syntax so those files still
/// highlight instead of rendering as plain text.
fn fallback_extension(language: &str) -> &'static str {
    match language {
        "ts" | "tsx" | "mts" | "cts" | "jsx" | "mjs" | "cjs" => "js",
        _ => "txt",
    }
}

/// Append a token for `chunk` at code-point offset `offset`, merging with the previous one
/// when the scope is unchanged — keeps the payload the frontend builds small on big files.
fn push_token(tokens: &mut Vec<Token>, chunk: &str, offset: usize, stack: &ScopeStack) {
    let len = chunk.chars().count();
    if len == 0 {
        return;
    }
    let scope = stack.to_string();
    match tokens.last_mut() {
        Some((_, end, prev)) if *end == offset && *prev == scope => *end = offset + len,
        _ => tokens.push((offset, offset + len, scope)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(text: &str, language: &str) -> ViewerDoc {
        ViewerDoc::new(PathBuf::from("test.rs"), text, language)
    }

    #[test]
    fn undo_and_redo_swap_edits_back_and_forth() {
        let mut d = doc("one\ntwo\nthree\n", "txt");
        d.edit(d.offset_of(1, 0), d.offset_of(2, 0), "TWO\nextra\n");
        assert_eq!(d.full_text(), "one\nTWO\nextra\nthree\n");
        // Undo returns to the line the change lands on; the text is exactly restored.
        let (line, count) = d.undo().unwrap();
        assert_eq!(line, 1);
        assert_eq!(count, 4);
        assert_eq!(d.full_text(), "one\ntwo\nthree\n");
        assert!(d.undo().is_none(), "an empty undo stack yields None");
        let (line, _) = d.redo().unwrap();
        assert_eq!(line, 1);
        assert_eq!(d.full_text(), "one\nTWO\nextra\nthree\n");
        // A fresh edit drops the redo stack, as editors do.
        d.edit(d.offset_of(0, 0), d.offset_of(0, 0), "zero\n");
        assert!(d.redo().is_none());
        d.undo().unwrap();
        assert_eq!(d.full_text(), "one\nTWO\nextra\nthree\n");
        d.undo().unwrap();
        assert_eq!(d.full_text(), "one\ntwo\nthree\n");
        // Undo of a pure deletion restores the text.
        d.edit(d.offset_of(0, 0), d.offset_of(1, 0), "");
        assert_eq!(d.full_text(), "two\nthree\n");
        d.undo().unwrap();
        assert_eq!(d.full_text(), "one\ntwo\nthree\n");
    }

    #[test]
    fn replace_sites_is_one_undo_step() {
        // "one\nTWO\nthree\nTWO\n" — replace both "TWO" sites at absolute char offsets.
        let mut d = doc("one\nTWO\nthree\nTWO\n", "txt");
        let first = d.replace_sites(vec![(4, 7, "2".to_owned()), (14, 17, "deux".to_owned())]);
        assert_eq!(first, 1);
        assert_eq!(d.full_text(), "one\n2\nthree\ndeux\n");
        // One undo rewinds the whole replace-all, wherever its sites were.
        let (line, count) = d.undo().unwrap();
        assert_eq!(line, 1);
        assert_eq!(count, 5);
        assert_eq!(d.full_text(), "one\nTWO\nthree\nTWO\n");
        assert!(d.undo().is_none(), "the replace-all is a single undo step");
        // Redo replays every site with the length shifts of the ones before it (the second
        // site's text is longer than its match, so its offset must not drift).
        let (line, _) = d.redo().unwrap();
        assert_eq!(line, 1);
        assert_eq!(d.full_text(), "one\n2\nthree\ndeux\n");
    }

    #[test]
    fn replace_sites_with_no_sites_touches_nothing() {
        let mut d = doc("a\nb\n", "txt");
        assert_eq!(d.replace_sites(Vec::new()), 0);
        assert_eq!(d.full_text(), "a\nb\n");
        assert!(
            d.undo().is_none(),
            "an empty replace-all pushes no undo step"
        );
    }

    #[test]
    fn highlights_rust_scopes() {
        let mut d = doc("fn main() {\n    let x = 1;\n}\n", "rs");
        assert_eq!(d.syntax_name, "Rust");
        let lines = d.highlight_lines(0, 2);
        assert_eq!(lines.len(), 3);
        let scopes: Vec<&str> = lines[0].1.iter().map(|(_, _, s)| s.as_str()).collect();
        assert!(
            scopes.iter().any(|s| s.contains("storage.type.function")),
            "fn should be a function-type scope, got {scopes:?}"
        );
        // Token ranges must tile the line exactly.
        let mut at = 0usize;
        for (start, end, _) in &lines[0].1 {
            assert_eq!(*start, at);
            at = *end;
        }
        assert_eq!(at, lines[0].0.chars().count());
    }

    #[test]
    fn typescript_falls_back_to_javascript() {
        let mut d = doc("const x: number = 1; // note\n", "ts");
        assert_eq!(d.syntax_name, "JavaScript");
        let lines = d.highlight_lines(0, 0);
        let scopes: Vec<&str> = lines[0].1.iter().map(|(_, _, s)| s.as_str()).collect();
        assert!(
            scopes
                .iter()
                .any(|s| s.contains("keyword") || s.contains("comment")),
            "TS source must produce JS scopes, got {scopes:?}"
        );
    }

    #[test]
    fn mid_file_window_matches_full_scan() {
        // 600 lines so windows start beyond the first checkpoint block.
        let text = (0..600)
            .map(|i| format!("let value{i} = {i};\n"))
            .collect::<String>();
        let mut a = doc(&text, "rs");
        let mut b = doc(&text, "rs");
        // Prime checkpoints on `a` by highlighting from the top.
        a.highlight_lines(0, 599);
        let direct = b.highlight_lines(300, 320);
        let resumed = a.highlight_lines(300, 320);
        for ((ta, ka), (tb, kb)) in direct.iter().zip(resumed.iter()) {
            assert_eq!(ta, tb);
            assert_eq!(ka, kb, "checkpoint resume must reproduce the same tokens");
        }
    }

    #[test]
    fn edit_invalidates_and_recounts() {
        let mut d = doc("a\nb\nc\n", "txt");
        let start = d.offset_of(1, 0);
        let end = d.offset_of(2, 0);
        let first_changed = d.edit(start, end, "B edited\nextra\n");
        assert_eq!(first_changed, 1);
        // "a\nb\nc\n" → "a\nB edited\nextra\nc\n" — the trailing newline keeps a final empty
        // line, so 4 lines become 5.
        assert_eq!(d.line_count(), 5);
        assert_eq!(d.line_text(1), "B edited");
        assert_eq!(d.line_text(2), "extra");
    }

    #[test]
    fn offset_of_clamps_out_of_range_positions() {
        // "a\nbc\n" — 5 chars; line 1 ("bc\n") spans offsets 2..5.
        let d = doc("a\nbc\n", "txt");
        assert_eq!(d.offset_of(0, 0), 0);
        assert_eq!(d.offset_of(1, 1), 3);
        // A column past the line's end must stay inside the document instead of panicking
        // on rope.remove/remove bounds in edit().
        assert!(d.offset_of(1, 9999) <= d.rope.len_chars());
        assert!(d.offset_of(9999, 9999) <= d.rope.len_chars());
        assert!(d.offset_of(2, 9999) <= d.rope.len_chars());
        // A huge line/col pair must not panic and must equal the end of the document.
        assert_eq!(d.offset_of(9999, 9999), d.rope.len_chars());
    }

    /// The windowed editor spells "through the end of the file" as `(line_count, 0)`. That
    /// is the document's end even when the last line has text — landing on that line's
    /// *start* instead spliced a replacement of the last line into its own text.
    #[test]
    fn past_the_end_line_is_the_document_end() {
        let mut d = doc("a\nb\nc", "txt");
        assert_eq!(d.line_count(), 3);
        assert_eq!(d.offset_of(3, 0), d.rope.len_chars());
        assert_eq!(
            d.offset_of(2, 0),
            4,
            "the last line's start is still its start"
        );
        // Retype the last line: (2,0)..(3,0) is exactly "c".
        d.edit(d.offset_of(2, 0), d.offset_of(3, 0), "C");
        assert_eq!(d.full_text(), "a\nb\nC");
        // Append after the last line: an empty range at the end.
        d.edit(d.offset_of(3, 0), d.offset_of(3, 0), "\nd");
        assert_eq!(d.full_text(), "a\nb\nC\nd");
        // With a trailing newline the final empty line's start is the end as well.
        let d = doc("a\nb\n", "txt");
        assert_eq!(d.offset_of(2, 0), d.rope.len_chars());
        assert_eq!(d.offset_of(3, 0), d.rope.len_chars());
    }

    #[test]
    fn edit_with_stale_out_of_range_position_does_not_panic() {
        // Simulates the frontend editing against a desynchronized, shorter document.
        let mut d = doc("a\nbc\n", "txt");
        let start = d.offset_of(1, 9999);
        let end = d.offset_of(9999, 9999);
        d.edit(start, end, "X");
        assert_eq!(d.full_text(), "a\nbcX");
    }

    #[test]
    fn large_file_open_and_window() {
        // 100k lines — the smoke test that "instant open" stays instant: building the rope and
        // highlighting one window must not scan the whole file.
        let mut big = String::with_capacity(1_600_000);
        for i in 0..100_000 {
            big.push_str(&format!("let v{i} = {i}; // comment\n"));
        }
        let mut d = doc(&big, "rs");
        assert_eq!(d.line_count(), 100_001); // trailing newline ⇒ +1 empty line
        let window = d.highlight_lines(90_000, 90_040);
        assert_eq!(window.len(), 41);
        assert_eq!(window[0].0, "let v90000 = 90000; // comment");
    }
}
