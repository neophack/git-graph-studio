//! The interactive line editor (module 18): what makes the REPL feel like Git Bash's
//! readline — cursor movement, kill keys, history recall and **Tab completion** of
//! commands, paths, `$VARIABLES` and git subcommands / refs. Pure std: the terminal is
//! put in raw mode only while a line is being read (Win32 console mode on Windows,
//! `stty` elsewhere) and restored before any command runs, so children see a normal
//! terminal. The editing state ([`Editor`]) and the completion engine ([`complete`]) are
//! pure functions over text, which is what the unit tests drive; a stdin that cannot
//! enter raw mode (a pipe, an old console) falls back to plain `read_line`.

use std::io::{Read, Write};
use std::path::Path;

use super::applets::APPLET_NAMES;
use super::builtins::BUILTIN_NAMES;
use super::exec::{Io, Shell};

/* ---------- Raw terminal mode ---------- */

/// Raw mode for the lifetime of the guard; dropping it restores the saved settings.
pub struct RawMode {
    #[cfg(windows)]
    saved: u32,
    #[cfg(unix)]
    saved: String,
}

#[cfg(windows)]
mod sys {
    extern "system" {
        pub fn GetConsoleMode(handle: *mut core::ffi::c_void, mode: *mut u32) -> i32;
        pub fn SetConsoleMode(handle: *mut core::ffi::c_void, mode: u32) -> i32;
        pub fn GetStdHandle(which: i32) -> *mut core::ffi::c_void;
    }
}

impl RawMode {
    #[cfg(windows)]
    pub fn enter() -> Option<RawMode> {
        const PROCESSED_INPUT: u32 = 0x1;
        const LINE_INPUT: u32 = 0x2;
        const ECHO_INPUT: u32 = 0x4;
        const VIRTUAL_TERMINAL_INPUT: u32 = 0x200;
        unsafe {
            let handle = sys::GetStdHandle(-10);
            let mut mode = 0u32;
            if sys::GetConsoleMode(handle, &mut mode) == 0 {
                return None;
            }
            let raw =
                (mode & !(PROCESSED_INPUT | LINE_INPUT | ECHO_INPUT)) | VIRTUAL_TERMINAL_INPUT;
            if sys::SetConsoleMode(handle, raw) == 0 {
                return None;
            }
            Some(RawMode { saved: mode })
        }
    }

    #[cfg(unix)]
    pub fn enter() -> Option<RawMode> {
        use std::process::{Command, Stdio};
        let saved = Command::new("stty")
            .arg("-g")
            .stdin(Stdio::inherit())
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())?;
        let status = Command::new("stty")
            .args(["-icanon", "-echo", "-isig", "min", "1"])
            .stdin(Stdio::inherit())
            .status()
            .ok()?;
        status.success().then_some(RawMode { saved })
    }
}

impl Drop for RawMode {
    #[cfg(windows)]
    fn drop(&mut self) {
        unsafe {
            let handle = sys::GetStdHandle(-10);
            sys::SetConsoleMode(handle, self.saved);
        }
    }

    #[cfg(unix)]
    fn drop(&mut self) {
        let _ = std::process::Command::new("stty")
            .arg(&self.saved)
            .stdin(std::process::Stdio::inherit())
            .status();
    }
}

/* ---------- The editing state ---------- */

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Enter,
    Backspace,
    Delete,
    Left,
    Right,
    WordLeft,
    WordRight,
    Home,
    End,
    Up,
    Down,
    KillToEnd,
    KillToStart,
    KillWord,
    ClearScreen,
    Tab,
    /// Ctrl-R: reverse incremental history search.
    Search,
    Interrupt,
    /// Ctrl-D: EOF on an empty line, delete-under-cursor otherwise.
    Eof,
    Other,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Continue,
    Submit,
    Interrupt,
    Eof,
    Tab,
    ClearScreen,
    Search,
}

/// The line being edited: characters, cursor, and the history walk.
#[derive(Default)]
pub struct Editor {
    pub buf: Vec<char>,
    pub cursor: usize,
    /// Index into the history while walking it (`None` = the live line).
    walk: Option<usize>,
    /// The live line stashed when the walk started.
    stash: Vec<char>,
}

impl Editor {
    pub fn text(&self) -> String {
        self.buf.iter().collect()
    }

    pub fn before_cursor(&self) -> String {
        self.buf[..self.cursor].iter().collect()
    }

    fn set(&mut self, text: &str) {
        self.buf = text.chars().collect();
        self.cursor = self.buf.len();
    }

    /// Replace the characters from `start` to the cursor with `text`.
    pub fn replace_word(&mut self, start: usize, text: &str) {
        let replacement: Vec<char> = text.chars().collect();
        self.buf
            .splice(start..self.cursor, replacement.iter().copied());
        self.cursor = start + replacement.len();
    }

    fn word_left(&self) -> usize {
        let mut at = self.cursor;
        while at > 0 && self.buf[at - 1].is_whitespace() {
            at -= 1;
        }
        while at > 0 && !self.buf[at - 1].is_whitespace() {
            at -= 1;
        }
        at
    }

    fn word_right(&self) -> usize {
        let mut at = self.cursor;
        while at < self.buf.len() && self.buf[at].is_whitespace() {
            at += 1;
        }
        while at < self.buf.len() && !self.buf[at].is_whitespace() {
            at += 1;
        }
        at
    }

    pub fn apply(&mut self, key: Key, history: &[String]) -> Outcome {
        match key {
            Key::Char(c) => {
                self.buf.insert(self.cursor, c);
                self.cursor += 1;
            }
            Key::Enter => return Outcome::Submit,
            Key::Backspace => {
                if self.cursor > 0 {
                    self.cursor -= 1;
                    self.buf.remove(self.cursor);
                }
            }
            Key::Delete => {
                if self.cursor < self.buf.len() {
                    self.buf.remove(self.cursor);
                }
            }
            Key::Left => self.cursor = self.cursor.saturating_sub(1),
            Key::Right => self.cursor = (self.cursor + 1).min(self.buf.len()),
            Key::WordLeft => self.cursor = self.word_left(),
            Key::WordRight => self.cursor = self.word_right(),
            Key::Home => self.cursor = 0,
            Key::End => self.cursor = self.buf.len(),
            Key::KillToEnd => self.buf.truncate(self.cursor),
            Key::KillToStart => {
                self.buf.drain(..self.cursor);
                self.cursor = 0;
            }
            Key::KillWord => {
                let start = self.word_left();
                self.buf.drain(start..self.cursor);
                self.cursor = start;
            }
            Key::Up => {
                if history.is_empty() {
                    return Outcome::Continue;
                }
                let next = match self.walk {
                    None => {
                        self.stash = self.buf.clone();
                        history.len() - 1
                    }
                    Some(0) => 0,
                    Some(at) => at - 1,
                };
                self.walk = Some(next);
                self.set(&history[next]);
            }
            Key::Down => match self.walk {
                None => {}
                Some(at) if at + 1 < history.len() => {
                    self.walk = Some(at + 1);
                    self.set(&history[at + 1]);
                }
                Some(_) => {
                    self.walk = None;
                    self.buf = std::mem::take(&mut self.stash);
                    self.cursor = self.buf.len();
                }
            },
            Key::Tab => return Outcome::Tab,
            Key::Search => return Outcome::Search,
            Key::ClearScreen => return Outcome::ClearScreen,
            Key::Interrupt => return Outcome::Interrupt,
            Key::Eof => {
                if self.buf.is_empty() {
                    return Outcome::Eof;
                }
                if self.cursor < self.buf.len() {
                    self.buf.remove(self.cursor);
                }
            }
            Key::Other => {}
        }
        Outcome::Continue
    }
}

/* ---------- Key decoding ---------- */

fn next_byte(input: &mut impl Read) -> Option<u8> {
    let mut one = [0u8; 1];
    match input.read(&mut one) {
        Ok(1) => Some(one[0]),
        _ => None,
    }
}

/// Decode one key from the byte stream; `None` = the stream ended.
pub fn read_key(input: &mut impl Read) -> Option<Key> {
    let first = next_byte(input)?;
    Some(match first {
        b'\r' | b'\n' => Key::Enter,
        b'\t' => Key::Tab,
        0x7f | 0x08 => Key::Backspace,
        0x01 => Key::Home,
        0x02 => Key::Left,
        0x03 => Key::Interrupt,
        0x04 => Key::Eof,
        0x05 => Key::End,
        0x06 => Key::Right,
        0x0b => Key::KillToEnd,
        0x0c => Key::ClearScreen,
        0x0e => Key::Down,
        0x10 => Key::Up,
        0x12 => Key::Search,
        0x15 => Key::KillToStart,
        0x17 => Key::KillWord,
        0x1b => return read_escape(input),
        b if b < 0x20 => Key::Other,
        b if b < 0x80 => Key::Char(b as char),
        lead => {
            // A UTF-8 sequence: the lead byte says how many continuation bytes follow.
            let extra = match lead {
                0xc0..=0xdf => 1,
                0xe0..=0xef => 2,
                0xf0..=0xf7 => 3,
                _ => return Some(Key::Other),
            };
            let mut bytes = vec![lead];
            for _ in 0..extra {
                bytes.push(next_byte(input)?);
            }
            match std::str::from_utf8(&bytes)
                .ok()
                .and_then(|s| s.chars().next())
            {
                Some(c) => Key::Char(c),
                None => Key::Other,
            }
        }
    })
}

fn read_escape(input: &mut impl Read) -> Option<Key> {
    let second = next_byte(input)?;
    Some(match second {
        b'[' => {
            let mut params = String::new();
            loop {
                let byte = next_byte(input)?;
                if (0x40..=0x7e).contains(&byte) {
                    break csi_key(&params, byte as char);
                }
                params.push(byte as char);
            }
        }
        b'O' => match next_byte(input)? {
            b'A' => Key::Up,
            b'B' => Key::Down,
            b'C' => Key::Right,
            b'D' => Key::Left,
            b'H' => Key::Home,
            b'F' => Key::End,
            _ => Key::Other,
        },
        b'b' => Key::WordLeft,
        b'f' => Key::WordRight,
        b'd' => Key::Other,
        0x7f => Key::KillWord,
        _ => Key::Other,
    })
}

fn csi_key(params: &str, final_byte: char) -> Key {
    // A modifier (`1;5C` = Ctrl-Right) turns the arrows into word motion.
    let modified = params.contains(';');
    match final_byte {
        'A' => Key::Up,
        'B' => Key::Down,
        'C' if modified => Key::WordRight,
        'D' if modified => Key::WordLeft,
        'C' => Key::Right,
        'D' => Key::Left,
        'H' => Key::Home,
        'F' => Key::End,
        '~' => match params.split(';').next().unwrap_or("") {
            "1" | "7" => Key::Home,
            "4" | "8" => Key::End,
            "3" => Key::Delete,
            _ => Key::Other,
        },
        _ => Key::Other,
    }
}

/* ---------- Rendering ---------- */

fn char_width(c: char) -> usize {
    let n = c as u32;
    let wide = (0x1100..=0x115f).contains(&n)
        || (0x2e80..=0xa4cf).contains(&n)
        || (0xac00..=0xd7a3).contains(&n)
        || (0xf900..=0xfaff).contains(&n)
        || (0xfe30..=0xfe6f).contains(&n)
        || (0xff00..=0xff60).contains(&n)
        || (0xffe0..=0xffe6).contains(&n)
        || (0x20000..=0x3fffd).contains(&n);
    if wide {
        2
    } else {
        1
    }
}

fn width_of(chars: &[char]) -> usize {
    chars.iter().map(|&c| char_width(c)).sum()
}

/// The visible width of a prompt's last line (ANSI escapes stripped).
pub fn prompt_width(prompt: &str) -> usize {
    let last = prompt.rsplit('\n').next().unwrap_or("");
    let mut width = 0;
    let mut chars = last.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Skip a CSI sequence up to its final byte.
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) && next != '[' {
                    break;
                }
            }
        } else {
            width += char_width(c);
        }
    }
    width
}

fn redraw(out: &mut impl Write, width: usize, editor: &Editor) {
    let mut frame = String::from("\r");
    if width > 0 {
        frame.push_str(&format!("\x1b[{width}C"));
    }
    frame.push_str(&editor.text());
    frame.push_str("\x1b[K");
    let back = width_of(&editor.buf[editor.cursor..]);
    if back > 0 {
        frame.push_str(&format!("\x1b[{back}D"));
    }
    let _ = out.write_all(frame.as_bytes());
    let _ = out.flush();
}

/// The candidates as a column-major grid sized to the terminal.
pub fn format_columns(items: &[String], columns: usize) -> String {
    let cell = items.iter().map(|s| s.chars().count()).max().unwrap_or(0) + 2;
    let per_row = (columns / cell.max(1)).max(1);
    let rows = items.len().div_ceil(per_row);
    let mut out = String::new();
    for row in 0..rows {
        for col in 0..per_row {
            if let Some(item) = items.get(col * rows + row) {
                let pad = cell - item.chars().count();
                out.push_str(item);
                if col * rows + row + rows < items.len() {
                    out.push_str(&" ".repeat(pad));
                }
            }
        }
        out.push_str("\r\n");
    }
    out
}

/* ---------- Reading a line ---------- */

pub enum ReadLine {
    Line(String),
    Eof,
    Interrupted,
    Failed,
}

/// Print `prompt` and read one line. On a raw-capable terminal this is the full editor;
/// otherwise a plain buffered `read_line` (the prompt still printed through `io`).
pub fn read_line(shell: &Shell, prompt: &str, io: &Io) -> ReadLine {
    let raw = RawMode::enter();
    if raw.is_none() {
        io.out_str(prompt);
        let mut line = String::new();
        return match std::io::stdin().read_line(&mut line) {
            Ok(0) => ReadLine::Eof,
            Ok(_) => ReadLine::Line(line),
            Err(_) => ReadLine::Failed,
        };
    }
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut out = std::io::stdout();
    let _ = out.write_all(prompt.as_bytes());
    let _ = out.flush();
    let width = prompt_width(prompt);
    let columns = std::env::var("COLUMNS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&c| c >= 20)
        .unwrap_or(80);
    let mut editor = Editor::default();
    loop {
        let Some(key) = read_key(&mut input) else {
            return ReadLine::Eof;
        };
        let at_end = editor.cursor == editor.buf.len();
        let appending_char = matches!(&key, Key::Char(_)) && at_end;
        let before = editor.buf.len();
        match editor.apply(key.clone(), &shell.history) {
            Outcome::Submit => {
                let _ = out.write_all(b"\r\n");
                let _ = out.flush();
                return ReadLine::Line(format!("{}\n", editor.text()));
            }
            Outcome::Interrupt => {
                let _ = out.write_all(b"^C\r\n");
                let _ = out.flush();
                return ReadLine::Interrupted;
            }
            Outcome::Eof => return ReadLine::Eof,
            Outcome::Search => {
                match reverse_search(&mut input, &mut out, &shell.history, &mut editor) {
                    SearchEnd::Submit => {
                        let _ = out.write_all(b"\r\n");
                        let _ = out.flush();
                        return ReadLine::Line(format!("{}\n", editor.text()));
                    }
                    SearchEnd::Edit => {}
                    SearchEnd::Eof => return ReadLine::Eof,
                }
                let _ = out.write_all(b"\r\x1b[K");
                let _ = out.write_all(prompt.rsplit('\n').next().unwrap_or("").as_bytes());
                redraw(&mut out, width, &editor);
            }
            Outcome::ClearScreen => {
                let _ = out.write_all(b"\x1b[2J\x1b[H");
                let _ = out.write_all(prompt.rsplit('\n').next().unwrap_or("").as_bytes());
                redraw(&mut out, width, &editor);
            }
            Outcome::Tab => {
                let prefix = editor.before_cursor();
                let found = complete(shell, &prefix);
                match found.candidates.len() {
                    0 => {
                        let _ = out.write_all(b"\x07");
                    }
                    1 => {
                        let c = &found.candidates[0];
                        let mut text = c.insert.clone();
                        if !c.is_dir {
                            text.push_str(&found.closer);
                        }
                        editor.replace_word(found.start, &text);
                    }
                    _ => {
                        let common = common_prefix(&found.candidates);
                        let typed = prefix.chars().count() - found.start;
                        if common.chars().count() > typed {
                            editor.replace_word(found.start, &common);
                        } else {
                            let shown: Vec<String> =
                                found.candidates.iter().map(|c| c.shown.clone()).collect();
                            let _ = out.write_all(b"\r\n");
                            let _ = out.write_all(format_columns(&shown, columns).as_bytes());
                            let _ = out.write_all(prompt.as_bytes());
                        }
                    }
                }
                redraw(&mut out, width, &editor);
            }
            Outcome::Continue => {
                if appending_char && editor.buf.len() == before + 1 {
                    // The common case — typing at the end — echoes just the character.
                    if let Some(c) = editor.buf.last() {
                        let mut buf = [0u8; 4];
                        let _ = out.write_all(c.encode_utf8(&mut buf).as_bytes());
                        let _ = out.flush();
                    }
                } else {
                    redraw(&mut out, width, &editor);
                }
            }
        }
    }
}

enum SearchEnd {
    /// Enter: run the matched line at once.
    Submit,
    /// Any other key: the match lands in the editor for further editing.
    Edit,
    Eof,
}

/// Ctrl-R: `(reverse-i-search)`query': match`. Typing narrows, Ctrl-R steps to the next
/// older match, Backspace widens, Enter runs, Ctrl-C / Esc leave the line as it was,
/// anything else accepts the match for editing.
fn reverse_search(
    input: &mut impl Read,
    out: &mut impl Write,
    history: &[String],
    editor: &mut Editor,
) -> SearchEnd {
    let original = editor.buf.clone();
    let mut query = String::new();
    let mut found: Option<usize> = None;
    loop {
        let shown = found.map(|i| history[i].as_str()).unwrap_or("");
        let _ = write!(out, "\r\x1b[K(reverse-i-search)`{query}': {shown}");
        let _ = out.flush();
        let Some(key) = read_key(input) else {
            return SearchEnd::Eof;
        };
        let accept = |editor: &mut Editor, found: Option<usize>| {
            if let Some(i) = found {
                editor.buf = history[i].chars().collect();
                editor.cursor = editor.buf.len();
            }
        };
        match key {
            Key::Char(c) => {
                query.push(c);
                // The current match stays a candidate: it may still contain the query.
                let from = found.map(|i| i + 1).unwrap_or(history.len());
                found = find_back(history, &query, from);
            }
            Key::Backspace => {
                query.pop();
                found = find_back(history, &query, history.len());
            }
            Key::Search => {
                let from = found.unwrap_or(history.len());
                found = find_back(history, &query, from).or(found);
            }
            Key::Enter => {
                accept(editor, found);
                return SearchEnd::Submit;
            }
            Key::Interrupt | Key::Other => {
                editor.buf = original;
                editor.cursor = editor.buf.len();
                return SearchEnd::Edit;
            }
            _ => {
                accept(editor, found);
                return SearchEnd::Edit;
            }
        }
    }
}

/// The newest history index below `before` whose line contains `query` (an empty query
/// matches nothing, like readline's).
fn find_back(history: &[String], query: &str, before: usize) -> Option<usize> {
    if query.is_empty() {
        return None;
    }
    (0..before.min(history.len()))
        .rev()
        .find(|&i| history[i].contains(query))
}

/// Bash's history expansion on a submitted line: `!!`, `!$`, `!^`, `!*`, `!n`, `!-n`,
/// `!prefix`, `!?text`. Single quotes and a backslash keep a bang literal, as does a
/// bang before a space, `=` or `(`. `Ok(None)` = nothing expanded; `Err` = event not found.
pub fn expand_history(line: &str, history: &[String]) -> Result<Option<String>, String> {
    if !line.contains('!') {
        return Ok(None);
    }
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::new();
    let mut changed = false;
    let mut in_single = false;
    let mut at = 0;
    let words_of =
        |entry: &str| -> Vec<String> { entry.split_whitespace().map(str::to_owned).collect() };
    while at < chars.len() {
        let c = chars[at];
        if c == '\\' && at + 1 < chars.len() {
            out.push(c);
            out.push(chars[at + 1]);
            at += 2;
            continue;
        }
        if c == '\'' {
            in_single = !in_single;
        }
        if c != '!' || in_single {
            out.push(c);
            at += 1;
            continue;
        }
        let (replacement, used) = match chars.get(at + 1).copied() {
            None | Some(' ') | Some('\t') | Some('=') | Some('(') | Some('\n') | Some('\r') => {
                out.push(c);
                at += 1;
                continue;
            }
            Some('!') => (history.last().cloned().ok_or("!!: event not found")?, 2),
            Some('$') => {
                let entry = history.last().ok_or("!$: event not found")?;
                (words_of(entry).last().cloned().unwrap_or_default(), 2)
            }
            Some('^') => {
                let entry = history.last().ok_or("!^: event not found")?;
                (words_of(entry).get(1).cloned().unwrap_or_default(), 2)
            }
            Some('*') => {
                let entry = history.last().ok_or("!*: event not found")?;
                let words = words_of(entry);
                (words[1.min(words.len())..].join(" "), 2)
            }
            Some(first) => {
                let mut end = at + 1;
                if first == '-' || first == '?' {
                    end += 1;
                }
                while end < chars.len()
                    && !chars[end].is_whitespace()
                    && !matches!(chars[end], ';' | '|' | '&')
                {
                    end += 1;
                }
                let spec: String = chars[at + 1..end].iter().collect();
                let entry = if let Some(text) = spec.strip_prefix('?') {
                    let text = text.trim_end_matches('?');
                    history.iter().rev().find(|h| h.contains(text))
                } else if let Some(n) = spec.strip_prefix('-').and_then(|n| n.parse::<usize>().ok())
                {
                    history.len().checked_sub(n).and_then(|i| history.get(i))
                } else if let Ok(n) = spec.parse::<usize>() {
                    n.checked_sub(1).and_then(|i| history.get(i))
                } else {
                    history.iter().rev().find(|h| h.starts_with(&spec))
                };
                (
                    entry.cloned().ok_or(format!("!{spec}: event not found"))?,
                    end - at,
                )
            }
        };
        out.push_str(&replacement);
        changed = true;
        at += used;
    }
    Ok(changed.then_some(out))
}

fn common_prefix(candidates: &[Candidate]) -> String {
    let mut iter = candidates.iter().map(|c| c.insert.as_str());
    let Some(first) = iter.next() else {
        return String::new();
    };
    let mut common: Vec<char> = first.chars().collect();
    for next in iter {
        let keep = common
            .iter()
            .zip(next.chars())
            .take_while(|(a, b)| **a == *b)
            .count();
        common.truncate(keep);
    }
    common.into_iter().collect()
}

/* ---------- Completion ---------- */

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// What replaces the typed word (already escaped for the shell).
    pub insert: String,
    /// What the candidate list shows.
    pub shown: String,
    pub is_dir: bool,
}

#[derive(Debug, Default)]
pub struct Completion {
    /// Char index in the line where the replaced word starts.
    pub start: usize,
    pub candidates: Vec<Candidate>,
    /// The closing quote a unique file completion appends inside an open quote.
    pub closer: String,
}

/// What the scanner learned about the text before the cursor.
struct Scan {
    /// Completed words of the current simple command (unquoted values).
    words: Vec<String>,
    /// The word under the cursor, unquoted.
    cur: String,
    /// Char index of its first character (after an opening quote).
    start: usize,
    quote: Option<char>,
    after_redirect: bool,
}

fn scan(prefix: &str) -> Scan {
    let chars: Vec<char> = prefix.chars().collect();
    let mut words: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut start = 0;
    let mut quote: Option<char> = None;
    let mut after_redirect = false;
    let mut in_word = false;
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else if q == '"' && c == '\\' && at + 1 < chars.len() {
                    at += 1;
                    cur.push(chars[at]);
                } else {
                    cur.push(c);
                }
            }
            None => match c {
                '\\' if at + 1 < chars.len() => {
                    if !in_word {
                        in_word = true;
                        start = at;
                    }
                    at += 1;
                    cur.push(chars[at]);
                }
                '\'' | '"' => {
                    if !in_word {
                        in_word = true;
                        start = at + 1;
                    }
                    quote = Some(c);
                }
                ' ' | '\t' => {
                    if in_word {
                        if !after_redirect {
                            words.push(std::mem::take(&mut cur));
                        } else {
                            cur.clear();
                        }
                        after_redirect = false;
                        in_word = false;
                    }
                }
                '|' | ';' | '&' | '(' => {
                    words.clear();
                    cur.clear();
                    in_word = false;
                    after_redirect = false;
                }
                '<' | '>' => {
                    cur.clear();
                    in_word = false;
                    after_redirect = true;
                }
                _ => {
                    if !in_word {
                        in_word = true;
                        start = at;
                    }
                    cur.push(c);
                }
            },
        }
        at += 1;
    }
    if !in_word {
        start = chars.len();
        cur.clear();
    }
    Scan {
        words,
        cur,
        start,
        quote,
        after_redirect,
    }
}

const GIT_SUBCOMMANDS: &[&str] = &[
    "add",
    "am",
    "apply",
    "bisect",
    "blame",
    "branch",
    "checkout",
    "cherry-pick",
    "clean",
    "clone",
    "commit",
    "config",
    "describe",
    "diff",
    "fetch",
    "format-patch",
    "gc",
    "grep",
    "init",
    "log",
    "ls-files",
    "merge",
    "mv",
    "pull",
    "push",
    "rebase",
    "reflog",
    "remote",
    "reset",
    "restore",
    "revert",
    "rm",
    "show",
    "stash",
    "status",
    "submodule",
    "switch",
    "tag",
    "worktree",
];

/// Subcommands whose first operands are refs (branches, tags, remotes).
const GIT_REF_COMMANDS: &[&str] = &[
    "checkout",
    "switch",
    "merge",
    "rebase",
    "branch",
    "cherry-pick",
    "diff",
    "log",
    "show",
    "reset",
    "revert",
    "push",
    "pull",
    "fetch",
    "tag",
];

pub fn complete(shell: &Shell, prefix: &str) -> Completion {
    let scanned = scan(prefix);
    let mut result = Completion {
        start: scanned.start,
        ..Completion::default()
    };
    let cur = scanned.cur.as_str();
    result.closer = match scanned.quote {
        Some(q) => q.to_string(),
        None => " ".to_owned(),
    };
    let command_position = scanned.words.is_empty() && !scanned.after_redirect;

    // $VARIABLE names.
    if scanned.quote != Some('\'') {
        if let Some(name) = cur.strip_prefix('$') {
            if !name.contains(['/', '"']) {
                let mut names: Vec<String> = shell
                    .vars
                    .keys()
                    .filter(|key| key.starts_with(name))
                    .cloned()
                    .collect();
                names.sort();
                names.dedup();
                result.candidates = names
                    .into_iter()
                    .map(|n| Candidate {
                        insert: format!("${n}"),
                        shown: n,
                        is_dir: false,
                    })
                    .collect();
                return result;
            }
        }
    }

    let program = scanned.words.first().map(|w| {
        w.rsplit(['/', '\\'])
            .next()
            .unwrap_or(w)
            .trim_end_matches(".exe")
            .to_owned()
    });

    if command_position && !cur.is_empty() && !cur.contains('/') && !cur.starts_with(['.', '~']) {
        result.candidates = command_candidates(shell, cur);
        return result;
    }

    if program.as_deref() == Some("git") && !cur.starts_with('-') && !cur.contains('/') {
        if scanned.words.len() == 1 {
            result.candidates = GIT_SUBCOMMANDS
                .iter()
                .filter(|s| s.starts_with(cur))
                .map(|s| plain(s))
                .collect();
            if !result.candidates.is_empty() {
                return result;
            }
        } else if scanned
            .words
            .get(1)
            .is_some_and(|sub| GIT_REF_COMMANDS.contains(&sub.as_str()))
        {
            let mut refs = git_refs(shell, cur);
            let mut paths = path_candidates(shell, cur, false, scanned.quote.is_some());
            refs.append(&mut paths);
            if !refs.is_empty() {
                result.candidates = refs;
                return result;
            }
        }
    }

    let dirs_only = matches!(
        program.as_deref(),
        Some("cd") | Some("pushd") | Some("rmdir")
    );
    result.candidates = path_candidates(shell, cur, dirs_only, scanned.quote.is_some());
    result
}

fn plain(name: &str) -> Candidate {
    Candidate {
        insert: name.to_owned(),
        shown: name.to_owned(),
        is_dir: false,
    }
}

fn command_candidates(shell: &Shell, prefix: &str) -> Vec<Candidate> {
    let mut names: Vec<String> = Vec::new();
    names.extend(BUILTIN_NAMES.iter().map(|s| (*s).to_owned()));
    names.extend(APPLET_NAMES.iter().map(|s| (*s).to_owned()));
    names.extend(
        ["bash", "sh", "less", "more"]
            .iter()
            .map(|s| (*s).to_owned()),
    );
    names.extend(shell.funcs.keys().cloned());
    names.extend(shell.aliases.keys().cloned());
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(str::to_lowercase)
            .collect()
    } else {
        Vec::new()
    };
    for dir in super::exec::split_path_list(&shell.path_var()) {
        let dir = super::msys::from_msys(&dir);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_executable(&entry.path(), &name, &extensions) {
                continue;
            }
            let stem = if cfg!(windows) {
                match Path::new(&name).file_stem() {
                    Some(stem) => stem.to_string_lossy().into_owned(),
                    None => continue,
                }
            } else {
                name
            };
            names.push(stem);
        }
    }
    let ci = cfg!(windows);
    let wanted = if ci {
        prefix.to_lowercase()
    } else {
        prefix.to_owned()
    };
    names.retain(|n| {
        if ci {
            n.to_lowercase().starts_with(&wanted)
        } else {
            n.starts_with(&wanted)
        }
    });
    names.sort();
    names.dedup();
    names.truncate(1000);
    names.iter().map(|n| plain(n)).collect()
}

#[cfg(windows)]
fn is_executable(path: &Path, _name: &str, extensions: &[String]) -> bool {
    path.extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .is_some_and(|e| extensions.contains(&e))
}

#[cfg(unix)]
fn is_executable(path: &Path, _name: &str, _extensions: &[String]) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn git_refs(shell: &Shell, prefix: &str) -> Vec<Candidate> {
    let output = std::process::Command::new("git")
        .args([
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ])
        .current_dir(&shell.cwd)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    let mut refs: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| line.starts_with(prefix) && !line.ends_with("/HEAD"))
        .map(str::to_owned)
        .collect();
    refs.sort();
    refs.dedup();
    refs.truncate(500);
    refs.iter().map(|r| plain(r)).collect()
}

fn escape_for_shell(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if " \t'\"()&;|<>$`!*?[]#{}\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn path_candidates(shell: &Shell, cur: &str, dirs_only: bool, quoted: bool) -> Vec<Candidate> {
    let (dir_part, name_prefix) = match cur.rfind('/') {
        Some(at) => (&cur[..=at], &cur[at + 1..]),
        None => ("", cur),
    };
    let lookup = if let Some(rest) = dir_part.strip_prefix('~') {
        match shell.get_var("HOME") {
            Some(home) => format!("{home}{rest}"),
            None => return Vec::new(),
        }
    } else if dir_part.is_empty() {
        ".".to_owned()
    } else {
        dir_part.to_owned()
    };
    let dir = shell.resolve_working_path(&lookup);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let ci = cfg!(windows);
    let wanted = if ci {
        name_prefix.to_lowercase()
    } else {
        name_prefix.to_owned()
    };
    let show_hidden = name_prefix.starts_with('.');
    let mut found: Vec<Candidate> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && !show_hidden {
            continue;
        }
        let matches = if ci {
            name.to_lowercase().starts_with(&wanted)
        } else {
            name.starts_with(&wanted)
        };
        if !matches {
            continue;
        }
        let is_dir = entry.path().is_dir();
        if dirs_only && !is_dir {
            continue;
        }
        let mut insert = if quoted {
            format!("{dir_part}{name}")
        } else {
            format!("{}{}", dir_part, escape_for_shell(&name))
        };
        let mut shown = name;
        if is_dir {
            insert.push('/');
            shown.push('/');
        }
        found.push(Candidate {
            insert,
            shown,
            is_dir,
        });
        if found.len() >= 1000 {
            break;
        }
    }
    found.sort_by(|a, b| a.shown.cmp(&b.shown));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(editor: &mut Editor, text: &str) {
        for c in text.chars() {
            editor.apply(Key::Char(c), &[]);
        }
    }

    fn decode(bytes: &[u8]) -> Vec<Key> {
        let mut input = bytes;
        let mut out = Vec::new();
        while let Some(key) = read_key(&mut input) {
            out.push(key);
        }
        out
    }

    #[test]
    fn editing_keys_move_and_kill() {
        let mut e = Editor::default();
        keys(&mut e, "echo hello world");
        e.apply(Key::WordLeft, &[]);
        assert_eq!(e.cursor, 11);
        e.apply(Key::KillWord, &[]);
        assert_eq!(e.text(), "echo world");
        e.apply(Key::Home, &[]);
        e.apply(Key::Delete, &[]);
        assert_eq!(e.text(), "cho world");
        e.apply(Key::End, &[]);
        e.apply(Key::Backspace, &[]);
        assert_eq!(e.text(), "cho worl");
        e.apply(Key::KillToStart, &[]);
        assert_eq!(e.text(), "");
        assert_eq!(e.apply(Key::Eof, &[]), Outcome::Eof);
    }

    #[test]
    fn history_walk_restores_the_live_line() {
        let history = vec!["ls".to_owned(), "pwd".to_owned()];
        let mut e = Editor::default();
        keys(&mut e, "ec");
        e.apply(Key::Up, &history);
        assert_eq!(e.text(), "pwd");
        e.apply(Key::Up, &history);
        assert_eq!(e.text(), "ls");
        e.apply(Key::Up, &history);
        assert_eq!(e.text(), "ls");
        e.apply(Key::Down, &history);
        e.apply(Key::Down, &history);
        assert_eq!(e.text(), "ec");
    }

    #[test]
    fn escape_sequences_decode() {
        assert_eq!(
            decode(b"\x1b[A\x1b[B\x1b[C\x1b[D\x1b[3~\x1b[H\x1bOF\x1b[1;5C"),
            vec![
                Key::Up,
                Key::Down,
                Key::Right,
                Key::Left,
                Key::Delete,
                Key::Home,
                Key::End,
                Key::WordRight
            ]
        );
        assert_eq!(
            decode("a\t\r\u{4e2d}\x7f".as_bytes()),
            vec![
                Key::Char('a'),
                Key::Tab,
                Key::Enter,
                Key::Char('中'),
                Key::Backspace
            ]
        );
    }

    #[test]
    fn prompt_width_ignores_ansi_and_earlier_lines() {
        assert_eq!(prompt_width("\x1b[32muser\x1b[0m host\n$ "), 2);
    }

    #[test]
    fn scan_tracks_words_quotes_and_commands() {
        let s = scan("echo hi | grep fo");
        assert_eq!(s.words, vec!["grep"]);
        assert_eq!(s.cur, "fo");
        let s = scan("cat \"my fi");
        assert_eq!(s.cur, "my fi");
        assert_eq!(s.quote, Some('"'));
        assert_eq!(s.start, 5);
        let s = scan("ls my\\ fi");
        assert_eq!(s.cur, "my fi");
        let s = scan("echo > ou");
        assert!(s.after_redirect);
    }

    #[test]
    fn paths_complete_with_escapes_and_directories() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("sample file.txt"), "").unwrap();
        std::fs::write(dir.path().join(".hidden"), "").unwrap();
        let mut shell = Shell::new("ggs-bash");
        shell.cwd = dir.path().to_path_buf();
        let done = complete(&shell, "cat s");
        let inserts: Vec<&str> = done.candidates.iter().map(|c| c.insert.as_str()).collect();
        assert_eq!(inserts, vec!["sample\\ file.txt", "src/"]);
        assert_eq!(done.start, 4);
        let done = complete(&shell, "cd s");
        assert_eq!(done.candidates.len(), 1);
        assert!(done.candidates[0].is_dir);
        let done = complete(&shell, "ls ");
        assert!(done.candidates.iter().all(|c| !c.insert.starts_with('.')));
        let done = complete(&shell, "ls .h");
        assert_eq!(done.candidates.len(), 1);
        let done = complete(&shell, "ls src/");
        assert!(done.candidates.is_empty());
    }

    #[test]
    fn commands_variables_and_git_subcommands_complete() {
        let mut shell = Shell::new("ggs-bash");
        shell.set_var("GGS_TAB_VAR", "1");
        let done = complete(&shell, "ech");
        assert!(done.candidates.iter().any(|c| c.insert == "echo"));
        let done = complete(&shell, "echo hi | gre");
        assert!(done.candidates.iter().any(|c| c.insert == "grep"));
        let done = complete(&shell, "echo $GGS_TAB");
        assert_eq!(done.candidates[0].insert, "$GGS_TAB_VAR");
        let done = complete(&shell, "git sta");
        let inserts: Vec<&str> = done.candidates.iter().map(|c| c.insert.as_str()).collect();
        assert!(inserts.contains(&"status") && inserts.contains(&"stash"));
        // bash, sh, less and more are commands of this shell.
        for name in ["bash", "less"] {
            assert!(complete(&shell, &name[..2])
                .candidates
                .iter()
                .any(|c| c.insert == name));
        }
    }

    #[test]
    fn history_expansion_and_search_helpers() {
        let h = vec!["git status".to_owned(), "ls -la /tmp".to_owned()];
        let x = |l: &str| expand_history(l, &h);
        assert_eq!(x("echo !$").unwrap().unwrap(), "echo /tmp");
        assert_eq!(x("!!").unwrap().unwrap(), "ls -la /tmp");
        assert_eq!(x("sudo !!").unwrap().unwrap(), "sudo ls -la /tmp");
        assert_eq!(x("!git").unwrap().unwrap(), "git status");
        assert_eq!(x("!1").unwrap().unwrap(), "git status");
        assert_eq!(x("!-2").unwrap().unwrap(), "git status");
        assert_eq!(x("!?tmp").unwrap().unwrap(), "ls -la /tmp");
        assert_eq!(x("echo !^").unwrap().unwrap(), "echo -la");
        assert_eq!(x("echo 'a!!' \\!! hi! x").unwrap(), None);
        assert!(x("!nope").is_err());
        assert_eq!(find_back(&h, "git", 2), Some(0));
        assert_eq!(find_back(&h, "l", 2), Some(1));
        assert_eq!(find_back(&h, "", 2), None);
    }

    #[test]
    fn reverse_search_finds_steps_and_runs() {
        let h = vec![
            "make test".to_owned(),
            "make build".to_owned(),
            "ls".to_owned(),
        ];
        let mut editor = Editor::default();
        let mut out = Vec::new();
        // "mak", Ctrl-R (older match), Enter.
        let mut input: &[u8] = b"mak\x12\r";
        assert!(matches!(
            reverse_search(&mut input, &mut out, &h, &mut editor),
            SearchEnd::Submit
        ));
        assert_eq!(editor.text(), "make test");
        // Ctrl-C leaves the original line alone.
        let mut editor = Editor::default();
        keys(&mut editor, "orig");
        let mut input: &[u8] = b"ls\x03";
        reverse_search(&mut input, &mut out, &h, &mut editor);
        assert_eq!(editor.text(), "orig");
    }

    #[test]
    fn common_prefix_and_columns() {
        let cands = vec![plain("status"), plain("stash"), plain("stage")];
        assert_eq!(common_prefix(&cands), "sta");
        let grid = format_columns(&["aa".into(), "bb".into(), "cc".into()], 8);
        assert_eq!(grid, "aa  cc\r\nbb\r\n");
    }
}
