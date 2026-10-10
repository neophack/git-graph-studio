//! The interpreter. `Shell` is the whole mutable world — variables, functions, the cwd,
//! the option flags — cheap to clone because every pipeline stage and command
//! substitution needs exactly that: a subshell. The three streams an expression runs
//! against live in [`Io`], whose sinks are either the process's own stdio, a file a
//! redirection opened, a capture buffer (`$( … )`) or one end of an in-process pipe; the
//! same representation serves builtins (they write through it directly) and externals
//! (converted to `Stdio`, with pump threads for the piped ends).

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

use super::applets;
use super::ast::*;
use super::builtins;
use super::expand;

/// Why an execution unwound early. A command's nonzero status is a normal answer, not
/// an error — only the control-flow escapes travel as errors.
#[derive(Debug)]
pub enum ExecError {
    /// `return n` out of a function or sourced file.
    Return(i32),
    /// `break` / `continue` — caught by the enclosing loop.
    Break(u32),
    Continue(u32),
    /// `exit n` — run to the top.
    Exit(i32),
    /// An I/O or spawn failure worth reporting to stderr.
    Io(String),
}

impl ExecError {
    /// The message for stderr, if this kind has one.
    pub fn message(&self) -> Option<String> {
        match self {
            ExecError::Io(text) => Some(text.clone()),
            ExecError::Return(_)
            | ExecError::Break(_)
            | ExecError::Continue(_)
            | ExecError::Exit(_) => None,
        }
    }
}

pub type ExecResult = Result<i32, ExecError>;

/* ---------- The streams ---------- */

#[derive(Clone)]
pub enum Source {
    Inherit,
    Null,
    /// Here-string / heredoc text — shared, so successive `read`s consume it in
    /// steps (`while read x; do …; done <<< "$text"` walks the whole string).
    Str(Arc<Mutex<String>>),
    /// The receiving end of a pipe: the channel plus the bytes a one-line read
    /// pulled early, so `while read` over a pipeline takes it line by line instead
    /// of draining the stream on the first call.
    PipeIn(Arc<Mutex<PipeRx>>),
    File(Arc<Mutex<std::fs::File>>),
}

/// The shared state behind [`Source::PipeIn`].
pub struct PipeRx {
    pub rx: Receiver<Vec<u8>>,
    pub pending: Vec<u8>,
}

#[derive(Clone)]
pub enum Sink {
    Inherit,
    Null,
    PipeOut {
        tx: Sender<Vec<u8>>,
        /// Set once a send fails: the reading stage is gone, and the producing
        /// stage's loops stop instead of pumping a disconnected channel forever —
        /// the producer half of SIGPIPE (`while :; do echo; done | head -1`).
        broken: Arc<std::sync::atomic::AtomicBool>,
    },
    Capture(Arc<Mutex<Vec<u8>>>),
    File(Arc<Mutex<std::fs::File>>),
}

#[derive(Clone)]
pub struct Io {
    pub stdin: Source,
    pub stdout: Sink,
    pub stderr: Sink,
}

impl Default for Io {
    fn default() -> Io {
        Io {
            stdin: Source::Inherit,
            stdout: Sink::Inherit,
            stderr: Sink::Inherit,
        }
    }
}

impl Io {
    /// A capturing context — `$( … )`.
    pub fn capturing() -> (Io, Arc<Mutex<Vec<u8>>>) {
        let buffer = Arc::new(Mutex::new(Vec::new()));
        (
            Io {
                stdin: Source::Inherit,
                stdout: Sink::Capture(buffer.clone()),
                stderr: Sink::Inherit,
            },
            buffer,
        )
    }

    pub fn write_out(&self, bytes: &[u8]) {
        match &self.stdout {
            Sink::Inherit => {
                let mut out = std::io::stdout();
                let _ = out.write_all(bytes);
                let _ = out.flush();
            }
            Sink::Null => {}
            Sink::PipeOut { tx, broken } => {
                if tx.send(bytes.to_vec()).is_err() {
                    broken.store(true, Ordering::Relaxed);
                }
            }
            Sink::Capture(buffer) => buffer.lock().unwrap().extend_from_slice(bytes),
            Sink::File(file) => {
                let _ = file.lock().unwrap().write_all(bytes);
            }
        }
    }

    pub fn out_str(&self, text: &str) {
        self.write_out(text.as_bytes());
    }

    pub fn write_err(&self, bytes: &[u8]) {
        match &self.stderr {
            // stderr redirected to stdout follows stdout's sink, not the process's.
            Sink::Inherit => {
                let mut err = std::io::stderr();
                let _ = err.write_all(bytes);
                let _ = err.flush();
            }
            Sink::Null => {}
            Sink::PipeOut { tx, broken } => {
                if tx.send(bytes.to_vec()).is_err() {
                    broken.store(true, Ordering::Relaxed);
                }
            }
            Sink::Capture(buffer) => buffer.lock().unwrap().extend_from_slice(bytes),
            Sink::File(file) => {
                let _ = file.lock().unwrap().write_all(bytes);
            }
        }
    }

    pub fn err_str(&self, text: &str) {
        self.write_err(text.as_bytes());
    }

    /// Whether a pipe this context writes into has closed — its reader is gone, the
    /// producer's own version of SIGPIPE. Command loops check this between commands.
    pub fn broken_pipe(&self) -> bool {
        let dead = |sink: &Sink| matches!(sink, Sink::PipeOut { broken, .. } if broken.load(Ordering::Relaxed));
        dead(&self.stdout) || dead(&self.stderr)
    }

    /// Everything stdin still holds. Channel input drains to the close; inherit reads
    /// the process stdin to its end (the `read` builtin special-cases a live line).
    pub fn read_all_stdin(&mut self) -> String {
        match &self.stdin {
            Source::Inherit => {
                let mut text = String::new();
                let _ = std::io::stdin().read_to_string(&mut text);
                text
            }
            Source::Null => String::new(),
            Source::Str(text) => {
                let mut text = text.lock().unwrap();
                std::mem::take(&mut *text)
            }
            Source::PipeIn(state) => {
                let mut bytes = Vec::new();
                {
                    let mut state = state.lock().unwrap();
                    bytes.append(&mut state.pending);
                    while let Ok(chunk) = state.rx.recv() {
                        bytes.extend_from_slice(&chunk);
                    }
                }
                self.stdin = Source::Null;
                String::from_utf8_lossy(&bytes).into_owned()
            }
            Source::File(file) => {
                let mut bytes = Vec::new();
                let _ = file.lock().unwrap().read_to_end(&mut bytes);
                String::from_utf8_lossy(&bytes).into_owned()
            }
        }
    }

    /// One line, for the `read` builtin — exactly one: the position (a file handle, a
    /// herestring, a pipe's buffered bytes) advances by the line, so the next `read`
    /// in a `while read` loop sees the next line, not end-of-stream.
    pub fn read_one_line(&mut self) -> Option<String> {
        self.read_raw_line().map(|line| {
            String::from_utf8_lossy(&line)
                .trim_end_matches(['\n', '\r'])
                .to_owned()
        })
    }

    /// One line as raw bytes, its terminating newline kept (absent only on a last line
    /// that had none) — the byte-exact form `head` passes through untouched.
    pub fn read_raw_line(&mut self) -> Option<Vec<u8>> {
        match &self.stdin {
            Source::Inherit => {
                use std::io::BufRead;
                let mut line = Vec::new();
                match std::io::stdin().lock().read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => None,
                    Ok(_) => Some(line),
                }
            }
            Source::Null => None,
            Source::Str(text) => {
                let mut text = text.lock().unwrap();
                match text.find('\n') {
                    Some(at) => {
                        let line = text[..=at].as_bytes().to_vec();
                        text.replace_range(..=at, "");
                        Some(line)
                    }
                    None if text.is_empty() => None,
                    None => Some(std::mem::take(&mut *text).into_bytes()),
                }
            }
            Source::PipeIn(state) => {
                let mut state = state.lock().unwrap();
                loop {
                    if let Some(at) = state.pending.iter().position(|b| *b == b'\n') {
                        return Some(state.pending.drain(..=at).collect());
                    }
                    match state.rx.recv() {
                        Ok(chunk) => state.pending.extend_from_slice(&chunk),
                        Err(_) => {
                            if state.pending.is_empty() {
                                return None;
                            }
                            return Some(std::mem::take(&mut state.pending));
                        }
                    }
                }
            }
            Source::File(file) => {
                // Byte-wise on the shared handle: a fresh BufReader would drop its
                // buffered-but-unread tail when it dies, losing every line after the
                // first; the handle's own position is the only durable cursor.
                let mut handle = file.lock().unwrap();
                let mut line = Vec::new();
                let mut byte = [0u8; 1];
                loop {
                    match handle.read(&mut byte) {
                        Ok(0) => break,
                        Ok(_) => {
                            line.push(byte[0]);
                            if byte[0] == b'\n' {
                                break;
                            }
                        }
                        Err(_) => return None,
                    }
                }
                if line.is_empty() {
                    None
                } else {
                    Some(line)
                }
            }
        }
    }
}

/* ---------- The shell state ---------- */

#[derive(Clone, Debug)]
pub struct Var {
    pub value: String,
    pub exported: bool,
}

#[derive(Clone)]
pub struct Shell {
    pub vars: BTreeMap<String, Var>,
    pub funcs: HashMap<String, Arc<Script>>,
    pub aliases: HashMap<String, String>,
    pub args: Vec<String>,
    pub arg0: String,
    pub status: i32,
    pub cwd: PathBuf,
    pub errexit: bool,
    pub xtrace: bool,
    pub noglob: bool,
    pub interactive: bool,
    /// `local` frames, innermost last.
    pub locals: Vec<HashMap<String, String>>,
    /// Alias expansion in flight (an alias may not invoke itself).
    pub alias_stack: Vec<String>,
    /// Guards runaway source/eval recursion.
    pub depth: usize,
    /// The interactive prompt's history (`history` lists it numbered).
    pub history: Vec<String>,
    /// The last pipeline ran in an `set -e`-exempt position (condition, `&&` left,
    /// negated): its failure must not end the script.
    pub last_was_exempt: bool,
    /// `trap 'cmd' SIG` handlers by signal name; only `EXIT` fires (a shell has no
    /// signals to deliver here), the rest are accepted and remembered for `trap -p`.
    pub traps: HashMap<String, String>,
    /// Indexed arrays (`arr=(a b)`); `$arr` is element 0. Not exported to children.
    pub arrays: HashMap<String, Vec<String>>,
    /// Associative arrays (`declare -A m`), insertion-ordered `(key, value)` pairs.
    pub assoc: HashMap<String, Vec<(String, String)>>,
    /// Background jobs (`cmd &`), shared with the clones that run them.
    pub jobs: Arc<Mutex<JobTable>>,
}

/// One background job: a thread running a clone of the shell on the statement.
pub struct Job {
    pub id: usize,
    pub text: String,
    /// `Some(exit status)` once the statement finished.
    pub status: Arc<Mutex<Option<i32>>>,
    pub handle: Option<std::thread::JoinHandle<()>>,
}

#[derive(Default)]
pub struct JobTable {
    /// The highest job number handed out (`$!`).
    pub last: usize,
    pub list: Vec<Job>,
}

impl Shell {
    /// A shell inheriting this process's environment, exported by construction.
    pub fn new(arg0: &str) -> Shell {
        let mut vars = BTreeMap::new();
        for (key, value) in std::env::vars() {
            vars.insert(
                key,
                Var {
                    value,
                    exported: true,
                },
            );
        }
        // Git Bash always has a HOME; a stock Windows box often does not. Everything
        // from bare `cd` to `~/.bashrc` leans on it.
        if !vars.keys().any(|key| key.eq_ignore_ascii_case("HOME")) {
            if let Some(profile) = vars
                .keys()
                .find(|key| key.eq_ignore_ascii_case("USERPROFILE"))
                .and_then(|key| vars.get(key))
            {
                vars.insert("HOME".to_owned(), profile.clone());
            }
        }
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        Shell {
            vars,
            funcs: HashMap::new(),
            aliases: HashMap::new(),
            args: Vec::new(),
            arg0: arg0.to_owned(),
            status: 0,
            cwd,
            errexit: false,
            xtrace: false,
            noglob: false,
            interactive: false,
            locals: Vec::new(),
            alias_stack: Vec::new(),
            depth: 0,
            history: Vec::new(),
            last_was_exempt: false,
            traps: HashMap::new(),
            arrays: HashMap::new(),
            assoc: HashMap::new(),
            jobs: Arc::default(),
        }
    }

    pub fn get_var(&self, name: &str) -> Option<String> {
        for frame in self.locals.iter().rev() {
            if let Some(value) = frame.get(name) {
                return Some(value.clone());
            }
        }
        match name {
            "?" => return Some(self.status.to_string()),
            "#" => return Some(self.args.len().to_string()),
            "$" => return Some(std::process::id().to_string()),
            "!" => return Some(self.jobs.lock().unwrap().last.to_string()),
            "0" => return Some(self.arg0.clone()),
            "@" => return Some(self.args.join(" ")),
            // `$*` glues with the FIRST IFS character (`IFS=:; "$*"` is a:b:c), space
            // when IFS is unset, nothing when it is set but empty.
            "*" => {
                return Some(match self.get_var("IFS") {
                    Some(ifs) => self
                        .args
                        .join(&ifs.chars().next().map(String::from).unwrap_or_default()),
                    None => self.args.join(" "),
                });
            }
            n if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => {
                return self
                    .args
                    .get(n.parse::<usize>().unwrap().checked_sub(1)?)
                    .cloned();
            }
            _ => {}
        }
        if let Some(items) = self.arrays.get(name) {
            return Some(items.first().cloned().unwrap_or_default());
        }
        // Windows spells it Path, PATH or path depending on who set it — one variable
        // however it is written (the environment block is case-blind).
        if let Some(key) = self.vars.keys().find(|key| key.eq_ignore_ascii_case(name)) {
            let value = self.vars.get(key)?.value.clone();
            if key.eq_ignore_ascii_case("PATH") {
                return Some(self.present_path(&value));
            }
            return Some(value);
        }
        None
    }

    /// Git Bash presents `PATH` colon-separated over MSYS addresses while the stored
    /// and spawned-with form stays Windows-native (`;`-joined). `echo $PATH` is the
    /// presented form; `PATH=$PATH:/c/tools` stores back through [`store_path`].
    pub fn present_path(&self, stored: &str) -> String {
        stored
            .split([';', ':'])
            .filter(|piece| !piece.is_empty())
            .map(|piece| super::msys::to_msys(Path::new(&super::msys::from_msys(piece))))
            .collect::<Vec<_>>()
            .join(":")
    }

    /// The inverse of [`present_path`]: a colon-separated MSYS value stores native.
    fn store_path(&self, value: &str) -> String {
        value
            .split([';', ':'])
            .filter(|piece| !piece.is_empty())
            .map(super::msys::from_msys)
            .collect::<Vec<_>>()
            .join(";")
    }

    /// The value of `$@` as separate words (the one expansion that keeps arguments
    /// apart even inside double quotes).
    pub fn positional(&self) -> Vec<String> {
        self.args.clone()
    }

    pub fn set_var(&mut self, name: &str, value: &str) {
        if let Some(frame) = self.locals.last_mut() {
            if frame.contains_key(name) {
                frame.insert(name.to_owned(), value.to_owned());
                return;
            }
        }
        // PATH keeps a Windows-native stored form whichever dialect set it.
        let value = if name.eq_ignore_ascii_case("PATH") {
            self.store_path(value)
        } else {
            value.to_owned()
        };
        match self
            .vars
            .keys()
            .find(|key| key.eq_ignore_ascii_case(name))
            .cloned()
        {
            Some(existing) => {
                if let Some(var) = self.vars.get_mut(&existing) {
                    var.value = value;
                }
            }
            None => {
                self.vars.insert(
                    name.to_owned(),
                    Var {
                        value,
                        exported: false,
                    },
                );
            }
        }
    }

    pub fn export_var(&mut self, name: &str, value: Option<&str>) {
        if let Some(value) = value {
            self.set_var(name, value);
        }
        if let Some(existing) = self
            .vars
            .keys()
            .find(|key| key.eq_ignore_ascii_case(name))
            .cloned()
        {
            if let Some(var) = self.vars.get_mut(&existing) {
                var.exported = true;
            }
        }
    }

    pub fn path_var(&self) -> String {
        self.get_var("PATH").unwrap_or_default()
    }

    /// The child environment: this process's own, overlaid with every exported shell
    /// variable (case-insensitively on Windows, where `Path` and `PATH` are one key).
    pub fn child_env(&self, extra: &[(String, String)]) -> Vec<(String, String)> {
        let mut env: BTreeMap<String, String> = std::env::vars().collect();
        for (name, var) in &self.vars {
            if var.exported {
                insert_env(&mut env, name, &var.value);
            }
        }
        for frame in &self.locals {
            for (name, value) in frame {
                insert_env(&mut env, name, value);
            }
        }
        for (name, value) in extra {
            insert_env(&mut env, name, value);
        }
        env.into_iter().collect()
    }
}

fn insert_env(env: &mut BTreeMap<String, String>, name: &str, value: &str) {
    if cfg!(windows) {
        let hit = env
            .keys()
            .find(|key| key.eq_ignore_ascii_case(name))
            .cloned();
        if let Some(hit) = hit {
            env.insert(hit, value.to_owned());
            return;
        }
    }
    env.insert(name.to_owned(), value.to_owned());
}

/* ---------- Program resolution ---------- */

/// The platform's executable extensions: PATHEXT on Windows (`.COM;.EXE;.BAT;.CMD` by
/// default), a lone empty one elsewhere.
fn executable_extensions() -> Vec<String> {
    if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(str::to_owned)
            .collect()
    } else {
        vec![String::new()]
    }
}

/// Find `name` the way the shell spawns it: a path with separators runs as-is;
/// otherwise each `PATH` entry, with the platform's executable extensions (PATHEXT on
/// Windows) appended. Returns the resolved path and whether it is a `.cmd`/`.bat`
/// (informational for callers that report).
pub fn resolve_on_path(name: &str, path_var: &str) -> Option<PathBuf> {
    if name.contains('/')
        || name.contains('\\')
        || (cfg!(windows) && name.len() > 1 && name.as_bytes()[1] == b':')
    {
        return Some(PathBuf::from(name));
    }
    let extensions = executable_extensions();
    // Both dialects, whichever side the value came from: the stored form is
    // `;`-joined Windows paths, `$PATH` round-trips arrive `:`-joined MSYS ones.
    for dir in path_var.split([';', ':']) {
        if dir.is_empty() {
            continue;
        }
        let dir = super::msys::from_msys(dir);
        for extension in &extensions {
            let candidate = Path::new(&dir).join(format!("{name}{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Anchor a resolved-but-relative program (`./x`, `dir/tool`, an MSYS `/c/...` spelling)
/// to the shell's cwd in the native dialect before spawning. Windows resolves a
/// *relative* application path against the spawning process's cwd, which the shell's
/// `cd` never moves — without this, `cd scripts && ./x.bat` would look for
/// `<process cwd>\x.bat`. A literal miss then completes a PATHEXT extension the way Git
/// Bash does: `./build` finds `build.bat`.
pub fn anchor_program(program: &Path, cwd: &Path) -> PathBuf {
    let text = program.display().to_string();
    let dialect = if cfg!(windows) {
        super::msys::from_msys(&text)
    } else {
        text
    };
    let mut anchored = PathBuf::from(dialect);
    if !anchored.is_absolute() {
        anchored = cwd.join(anchored);
    }
    if cfg!(windows) && !anchored.is_file() {
        for extension in executable_extensions() {
            if extension.is_empty() {
                continue;
            }
            let candidate = PathBuf::from(format!("{}{}", anchored.display(), extension));
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    anchored
}

/* ---------- The interpreter ---------- */

impl Shell {
    /// Print `Done` lines for background jobs that finished since the last prompt
    /// (interactive shells only) and forget them.
    pub fn report_finished_jobs(&mut self, io: &Io) {
        let mut table = self.jobs.lock().unwrap();
        let mut keep = Vec::new();
        for job in table.list.drain(..) {
            let done = *job.status.lock().unwrap();
            match done {
                Some(code) => {
                    let state = if code == 0 {
                        "Done".to_owned()
                    } else {
                        format!("Exit {code}")
                    };
                    io.out_str(&format!("[{}]+  {state:<24}{}\n", job.id, job.text));
                }
                None => keep.push(job),
            }
        }
        table.list = keep;
    }

    /// Run the `EXIT` trap once, when the shell ends (script end, `exit`, EOF).
    pub fn run_exit_trap(&mut self, io: &Io) {
        if let Some(command) = self.traps.remove("EXIT") {
            if let Ok(script) = super::parse::parse_script(&command) {
                let _ = self.exec_block(&script, io, false);
            }
        }
    }

    /// One `name=value` of a bare assignment list, in all its shapes: scalar, `+=`
    /// append, `name[i]=v`, `name=(…)` / `name+=(…)` and the associative forms
    /// `m[key]=v` / `m=([k]=v …)`. A target `name[]` carries its subscript in the value
    /// word before a `Sep` (the parser's form for `name[$i]=v`).
    pub fn assign(&mut self, target: &str, value: &Word, io: &Io) -> Result<(), ExecError> {
        let append = target.ends_with('+');
        let target = target.strip_suffix('+').unwrap_or(target);
        let mut value = value.clone();
        let (base, subscript): (String, Option<String>) =
            if let Some(base) = target.strip_suffix("[]") {
                let at = value
                    .0
                    .iter()
                    .position(|p| matches!(p, Part::Sep))
                    .unwrap_or(0);
                let subscript = Word(value.0[..at].to_vec());
                let rest = value.0.get(at + 1..).unwrap_or(&[]).to_vec();
                value = Word(rest);
                let key = expand::expand_single(self, &subscript, io)?;
                (base.to_owned(), Some(key))
            } else {
                match expand::split_subscript(target) {
                    Some((base, index)) => (base.to_owned(), Some(index.to_owned())),
                    None => (target.to_owned(), None),
                }
            };
        if self.assoc.contains_key(&base) {
            return self.assign_assoc(&base, subscript, append, &value, io);
        }
        if let [Part::ArrayLit(words)] = value.0.as_slice() {
            let items = expand::expand_words(self, words, io)?;
            let mut current = if append {
                self.array_snapshot(&base)
            } else {
                Vec::new()
            };
            current.extend(items);
            self.vars.remove(&base);
            self.arrays.insert(base, current);
            return Ok(());
        }
        let text = expand::expand_assignment(self, &value, io)?;
        if let Some(index) = subscript {
            let at = expand::eval_arith(self, &index, io)?;
            let mut items = self.array_snapshot(&base);
            let at = if at < 0 {
                (items.len() as i64 + at).max(0) as usize
            } else {
                at as usize
            };
            if items.len() <= at {
                items.resize(at + 1, String::new());
            }
            items[at] = if append {
                format!("{}{text}", items[at])
            } else {
                text
            };
            self.vars.remove(&base);
            self.arrays.insert(base, items);
        } else if self.arrays.contains_key(&base) {
            let items = self.arrays.get_mut(&base).expect("checked above");
            if items.is_empty() {
                items.push(String::new());
            }
            items[0] = if append {
                format!("{}{text}", items[0])
            } else {
                text
            };
        } else if append {
            let old = self.get_var(&base).unwrap_or_default();
            self.set_var(&base, &format!("{old}{text}"));
        } else {
            self.set_var(&base, &text);
        }
        Ok(())
    }

    fn assign_assoc(
        &mut self,
        base: &str,
        subscript: Option<String>,
        append: bool,
        value: &Word,
        io: &Io,
    ) -> Result<(), ExecError> {
        if let [Part::ArrayLit(words)] = value.0.as_slice() {
            let items = expand::expand_words(self, words, io)?;
            if !append {
                self.assoc.insert(base.to_owned(), Vec::new());
            }
            for item in items {
                // `[key]=value`; the key is already expanded by the word expansion.
                let Some(rest) = item.strip_prefix('[') else {
                    continue;
                };
                let Some((key, text)) = rest.split_once("]=") else {
                    continue;
                };
                self.assoc_set(base, key, text.to_owned(), false);
            }
            return Ok(());
        }
        let text = expand::expand_assignment(self, value, io)?;
        let key = match subscript {
            Some(raw) => expand::assoc_key(self, &raw, io)?,
            None => "0".to_owned(),
        };
        self.assoc_set(base, &key, text, append);
        Ok(())
    }

    pub fn assoc_set(&mut self, base: &str, key: &str, value: String, append: bool) {
        let entries = self.assoc.entry(base.to_owned()).or_default();
        match entries.iter_mut().find(|(k, _)| k == key) {
            Some((_, old)) => {
                if append {
                    old.push_str(&value);
                } else {
                    *old = value;
                }
            }
            None => entries.push((key.to_owned(), value)),
        }
    }

    /// The array `name` as a vector; a plain variable counts as a one-element array.
    pub fn array_snapshot(&self, name: &str) -> Vec<String> {
        if let Some(items) = self.arrays.get(name) {
            return items.clone();
        }
        match self.vars.get(name) {
            Some(var) => vec![var.value.clone()],
            None => Vec::new(),
        }
    }

    pub fn exec_script(&mut self, script: &Script, io: &Io) -> ExecResult {
        match self.exec_block(script, io, false) {
            Ok(status) => Ok(status),
            Err(ExecError::Break(_) | ExecError::Continue(_)) => {
                io.err_str("ggs-bash: break/continue outside a loop\n");
                Ok(2)
            }
            Err(ExecError::Return(code)) => {
                // `return` at the top of a sourced file's caller is a plain status.
                Ok(code)
            }
            Err(other) => Err(other),
        }
    }

    /// Statements of a block: if/while bodies, function bodies, brace groups. Stops
    /// early under `set -e` (a failing statement ends the block) unless the failure
    /// came from an exempt position (a condition, the left of `&&`, a negation).
    pub fn exec_block(&mut self, script: &Script, io: &Io, exempt_pass: bool) -> ExecResult {
        let mut status = 0;
        for stmt in &script.0 {
            // A closed pipe downstream ends this stage the way SIGPIPE ends a producer:
            // `while :; do echo; done | head -1` stops once head exits, not never.
            if io.broken_pipe() {
                return Err(ExecError::Exit(141));
            }
            self.last_was_exempt = false;
            status = self.exec_stmt(stmt, io)?;
            if self.errexit && status != 0 && !exempt_pass && !self.last_was_exempt {
                return Ok(status);
            }
        }
        Ok(status)
    }

    fn exec_stmt(&mut self, stmt: &Stmt, io: &Io) -> ExecResult {
        if stmt.background {
            let mut shell = self.clone();
            let thread_io = io.clone();
            let body = stmt.body.clone();
            let status = Arc::new(Mutex::new(None));
            let finished = status.clone();
            let text = describe(&stmt.body);
            let handle = std::thread::spawn(move || {
                let code = match shell.exec_and_or(&body, &thread_io) {
                    Ok(code) | Err(ExecError::Exit(code)) | Err(ExecError::Return(code)) => code,
                    Err(_) => 1,
                };
                *finished.lock().unwrap() = Some(code);
            });
            let mut table = self.jobs.lock().unwrap();
            // Numbers restart once the table empties, as in bash.
            let id = table.list.iter().map(|j| j.id).max().unwrap_or(0) + 1;
            table.last = id;
            table.list.push(Job {
                id,
                text,
                status,
                handle: Some(handle),
            });
            if self.interactive {
                io.err_str(&format!("[{id}] {id}\n"));
            }
            return Ok(0);
        }
        self.exec_and_or(&stmt.body, io)
    }

    pub fn exec_and_or(&mut self, and_or: &AndOr, io: &Io) -> ExecResult {
        let total = 1 + and_or.rest.len();
        let mut status = {
            // The left of a chain is exempt from -e.
            let exempt = total > 1;
            self.with_exempt(exempt, |shell| shell.exec_pipeline(&and_or.first, io))?
        };
        for (index, (is_and, pipeline)) in and_or.rest.iter().enumerate() {
            // `&&` runs the rest only after success, `||` only after failure.
            let runs = if *is_and { status == 0 } else { status != 0 };
            if !runs {
                continue;
            }
            let exempt = index + 1 < total - 1;
            status = self.with_exempt(exempt, |shell| shell.exec_pipeline(pipeline, io))?;
        }
        Ok(status)
    }

    fn exec_pipeline(&mut self, pipeline: &Pipeline, io: &Io) -> ExecResult {
        if pipeline.stages.is_empty() {
            return Ok(0);
        }
        let mut status = if pipeline.stages.len() == 1 {
            let stage = &pipeline.stages[0];
            let mut stage_io = io.clone();
            self.apply_redirects(&mut stage_io, &stage.redirects)?;
            let result = self.exec_command(&stage.command, &stage_io);
            // A `>(cmd)` consumer eats its temp file once the producer has finished,
            // writing to the command's own stdout (never into the redirect target).
            expand::flush_pending_process_subs(self, io);
            result?
        } else {
            let result = self.run_threaded_pipeline(pipeline, io);
            // The stages' redirect expansions queued their `>(cmd)` consumers on
            // this thread (the expansions run before the stage threads spawn).
            expand::flush_pending_process_subs(self, io);
            result?
        };
        if pipeline.negated {
            status = if status == 0 { 1 } else { 0 };
            self.last_was_exempt = true;
        } else if pipeline.stages.len() > 1 {
            // Only the last stage's status is the pipeline's; a failure mid-pipe that
            // surfaced through is not an -e trigger of its own.
            self.last_was_exempt = false;
        }
        // `$?` reads the last pipeline's answer, always.
        self.status = status;
        Ok(status)
    }

    /// One thread per stage, joined at both ends; each stage runs on a cloned shell
    /// (bash's pipeline segments are subshells). The channels are made up front so an
    /// early error drops every sender and the already-spawned stages see clean closes.
    fn run_threaded_pipeline(&mut self, pipeline: &Pipeline, io: &Io) -> ExecResult {
        type PipeEnd = Arc<Mutex<PipeRx>>;
        let count = pipeline.stages.len();
        let mut senders: Vec<Option<Sender<Vec<u8>>>> = vec![None; count];
        let mut receivers: Vec<Option<PipeEnd>> = vec![None; count];
        for link in 0..count - 1 {
            let (tx, rx) = channel::<Vec<u8>>();
            senders[link] = Some(tx);
            receivers[link + 1] = Some(Arc::new(Mutex::new(PipeRx {
                rx,
                pending: Vec::new(),
            })));
        }
        let mut threads = Vec::new();
        for (index, stage) in pipeline.stages.iter().enumerate() {
            let stdin = if index == 0 {
                io.stdin.clone()
            } else {
                Source::PipeIn(
                    receivers[index]
                        .clone()
                        .expect("every non-first stage has a receiver"),
                )
            };
            let stdout = if index + 1 == count {
                io.stdout.clone()
            } else {
                Sink::PipeOut {
                    tx: senders[index]
                        .clone()
                        .expect("every non-last stage has a sender"),
                    broken: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                }
            };
            let mut stage_io = Io {
                stdin,
                stdout,
                stderr: io.stderr.clone(),
            };
            self.apply_redirects(&mut stage_io, &stage.redirects)?;
            let mut shell = self.clone();
            let command = stage.command.clone();
            threads.push(std::thread::spawn(move || {
                shell.exec_command(&command, &stage_io)
            }));
        }
        // The vec's originals of each sender must go before the joins: a downstream
        // stage's recv() only reports EOF once every sender clone is gone, and each
        // stage's own clone dies with its thread. Joining first would deadlock the
        // reader of the very channel we are holding open. The receiver originals
        // matter just as much: a producer's send() only fails once the receiver is
        // fully dropped, and an early-finishing consumer must close its pipe so an
        // endless producer (`while :; do echo; done | head -1`) sees the close and
        // stops instead of pumping forever.
        drop(senders);
        drop(receivers);
        let mut status = 0;
        for thread in threads {
            match thread.join() {
                Ok(result) => {
                    status = match result {
                        Ok(code) => code,
                        // A pipeline segment is a subshell: `exit` stays inside it and
                        // its code is the stage's status.
                        Err(ExecError::Exit(code)) => code,
                        Err(_) => 1,
                    }
                }
                Err(_) => status = 1,
            }
        }
        Ok(status)
    }

    fn exec_command(&mut self, command: &Command, io: &Io) -> ExecResult {
        match command {
            Command::Simple(simple) => self.exec_simple(simple, io),
            Command::Condition(tokens) => {
                let words: Vec<String> = tokens
                    .iter()
                    .map(|token| match token {
                        CondTok::Word(word) => expand::expand_single(self, word, io),
                        CondTok::Op(op) => Ok(op.clone()),
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                match builtins::eval_condition(&words, true) {
                    Ok(true) => Ok(0),
                    Ok(false) => Ok(1),
                    Err(text) => {
                        io.err_str(&format!("ggs-bash: {text}\n"));
                        Ok(2)
                    }
                }
            }
            Command::Compound(compound) => self.exec_compound(compound, io),
        }
    }

    fn exec_compound(&mut self, compound: &Compound, io: &Io) -> ExecResult {
        match compound {
            Compound::Brace(body) => self.exec_block(body, io, false),
            Compound::CFor {
                init,
                cond,
                step,
                body,
            } => {
                self.exec_block(init, io, false)?;
                let mut status = 0;
                loop {
                    if let Some(cond) = cond {
                        let code =
                            self.with_exempt(true, |shell| shell.exec_block(cond, io, true))?;
                        if code != 0 {
                            break;
                        }
                    }
                    match self.exec_block(body, io, false) {
                        Ok(code) => status = code,
                        Err(ExecError::Break(n)) if n > 1 => return Err(ExecError::Break(n - 1)),
                        Err(ExecError::Break(_)) => break,
                        Err(ExecError::Continue(n)) if n > 1 => {
                            return Err(ExecError::Continue(n - 1))
                        }
                        Err(ExecError::Continue(_)) => {}
                        Err(other) => return Err(other),
                    }
                    self.exec_block(step, io, false)?;
                }
                Ok(status)
            }
            Compound::Subshell(body) => {
                let mut shell = self.clone();
                // `exit` ends the subshell, not the parent: its code becomes the
                // subshell's status (`(exit 3); echo after` still echoes).
                match shell.exec_block(body, io, false) {
                    Err(ExecError::Exit(code)) => Ok(code),
                    other => other,
                }
            }
            Compound::If {
                cond,
                then,
                elifs,
                otherwise,
            } => {
                let taken = self.with_exempt(true, |shell| shell.exec_block(cond, io, true))? == 0;
                if taken {
                    return self.exec_block(then, io, false);
                }
                for (cond, body) in elifs {
                    let taken =
                        self.with_exempt(true, |shell| shell.exec_block(cond, io, true))? == 0;
                    if taken {
                        return self.exec_block(body, io, false);
                    }
                }
                match otherwise {
                    Some(body) => self.exec_block(body, io, false),
                    None => Ok(0),
                }
            }
            Compound::While { cond, body, until } => loop {
                let status = self.with_exempt(true, |shell| shell.exec_block(cond, io, true))?;
                let keep_going = if *until { status != 0 } else { status == 0 };
                if !keep_going {
                    return Ok(0);
                }
                match self.exec_block(body, io, false) {
                    Ok(_) => continue,
                    Err(ExecError::Break(n)) if n > 1 => return Err(ExecError::Break(n - 1)),
                    Err(ExecError::Break(_)) => return Ok(0),
                    Err(ExecError::Continue(n)) if n > 1 => return Err(ExecError::Continue(n - 1)),
                    Err(ExecError::Continue(_)) => continue,
                    Err(other) => return Err(other),
                }
            },
            Compound::For {
                variable,
                words,
                body,
            } => {
                let fields = expand::expand_words(self, words, io)?;
                let mut status = 0;
                for field in fields {
                    self.set_var(variable, &field);
                    match self.exec_block(body, io, false) {
                        Ok(code) => status = code,
                        Err(ExecError::Break(n)) if n > 1 => return Err(ExecError::Break(n - 1)),
                        Err(ExecError::Break(_)) => break,
                        Err(ExecError::Continue(n)) if n > 1 => {
                            return Err(ExecError::Continue(n - 1))
                        }
                        Err(ExecError::Continue(_)) => continue,
                        Err(other) => return Err(other),
                    }
                }
                Ok(status)
            }
            Compound::Case { subject, arms } => {
                let value = expand::expand_single(self, subject, io)?;
                for arm in arms {
                    for pattern in &arm.patterns {
                        let pattern_text = expand::expand_pattern(self, pattern, io)?;
                        // `case` is pattern matching, not pathname expansion — no
                        // hidden-file rule (`case .git in *) …` must take the arm).
                        if super::glob::glob_match_raw(&pattern_text, &value) {
                            return self.exec_block(&arm.body, io, false);
                        }
                    }
                }
                Ok(0)
            }
            Compound::Function { name, body } => {
                self.funcs.insert(name.clone(), body.clone());
                Ok(0)
            }
        }
    }

    fn exec_simple(&mut self, simple: &SimpleCommand, io: &Io) -> ExecResult {
        let mut argv = expand::expand_words(self, &simple.words, io)?;
        if let Some(name) = argv.first().cloned() {
            // Alias expansion, command position only, never recursive.
            if let Some(value) = self.aliases.get(&name).cloned() {
                if !self.alias_stack.contains(&name) {
                    if let Some(spliced) = expand::expand_alias(self, &value, &argv[1..], io)? {
                        argv = spliced;
                        self.alias_stack.push(name);
                        let status = self.dispatch(&argv, &simple.assigns, io, true);
                        self.alias_stack.pop();
                        return status;
                    }
                }
            }
        }
        self.dispatch(&argv, &simple.assigns, io, false)
    }

    fn dispatch(
        &mut self,
        argv: &[String],
        assigns: &[(String, Word)],
        io: &Io,
        in_alias: bool,
    ) -> ExecResult {
        let _ = in_alias;
        if self.xtrace && !argv.is_empty() {
            io.err_str(&format!("+ {}\n", argv.join(" ")));
        }
        // A bare assignment list (`x=1`, `x=1 y=2`) touches this shell.
        if argv.is_empty() {
            for (name, value) in assigns {
                self.assign(name, value, io)?;
            }
            return Ok(self.status);
        }
        // Prefix assignments scope to the command (`VAR=x env`): exported for the one
        // spawn, then restored.
        if !assigns.is_empty() {
            let mut extra = Vec::new();
            for (name, value) in assigns {
                extra.push((name.clone(), expand::expand_assignment(self, value, io)?));
            }
            // Save/restore under the key the map actually holds: on Windows `PATH`
            // lives as `Path`, and restoring the literal spelling would remove
            // nothing while `export_var` had already clobbered the real entry —
            // a `PATH=…:$PATH cmd` leaking into the whole session afterwards.
            let saved: Vec<(String, Option<Var>)> = extra
                .iter()
                .map(|(name, _)| {
                    let key = self
                        .vars
                        .keys()
                        .find(|key| key.eq_ignore_ascii_case(name))
                        .cloned()
                        .unwrap_or_else(|| name.clone());
                    let previous = self.vars.get(&key).cloned();
                    (key, previous)
                })
                .collect();
            for (name, value) in &extra {
                self.export_var(name, Some(value));
            }
            let result = self.dispatch_env(argv, &extra, io);
            for (name, previous) in saved {
                match previous {
                    Some(var) => {
                        self.vars.insert(name, var);
                    }
                    None => {
                        self.vars.remove(&name);
                    }
                }
            }
            return result;
        }
        self.dispatch_env(argv, &[], io)
    }

    fn dispatch_env(
        &mut self,
        argv: &[String],
        extra_env: &[(String, String)],
        io: &Io,
    ) -> ExecResult {
        let name = argv[0].clone();
        // A function call: fresh positional parameters, `local` frame, `return` unwinds.
        if let Some(body) = self.funcs.get(&name).cloned() {
            let saved_args = std::mem::replace(&mut self.args, argv[1..].to_vec());
            let saved_arg0 = std::mem::replace(&mut self.arg0, name.clone());
            self.locals.push(HashMap::new());
            self.depth += 1;
            let result = if self.depth > 100 {
                Err(ExecError::Io("function recursion too deep".into()))
            } else {
                self.exec_block(&body, io, false)
            };
            self.depth -= 1;
            self.locals.pop();
            self.args = saved_args;
            self.arg0 = saved_arg0;
            return match result {
                Err(ExecError::Return(code)) => Ok(code),
                other => other,
            };
        }
        if let Some(result) = builtins::run_builtin(self, io, &name, &argv[1..]) {
            return result;
        }
        if let Some(result) = applets::run_applet(self, io, &name, &argv[1..]) {
            return result;
        }
        self.spawn_external(&name, &argv[1..], extra_env, io)
    }

    /// The PATH wins over nothing here: builtins and applets already declined, so the
    /// name goes to the filesystem. 127 is "not found", 126 "found, not runnable".
    pub fn spawn_external(
        &mut self,
        name: &str,
        args: &[String],
        extra_env: &[(String, String)],
        io: &Io,
    ) -> ExecResult {
        let Some(resolved) = resolve_on_path(name, &self.path_var()) else {
            io.err_str(&format!("ggs-bash: {name}: command not found\n"));
            return Ok(127);
        };
        let program = anchor_program(&resolved, &self.cwd);
        // Rust std routes a .bat/.cmd through cmd.exe without checking the script
        // exists, so a missing one turns into cmd.exe's localized "not recognized"
        // noise carrying cmd's own exit code — report it the way every other missing
        // program reports instead.
        let is_batch = program
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("bat") || e.eq_ignore_ascii_case("cmd"));
        if cfg!(windows) && is_batch && !program.is_file() {
            io.err_str(&format!("ggs-bash: {name}: command not found\n"));
            return Ok(127);
        }
        // Native programs do not know `/c/...`; MSYS2 converts arguments of the
        // unambiguous path shape for native children, and so does the shell.
        let translated: Vec<String> = if cfg!(windows) {
            args.iter()
                .map(|arg| super::msys::translate_argument(arg))
                .collect()
        } else {
            args.to_vec()
        };
        match spawn_process(
            &program,
            &translated,
            &self.cwd,
            &self.child_env(extra_env),
            io,
        ) {
            Ok(code) => Ok(code),
            Err(error) => {
                // A text file with a shebang (or a .sh the platform refuses as PE)
                // executes through this very shell: `./build.sh args` runs the way
                // Git Bash runs it, no chmod ceremony. `program` is already anchored
                // absolute above, so it reads as-is.
                if let Ok(head) = std::fs::read(&program) {
                    let looks_script = head.starts_with(b"#!")
                        || (program.extension().map(|e| e == "sh").unwrap_or(false)
                            && head.iter().take(1024).all(|byte| *byte != 0));
                    if looks_script {
                        return self.run_script_file(&program, &translated, io);
                    }
                }
                io.err_str(&format!("ggs-bash: {name}: {error}\n"));
                Ok(if program.is_file() { 126 } else { 127 })
            }
        }
    }

    /// Run a shell script in-process: fresh positional parameters, `$0` the path.
    fn run_script_file(&mut self, path: &Path, argv: &[String], io: &Io) -> ExecResult {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Ok(127);
        };
        // The shebang's interpreter is this shell; drop the line.
        let first_line = text.split('\n').next().unwrap_or("");
        let body = text.strip_prefix(first_line).unwrap_or(text.as_str());
        let script = match super::parse::parse_script(body) {
            Ok(script) => script,
            Err(error) => {
                io.err_str(&format!("ggs-bash: {}: {:?}\n", path.display(), error));
                return Ok(2);
            }
        };
        let saved_args = std::mem::replace(&mut self.args, argv.to_vec());
        let saved_arg0 = std::mem::replace(&mut self.arg0, path.display().to_string());
        self.depth += 1;
        let result = if self.depth > 64 {
            Err(ExecError::Io("script nesting too deep".into()))
        } else {
            self.exec_block(&script, io, false)
        };
        self.depth -= 1;
        self.args = saved_args;
        self.arg0 = saved_arg0;
        match result {
            Err(ExecError::Exit(code)) => Ok(code),
            other => other,
        }
    }

    /// Run one argv through the full dispatch (functions, builtins, applets, PATH) —
    /// the seam `xargs` and `find -exec` use, where a command already exists as argv
    /// rather than as shell source.
    pub fn run_argv(&mut self, argv: &[String], io: &Io) -> ExecResult {
        if argv.is_empty() {
            return Ok(0);
        }
        self.dispatch_env(argv, &[], io)
    }

    pub fn apply_redirects(&mut self, io: &mut Io, redirects: &[Redir]) -> Result<(), ExecError> {
        for redirect in redirects {
            self.apply_redirect(io, redirect)?;
        }
        Ok(())
    }

    fn apply_redirect(&mut self, io: &mut Io, redirect: &Redir) -> Result<(), ExecError> {
        // `/dev/null` is the null device everywhere; on Windows nothing is opened.
        if let RedirTarget::Word(word) = &redirect.target {
            if let Ok(fields) = expand::expand_words(self, std::slice::from_ref(word), io) {
                if fields.len() == 1 && fields[0] == "/dev/null" {
                    match redirect.op {
                        RedirOp::Input => io.stdin = Source::Null,
                        // `&>` nulls both streams; a plain `>`/`>>` nulls only the fd it
                        // names (`2>/dev/null` must leave stdout alone).
                        RedirOp::Both => {
                            io.stdout = Sink::Null;
                            io.stderr = Sink::Null;
                        }
                        RedirOp::Output | RedirOp::Append => match redirect.fd {
                            None | Some(1) => io.stdout = Sink::Null,
                            Some(2) => io.stderr = Sink::Null,
                            // A descriptor the shell does not model (`3>/dev/null`)
                            // touches neither standard stream.
                            Some(_) => {}
                        },
                        _ => {}
                    }
                    return Ok(());
                }
            }
        }
        match redirect.op {
            RedirOp::Output | RedirOp::Append => {
                let path = self.redirect_path(io, redirect)?;
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create(true);
                if matches!(redirect.op, RedirOp::Output) {
                    options.truncate(true);
                } else {
                    options.append(true);
                }
                let file = options
                    .open(&path)
                    .map_err(|e| ExecError::Io(format!("{}: {e}", path.display())))?;
                let sink = Sink::File(Arc::new(Mutex::new(file)));
                self.place_sink(io, redirect.fd, sink)?;
            }
            RedirOp::Both => {
                let path = self.redirect_path(io, redirect)?;
                let file = std::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .open(&path)
                    .map_err(|e| ExecError::Io(format!("{}: {e}", path.display())))?;
                let sink = Sink::File(Arc::new(Mutex::new(file)));
                io.stdout = sink.clone();
                io.stderr = sink;
            }
            RedirOp::Input => {
                let path = self.redirect_path(io, redirect)?;
                let file = std::fs::File::open(&path)
                    .map_err(|e| ExecError::Io(format!("{}: {e}", path.display())))?;
                io.stdin = Source::File(Arc::new(Mutex::new(file)));
            }
            RedirOp::Dup => match &redirect.target {
                RedirTarget::Fd(from) => {
                    let sink = match from {
                        1 => io.stdout.clone(),
                        2 => io.stderr.clone(),
                        _ => return Err(ExecError::Io(format!("cannot duplicate fd {from}"))),
                    };
                    self.place_sink(io, redirect.fd, sink)?;
                }
                RedirTarget::Word(word) => {
                    // `>&name` is archaic; treat it as writing the file.
                    let path = self.redirect_word_path(io, word)?;
                    let file = std::fs::OpenOptions::new()
                        .write(true)
                        .create(true)
                        .truncate(true)
                        .open(&path)
                        .map_err(|e| ExecError::Io(format!("{}: {e}", path.display())))?;
                    self.place_sink(io, redirect.fd, Sink::File(Arc::new(Mutex::new(file))))?;
                }
                _ => return Err(ExecError::Io("bad duplication target".into())),
            },
            RedirOp::Heredoc | RedirOp::HeredocStrip => {
                let RedirTarget::Heredoc { content, expand } = &redirect.target else {
                    return Err(ExecError::Io("bad heredoc".into()));
                };
                let text = if *expand {
                    expand::expand_heredoc(self, content, io)?
                } else {
                    content.to_string()
                };
                io.stdin = Source::Str(Arc::new(Mutex::new(text)));
            }
            RedirOp::Herestring => {
                let RedirTarget::Word(word) = &redirect.target else {
                    return Err(ExecError::Io("bad herestring".into()));
                };
                let text = expand::expand_single(self, word, io)?;
                io.stdin = Source::Str(Arc::new(Mutex::new(format!("{text}\n"))));
            }
        }
        Ok(())
    }

    fn place_sink(&self, io: &mut Io, fd: Option<u32>, sink: Sink) -> Result<(), ExecError> {
        match fd.unwrap_or(1) {
            1 => io.stdout = sink,
            2 => io.stderr = sink,
            other => {
                return Err(ExecError::Io(format!(
                    "ggs-bash: fd {other}: only 0, 1 and 2 exist"
                )))
            }
        }
        Ok(())
    }

    fn redirect_path(&mut self, io: &Io, redirect: &Redir) -> Result<PathBuf, ExecError> {
        match &redirect.target {
            RedirTarget::Word(word) => self.redirect_word_path(io, word),
            _ => Err(ExecError::Io("expected a file name".into())),
        }
    }

    fn redirect_word_path(&mut self, io: &Io, word: &Word) -> Result<PathBuf, ExecError> {
        let fields = expand::expand_words(self, std::slice::from_ref(word), io)?;
        match fields.len() {
            1 => Ok(self.resolve_working_path(&fields[0])),
            _ => Err(ExecError::Io(format!(
                "ambiguous redirect: {}",
                fields.join(" ")
            ))),
        }
    }

    /// A relative path the shell was given lands in the shell's cwd, never the
    /// process's; an MSYS-shaped absolute (`/c/...`, `/tmp/...`) crosses over.
    pub fn resolve_working_path(&self, path: &str) -> PathBuf {
        let translated = super::msys::from_msys(path);
        let candidate = PathBuf::from(&translated);
        if candidate.is_absolute() {
            candidate
        } else {
            self.cwd.join(candidate)
        }
    }

    /// Run one pipeline, flagging whether its failure counts for `set -e`.
    fn with_exempt(
        &mut self,
        exempt: bool,
        body: impl FnOnce(&mut Shell) -> ExecResult,
    ) -> ExecResult {
        self.last_was_exempt = exempt;
        body(self)
    }
}

/* ---------- External process plumbing ---------- */

/// A spawned child plus the pump threads feeding/draining its piped ends. The pumps
/// outlive the spawn call; drop the child (or kill it) and they wind down.
pub struct SpawnedChild {
    pub child: std::process::Child,
    pumps: Vec<std::thread::JoinHandle<()>>,
}

impl SpawnedChild {
    /// Wait for the child, then let its pumps drain.
    pub fn finish(&mut self) -> Result<i32, String> {
        let status = self.child.wait().map_err(|e| format!("{e}"))?;
        for pump in self.pumps.drain(..) {
            let _ = pump.join();
        }
        Ok(status.code().unwrap_or(1))
    }

    /// [`finish`](Self::finish) with the pump drain bounded by `grace`: after a kill, a
    /// grandchild still holding the pipes open must not hold the caller with it — the
    /// stranded pumps end on their own once that grandchild closes its ends.
    pub fn finish_within(&mut self, grace: std::time::Duration) -> Result<i32, String> {
        let status = self.child.wait().map_err(|e| format!("{e}"))?;
        let deadline = std::time::Instant::now() + grace;
        for pump in self.pumps.drain(..) {
            while !pump.is_finished() && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            if pump.is_finished() {
                let _ = pump.join();
            }
        }
        Ok(status.code().unwrap_or(1))
    }
}

/// Spawn `program` with the Io's streams mapped onto stdio. Piped ends get pump
/// threads: a channel sink is fed from the child's stdout as it arrives, and a channel
/// source drains into the child's stdin until it closes.
pub fn spawn_with_io(
    program: &Path,
    args: &[String],
    cwd: &Path,
    env: &[(String, String)],
    io: &Io,
) -> Result<SpawnedChild, String> {
    let mut command = std::process::Command::new(program);
    command.args(args).current_dir(cwd).env_clear();
    for (key, value) in env {
        command.env(key, value);
    }
    command.stdin(stdin_of(&io.stdin)?);
    let stdout_pipe = matches!(io.stdout, Sink::PipeOut { .. } | Sink::Capture(_));
    let stderr_pipe = matches!(io.stderr, Sink::PipeOut { .. } | Sink::Capture(_));
    if stdout_pipe {
        command.stdout(std::process::Stdio::piped());
    } else {
        command.stdout(stdout_of(&io.stdout)?);
    }
    if stderr_pipe {
        command.stderr(std::process::Stdio::piped());
    } else {
        command.stderr(stdout_of(&io.stderr)?);
    }
    let mut child = command.spawn().map_err(|e| format!("{e}"))?;
    // Feed stdin.
    match &io.stdin {
        Source::Str(text) => {
            if let Some(mut handle) = child.stdin.take() {
                let _ = handle.write_all(text.lock().unwrap().as_bytes());
            }
        }
        Source::PipeIn(rx) => {
            if let Some(mut handle) = child.stdin.take() {
                let rx = rx.clone();
                std::thread::spawn(move || {
                    // The bytes an earlier one-line read pulled early go to the child
                    // first, then the channel's remainder as it arrives.
                    {
                        let mut state = rx.lock().unwrap();
                        if !state.pending.is_empty() {
                            if handle.write_all(&state.pending).is_err() {
                                return;
                            }
                            state.pending.clear();
                        }
                    }
                    loop {
                        let next = rx.lock().unwrap().rx.recv();
                        match next {
                            Ok(chunk) => {
                                if handle.write_all(&chunk).is_err() {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                });
            }
        }
        _ => {}
    }
    // Pump stdout / stderr.
    let mut pumps = Vec::new();
    if stdout_pipe {
        if let Some(out) = child.stdout.take() {
            pumps.push(pump(out, io.stdout.clone()));
        }
    }
    if stderr_pipe {
        if let Some(err) = child.stderr.take() {
            pumps.push(pump(err, io.stderr.clone()));
        }
    }
    Ok(SpawnedChild { child, pumps })
}

/// [`spawn_with_io`] plus the wait: the one-call form every plain external uses.
pub fn spawn_process(
    program: &Path,
    args: &[String],
    cwd: &Path,
    env: &[(String, String)],
    io: &Io,
) -> Result<i32, String> {
    spawn_with_io(program, args, cwd, env, io)?.finish()
}

fn pump<R: Read + Send + 'static>(mut reader: R, sink: Sink) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => match &sink {
                    Sink::PipeOut { tx, broken } => {
                        if tx.send(buffer[..n].to_vec()).is_err() {
                            broken.store(true, Ordering::Relaxed);
                            break;
                        }
                    }
                    Sink::Capture(cell) => cell.lock().unwrap().extend_from_slice(&buffer[..n]),
                    _ => break,
                },
            }
        }
    })
}

fn stdin_of(source: &Source) -> Result<std::process::Stdio, String> {
    match source {
        Source::Inherit => Ok(std::process::Stdio::inherit()),
        Source::Null => Ok(std::process::Stdio::null()),
        Source::Str(_) | Source::PipeIn(_) => Ok(std::process::Stdio::piped()),
        Source::File(file) => file
            .lock()
            .unwrap()
            .try_clone()
            .map(Into::into)
            .map_err(|e| format!("{e}")),
    }
}

fn stdout_of(sink: &Sink) -> Result<std::process::Stdio, String> {
    match sink {
        Sink::Inherit => Ok(std::process::Stdio::inherit()),
        Sink::Null => Ok(std::process::Stdio::null()),
        Sink::File(file) => file
            .lock()
            .unwrap()
            .try_clone()
            .map(Into::into)
            .map_err(|e| format!("{e}")),
        Sink::PipeOut { .. } | Sink::Capture(_) => Ok(std::process::Stdio::piped()),
    }
}

/// A one-line rendering of a background statement for `jobs`.
fn describe(body: &super::ast::AndOr) -> String {
    use super::ast::{Command, DPart};
    fn word_text(word: &Word) -> String {
        let mut out = String::new();
        for part in &word.0 {
            match part {
                Part::Lit(t) | Part::Quoted(t) => out.push_str(t),
                Part::Var { name, .. } => out.push_str(&format!("${name}")),
                Part::DQuoted(parts) => {
                    for p in parts {
                        match p {
                            DPart::Lit(t) => out.push_str(t),
                            DPart::Var { name, .. } => out.push_str(&format!("${name}")),
                            _ => out.push('…'),
                        }
                    }
                }
                _ => out.push('…'),
            }
        }
        out
    }
    let pipeline = |p: &super::ast::Pipeline| -> String {
        p.stages
            .iter()
            .map(|stage| match &stage.command {
                Command::Simple(simple) => simple
                    .words
                    .iter()
                    .map(word_text)
                    .collect::<Vec<_>>()
                    .join(" "),
                _ => "(compound command)".to_owned(),
            })
            .collect::<Vec<_>>()
            .join(" | ")
    };
    let mut text = pipeline(&body.first);
    for (and, next) in &body.rest {
        text.push_str(if *and { " && " } else { " || " });
        text.push_str(&pipeline(next));
    }
    format!("{text} &")
}
