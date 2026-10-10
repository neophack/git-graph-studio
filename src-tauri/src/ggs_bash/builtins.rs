//! The shell builtins — the commands that need the shell's own state (`cd`, `export`,
//! `return`) or must run in-process to mean anything (`eval`, `source`). Everything
//! else an interactive user types is either an applet (`applets.rs`) or an external
//! program. [`run_builtin`] answers `None` for names it does not own, which is how the
//! dispatcher falls through.

use std::path::{Path, PathBuf};

use super::exec::{ExecError, ExecResult, Io, Shell};
use super::parse;

/// The names [`run_builtin`] answers — `type` and `command -v` test membership without
/// executing anything (a probe run of `set` would print the whole environment).
pub const BUILTIN_NAMES: &[&str] = &[
    ":",
    "true",
    "false",
    "echo",
    "printf",
    "cd",
    "pwd",
    "export",
    "unset",
    "set",
    "shift",
    "exit",
    "return",
    "break",
    "continue",
    "type",
    "alias",
    "unalias",
    "local",
    "read",
    "source",
    ".",
    "eval",
    "test",
    "[",
    "command",
    "wait",
    "history",
    "bash",
    "sh",
    "trap",
    "declare",
    "typeset",
    "mapfile",
    "readarray",
    "((",
    "let",
    "jobs",
    "fg",
    "bg",
    "disown",
    "kill",
];

pub fn is_builtin(name: &str) -> bool {
    BUILTIN_NAMES.contains(&name)
}

/// Run `name` as a builtin, if it is one.
pub fn run_builtin(shell: &mut Shell, io: &Io, name: &str, args: &[String]) -> Option<ExecResult> {
    let result = match name {
        ":" => Ok(0),
        "true" => Ok(0),
        "false" => Ok(1),
        "echo" => echo(shell, io, args),
        "printf" => printf(shell, io, args),
        "cd" => cd(shell, io, args),
        "pwd" => {
            // Git Bash prints `/c/Users/...`; `pwd -W` answers the Windows form.
            if args.iter().any(|arg| arg == "-W") {
                io.out_str(&format!("{}\n", shell.cwd.display()));
            } else {
                io.out_str(&format!("{}\n", super::msys::to_msys(&shell.cwd)));
            }
            Ok(0)
        }
        "history" => {
            for (index, line) in shell.history.iter().enumerate() {
                io.out_str(&format!("{:>5}  {line}\n", index + 1));
            }
            Ok(0)
        }
        "export" => export(shell, io, args),
        "unset" => unset(shell, args),
        "set" => set(shell, io, args),
        "shift" => shift(shell, args),
        "exit" => Err(ExecError::Exit(
            args.first()
                .and_then(|n| n.parse().ok())
                .unwrap_or(shell.status),
        )),
        "return" => Err(ExecError::Return(
            args.first()
                .and_then(|n| n.parse().ok())
                .unwrap_or(shell.status),
        )),
        "break" => Err(ExecError::Break(loop_levels(args))),
        "continue" => Err(ExecError::Continue(loop_levels(args))),
        "trap" => trap(shell, io, args),
        "declare" | "typeset" => declare(shell, io, args),
        "((" => Ok(match args.first().and_then(|v| v.parse::<i64>().ok()) {
            Some(0) | None => 1,
            Some(_) => 0,
        }),
        "let" => let_command(shell, io, args),
        "jobs" => jobs_command(shell, io, args),
        "fg" => fg_command(shell, io, args),
        "bg" => bg_command(shell, io, args),
        "disown" => disown_command(shell, args),
        "kill" => kill_command(shell, io, args),
        "mapfile" | "readarray" => mapfile(shell, io, args),
        "type" => type_of(shell, io, args),
        "alias" => alias(shell, io, args),
        "unalias" => unalias(shell, args),
        "local" => local(shell, io, args),
        "read" => read(shell, io, args),
        "source" | "." => source(shell, io, args),
        "eval" => eval(shell, io, args),
        "test" => test_command(shell, io, args, false),
        "[" => {
            let mut words = args.to_vec();
            if words.last().map(String::as_str) == Some("]") {
                words.pop();
            }
            test_command(shell, io, &words, false)
        }
        "command" => command(shell, io, args),
        "wait" => wait_command(shell, io, args),
        "bash" | "sh" => Ok(super::run_nested(shell, io, name, args)),
        _ => return None,
    };
    Some(result)
}

/* ---------- Output builtins ---------- */

/// `declare` / `typeset`: `-a` arrays, `-x` export, `name=value`, `name=(a b)`; the
/// integer / readonly / case flags are accepted and ignored, `-A` (associative) is not
/// supported and says so.
fn declare(shell: &mut Shell, _io: &Io, args: &[String]) -> ExecResult {
    let mut array = false;
    let mut assoc = false;
    let mut export = false;
    let mut names: Vec<&String> = Vec::new();
    for arg in args {
        if let Some(flags) = arg.strip_prefix('-').filter(|f| !f.is_empty()) {
            for flag in flags.chars() {
                match flag {
                    'a' => array = true,
                    'x' => export = true,
                    'A' => assoc = true,
                    _ => {}
                }
            }
        } else {
            names.push(arg);
        }
    }
    for arg in names {
        let (name, value) = match arg.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (arg.as_str(), None),
        };
        match value {
            Some(list) if assoc && list.starts_with('(') && list.ends_with(')') => {
                shell.vars.remove(name);
                shell.arrays.remove(name);
                shell.assoc.insert(name.to_owned(), Vec::new());
                for item in list[1..list.len() - 1].split_whitespace() {
                    if let Some((key, text)) =
                        item.strip_prefix('[').and_then(|r| r.split_once("]="))
                    {
                        shell.assoc_set(name, key, text.to_owned(), false);
                    }
                }
            }
            None if assoc => {
                shell.vars.remove(name);
                shell.arrays.remove(name);
                shell.assoc.entry(name.to_owned()).or_default();
            }
            Some(list) if list.starts_with('(') && list.ends_with(')') => {
                let items = list[1..list.len() - 1]
                    .split_whitespace()
                    .map(str::to_owned)
                    .collect();
                shell.vars.remove(name);
                shell.arrays.insert(name.to_owned(), items);
            }
            Some(text) if array => {
                shell.vars.remove(name);
                shell.arrays.insert(name.to_owned(), vec![text.to_owned()]);
            }
            Some(text) => shell.set_var(name, text),
            None if array => {
                shell.arrays.entry(name.to_owned()).or_default();
            }
            None => {}
        }
        if export {
            if let Some(text) = shell.get_var(name) {
                shell.export_var(name, Some(&text));
            }
        }
    }
    Ok(0)
}

/// `mapfile [-t] [name]` / `readarray`: stdin's lines into an array (`MAPFILE` by default).
fn mapfile(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut trim = false;
    let mut name = "MAPFILE".to_owned();
    for arg in args {
        match arg.as_str() {
            "-t" => trim = true,
            flag if flag.starts_with('-') => {}
            other => name = other.to_owned(),
        }
    }
    let text = io.clone().read_all_stdin();
    let items: Vec<String> = text
        .split_inclusive('\n')
        .map(|line| {
            if trim {
                line.trim_end_matches(['\n', '\r']).to_owned()
            } else {
                line.to_owned()
            }
        })
        .collect();
    shell.vars.remove(&name);
    shell.arrays.insert(name, items);
    Ok(0)
}

/// `let expr…`: each argument an arithmetic expression; the status is that of the last
/// (0 when it is nonzero, as in bash).
fn let_command(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut last = 0;
    for arg in args {
        match super::expand::eval_arith(shell, arg, io) {
            Ok(value) => last = value,
            Err(error) => {
                if let Some(message) = error.message() {
                    io.err_str(&format!("let: {message}\n"));
                }
                return Ok(1);
            }
        }
    }
    Ok(i32::from(last == 0))
}

/// `%n`, `n` or nothing (the newest job) → a job id.
fn job_id(shell: &Shell, spec: Option<&String>) -> Option<usize> {
    let table = shell.jobs.lock().unwrap();
    match spec {
        None => table.list.last().map(|j| j.id),
        Some(text) => {
            let n: usize = text.trim_start_matches('%').parse().ok()?;
            table.list.iter().find(|j| j.id == n).map(|j| j.id)
        }
    }
}

/// Wait for one job and take it out of the table; its exit status.
fn join_job(shell: &Shell, id: usize) -> Option<i32> {
    let (handle, status) = {
        let mut table = shell.jobs.lock().unwrap();
        let at = table.list.iter().position(|j| j.id == id)?;
        let job = &mut table.list[at];
        (job.handle.take(), job.status.clone())
    };
    if let Some(handle) = handle {
        let _ = handle.join();
    }
    let code = (*status.lock().unwrap()).unwrap_or(0);
    shell.jobs.lock().unwrap().list.retain(|j| j.id != id);
    Some(code)
}

fn wait_command(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    if args.is_empty() {
        let ids: Vec<usize> = shell
            .jobs
            .lock()
            .unwrap()
            .list
            .iter()
            .map(|j| j.id)
            .collect();
        for id in ids {
            join_job(shell, id);
        }
        return Ok(0);
    }
    let mut status = 0;
    for spec in args {
        match job_id(shell, Some(spec)).and_then(|id| join_job(shell, id)) {
            Some(code) => status = code,
            None => {
                io.err_str(&format!("wait: {spec}: no such job\n"));
                status = 127;
            }
        }
    }
    Ok(status)
}

fn jobs_command(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let pids_only = args.iter().any(|a| a == "-p");
    let mut table = shell.jobs.lock().unwrap();
    let newest = table.list.last().map(|j| j.id);
    let mut finished = Vec::new();
    for job in &table.list {
        let state = match *job.status.lock().unwrap() {
            None => "Running".to_owned(),
            Some(0) => "Done".to_owned(),
            Some(code) => format!("Exit {code}"),
        };
        if pids_only {
            io.out_str(&format!("{}\n", job.id));
        } else {
            let mark = if Some(job.id) == newest { '+' } else { '-' };
            io.out_str(&format!("[{}]{mark}  {state:<24}{}\n", job.id, job.text));
        }
        if job.status.lock().unwrap().is_some() {
            finished.push(job.id);
        }
    }
    table.list.retain(|j| !finished.contains(&j.id));
    Ok(0)
}

fn fg_command(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let Some(id) = job_id(shell, args.first()) else {
        io.err_str("fg: no such job\n");
        return Ok(1);
    };
    if let Some(job) = shell.jobs.lock().unwrap().list.iter().find(|j| j.id == id) {
        io.out_str(&format!("{}\n", job.text.trim_end_matches(" &")));
    }
    Ok(join_job(shell, id).unwrap_or(1))
}

fn bg_command(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    match job_id(shell, args.first()) {
        Some(id) => {
            // Jobs start in the background and stay there: nothing to resume.
            if let Some(job) = shell.jobs.lock().unwrap().list.iter().find(|j| j.id == id) {
                io.out_str(&format!("[{id}]+ {}\n", job.text));
            }
            Ok(0)
        }
        None => {
            io.err_str("bg: no such job\n");
            Ok(1)
        }
    }
}

fn disown_command(shell: &mut Shell, args: &[String]) -> ExecResult {
    match job_id(shell, args.first()) {
        Some(id) => {
            shell.jobs.lock().unwrap().list.retain(|j| j.id != id);
            Ok(0)
        }
        None => Ok(1),
    }
}

/// `kill [-SIG] pid…` for real processes (`taskkill` on Windows); a `%job` is a thread of
/// this shell and cannot be signalled.
fn kill_command(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut status = 0;
    for arg in args {
        if arg.starts_with('-') {
            continue;
        }
        if arg.starts_with('%') {
            io.err_str(&format!("kill: {arg}: in-shell jobs cannot be signalled\n"));
            status = 1;
            continue;
        }
        let _ = &shell;
        let outcome = if cfg!(windows) {
            std::process::Command::new("taskkill")
                .args(["/PID", arg, "/F"])
                .output()
        } else {
            std::process::Command::new("kill").arg(arg).output()
        };
        match outcome {
            Ok(out) if out.status.success() => {}
            _ => {
                io.err_str(&format!("kill: ({arg}) - No such process\n"));
                status = 1;
            }
        }
    }
    Ok(status)
}

/// `break N` / `continue N`: the number of loop levels (at least one).
fn loop_levels(args: &[String]) -> u32 {
    args.first()
        .and_then(|n| n.parse::<u32>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(1)
}

/// `trap 'cmd' SIG…`, `trap - SIG…` (reset), `trap -p` / `trap` (list). Signal names
/// normalise (`SIGINT`, `int`, `2` → `INT`; `0` → `EXIT`); `EXIT` fires at shell end.
fn trap(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    fn normalize(name: &str) -> String {
        let upper = name.to_uppercase();
        let bare = upper.strip_prefix("SIG").unwrap_or(&upper);
        match bare {
            "0" => "EXIT".to_owned(),
            "1" => "HUP".to_owned(),
            "2" => "INT".to_owned(),
            "15" => "TERM".to_owned(),
            other => other.to_owned(),
        }
    }
    let args: Vec<&String> = args.iter().filter(|a| a.as_str() != "--").collect();
    if args.is_empty() || args[0] == "-p" {
        let mut names: Vec<&String> = shell.traps.keys().collect();
        names.sort();
        for name in names {
            io.out_str(&format!(
                "trap -- '{}' {name}
",
                shell.traps[name]
            ));
        }
        return Ok(0);
    }
    if args[0] == "-l" {
        io.out_str(
            "EXIT HUP INT QUIT TERM ERR DEBUG RETURN
",
        );
        return Ok(0);
    }
    let (action, signals) = if args.len() == 1 {
        ("-".to_owned(), &args[..])
    } else {
        (args[0].clone(), &args[1..])
    };
    for signal in signals {
        let name = normalize(signal);
        if action == "-" {
            shell.traps.remove(&name);
        } else {
            shell.traps.insert(name, action.clone());
        }
    }
    Ok(0)
}

fn echo(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut newline = true;
    let mut interpret = false;
    let mut rest = args;
    while let Some(first) = rest.first() {
        match first.as_str() {
            "-n" => newline = false,
            "-e" => interpret = true,
            "-E" => interpret = false,
            _ => break,
        }
        rest = &rest[1..];
    }
    let _ = shell;
    let mut text = rest.join(" ");
    if interpret {
        text = unescape(&text);
    }
    io.out_str(&text);
    if newline {
        io.out_str("\n");
    }
    Ok(0)
}

fn printf(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let _ = shell;
    let Some(format) = args.first() else {
        return Ok(1);
    };
    let mut out = String::new();
    let mut arg_at = 1;
    let mut chars = format.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            if c == '\\' {
                // \n and friends inside the format.
                let mut probe = String::from("\\");
                if let Some(next) = chars.next() {
                    probe.push(next);
                }
                out.push_str(&unescape(&probe));
            } else {
                out.push(c);
            }
            continue;
        }
        // The conversion: flags, width, precision, then the verb.
        let mut left = false;
        let mut zero = false;
        let mut width = 0usize;
        let mut precision: Option<usize> = None;
        let mut in_precision = false;
        let mut verb: Option<char> = None;
        while verb.is_none() {
            match chars.next() {
                Some('-') if width == 0 && !in_precision => left = true,
                Some('0') if width == 0 && !in_precision => zero = true,
                Some(d) if d.is_ascii_digit() => {
                    if in_precision {
                        precision =
                            Some(precision.unwrap_or(0) * 10 + d.to_digit(10).unwrap() as usize);
                    } else {
                        width = width * 10 + d.to_digit(10).unwrap() as usize;
                    }
                }
                Some('.') => in_precision = true,
                Some('%') => {
                    out.push('%');
                    verb = Some('\0');
                }
                Some(v) => verb = Some(v),
                None => verb = Some('\0'),
            }
        }
        if verb == Some('\0') {
            continue;
        }
        let verb = verb.unwrap();
        let arg = args.get(arg_at).cloned().unwrap_or_default();
        if arg_at < args.len() {
            arg_at += 1;
        }
        let piece = match verb {
            's' => {
                let mut text: String = arg.chars().take(precision.unwrap_or(usize::MAX)).collect();
                text = pad(&text, width, left, false);
                text
            }
            'd' | 'i' | 'u' => match arg.parse::<i64>() {
                Ok(n) => pad(&n.to_string(), width, left, zero),
                Err(_) => {
                    io.err_str(&format!("printf: {arg}: expected a number\n"));
                    return Ok(1);
                }
            },
            'x' => pad(
                &radix(arg.parse::<i64>().unwrap_or(0), 16),
                width,
                left,
                zero,
            ),
            'X' => pad(
                &radix(arg.parse::<i64>().unwrap_or(0), 16).to_uppercase(),
                width,
                left,
                zero,
            ),
            'o' => pad(
                &radix(arg.parse::<i64>().unwrap_or(0), 8),
                width,
                left,
                zero,
            ),
            'c' => arg.chars().next().map(String::from).unwrap_or_default(),
            other => {
                io.err_str(&format!("printf: %{other}: unsupported\n"));
                return Ok(1);
            }
        };
        out.push_str(&piece);
    }
    io.out_str(&out);
    Ok(0)
}

fn pad(text: &str, width: usize, left: bool, zero: bool) -> String {
    let len = text.chars().count();
    if len >= width {
        return text.to_owned();
    }
    let fill = if zero { '0' } else { ' ' };
    let padding: String = fill.to_string().repeat(width - len);
    if left {
        format!("{text}{padding}")
    } else {
        format!("{padding}{text}")
    }
}

fn radix(value: i64, base: i64) -> String {
    if value == 0 {
        return "0".to_owned();
    }
    let negative = value < 0;
    let mut digits = Vec::new();
    let mut rest = value.unsigned_abs();
    while rest > 0 {
        digits.push(std::char::from_digit((rest % base as u64) as u32, base as u32).unwrap_or('0'));
        rest /= base as u64;
    }
    if negative {
        digits.push('-');
    }
    digits.into_iter().rev().collect()
}

pub fn unescape(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('a') => out.push('\x07'),
            Some('b') => out.push('\x08'),
            Some('f') => out.push('\x0c'),
            Some('v') => out.push('\x0b'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/* ---------- State builtins ---------- */

fn cd(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let target = match args.iter().find(|a| !a.starts_with('-')) {
        Some(dir) => dir.clone(),
        None => match shell
            .get_var("HOME")
            .or_else(|| shell.get_var("USERPROFILE"))
        {
            Some(home) => home,
            None => {
                io.err_str("cd: no HOME\n");
                return Ok(1);
            }
        },
    };
    let target = if target == "-" {
        match shell.get_var("OLDPWD") {
            Some(previous) => {
                io.out_str(&format!("{}\n", previous));
                previous
            }
            None => {
                io.err_str("cd: no OLDPWD\n");
                return Ok(1);
            }
        }
    } else {
        target
    };
    let mut next = shell.resolve_working_path(&target);
    // A logical path: fold `.` and `..` textually, like bash's default cd -L.
    let mut folded: Vec<String> = Vec::new();
    for component in next.iter() {
        match component.to_str() {
            Some(".") => {}
            Some("..") => {
                folded.pop();
            }
            other => folded.push(other.unwrap_or_default().to_owned()),
        }
    }
    next = folded.iter().collect();
    if !next.is_dir() {
        io.err_str(&format!("cd: {target}: no such directory\n"));
        return Ok(1);
    }
    let old = shell.cwd.display().to_string();
    shell.set_var("OLDPWD", &old);
    shell.set_var("PWD", &next.display().to_string());
    shell.cwd = next;
    Ok(0)
}

fn export(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    if args.is_empty() {
        for (name, var) in &shell.vars {
            if var.exported {
                io.out_str(&format!("declare -x {name}=\"{}\"\n", var.value));
            }
        }
        return Ok(0);
    }
    let mut status = 0;
    let mut unexport = false;
    for arg in args {
        if arg == "-n" {
            unexport = true;
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        match arg.split_once('=') {
            Some((name, value)) => {
                shell.export_var(name, Some(value));
            }
            None => {
                if unexport {
                    if let Some(var) = shell.vars.get_mut(arg) {
                        var.exported = false;
                    }
                } else if shell.vars.contains_key(arg) {
                    shell.export_var(arg, None);
                } else {
                    io.err_str(&format!("export: {arg}: not a variable\n"));
                    status = 1;
                }
            }
        }
    }
    Ok(status)
}

fn unset(shell: &mut Shell, args: &[String]) -> ExecResult {
    for arg in args {
        if arg.starts_with('-') {
            continue;
        }
        if let Some((base, index)) = super::expand::split_subscript(arg) {
            if let Some(entries) = shell.assoc.get_mut(base) {
                let key = index.trim_matches(|c| c == '"' || c == '\'');
                entries.retain(|(k, _)| k != key);
                continue;
            }
            if let (Some(items), Ok(at)) = (shell.arrays.get_mut(base), index.parse::<usize>()) {
                if at < items.len() {
                    items.remove(at);
                }
            }
            continue;
        }
        shell.vars.remove(arg);
        shell.arrays.remove(arg);
        shell.assoc.remove(arg);
        for frame in shell.locals.iter_mut() {
            frame.remove(arg);
        }
    }
    Ok(0)
}

fn set(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    if args.is_empty() {
        for (name, var) in &shell.vars {
            io.out_str(&format!("{name}={}\n", var.value));
        }
        return Ok(0);
    }
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        // `set -- a b c` / `set a b c`: replace the positional parameters.
        if arg == "--" {
            shell.args = args[index + 1..].to_vec();
            return Ok(0);
        }
        if !arg.starts_with(['-', '+']) {
            shell.args = args[index..].to_vec();
            return Ok(0);
        }
        let turn_on = !arg.starts_with('+');
        let flag = arg.trim_start_matches(['-', '+']);
        match flag {
            "e" => shell.errexit = turn_on,
            "x" => shell.xtrace = turn_on,
            "f" => shell.noglob = turn_on,
            "o" | "u" | "pipefail" | "" => {
                // Accepted, no effect (`-u` stays forgiving: an unset variable reads
                // empty rather than killing an AI-generated script mid-run).
            }
            "-" => break,
            other => {
                io.err_str(&format!("set: -{other}: unsupported\n"));
                return Ok(2);
            }
        }
        index += 1;
    }
    Ok(0)
}

fn shift(shell: &mut Shell, args: &[String]) -> ExecResult {
    let count = args
        .first()
        .and_then(|n| n.parse::<usize>().ok())
        .unwrap_or(1);
    if count > shell.args.len() {
        return Ok(1);
    }
    shell.args.drain(..count);
    Ok(0)
}

fn type_of(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut status = 0;
    for name in args {
        if shell.funcs.contains_key(name) {
            io.out_str(&format!("{name} is a function\n"));
        } else if shell.aliases.contains_key(name) {
            io.out_str(&format!("{name} is aliased to `{}`\n", shell.aliases[name]));
        } else if is_builtin(name) {
            io.out_str(&format!("{name} is a shell builtin\n"));
        } else if super::applets::is_applet(name) {
            io.out_str(&format!("{name} is a ggs-bash applet\n"));
        } else if let Some(path) = super::exec::resolve_on_path(name, &shell.path_var()) {
            io.out_str(&format!("{name} is {}\n", path.display()));
        } else {
            io.err_str(&format!("type: {name}: not found\n"));
            status = 1;
        }
    }
    Ok(status)
}

fn alias(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    if args.is_empty() {
        for (name, value) in &shell.aliases {
            io.out_str(&format!("alias {name}='{value}'\n"));
        }
        return Ok(0);
    }
    for arg in args {
        match arg.split_once('=') {
            Some((name, value)) => {
                shell.aliases.insert(name.to_owned(), value.to_owned());
            }
            None => match shell.aliases.get(arg) {
                Some(value) => io.out_str(&format!("alias {arg}='{value}'\n")),
                None => {
                    io.err_str(&format!("alias: {arg}: not found\n"));
                    return Ok(1);
                }
            },
        }
    }
    Ok(0)
}

fn unalias(shell: &mut Shell, args: &[String]) -> ExecResult {
    let mut status = 0;
    for arg in args {
        if arg == "-a" {
            shell.aliases.clear();
            continue;
        }
        if shell.aliases.remove(arg).is_none() {
            status = 1;
        }
    }
    Ok(status)
}

fn local(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let Some(frame) = shell.locals.last_mut() else {
        io.err_str("local: only inside a function\n");
        return Ok(1);
    };
    // `local -A m` / `local -a l`: containers, kept shell-wide (the flat model).
    let assoc = args.iter().any(|a| a.starts_with('-') && a.contains('A'));
    let array = args.iter().any(|a| a.starts_with('-') && a.contains('a'));
    for arg in args {
        if arg.starts_with('-') {
            continue;
        }
        if assoc || array {
            let name = arg.split('=').next().unwrap_or(arg).to_owned();
            if assoc {
                shell.assoc.entry(name).or_default();
            } else {
                shell.arrays.entry(name).or_default();
            }
            continue;
        }
        match arg.split_once('=') {
            Some((name, value)) => {
                frame.insert(name.to_owned(), value.to_owned());
            }
            None => {
                frame.entry(arg.clone()).or_default();
            }
        }
    }
    Ok(0)
}

fn read(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut into_array = false;
    let mut names: Vec<String> = Vec::new();
    let mut prompt = String::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "-r" | "-s" => {}
            "-a" => into_array = true,
            "-p" => {
                index += 1;
                if let Some(text) = args.get(index) {
                    prompt = text.clone();
                }
            }
            other => names.push(other.to_owned()),
        }
        index += 1;
    }
    if names.is_empty() {
        names.push("REPLY".to_owned());
    }
    if !prompt.is_empty() {
        io.err_str(&prompt);
    }
    // The line read drains a stdin the caller still holds — the clone shares every
    // sink (Arc/Mutex), only the Str content is consumed, once.
    let mut line_io = io.clone();
    let Some(line) = line_io.read_one_line() else {
        return Ok(1);
    };
    let ifs: Vec<char> = shell
        .get_var("IFS")
        .unwrap_or_else(|| " \t\n".to_owned())
        .chars()
        .collect();
    let fields: Vec<&str> = line
        .split(|c| ifs.contains(&c))
        .filter(|f| !f.is_empty())
        .collect();
    if into_array {
        let name = names[0].clone();
        shell.vars.remove(&name);
        shell
            .arrays
            .insert(name, fields.iter().map(|f| (*f).to_owned()).collect());
        return Ok(0);
    }
    let joiner = ifs
        .first()
        .map(|c| c.to_string())
        .unwrap_or_else(|| " ".to_owned());
    for (slot, name) in names.iter().enumerate() {
        let value = if slot + 1 == names.len() && fields.len() > names.len() {
            // The last name takes everything that remains, re-joined on the IFS.
            fields[slot..].join(&joiner)
        } else {
            fields
                .get(slot)
                .map(|f| (*f).to_owned())
                .unwrap_or_default()
        };
        shell.set_var(name, &value);
    }
    Ok(0)
}

fn source(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let Some(path) = args.first() else {
        io.err_str("source: a file is required\n");
        return Ok(2);
    };
    let resolved = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        shell.cwd.join(path)
    };
    let text = match std::fs::read_to_string(&resolved) {
        Ok(text) => text,
        Err(error) => {
            io.err_str(&format!("source: {path}: {error}\n"));
            return Ok(1);
        }
    };
    shell.depth += 1;
    if shell.depth > 64 {
        shell.depth -= 1;
        return Err(ExecError::Io("source nested too deeply".into()));
    }
    let result = match parse::parse_script(&text) {
        Ok(script) => shell.exec_block(&script, io, false),
        Err(error) => {
            io.err_str(&format!("source {path}: {error:?}\n"));
            Ok(2)
        }
    };
    shell.depth -= 1;
    match result {
        Err(ExecError::Return(code)) => Ok(code),
        other => other,
    }
}

fn eval(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let line = args.join(" ");
    if line.trim().is_empty() {
        return Ok(0);
    }
    match parse::parse_script(&line) {
        Ok(script) => shell.exec_block(&script, io, false),
        Err(error) => {
            io.err_str(&format!("eval: {error:?}\n"));
            Ok(2)
        }
    }
}

fn command(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    if args.first().map(String::as_str) == Some("-v") {
        let mut status = 0;
        for name in &args[1..] {
            // A membership answer, never an execution — probing by running the builtin
            // had `command -v cd` change the directory and `command -v set` dump the
            // whole environment.
            if is_builtin(name) || super::applets::is_applet(name) {
                io.out_str(&format!("{name}\n"));
            } else if let Some(path) = super::exec::resolve_on_path(name, &shell.path_var()) {
                io.out_str(&format!("{}\n", path.display()));
            } else {
                status = 1;
            }
        }
        return Ok(status);
    }
    if args.is_empty() {
        return Ok(0);
    }
    // `command cmd` skips functions and aliases, not builtins.
    let name = args[0].clone();
    if let Some(result) = run_builtin(shell, io, &name, &args[1..]) {
        return result;
    }
    if let Some(result) = super::applets::run_applet(shell, io, &name, &args[1..]) {
        return result;
    }
    shell.spawn_external(&name, &args[1..], &[], io)
}

/* ---------- test / [ ] / [[ ]] ---------- */

fn test_command(_shell: &mut Shell, io: &Io, words: &[String], patterns: bool) -> ExecResult {
    match eval_condition(words, patterns) {
        Ok(true) => Ok(0),
        Ok(false) => Ok(1),
        Err(text) => {
            io.err_str(&format!("test: {text}\n"));
            Ok(2)
        }
    }
}

/// Evaluate a `test` / `[[ ]]` expression over already-expanded words. `patterns`
/// selects `[[ ]]` semantics: `==`/`!=` match the right side as a glob, `&&`/`||` join.
pub fn eval_condition(words: &[String], patterns: bool) -> Result<bool, String> {
    let mut parser = CondParser {
        words,
        at: 0,
        patterns,
    };
    let value = parser.parse_or()?;
    if parser.at != words.len() {
        return Err(format!("unexpected `{}`", words[parser.at]));
    }
    Ok(value)
}

struct CondParser<'a> {
    words: &'a [String],
    at: usize,
    patterns: bool,
}

impl<'a> CondParser<'a> {
    fn peek(&self) -> Option<&String> {
        self.words.get(self.at)
    }
    fn is(&self, text: &str) -> bool {
        self.peek().map(String::as_str) == Some(text)
    }

    fn parse_or(&mut self) -> Result<bool, String> {
        let mut left = self.parse_and()?;
        while self.is("||") || (!self.patterns && self.is("-o")) {
            self.at += 1;
            let right = self.parse_and()?;
            left = left || right;
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<bool, String> {
        let mut left = self.parse_unary_top()?;
        while self.is("&&") || (!self.patterns && self.is("-a")) {
            self.at += 1;
            let right = self.parse_unary_top()?;
            left = left && right;
        }
        Ok(left)
    }

    fn parse_unary_top(&mut self) -> Result<bool, String> {
        if self.is("!") {
            self.at += 1;
            return Ok(!self.parse_unary_top()?);
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<bool, String> {
        if self.is("(") {
            self.at += 1;
            let value = self.parse_or()?;
            if !self.is(")") {
                return Err("expected `)`".into());
            }
            self.at += 1;
            return Ok(value);
        }
        // A unary operator with its operand.
        if let Some(word) = self.peek() {
            if word.starts_with('-') && word.len() == 2 {
                let op = word.clone();
                if matches!(
                    op.as_str(),
                    "-e" | "-f" | "-d" | "-r" | "-w" | "-x" | "-s" | "-z" | "-n"
                ) {
                    self.at += 1;
                    let operand = self.words.get(self.at).cloned().unwrap_or_default();
                    self.at += 1;
                    return unary(&op, &operand);
                }
            }
        }
        // A binary: `a op b`.
        let left = self.words.get(self.at).cloned().ok_or("missing operand")?;
        self.at += 1;
        let op = match self.peek() {
            Some(op)
                if matches!(
                    op.as_str(),
                    "=" | "==" | "!=" | "<" | ">" | "-eq" | "-ne" | "-lt" | "-le" | "-gt" | "-ge"
                ) =>
            {
                let op = op.clone();
                self.at += 1;
                op
            }
            _ => {
                // A single bare word tests for non-emptiness.
                return Ok(!left.is_empty());
            }
        };
        let right = self
            .words
            .get(self.at)
            .cloned()
            .ok_or_else(|| format!("missing operand after {op}"))?;
        self.at += 1;
        binary(&left, &op, &right, self.patterns)
    }
}

fn unary(op: &str, operand: &str) -> Result<bool, String> {
    match op {
        "-z" => Ok(operand.is_empty()),
        "-n" => Ok(!operand.is_empty()),
        _ => {
            let path = Path::new(operand);
            let metadata = path.symlink_metadata();
            match op {
                "-e" => Ok(metadata.is_ok()),
                "-f" => Ok(metadata.map(|m| m.is_file()).unwrap_or(false)),
                "-d" => Ok(metadata.map(|m| m.is_dir()).unwrap_or(false)),
                "-s" => Ok(metadata.map(|m| m.len() > 0).unwrap_or(false)),
                "-r" => Ok(metadata.is_ok()),
                "-w" => Ok(metadata
                    .map(|m| !m.permissions().readonly())
                    .unwrap_or(false)),
                "-x" => Ok(metadata.is_ok()),
                other => Err(format!("unsupported operator {other}")),
            }
        }
    }
}

fn binary(left: &str, op: &str, right: &str, patterns: bool) -> Result<bool, String> {
    match op {
        "=" | "==" => {
            if patterns && (right.contains('*') || right.contains('?') || right.contains('[')) {
                Ok(super::glob::glob_match(right, left))
            } else {
                Ok(left == right)
            }
        }
        "!=" => {
            if patterns && (right.contains('*') || right.contains('?') || right.contains('[')) {
                Ok(!super::glob::glob_match(right, left))
            } else {
                Ok(left != right)
            }
        }
        "<" => Ok(left < right),
        ">" => Ok(left > right),
        "-eq" | "-ne" | "-lt" | "-le" | "-gt" | "-ge" => {
            let a: i64 = left
                .parse()
                .map_err(|_| format!("{left}: integer expected"))?;
            let b: i64 = right
                .parse()
                .map_err(|_| format!("{right}: integer expected"))?;
            Ok(match op {
                "-eq" => a == b,
                "-ne" => a != b,
                "-lt" => a < b,
                "-le" => a <= b,
                "-gt" => a > b,
                _ => a >= b,
            })
        }
        other => Err(format!("unsupported operator {other}")),
    }
}
