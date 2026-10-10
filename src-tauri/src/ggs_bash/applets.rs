//! The applets — the POSIX line tools the shell carries built in, busybox-style. On a
//! clean Windows machine `grep`/`sed`/`find` do not exist (or exist as the wrong tools —
//! `find.exe` prompts for search strings), so the shell ships its own: the curated
//! applet list wins over `PATH` (predictable POSIX behaviour for scripts and AI-driven
//! commands), and anything not on the list goes to the filesystem. Each applet reads
//! files or the pipeline's stdin and writes through the [`Io`] it was given.

use std::path::{Path, PathBuf};

use super::builtins::unescape;
use super::exec::{anchor_program, resolve_on_path, spawn_with_io, ExecResult, Io, Shell};
use super::glob;
use super::localtime::{local_now, unix_to_local, Civil};
use super::regexlite::Regex;

pub const APPLET_NAMES: &[&str] = &[
    "ls",
    "cat",
    "grep",
    "find",
    "head",
    "tail",
    "wc",
    "mkdir",
    "rmdir",
    "rm",
    "cp",
    "mv",
    "touch",
    "sort",
    "uniq",
    "cut",
    "tr",
    "sed",
    "env",
    "which",
    "basename",
    "dirname",
    "realpath",
    "readlink",
    "date",
    "sleep",
    "seq",
    "clear",
    "awk",
    "diff",
    "tee",
    "xargs",
    "uname",
    "whoami",
    "hostname",
    "cygpath",
    "md5sum",
    "sha1sum",
    "sha256sum",
    "base64",
    "du",
    "ln",
    "chmod",
    "timeout",
    "tar",
    "unzip",
    "gzip",
    "gunzip",
    "less",
    "more",
];

pub fn is_applet(name: &str) -> bool {
    APPLET_NAMES.contains(&name)
}

pub fn run_applet(shell: &mut Shell, io: &Io, name: &str, args: &[String]) -> Option<ExecResult> {
    let result = match name {
        "ls" => ls(shell, io, args),
        "cat" => cat(shell, io, args),
        "less" | "more" => pager(shell, io, args),
        "grep" => grep(shell, io, args),
        "find" => find(shell, io, args),
        "head" => head(shell, io, args),
        "tail" => tail(shell, io, args),
        "wc" => wc(shell, io, args),
        "mkdir" => mkdir(shell, io, args),
        "rmdir" => rmdir(shell, io, args),
        "rm" => rm(shell, io, args),
        "cp" => cp(shell, io, args),
        "mv" => mv(shell, io, args),
        "touch" => touch(shell, io, args),
        "sort" => sort(shell, io, args),
        "uniq" => uniq(shell, io, args),
        "cut" => cut(shell, io, args),
        "tr" => tr(shell, io, args),
        "sed" => sed(shell, io, args),
        "env" => env(shell, io, args),
        "which" => which(shell, io, args),
        "basename" => basename(shell, io, args),
        "dirname" => dirname(shell, io, args),
        "realpath" => realpath(shell, io, args),
        "date" => date(shell, io, args),
        "sleep" => sleep(shell, io, args),
        "seq" => seq(shell, io, args),
        "clear" => {
            io.out_str("\x1b[2J\x1b[H");
            Ok(0)
        }
        "awk" => super::awk::run_awk(shell, io, args),
        "diff" => diff(shell, io, args),
        "tee" => tee(shell, io, args),
        "xargs" => xargs(shell, io, args),
        "uname" => uname(io, args),
        "whoami" => {
            io.out_str(&format!(
                "{}\n",
                shell.get_var("USERNAME").unwrap_or_default().to_lowercase()
            ));
            Ok(0)
        }
        "hostname" => {
            io.out_str(&format!(
                "{}\n",
                shell
                    .get_var("COMPUTERNAME")
                    .unwrap_or_default()
                    .to_lowercase()
            ));
            Ok(0)
        }
        "cygpath" => cygpath(shell, io, args),
        "readlink" => readlink(shell, io, args),
        "md5sum" | "sha1sum" | "sha256sum" => checksum(shell, io, name, args),
        "base64" => base64_applet(io, args),
        "du" => du(shell, io, args),
        "ln" => ln(shell, io, args),
        "chmod" => chmod(shell, io, args),
        "timeout" => timeout(shell, io, args),
        "tar" => super::archive::run_tar(shell, io, args),
        "unzip" => super::archive::run_unzip(shell, io, args),
        "gzip" | "gunzip" => super::archive::run_gzip(shell, io, name, args),
        _ => return None,
    };
    Some(result)
}

/* ---------- Shared parsing helpers ---------- */

/// Split args into flag letters (`-abc` → "abc", `--long` ignored as a no-op) and the
/// positional rest. `-` alone and anything after `--` stays positional.
fn parse_flags(args: &[String]) -> (String, Vec<String>) {
    let mut flags = String::new();
    let mut rest = Vec::new();
    let mut only_positional = false;
    for arg in args {
        if only_positional {
            rest.push(arg.clone());
            continue;
        }
        if arg == "--" {
            only_positional = true;
            continue;
        }
        if let Some(body) = arg.strip_prefix('-') {
            if !body.is_empty() && body.chars().all(|c| c.is_ascii_alphabetic()) {
                flags.push_str(body);
                continue;
            }
        }
        rest.push(arg.clone());
    }
    (flags, rest)
}

/// Resolve paths relative to the shell's cwd; no paths means stdin (the callers test
/// `paths.is_empty()`).
fn resolve_paths(shell: &Shell, paths: &[String]) -> Vec<PathBuf> {
    paths
        .iter()
        .map(|p| {
            if Path::new(p).is_absolute() {
                PathBuf::from(p)
            } else {
                shell.cwd.join(p)
            }
        })
        .collect()
}

fn read_input(
    shell: &mut Shell,
    io: &mut Io,
    paths: &[String],
) -> Result<Vec<(String, String)>, String> {
    if paths.is_empty() {
        return Ok(vec![(String::new(), io.read_all_stdin())]);
    }
    let mut out = Vec::new();
    for path in resolve_paths(shell, paths) {
        let text =
            std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        out.push((path.display().to_string(), text));
    }
    Ok(out)
}

fn lines_of(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    // A trailing newline makes the last split an empty artifact.
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

/* ---------- ls ---------- */

fn ls(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (flags, paths) = parse_flags(args);
    let all = flags.contains('a');
    let almost_all = flags.contains('A');
    let long = flags.contains('l');
    let by_time = flags.contains('t');
    let reverse = flags.contains('r');
    let targets: Vec<String> = if paths.is_empty() {
        vec![".".to_owned()]
    } else {
        paths
    };
    let multiple = targets.len() > 1;
    let mut status = 0;
    for (index, target) in targets.iter().enumerate() {
        if multiple && index > 0 {
            io.out_str("\n");
        }
        let path = resolve_paths(shell, std::slice::from_ref(target)).remove(0);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                io.err_str(&format!("ls: {target}: {error}\n"));
                status = 2;
                continue;
            }
        };
        if !metadata.is_dir() {
            print_ls_entry(io, &path, &metadata, long);
            continue;
        }
        if multiple {
            io.out_str(&format!("{}:\n", path.display()));
        }
        let mut names: Vec<String> = match std::fs::read_dir(&path) {
            Ok(entries) => entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| all || almost_all || !name.starts_with('.'))
                .collect(),
            Err(error) => {
                io.err_str(&format!("ls: {target}: {error}\n"));
                status = 2;
                continue;
            }
        };
        if all {
            names.push("..".to_owned());
            names.push(".".to_owned());
        }
        if by_time {
            // Newest first (mtime, then name for the stable tie).
            names.sort_by(|a, b| {
                let mtime = |name: &String| {
                    std::fs::symlink_metadata(path.join(name))
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0)
                };
                mtime(b)
                    .cmp(&mtime(a))
                    .then_with(|| a.to_lowercase().cmp(&b.to_lowercase()))
            });
        } else {
            names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then(a.cmp(b)));
        }
        if reverse {
            names.reverse();
        }
        for name in names {
            let entry = path.join(&name);
            if let Ok(metadata) = std::fs::symlink_metadata(&entry) {
                print_ls_entry(io, &entry, &metadata, long);
            }
        }
    }
    Ok(status)
}

fn print_ls_entry(io: &Io, path: &Path, metadata: &std::fs::Metadata, long: bool) {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    // Git Bash colorizes on a terminal: bold blue directories, bold green executables.
    let colored = matches!(io.stdout, super::exec::Sink::Inherit);
    let executable = !metadata.is_dir()
        && name
            .rsplit_once('.')
            .map(|(_, extension)| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "exe" | "cmd" | "bat" | "com" | "msi"
                )
            })
            .unwrap_or(false);
    let shown = if colored && metadata.is_dir() {
        format!("\x1b[01;34m{name}\x1b[0m")
    } else if colored && executable {
        format!("\x1b[01;32m{name}\x1b[0m")
    } else {
        name.clone()
    };
    if !long {
        io.out_str(&format!("{shown}\n"));
        return;
    }
    let mode = if metadata.is_dir() {
        "drwxr-xr-x"
    } else if metadata.permissions().readonly() {
        "-r--r--r--"
    } else {
        "-rw-r--r--"
    };
    let stamp = unix_to_local(
        metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
    );
    let size = metadata.len();
    io.out_str(&format!(
        "{mode} {size:>10} {} {shown}\n",
        format_month_day_time(&stamp)
    ));
}

fn format_month_day_time(civil: &Civil) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!(
        "{} {:>2} {:02}:{:02}:{:02}",
        MONTHS[(civil.month as usize - 1).min(11)],
        civil.day,
        civil.hour,
        civil.minute,
        civil.second
    )
}

/* ---------- cat ---------- */

fn cat(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (flags, paths) = parse_flags(args);
    let number = flags.contains('n');
    let mut io_mut = io.clone();
    let inputs = match read_input(shell, &mut io_mut, &paths) {
        Ok(inputs) => inputs,
        Err(error) => {
            io.err_str(&format!("cat: {error}\n"));
            return Ok(1);
        }
    };
    for (_, text) in inputs {
        if !number {
            io.out_str(&text);
            continue;
        }
        for (index, line) in lines_of(&text).iter().enumerate() {
            io.out_str(&format!("{:>6}  {line}\n", index + 1));
        }
    }
    Ok(0)
}

/* ---------- less / more ---------- */

/// The pager, minus the paging: the integrated terminal has its own scrollback and a
/// tool's captured output has no screen, so `less file` / `cmd | less` print the whole
/// input. `-N` numbers the lines; the display flags (`-R -S -F -X -i -M -r`), `+cmd`
/// and `-n<k>` arguments are accepted and ignored so muscle-memory invocations work.
fn pager(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut number = false;
    let mut paths: Vec<String> = Vec::new();
    let mut only_paths = false;
    for arg in args {
        if only_paths || arg == "-" || !(arg.starts_with('-') || arg.starts_with('+')) {
            paths.push(arg.clone());
        } else if arg == "--" {
            only_paths = true;
        } else if arg == "--line-numbers"
            || (!arg.starts_with("--")
                && !arg.starts_with('+')
                && arg[1..].chars().all(|c| c.is_ascii_alphabetic())
                && arg.contains('N'))
        {
            number = true;
        }
    }
    let mut forwarded: Vec<String> = Vec::new();
    if number {
        forwarded.push("-n".to_owned());
    }
    forwarded.extend(paths);
    cat(shell, io, &forwarded)
}

/* ---------- grep ---------- */

fn grep(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut pattern: Option<String> = None;
    let mut files: Vec<String> = Vec::new();
    let mut flags = String::new();
    let mut recursive = false;
    // -A/-B/-C context windows, and the -r walk's filename filters.
    let mut after = 0usize;
    let mut before = 0usize;
    let mut include: Option<String> = None;
    let mut exclude: Option<String> = None;
    let mut index = 0;
    let mut only_args = false;
    while index < args.len() {
        let arg = &args[index];
        if only_args || !arg.starts_with('-') || arg == "-" {
            if pattern.is_none() && !only_args {
                pattern = Some(arg.clone());
            } else {
                files.push(arg.clone());
            }
            index += 1;
            continue;
        }
        if arg == "--" {
            only_args = true;
            index += 1;
            continue;
        }
        // Long options first: --include=... / --exclude=... / --include ....
        if let Some(value) = arg.strip_prefix("--include=") {
            include = Some(value.to_owned());
            index += 1;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--exclude=") {
            exclude = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--include" || arg == "--exclude" {
            let value = args.get(index + 1).cloned();
            if arg == "--include" {
                include = value;
            } else {
                exclude = value;
            }
            index += 2;
            continue;
        }
        let body = arg.trim_start_matches('-');
        match body {
            "e" => {
                index += 1;
                if let Some(value) = args.get(index) {
                    pattern = Some(value.clone());
                }
            }
            // The context windows: `-A 3`, `-A3`, `-C2` — letter optionally glued to
            // its count.
            other
                if matches!(
                    other.as_bytes().first(),
                    Some(b'A') | Some(b'B') | Some(b'C')
                ) && (other.len() == 1 || other[1..].chars().all(|c| c.is_ascii_digit())) =>
            {
                let value = if other.len() > 1 {
                    other[1..].to_owned()
                } else {
                    index += 1;
                    args.get(index).cloned().unwrap_or_default()
                };
                let parsed: usize = value.parse().unwrap_or(0);
                match other.as_bytes()[0] {
                    b'A' => after = parsed,
                    b'B' => before = parsed,
                    _ => {
                        after = parsed;
                        before = parsed;
                    }
                }
            }
            _ => {
                for c in body.chars() {
                    match c {
                        'i' | 'v' | 'n' | 'c' | 'l' | 'q' | 'E' | 'F' | 'o' | 'w' | 'H' | 'h' => {
                            flags.push(c)
                        }
                        'r' | 'R' => recursive = true,
                        other => io.err_str(&format!("grep: -{other}: unsupported\n")),
                    }
                }
            }
        }
        index += 1;
    }
    let Some(pattern) = pattern else {
        io.err_str("grep: a pattern is required\n");
        return Ok(2);
    };
    let icase = flags.contains('i');
    let matcher = if flags.contains('F') {
        None
    } else {
        match Regex::compile(&pattern, flags.contains('E'), icase) {
            Ok(regex) => Some(regex),
            Err(error) => {
                io.err_str(&format!("grep: {error}\n"));
                return Ok(2);
            }
        }
    };
    // Expand directories into their files when -r.
    let mut sources: Vec<String> = Vec::new();
    for file in &files {
        let path = resolve_paths(shell, std::slice::from_ref(file)).remove(0);
        if path.is_dir() {
            if recursive {
                collect_files_filtered(&path, &mut sources, &include, &exclude);
            } else {
                io.err_str(&format!("grep: {file}: is a directory\n"));
                return Ok(2);
            }
        } else {
            sources.push(file.clone());
        }
    }
    // `-H` forces the file prefix on, `-h` off; otherwise several files or -r label.
    let labelled = if flags.contains('H') {
        true
    } else if flags.contains('h') {
        false
    } else {
        files.len() > 1 || recursive
    };
    let mut inputs: Vec<(String, String)> = Vec::new();
    if sources.is_empty() && files.is_empty() {
        let mut io_mut = io.clone();
        inputs.push((String::new(), io_mut.read_all_stdin()));
    } else {
        for source in &sources {
            let path = resolve_paths(shell, std::slice::from_ref(source)).remove(0);
            match std::fs::read_to_string(&path) {
                Ok(text) => inputs.push((source.clone(), text)),
                Err(error) => {
                    io.err_str(&format!("grep: {source}: {error}\n"));
                }
            }
        }
    }
    let mut matches = 0usize;
    let quiet = flags.contains('q');
    let mut status = 1;
    for (name, text) in &inputs {
        let mut count = 0usize;
        let printed_file = false;
        let all_lines = lines_of(text);
        // Every match on a line as a byte span — the regex's, or the fixed string's
        // (case-folded under -i) — keeping under `-w` only the spans flanked by
        // non-word characters (or the edges). `-w` and `-o` both read these.
        let spans_of = |line: &str| -> Vec<(usize, usize)> {
            let spans: Vec<(usize, usize)> = match &matcher {
                Some(regex) => regex
                    .find_iter(line)
                    .iter()
                    .map(|found| (found.start, found.end))
                    .collect(),
                None => fixed_spans(line, &pattern, icase),
            };
            if flags.contains('w') {
                spans
                    .into_iter()
                    .filter(|(start, end)| word_bounded(line, *start, *end))
                    .collect()
            } else {
                spans
            }
        };
        let is_hit = |line: &str| -> bool {
            let hit = if flags.contains('w') {
                !spans_of(line).is_empty()
            } else {
                match &matcher {
                    Some(regex) => regex.is_match(line),
                    None => contains_fold(line, &pattern, icase),
                }
            };
            hit != flags.contains('v')
        };
        // The -A/-B/-C context windows: every hit pulls its surrounding lines into
        // one print set; overlapping windows merge, and a gap between printed runs
        // separates groups with `--` (GNU's exact shape).
        let hits: Vec<bool> = all_lines.iter().map(|line| is_hit(line)).collect();
        let mut print = vec![false; all_lines.len()];
        for (at, hit) in hits.iter().enumerate() {
            if !*hit {
                continue;
            }
            matches += 1;
            count += 1;
            status = 0;
            let window_start = at.saturating_sub(before);
            let window_end = (at + after).min(all_lines.len().saturating_sub(1));
            for slot in print.iter_mut().take(window_end + 1).skip(window_start) {
                *slot = true;
            }
        }
        let prefix = if labelled {
            format!("{name}:")
        } else {
            String::new()
        };
        let mut previous_printed: Option<usize> = None;
        for (at, line) in all_lines.iter().enumerate() {
            if !print[at] {
                continue;
            }
            if quiet {
                continue;
            }
            if flags.contains('l') {
                if !printed_file {
                    io.out_str(&format!("{name}\n"));
                }
                break;
            }
            if flags.contains('c') {
                continue;
            }
            let line_number = if flags.contains('n') {
                format!("{}:", at + 1)
            } else {
                String::new()
            };
            // A jump in the printed run is a group boundary.
            if let Some(previous) = previous_printed {
                if at > previous + 1 && (before > 0 || after > 0) {
                    io.out_str(&format!("{prefix}--\n"));
                }
            }
            previous_printed = Some(at);
            if flags.contains('o') {
                // Only the matched parts, one per line.
                let parts: Vec<String> = spans_of(line)
                    .into_iter()
                    .filter(|(start, end)| start != end)
                    .map(|(start, end)| line[start..end].to_owned())
                    .collect();
                for part in parts {
                    io.out_str(&format!("{prefix}{line_number}{part}\n"));
                }
                continue;
            }
            io.out_str(&format!("{prefix}{line_number}{line}\n"));
        }
        if flags.contains('c') && !quiet {
            io.out_str(&format!("{prefix}{count}\n"));
        }
        if quiet && matches > 0 {
            return Ok(0);
        }
    }
    let _ = matches;
    Ok(status)
}

fn contains_fold(haystack: &str, needle: &str, icase: bool) -> bool {
    if !icase {
        return haystack.contains(needle);
    }
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// Every non-overlapping occurrence of the fixed string `needle` in `line`, as byte
/// spans; `icase` folds case character by character, so the spans stay on the line's
/// own character boundaries whatever the folded forms' lengths.
fn fixed_spans(line: &str, needle: &str, icase: bool) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    if needle.is_empty() {
        return spans;
    }
    let mut at = 0usize;
    while at < line.len() {
        match fixed_match_at(&line[at..], needle, icase) {
            Some(len) => {
                spans.push((at, at + len));
                at += len;
            }
            None => at += line[at..].chars().next().map_or(1, char::len_utf8),
        }
    }
    spans
}

/// The byte length of `needle` matched at the start of `text`, if it matches there.
fn fixed_match_at(text: &str, needle: &str, icase: bool) -> Option<usize> {
    if !icase {
        return text.starts_with(needle).then_some(needle.len());
    }
    let mut taken = 0usize;
    let mut hay = text.chars();
    for want in needle.chars() {
        let got = hay.next()?;
        if !got.to_lowercase().eq(want.to_lowercase()) {
            return None;
        }
        taken += got.len_utf8();
    }
    Some(taken)
}

/// Whether the `[start, end)` byte span of `text` is flanked by non-word characters
/// (or the string's edges) — grep -w's test. Word means `[A-Za-z0-9_]`; multibyte
/// bytes are never ASCII-word, so the byte check is boundary-correct.
fn word_bounded(text: &str, start: usize, end: usize) -> bool {
    let is_word = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let before_ok = start == 0 || !is_word(text.as_bytes()[start - 1]);
    let after_ok = end >= text.len() || !is_word(text.as_bytes()[end]);
    before_ok && after_ok
}

/// The -r walk, honouring `--include`/`--exclude` filename globs.
fn collect_files_filtered(
    dir: &Path,
    out: &mut Vec<String>,
    include: &Option<String>,
    exclude: &Option<String>,
) {
    let mut entries: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(entries) => entries.flatten().map(|e| e.path()).collect(),
        Err(_) => return,
    };
    entries.sort();
    for entry in entries {
        if entry.is_dir() {
            collect_files_filtered(&entry, out, include, exclude);
            continue;
        }
        let file_name = entry
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if let Some(pattern) = include {
            if !glob::glob_match(pattern, &file_name) {
                continue;
            }
        }
        if let Some(pattern) = exclude {
            if glob::glob_match(pattern, &file_name) {
                continue;
            }
        }
        out.push(entry.display().to_string());
    }
}

/* ---------- find ---------- */

fn find(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    // Paths first, then the expression. `find . -name x` and `find . \( -name a -o -name b \)`
    // both parse; the expression is a tiny recursive-descent over the tests.
    let mut index = 0;
    let mut roots: Vec<String> = Vec::new();
    while index < args.len() {
        let arg = &args[index];
        if arg == "--" {
            index += 1;
            continue;
        }
        if arg.starts_with('-') || arg == "(" || arg == "!" {
            break;
        }
        roots.push(arg.clone());
        index += 1;
    }
    if roots.is_empty() {
        roots.push(".".to_owned());
    }
    let expression = &args[index..];
    let mut parser = FindParser {
        tokens: expression,
        at: 0,
        min_depth: 0,
    };
    let mut max_depth = None;
    let mut actions: Vec<FindAction> = Vec::new();
    let mut has_explicit_action = false;
    let tree = match parser.parse_or(&mut max_depth, &mut actions, &mut has_explicit_action) {
        Ok(tree) => tree,
        Err(error) => {
            io.err_str(&format!("find: {error}\n"));
            return Ok(1);
        }
    };
    if parser.at != expression.len() {
        io.err_str(&format!("find: unexpected `{}`\n", expression[parser.at]));
        return Ok(1);
    }
    if !has_explicit_action {
        actions.push(FindAction::Print);
    }
    let mut status = 0;
    for root in &roots {
        let resolved = shell.resolve_working_path(root);
        // GNU find echoes the root as typed (`find .` answers `./x`, not an absolute
        // path); the walk itself resolves it.
        let display_root = root.trim_end_matches('/').to_owned();
        if !resolved.exists() {
            io.err_str(&format!("find: {root}: no such file or directory\n"));
            status = 1;
            continue;
        }
        let mut walker = Walker {
            depth: 0,
            max_depth,
            min_depth: parser.min_depth,
        };
        let mut found: Vec<(String, bool)> = Vec::new();
        // The root is visited first — `find _t` answers `_t` before its contents, and
        // `find . -maxdepth 0` answers `.` and nothing else; `-mindepth 1` leaves it out.
        if parser.min_depth > 0 {
            // The root is depth 0: below the floor, walked but not a candidate.
        } else if let Ok(metadata) = std::fs::symlink_metadata(&resolved) {
            let is_dir = metadata.is_dir();
            let is_file = metadata.is_file();
            let mtime_secs = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let name = display_root
                .rsplit('/')
                .next()
                .unwrap_or(&display_root)
                .to_owned();
            if test_matches(&tree, &name, &display_root, is_dir, is_file, mtime_secs) {
                found.push((display_root.clone(), is_dir));
            }
        }
        walker.visit(&resolved, &display_root, &tree, &mut found);
        // `-exec … {} +` batches every match into one invocation — run once, not once
        // per match (GNU aggregates; no matches means no run at all).
        for action in &actions {
            if let FindAction::Exec {
                command,
                terminator: '+',
            } = action
            {
                if found.is_empty() {
                    continue;
                }
                let mut argv: Vec<String> = Vec::new();
                for piece in command {
                    if piece == "{}" {
                        argv.extend(found.iter().map(|(path, _)| path.clone()));
                    } else {
                        argv.push(piece.clone());
                    }
                }
                if let Err(error) = shell.run_argv(&argv, io) {
                    io.err_str(&format!("find: -exec: {error:?}\n"));
                    status = 1;
                }
            }
        }
        // GNU walks pre-order (a directory before its contents); only -delete needs the
        // deepest-first pass (a directory empties before it goes).
        let deepest_first = actions.iter().any(|a| matches!(a, FindAction::Delete));
        let order: Vec<&(String, bool)> = if deepest_first {
            found.iter().rev().collect()
        } else {
            found.iter().collect()
        };
        for (display, is_dir) in order {
            for action in &actions {
                match action {
                    // GNU never removes `.` itself (`find . -delete` empties the
                    // directory and stays quiet about its own root).
                    FindAction::Delete if display == "." => {}
                    FindAction::Delete => {
                        let native = shell.resolve_working_path(display);
                        let result = if *is_dir {
                            std::fs::remove_dir(&native)
                        } else {
                            std::fs::remove_file(&native)
                        };
                        if let Err(error) = result {
                            io.err_str(&format!("find: {display}: {error}\n"));
                            status = 1;
                        }
                    }
                    FindAction::Exec {
                        command,
                        terminator: ';',
                    } => {
                        let mut argv: Vec<String> = Vec::new();
                        for piece in command {
                            if piece == "{}" {
                                argv.push(display.clone());
                            } else {
                                argv.push(piece.clone());
                            }
                        }
                        if let Err(error) = shell.run_argv(&argv, io) {
                            io.err_str(&format!("find: -exec: {error:?}\n"));
                            status = 1;
                        }
                    }
                    // `+` already ran once over the whole batch above.
                    FindAction::Exec { .. } => {}
                    FindAction::Print => io.out_str(&format!("{display}\n")),
                }
            }
        }
    }
    Ok(status)
}

/* ---------- find's expression language ---------- */

#[derive(Debug, Clone)]
enum FindTest {
    Always,
    Name(String),
    Path(String, bool),
    Type(char),
    MTime(i64, FindAge),
    Not(Box<FindTest>),
    Any(Vec<FindTest>),
    All(Vec<FindTest>),
    MaxDepth,
}

/// `-mtime`'s three comparisons: `+n` older than n whole days, `-n` newer, `n` exact.
#[derive(Debug, Clone, Copy, PartialEq)]
enum FindAge {
    Exact,
    Older,
    Newer,
}

#[derive(Debug, Clone)]
enum FindAction {
    Print,
    Delete,
    Exec {
        command: Vec<String>,
        terminator: char,
    },
}

struct FindParser<'a> {
    tokens: &'a [String],
    at: usize,
    /// `-mindepth N`: entries shallower than N (the root is depth 0) are walked but
    /// never tested — `find dir -mindepth 1 -delete` empties `dir` and keeps it.
    min_depth: usize,
}

impl<'a> FindParser<'a> {
    fn peek(&self) -> Option<&String> {
        self.tokens.get(self.at)
    }
    fn eat(&mut self, text: &str) -> bool {
        if self.peek().map(String::as_str) == Some(text) {
            self.at += 1;
            true
        } else {
            false
        }
    }
    fn value(&mut self, what: &str) -> Result<String, String> {
        let next = self
            .tokens
            .get(self.at)
            .cloned()
            .ok_or(format!("{what} needs a value"))?;
        self.at += 1;
        Ok(next)
    }

    fn parse_or(
        &mut self,
        max_depth: &mut Option<usize>,
        actions: &mut Vec<FindAction>,
        saw_action: &mut bool,
    ) -> Result<FindTest, String> {
        let mut branches = vec![self.parse_all(max_depth, actions, saw_action)?];
        while self.eat("-o") || self.eat("-or") {
            branches.push(self.parse_all(max_depth, actions, saw_action)?);
        }
        Ok(if branches.len() == 1 {
            branches.pop().unwrap()
        } else {
            FindTest::Any(branches)
        })
    }

    fn parse_all(
        &mut self,
        max_depth: &mut Option<usize>,
        actions: &mut Vec<FindAction>,
        saw_action: &mut bool,
    ) -> Result<FindTest, String> {
        let mut branches = vec![self.parse_unary(max_depth, actions, saw_action)?];
        loop {
            match self.peek().map(String::as_str) {
                None | Some(")") | Some("-o") | Some("-or") => break,
                _ => branches.push(self.parse_unary(max_depth, actions, saw_action)?),
            }
        }
        Ok(if branches.len() == 1 {
            branches.pop().unwrap()
        } else {
            FindTest::All(branches)
        })
    }

    fn parse_unary(
        &mut self,
        max_depth: &mut Option<usize>,
        actions: &mut Vec<FindAction>,
        saw_action: &mut bool,
    ) -> Result<FindTest, String> {
        if self.eat("-not") {
            return Ok(FindTest::Not(Box::new(
                self.parse_unary(max_depth, actions, saw_action)?,
            )));
        }
        if self.eat("!") {
            return Ok(FindTest::Not(Box::new(
                self.parse_unary(max_depth, actions, saw_action)?,
            )));
        }
        if self.eat("(") {
            let inner = self.parse_or(max_depth, actions, saw_action)?;
            if !self.eat(")") {
                return Err("expected `)`".into());
            }
            return Ok(inner);
        }
        match self.peek().cloned().as_deref() {
            Some("-name") => {
                self.at += 1;
                Ok(FindTest::Name(self.value("-name")?))
            }
            Some("-path") | Some("-ipath") => {
                let insensitive = self.peek().map(String::as_str) == Some("-ipath");
                self.at += 1;
                Ok(FindTest::Path(self.value("-path")?, insensitive))
            }
            Some("-type") => {
                self.at += 1;
                let kind = self.value("-type")?;
                Ok(FindTest::Type(kind.chars().next().unwrap_or('f')))
            }
            Some("-mtime") => {
                self.at += 1;
                let raw = self.value("-mtime")?;
                let (mode, raw) = match raw.strip_prefix('+') {
                    Some(rest) => (FindAge::Older, rest.to_owned()),
                    None => match raw.strip_prefix('-') {
                        Some(rest) => (FindAge::Newer, rest.to_owned()),
                        None => (FindAge::Exact, raw),
                    },
                };
                let days: i64 = raw.parse().map_err(|_| "bad -mtime")?;
                Ok(FindTest::MTime(days, mode))
            }
            Some("-maxdepth") => {
                self.at += 1;
                let depth: usize = self
                    .value("-maxdepth")?
                    .parse()
                    .map_err(|_| "bad -maxdepth")?;
                *max_depth = Some(depth);
                Ok(FindTest::MaxDepth)
            }
            Some("-mindepth") => {
                self.at += 1;
                self.min_depth = self
                    .value("-mindepth")?
                    .parse()
                    .map_err(|_| "bad -mindepth")?;
                Ok(FindTest::MaxDepth)
            }
            Some("-true") => {
                self.at += 1;
                Ok(FindTest::Always)
            }
            Some("-print") => {
                self.at += 1;
                actions.push(FindAction::Print);
                *saw_action = true;
                Ok(FindTest::Always)
            }
            Some("-delete") => {
                self.at += 1;
                actions.push(FindAction::Delete);
                *saw_action = true;
                Ok(FindTest::Always)
            }
            Some("-exec") | Some("-execdir") => {
                self.at += 1;
                let mut command = Vec::new();
                let mut terminator = ';';
                while let Some(token) = self.peek().cloned() {
                    self.at += 1;
                    if token == ";" {
                        break;
                    }
                    if token == "+" {
                        terminator = '+';
                        break;
                    }
                    command.push(token);
                }
                if command.is_empty() {
                    return Err("-exec needs a command".into());
                }
                actions.push(FindAction::Exec {
                    command,
                    terminator,
                });
                *saw_action = true;
                Ok(FindTest::Always)
            }
            Some(other) => Err(format!("{other}: unsupported test")),
            None => Ok(FindTest::Always),
        }
    }
}

fn test_matches(
    test: &FindTest,
    name: &str,
    display_path: &str,
    is_dir: bool,
    is_file: bool,
    mtime_secs: i64,
) -> bool {
    match test {
        FindTest::Always | FindTest::MaxDepth => true,
        // find matches hidden names like any other — no pathname-expansion dot rule.
        FindTest::Name(pattern) => glob::glob_match_raw(pattern, name),
        FindTest::Path(pattern, insensitive) => {
            if *insensitive {
                glob::glob_match_raw(&pattern.to_lowercase(), &display_path.to_lowercase())
            } else {
                glob::glob_match_raw(pattern, display_path)
            }
        }
        FindTest::MTime(days, mode) => {
            // GNU counts the file's age in whole days down from now.
            let age_days = (super::localtime::now_unix() - mtime_secs) / 86_400;
            match mode {
                FindAge::Exact => age_days == *days,
                FindAge::Older => age_days > *days,
                FindAge::Newer => age_days < *days,
            }
        }
        FindTest::Type(kind) => match kind {
            'd' => is_dir,
            'f' => is_file,
            _ => true,
        },
        FindTest::Not(inner) => {
            !test_matches(inner, name, display_path, is_dir, is_file, mtime_secs)
        }
        FindTest::Any(branches) => branches
            .iter()
            .any(|branch| test_matches(branch, name, display_path, is_dir, is_file, mtime_secs)),
        FindTest::All(branches) => branches
            .iter()
            .all(|branch| test_matches(branch, name, display_path, is_dir, is_file, mtime_secs)),
    }
}

struct Walker {
    depth: usize,
    max_depth: Option<usize>,
    min_depth: usize,
}

impl Walker {
    fn visit(&mut self, dir: &Path, display: &str, test: &FindTest, out: &mut Vec<(String, bool)>) {
        // A visit at depth d yields children at find-depth d+1 (the root is 0), so
        // -maxdepth N stops the descent one level early.
        if let Some(max) = self.max_depth {
            if self.depth >= max {
                return;
            }
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        let mut paths: Vec<std::path::PathBuf> =
            entries.flatten().map(|entry| entry.path()).collect();
        paths.sort();
        for path in paths {
            let metadata = std::fs::symlink_metadata(&path).ok();
            let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let is_file = metadata.as_ref().map(|m| m.is_file()).unwrap_or(false);
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let display_path = format!("{}/{}", display.trim_end_matches('/'), file_name);
            let mtime_secs = metadata
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            // A child of a depth-d visit sits at find-depth d+1.
            if self.depth + 1 >= self.min_depth
                && test_matches(test, &file_name, &display_path, is_dir, is_file, mtime_secs)
            {
                out.push((display_path.clone(), is_dir));
            }
            if is_dir {
                self.depth += 1;
                self.visit(&path, &display_path, test, out);
                self.depth -= 1;
            }
        }
    }
}

/* ---------- head / tail ---------- */

fn head(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    // `-c N` counts bytes instead of lines.
    let mut bytes: Option<usize> = None;
    let mut scanned: Vec<String> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if let Some(value) = arg.strip_prefix("-c") {
            if let Ok(parsed) = value.parse::<usize>() {
                bytes = Some(parsed);
                index += 1;
                continue;
            }
        }
        if arg == "-c" {
            if let Some(parsed) = args
                .get(index + 1)
                .and_then(|value| value.parse::<usize>().ok())
            {
                bytes = Some(parsed);
                index += 2;
                continue;
            }
        }
        scanned.push(arg.clone());
        index += 1;
    }
    let (count, _from_start, rest) = split_count_args(&scanned, 10);
    let (_flags, paths) = parse_flags(&rest);
    // stdin is streamed line by line: head must be able to stop BEFORE the writer
    // ends — `while :; do echo; done | head -1` only terminates because head closes
    // its end of the pipe after the first line (the writer's SIGPIPE). The lines pass
    // through byte-exact: a CRLF stays CRLF, and a last line without a newline gets none.
    if paths.is_empty() {
        let mut stdin = io.clone();
        if let Some(bytes) = bytes {
            let mut got: Vec<u8> = Vec::new();
            while got.len() < bytes {
                match stdin.read_raw_line() {
                    Some(line) => got.extend_from_slice(&line),
                    None => break,
                }
            }
            io.write_out(&got[..bytes.min(got.len())]);
            return Ok(0);
        }
        let mut printed = 0i64;
        while printed < count {
            match stdin.read_raw_line() {
                Some(line) => {
                    io.write_out(&line);
                    printed += 1;
                }
                None => break,
            }
        }
        return Ok(0);
    }
    let mut io_mut = io.clone();
    let inputs = match read_input(shell, &mut io_mut, &paths) {
        Ok(inputs) => inputs,
        Err(error) => {
            io.err_str(&format!("head: {error}\n"));
            return Ok(1);
        }
    };
    for (name, text) in inputs {
        let labelled = paths.len() > 1;
        if labelled {
            io.out_str(&format!("==> {name} <==\n"));
        }
        if let Some(bytes) = bytes {
            let cut = &text.as_bytes()[..bytes.min(text.len())];
            io.write_out(cut);
            continue;
        }
        for line in lines_of(&text).into_iter().take(count.max(0) as usize) {
            io.out_str(&format!("{line}\n"));
        }
    }
    Ok(0)
}

/// The `-n N` / `-nN` / legacy `-N` count forms, split away from the positional
/// arguments (so `head -n 2` does not also open a file named `2`). The second answer
/// carries a leading `+` (`tail -n +K` means from line K, not the last K — and Rust's
/// integer parse would happily swallow the sign and lose the distinction).
fn split_count_args(args: &[String], default: i64) -> (i64, bool, Vec<String>) {
    let mut count = default;
    let mut from_start = false;
    let mut rest = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if let Some(body) = arg.strip_prefix('-') {
            let mut take = |value: &str| -> bool {
                match value.strip_prefix('+') {
                    Some(plus) => match plus.parse::<i64>() {
                        Ok(parsed) => {
                            count = parsed;
                            from_start = true;
                            true
                        }
                        Err(_) => false,
                    },
                    None => match value.parse::<i64>() {
                        Ok(parsed) => {
                            count = parsed;
                            from_start = false;
                            true
                        }
                        Err(_) => false,
                    },
                }
            };
            if body == "n" {
                if let Some(value) = args.get(index + 1) {
                    if take(value) {
                        index += 2;
                        continue;
                    }
                }
            }
            if let Some(value) = body.strip_prefix('n') {
                if take(value) {
                    index += 1;
                    continue;
                }
            }
            if !body.is_empty() && body.chars().all(|c| c.is_ascii_digit()) {
                if let Ok(parsed) = body.parse::<i64>() {
                    count = parsed;
                    from_start = false;
                    index += 1;
                    continue;
                }
            }
        }
        rest.push(arg.clone());
        index += 1;
    }
    (count, from_start, rest)
}

fn tail(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (count, from_start, rest) = split_count_args(args, 10);
    // `tail -n +K` prints from line K instead of the last K.
    let from_line: Option<usize> = from_start.then_some(count.max(1) as usize);
    let (_flags, paths) = parse_flags(&rest);
    let mut io_mut = io.clone();
    let inputs = match read_input(shell, &mut io_mut, &paths) {
        Ok(inputs) => inputs,
        Err(error) => {
            io.err_str(&format!(
                "tail: {error}
"
            ));
            return Ok(1);
        }
    };
    for (name, text) in inputs {
        let labelled = paths.len() > 1;
        if labelled {
            io.out_str(&format!(
                "==> {name} <==
"
            ));
        }
        let lines = lines_of(&text);
        match from_line {
            Some(start) => {
                for line in lines.iter().skip(start.saturating_sub(1)) {
                    io.out_str(&format!(
                        "{line}
"
                    ));
                }
            }
            None => {
                let take = count.max(0) as usize;
                let skip = lines.len().saturating_sub(take);
                for line in lines.iter().skip(skip) {
                    io.out_str(&format!(
                        "{line}
"
                    ));
                }
            }
        }
    }
    Ok(0)
}

/* ---------- wc ---------- */

fn wc(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (flags, paths) = parse_flags(args);
    let want_lines = flags.contains('l');
    let want_words = flags.contains('w');
    let want_chars = flags.contains('c');
    let everything = !want_lines && !want_words && !want_chars;
    let mut io_mut = io.clone();
    let inputs = match read_input(shell, &mut io_mut, &paths) {
        Ok(inputs) => inputs,
        Err(error) => {
            io.err_str(&format!("wc: {error}\n"));
            return Ok(1);
        }
    };
    let labelled = paths.len() > 1;
    let mut totals = (0usize, 0usize, 0usize);
    for (name, text) in &inputs {
        let line_count = text.matches('\n').count();
        let word_count = text.split_whitespace().count();
        let byte_count = text.len();
        totals.0 += line_count;
        totals.1 += word_count;
        totals.2 += byte_count;
        io.out_str(&wc_line(
            line_count, word_count, byte_count, want_lines, want_words, want_chars, everything,
        ));
        if labelled {
            io.out_str(&format!(" {name}\n"));
        } else {
            io.out_str("\n");
        }
    }
    if labelled {
        io.out_str(&wc_line(
            totals.0, totals.1, totals.2, want_lines, want_words, want_chars, everything,
        ));
        io.out_str(" total\n");
    }
    Ok(0)
}

fn wc_line(
    lines: usize,
    words: usize,
    chars: usize,
    l: bool,
    w: bool,
    c: bool,
    everything: bool,
) -> String {
    let mut out = String::new();
    if l || everything {
        out.push_str(&format!("{lines:>8}"));
    }
    if w || everything {
        out.push_str(&format!("{words:>8}"));
    }
    if c || everything {
        out.push_str(&format!("{chars:>8}"));
    }
    out
}

/* ---------- Filesystem applets ---------- */

fn mkdir(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (flags, paths) = parse_flags(args);
    let parents = flags.contains('p');
    let mut status = 0;
    for path in resolve_paths(shell, &paths) {
        let result = if parents {
            std::fs::create_dir_all(&path)
        } else {
            std::fs::create_dir(&path)
        };
        if let Err(error) = result {
            io.err_str(&format!("mkdir: {}: {error}\n", path.display()));
            status = 1;
        }
    }
    Ok(status)
}

fn rmdir(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (_, paths) = parse_flags(args);
    let mut status = 0;
    for path in resolve_paths(shell, &paths) {
        if let Err(error) = std::fs::remove_dir(&path) {
            io.err_str(&format!("rmdir: {}: {error}\n", path.display()));
            status = 1;
        }
    }
    Ok(status)
}

fn rm(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (flags, paths) = parse_flags(args);
    let recursive = flags.contains('r') || flags.contains('R');
    let force = flags.contains('f');
    let mut status = 0;
    for path in resolve_paths(shell, &paths) {
        let metadata = std::fs::symlink_metadata(&path);
        let result = match &metadata {
            Err(_) if force => continue,
            Err(error) => Err(std::io::Error::other(format!("{error}"))),
            Ok(m) if m.is_dir() && recursive => std::fs::remove_dir_all(&path),
            Ok(m) if m.is_dir() => std::fs::remove_dir(&path),
            Ok(_) => std::fs::remove_file(&path),
        };
        if let Err(error) = result {
            io.err_str(&format!("rm: {}: {error}\n", path.display()));
            status = 1;
        }
    }
    Ok(status)
}

fn cp(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (flags, paths) = parse_flags(args);
    let recursive = flags.contains('r') || flags.contains('R');
    if paths.len() < 2 {
        io.err_str("cp: a source and a destination are required\n");
        return Ok(1);
    }
    let (sources, destination) = paths.split_at(paths.len() - 1);
    let destination = resolve_paths(shell, destination).remove(0);
    let into_dir = destination.is_dir()
        && !(sources.len() == 1 && destination == resolve_paths(shell, sources).remove(0));
    let mut status = 0;
    for source in sources {
        let from = resolve_paths(shell, std::slice::from_ref(source)).remove(0);
        let to = if into_dir {
            destination.join(from.file_name().unwrap_or_default())
        } else {
            destination.clone()
        };
        if let Err(error) = copy_tree(&from, &to, recursive) {
            io.err_str(&format!("cp: {source}: {error}\n"));
            status = 1;
        }
    }
    Ok(status)
}

fn copy_tree(from: &Path, to: &Path, recursive: bool) -> Result<(), String> {
    if from.is_dir() {
        if !recursive {
            return Err(format!("{}: is a directory (use -r)", from.display()));
        }
        std::fs::create_dir_all(to).map_err(|e| format!("{e}"))?;
        let mut entries: Vec<PathBuf> = std::fs::read_dir(from)
            .map_err(|e| format!("{e}"))?
            .flatten()
            .map(|e| e.path())
            .collect();
        entries.sort();
        for entry in entries {
            let name = entry.file_name().unwrap_or_default();
            copy_tree(&entry, &to.join(name), recursive)?;
        }
        return Ok(());
    }
    std::fs::copy(from, to)
        .map_err(|e| format!("{e}"))
        .map(|_| ())
}

fn mv(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (_, paths) = parse_flags(args);
    if paths.len() < 2 {
        io.err_str("mv: a source and a destination are required\n");
        return Ok(1);
    }
    let (sources, destination) = paths.split_at(paths.len() - 1);
    let destination = resolve_paths(shell, destination).remove(0);
    let into_dir = destination.is_dir();
    let mut status = 0;
    for source in sources {
        let from = resolve_paths(shell, std::slice::from_ref(source)).remove(0);
        let to = if into_dir {
            destination.join(from.file_name().unwrap_or_default())
        } else {
            destination.clone()
        };
        if let Err(error) = std::fs::rename(&from, &to) {
            // Across volumes a rename fails; fall back to copy + remove.
            if copy_tree(&from, &to, true).is_ok() {
                let _ = std::fs::remove_dir_all(&from);
            } else {
                io.err_str(&format!("mv: {source}: {error}\n"));
                status = 1;
            }
        }
    }
    Ok(status)
}

fn touch(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (_, paths) = parse_flags(args);
    let mut status = 0;
    for path in resolve_paths(shell, &paths) {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(_) => {}
            Err(_) if path.exists() => {
                // Exists: refresh mtime by rewriting the length at itself.
                if let Ok(metadata) = std::fs::metadata(&path) {
                    if let Ok(file) = std::fs::OpenOptions::new().write(true).open(&path) {
                        let _ = file.set_len(metadata.len());
                    }
                }
            }
            Err(error) => {
                io.err_str(&format!("touch: {}: {error}\n", path.display()));
                status = 1;
            }
        }
    }
    Ok(status)
}

/* ---------- Text applets ---------- */

fn sort(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut reverse = false;
    let mut numeric = false;
    let mut unique = false;
    let mut fold = false;
    // `None` until -t: the default field separator is a RUN of blanks with the
    // leading ones skipped (so `-k2` sees "a  b" as field 2 = "b"), not a tab.
    let mut delim: Option<char> = None;
    let mut keys: Vec<(usize, usize, bool)> = Vec::new(); // (field, end_field, numeric)
    let mut output: Option<String> = None;
    let mut paths: Vec<String> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "-t" {
            // The spaced form first: "-t" alone must not match the glued strip below.
            index += 1;
            if let Some(value) = args.get(index) {
                delim = value.chars().next();
            }
        } else if let Some(value) = arg.strip_prefix("-t") {
            delim = unescape(value).chars().next();
        } else if let Some(value) = arg.strip_prefix("-k") {
            // -k 2, -k2, -k 2.1, -k2,3, -k 2n, -k2r — the common shapes.
            let key = if value.is_empty() {
                index += 1;
                args.get(index).cloned().unwrap_or_default()
            } else {
                value.to_owned()
            };
            let (body, key_numeric) = if let Some(stripped) = key.strip_suffix('n') {
                (stripped.to_owned(), true)
            } else {
                (key.clone(), false)
            };
            let (start_field, end_field) = match body.split_once(',') {
                Some((from, to)) => (field_number(from), field_number(to)),
                None => {
                    // A bare `-k N` runs to the end of the line, not just field N.
                    let at = field_number(&body);
                    (at, usize::MAX)
                }
            };
            keys.push((start_field, end_field, key_numeric));
        } else if let Some(value) = arg.strip_prefix("-o") {
            output = Some(if value.is_empty() {
                index += 1;
                args.get(index).cloned().unwrap_or_default()
            } else {
                value.to_owned()
            });
        } else if arg == "-o" {
            index += 1;
            output = args.get(index).cloned();
        } else if let Some(flags) = arg.strip_prefix('-') {
            for c in flags.chars() {
                match c {
                    'r' => reverse = true,
                    'n' => numeric = true,
                    'u' => unique = true,
                    'f' => fold = true,
                    'b' | 'g' | 's' | 'h' => {}
                    other => io.err_str(&format!("sort: -{other}: unsupported\n")),
                }
            }
        } else {
            paths.push(arg.clone());
        }
        index += 1;
    }
    let mut io_mut = io.clone();
    let inputs = match read_input(shell, &mut io_mut, &paths) {
        Ok(inputs) => inputs,
        Err(error) => {
            io.err_str(&format!("sort: {error}\n"));
            return Ok(1);
        }
    };
    let mut lines: Vec<String> = inputs
        .into_iter()
        .flat_map(|(_, text)| {
            lines_of(&text)
                .iter()
                .map(|l| (*l).to_owned())
                .collect::<Vec<_>>()
        })
        .collect();
    // The fields of one line under the separator in force: an explicit -t splits on
    // each single delimiter (empties kept); the default splits on blank runs and
    // never sees the leading blanks as a field.
    fn fields_of(line: &str, delim: Option<char>) -> Vec<&str> {
        match delim {
            Some(d) => line.split(d).collect(),
            None => line.split_whitespace().collect(),
        }
    }
    // One -k range's text: fields start..=end (end clamped by the line).
    let key_text = |line: &str, start: &usize, end: &usize| -> String {
        let fields = fields_of(line, delim);
        let from = start.saturating_sub(1);
        let to = (*end).min(fields.len());
        fields[from..to.max(from)].join(" ")
    };
    let lex = |a: &str, b: &str| -> std::cmp::Ordering {
        if fold {
            a.to_lowercase().cmp(&b.to_lowercase())
        } else {
            a.cmp(b)
        }
    };
    lines.sort_by(|a, b| {
        if keys.is_empty() {
            return if numeric {
                numeric_prefix_of(a)
                    .partial_cmp(&numeric_prefix_of(b))
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| lex(a, b))
            } else {
                lex(a, b)
            };
        }
        // Each key compares on its own: numeric where the key (or a global -n)
        // says so, lexically otherwise; the first difference decides.
        for (start, end, key_numeric) in &keys {
            let ka = key_text(a, start, end);
            let kb = key_text(b, start, end);
            let ord = if *key_numeric || numeric {
                numeric_prefix_of(&ka)
                    .partial_cmp(&numeric_prefix_of(&kb))
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| lex(&ka, &kb))
            } else {
                lex(&ka, &kb)
            };
            if ord != std::cmp::Ordering::Equal {
                return ord;
            }
        }
        // Every key equal: the whole line decides, lexically (GNU's last resort).
        lex(a, b)
    });
    if unique {
        lines.dedup_by(|a, b| {
            if fold {
                a.to_lowercase() == b.to_lowercase()
            } else {
                a == b
            }
        });
    }
    if reverse {
        lines.reverse();
    }
    let mut text = String::new();
    for line in &lines {
        text.push_str(line);
        text.push('\n');
    }
    match output {
        Some(path) => {
            let resolved = shell.resolve_working_path(&path);
            if let Err(error) = std::fs::write(&resolved, &text) {
                io.err_str(&format!("sort: {path}: {error}\n"));
                return Ok(1);
            }
        }
        None => io.out_str(&text),
    }
    Ok(0)
}

/// `-k 2.1` → field 2 (the character offset is accepted and dropped).
fn field_number(text: &str) -> usize {
    let base = text.split('.').next().unwrap_or("1");
    base.parse().unwrap_or(1).max(1)
}

/// The numeric prefix GNU sort reads: optional sign, digits, one decimal point —
/// anything else ends the number (and a prefix with no digits at all is zero).
fn numeric_prefix_of(text: &str) -> f64 {
    let trimmed = text.trim_start();
    let mut digits = String::new();
    let mut seen_digit = false;
    let mut seen_point = false;
    let mut chars = trimmed.chars().peekable();
    if let Some(sign @ ('-' | '+')) = chars.peek().copied() {
        digits.push(sign);
        chars.next();
    }
    for c in chars {
        if c.is_ascii_digit() {
            seen_digit = true;
            digits.push(c);
        } else if c == '.' && !seen_point {
            seen_point = true;
            digits.push(c);
        } else {
            break;
        }
    }
    if !seen_digit {
        return 0.0;
    }
    digits.parse().unwrap_or(0.0)
}

fn uniq(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (flags, paths) = parse_flags(args);
    let count = flags.contains('c');
    let only_dups = flags.contains('d');
    let only_uniques = flags.contains('u');
    let mut io_mut = io.clone();
    let inputs = match read_input(shell, &mut io_mut, &paths) {
        Ok(inputs) => inputs,
        Err(error) => {
            io.err_str(&format!("uniq: {error}\n"));
            return Ok(1);
        }
    };
    let mut run: Option<(String, usize)> = None;
    let flush = |run: &mut Option<(String, usize)>, io: &Io| {
        if let Some((text, times)) = run.take() {
            let keep = if only_dups {
                times > 1
            } else if only_uniques {
                times == 1
            } else {
                true
            };
            if keep {
                if count {
                    io.out_str(&format!("{times:>7} {text}\n"));
                } else {
                    io.out_str(&format!("{text}\n"));
                }
            }
        }
    };
    for (_, text) in inputs {
        for line in lines_of(&text) {
            match &mut run {
                Some((previous, times)) if previous == line => *times += 1,
                _ => {
                    flush(&mut run, io);
                    run = Some((line.to_owned(), 1));
                }
            }
        }
    }
    flush(&mut run, io);
    Ok(0)
}

fn cut(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut delimiter = '\t';
    let mut fields: Option<String> = None;
    let mut chars: Option<String> = None;
    let mut paths: Vec<String> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if let Some(value) = arg.strip_prefix("-d") {
            if value.is_empty() {
                index += 1;
                if let Some(next) = args.get(index) {
                    delimiter = next.chars().next().unwrap_or('\t');
                }
            } else {
                delimiter = unescape(value).chars().next().unwrap_or('\t');
            }
        } else if arg == "-f" || arg == "-c" {
            // The spaced forms take their list from the next argument.
            index += 1;
            let list = args.get(index).cloned().unwrap_or_default();
            if arg == "-f" {
                fields = Some(list);
            } else {
                chars = Some(list);
            }
        } else if let Some(value) = arg.strip_prefix("-f") {
            fields = Some(value.to_owned());
        } else if let Some(value) = arg.strip_prefix("-c") {
            chars = Some(value.to_owned());
        } else if arg == "--" {
            // everything after is positional
        } else if !arg.starts_with('-') {
            paths.push(arg.clone());
        }
        index += 1;
    }
    let by_chars = chars.is_some();
    let list = fields.or(chars).unwrap_or_default();
    let ranges = match parse_ranges(&list) {
        Ok(ranges) => ranges,
        Err(error) => {
            io.err_str(&format!("cut: {error}\n"));
            return Ok(1);
        }
    };
    let mut io_mut = io.clone();
    let inputs = match read_input(shell, &mut io_mut, &paths) {
        Ok(inputs) => inputs,
        Err(error) => {
            io.err_str(&format!("cut: {error}\n"));
            return Ok(1);
        }
    };
    for (_, text) in inputs {
        for line in lines_of(&text) {
            let pieces: Vec<String> = if by_chars {
                vec![line.to_owned()]
            } else {
                line.split(delimiter).map(str::to_owned).collect()
            };
            let mut picked: Vec<String> = Vec::new();
            for range in &ranges {
                if by_chars {
                    let chars: Vec<char> = line.chars().collect();
                    let slice: String = chars
                        .iter()
                        .skip(range.start.saturating_sub(1))
                        .take(range.end.saturating_sub(range.start.saturating_sub(1)))
                        .collect();
                    picked.push(slice);
                } else if range.end == usize::MAX {
                    picked.extend(pieces.iter().skip(range.start.saturating_sub(1)).cloned());
                } else {
                    picked.extend(
                        pieces
                            .iter()
                            .skip(range.start.saturating_sub(1))
                            .take(range.end.saturating_sub(range.start.saturating_sub(1)))
                            .cloned(),
                    );
                }
            }
            if picked.is_empty() {
                picked.push(String::new());
            }
            io.out_str(&format!("{}\n", picked.join(&delimiter.to_string())));
        }
    }
    Ok(0)
}

struct Range {
    start: usize,
    end: usize,
}

fn parse_ranges(list: &str) -> Result<Vec<Range>, String> {
    let mut ranges = Vec::new();
    for part in list.split(',') {
        if part.is_empty() {
            continue;
        }
        let (start, end) = match part.split_once('-') {
            Some((from, to)) => {
                let start: usize = if from.is_empty() {
                    1
                } else {
                    from.parse().map_err(|_| format!("{part}: bad range"))?
                };
                let end: usize = if to.is_empty() {
                    usize::MAX
                } else {
                    to.parse().map_err(|_| format!("{part}: bad range"))?
                };
                (start, end)
            }
            None => {
                let at: usize = part.parse().map_err(|_| format!("{part}: bad range"))?;
                (at, at)
            }
        };
        if start == 0 || (end != usize::MAX && end < start) {
            return Err(format!("{part}: bad range"));
        }
        ranges.push(Range { start, end });
    }
    Ok(ranges)
}

fn tr(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (flags, rest) = parse_flags(args);
    let delete = flags.contains('d');
    let squeeze = flags.contains('s');
    let Some(set1) = rest.first().map(|s| expand_set(s)) else {
        io.err_str("tr: a set is required\n");
        return Ok(1);
    };
    let set2 = rest.get(1).map(|s| expand_set(s));
    let mut io_mut = io.clone();
    let inputs = match read_input(shell, &mut io_mut, &[]) {
        Ok(inputs) => inputs,
        Err(error) => {
            io.err_str(&format!("tr: {error}\n"));
            return Ok(1);
        }
    };
    // The last character of SET2 covers every SET1 member beyond its length (`tr ab 1`).
    let set2_last = set2.as_ref().and_then(|s| s.last().copied());
    // `-s` squeezes repeats of the LAST set's characters: SET2 when translating (or
    // when deleting with a squeeze set), SET1 for a lone `tr -s set`.
    let squeeze_set: &[char] = set2.as_deref().unwrap_or(&set1);
    for (_, text) in inputs {
        let mut out = String::new();
        let mut previous: Option<char> = None;
        for c in text.chars() {
            let mapped = if delete {
                None
            } else {
                match set1.iter().position(|s| *s == c) {
                    Some(at) => Some(
                        set2.as_ref()
                            .and_then(|s| s.get(at).copied())
                            .or(set2_last)
                            .unwrap_or(c),
                    ),
                    None => Some(c),
                }
            };
            let Some(mapped) = mapped else { continue };
            if squeeze && squeeze_set.contains(&mapped) && previous == Some(mapped) {
                continue;
            }
            out.push(mapped);
            previous = Some(mapped);
        }
        io.out_str(&out);
    }
    Ok(0)
}

fn expand_set(text: &str) -> Vec<char> {
    let unescaped = unescape(text);
    let mut out = Vec::new();
    let chars: Vec<char> = unescaped.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if index + 2 < chars.len() && chars[index + 1] == '-' {
            for code in (chars[index] as u32)..=(chars[index + 2] as u32) {
                if let Some(c) = char::from_u32(code) {
                    out.push(c);
                }
            }
            index += 3;
        } else {
            out.push(chars[index]);
            index += 1;
        }
    }
    out
}

/* ---------- sed ---------- */

enum SedAddr {
    Line(usize),
    Last,
    Regex(Regex),
}

enum SedCmd {
    Substitute {
        regex: Regex,
        replacement: String,
        global: bool,
    },
    Print,
    Delete,
    Quit,
}

struct SedRule {
    from: Option<SedAddr>,
    to: Option<SedAddr>,
    cmd: SedCmd,
}

fn sed(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut quiet = false;
    let mut ere = false;
    let mut inplace = false;
    // Every `-e` rides along; a bare script argument is a single expression.
    let mut scripts: Vec<String> = Vec::new();
    let mut paths: Vec<String> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if let Some(body) = arg.strip_prefix('-') {
            match body {
                "n" => quiet = true,
                "E" | "r" => ere = true,
                "i" => inplace = true,
                "e" => {
                    index += 1;
                    if let Some(value) = args.get(index) {
                        scripts.push(value.clone());
                    }
                }
                _ => {}
            }
        } else if scripts.is_empty() {
            scripts.push(arg.clone());
        } else {
            paths.push(arg.clone());
        }
        index += 1;
    }
    let joined = scripts.join(";");
    if joined.is_empty() {
        io.err_str("sed: a script is required\n");
        return Ok(1);
    }
    let script = joined;
    let rules = match parse_sed(&script, ere) {
        Ok(rules) => rules,
        Err(error) => {
            io.err_str(&format!("sed: {error}\n"));
            return Ok(1);
        }
    };
    let mut io_mut = io.clone();
    let inputs = match read_input(shell, &mut io_mut, &paths) {
        Ok(inputs) => inputs,
        Err(error) => {
            io.err_str(&format!("sed: {error}\n"));
            return Ok(1);
        }
    };
    // `-i` collects each file's answer instead of printing it, then writes it back.
    for (name, text) in inputs {
        let lines: Vec<&str> = lines_of(&text);
        let total = lines.len();
        let mut file_out = String::new();
        // A two-address range is a state, not a per-line AND: `/a/,/b/` opens at the
        // first `a` and stays open (inclusive) through the first `b` after it. Each
        // rule owns its own open flag; a new input file starts every range closed.
        let mut range_open = vec![false; rules.len()];
        for (at, line) in lines.iter().enumerate() {
            let line_number = at + 1;
            let mut current: String = line.to_string();
            let mut deleted = false;
            let mut quit = false;
            let addr_hit = |addr: &SedAddr, current: &str| match addr {
                SedAddr::Line(n) => *n == line_number,
                SedAddr::Last => line_number == total,
                SedAddr::Regex(re) => re.is_match(current),
            };
            for (rule_at, rule) in rules.iter().enumerate() {
                let in_range = match (&rule.from, &rule.to) {
                    (None, _) => true,
                    (Some(_), None) => addr_hit(rule.from.as_ref().unwrap(), &current),
                    (Some(_), Some(_)) => {
                        let (from, to) = (rule.from.as_ref().unwrap(), rule.to.as_ref().unwrap());
                        if range_open[rule_at] {
                            if addr_hit(to, &current) {
                                range_open[rule_at] = false;
                            }
                            true
                        } else if addr_hit(from, &current) {
                            // The opening line is in the range. POSIX tries a regex
                            // end address from the NEXT line on (`/^---$/,/^---$/`
                            // spans the front matter); a line-number end at or before
                            // this line makes the range exactly this one line.
                            let closes_here = match to {
                                SedAddr::Line(n) => *n <= line_number,
                                SedAddr::Last => line_number == total,
                                SedAddr::Regex(_) => false,
                            };
                            if !closes_here {
                                range_open[rule_at] = true;
                            }
                            true
                        } else {
                            false
                        }
                    }
                };
                if !in_range {
                    continue;
                }
                match &rule.cmd {
                    SedCmd::Substitute {
                        regex,
                        replacement,
                        global,
                    } => {
                        current = substitute(regex, &current, replacement, *global);
                    }
                    SedCmd::Print => {
                        file_out.push_str(&format!("{current}\n"));
                    }
                    SedCmd::Delete => {
                        deleted = true;
                    }
                    SedCmd::Quit => {
                        quit = true;
                    }
                }
                if quit {
                    break;
                }
            }
            if quit {
                if !quiet && !deleted {
                    file_out.push_str(&format!("{current}\n"));
                }
                break;
            }
            if !deleted && !quiet {
                file_out.push_str(&format!("{current}\n"));
            }
        }
        if inplace && !paths.is_empty() {
            let path = shell.resolve_working_path(&name);
            if let Err(error) = std::fs::write(&path, &file_out) {
                io.err_str(&format!("sed: {name}: {error}\n"));
                return Ok(1);
            }
        } else {
            io.out_str(&file_out);
        }
    }
    Ok(0)
}

fn substitute(regex: &Regex, line: &str, replacement: &str, global: bool) -> String {
    // The matches are laid over the whole line in byte offsets: `^` anchors once at the
    // line start (rescanning a tail would re-anchor it at every step), and the spans
    // slice `line` directly whatever multibyte text sits in front of them.
    let mut out = String::new();
    let mut at = 0usize;
    let mut last_end: Option<usize> = None;
    for found in regex.find_iter(line) {
        // An empty match right where the previous match ended is no match — GNU's
        // rule (`s/x*/-/g` over `xab` is `-a-b-`).
        if found.start == found.end && last_end == Some(found.start) {
            continue;
        }
        out.push_str(&line[at..found.start]);
        out.push_str(&expand_replacement(replacement, line, &found));
        at = found.end;
        last_end = Some(found.end);
        if !global {
            break;
        }
    }
    out.push_str(&line[at..]);
    out
}

fn expand_replacement(replacement: &str, text: &str, found: &super::regexlite::Match) -> String {
    let mut out = String::new();
    let mut chars = replacement.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some(digit) if digit.is_ascii_digit() && digit != '0' => {
                    if let Some(Some((start, end))) =
                        found.groups.get(digit as usize - '0' as usize)
                    {
                        out.push_str(&text[*start..*end]);
                    }
                }
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            },
            '&' => out.push_str(&text[found.start..found.end]),
            other => out.push(other),
        }
    }
    out
}

fn parse_sed(script: &str, ere: bool) -> Result<Vec<SedRule>, String> {
    let mut rules = Vec::new();
    let mut rest: String = script.trim().to_owned();
    while !rest.is_empty() {
        if rest.starts_with('#') {
            // A comment runs to the end of the script.
            break;
        }
        // Up to two addresses, then the command.
        let (from, after_from) = take_addr(&rest, ere)?;
        rest = after_from;
        let mut to = None;
        if rest.starts_with(',') {
            let (second, after_to) = take_addr(&rest[1..], ere)?;
            to = second;
            rest = after_to;
        }
        let (cmd, after_cmd) = take_cmd(&rest, ere)?;
        rules.push(SedRule { from, to, cmd });
        rest = after_cmd
            .trim_start()
            .trim_start_matches(';')
            .trim_start()
            .to_owned();
    }
    Ok(rules)
}

/// One address: `$`, `/regex/` or a line number — `None` when the text starts with
/// something else (the command is unconditional).
fn take_addr(script: &str, ere: bool) -> Result<(Option<SedAddr>, String), String> {
    if let Some(after) = script.strip_prefix('$') {
        return Ok((Some(SedAddr::Last), after.to_owned()));
    }
    if let Some(after_slash) = script.strip_prefix('/') {
        let bytes: Vec<char> = after_slash.chars().collect();
        let mut end = 0;
        while end < bytes.len() && bytes[end] != '/' {
            if bytes[end] == '\\' {
                end += 1;
            }
            end += 1;
        }
        if end >= bytes.len() {
            return Err("unterminated /regex/ address".into());
        }
        let pattern: String = bytes[..end].iter().collect();
        let rest: String = bytes[end + 1..].iter().collect();
        let regex = Regex::compile(&pattern, ere, false)?;
        return Ok((Some(SedAddr::Regex(regex)), rest));
    }
    let digits: String = script.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return Ok((None, script.to_owned()));
    }
    let line: usize = digits.parse().map_err(|_| "bad line address")?;
    Ok((Some(SedAddr::Line(line)), script[digits.len()..].to_owned()))
}

fn take_cmd(script: &str, ere: bool) -> Result<(SedCmd, String), String> {
    let mut chars = script.chars();
    let Some(cmd) = chars.next() else {
        return Err("a command is required".into());
    };
    match cmd {
        's' => {
            let Some(delim) = chars.next() else {
                return Err("s needs a delimiter".into());
            };
            // Split s/pat/rep/flags on the unescaped delimiter.
            let body: Vec<char> = script.chars().skip(2).collect();
            let mut parts: Vec<String> = Vec::new();
            let mut current = String::new();
            let mut index = 0;
            while index < body.len() {
                let c = body[index];
                if c == '\\' && index + 1 < body.len() {
                    current.push(c);
                    current.push(body[index + 1]);
                    index += 2;
                    continue;
                }
                if c == delim {
                    parts.push(std::mem::take(&mut current));
                    if parts.len() == 3 {
                        index += 1;
                        break;
                    }
                } else if c == ';' && parts.len() >= 2 {
                    // The flags end where the next command begins (`s/a/b/g;2d`).
                    break;
                } else {
                    current.push(c);
                }
                index += 1;
            }
            if parts.len() == 2 && !current.is_empty() {
                parts.push(current);
            }
            if parts.len() < 2 {
                return Err("s needs s/pattern/replacement/".into());
            }
            let delim_text = format!("\\{delim}");
            let pattern = parts[0].replace(&delim_text, &delim.to_string());
            let replacement = parts[1].replace(&delim_text, &delim.to_string());
            let flags = parts.get(2).cloned().unwrap_or_default();
            let regex = Regex::compile(&pattern, ere, flags.contains('i'))?;
            let global = flags.contains('g');
            let rest: String = body[index.min(body.len())..].iter().collect();
            Ok((
                SedCmd::Substitute {
                    regex,
                    replacement,
                    global,
                },
                rest,
            ))
        }
        'p' => Ok((SedCmd::Print, script[1..].to_owned())),
        'd' => Ok((SedCmd::Delete, script[1..].to_owned())),
        'q' => Ok((SedCmd::Quit, script[1..].to_owned())),
        other => Err(format!("sed: {other}: unsupported command")),
    }
}

/* ---------- Environment applets ---------- */

fn env(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut index = 0;
    let mut extra: Vec<(String, String)> = Vec::new();
    while index < args.len() {
        if args[index].contains('=') && !args[index].starts_with('-') {
            if let Some((key, value)) = args[index].split_once('=') {
                extra.push((key.to_owned(), value.to_owned()));
                index += 1;
                continue;
            }
        }
        if args[index] == "-i" || args[index] == "-u" {
            index += 1;
            continue;
        }
        break;
    }
    if index >= args.len() {
        for (key, value) in shell.child_env(&extra) {
            io.out_str(&format!("{key}={value}\n"));
        }
        return Ok(0);
    }
    let name = args[index].clone();
    shell.spawn_external(&name, &args[index + 1..], &extra, io)
}

fn which(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut status = 0;
    let self_exe = std::env::current_exe()
        .ok()
        .map(|p| p.display().to_string());
    for name in args {
        if super::builtins::is_builtin(name) || is_applet(name) {
            io.out_str(&format!("{}\n", self_exe.as_deref().unwrap_or("ggs-bash")));
        } else if let Some(path) = resolve_on_path(name, &shell.path_var()) {
            io.out_str(&format!("{}\n", path.display()));
        } else {
            status = 1;
        }
    }
    Ok(status)
}

fn basename(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (_, rest) = parse_flags(args);
    let Some(path) = rest.first() else {
        io.err_str("basename: a path is required\n");
        return Ok(1);
    };
    let trimmed = path.trim_end_matches(['/', '\\']);
    let mut name = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    if let Some(suffix) = rest.get(1) {
        if let Some(stripped) = name.strip_suffix(suffix.as_str()) {
            name = stripped;
        }
    }
    let _ = shell;
    io.out_str(&format!("{name}\n"));
    Ok(0)
}

fn dirname(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (_, rest) = parse_flags(args);
    let Some(path) = rest.first() else {
        io.err_str("dirname: a path is required\n");
        return Ok(1);
    };
    // GNU strips the trailing slashes first: `dirname /a/` is `/`, not `/a`.
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    let body = if trimmed.is_empty() && normalized.contains('/') {
        "/"
    } else {
        trimmed
    };
    let mut name = match body.rfind('/') {
        Some(0) => "/".to_owned(),
        Some(at) => body[..at].trim_end_matches('/').to_owned(),
        None => ".".to_owned(),
    };
    if name.is_empty() {
        name = "/".to_owned();
    }
    let _ = shell;
    io.out_str(&format!("{name}\n"));
    Ok(0)
}

fn realpath(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (_, rest) = parse_flags(args);
    let mut status = 0;
    for path in resolve_paths(shell, &rest) {
        match std::fs::canonicalize(&path) {
            Ok(real) => io.out_str(&format!("{}\n", super::msys::to_msys(&real))),
            Err(error) => {
                io.err_str(&format!("realpath: {}: {error}\n", path.display()));
                status = 1;
            }
        }
    }
    Ok(status)
}

fn date(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let _ = shell;
    let format = args
        .iter()
        .find(|a| a.starts_with('+'))
        .map(|a| a[1..].to_owned())
        .unwrap_or_else(|| "%a %b %e %H:%M:%S %Z %Y".to_owned());
    let now = local_now();
    io.out_str(&format_date(&format, &now));
    io.out_str("\n");
    Ok(0)
}

fn format_date(format: &str, now: &Civil) -> String {
    let offset = super::localtime::local_offset_seconds();
    let mut out = String::new();
    let mut chars = format.chars();
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('Y') => out.push_str(&now.year.to_string()),
            Some('y') => out.push_str(&format!("{:02}", now.year.rem_euclid(100))),
            Some('m') => out.push_str(&format!("{:02}", now.month)),
            Some('d') => out.push_str(&format!("{:02}", now.day)),
            Some('e') => out.push_str(&format!("{:>2}", now.day)),
            Some('H') => out.push_str(&format!("{:02}", now.hour)),
            Some('M') => out.push_str(&format!("{:02}", now.minute)),
            Some('S') => out.push_str(&format!("{:02}", now.second)),
            Some('F') => out.push_str(&format!("{}-{:02}-{:02}", now.year, now.month, now.day)),
            Some('T') => out.push_str(&format!(
                "{:02}:{:02}:{:02}",
                now.hour, now.minute, now.second
            )),
            Some('s') => out.push_str(&super::localtime::now_unix().to_string()),
            Some('z') => {
                let sign = if offset < 0 { '-' } else { '+' };
                let minutes = offset.abs() / 60;
                out.push_str(&format!("{sign}{:02}{:02}", minutes / 60, minutes % 60));
            }
            Some('Z') => out.push_str(""),
            Some('a') => out.push_str(DAYS[now.weekday() as usize]),
            Some('b') => out.push_str(MONTHS[(now.month as usize - 1).min(11)]),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('%') => out.push('%'),
            Some(other) => {
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }
    out
}

fn sleep(_shell: &mut Shell, _io: &Io, args: &[String]) -> ExecResult {
    let total: Result<f64, _> = args
        .iter()
        .filter(|a| !a.starts_with('-'))
        .map(|a| a.parse::<f64>())
        .sum();
    match total {
        Ok(seconds) if seconds >= 0.0 => {
            std::thread::sleep(std::time::Duration::from_millis((seconds * 1000.0) as u64));
            Ok(0)
        }
        _ => Ok(1),
    }
}

fn seq(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let numbers: Vec<i64> = args
        .iter()
        .filter(|a| !a.starts_with('-') || a.parse::<f64>().is_ok())
        .filter_map(|a| a.parse().ok())
        .collect();
    let _ = shell;
    match numbers.len() {
        1 => {
            for value in 1..=numbers[0] {
                io.out_str(&format!("{value}\n"));
            }
            Ok(0)
        }
        2 => {
            for value in numbers[0]..=numbers[1] {
                io.out_str(&format!("{value}\n"));
            }
            Ok(0)
        }
        3 => {
            let (first, step, last) = (numbers[0], numbers[1], numbers[2]);
            if step == 0 {
                io.err_str("seq: the step may not be zero\n");
                return Ok(1);
            }
            let mut value = first;
            while (step > 0 && value <= last) || (step < 0 && value >= last) {
                io.out_str(&format!("{value}\n"));
                value += step;
            }
            Ok(0)
        }
        _ => {
            io.err_str("seq: seq [first [step]] last\n");
            Ok(1)
        }
    }
}

/* ---------- The Git Bash parity batch ---------- */

#[derive(Clone, Copy)]
enum DiffEdit {
    Keep,
    Remove,
    Add,
}

/// `diff a b` — unified output, exit 0 identical / 1 different (the AI-facing shape;
/// `-u` is accepted and identical). Recursive directory compare is not supported.
fn diff(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (_flags, paths) = parse_flags(args);
    if paths.len() != 2 {
        io.err_str("diff: two files are required\n");
        return Ok(2);
    }
    let resolved = resolve_paths(shell, &paths);
    let (left_name, right_name) = (paths[0].clone(), paths[1].clone());
    let left = match std::fs::read_to_string(&resolved[0]) {
        Ok(text) => text,
        Err(error) => {
            io.err_str(&format!("diff: {left_name}: {error}\n"));
            return Ok(2);
        }
    };
    let right = match std::fs::read_to_string(&resolved[1]) {
        Ok(text) => text,
        Err(error) => {
            io.err_str(&format!("diff: {right_name}: {error}\n"));
            return Ok(2);
        }
    };
    let a: Vec<&str> = left
        .split_inclusive('\n')
        .map(|l| l.trim_end_matches('\n'))
        .collect();
    let b: Vec<&str> = right
        .split_inclusive('\n')
        .map(|l| l.trim_end_matches('\n'))
        .collect();
    let edits = myers(&a, &b);
    if edits.iter().all(|(edit, _)| matches!(edit, DiffEdit::Keep)) && a.len() == b.len() {
        return Ok(0);
    }
    io.out_str(&format!("--- {left_name}\n+++ {right_name}\n"));
    // Hunks with three context lines around every changed span.
    let context = 3usize;
    let mut index = 0usize;
    while index < edits.len() {
        if matches!(edits[index].0, DiffEdit::Keep) {
            index += 1;
            continue;
        }
        let start = index.saturating_sub(context);
        let mut end = index;
        while end < edits.len() {
            let window = &edits[end..(end + context + 1).min(edits.len())];
            if window
                .iter()
                .all(|(edit, _)| matches!(edit, DiffEdit::Keep))
            {
                break;
            }
            end += 1;
        }
        let end = (end + context).min(edits.len());
        let mut a_line = 1usize;
        let mut b_line = 1usize;
        for (edit, _) in &edits[..start] {
            match edit {
                DiffEdit::Keep => {
                    a_line += 1;
                    b_line += 1;
                }
                DiffEdit::Remove => a_line += 1,
                DiffEdit::Add => b_line += 1,
            }
        }
        let a_count = edits[start..end]
            .iter()
            .filter(|(e, _)| !matches!(e, DiffEdit::Add))
            .count();
        let b_count = edits[start..end]
            .iter()
            .filter(|(e, _)| !matches!(e, DiffEdit::Remove))
            .count();
        io.out_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            a_line, a_count, b_line, b_count
        ));
        for (edit, line) in &edits[start..end] {
            match edit {
                DiffEdit::Keep => io.out_str(&format!(" {line}\n")),
                DiffEdit::Remove => io.out_str(&format!("-{line}\n")),
                DiffEdit::Add => io.out_str(&format!("+{line}\n")),
            }
        }
        index = end;
    }
    Ok(1)
}

/// Myers' greedy diff. The answer walks both files in order as (edit, line) pairs.
fn myers<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<(DiffEdit, &'a str)> {
    let n = a.len() as i64;
    let m = b.len() as i64;
    if n == 0 && m == 0 {
        return Vec::new();
    }
    let max = (n + m + 1) as usize;
    let offset = max as i64;
    let mut v = vec![0i64; 2 * max + 1];
    let mut trace: Vec<Vec<i64>> = Vec::new();
    let mut d_final = 0i64;
    'd: for d in 0..=max as i64 {
        trace.push(v.clone());
        let mut k = -d;
        while k <= d {
            let index = (k + offset) as usize;
            let mut x = if k == -d || (k != d && v[index - 1] < v[index + 1]) {
                v[index + 1]
            } else {
                v[index - 1] + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[index] = x;
            if x >= n && y >= m {
                d_final = d;
                break 'd;
            }
            // k walks the diagonals of one parity: -d, -d+2, …, d.
            k += 2;
        }
    }
    // Backtrack: keeps on the diagonals, one removal or addition per step.
    let mut edits: Vec<(DiffEdit, &str)> = Vec::new();
    let mut x = n;
    let mut y = m;
    for d in (0..=d_final).rev() {
        let v = &trace[d as usize];
        let k = x - y;
        let index = (k + offset) as usize;
        let prev_k = if k == -d || (k != d && v[index - 1] < v[index + 1]) {
            k + 1
        } else {
            k - 1
        };
        let prev_x = v[(prev_k + offset) as usize];
        let prev_y = prev_x - prev_k;
        while x > prev_x && y > prev_y {
            x -= 1;
            y -= 1;
            edits.push((DiffEdit::Keep, a[x as usize]));
        }
        if d > 0 {
            if x > prev_x {
                x -= 1;
                edits.push((DiffEdit::Remove, a[x as usize]));
            } else {
                y -= 1;
                edits.push((DiffEdit::Add, b[y as usize]));
            }
        }
    }
    edits.reverse();
    edits
}

/// `tee` — write stdin to the files AND pass it on (the pipeline tap).
fn tee(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let append = args.iter().any(|arg| arg == "-a");
    let paths: Vec<String> = args
        .iter()
        .filter(|arg| !arg.starts_with('-'))
        .cloned()
        .collect();
    let mut io_mut = io.clone();
    let text = io_mut.read_all_stdin();
    for path in &paths {
        let resolved = shell.resolve_working_path(path);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true);
        if append {
            options.append(true);
        } else {
            options.truncate(true);
        }
        match options.open(&resolved) {
            Ok(mut file) => {
                use std::io::Write;
                let _ = file.write_all(text.as_bytes());
            }
            Err(error) => {
                io.err_str(&format!("tee: {path}: {error}\n"));
                return Ok(1);
            }
        }
    }
    io.out_str(&text);
    Ok(0)
}

/// `xargs` — read the argument lines, run the command over them. `-n N` batches,
/// `-0` NUL-separated input, `-I{}` substitutes, `-r` skips the empty run (GNU runs
/// the command once bare when the input is empty, and so does the shell).
fn xargs(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut batch = 0usize;
    let mut null_split = false;
    let mut no_run_if_empty = false;
    let mut placeholder: Option<String> = None;
    let mut rest: Vec<String> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "-n" {
            // The spaced form first: "-n" alone must not match the glued strip below
            // (its empty suffix used to swallow the flag and strand the count).
            if let Some(parsed) = args
                .get(index + 1)
                .and_then(|value| value.parse::<usize>().ok())
            {
                batch = parsed;
                index += 1;
            }
        } else if let Some(value) = arg.strip_prefix("-n") {
            if let Ok(parsed) = value.parse::<usize>() {
                batch = parsed;
            }
        } else if arg == "-0" {
            null_split = true;
        } else if arg == "-r" || arg == "--no-run-if-empty" {
            no_run_if_empty = true;
        } else if arg == "-I" {
            // The spaced form carries the placeholder as the next argument.
            index += 1;
            placeholder = Some(args.get(index).cloned().unwrap_or_else(|| "{}".to_owned()));
        } else if let Some(value) = arg.strip_prefix("-I") {
            placeholder = Some(value.to_owned());
        } else if arg != "--" {
            rest.push(arg.clone());
        }
        index += 1;
    }
    let mut io_mut = io.clone();
    let input = io_mut.read_all_stdin();
    let items: Vec<String> = if null_split {
        input
            .split('\0')
            .filter(|item| !item.is_empty())
            .map(str::to_owned)
            .collect()
    } else {
        input
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(str::to_owned)
            .collect()
    };
    let batch = if batch == 0 {
        items.len().max(1)
    } else {
        batch
    };
    let command: Vec<String> = if rest.is_empty() {
        vec!["echo".to_owned()]
    } else {
        rest
    };
    let groups: Vec<&[String]> = if items.is_empty() {
        if no_run_if_empty {
            Vec::new()
        } else {
            vec![&items[..]]
        }
    } else {
        items.chunks(batch).collect()
    };
    let mut status = 0;
    for chunk in groups {
        let argv: Vec<String> = match &placeholder {
            Some(marker) => command
                .iter()
                .map(|piece| {
                    piece.replace(
                        marker.as_str(),
                        chunk.first().map(String::as_str).unwrap_or(""),
                    )
                })
                .collect(),
            None => {
                let mut argv = command.clone();
                argv.extend(chunk.iter().cloned());
                argv
            }
        };
        let _ = shell.run_argv(&argv, io);
        if shell.status != 0 {
            status = shell.status;
        }
    }
    Ok(status)
}

/// `uname` answers in Git Bash's own dialect (`MINGW64_NT-…`), so scripts probing the
/// shell keep answering what they answer there.
fn uname(io: &Io, args: &[String]) -> ExecResult {
    let (flags, _) = parse_flags(args);
    let release = "10.0";
    let machine = "x86_64";
    let sysname = if cfg!(windows) {
        format!("MINGW64_NT-{release}")
    } else {
        "Linux".to_owned()
    };
    if flags.contains('a') {
        io.out_str(&format!("{sysname} {machine} MINGW64\n"));
    } else if flags.contains('r') {
        io.out_str(&format!("{release}\n"));
    } else if flags.contains('m') {
        io.out_str(&format!("{machine}\n"));
    } else if flags.contains('o') {
        io.out_str("MINGW64\n");
    } else {
        io.out_str(&format!("{sysname}\n"));
    }
    Ok(0)
}

/// `cygpath` — translate between the dialects: default `-u` (MSYS), `-w` Windows,
/// `-m` mixed (drive + forward slashes).
fn cygpath(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let to_windows = args.iter().any(|arg| arg == "-w");
    let to_mixed = args.iter().any(|arg| arg == "-m");
    let paths: Vec<String> = args
        .iter()
        .filter(|arg| !arg.starts_with('-'))
        .cloned()
        .collect();
    if paths.is_empty() {
        io.err_str("cygpath: a path is required\n");
        return Ok(1);
    }
    for path in &paths {
        // Absolute in its own dialect translates as text — `/c/...` becomes `C:/...`
        // whose absolute-ness a POSIX `Path` cannot see; only a relative operand
        // anchors to the shell's cwd.
        let absolute = path.starts_with('/')
            || (path.len() > 1
                && path.as_bytes()[1] == b':'
                && path.as_bytes()[0].is_ascii_alphabetic());
        let native = super::msys::from_msys(path);
        let native = if absolute {
            std::path::PathBuf::from(native)
        } else {
            shell.resolve_working_path(&native)
        };
        let answer = if to_windows {
            // -w speaks with backslashes (Git Bash's own output shape).
            native.display().to_string().replace('/', "\\")
        } else if to_mixed {
            native.display().to_string().replace('\\', "/")
        } else {
            super::msys::to_msys(&native)
        };
        io.out_str(&format!("{answer}\n"));
    }
    Ok(0)
}

/// `readlink -f` answers the resolved MSYS path; bare `readlink` a symlink target.
fn readlink(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let canonical = args.iter().any(|arg| arg == "-f" || arg == "-e");
    let paths: Vec<String> = args
        .iter()
        .filter(|arg| !arg.starts_with('-'))
        .cloned()
        .collect();
    if paths.is_empty() {
        io.err_str("readlink: a path is required\n");
        return Ok(1);
    }
    for path in &paths {
        let resolved = shell.resolve_working_path(&super::msys::from_msys(path));
        if canonical {
            match std::fs::canonicalize(&resolved) {
                Ok(real) => io.out_str(&format!("{}\n", super::msys::to_msys(&real))),
                Err(error) => {
                    io.err_str(&format!("readlink: {path}: {error}\n"));
                    return Ok(1);
                }
            }
        } else {
            match std::fs::read_link(&resolved) {
                Ok(target) => io.out_str(&format!("{}\n", target.display())),
                Err(error) => {
                    io.err_str(&format!("readlink: {path}: {error}\n"));
                    return Ok(1);
                }
            }
        }
    }
    Ok(0)
}

/// `md5sum` / `sha1sum` / `sha256sum`, with `-c` to verify a checksum listing.
fn checksum(shell: &mut Shell, io: &Io, name: &str, args: &[String]) -> ExecResult {
    let digest = |data: &[u8]| -> String {
        match name {
            "md5sum" => super::hashes::md5(data),
            "sha1sum" => super::hashes::sha1(data),
            _ => super::hashes::sha256(data),
        }
    };
    if args.iter().any(|arg| arg == "-c" || arg == "--check") {
        let list: Vec<String> = args
            .iter()
            .filter(|arg| !arg.starts_with('-'))
            .cloned()
            .collect();
        let mut status = 0;
        let entries: Vec<(String, String)> = if list.is_empty() {
            let mut io_mut = io.clone();
            io_mut
                .read_all_stdin()
                .lines()
                .filter_map(|line| {
                    line.split_once("  ")
                        .map(|(hash, path)| (hash.to_owned(), path.trim().to_owned()))
                })
                .collect()
        } else {
            let mut entries = Vec::new();
            for path in &list {
                match std::fs::read_to_string(shell.resolve_working_path(path)) {
                    Ok(text) => entries.extend(text.lines().filter_map(|line| {
                        line.split_once("  ")
                            .map(|(hash, path)| (hash.to_owned(), path.trim().to_owned()))
                    })),
                    Err(error) => {
                        io.err_str(&format!("{name}: {path}: {error}\n"));
                        status = 1;
                    }
                }
            }
            entries
        };
        for (expected, path) in entries {
            let resolved = shell.resolve_working_path(&path);
            match std::fs::read(&resolved) {
                Ok(data) => {
                    let actual = digest(&data);
                    if actual == expected {
                        io.out_str(&format!("{path}: OK\n"));
                    } else {
                        io.out_str(&format!("{path}: FAILED\n"));
                        status = 1;
                    }
                }
                Err(_) => {
                    io.out_str(&format!("{path}: FAILED open or read\n"));
                    status = 1;
                }
            }
        }
        return Ok(status);
    }
    let paths: Vec<String> = args
        .iter()
        .filter(|arg| !arg.starts_with('-'))
        .cloned()
        .collect();
    if paths.is_empty() {
        let mut io_mut = io.clone();
        let data = io_mut.read_all_stdin().into_bytes();
        io.out_str(&format!("{}  -\n", digest(&data)));
        return Ok(0);
    }
    let mut status = 0;
    for path in &paths {
        let resolved = shell.resolve_working_path(path);
        match std::fs::read(&resolved) {
            Ok(data) => io.out_str(&format!("{}  {path}\n", digest(&data))),
            Err(error) => {
                io.err_str(&format!("{name}: {path}: {error}\n"));
                status = 1;
            }
        }
    }
    Ok(status)
}

/// `base64` — encode, `-d` decode, `-w 0` unlimited width (the default wraps at 76).
fn base64_applet(io: &Io, args: &[String]) -> ExecResult {
    let decode = args.iter().any(|arg| arg == "-d" || arg == "--decode");
    let wrap = match args.iter().position(|arg| arg == "-w") {
        Some(at) => args
            .get(at + 1)
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0),
        None => match args.iter().find_map(|arg| arg.strip_prefix("-w")) {
            Some(value) => value.parse::<usize>().ok().unwrap_or(0),
            None => 76,
        },
    };
    let mut io_mut = io.clone();
    let input = io_mut.read_all_stdin();
    if decode {
        match base64_decode(input.trim_matches(['\n', '\r', ' '])) {
            Ok(bytes) => io.write_out(&bytes),
            Err(error) => {
                io.err_str(&format!("base64: {error}\n"));
                return Ok(1);
            }
        }
        return Ok(0);
    }
    let encoded = base64_encode(input.as_bytes());
    if wrap == 0 {
        io.out_str(&encoded);
    } else {
        for chunk in encoded.as_bytes().chunks(wrap.max(1)) {
            io.out_str(&String::from_utf8_lossy(chunk));
            io.out_str("\n");
        }
    }
    Ok(0)
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let bytes = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let triple = ((bytes[0] as u32) << 16) | ((bytes[1] as u32) << 8) | bytes[2] as u32;
        out.push(B64[(triple >> 18) as usize & 63] as char);
        out.push(B64[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(triple >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[triple as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for c in text.chars() {
        if c == '=' || c == '\n' || c == '\r' {
            continue;
        }
        let value = B64
            .iter()
            .position(|byte| *byte as char == c)
            .ok_or_else(|| format!("invalid character {c:?}"))? as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Ok(out)
}

/// `du -sh path…` — the recursive size, `-s` summary only, `-h` human units.
fn du(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let human = args
        .iter()
        .any(|arg| arg.starts_with('-') && !arg.starts_with("--") && arg[1..].contains('h'));
    let summary = args
        .iter()
        .any(|arg| arg.starts_with('-') && !arg.starts_with("--") && arg[1..].contains('s'));
    let paths: Vec<String> = args
        .iter()
        .filter(|arg| !arg.starts_with('-'))
        .cloned()
        .collect();
    let targets: Vec<String> = if paths.is_empty() {
        vec![".".to_owned()]
    } else {
        paths
    };
    for target in &targets {
        let resolved = shell.resolve_working_path(&super::msys::from_msys(target));
        if summary {
            io.out_str(&format!(
                "{}\t{}\n",
                human_size(dir_size(&resolved), human),
                super::msys::to_msys(&resolved)
            ));
        } else {
            walk_du(io, &resolved, human);
        }
    }
    Ok(0)
}

fn dir_size(path: &std::path::Path) -> u64 {
    if path.is_file() {
        return std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries.flatten().map(|entry| dir_size(&entry.path())).sum()
}

fn walk_du(io: &Io, current: &std::path::Path, human: bool) {
    if current.is_dir() {
        io.out_str(&format!(
            "{}\t{}\n",
            human_size(dir_size(current), human),
            super::msys::to_msys(current)
        ));
        let Ok(entries) = std::fs::read_dir(current) else {
            return;
        };
        for entry in entries.flatten() {
            walk_du(io, &entry.path(), human);
        }
    }
}

fn human_size(bytes: u64, human: bool) -> String {
    if !human {
        return bytes.to_string();
    }
    let units = ["B", "K", "M", "G", "T"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{value:.0}{}", units[unit])
    } else {
        format!("{value:.1}{}", units[unit])
    }
}

/// `ln -s target link` — a real symlink when the OS grants it.
fn ln(shell: &Shell, io: &Io, args: &[String]) -> ExecResult {
    let symbolic = args.iter().any(|arg| arg == "-s");
    let paths: Vec<String> = args
        .iter()
        .filter(|arg| !arg.starts_with('-'))
        .cloned()
        .collect();
    if !symbolic || paths.len() != 2 {
        io.err_str("ln: -s target link is the supported form\n");
        return Ok(1);
    }
    // Both operands live in the shell's cwd, not the process's.
    let target = shell.resolve_working_path(&paths[0]);
    let link = shell.resolve_working_path(&paths[1]);
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(&target, &link);
    #[cfg(windows)]
    let result = if target.is_dir() {
        std::os::windows::fs::symlink_dir(&target, &link)
    } else {
        std::os::windows::fs::symlink_file(&target, &link)
    };
    match result {
        Ok(()) => Ok(0),
        Err(error) => {
            io.err_str(&format!(
                "ln: {}: {error} (Windows needs Developer Mode or privileges for symlinks)\n",
                link.display()
            ));
            Ok(1)
        }
    }
}

/// `chmod MODE FILE…` — NTFS carries no execute bit; the Git Bash-shaped success
/// (Claude's `chmod +x` before running a script must not fail). The first operand is
/// the mode word (`+x`, `755`, `a-w`), never a file; the rest must exist.
fn chmod(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let _ = io;
    let mut operands = args.iter().filter(|arg| !arg.starts_with('-'));
    let _mode = operands.next();
    for arg in operands {
        if !shell.resolve_working_path(arg).exists() {
            return Ok(1);
        }
    }
    Ok(0)
}

/// `timeout N cmd…` — run under a clock; 124 on expiry (GNU's own code). The child is
/// spawned through [`spawn_with_io`], so the pipeline's pipe (or a redirection's file)
/// reaches it — the inherit() wiring starved `cmd | timeout 5 awk …` of its stdin.
fn timeout(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut duration: Option<String> = None;
    let mut rest: Vec<String> = Vec::new();
    for arg in args {
        if duration.is_none()
            && rest.is_empty()
            && !arg.starts_with('-')
            && arg
                .chars()
                .next()
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
        {
            duration = Some(arg.clone());
            continue;
        }
        rest.push(arg.clone());
    }
    let Some(duration) = duration else {
        io.err_str("timeout: a duration is required\n");
        return Ok(2);
    };
    let Ok(secs) = duration.parse::<f64>() else {
        io.err_str("timeout: bad duration\n");
        return Ok(2);
    };
    if rest.is_empty() {
        io.err_str("timeout: a command is required\n");
        return Ok(2);
    }
    let resolved =
        resolve_on_path(&rest[0], &shell.path_var()).unwrap_or_else(|| PathBuf::from(&rest[0]));
    let program = anchor_program(&resolved, &shell.cwd);
    let mut spawned =
        match spawn_with_io(&program, &rest[1..], &shell.cwd, &shell.child_env(&[]), io) {
            Ok(spawned) => spawned,
            Err(error) => {
                io.err_str(&format!("timeout: {}: {error}\n", rest[0]));
                return Ok(127);
            }
        };
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis((secs * 1000.0) as u64);
    loop {
        match spawned.child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = spawned.child.kill();
                    // Drain the pumps even on the kill — a pipe writer waiting on them
                    // would otherwise hang past the child's death — but at most 2 s:
                    // a grandchild holding the pipes must not outlive the deadline.
                    let _ = spawned.finish_within(std::time::Duration::from_secs(2));
                    return Ok(124);
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(error) => {
                io.err_str(&format!("timeout: {error}\n"));
                return Ok(1);
            }
        }
    }
    match spawned.finish() {
        Ok(code) => Ok(code),
        Err(error) => {
            io.err_str(&format!("timeout: {error}\n"));
            Ok(1)
        }
    }
}

#[cfg(test)]
mod diff_debug_tests {
    use super::{myers, DiffEdit};

    #[test]
    fn myers_orders_keeps_and_changes() {
        let a = vec!["a", "b"];
        let b = vec!["a", "c"];
        let edits = myers(&a, &b);
        let labels: Vec<&str> = edits
            .iter()
            .map(|(edit, _)| match edit {
                DiffEdit::Keep => "K",
                DiffEdit::Remove => "R",
                DiffEdit::Add => "A",
            })
            .collect();
        assert_eq!(
            labels,
            vec!["K", "R", "A"],
            "lines: {:?}",
            edits.iter().map(|(_, l)| l).collect::<Vec<_>>()
        );
        let edits = myers(&["a"], &["a", "b"]);
        let labels: Vec<&str> = edits
            .iter()
            .map(|(e, _)| match e {
                DiffEdit::Keep => "K",
                DiffEdit::Remove => "R",
                DiffEdit::Add => "A",
            })
            .collect();
        assert_eq!(labels, vec!["K", "A"]);
        let edits = myers(&["a", "b"], &["a"]);
        let labels: Vec<&str> = edits
            .iter()
            .map(|(e, _)| match e {
                DiffEdit::Keep => "K",
                DiffEdit::Remove => "R",
                DiffEdit::Add => "A",
            })
            .collect();
        assert_eq!(labels, vec!["K", "R"]);
        assert!(myers(&["x"], &["x"])
            .iter()
            .all(|(e, _)| matches!(e, DiffEdit::Keep)));
    }
}
