//! Running the `git` executable: the app's whole git surface (module 9).
//!
//! Everything that reads or mutates a repository shells out to `git` — exactly as the
//! extension's own CLI backend does. This is the one place git is spawned from, so the
//! process setup (working directory, no console window on Windows, no interactive
//! credential prompts that would hang a GUI app) is shared by every caller — and a
//! Windows spawn that fails with error 206 (a CreateProcess length limit, never a
//! missing git) retries through the recovery ladder below instead of surfacing as
//! "Could not run git".

use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// ERROR_FILENAME_EXCED_RANGE — CreateProcess's answer when the command line, the
/// environment block or the working-directory path exceeds its length ceiling. On a
/// Chinese Windows it prints as the "文件名或扩展名太长 (os error 206)" every git
/// invocation on an affected machine fails with, whatever git's own availability.
#[cfg(windows)]
const ERROR_FILENAME_EXCED_RANGE: i32 = 206;

/// The variables the curated recovery environment carries, besides the slim `PATH`
/// ([`slim_path`]) and the setup every spawn here applies: Windows' own machinery, the
/// user's home and locale, and the proxy and SSH settings git itself reads. Windows
/// matches environment names case-insensitively, so the spellings need no twins.
#[cfg(windows)]
const MINIMAL_ENV: &[&str] = &[
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "OS",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "HOME",
    "LANG",
    "LC_ALL",
    "GNUPGHOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "SSH_AUTH_SOCK",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
];

/// Every git invocation is recorded here for the "Git" output channel of the panel, the way
/// VS Code's Git extension logs its commands: the command line, its duration and exit, and what
/// it printed. The most recent `LOG_CAPACITY` entries are kept.
static LOG: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
const LOG_CAPACITY: usize = 2000;
/// Set by the app at startup so new log lines are pushed to the panel as events.
static EMITTER: OnceLock<LogEmitter> = OnceLock::new();
type LogEmitter = Box<dyn Fn(&str) + Send + Sync>;

pub fn set_log_emitter(emitter: impl Fn(&str) + Send + Sync + 'static) {
    let _ = EMITTER.set(Box::new(emitter));
}

/// The recorded output, oldest first.
pub fn log_lines() -> Vec<String> {
    LOG.lock().unwrap().iter().cloned().collect()
}

pub fn clear_log() {
    LOG.lock().unwrap().clear();
}

fn record(line: String) {
    {
        let mut log = LOG.lock().unwrap();
        if log.len() >= LOG_CAPACITY {
            log.pop_front();
        }
        log.push_back(line.clone());
    }
    if let Some(emit) = EMITTER.get() {
        emit(&line);
    }
}

fn quote_arg(arg: &str) -> String {
    if arg.is_empty() || arg.chars().any(|c| c.is_whitespace() || c == '"') {
        format!("\"{}\"", arg.replace('"', "\\\""))
    } else {
        arg.to_owned()
    }
}

/// A git invocation context: the repository to run in, plus environment overrides (the tests
/// use these to point git at a scratch global config instead of the developer's own).
#[derive(Clone, Debug)]
pub struct Git {
    pub repo: PathBuf,
    pub env: Vec<(String, String)>,
}

/// The git binary every invocation runs. A `git` on the PATH stays the answer wherever
/// one is there — nothing changes for those machines; where the machine's Git lives in
/// a custom directory the PATH never names (Git for Windows' "use Git from Git Bash
/// only" install), it is located through the registry `InstallPath` Git's own installer
/// writes and the standard install roots — [`locate::find_git_exe`], the
/// same discovery the Terminal Shell's Git Bash choice rides. Resolved once per run.
fn executable() -> &'static std::ffi::OsStr {
    static GIT: OnceLock<PathBuf> = OnceLock::new();
    GIT.get_or_init(|| {
        crate::locate::find_git_exe().unwrap_or_else(|| PathBuf::from("git"))
    })
    .as_os_str()
}

impl Git {
    pub fn new(repo: impl AsRef<Path>) -> Git {
        Git {
            repo: repo.as_ref().to_path_buf(),
            env: Vec::new(),
        }
    }

    pub fn command(&self) -> Command {
        self.base_command(&self.repo)
    }

    /// The common spawn setup — environment overrides, pipes, the no-console flag —
    /// over a `Command` whose working directory the caller already placed. The
    /// error-206 recovery shapes rebuild the environment from scratch and reapply this,
    /// so the ladder's spawns keep every guarantee the ordinary one carries.
    fn apply_common_setup(&self, command: &mut Command) {
        command
            // A credential or host-key prompt would block forever behind a windowed app.
            .env("GIT_TERMINAL_PROMPT", "0")
            // Every command the app runs must finish without an editor; git special-cases ":"
            // as "no editor" (see git's editor.c), which is portable unlike `true`.
            .env("GIT_EDITOR", ":")
            .env("GIT_SEQUENCE_EDITOR", ":")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &self.env {
            command.env(key, value);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
    }

    /// A git invocation against `cwd` — [`Git::command`] with the working directory as
    /// the one knob the recovery ladder varies.
    fn base_command(&self, cwd: &Path) -> Command {
        let mut command = Command::new(executable());
        command.current_dir(cwd);
        self.apply_common_setup(&mut command);
        command
    }

    /// Run a mutating command. `Ok(())` on exit 0; otherwise git's own complaint, as the
    /// extension reports it (stderr followed by stdout, trailing newline dropped).
    pub fn run(&self, args: &[&str]) -> Result<(), String> {
        self.output(args).map(|_| ())
    }

    /// Run a mutating command feeding `input` on git's stdin — the `-F -` shape every
    /// unbounded text argument (the commit message) rides: Windows caps a spawn's
    /// command line at 32 767 characters, so a long message passed as `-m` fails the
    /// spawn with error 206 before git ever runs. The command must consume its stdin
    /// before producing more than a pipe of output (git's `-F -` reads the message to
    /// EOF first), or the write and the capture deadlock against each other.
    pub fn run_input(&self, args: &[&str], input: &[u8]) -> Result<(), String> {
        self.output_input(args, input).map(|_| ())
    }

    /// Run a command and return its stdout.
    pub fn output(&self, args: &[&str]) -> Result<String, String> {
        self.output_inner(args, None)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Run a command fed on stdin and return its stdout.
    pub fn output_input(&self, args: &[&str], input: &[u8]) -> Result<String, String> {
        self.output_inner(args, Some(input))
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Run a command and return its stdout as raw bytes — for content that must not pass
    /// through UTF-8 (`cat-file` of a binary blob, the byte-level comparison views).
    pub fn output_bytes(&self, args: &[&str]) -> Result<Vec<u8>, String> {
        self.output_inner(args, None)
    }

    /// Run a command and hand back the whole `Output` — for the callers that read the
    /// status and both streams themselves. It spawns through the same recovery ladder
    /// as every other invocation here.
    pub fn raw_output(&self, args: &[&str]) -> Result<Output, String> {
        let started = Instant::now();
        let (output, ran) = self.run_capture(args, None).map_err(|e| spawn_error(&e))?;
        self.log(&ran, &output, started);
        Ok(output)
    }

    fn output_inner(&self, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>, String> {
        let started = Instant::now();
        let (output, ran) = self.run_capture(args, input).map_err(|e| spawn_error(&e))?;
        self.log(&ran, &output, started);
        collect_bytes(output)
    }

    /// One captured git spawn. A Windows failure with error 206 (see
    /// [`ERROR_FILENAME_EXCED_RANGE`]) is not git being missing — it is a CreateProcess
    /// length limit (the command line, the inherited environment block, or the
    /// working-directory path) — and the [`capture_windows_206`] ladder retries what it
    /// can recover. Arguments too long to survive any shape (a commit message on the
    /// command line) are the callers' to keep off it: [`Git::run_input`].
    fn run_capture(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
    ) -> std::io::Result<(Output, Vec<String>)> {
        match self.capture_with(self.command(), args, input) {
            Ok(output) => Ok((output, args.iter().map(|a| a.to_string()).collect())),
            Err(e) => {
                #[cfg(windows)]
                {
                    if e.raw_os_error() == Some(ERROR_FILENAME_EXCED_RANGE) {
                        if let Some(recovered) = self.capture_windows_206(args, input) {
                            return Ok(recovered);
                        }
                    }
                }
                Err(e)
            }
        }
    }

    /// Spawn `command` with `args` (and `input` on its stdin, piped) and collect the
    /// result; a spawn failure propagates before anything is written.
    fn capture_with(
        &self,
        mut command: Command,
        args: &[&str],
        input: Option<&[u8]>,
    ) -> std::io::Result<Output> {
        if input.is_some() {
            command.stdin(Stdio::piped());
        }
        command.args(args);
        let mut child = command.spawn()?;
        if let Some(bytes) = input {
            if let Some(mut pipe) = child.stdin.take() {
                pipe.write_all(bytes)?;
            }
        }
        child.wait_with_output()
    }

    /// The error-206 recovery ladder (Windows): the same git call with the repository
    /// passed as `-C` from a short working directory — a repository nested deeper than
    /// MAX_PATH keeps answering — then, should the inherited environment be what
    /// overflowed, with the accumulated `PATH` slimmed and finally with a curated
    /// minimal environment. The first shape that works wins; `None` when none does.
    #[cfg(windows)]
    fn capture_windows_206(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
    ) -> Option<(Output, Vec<String>)> {
        let mut full: Vec<String> = vec!["-C".to_owned(), self.repo.to_string_lossy().into_owned()];
        full.extend(args.iter().map(|a| a.to_string()));
        let refs: Vec<&str> = full.iter().map(String::as_str).collect();
        // The child's initial working directory only has to exist and be short: git's
        // `-C` does its own chdir. The repository's root (`C:\`, `\\server\share\`) is
        // the shortest directory that always does.
        let short_dir = self
            .repo
            .ancestors()
            .last()
            .unwrap_or(Path::new("."))
            .to_path_buf();
        for shape in 0.. {
            let Some(command) = self.command_206(shape, &short_dir) else {
                break;
            };
            if let Ok(output) = self.capture_with(command, &refs, input) {
                record(format!(
                    "the spawn failed with Windows error 206 (文件名或扩展名太长); retried {} and it answered",
                    match shape {
                        0 => "with `git -C` from the repository's root",
                        1 => "with a slimmed `PATH` as well",
                        _ => "with a minimal environment as well",
                    }
                ));
                return Some((output, full));
            }
        }
        None
    }

    /// The recovery spawn shapes, in order: the inherited environment from the short
    /// working directory; the inherited environment with `PATH` — whose accumulated
    /// length is the usual overflow — replaced by [`slim_path`]; a curated minimal
    /// environment. `None` past the last.
    #[cfg(windows)]
    fn command_206(&self, shape: usize, short_dir: &Path) -> Option<Command> {
        let command = match shape {
            0 => self.base_command(short_dir),
            1 | 2 => {
                let mut command = Command::new(executable());
                command.current_dir(short_dir);
                command.env_clear();
                if shape == 1 {
                    environment_without_path(&mut command);
                } else {
                    for name in MINIMAL_ENV {
                        if let Some(value) = std::env::var_os(name) {
                            command.env(name, value);
                        }
                    }
                }
                command.env("PATH", slim_path());
                self.apply_common_setup(&mut command);
                command
            }
            _ => return None,
        };
        Some(command)
    }

    fn log(&self, args: &[String], output: &Output, started: Instant) {
        let mut line = format!(
            "> git {} [{}ms]",
            args.iter()
                .map(|a| quote_arg(a))
                .collect::<Vec<_>>()
                .join(" "),
            started.elapsed().as_millis()
        );
        if !output.status.success() {
            line.push_str(&format!(" (exit {})", output.status.code().unwrap_or(-1)));
        }
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let text = text.trim_end();
        if !text.is_empty() {
            // Long listings are trimmed: the channel is for diagnosing, not for dumping logs.
            let mut lines: Vec<&str> = text.lines().collect();
            if lines.len() > 40 {
                let dropped = lines.len() - 40;
                lines.truncate(40);
                line.push('\n');
                line.push_str(&lines.join("\n"));
                line.push_str(&format!("\n… {dropped} more line(s)"));
            } else {
                line.push('\n');
                line.push_str(&lines.join("\n"));
            }
        }
        record(line);
    }

    /// The absolute `.git` directory (a worktree's is elsewhere than `<repo>/.git`).
    ///
    /// Answered from the file system when the layout is the common one - `<repo>/.git` is
    /// the directory itself, or a `gitdir: <path>` file (a worktree, a submodule) - which is
    /// what `git rev-parse --git-dir` reports for them; the CLI is only asked for anything
    /// else. The graph's `loadRepoInfo` asks on every refresh, and a git process is tens of
    /// milliseconds on Windows.
    pub fn git_dir(&self) -> Result<PathBuf, String> {
        let dot_git = self.repo.join(".git");
        if dot_git.is_dir() {
            return Ok(dot_git);
        }
        if let Ok(pointer) = std::fs::read_to_string(&dot_git) {
            if let Some(target) = pointer.trim().strip_prefix("gitdir:") {
                let target = Path::new(target.trim());
                return Ok(if target.is_absolute() {
                    target.to_path_buf()
                } else {
                    self.repo.join(target)
                });
            }
        }
        let dir = self.output(&["rev-parse", "--git-dir"])?;
        let dir = Path::new(dir.trim());
        Ok(if dir.is_absolute() {
            dir.to_path_buf()
        } else {
            self.repo.join(dir)
        })
    }
}

/* ---------- The Windows error-206 recovery's environment shapes ---------- */

/// The inherited environment minus `PATH` — whose accumulated length is the usual
/// overflow — ready for the [`slim_path`] replacement the recovery slots in. Every
/// other variable rides verbatim, so proxies, locale and the user's home survive.
#[cfg(windows)]
fn environment_without_path(command: &mut Command) {
    for (key, value) in std::env::vars_os() {
        if !key.eq_ignore_ascii_case("PATH") {
            command.env(key, value);
        }
    }
}

/// The slim `PATH` the recovery spawns with: git's own directory first, then the
/// system directories every child of git needs. The inherited `PATH` is left behind.
#[cfg(windows)]
fn slim_path() -> std::ffi::OsString {
    let mut entries: Vec<PathBuf> = Path::new(executable())
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .into_iter()
        .collect();
    if let Some(root) = std::env::var_os("SystemRoot") {
        let root = PathBuf::from(root);
        entries.push(root.join("System32"));
        entries.push(root.join("System32").join("Wbem"));
        entries.push(root);
    }
    std::env::join_paths(entries).unwrap_or_default()
}

/// The spawn-failure message: the PATH hint for an ordinary failure, and a targeted
/// diagnosis when Windows error 206 survived the whole recovery ladder.
fn spawn_error(error: &std::io::Error) -> String {
    #[cfg(windows)]
    {
        if error.raw_os_error() == Some(ERROR_FILENAME_EXCED_RANGE) {
            return format!(
                "Could not run git: Windows error 206 — the command line, the environment \
                 block or the repository's path exceeded a Windows length limit, and the \
                 fallbacks (git -C from a short working directory, a slimmed environment) \
                 did not help. A shorter repository path or a shorter machine PATH may. \
                 ({error})"
            );
        }
    }
    format!("Could not run git (is it on the PATH?): {error}")
}

/* ---------- The extension backends' git (the spawn-env seam) ---------- */

/// The environment extension backends spawn with: git's directory prepended to `PATH`
/// when the located Git is not on it. A backend's own git discovery scans the standard
/// install roots and then `PATH` — VS Code's Git-extension order, the Git Graph view's
/// `findGit` among them — so a Git installed to a custom directory the PATH never names
/// is invisible to it (the "未找到 Git，写入类操作需要安装 Git" notice); with the
/// directory on the backend's `PATH` the extension finds and writes with the same
/// install the app runs. Registered at the composition root onto `ext_process`'s
/// spawn-env sources; the id is unused — git is no extension's private concern.
pub fn backend_env(_ext_id: &str) -> Vec<(String, String)> {
    let Some(dir) = crate::locate::find_git_exe().and_then(|git| {
        git.parent()
            .filter(|dir| !dir.as_os_str().is_empty())
            .map(Path::to_path_buf)
    }) else {
        return Vec::new();
    };
    let current = std::env::var_os("PATH").unwrap_or_default();
    match path_with(&current, &dir) {
        Some(extended) => vec![("PATH".to_owned(), extended.to_string_lossy().into_owned())],
        None => Vec::new(),
    }
}

/// `current` with `dir` prepended, or `None` when `current` already names `dir`. Pure
/// over the inputs, so the join is testable; empty entries drop out along the way.
fn path_with(current: &std::ffi::OsStr, dir: &Path) -> Option<std::ffi::OsString> {
    let carried = |entry: &PathBuf| !entry.as_os_str().is_empty();
    if std::env::split_paths(current)
        .filter(carried)
        .any(|entry| entry == dir)
    {
        return None;
    }
    std::env::join_paths(
        std::iter::once(dir.to_path_buf()).chain(std::env::split_paths(current).filter(carried)),
    )
    .ok()
}

fn collect_bytes(output: std::process::Output) -> Result<Vec<u8>, String> {
    if output.status.success() {
        return Ok(output.stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut text = format!("{stderr}{stdout}");
    while text.ends_with('\n') || text.ends_with('\r') {
        text.pop();
    }
    if text.is_empty() {
        text = format!("git exited with {}", output.status);
    }
    Err(text)
}

/* ---------- Pure argument validation (src/utils.ts: isSafeRefName & co.) ---------- */

/// A commit hash as the view sends one: 4–64 hex digits (SHA-1 and SHA-256 both fit).
pub fn is_valid_commit_hash(hash: &str) -> bool {
    (4..=64).contains(&hash.len()) && hash.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn is_safe_ref_name(name: &str) -> bool {
    if name.is_empty() || name.starts_with('-') || name.starts_with('.') {
        return false;
    }
    if name.ends_with('/') || name.ends_with('.') || name.ends_with(".lock") {
        return false;
    }
    if name.chars().any(|c| c.is_control()) {
        return false;
    }
    !["..", "@{", "\\", "^", ":", "?", "[", "*"]
        .iter()
        .any(|seq| name.contains(seq))
}

/// `git fetch` with the view's options: one named remote (validated) or `--all`, optional
/// pruning (tags only alongside branches).
pub fn fetch(git: &Git, remote: Option<&str>, prune: bool, prune_tags: bool) -> Result<(), String> {
    if let Some(remote) = remote.filter(|name| !is_safe_ref_name(name)) {
        return Err(format!(
            "Invalid reference name was provided for \"remote\" ({remote})"
        ));
    }
    let mut args = vec!["fetch", remote.unwrap_or("--all")];
    if prune {
        args.push("--prune");
    }
    if prune_tags {
        if !prune {
            return Err("In order to Prune Tags, pruning must also be enabled when fetching from remote(s).".to_owned());
        }
        args.push("--prune-tags");
    }
    git.run(&args)
}

#[cfg(test)]
mod spawn_env_tests {
    use super::*;

    // The fixtures carry no drive letters: `join_paths` rejects an entry containing the
    // platform's PATH separator, and a `C:` drive's colon is Unix's — a Windows-shaped
    // fixture fails the join before the behaviour under test is reached.
    #[test]
    fn a_path_lacking_the_git_dir_gains_it_in_front() {
        let current = std::env::join_paths(["/tools", "/other"]).unwrap();
        let git_dir = Path::new("/custom/Git/cmd");
        let extended = path_with(&current, git_dir).expect("the directory is prepended");
        let expected =
            std::env::join_paths([git_dir, Path::new("/tools"), Path::new("/other")]).unwrap();
        assert_eq!(extended, expected);
    }

    #[test]
    fn a_path_already_carrying_the_git_dir_is_returned_untouched() {
        let git_dir = Path::new("/custom/Git/cmd");
        let current =
            std::env::join_paths([Path::new("/tools"), git_dir, Path::new("/other")]).unwrap();
        assert_eq!(path_with(&current, git_dir), None);
    }

    #[test]
    fn an_empty_path_becomes_the_git_dir_alone() {
        let git_dir = Path::new("/custom/Git/cmd");
        let extended = path_with(std::ffi::OsStr::new(""), git_dir).expect("the directory alone");
        assert_eq!(extended, std::env::join_paths([git_dir]).unwrap());
    }
}

#[cfg(all(test, windows))]
mod windows_206_tests {
    use super::*;

    fn scratch_repo(name: &str) -> Git {
        let dir = tempfile::tempdir().unwrap();
        // Keep the tempdir alive for the test's duration by keeping it — the runner
        // only needs the directory to exist while git runs.
        let repo = dir.keep().join(name);
        std::fs::create_dir_all(&repo).unwrap();
        let git = Git::new(&repo);
        git.run(&["init", "-q", "-b", "main"]).unwrap();
        git
    }

    /// The recovery ladder's `-C` shape is a real, working git invocation: on a machine
    /// where git answers, it resolves the repository exactly as the primary spawn does.
    #[test]
    fn the_minus_c_shape_runs_git_against_the_repository() {
        let git = scratch_repo("repo");
        let (output, ran) = git
            .capture_windows_206(&["rev-parse", "--show-toplevel"], None)
            .expect("the recovery ladder answers when git itself is healthy");
        assert!(output.status.success());
        assert_eq!(ran[0], "-C");
        assert!(Path::new(&ran[1]).ends_with("repo"));
        let printed = String::from_utf8_lossy(&output.stdout);
        assert!(printed.trim().replace('\\', "/").ends_with("/repo"));
    }

    /// The slimmed-`PATH` shape runs git too: the absolute git plus the system roots is
    /// a `PATH` a git child survives. (The `-C` argument rides along, as the ladder
    /// itself would add it.)
    #[test]
    fn the_slimmed_path_shape_runs_git() {
        let git = scratch_repo("repo");
        let short_dir = git.repo.ancestors().last().unwrap().to_path_buf();
        let command = git.command_206(1, &short_dir).expect("the shape exists");
        let repo_arg = git.repo.to_string_lossy();
        let args = ["-C", repo_arg.as_ref(), "rev-parse", "--show-toplevel"];
        let output = git
            .capture_with(command, &args, None)
            .expect("git answers under the slimmed PATH");
        assert!(output.status.success());
        let printed = String::from_utf8_lossy(&output.stdout);
        assert!(printed.trim().replace('\\', "/").ends_with("/repo"));
    }

    /// The slim `PATH` leads with git's own directory and keeps the system roots.
    #[test]
    fn the_slim_path_leads_with_gits_directory_and_keeps_system32() {
        let entries: Vec<PathBuf> = std::env::split_paths(&slim_path()).collect();
        if let Some(dir) = Path::new(executable())
            .parent()
            .filter(|dir| !dir.as_os_str().is_empty())
        {
            assert_eq!(entries.first(), Some(&dir.to_path_buf()));
        }
        assert!(entries.iter().any(|entry| entry.ends_with("System32")));
    }
}

#[cfg(test)]
mod git_dir_tests {
    use super::*;

    #[test]
    fn git_dir_is_read_from_the_file_system_for_the_common_layouts() {
        let dir = tempfile::tempdir().unwrap();
        // A plain checkout: `.git` is the directory.
        let plain = dir.path().join("plain");
        std::fs::create_dir_all(plain.join(".git")).unwrap();
        assert_eq!(Git::new(&plain).git_dir().unwrap(), plain.join(".git"));
        // A worktree / submodule checkout: `.git` is a `gitdir:` pointer, relative or absolute.
        let linked = dir.path().join("linked");
        std::fs::create_dir_all(&linked).unwrap();
        std::fs::write(
            linked.join(".git"),
            "gitdir: ../plain/.git/worktrees/linked\n",
        )
        .unwrap();
        assert_eq!(
            Git::new(&linked).git_dir().unwrap(),
            linked.join("../plain/.git/worktrees/linked")
        );
        let absolute = plain.join(".git").join("modules").join("sub");
        std::fs::write(
            linked.join(".git"),
            format!("gitdir: {}", absolute.display()),
        )
        .unwrap();
        assert_eq!(Git::new(&linked).git_dir().unwrap(), absolute);
        // Anything else (no `.git` at all) still goes to git, which rejects a non-repository.
        let none = dir.path().join("none");
        std::fs::create_dir_all(&none).unwrap();
        assert!(Git::new(&none).git_dir().is_err());
    }
}
