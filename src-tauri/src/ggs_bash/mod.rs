//! GGS Bash — the bundled bash-like shell (`ggs-bash`, module 18) and Git Graph
//! Studio's default terminal shell. Pure Rust, zero dependencies: the lexer, parser and
//! interpreter in this module, the POSIX line tools as built-in applets (an `awk`
//! interpreter included), a small BRE/ERE engine for `grep`/`sed`, and Git Bash's path
//! dialect (`msys.rs`): `/c/...` drive paths, `/dev/null`, `/tmp`, a colon-separated
//! `PATH`, `~/.bashrc` at startup, the colored `user@host MINGW64 ~/path` prompt. A
//! clean Windows machine has no bash — this one ships with the app: the integrated
//! terminal runs it (the Terminal Shell setting, GGS Bash by default) and the bridged
//! claude-code backend is pointed at it through `CLAUDE_CODE_GIT_BASH_PATH` with
//! `MSYSTEM=MINGW64`, so shell commands are written exactly as on Git Bash.
//!
//! The honest subset: quotes and all the `$` forms, pipes, redirections (heredocs,
//! here-strings), process substitution `<(cmd)`/`>(cmd)` (temp-file backed),
//! `&&`/`||`, `if`/`for`/`while`/`until`/`case`, functions, subshells,
//! `set -e`/`-x`, aliases; not implemented: arrays,
//! brace expansion, traps, `break N` levels. An unsupported construct fails with a
//! clear syntax error instead of misbehaving.

pub mod applets;
pub mod archive;
pub mod arith;
pub mod ast;
pub mod awk;
pub mod builtins;
pub mod compress;
pub mod exec;
pub mod expand;
pub mod glob;
pub mod hashes;
pub mod lex;
pub mod lineedit;
pub mod localtime;
pub mod msys;
pub mod parse;
pub mod pref;
pub mod regexlite;

use exec::{ExecError, Io, Shell};

/// Run one command line (or a whole script) against a fresh shell — the seam every test
/// drives. Returns the last command's exit status; stderr goes to the process's own.
pub fn run_string(line: &str, io: &Io) -> i32 {
    run_with(Shell::new("ggs-bash"), line, io)
}

/// [`run_string`] over a given shell (tests pin the cwd and variables).
pub fn run_with(mut shell: Shell, line: &str, io: &Io) -> i32 {
    match parse::parse_script(line) {
        Ok(script) => match shell.exec_script(&script, io) {
            Ok(status) => status,
            Err(error) => {
                report(&error, io);
                match error {
                    ExecError::Exit(code) => code,
                    _ => 1,
                }
            }
        },
        Err(error) => {
            io.err_str(&format!("ggs-bash: syntax: {error:?}\n"));
            2
        }
    }
}

fn report(error: &ExecError, io: &Io) {
    if let Some(message) = error.message() {
        io.err_str(&format!("ggs-bash: {message}\n"));
    }
}

/* ---------- The binary's entry ---------- */

/// `ggs-bash`'s main: `-c 'cmd'`, a script file, or the interactive REPL reading stdin.
pub fn run_main() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_main_args(&args) {
        MainRequest::Version => {
            println!("ggs-bash (Git Graph Studio) 1.0");
            0
        }
        MainRequest::Help => {
            print_help();
            0
        }
        MainRequest::Error(message) => {
            eprintln!("ggs-bash: {message}");
            2
        }
        MainRequest::Command {
            string,
            arg0,
            args,
            interactive,
        } => {
            let mut shell = Shell::new(arg0.as_deref().unwrap_or("ggs-bash"));
            shell.args = args;
            shell.interactive = interactive;
            run_string_owning(shell, &string, &Io::default())
        }
        MainRequest::Script {
            path,
            args,
            interactive,
        } => {
            let mut shell = Shell::new(&path);
            shell.args = args;
            shell.interactive = interactive;
            let io = Io::default();
            match std::fs::read_to_string(&path) {
                Ok(text) => run_string_owning(shell, &text, &io),
                Err(error) => {
                    eprintln!("ggs-bash: {path}: {error}");
                    127
                }
            }
        }
        MainRequest::Stdin { interactive } => {
            let mut shell = Shell::new("ggs-bash");
            shell.interactive = interactive || is_stdin_tty();
            let io = Io::default();
            if shell.interactive {
                repl(shell, &io)
            } else {
                // A script on stdin (the `curl … | bash` shape and the harness pipe).
                let mut text = String::new();
                use std::io::Read;
                let _ = std::io::stdin().read_to_string(&mut text);
                run_string_owning(shell, &text, &io)
            }
        }
    }
}

/// The parsed command line. Git Bash's invocation dialect holds: the login/interactive
/// flags ride around `-c` in any order (`-c -l cmd`, `-lc cmd`, `--login -c cmd` are the
/// same run — a harness's `bash -c -l pwd` must not try to execute `-l`), and the words
/// after a `-c` string are positional parameters, the first of them `$0`. Split out of
/// [`run_main`] so the dialect is unit-testable without spawning a process.
enum MainRequest {
    Command {
        string: String,
        arg0: Option<String>,
        args: Vec<String>,
        interactive: bool,
    },
    Script {
        path: String,
        args: Vec<String>,
        interactive: bool,
    },
    /// No command and no script: the REPL on a terminal, a piped script otherwise.
    Stdin {
        interactive: bool,
    },
    Version,
    Help,
    Error(String),
}

fn parse_main_args(args: &[String]) -> MainRequest {
    let mut interactive = false;
    let mut want_command = false;
    let mut command: Option<String> = None;
    let mut trailing: Vec<String> = Vec::new();
    let mut options_open = true;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if command.is_some() {
            // After the -c string everything is positional, option-shaped or not.
            trailing.push(arg.clone());
        } else if options_open && arg == "--" {
            options_open = false;
        } else if options_open && arg.len() > 1 && arg.starts_with('-') {
            if let Some(long) = arg.strip_prefix("--") {
                match long {
                    // Accepted like bash's; the REPL sources ~/.bashrc either way.
                    "login" => {}
                    "help" => return MainRequest::Help,
                    "version" => return MainRequest::Version,
                    other => return MainRequest::Error(format!("--{other}: unsupported option")),
                }
            } else {
                for c in arg[1..].chars() {
                    match c {
                        'c' => want_command = true,
                        'i' => interactive = true,
                        'l' | 's' => {} // login/stdin flags: accepted, no effect
                        'e' | 'E' | 'u' | 'm' | 'b' => {}
                        'v' => return MainRequest::Version,
                        'h' => return MainRequest::Help,
                        other => {
                            return MainRequest::Error(format!("-{other}: unsupported option"))
                        }
                    }
                }
            }
        } else if want_command {
            command = Some(arg.clone());
        } else {
            // The script file closes the line: its arguments follow, dashes included.
            return MainRequest::Script {
                path: arg.clone(),
                args: args[index + 1..].to_vec(),
                interactive,
            };
        }
        index += 1;
    }
    if let Some(string) = command {
        let (arg0, args) = match trailing.split_first() {
            Some((zero, rest)) => (Some(zero.clone()), rest.to_vec()),
            None => (None, Vec::new()),
        };
        return MainRequest::Command {
            string,
            arg0,
            args,
            interactive,
        };
    }
    if want_command {
        return MainRequest::Error("-c: a command string is required".to_owned());
    }
    MainRequest::Stdin { interactive }
}

fn run_string_owning(mut shell: Shell, text: &str, io: &Io) -> i32 {
    let code = match parse::parse_script(text) {
        Ok(script) => match shell.exec_script(&script, io) {
            Ok(status) => status,
            Err(ExecError::Exit(code)) => code,
            Err(error) => {
                report(&error, io);
                1
            }
        },
        Err(error) => {
            io.err_str(&format!(
                "ggs-bash: syntax: {error:?}
"
            ));
            2
        }
    };
    shell.run_exit_trap(io);
    code
}

/// `bash` / `sh` typed inside the shell (a builtin: a clean Windows machine has neither
/// binary, and `bash script.sh`, `bash -c '…'`, `sh -c '…'` are what scripts and AI
/// shell tools reach for). The child is a fresh shell over the parent's exported
/// environment and cwd — functions, aliases and plain variables do not cross, exactly as
/// with a real child process.
pub(crate) fn run_nested(parent: &Shell, io: &Io, name: &str, args: &[String]) -> i32 {
    let mut child = parent.clone();
    child.funcs.clear();
    child.aliases.clear();
    child.locals.clear();
    child.traps.clear();
    child.arrays.clear();
    child.assoc.clear();
    child.jobs = Default::default();
    child.vars.retain(|_, var| var.exported);
    child.args = Vec::new();
    child.arg0 = name.to_owned();
    child.status = 0;
    child.errexit = false;
    child.xtrace = false;
    child.interactive = false;
    match parse_main_args(args) {
        MainRequest::Version => {
            io.out_str(
                "ggs-bash (Git Graph Studio) 1.0
",
            );
            0
        }
        MainRequest::Help => {
            io.out_str(
                "usage: bash [-l] [-c command | script.sh [args...]]
",
            );
            0
        }
        MainRequest::Error(message) => {
            io.err_str(&format!(
                "{name}: {message}
"
            ));
            2
        }
        MainRequest::Command {
            string, arg0, args, ..
        } => {
            if let Some(zero) = arg0 {
                child.arg0 = zero;
            }
            child.args = args;
            run_string_owning(child, &string, io)
        }
        MainRequest::Script { path, args, .. } => {
            child.arg0 = path.clone();
            child.args = args;
            match std::fs::read_to_string(child.resolve_working_path(&path)) {
                Ok(text) => run_string_owning(child, &text, io),
                Err(error) => {
                    io.err_str(&format!(
                        "{name}: {path}: {error}
"
                    ));
                    127
                }
            }
        }
        MainRequest::Stdin { interactive } => {
            if interactive && matches!(io.stdin, exec::Source::Inherit) && is_stdin_tty() {
                child.interactive = true;
                return repl(child, io);
            }
            let text = io.clone().read_all_stdin();
            run_string_owning(child, &text, io)
        }
    }
}

/// The interactive loop: a prompt per logical line, continuation while the input is
/// syntactically incomplete (an open quote, `if` without `fi`, a pending heredoc).
/// ConPTY provides the line discipline and the echo; the shell reads whole lines.
/// Git Bash's startup contract holds: `~/.bashrc` runs first, and the default prompt
/// is its own — green `user@host`, magenta `MINGW64`, yellow `~`-shortened path.
fn repl(mut shell: Shell, io: &Io) -> i32 {
    if let Some(home) = shell.get_var("HOME") {
        let bashrc = shell.resolve_working_path(&format!("{home}/.bashrc"));
        if bashrc.is_file() {
            if let Ok(text) = std::fs::read_to_string(&bashrc) {
                if let Ok(script) = parse::parse_script(&text) {
                    let _ = shell.exec_script(&script, io);
                }
            }
        }
    }
    let mut pending = String::new();
    loop {
        shell.report_finished_jobs(io);
        let prompt = if pending.is_empty() {
            prompt(&shell)
        } else {
            "> ".to_owned()
        };
        // The line editor (history, kill keys, Tab completion) on a raw-capable
        // terminal, plain buffered reads otherwise.
        let line = match lineedit::read_line(&shell, &prompt, io) {
            lineedit::ReadLine::Line(line) => line,
            lineedit::ReadLine::Eof => {
                io.out_str(
                    "
",
                );
                return shell.status;
            }
            lineedit::ReadLine::Interrupted => {
                pending.clear();
                continue;
            }
            lineedit::ReadLine::Failed => return 1,
        };
        if line.trim() == "exit" || line.trim().starts_with("exit ") {
            let code = line
                .split_whitespace()
                .nth(1)
                .and_then(|n| n.parse().ok())
                .unwrap_or(shell.status);
            shell.run_exit_trap(io);
            return code;
        }
        let line = match lineedit::expand_history(&line, &shell.history) {
            Ok(Some(expanded)) => {
                io.out_str(&expanded);
                expanded
            }
            Ok(None) => line,
            Err(message) => {
                io.err_str(&format!("ggs-bash: {message}\n"));
                continue;
            }
        };
        pending.push_str(&line);
        if !parse::is_complete(&pending) {
            continue;
        }
        let source = std::mem::take(&mut pending);
        let trimmed = source.trim();
        if !trimmed.is_empty()
            && shell
                .history
                .last()
                .map(|last| last != trimmed)
                .unwrap_or(true)
        {
            shell.history.push(trimmed.to_owned());
        }
        let _ = run_with_status(&mut shell, &source, io);
    }
}

/// Git Bash's own prompt: `user@host MINGW64 ~/path`, then `$ ` on the same line
/// (the classic dot-files add a newline; the stock one does not). A hand-set `PS1`
/// wins, with the usual `\u \h \w \$` escapes honoured.
fn prompt(shell: &Shell) -> String {
    if let Some(custom) = shell.get_var("PS1") {
        return custom
            .replace("\\u", &shell.get_var("USERNAME").unwrap_or_default())
            .replace("\\h", &shell.get_var("COMPUTERNAME").unwrap_or_default())
            .replace(
                "\\w",
                &msys::display_cwd(&shell.cwd, shell.get_var("HOME").as_deref()),
            )
            .replace("\\$", "$");
    }
    let user = shell
        .get_var("USERNAME")
        .unwrap_or_else(|| "user".to_owned())
        .to_lowercase();
    let host = shell
        .get_var("COMPUTERNAME")
        .unwrap_or_else(|| "localhost".to_owned())
        .to_lowercase();
    let path = msys::display_cwd(&shell.cwd, shell.get_var("HOME").as_deref());
    format!("\x1b[32m{user}@{host}\x1b[0m \x1b[35mMINGW64\x1b[0m \x1b[33m{path}\x1b[0m\n$ ")
}

fn run_with_status(shell: &mut Shell, line: &str, io: &Io) -> i32 {
    match parse::parse_script(line) {
        Ok(script) => match shell.exec_script(&script, io) {
            Ok(status) => status,
            Err(ExecError::Exit(code)) => std::process::exit(code),
            Err(error) => {
                report(&error, io);
                1
            }
        },
        Err(error) => {
            io.err_str(&format!("ggs-bash: {error:?}\n"));
            2
        }
    }
}

fn print_help() {
    println!("ggs-bash — Git Graph Studio's bundled bash-like shell");
    println!();
    println!("usage: ggs-bash [-i] [-l] [-c command | script.sh [args...]]");
    println!();
    println!("POSIX-shaped command language: pipes, redirections, heredocs, && || ;,");
    println!("if / for / while / until / case, functions, command substitution, the");
    println!("common builtins and the built-in line tools (grep, sed, find, ls, ...).");
}

#[cfg(unix)]
fn is_stdin_tty() -> bool {
    // The REPL only engages for a real terminal; piped stdin is a script.
    unsafe { libc_isatty() == 1 }
}

#[cfg(unix)]
extern "C" {
    #[link_name = "isatty"]
    fn libc_isatty() -> i32;
}

#[cfg(windows)]
fn is_stdin_tty() -> bool {
    // On Windows, a piped stdin is the harness case; ConPTY stdin is a console.
    // GetConsoleMode succeeding means a console is attached.
    #[repr(C)]
    struct ConsoleMode {
        mode: u32,
    }
    extern "system" {
        fn GetConsoleMode(handle: *mut core::ffi::c_void, mode: *mut u32) -> i32;
        fn GetStdHandle(which: i32) -> *mut core::ffi::c_void;
    }
    unsafe {
        let handle = GetStdHandle(-10); // STD_INPUT_HANDLE
        let mut mode = ConsoleMode { mode: 0 };
        GetConsoleMode(handle, &mut mode.mode) == 1
    }
}

/* ---------- The test harness ---------- */

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A shell run with stdout captured — every behaviour test's frame.
    pub struct Captured {
        pub stdout: Arc<Mutex<Vec<u8>>>,
        pub stderr: Arc<Mutex<Vec<u8>>>,
        pub io: Io,
    }

    pub fn capture_io() -> Captured {
        let stdout = Arc::new(Mutex::new(Vec::new()));
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let io = Io {
            stdin: exec::Source::Null,
            stdout: exec::Sink::Capture(stdout.clone()),
            stderr: exec::Sink::Capture(stderr.clone()),
        };
        Captured { stdout, stderr, io }
    }

    pub fn out_text(captured: &Captured) -> String {
        String::from_utf8_lossy(&captured.stdout.lock().unwrap()).into_owned()
    }

    pub fn err_text(captured: &Captured) -> String {
        String::from_utf8_lossy(&captured.stderr.lock().unwrap()).into_owned()
    }

    pub fn shell_in(dir: &std::path::Path) -> Shell {
        let mut shell = Shell::new("ggs-bash");
        shell.cwd = dir.to_path_buf();
        shell
    }

    pub fn run_in(dir: &std::path::Path, line: &str) -> (String, String, i32) {
        let captured = capture_io();
        let mut shell = shell_in(dir);
        let status = match parse::parse_script(line) {
            Ok(script) => shell.exec_script(&script, &captured.io).unwrap_or(1),
            Err(error) => {
                captured.io.err_str(&format!("{error:?}"));
                2
            }
        };
        (out_text(&captured), err_text(&captured), status)
    }

    #[test]
    fn pipelines_redirects_and_substitutions_behave() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, _, status) = run_in(dir.path(), "echo hello | tr a-z A-Z; echo $((2+3))");
        assert_eq!(status, 0);
        assert_eq!(out, "HELLO\n5\n");
        let (out, _, _) = run_in(dir.path(), "x=world; echo \"hi $x\" $(echo there)");
        assert_eq!(out, "hi world there\n");
        let (_, _, status) = run_in(dir.path(), "false && echo no; true || echo no");
        assert_eq!(status, 0);
    }

    #[test]
    fn redirections_write_files_and_read_them_back() {
        let dir = tempfile::TempDir::new().unwrap();
        let (_, _, status) = run_in(
            dir.path(),
            "echo one > f.txt && echo two >> f.txt && cat f.txt",
        );
        assert_eq!(status, 0);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            "one\ntwo\n"
        );
        let (out, _, _) = run_in(dir.path(), "cat < f.txt | wc -l");
        assert_eq!(out.trim(), "2");
    }

    #[test]
    fn heredocs_feed_commands() {
        let dir = tempfile::TempDir::new().unwrap();
        let name = dir.path().join("h.txt");
        // A quoted delimiter leaves $name alone; an unquoted one expands it.
        let (out, _, _) = run_in(dir.path(), "name=you; cat <<EOF\nhi $name\nEOF");
        assert_eq!(out, "hi you\n");
        let _ = name;
        let (_, _, status) = run_in(dir.path(), "cat <<'EOF' > quoted.txt\n$literal\nEOF");
        assert_eq!(status, 0);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("quoted.txt")).unwrap(),
            "$literal\n"
        );
    }

    #[test]
    fn control_flow_and_functions_run() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, _, status) = run_in(
            dir.path(),
            "for i in 1 2 3; do echo n$i; done; if true; then echo yes; else echo no; fi",
        );
        assert_eq!(status, 0);
        assert_eq!(out, "n1\nn2\nn3\nyes\n");
        let (out, _, _) = run_in(dir.path(), "greet() { echo \"hi $1\"; }; greet bob");
        assert_eq!(out, "hi bob\n");
        let (out, _, _) = run_in(
            dir.path(),
            "case abc in a*) echo star ;; *) echo other ;; esac",
        );
        assert_eq!(out, "star\n");
        let (out, _, _) = run_in(
            dir.path(),
            "i=0; while [ $i -lt 3 ]; do i=$((i+1)); done; echo $i",
        );
        assert_eq!(out, "3\n");
    }

    #[test]
    fn set_e_stops_a_failing_script() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, _, status) = run_in(dir.path(), "set -e; echo one; false; echo two");
        assert_eq!(status, 1);
        assert_eq!(out, "one\n");
        // A condition context never trips it.
        let (_, _, status) = run_in(dir.path(), "set -e; if false; then :; fi; true");
        assert_eq!(status, 0);
    }

    #[test]
    fn conditions_evaluate_posix_style() {
        let dir = tempfile::TempDir::new().unwrap();
        let (_, _, status) = run_in(dir.path(), "[ 1 -lt 2 ] && [ -d . ]");
        assert_eq!(status, 0);
        let (_, _, status) = run_in(dir.path(), "[[ hello == hel* ]] && [[ ! -z hello ]]");
        assert_eq!(status, 0);
        let (_, _, status) = run_in(dir.path(), "[[ 3 -gt 4 ]] || false");
        assert_eq!(status, 1);
    }

    #[test]
    fn applets_cover_the_posix_line_tools() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.txt"), "beta\nalpha\nalpha\n").unwrap();
        let (out, _, _) = run_in(dir.path(), "cat a.txt | sort | uniq -c");
        assert_eq!(out, "      2 alpha\n      1 beta\n");
        let (out, _, _) = run_in(dir.path(), "grep -c alpha a.txt");
        assert_eq!(out.trim(), "2");
        let (out, _, _) = run_in(
            dir.path(),
            "sed s/alpha/first/ a.txt | head -n 2 | tail -n 1",
        );
        assert_eq!(out, "first\n");
    }

    #[test]
    fn external_programs_spawn_through_the_pipe() {
        // `git` is a prerequisite of the app itself, so it is the one external every
        // environment running these tests can rely on.
        let dir = tempfile::TempDir::new().unwrap();
        let (out, _, status) = run_in(dir.path(), "git --version | cut -d' ' -f1");
        assert_eq!(status, 0, "git --version must run");
        assert_eq!(out.trim(), "git");
    }

    #[test]
    fn subshells_isolate_and_backgrounding_returns() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, _, _) = run_in(dir.path(), "x=1; (x=2; echo inner $x); echo outer $x");
        assert_eq!(out, "inner 2\nouter 1\n");
        let (_, _, status) = run_in(dir.path(), "sleep 0 &");
        assert_eq!(status, 0);
    }

    #[test]
    fn git_bash_path_dialect_round_trips() {
        let dir = tempfile::TempDir::new().unwrap();
        // `pwd` answers in the MSYS form and `cd` accepts it back.
        let (out, _, status) = run_in(dir.path(), "pwd");
        assert_eq!(status, 0);
        let msys_cwd = out.trim_end_matches('\n').to_owned();
        assert!(msys_cwd.starts_with('/'), "{msys_cwd}");
        let (out, _, _) = run_in(dir.path(), &format!("cd {msys_cwd} && pwd"));
        assert_eq!(out.trim_end_matches('\n'), msys_cwd);
        // /dev/null swallows.
        let (_, err, status) = run_in(dir.path(), "echo hi 2>/dev/null");
        assert_eq!((status, err.is_empty()), (0, true));
        // $PATH presents colon-joined and round-trips through assignment.
        let (out, _, _) = run_in(dir.path(), r#"echo "$PATH" | grep -c :"#);
        assert_eq!(out.trim(), "1");
        let (_, _, status) = run_in(dir.path(), r#"PATH="$PATH:/nowhere" git --version"#);
        assert_eq!(status, 0, "a rewritten PATH must still find git");
    }

    #[test]
    fn git_bash_tool_parity_batch() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("one.txt"), "a\nb\n").unwrap();
        std::fs::write(dir.path().join("two.txt"), "a\nc\n").unwrap();
        // diff spots the changed line.
        let (out, _, status) = run_in(dir.path(), "diff one.txt two.txt");
        assert_eq!(status, 1);
        assert!(out.contains("-b") && out.contains("+c"), "{out}");
        let (_, _, status) = run_in(dir.path(), "diff one.txt one.txt");
        assert_eq!(status, 0);
        // tee taps the pipe.
        let (out, _, _) = run_in(dir.path(), "printf x | tee tapped.txt | wc -c");
        assert_eq!(out.trim(), "1");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("tapped.txt")).unwrap(),
            "x"
        );
        // xargs runs the lines as arguments.
        let (out, _, _) = run_in(dir.path(), "printf 'a\nb\n' | xargs echo got:");
        assert_eq!(out, "got: a b\n");
        // checksums verify.
        let _ = run_in(dir.path(), "sha256sum one.txt > sums.txt");
        let (out, _, status) = run_in(dir.path(), "sha256sum -c sums.txt");
        assert_eq!(status, 0, "{out}");
        assert!(out.contains("one.txt: OK"));
        // uname answers the MINGW64 shape on Windows.
        if cfg!(windows) {
            let (out, _, _) = run_in(dir.path(), "uname -s");
            assert!(out.starts_with("MINGW64_NT-"), "{out}");
        }
    }

    #[test]
    fn find_runs_exec_and_delete() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("keep.rs"), "").unwrap();
        std::fs::write(dir.path().join("drop.tmp"), "").unwrap();
        let (out, _, _) = run_in(dir.path(), "find . -name '*.rs' -exec basename {} ;");
        assert_eq!(out.trim(), "keep.rs");
        let (_, _, status) = run_in(dir.path(), "find . -name '*.tmp' -delete");
        assert_eq!(status, 0);
        assert!(!dir.path().join("drop.tmp").exists());
        assert!(dir.path().join("keep.rs").exists());
    }

    #[test]
    fn sed_edits_files_in_place() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("f.txt"), "alpha\nbeta\n").unwrap();
        let (_, _, status) = run_in(dir.path(), "sed -i s/alpha/first/ f.txt");
        assert_eq!(status, 0);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            "first\nbeta\n"
        );
    }

    #[test]
    fn awk_counts_through_the_pipeline() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, _, _) = run_in(
            dir.path(),
            r#"printf 'a x\nb y\na z\n' | awk '{ c[$1]++ } END { print c["a"], c["b"] }'"#,
        );
        assert_eq!(out.trim(), "2 1");
    }

    #[test]
    fn process_substitution_feeds_comparisons() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();
        // `diff file <(cmd)`: the substituted file carries the command's output.
        let (out, _, status) = run_in(dir.path(), r#"diff a.txt <(printf 'one\ntwo\n')"#);
        assert_eq!(status, 0, "{out}");
        let (out, _, status) = run_in(dir.path(), r#"diff a.txt <(printf 'one\nTWO\n')"#);
        assert_eq!(status, 1);
        assert!(out.contains("-two") && out.contains("+TWO"), "{out}");
        // grep over one: `grep x <(echo yx)` must see the content.
        let (out, _, _) = run_in(dir.path(), r#"grep y <(echo xy)"#);
        assert_eq!(out, "xy\n");
    }

    #[test]
    fn scripts_execute_by_shebang() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join("build.sh"),
            "#!/usr/bin/env bash\necho \"args: $1 $2\"\nexit 7\n",
        )
        .unwrap();
        let (out, _, status) = run_in(dir.path(), "./build.sh one two");
        assert_eq!(out, "args: one two\n");
        assert_eq!(status, 7);
    }

    #[test]
    #[cfg(windows)]
    fn batch_scripts_run_from_the_shell_cwd() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join("x.bat"),
            "@echo off\r\necho bat-ran %1\r\nexit /b 7\r\n",
        )
        .unwrap();
        // `shell_in` moves only the shell's cwd — the process cwd stays behind in the
        // cargo harness dir, exactly the trap `anchor_program` closes: Windows resolves
        // a relative application path against the *process* cwd, so without anchoring
        // this would spawn `<harness dir>\x.bat` and cmd.exe would report it missing.
        let (out, err, status) = run_in(dir.path(), "./x.bat one");
        assert_eq!(status, 7, "{out}{err}");
        assert!(out.contains("bat-ran one"), "{out}{err}");
    }

    #[test]
    #[cfg(windows)]
    fn batch_scripts_resolve_after_cd() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(
            dir.path().join("sub").join("y.bat"),
            "@echo off\r\necho from-sub\r\n",
        )
        .unwrap();
        let (out, err, status) = run_in(dir.path(), "cd sub && ./y.bat");
        assert_eq!(status, 0, "{out}{err}");
        assert!(out.contains("from-sub"), "{out}{err}");
    }

    #[test]
    #[cfg(windows)]
    fn patext_completes_an_extensionless_name() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("z.bat"), "@echo off\r\necho completed\r\n").unwrap();
        let (out, err, status) = run_in(dir.path(), "./z");
        assert_eq!(status, 0, "{out}{err}");
        assert!(out.contains("completed"), "{out}{err}");
    }

    #[test]
    #[cfg(windows)]
    fn a_missing_batch_reports_not_found_not_cmd_noise() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, err, status) = run_in(dir.path(), "./nope.bat");
        assert_eq!(status, 127, "{out}{err}");
        assert!(err.contains("command not found"), "{out}{err}");
    }

    #[test]
    fn grep_prints_context_windows() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join("log.txt"),
            "l1\nl2\nhit\nl4\nl5\nl6\nhit2\nl8\n",
        )
        .unwrap();
        let (out, _, _) = run_in(dir.path(), "grep -A 1 -B 1 hit log.txt");
        assert!(out.contains("l2\nhit\nl4"), "{out}");
        assert!(out.contains("--"), "{out}");
        assert!(out.contains("l6\nhit2\nl8"), "{out}");
    }

    #[test]
    fn sort_keys_and_base64_round_trip() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("t.txt"), "b:2\na:9\nc:1\n").unwrap();
        let (out, _, _) = run_in(dir.path(), "sort -t: -k2,2n t.txt");
        assert_eq!(out, "c:1\nb:2\na:9\n");
        let (out, _, _) = run_in(dir.path(), r#"printf 'hello' | base64"#);
        assert_eq!(out.trim(), "aGVsbG8=");
        let (out, _, _) = run_in(dir.path(), r#"printf 'aGVsbG8=' | base64 -d"#);
        assert_eq!(out, "hello");
    }

    #[test]
    fn archives_round_trip() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("x.txt"), "content-here").unwrap();
        let (_, _, status) = run_in(dir.path(), "tar -czf pack.tgz x.txt");
        assert_eq!(status, 0);
        std::fs::remove_file(dir.path().join("x.txt")).unwrap();
        let (_, _, status) = run_in(dir.path(), "tar -xzf pack.tgz");
        assert_eq!(status, 0);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("x.txt")).unwrap(),
            "content-here"
        );
        let (out, _, _) = run_in(dir.path(), "tar -tzf pack.tgz");
        assert!(out.contains("x.txt"), "{out}");
        // gunzip path
        let (_, _, status) = run_in(dir.path(), "gzip x.txt");
        assert_eq!(status, 0);
        assert!(dir.path().join("x.txt.gz").exists());
        let (_, _, status) = run_in(dir.path(), "gunzip x.txt.gz");
        assert_eq!(status, 0);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("x.txt")).unwrap(),
            "content-here"
        );
    }

    #[test]
    fn the_invocation_dialect_parses_like_git_bash() {
        // The harness shapes: the login/interactive flags ride around -c in any order
        // (`bash -c -l pwd` runs pwd — a harness's Bash tool hit `-l: command not
        // found` when -c grabbed the flag as its string, 2026-10-11).
        let as_strings = |argv: &[&str]| argv.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        for argv in [
            &["-l", "-c", "cmd"][..],
            &["-c", "-l", "cmd"][..],
            &["-lc", "cmd"][..],
            &["-ilc", "cmd"][..],
            &["-c", "-i", "-l", "cmd"][..],
            &["--login", "-c", "cmd"][..],
            &["-c", "--", "cmd"][..],
        ] {
            match parse_main_args(&as_strings(argv)) {
                MainRequest::Command { string, .. } => assert_eq!(string, "cmd"),
                _ => panic!("{argv:?}: the flags must parse, the word must be the command"),
            }
        }
        // Words after the -c string are positional ($0, $1…), option-shaped or not.
        match parse_main_args(&as_strings(&["-c", "cmd", "-i", "AA", "BB"])) {
            MainRequest::Command {
                string, arg0, args, ..
            } => {
                assert_eq!(string, "cmd");
                assert_eq!(arg0.as_deref(), Some("-i"));
                assert_eq!(args, vec!["AA".to_owned(), "BB".to_owned()]);
            }
            _ => panic!("the trailing words are positional"),
        }
        // A script file closes the line: its arguments follow, dashes included.
        match parse_main_args(&as_strings(&["build.sh", "-x"])) {
            MainRequest::Script { path, args, .. } => {
                assert_eq!(path, "build.sh");
                assert_eq!(args, vec!["-x".to_owned()]);
            }
            _ => panic!("the script file takes the rest as its arguments"),
        }
        // An unknown option is an error (bash's exit-2 shape), never a command name.
        assert!(matches!(
            parse_main_args(&as_strings(&["-Z"])),
            MainRequest::Error(_)
        ));
        assert!(matches!(
            parse_main_args(&as_strings(&["--bogus"])),
            MainRequest::Error(_)
        ));
        assert!(matches!(
            parse_main_args(&as_strings(&["-c"])),
            MainRequest::Error(_)
        ));
        // Bare invocation reads stdin; -i forces the interactive REPL.
        assert!(matches!(
            parse_main_args(&[]),
            MainRequest::Stdin { interactive: false }
        ));
        assert!(matches!(
            parse_main_args(&as_strings(&["-i"])),
            MainRequest::Stdin { interactive: true }
        ));
        assert!(matches!(
            parse_main_args(&as_strings(&["-v"])),
            MainRequest::Version
        ));
        assert!(matches!(
            parse_main_args(&as_strings(&["--help"])),
            MainRequest::Help
        ));
    }

    #[test]
    fn file_operations_create_copy_move_remove_and_link() {
        let dir = tempfile::TempDir::new().unwrap();
        let (_, _, status) = run_in(
            dir.path(),
            "mkdir -p a/b && echo data > a/b/f.txt && touch top.txt",
        );
        assert_eq!(status, 0);
        assert!(dir.path().join("a/b").is_dir());
        assert!(dir.path().join("top.txt").is_file());
        // cp a file and, with -r, a tree; a directory without -r is refused.
        let (_, _, status) = run_in(dir.path(), "cp a/b/f.txt copy.txt && cp -r a tree");
        assert_eq!(status, 0);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("copy.txt")).unwrap(),
            "data\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("tree/b/f.txt")).unwrap(),
            "data\n"
        );
        let (_, err, status) = run_in(dir.path(), "cp a plain");
        assert_eq!(status, 1);
        assert!(err.contains("directory"), "{err}");
        // cp/mv into a directory keep the name.
        let (_, _, status) = run_in(
            dir.path(),
            "cp copy.txt a/b && mv copy.txt moved.txt && mv moved.txt a/b",
        );
        assert_eq!(status, 0);
        assert!(dir.path().join("a/b/copy.txt").is_file());
        assert!(dir.path().join("a/b/moved.txt").is_file());
        // rm needs -r for a non-empty directory; rmdir takes an empty one.
        let (_, _, status) = run_in(
            dir.path(),
            "rm tree/b/f.txt && rmdir tree/b && rm -r tree && rm top.txt",
        );
        assert_eq!(status, 0);
        assert!(!dir.path().join("tree").exists());
        assert!(!dir.path().join("top.txt").exists());
        // rm -f forgives the missing; without -f the missing is a failure.
        let (_, _, status) = run_in(dir.path(), "rm -f gone.txt");
        assert_eq!(status, 0);
        let (_, _, status) = run_in(dir.path(), "rm gone.txt");
        assert_eq!(status, 1);
        // ln -s: a real symlink where the OS grants it (Windows may refuse without
        // Developer Mode — then the error still says why).
        let (_, err, status) = run_in(dir.path(), "ln -s a/b/f.txt link.txt");
        if status == 0 {
            assert!(dir
                .path()
                .join("link.txt")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink());
        } else {
            assert!(!err.is_empty(), "a refused symlink still says why");
        }
        // chmod MODE FILE: the mode word is never a file (chmod +x works), a missing
        // file fails.
        let (_, _, status) = run_in(dir.path(), "chmod +x a/b/f.txt && chmod 755 a/b/f.txt");
        assert_eq!(status, 0);
        let (_, _, status) = run_in(dir.path(), "chmod +x missing.bin");
        assert_eq!(status, 1);
    }

    #[test]
    fn ls_lists_hides_sorts_and_orders_by_time() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("b.txt"), "").unwrap();
        std::fs::write(dir.path().join("a.txt"), "").unwrap();
        std::fs::write(dir.path().join(".hidden"), "").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        // Plain: sorted case-insensitively, dotfiles hidden.
        let (out, _, status) = run_in(dir.path(), "ls");
        assert_eq!(status, 0);
        assert_eq!(out, "a.txt\nb.txt\nsub\n");
        // -a adds the dot entries, -r reverses, a file argument lists itself.
        let (out, _, _) = run_in(dir.path(), "ls -a");
        assert!(
            out.contains(".hidden\n") && out.contains(".\n") && out.contains("..\n"),
            "{out}"
        );
        let (out, _, _) = run_in(dir.path(), "ls -r");
        assert_eq!(out, "sub\nb.txt\na.txt\n");
        let (out, _, _) = run_in(dir.path(), "ls a.txt");
        assert_eq!(out, "a.txt\n");
        let (_, _, status) = run_in(dir.path(), "ls missing-xyz");
        assert_eq!(status, 2);
        // -t newest first, mtimes pinned through the file handles (no sleeping).
        let a = std::fs::OpenOptions::new()
            .write(true)
            .open(dir.path().join("a.txt"))
            .unwrap();
        a.set_modified(
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000),
        )
        .unwrap();
        let b = std::fs::OpenOptions::new()
            .write(true)
            .open(dir.path().join("b.txt"))
            .unwrap();
        b.set_modified(
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(2_000_000),
        )
        .unwrap();
        let (out, _, _) = run_in(dir.path(), "ls -t");
        let names: Vec<&str> = out.lines().collect();
        assert_eq!(names, vec!["sub", "b.txt", "a.txt"], "{out}");
        // -l's long form: mode, size, stamp, name — directories read drwxr-xr-x.
        let (out, _, _) = run_in(dir.path(), "ls -l a.txt");
        assert!(
            out.starts_with("-rw-r--r--") && out.trim_end().ends_with(" a.txt"),
            "{out}"
        );
        let (out, _, _) = run_in(dir.path(), "ls -l");
        assert!(
            out.lines()
                .any(|line| line.starts_with("drwxr-xr-x") && line.ends_with(" sub")),
            "{out}"
        );
    }

    #[test]
    fn environment_and_path_applets_answer() {
        let dir = tempfile::TempDir::new().unwrap();
        // env lists the exported variables; a VAR=word prefix rides the one command.
        let (out, _, _) = run_in(dir.path(), "export GGS_MARK=hello; env | grep ^GGS_MARK=");
        assert_eq!(out, "GGS_MARK=hello\n");
        let (out, _, _) = run_in(dir.path(), "env GGS_EXTRA=1 | grep ^GGS_EXTRA=");
        assert_eq!(out, "GGS_EXTRA=1\n");
        // which: builtins and applets answer with the shell itself, PATH programs with
        // their path, strangers with a failure.
        let (_, _, status) = run_in(dir.path(), "which ls");
        assert_eq!(status, 0);
        let (out, _, status) = run_in(dir.path(), "which git");
        assert_eq!(status, 0);
        assert!(out.to_lowercase().contains("git"), "{out}");
        let (_, _, status) = run_in(dir.path(), "which no-such-command-xyz");
        assert_eq!(status, 1);
        // type classifies: function, alias, builtin, applet, PATH, missing.
        let (out, _, _) = run_in(dir.path(), "f() { :; }; alias q='ls'; type f q cd grep");
        assert_eq!(out, "f is a function\nq is aliased to `ls`\ncd is a shell builtin\ngrep is a ggs-bash applet\n");
        let (_, _, status) = run_in(dir.path(), "type no-such-command-xyz");
        assert_eq!(status, 1);
        // command -v answers membership WITHOUT running anything (a probe run of `cd`
        // changed the directory; of `set` it dumped the environment).
        let (out, _, status) = run_in(dir.path(), "command -v set cd grep");
        assert_eq!(status, 0);
        assert_eq!(out, "set\ncd\ngrep\n");
        let (out, _, _) = run_in(dir.path(), "command -v cd; pwd");
        assert_eq!(out, format!("cd\n{}\n", msys::to_msys(dir.path())));
        // du -s totals the bytes, -h humanizes.
        std::fs::create_dir_all(dir.path().join("d")).unwrap();
        std::fs::write(dir.path().join("d/f.bin"), "abcd").unwrap();
        let (out, _, _) = run_in(dir.path(), "du -s d");
        assert!(out.starts_with("4\t"), "{out}");
        let (out, _, _) = run_in(dir.path(), "du -sh d");
        assert!(out.starts_with("4B\t"), "{out}");
    }

    #[test]
    fn date_seq_clear_and_identity_applets() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, _, status) = run_in(dir.path(), "date +%Y");
        assert_eq!(status, 0);
        let year = out.trim();
        assert!(year.len() == 4 && year.starts_with("20"), "{year}");
        let (out, _, _) = run_in(dir.path(), "date +%F");
        let text = out.trim();
        assert!(
            text.len() == 10 && &text[4..5] == "-" && &text[7..8] == "-",
            "{text}"
        );
        let (out, _, _) = run_in(dir.path(), "seq 3");
        assert_eq!(out, "1\n2\n3\n");
        let (out, _, _) = run_in(dir.path(), "seq 2 4");
        assert_eq!(out, "2\n3\n4\n");
        let (out, _, _) = run_in(dir.path(), "seq 5 -2 1");
        assert_eq!(out, "5\n3\n1\n");
        let (out, _, _) = run_in(dir.path(), "clear");
        assert_eq!(out, "\x1b[2J\x1b[H");
        let (_, _, status) = run_in(dir.path(), "whoami");
        assert_eq!(status, 0);
        let (_, _, status) = run_in(dir.path(), "hostname");
        assert_eq!(status, 0);
    }

    #[test]
    fn path_applets_translate_between_the_dialects() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, _, _) = run_in(dir.path(), "basename /a/b/c.txt; basename /a/b/c.txt .txt");
        assert_eq!(out, "c.txt\nc\n");
        let (out, _, _) = run_in(
            dir.path(),
            "dirname /a/b/c.txt; dirname plain.txt; dirname /a/",
        );
        assert_eq!(out, "/a/b\n.\n/\n");
        // realpath and readlink -f answer the canonical path in the MSYS dialect (no
        // \\?\ prefix, no backslashes); a missing path fails.
        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        let expected = format!("{}\n", msys::to_msys(&canonical));
        let (out, _, status) = run_in(dir.path(), "realpath .");
        assert_eq!(status, 0);
        assert_eq!(out, expected);
        let (out, _, status) = run_in(dir.path(), "readlink -f .");
        assert_eq!(status, 0);
        assert_eq!(out, expected);
        let (_, _, status) = run_in(dir.path(), "realpath missing-xyz");
        assert_eq!(status, 1);
        // cygpath: -u (default) / -w / -m.
        let (out, _, _) = run_in(
            dir.path(),
            "cygpath /c/foo/bar; cygpath -u 'C:/foo/bar'; cygpath -m /c/foo/bar",
        );
        assert_eq!(out, "/c/foo/bar\n/c/foo/bar\nC:/foo/bar\n");
        let (out, _, _) = run_in(dir.path(), "cygpath -w /c/foo/bar");
        assert_eq!(out, "C:\\foo\\bar\n");
    }

    #[test]
    fn checksums_digest_files_and_verify_listings() {
        let dir = tempfile::TempDir::new().unwrap();
        // The reference vectors, through stdin and through a file.
        let (out, _, _) = run_in(dir.path(), "printf '' | md5sum");
        assert_eq!(out, "d41d8cd98f00b204e9800998ecf8427e  -\n");
        let (out, _, _) = run_in(dir.path(), "printf abc | sha1sum");
        assert_eq!(out, "a9993e364706816aba3e25717850c26c9cd0d89d  -\n");
        std::fs::write(dir.path().join("f.txt"), "abc").unwrap();
        let (out, _, _) = run_in(dir.path(), "md5sum f.txt");
        assert_eq!(out, "900150983cd24fb0d6963f7d28e17f72  f.txt\n");
        // -c verifies, and a tampered file fails the check.
        let (_, _, status) = run_in(dir.path(), "md5sum f.txt > sums.md5");
        assert_eq!(status, 0);
        let (out, _, status) = run_in(dir.path(), "md5sum -c sums.md5");
        assert_eq!(status, 0);
        assert!(out.contains("f.txt: OK"), "{out}");
        std::fs::write(dir.path().join("f.txt"), "tampered").unwrap();
        let (out, _, status) = run_in(dir.path(), "md5sum -c sums.md5");
        assert_eq!(status, 1);
        assert!(out.contains("f.txt: FAILED"), "{out}");
    }

    #[test]
    fn timeout_runs_kills_and_reports_missing() {
        let dir = tempfile::TempDir::new().unwrap();
        // A fast command answers its own status; a missing one is 127.
        let (_, _, status) = run_in(dir.path(), "timeout 5 git --version");
        assert_eq!(status, 0);
        let (_, _, status) = run_in(dir.path(), "timeout 1 no-such-command-xyz");
        assert_eq!(status, 127);
        // Expiry is 124 (GNU's own code): the shell's own sidecar sleeps past the
        // deadline. The binary sits beside the test harness when cargo built it.
        if let Ok(shell) = crate::ext_process::resolve_engine_host("ggs-bash") {
            let shown = shell.display().to_string().replace('\\', "/");
            let (_, _, status) = run_in(dir.path(), &format!("timeout 0.2 '{shown}' -c 'sleep 5'"));
            assert_eq!(status, 124);
        }
    }

    #[test]
    fn unzip_lists_and_extracts_confined() {
        let dir = tempfile::TempDir::new().unwrap();
        // A hand-built stored zip: "dir/hi.txt" carrying "hello".
        let mut zip: Vec<u8> = Vec::new();
        zip.extend_from_slice(b"PK\x03\x04");
        zip.extend_from_slice(&[0x14, 0x00, 0x00, 0x00, 0x00, 0x00]); // version, flags, method 0
        zip.extend_from_slice(&[0, 0, 0, 0]); // time/date
        zip.extend_from_slice(&0u32.to_le_bytes()); // crc (unchecked on the read path)
        zip.extend_from_slice(&5u32.to_le_bytes()); // compressed
        zip.extend_from_slice(&5u32.to_le_bytes()); // uncompressed
        zip.extend_from_slice(&10u16.to_le_bytes()); // name length
        zip.extend_from_slice(&0u16.to_le_bytes()); // extra length
        zip.extend_from_slice(b"dir/hi.txt");
        zip.extend_from_slice(b"hello");
        std::fs::write(dir.path().join("pack.zip"), &zip).unwrap();
        // -l lists, -d extracts into a target, a second run needs -o.
        let (out, _, status) = run_in(dir.path(), "unzip -l pack.zip");
        assert_eq!(status, 0);
        assert!(out.contains("dir/hi.txt"), "{out}");
        let (_, _, status) = run_in(dir.path(), "unzip pack.zip -d out");
        assert_eq!(status, 0);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("out/dir/hi.txt")).unwrap(),
            "hello"
        );
        let (_, err, _) = run_in(dir.path(), "unzip pack.zip -d out");
        assert!(err.contains("exists"), "{err}");
        let (_, _, status) = run_in(dir.path(), "unzip -o pack.zip -d out");
        assert_eq!(status, 0);
    }

    #[test]
    fn grep_flags_cover_the_git_bash_set() {
        let dir = tempfile::TempDir::new().unwrap();
        // -o prints only the matched parts; -E switches to ERE.
        let (out, _, _) = run_in(dir.path(), "printf 'ab12cd34\n' | grep -oE '[0-9]+'");
        assert_eq!(out, "12\n34\n");
        // -v inverts, -n numbers, -i folds case, -q stays quiet.
        let (out, _, _) = run_in(dir.path(), "printf 'a\nb\n' | grep -v a");
        assert_eq!(out, "b\n");
        let (out, _, _) = run_in(dir.path(), "printf 'x\nhit\n' | grep -n hit");
        assert_eq!(out, "2:hit\n");
        let (out, _, _) = run_in(dir.path(), "printf 'HIT\n' | grep -i hit");
        assert_eq!(out, "HIT\n");
        let (out, _, status) = run_in(dir.path(), "printf 'hit\n' | grep -q hit");
        assert_eq!((status, out.is_empty()), (0, true));
        let (_, _, status) = run_in(dir.path(), "printf 'miss\n' | grep -q hit");
        assert_eq!(status, 1);
        // -r walks, labelling every hit; --include/--exclude filter the walk's names.
        std::fs::create_dir_all(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("a.rs"), "hit\n").unwrap();
        std::fs::write(dir.path().join("a.txt"), "hit\n").unwrap();
        std::fs::write(dir.path().join("sub/b.rs"), "hit\n").unwrap();
        let (out, _, status) = run_in(dir.path(), "grep -r hit .");
        assert_eq!(status, 0);
        assert!(
            out.contains("a.rs:hit") && out.contains("b.rs:hit") && out.contains("a.txt:hit"),
            "{out}"
        );
        let (out, _, _) = run_in(dir.path(), "grep -r --include='*.rs' hit .");
        assert!(
            out.contains("a.rs:hit") && out.contains("b.rs:hit") && !out.contains("a.txt"),
            "{out}"
        );
        let (out, _, _) = run_in(dir.path(), "grep -r --exclude='*.txt' hit .");
        assert!(out.contains("a.rs:hit") && !out.contains("a.txt"), "{out}");
        // -C centers the context window; -l names the files only; no match is 1.
        std::fs::write(dir.path().join("log.txt"), "l1\nhit\nl3\n").unwrap();
        let (out, _, _) = run_in(dir.path(), "grep -C 1 hit log.txt");
        assert_eq!(out, "l1\nhit\nl3\n");
        let (out, _, _) = run_in(dir.path(), "grep -l hit log.txt a.rs");
        assert_eq!(out, "log.txt\na.rs\n");
        let (_, _, status) = run_in(dir.path(), "grep zzz log.txt");
        assert_eq!(status, 1);
    }

    #[test]
    fn find_expression_language_covers_the_git_bash_set() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("f1.rs"), "").unwrap();
        std::fs::write(dir.path().join("f2.txt"), "").unwrap();
        std::fs::write(dir.path().join("sub/f3.rs"), "").unwrap();
        // The root echoes as typed (GNU's shape): `find .` answers `./…`.
        let (out, _, status) = run_in(dir.path(), "find . -name 'f1.rs'");
        assert_eq!(status, 0);
        assert_eq!(out, "./f1.rs\n");
        // -o unions, parentheses group, ! negates.
        let (out, _, _) = run_in(dir.path(), "find . -name '*.rs' -o -name '*.txt'");
        assert!(
            out.contains("./f1.rs") && out.contains("./f2.txt") && out.contains("./sub/f3.rs"),
            "{out}"
        );
        let (out, _, _) = run_in(dir.path(), "find . \\( -name '*.txt' \\)");
        assert_eq!(out, "./f2.txt\n");
        let (out, _, _) = run_in(dir.path(), "find . ! -name '*.rs'");
        assert!(
            out.contains("./f2.txt") && !out.contains("f1.rs") && !out.contains("f3.rs"),
            "{out}"
        );
        // -path matches the displayed path, -type the kind, -maxdepth the depth.
        let (out, _, _) = run_in(dir.path(), "find . -path './sub/*'");
        assert_eq!(out, "./sub/f3.rs\n");
        let (out, _, _) = run_in(dir.path(), "find . -type d");
        assert_eq!(out, ".\n./sub\n");
        let (out, _, _) = run_in(dir.path(), "find . -maxdepth 1 -name '*.rs'");
        assert_eq!(out, "./f1.rs\n");
        // -mtime counts whole days of age: +n older, -n newer, n exact.
        let ten_days = std::time::SystemTime::now() - std::time::Duration::from_secs(10 * 86_400);
        let old = std::fs::OpenOptions::new()
            .write(true)
            .open(dir.path().join("f1.rs"))
            .unwrap();
        old.set_modified(ten_days).unwrap();
        let (out, _, _) = run_in(dir.path(), "find . -name 'f*.rs' -mtime +5");
        assert_eq!(out, "./f1.rs\n");
        let (out, _, _) = run_in(dir.path(), "find . -name 'f*.rs' -mtime +50");
        assert_eq!(out, "");
        let (out, _, _) = run_in(dir.path(), "find . -name 'f*.rs' -mtime -5");
        assert_eq!(out, "./sub/f3.rs\n");
    }

    #[test]
    fn sed_sort_head_and_xargs_flags() {
        let dir = tempfile::TempDir::new().unwrap();
        // Multiple -e scripts chain; addresses and the global flag behave.
        let (out, _, _) = run_in(dir.path(), "printf 'ab\n' | sed -e s/a/A/ -e s/b/B/");
        assert_eq!(out, "AB\n");
        let (out, _, _) = run_in(dir.path(), "printf 'a\nb\nc\n' | sed 2d");
        assert_eq!(out, "a\nc\n");
        let (out, _, _) = run_in(dir.path(), "printf 'a\nb\n' | sed -n '$p'");
        assert_eq!(out, "b\n");
        let (out, _, _) = run_in(dir.path(), "printf 'aaa\n' | sed 's/a/b/g'");
        assert_eq!(out, "bbb\n");
        // sort: -n numeric, -r reverse, -u unique, -o writes a file.
        let (out, _, _) = run_in(dir.path(), "printf '10\n9\n' | sort -n");
        assert_eq!(out, "9\n10\n");
        let (out, _, _) = run_in(dir.path(), "printf 'a\nb\n' | sort -r");
        assert_eq!(out, "b\na\n");
        let (out, _, _) = run_in(dir.path(), "printf 'b\na\na\n' | sort -u");
        assert_eq!(out, "a\nb\n");
        std::fs::write(dir.path().join("nums.txt"), "2\n1\n").unwrap();
        let (out, _, status) = run_in(dir.path(), "sort -o sorted.txt nums.txt");
        assert_eq!(status, 0);
        assert!(out.is_empty(), "{out}");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("sorted.txt")).unwrap(),
            "1\n2\n"
        );
        // The spaced flag forms parse too: -t with its delimiter, -k with its key,
        // cut -d/-f (a bare "-t"/"-f" must not be eaten by the glued strip).
        let (out, _, _) = run_in(dir.path(), "printf 'b:2\na:1\n' | sort -t : -k 2");
        assert_eq!(out, "a:1\nb:2\n");
        let (out, _, _) = run_in(dir.path(), "printf 'a:b:c\n' | cut -d : -f 2");
        assert_eq!(out, "b\n");
        // head -c counts bytes, glued or spaced.
        let (out, _, _) = run_in(dir.path(), "printf 'hello' | head -c 3");
        assert_eq!(out, "hel");
        let (out, _, _) = run_in(dir.path(), "printf 'hello' | head -c3");
        assert_eq!(out, "hel");
        // xargs: -n batches, -0 splits on NUL, -I substitutes, -r skips the empty run
        // (without -r GNU runs the command once bare).
        let (out, _, _) = run_in(dir.path(), "printf 'a\nb\nc\n' | xargs -n 2 echo");
        assert_eq!(out, "a b\nc\n");
        std::fs::write(dir.path().join("nul.bin"), b"a\0b\0").unwrap();
        let (out, _, _) = run_in(dir.path(), "xargs -0 echo < nul.bin");
        assert_eq!(out, "a b\n");
        let (out, _, _) = run_in(dir.path(), "printf 'f.txt\n' | xargs -I {} echo got-{}");
        assert_eq!(out, "got-f.txt\n");
        let (out, _, _) = run_in(dir.path(), "printf '' | xargs -r echo ran");
        assert_eq!(out, "");
        let (out, _, _) = run_in(dir.path(), "printf '' | xargs echo ran");
        assert_eq!(out, "ran\n");
    }

    #[test]
    fn variables_export_unset_and_scope() {
        let dir = tempfile::TempDir::new().unwrap();
        // export marks and lists; unset removes; ${x:-word} sees the removal.
        let (out, _, _) = run_in(dir.path(), "export GGS_V=42; export | grep GGS_V");
        assert_eq!(out, "declare -x GGS_V=\"42\"\n");
        let (out, _, _) = run_in(dir.path(), "u=1; unset u; echo \"[${u:-gone}]\"");
        assert_eq!(out, "[gone]\n");
        // A VAR=word prefix scopes to the one command, then the variable is gone again.
        let (out, _, _) = run_in(
            dir.path(),
            "GGS_PX=bar env | grep ^GGS_PX=; echo \"[${GGS_PX:-gone}]\"",
        );
        assert_eq!(out, "GGS_PX=bar\n[gone]\n");
        // local scopes inside a function and dies with it.
        let (out, _, _) = run_in(
            dir.path(),
            "x=global; f() { local x=inner; echo $x; }; f; echo $x",
        );
        assert_eq!(out, "inner\nglobal\n");
        // shift walks the positional parameters.
        let (out, _, _) = run_in(
            dir.path(),
            "f() { echo \"$1/$2\"; shift; echo \"$1/$#\"; }; f a b c",
        );
        assert_eq!(out, "a/b\nb/2\n");
    }

    #[test]
    fn alias_read_source_eval_and_command() {
        let dir = tempfile::TempDir::new().unwrap();
        // alias splices its words into command position; unalias removes it.
        let (out, _, _) = run_in(dir.path(), "alias hi='echo hello'; hi there");
        assert_eq!(out, "hello there\n");
        let (out, _, _) = run_in(dir.path(), "alias hi='echo hello'; alias hi");
        assert_eq!(out, "alias hi='echo hello'\n");
        let (_, _, status) = run_in(dir.path(), "alias hi='echo hello'; unalias hi; hi");
        assert_eq!(status, 127);
        // read splits on IFS (the last name takes the rest); EOF is 1.
        std::fs::write(dir.path().join("line.txt"), "a b c\n").unwrap();
        let (out, _, status) = run_in(dir.path(), "read x y < line.txt; echo \"$x/$y\"");
        assert_eq!(status, 0);
        assert_eq!(out, "a/b c\n");
        let (_, _, status) = run_in(dir.path(), "read x < /dev/null");
        assert_eq!(status, 1);
        // source runs a file in this shell (`.` is the same builtin); return unwinds it.
        std::fs::write(
            dir.path().join("lib.sh"),
            "libvar=42\nlibfn() { echo inlib; }\n",
        )
        .unwrap();
        let (out, _, _) = run_in(dir.path(), "source lib.sh; echo $libvar; libfn");
        assert_eq!(out, "42\ninlib\n");
        let (out, _, _) = run_in(dir.path(), ". lib.sh; echo $libvar");
        assert_eq!(out, "42\n");
        std::fs::write(dir.path().join("r.sh"), "return 3\n").unwrap();
        let (out, _, _) = run_in(dir.path(), "source r.sh; echo $?");
        assert_eq!(out, "3\n");
        // eval parses its joined arguments; command skips functions and aliases.
        let (out, _, _) = run_in(dir.path(), "eval \"evar=5\"; echo $evar");
        assert_eq!(out, "5\n");
        let (out, _, _) = run_in(
            dir.path(),
            "echo() { printf 'shadowed\n'; }; echo direct; command echo bypass",
        );
        assert_eq!(out, "shadowed\nbypass\n");
    }

    #[test]
    fn set_flags_break_continue_return_and_history() {
        let dir = tempfile::TempDir::new().unwrap();
        // set -x traces to stderr, set +x stops.
        let (out, err, _) = run_in(dir.path(), "set -x; echo traced; set +x; echo quiet");
        assert_eq!(out, "traced\nquiet\n");
        assert!(
            err.contains("+ echo traced") && !err.contains("+ echo quiet"),
            "{err}"
        );
        // set -f keeps a glob literal.
        std::fs::write(dir.path().join("only.rs"), "").unwrap();
        let (out, _, _) = run_in(dir.path(), "set -f; echo *.rs; set +f; echo *.rs");
        assert_eq!(out, "*.rs\nonly.rs\n");
        // break and continue steer the loop; return sets the function's status.
        let (out, _, _) = run_in(
            dir.path(),
            "for i in a b c d; do [ $i = b ] && continue; [ $i = d ] && break; echo $i; done",
        );
        assert_eq!(out, "a\nc\n");
        let (out, _, _) = run_in(dir.path(), "f() { return 3; }; f; echo $?");
        assert_eq!(out, "3\n");
        // history lists the interactive log, numbered.
        let captured = capture_io();
        let mut shell = shell_in(dir.path());
        shell.history.push("echo one".to_owned());
        let status = run_with(shell, "history", &captured.io);
        assert_eq!(status, 0);
        assert_eq!(out_text(&captured), "    1  echo one\n");
    }

    #[test]
    fn until_herestrings_and_output_process_substitution() {
        let dir = tempfile::TempDir::new().unwrap();
        // until loops while the condition FAILS.
        let (out, _, _) = run_in(
            dir.path(),
            "i=0; until [ $i -ge 3 ]; do i=$((i+1)); done; echo $i",
        );
        assert_eq!(out, "3\n");
        // <<< feeds the word (expanded) plus a newline as stdin.
        let (out, _, _) = run_in(dir.path(), "cat <<< hello");
        assert_eq!(out, "hello\n");
        let (out, _, _) = run_in(dir.path(), "w=world; tr a-z A-Z <<< \"hi $w\"");
        assert_eq!(out, "HI WORLD\n");
        // >(cmd) consumes the redirect's file once the producer finishes, writing to
        // the command's own stdout.
        let (out, _, status) = run_in(dir.path(), "echo hi > >(tr a-z A-Z)");
        assert_eq!(status, 0);
        assert_eq!(out, "HI\n");
        let (_, _, status) = run_in(dir.path(), "printf 'x\ny\n' > >(wc -l > count.txt)");
        assert_eq!(status, 0);
        assert!(std::fs::read_to_string(dir.path().join("count.txt"))
            .unwrap()
            .contains('2'));
        // The <(cmd) temp file is cleaned up at the pipeline's tail.
        let (out, _, _) = run_in(dir.path(), "cat <(printf 'psub-marker\n')");
        assert_eq!(out, "psub-marker\n");
        let (out, _, _) = run_in(dir.path(), "echo <(printf 'x')");
        let shown = out.trim();
        assert!(shown.contains("ggs-psub-"), "{shown}");
        assert!(
            !std::path::Path::new(shown).exists(),
            "the <(cmd) temp file leaked: {shown}"
        );
    }

    #[test]
    fn parameter_expansions_cover_the_forms() {
        let dir = tempfile::TempDir::new().unwrap();
        // :- defaults, := assigns, :+ alternates, ${#x} lengths.
        let (out, _, _) = run_in(
            dir.path(),
            "echo ${missing:-def}; x=; echo ${x:-def}; x=val; echo ${x:-def}",
        );
        assert_eq!(out, "def\ndef\nval\n");
        let (out, _, _) = run_in(dir.path(), "echo ${y:=assigned}; echo $y");
        assert_eq!(out, "assigned\nassigned\n");
        let (out, _, _) = run_in(
            dir.path(),
            "x=val; echo ${x:+alt}; unset z; echo \"a${z:+alt}b\"",
        );
        assert_eq!(out, "alt\nab\n");
        let (out, _, _) = run_in(dir.path(), "x=hello; echo ${#x}");
        assert_eq!(out, "5\n");
        // $? the last status, $#/$@ the positionals, $0 the shell's own name.
        let (out, _, _) = run_in(dir.path(), "false; echo $?; true; echo $?");
        assert_eq!(out, "1\n0\n");
        let (out, _, _) = run_in(dir.path(), "f() { echo \"$#|$@\"; }; f a b c");
        assert_eq!(out, "3|a b c\n");
        let (out, _, _) = run_in(
            dir.path(),
            "f() { for a in \"$@\"; do echo \"[$a]\"; done; }; f 'x y' z",
        );
        assert_eq!(out, "[x y]\n[z]\n");
        let (out, _, _) = run_in(dir.path(), "echo $0");
        assert_eq!(out, "ggs-bash\n");
    }
    #[test]
    fn bash_and_sh_run_as_nested_shells() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, _, status) = run_in(dir.path(), "bash -c 'echo hi $0 $1' zero one");
        assert_eq!(
            (out.as_str(), status),
            (
                "hi zero one
",
                0
            )
        );
        let (out, _, _) = run_in(dir.path(), "sh -c 'echo nested; exit 3'; echo status=$?");
        assert_eq!(
            out,
            "nested
status=3
"
        );
        std::fs::write(
            dir.path().join("s.sh"),
            "echo script $1 $2
",
        )
        .unwrap();
        let (out, _, _) = run_in(dir.path(), "bash s.sh a b");
        assert_eq!(
            out,
            "script a b
"
        );
        // Plain variables and functions stay in the parent; exported ones cross.
        let (out, _, _) = run_in(
            dir.path(),
            "plain=1; export shared=2; f() { :; }; bash -c 'echo [$plain][$shared]; type f >/dev/null 2>&1 && echo fn'",
        );
        assert_eq!(
            out,
            "[][2]
"
        );
        let (out, _, _) = run_in(dir.path(), "echo 'echo piped' | bash");
        assert_eq!(
            out,
            "piped
"
        );
        let (_, err, status) = run_in(dir.path(), "bash missing.sh");
        assert_eq!(status, 127);
        assert!(err.contains("missing.sh"));
        let (out, _, _) = run_in(dir.path(), "command -v bash sh");
        assert_eq!(
            out,
            "bash
sh
"
        );
    }

    #[test]
    fn less_and_more_print_whole_inputs() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join("f.txt"),
            "a
b
",
        )
        .unwrap();
        let (out, _, _) = run_in(dir.path(), "less -R f.txt");
        assert_eq!(
            out,
            "a
b
"
        );
        let (out, _, _) = run_in(dir.path(), "cat f.txt | more");
        assert_eq!(
            out,
            "a
b
"
        );
        let (out, _, _) = run_in(dir.path(), "less -N f.txt");
        assert_eq!(
            out,
            "     1  a
     2  b
"
        );
    }
    #[test]
    fn brace_expansion_covers_lists_sequences_and_nesting() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, _, _) = run_in(dir.path(), "echo {a,b,c} x{1,2}y {1..5} {a..e} {01..03}");
        assert_eq!(
            out,
            "a b c x1y x2y 1 2 3 4 5 a b c d e 01 02 03
"
        );
        let (out, _, _) = run_in(dir.path(), "echo {1..10..3} {5..1..2} {a,b{1,2}}");
        assert_eq!(
            out,
            "1 4 7 10 5 3 1 a b1 b2
"
        );
        // Literal braces stay: no comma, no sequence, quoted, or a `find` placeholder.
        let (out, _, _) = run_in(dir.path(), "echo {} {a} '{x,y}' \"{x,y}\" ${HOME:+{p,q}}");
        assert!(out.starts_with("{} {a} {x,y} {x,y}"));
        let (out, _, _) = run_in(
            dir.path(),
            "x=B; echo pre{a,$x}post; mkdir -p d/{s,t}; ls d",
        );
        assert_eq!(
            out,
            "preapost preBpost
s
t
"
        );
    }
    #[test]
    fn trap_exit_and_multi_level_loop_control() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, _, _) = run_in(
            dir.path(),
            "bash -c \"trap 'echo bye' EXIT; echo work; trap -p\"",
        );
        assert_eq!(out, "work\ntrap -- 'echo bye' EXIT\nbye\n");
        let (out, _, _) = run_in(
            dir.path(),
            "bash -c \"trap 'echo cleanup' EXIT; exit 4\"; echo rc=$?",
        );
        assert_eq!(out, "cleanup\nrc=4\n");
        let (out, _, _) = run_in(
            dir.path(),
            "bash -c \"trap 'echo no' EXIT; trap - EXIT; echo x\"",
        );
        assert_eq!(out, "x\n");
        let (out, _, _) = run_in(
            dir.path(),
            "for i in 1 2 3; do for j in a b; do [ $j = b ] && continue 2; echo $i$j; done; done; for i in 1 2; do for j in a b; do echo $i$j; break 2; done; done",
        );
        assert_eq!(out, "1a\n2a\n3a\n1a\n");
    }
    #[test]
    fn arrays_cover_literals_elements_and_expansions() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, _, _) = run_in(
            dir.path(),
            "a=(one two 'three four'); echo ${a[0]} ${a[1]} ${#a[@]} ${#a[2]}; for x in \"${a[@]}\"; do echo \"[$x]\"; done",
        );
        assert_eq!(out, "one two 3 10\n[one]\n[two]\n[three four]\n");
        let (out, _, _) = run_in(
            dir.path(),
            "a=(x y); a+=(z); a[5]=w; b[1]=q; echo ${#a[@]} ${a[-1]} \"${!b[@]}\" $a; unset 'a[0]'; echo ${a[@]}",
        );
        assert_eq!(
            out,
            "6 w 0 1 x
y z w
"
        );
    }

    #[test]
    fn parameter_operators_trim_replace_slice_and_case() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, _, _) = run_in(
            dir.path(),
            "f=/a/b/file.tar.gz; echo ${f##*/} ${f%/*} ${f%.*} ${f%%.*} ${f#/a/} ${f/b/X} ${f//[ab]/_} ${f/#\\/a/Z} ${f/%gz/zip}",
        );
        assert_eq!(
            out,
            "file.tar.gz /a/b /a/b/file.tar /a/b/file b/file.tar.gz /a/X/file.tar.gz /_/_/file.t_r.gz Z/b/file.tar.gz /a/b/file.tar.zip\n"
        );
        let (out, _, _) = run_in(
            dir.path(),
            "s=Hello; echo ${s:1:3} ${s: -2} ${s:2} ${s^^} ${s,,} ${s^} ${s/l/L} \"${s// /_}\"; set -- a b c d; echo \"${@:2:2}\" ${#s}",
        );
        assert_eq!(out, "ell lo llo HELLO hello Hello HeLlo Hello\nb c 5\n");
        let (out, _, _) = run_in(
            dir.path(),
            "x=\"a b c\"; echo \"${x/ /-}\" ${x:-no} ${y:-no} ${x:+yes}",
        );
        assert_eq!(out, "a-b c a b c no yes\n");
    }

    #[test]
    fn declare_and_mapfile_manage_arrays() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, _, _) = run_in(
            dir.path(),
            "declare -a l=(p q); declare -x E=1; printf 'a\\nb\\n' > lines.txt; mapfile -t m < lines.txt; echo ${l[1]} ${#m[@]} ${m[1]}; bash -c 'echo [${l[0]}] $E'",
        );
        assert_eq!(out, "q 2 b\n[] 1\n");
    }
    #[test]
    fn associative_arrays_hold_string_keys() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, err, _) = run_in(
            dir.path(),
            "declare -A m; m[one]=1; m[two]=2; k=three; m[$k]=3; m+=([four]=4); echo ${m[one]} ${m[$k]} ${#m[@]}; echo ${!m[@]}; echo ${m[@]}; unset 'm[two]'; echo ${#m[@]}; declare -A n=([a]=x [b]=y); for key in \"${!n[@]}\"; do echo \"$key=${n[$key]}\"; done",
        );
        assert_eq!(err, "");
        assert_eq!(out, "1 3 4\none two three four\n1 2 3 4\n3\na=x\nb=y\n");
    }

    #[test]
    fn arithmetic_command_let_and_c_for() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, err, _) = run_in(
            dir.path(),
            "i=0; ((i++)); ((i += 5)); echo $i; let 'j = i * 2' k=3; echo $j $k; if (( i > 5 && j == 12 )); then echo big; fi; ((0)) || echo zero; for ((n=0; n<4; n++)); do ((n == 2)) && continue; echo -n \"$n \"; done; echo; s=0; for (( ; s<3; )); do ((s++)); done; echo $s; echo $((2**10)) $((7&3|8)) $((x=4, x*x))",
        );
        assert_eq!(err, "");
        assert_eq!(out, "6\n12 3\nbig\nzero\n0 1 3 \n3\n1024 11 16\n");
    }

    #[test]
    fn subscripts_with_variables_and_read_array() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, err, _) = run_in(
            dir.path(),
            "i=2; a[$i]=two; a[i+1]=three; a[0]=zero; echo ${a[2]} ${a[3]} ${#a[@]}; echo 'x y  z' | { read -a w; echo ${#w[@]} ${w[2]}; }; w2=(p q); idx=1; echo ${w2[$idx]} ${w2[idx-1]}; w2[idx]+=Q; echo ${w2[1]}",
        );
        assert_eq!(err, "");
        assert_eq!(out, "two three 4\n3 z\nq p\nqQ\n");
    }

    #[test]
    fn background_jobs_wait_and_report() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, err, status) = run_in(
            dir.path(),
            "(sleep 0.2; echo slow) & echo started; wait; echo after; true & wait %1; echo rc=$?; sleep 0.1 & jobs; wait; jobs",
        );
        assert_eq!(err, "");
        assert_eq!(status, 0);
        assert!(out.starts_with("started\nslow\nafter\n"));
        assert!(out.contains("rc=0\n"));
        assert!(out.contains("Running"));
    }

    #[test]
    fn find_walks_preorder_and_batches_exec_plus() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("a/x")).unwrap();
        std::fs::create_dir(dir.path().join("b")).unwrap();
        std::fs::write(dir.path().join("a/x/y"), "").unwrap();
        std::fs::write(dir.path().join("f1"), "").unwrap();
        std::fs::write(dir.path().join("f2"), "").unwrap();
        // Pre-order: the root itself first, then each subtree depth-first, names
        // sorted — GNU's walk (`find _t` answered only the children before).
        let (out, _, status) = run_in(dir.path(), "find .");
        assert_eq!(status, 0);
        assert_eq!(out, ".\n./a\n./a/x\n./a/x/y\n./b\n./f1\n./f2\n");
        // The root is a candidate like any other: -maxdepth 0 answers it alone.
        let (out, _, _) = run_in(dir.path(), "find . -maxdepth 0");
        assert_eq!(out, ".\n");
        // `-exec {} +` runs ONE command over the whole batch — a single echo line.
        let (out, _, status) = run_in(dir.path(), "find . -name 'f*' -exec echo {} +");
        assert_eq!(status, 0);
        assert_eq!(out, "./f1 ./f2\n");
        // No matches, no run.
        let (out, _, status) = run_in(dir.path(), "find . -name 'zz*' -exec echo {} +");
        assert_eq!((status, out.as_str()), (0, ""));
    }

    #[test]
    fn awk_blank_records_the_in_operator_and_print_redirects() {
        let dir = tempfile::TempDir::new().unwrap();
        // Every input line — blank ones included — is a record.
        let (out, _, _) = run_in(
            dir.path(),
            "printf 'a\n\nb\n' | awk '{ print NR \":\" NF \":\" $0 }'",
        );
        assert_eq!(out, "1:1:a\n2:0:\n3:1:b\n");
        // `in` is an operator keyword, both polarities; a plain `2 in a` used to
        // concatenate into "2".
        let (out, _, _) = run_in(
            dir.path(),
            "printf '' | awk 'BEGIN { a[1]=7; print (2 in a); if (1 in a) print \"yes\"; if (!(2 in a)) print \"no\" }'",
        );
        assert_eq!(out, "0\nyes\nno\n");
        // `$0 ~ /re/` matches; a `/` after `)` divides.
        let (out, _, _) = run_in(
            dir.path(),
            "printf 'ax\nbx\n' | awk '($0 ~ /a/) && /x/ { print ($1 \"!\") }'",
        );
        assert_eq!(out, "ax!\n");
        let (out, _, _) = run_in(dir.path(), "printf '' | awk 'BEGIN { print (2+2)/2 }'");
        assert_eq!(out, "2\n");
        // print > file truncates; >> appends.
        let (_, _, status) = run_in(
            dir.path(),
            "printf '' | awk 'BEGIN { print \"one\" > \"f.txt\" }'",
        );
        assert_eq!(status, 0);
        let (_, _, status) = run_in(
            dir.path(),
            "printf '' | awk 'BEGIN { print \"two\" >> \"f.txt\" }'",
        );
        assert_eq!(status, 0);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            "one\ntwo\n"
        );
    }

    #[test]
    fn name_indirection_reads_through_the_variable() {
        let dir = tempfile::TempDir::new().unwrap();
        let (out, _, _) = run_in(dir.path(), "x=hello; y=x; echo ${!y}");
        assert_eq!(out, "hello\n");
        let (out, _, _) = run_in(dir.path(), "a=b; b=done; echo ${!a}");
        assert_eq!(out, "done\n");
    }

    #[test]
    fn ifs_field_splitting_follows_posix() {
        let dir = tempfile::TempDir::new().unwrap();
        // Only unquoted expansion results split — literal text never does, whatever
        // IFS holds.
        let (out, _, _) = run_in(dir.path(), "IFS=:; set -- a::b; echo literal=$#");
        assert_eq!(out, "literal=1\n");
        // An unquoted expansion splits on the non-whitespace delimiters, adjacent
        // ones leaving an empty field between them.
        let (out, _, _) = run_in(dir.path(), "IFS=:; v=a::b; set -- $v; echo split=$# 2=[$2]");
        assert_eq!(out, "split=3 2=[]\n");
        // IFS whitespace before a delimiter merges into it instead of adding empties.
        let (out, _, _) = run_in(dir.path(), "IFS=' :'; v='a :: b'; set -- $v; echo mixed=$#");
        assert_eq!(out, "mixed=3\n");
        // `"$*"` joins with the FIRST IFS character; unquoted `$@` re-joins the same
        // way and the IFS loop breaks it apart again.
        let (out, _, _) = run_in(dir.path(), "IFS=:; set -- a b c; echo \"$*\"");
        assert_eq!(out, "a:b:c\n");
        let (out, _, _) = run_in(
            dir.path(),
            "IFS=:; set -- a b c; for x in $@; do echo \"[$x]\"; done",
        );
        assert_eq!(out, "[a]\n[b]\n[c]\n");
        // IFS set but empty glues nothing.
        let (out, _, _) = run_in(dir.path(), "IFS=; set -- a b; echo \"$*\"x");
        assert_eq!(out, "abx\n");
        // Glob characters in unquoted literal text still glob.
        std::fs::write(dir.path().join("g.txt"), "").unwrap();
        let (out, _, _) = run_in(dir.path(), "echo *.txt");
        assert_eq!(out, "g.txt\n");
    }

    #[test]
    fn timeout_carries_the_pipelines_streams() {
        let dir = tempfile::TempDir::new().unwrap();
        // The wrapped command runs against the shell's Io, not the process's stdio:
        // its stdout reaches the capture and the pipeline's stdin reaches it.
        let (out, _, status) = run_in(dir.path(), "timeout 5 git --version");
        assert_eq!(status, 0);
        assert!(out.starts_with("git version"), "{out}");
        let (out, _, status) = run_in(
            dir.path(),
            "printf 'needle\n' | timeout 5 git hash-object --stdin",
        );
        assert_eq!(status, 0);
        assert_eq!(out.trim().len(), 40, "{out}");
    }
}
