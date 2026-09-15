//! Running the `git` executable: the write path of the app.
//!
//! The engine (`git-graph-core`) is read-only by design; everything that mutates a repository
//! shells out to `git`, exactly as the extension's own CLI backend does. This is the one place
//! git is spawned from, so the process setup (working directory, no console window on Windows,
//! no interactive credential prompts that would hang a GUI app) is shared by every caller.

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

/// Record a line that came from elsewhere - the plugin backend's `log` events, its stderr -
/// so the panel's "Git" channel shows one merged stream whichever process ran git.
pub fn record_line(line: &str) {
    record(line.to_owned());
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

impl Git {
    pub fn new(repo: impl AsRef<Path>) -> Git {
        Git {
            repo: repo.as_ref().to_path_buf(),
            env: Vec::new(),
        }
    }

    pub fn command(&self) -> Command {
        let mut command = Command::new("git");
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

    /// Run a command with text on its stdin, returning its stdout.
    pub fn output_with_input(&self, args: &[&str], input: &str) -> Result<String, String> {
        use std::io::Write;
        let started = Instant::now();
        let mut child = self
            .command()
            .args(args)
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not run git (is it on the PATH?): {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(input.as_bytes());
        }
        let output = child
            .wait_with_output()
            .map_err(|e| format!("Could not run git: {e}"))?;
        self.log(args, &output, started);
        collect(output)
    }

    /// Run a command whose failure is uninteresting (a best-effort cleanup).
    pub fn run_quietly(&self, args: &[&str]) {
        let _ = self.output(args);
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

fn collect(output: std::process::Output) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut text = format!("{stderr}{stdout}");
    while text.ends_with('\n') || text.ends_with('\r') {
        text.pop();
    }
    if text.is_empty() {
        text = format!("git exited with {}", output.status);
    }
    Err(text)
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
        std::fs::write(linked.join(".git"), "gitdir: ../plain/.git/worktrees/linked\n").unwrap();
        assert_eq!(Git::new(&linked).git_dir().unwrap(), linked.join("../plain/.git/worktrees/linked"));
        let absolute = plain.join(".git").join("modules").join("sub");
        std::fs::write(linked.join(".git"), format!("gitdir: {}", absolute.display())).unwrap();
        assert_eq!(Git::new(&linked).git_dir().unwrap(), absolute);
        // Anything else (no `.git` at all) still goes to git, which rejects a non-repository.
        let none = dir.path().join("none");
        std::fs::create_dir_all(&none).unwrap();
        assert!(Git::new(&none).git_dir().is_err());
    }
}
