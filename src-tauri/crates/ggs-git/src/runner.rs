//! Running the `git` executable: the app's whole git surface (module 9).
//!
//! Everything that reads or mutates a repository shells out to `git` — exactly as the
//! extension's own CLI backend does. This is the one place git is spawned from, so the
//! process setup (working directory, no console window on Windows, no interactive
//! credential prompts that would hang a GUI app) is shared by every caller.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

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
        let mut command = Command::new(executable());
        command
            .current_dir(&self.repo)
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
        command
    }

    /// Run a mutating command. `Ok(())` on exit 0; otherwise git's own complaint, as the
    /// extension reports it (stderr followed by stdout, trailing newline dropped).
    pub fn run(&self, args: &[&str]) -> Result<(), String> {
        self.output(args).map(|_| ())
    }

    /// Run a command and return its stdout.
    pub fn output(&self, args: &[&str]) -> Result<String, String> {
        let started = Instant::now();
        let output = self
            .command()
            .args(args)
            .output()
            .map_err(|e| format!("Could not run git (is it on the PATH?): {e}"))?;
        self.log(args, &output, started);
        collect(output)
    }

    fn log(&self, args: &[&str], output: &std::process::Output, started: Instant) {
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

    /// Run a command and return its stdout as raw bytes — for content that must not pass
    /// through UTF-8 (`cat-file` of a binary blob, the byte-level comparison views).
    pub fn output_bytes(&self, args: &[&str]) -> Result<Vec<u8>, String> {
        let started = Instant::now();
        let output = self
            .command()
            .args(args)
            .output()
            .map_err(|e| format!("Could not run git (is it on the PATH?): {e}"))?;
        self.log(args, &output, started);
        collect_bytes(output)
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

fn collect(output: std::process::Output) -> Result<String, String> {
    collect_bytes(output).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
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

    #[test]
    fn a_path_lacking_the_git_dir_gains_it_in_front() {
        let current = std::env::join_paths(["C:/tools", "C:/other"]).unwrap();
        let git_dir = Path::new("D:/custom/Git/cmd");
        let extended = path_with(&current, git_dir).expect("the directory is prepended");
        let expected =
            std::env::join_paths([git_dir, Path::new("C:/tools"), Path::new("C:/other")]).unwrap();
        assert_eq!(extended, expected);
    }

    #[test]
    fn a_path_already_carrying_the_git_dir_is_returned_untouched() {
        let git_dir = Path::new("D:/custom/Git/cmd");
        let current =
            std::env::join_paths([Path::new("C:/tools"), git_dir, Path::new("C:/other")]).unwrap();
        assert_eq!(path_with(&current, git_dir), None);
    }

    #[test]
    fn an_empty_path_becomes_the_git_dir_alone() {
        let git_dir = Path::new("D:/custom/Git/cmd");
        let extended = path_with(std::ffi::OsStr::new(""), git_dir).expect("the directory alone");
        assert_eq!(extended, std::env::join_paths([git_dir]).unwrap());
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
