//! The applets — the POSIX line tools the shell carries built in, busybox-style. On a
//! clean Windows machine `grep`/`sed`/`find` do not exist (or exist as the wrong tools —
//! `find.exe` prompts for search strings), so the shell ships its own: the curated
//! applet list wins over `PATH` (predictable POSIX behaviour for scripts and AI-driven
//! commands), and anything not on the list goes to the filesystem. Each applet reads
//! files or the pipeline's stdin and writes through the [`Io`] it was given.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::builtins::unescape;
use super::exec::{anchor_program, resolve_on_path, spawn_with_io, ExecResult, Io, Shell};
use super::glob;
use super::localtime::{local_now, local_offset_seconds, now_unix, unix_to_local, Civil};
use super::regexlite::Regex;

pub const APPLET_NAMES: &[&str] = &[
    "ls",
    "cat",
    "grep",
    "egrep",
    "fgrep",
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
    "printenv",
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
    "cmp",
    "tee",
    "xargs",
    "uname",
    "whoami",
    "hostname",
    "cygpath",
    "md5sum",
    "sha1sum",
    "sha224sum",
    "sha256sum",
    "sha384sum",
    "sha512sum",
    "b2sum",
    "cksum",
    "sum",
    "base32",
    "base64",
    "du",
    "df",
    "free",
    "ps",
    "mount",
    "umount",
    "id",
    "groups",
    "logname",
    "tty",
    "nproc",
    "arch",
    "start",
    "ln",
    "link",
    "unlink",
    "chmod",
    "chown",
    "chgrp",
    "stat",
    "file",
    "timeout",
    "truncate",
    "mktemp",
    "shred",
    "install",
    "sync",
    "dd",
    "tar",
    "unzip",
    "gzip",
    "gunzip",
    "zcat",
    "uncompress",
    "less",
    "more",
    "nl",
    "tac",
    "od",
    "xxd",
    "split",
    "paste",
    "join",
    "comm",
    "column",
    "fold",
    "expand",
    "unexpand",
    "tsort",
    "expr",
    "factor",
    "numfmt",
    "shuf",
    "yes",
    "iconv",
    "dos2unix",
    "d2u",
    "unix2dos",
    "u2d",
    "unix2mac",
    "mac2unix",
    "dircolors",
    "nohup",
    "nice",
    "stdbuf",
    "tput",
    "stty",
    "reset",
    "tset",
    "dir",
    "vdir",
];

pub fn is_applet(name: &str) -> bool {
    APPLET_NAMES.contains(&name)
}

/// [`parse_flags`] with digits allowed in the cluster — `ls -1`'s letter list
/// carries a digit GNU treats as a flag.
fn parse_flags_alnum(args: &[String]) -> (String, Vec<String>) {
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
            if !body.is_empty() && body.chars().all(|c| c.is_ascii_alphanumeric()) {
                flags.push_str(body);
                continue;
            }
        }
        rest.push(arg.clone());
    }
    (flags, rest)
}

pub fn run_applet(shell: &mut Shell, io: &Io, name: &str, args: &[String]) -> Option<ExecResult> {
    let result = match name {
        "ls" => ls(shell, io, args),
        "dir" => {
            let mut argv = vec!["-C".to_owned()];
            argv.extend_from_slice(args);
            ls(shell, io, &argv)
        }
        "vdir" => {
            let mut argv = vec!["-l".to_owned()];
            argv.extend_from_slice(args);
            ls(shell, io, &argv)
        }
        "cat" => cat(shell, io, args),
        "less" | "more" => pager(shell, io, args),
        "grep" => grep(shell, io, args),
        "egrep" => {
            let mut argv = vec!["-E".to_owned()];
            argv.extend_from_slice(args);
            grep(shell, io, &argv)
        }
        "fgrep" => {
            let mut argv = vec!["-F".to_owned()];
            argv.extend_from_slice(args);
            grep(shell, io, &argv)
        }
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
        "printenv" => printenv(shell, io, args),
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
        "reset" | "tset" => {
            if !matches!(io.stdin, super::exec::Source::Inherit)
                || !super::sysinfo::stdin_is_terminal()
            {
                io.err_str("reset: terminal attributes: No such device or address\n");
                Ok(1)
            } else {
                // The terminal's own reset: primary DA, then clear.
                io.out_str("\x1bc\x1b[2J\x1b[H\x1b[?25h");
                Ok(0)
            }
        }
        "awk" => super::awk::run_awk(shell, io, args),
        "diff" => diff(shell, io, args),
        "cmp" => cmp(shell, io, args),
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
        "sha224sum" | "sha384sum" | "sha512sum" | "b2sum" => checksum(shell, io, name, args),
        "cksum" => cksum_applet(shell, io, args),
        "sum" => sum_applet(shell, io, args),
        "base32" => base32_applet(shell, io, args),
        "base64" => base64_applet(shell, io, args),
        "du" => du(shell, io, args),
        "df" => super::sysinfo::df(shell, io, args),
        "free" => super::sysinfo::free(io, args),
        "ps" => super::sysinfo::ps(io, args),
        "mount" => super::sysinfo::mount(io, args),
        "umount" => super::sysinfo::umount(io, args),
        "id" => super::sysinfo::id(io, args),
        "groups" => super::sysinfo::groups(io),
        "logname" => super::sysinfo::logname(io),
        "tty" => super::sysinfo::tty(io),
        "nproc" => super::sysinfo::nproc(io),
        "arch" => super::sysinfo::arch(io),
        "start" => super::sysinfo::start(shell, io, args),
        "ln" => ln(shell, io, args),
        "link" => link_applet(shell, io, args),
        "unlink" => unlink_applet(shell, io, args),
        "chmod" => chmod(shell, io, args),
        "chown" | "chgrp" => {
            // GNU validates the owner/group BEFORE touching the file — and this
            // side of the bridge has no user database to name one.
            let owner = args
                .iter()
                .find(|arg| !arg.starts_with('-'))
                .map(String::as_str)
                .unwrap_or("");
            if name == "chgrp" || owner.starts_with(':') {
                io.err_str(&format!("chown: invalid group: \u{2018}{owner}\u{2019}\n"));
            } else {
                io.err_str(&format!("chown: invalid user: \u{2018}{owner}\u{2019}\n"));
            }
            Ok(1)
        }
        "stat" => stat(shell, io, args),
        "file" => file(shell, io, args),
        "timeout" => timeout(shell, io, args),
        "truncate" => truncate(shell, io, args),
        "mktemp" => mktemp(shell, io, args),
        "shred" => shred(shell, io, args),
        "install" => install(shell, io, args),
        "sync" => Ok(0),
        "dd" => dd(shell, io, args),
        "tar" => super::archive::run_tar(shell, io, args),
        "unzip" => super::archive::run_unzip(shell, io, args),
        "gzip" | "gunzip" => super::archive::run_gzip(shell, io, name, args),
        "zcat" | "uncompress" => zcat(shell, io, name, args),
        "nl" => nl(shell, io, args),
        "tac" => tac(shell, io, args),
        "od" => od(shell, io, args),
        "xxd" => xxd(shell, io, args),
        "split" => split_applet(shell, io, args),
        "paste" => paste(shell, io, args),
        "join" => join(shell, io, args),
        "comm" => comm(shell, io, args),
        "column" => column(shell, io, args),
        "fold" => fold(shell, io, args),
        "expand" => expand_applet(shell, io, args, false),
        "unexpand" => expand_applet(shell, io, args, true),
        "tsort" => tsort(shell, io, args),
        "expr" => expr(shell, io, args),
        "factor" => factor(shell, io, args),
        "numfmt" => numfmt(shell, io, args),
        "shuf" => shuf(io, args),
        "yes" => yes(io, args),
        "iconv" => iconv(shell, io, args),
        "dos2unix" | "d2u" => line_endings(shell, io, args, LineEndings::ToUnix),
        "unix2dos" | "u2d" => line_endings(shell, io, args, LineEndings::ToDos),
        "unix2mac" => line_endings(shell, io, args, LineEndings::ToMac),
        "mac2unix" => line_endings(shell, io, args, LineEndings::MacToUnix),
        "dircolors" => dircolors(io, args),
        "nohup" => nohup(shell, io, args),
        "nice" => nice(shell, io, args),
        "stdbuf" => stdbuf(shell, io, args),
        "tput" => tput(io, args),
        "stty" => stty(io, args),
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

/// Resolve paths the way the shell resolves every path: the MSYS dialect
/// (`/d/`, `/tmp/...`) crosses to Windows, relatives land in the shell's cwd.
/// Before this went through `resolve_working_path` the applets joined the
/// operand text itself, and `ls -la /d/` handed Windows a literal `/d/` —
/// root-relative on the CURRENT drive, "file not found" on a machine that owns
/// a perfectly good D:.
fn resolve_paths(shell: &Shell, paths: &[String]) -> Vec<PathBuf> {
    paths
        .iter()
        .map(|p| shell.resolve_working_path(p))
        .collect()
}

/// The POSIX wording Git Bash's coreutils print for the common IO errors. The
/// raw Windows message (`系统找不到指定的文件。 (os error 2)`) is a locale
/// artifact a bash session never sees.
fn io_error_text(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => "No such file or directory".to_owned(),
        std::io::ErrorKind::PermissionDenied => "Permission denied".to_owned(),
        std::io::ErrorKind::AlreadyExists => "File exists".to_owned(),
        std::io::ErrorKind::DirectoryNotEmpty => "Directory not empty".to_owned(),
        std::io::ErrorKind::NotADirectory => "Not a directory".to_owned(),
        std::io::ErrorKind::IsADirectory => "Is a directory".to_owned(),
        _ => error.to_string(),
    }
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
    // GNU tools report and label with the operand as typed (`cat: /d/x: …`),
    // never the resolved Windows path.
    for (operand, resolved) in paths.iter().zip(resolve_paths(shell, paths)) {
        let text = std::fs::read_to_string(&resolved)
            .map_err(|e| format!("{operand}: {}", io_error_text(&e)))?;
        out.push((operand.clone(), text));
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

/// One listed entry: the display name (bare inside a directory listing, the
/// operand as typed for direct operands — GNU's own rule) and its metadata.
struct LsEntry {
    name: String,
    metadata: std::fs::Metadata,
}

fn ls(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    // `-w N` / `--width=N` sets the -C line width ahead of the flag letters.
    let mut width_override: Option<usize> = None;
    let mut rest: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "-w" || arg == "--width" {
            if let Some(value) = iter.next() {
                width_override = value.parse().ok();
                continue;
            }
        }
        if let Some(value) = arg
            .strip_prefix("--width=")
            .or_else(|| arg.strip_prefix("-w"))
            .filter(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()))
        {
            width_override = value.parse().ok();
            continue;
        }
        rest.push(arg.clone());
    }
    let args: &[String] = &rest;
    let (flags, paths) = parse_flags_alnum(args);
    let all = flags.contains('a');
    let almost_all = flags.contains('A');
    let long = flags.contains('l');
    let by_time = flags.contains('t');
    let reverse = flags.contains('r');
    let directory_itself = flags.contains('d');
    let classify = flags.contains('F');
    let force_columns = flags.contains('C');
    let force_single = flags.contains('1');
    let tty = matches!(io.stdout, super::exec::Sink::Inherit) && stdout_is_console();
    let targets: Vec<String> = if paths.is_empty() {
        vec![".".to_owned()]
    } else {
        paths
    };

    // GNU's order: the operands are sorted like directory entries (the files
    // print first, then every directory with an `operand:` header); a miss is
    // an error line, not a listing.
    let mut status = 0;
    let mut file_ops: Vec<(String, std::fs::Metadata)> = Vec::new();
    let mut dir_ops: Vec<(String, PathBuf, std::fs::Metadata)> = Vec::new();
    for target in &targets {
        let resolved = shell.resolve_working_path(target);
        match std::fs::symlink_metadata(&resolved) {
            Ok(metadata) if metadata.is_dir() && !directory_itself => {
                dir_ops.push((target.clone(), resolved, metadata));
            }
            Ok(metadata) => file_ops.push((target.clone(), metadata)),
            Err(error) => {
                io.err_str(&format!(
                    "ls: cannot access '{target}': {}\n",
                    io_error_text(&error)
                ));
                status = 2;
            }
        }
    }
    let operand_order = |entries: &mut Vec<(String, std::fs::Metadata)>| {
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        if by_time {
            entries.sort_by_key(|b| std::cmp::Reverse(mtime_of(&b.1)));
        }
        if reverse {
            entries.reverse();
        }
    };
    operand_order(&mut file_ops);
    let mut dir_order: Vec<usize> = (0..dir_ops.len()).collect();
    dir_order.sort_by(|&a, &b| dir_ops[a].0.cmp(&dir_ops[b].0));
    if by_time {
        dir_order.sort_by(|&a, &b| mtime_of(&dir_ops[b].2).cmp(&mtime_of(&dir_ops[a].2)));
    }
    if reverse {
        dir_order.reverse();
    }
    let dir_ops: Vec<(String, PathBuf)> = dir_order
        .into_iter()
        .map(|index| (dir_ops[index].0.clone(), dir_ops[index].1.clone()))
        .collect();

    let columns = force_columns || (tty && !force_single && !long);
    let had_file_ops = !file_ops.is_empty();
    if had_file_ops {
        let entries: Vec<LsEntry> = file_ops
            .into_iter()
            .map(|(name, metadata)| LsEntry { name, metadata })
            .collect();
        if long {
            print_ls_rows(io, &entries, classify, tty);
        } else if columns && dir_ops.is_empty() {
            print_ls_columns(io, &entries, classify, tty, width_override);
        } else {
            print_ls_lines(io, &entries, classify, tty);
        }
    }

    let multiple = targets.len() > 1;
    for (index, (operand, path)) in dir_ops.iter().enumerate() {
        if multiple && (index > 0 || had_file_ops) {
            io.out_str("\n");
        }
        if multiple {
            io.out_str(&format!("{operand}:\n"));
        }
        let mut names: Vec<String> = match std::fs::read_dir(path) {
            Ok(entries) => entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| all || almost_all || !name.starts_with('.'))
                .collect(),
            Err(error) => {
                io.err_str(&format!(
                    "ls: cannot open directory '{operand}': {}\n",
                    io_error_text(&error)
                ));
                status = 2;
                continue;
            }
        };
        if all {
            names.push("..".to_owned());
            names.push(".".to_owned());
        }
        // Git Bash's C-locale order: byte-wise — a case fold would put `a.txt`
        // before `B.txt`, which a bash listing never does.
        names.sort();
        if by_time {
            // Newest first; the stable sort keeps the name order for equal times.
            names.sort_by_key(|b| std::cmp::Reverse(mtime_secs(&path.join(b))));
        }
        if reverse {
            names.reverse();
        }
        let entries: Vec<LsEntry> = names
            .iter()
            .filter_map(|name| {
                std::fs::symlink_metadata(path.join(name))
                    .ok()
                    .map(|metadata| LsEntry {
                        name: name.clone(),
                        metadata,
                    })
            })
            .collect();
        if long {
            let total: u64 = entries.iter().map(|entry| ls_blocks(&entry.metadata)).sum();
            io.out_str(&format!("total {total}\n"));
            print_ls_rows(io, &entries, classify, tty);
        } else if columns {
            print_ls_columns(io, &entries, classify, tty, width_override);
        } else {
            print_ls_lines(io, &entries, classify, tty);
        }
    }
    Ok(status)
}

fn print_ls_lines(io: &Io, entries: &[LsEntry], classify: bool, tty: bool) {
    for entry in entries {
        let plain = ls_plain_name(entry, classify);
        let shown = if tty { ls_color(&plain, entry) } else { plain };
        io.out_str(&format!("{shown}\n"));
    }
}

/// The `-l` row: `mode nlink user group size date name` with the middle columns
/// padded to this listing's own maxima — owner and group left-aligned, the size
/// right-aligned — exactly the shape GNU coreutils prints.
fn print_ls_rows(io: &Io, entries: &[LsEntry], classify: bool, tty: bool) {
    if entries.is_empty() {
        return;
    }
    let user = ls_user_name();
    let group = MSYS_GID.to_string();
    let size_width = entries
        .iter()
        .map(|entry| ls_size(entry).to_string().len())
        .max()
        .unwrap_or(1);
    for entry in entries {
        let plain = ls_plain_name(entry, classify);
        let shown = if tty { ls_color(&plain, entry) } else { plain };
        io.out_str(&format!(
            "{} 1 {:<uw$} {:<gw$} {:>sw$} {} {}\n",
            ls_mode(entry),
            user,
            group,
            ls_size(entry),
            ls_time(&entry.metadata),
            shown,
            uw = user.len(),
            gw = group.len(),
            sw = size_width,
        ));
    }
}

/// The multi-column listing on a terminal: GNU coreutils' own column planner
/// (`calculate_columns` in ls.c) with its tab-preferring indent, so the fill
/// order, the widths and the exact spacing match `ls -C` byte for byte.
/// `width` is `-w N`'s override; without it a console answers its own width and
/// a pipe the 80-column default.
fn print_ls_columns(io: &Io, entries: &[LsEntry], classify: bool, tty: bool, width: Option<usize>) {
    if entries.is_empty() {
        return;
    }
    let shown: Vec<(String, usize)> = entries
        .iter()
        .map(|entry| {
            let plain = ls_plain_name(entry, classify);
            let width = display_width(&plain);
            let shown = if tty { ls_color(&plain, entry) } else { plain };
            (shown, width)
        })
        .collect();
    let widths: Vec<usize> = shown.iter().map(|(_, width)| *width).collect();
    let line_length = width.or_else(terminal_columns).unwrap_or(80);
    let col_arr = gnu_column_widths(&widths, line_length);
    let cols = col_arr.len();
    let rows = entries.len().div_ceil(cols);
    let mut out = String::new();
    for row in 0..rows {
        let mut filesno = row;
        let mut col = 0;
        let mut pos = 0;
        loop {
            let (name, width) = &shown[filesno];
            out.push_str(name);
            let max_len = col_arr[col];
            col += 1;
            filesno += rows;
            if filesno >= entries.len() {
                break;
            }
            gnu_indent(&mut out, pos + width, pos + max_len);
            pos += max_len;
        }
        out.push('\n');
    }
    io.out_str(&out);
}

/// GNU ls' column planner, verbatim semantics: every candidate column count
/// starts pre-seeded at the 3-wide minimum (name + the 2-space gap) with its
/// running length at `3 × columns`, the last column carries no gap, a candidate
/// stays valid only while its running length stays under the line length, and
/// the widest still-valid candidate wins. Returns the per-column widths.
fn gnu_column_widths(widths: &[usize], line_length: usize) -> Vec<usize> {
    let n = widths.len();
    if n == 0 {
        return Vec::new();
    }
    const MIN_COLUMN_WIDTH: usize = 3;
    let max_idx =
        line_length / MIN_COLUMN_WIDTH + usize::from(!line_length.is_multiple_of(MIN_COLUMN_WIDTH));
    let max_cols = max_idx.min(n).max(1);
    let mut col_arr: Vec<Vec<usize>> = (1..=max_cols)
        .map(|cols| vec![MIN_COLUMN_WIDTH; cols])
        .collect();
    let mut line_len: Vec<usize> = (1..=max_cols).map(|cols| cols * MIN_COLUMN_WIDTH).collect();
    let mut valid: Vec<bool> = vec![true; max_cols];
    for (filesno, &width) in widths.iter().enumerate() {
        for ci in 0..max_cols {
            if !valid[ci] {
                continue;
            }
            // Column-major: this file lands in column `filesno / rows`; the
            // gap is GNU's two spaces, the last column carries none.
            let rows = (n + ci) / (ci + 1);
            let idx = filesno / rows;
            let real = width + if idx == ci { 0 } else { 2 };
            if col_arr[ci][idx] < real {
                line_len[ci] += real - col_arr[ci][idx];
                col_arr[ci][idx] = real;
                valid[ci] = line_len[ci] < line_length;
            }
        }
    }
    let mut cols = max_cols;
    while cols > 1 && !valid[cols - 1] {
        cols -= 1;
    }
    col_arr[cols - 1].clone()
}

/// GNU ls' `indent`: pad towards the next column start, preferring a tab while
/// one lands within the target.
fn gnu_indent(out: &mut String, mut from: usize, to: usize) {
    const TABSIZE: usize = 8;
    while from < to {
        if to / TABSIZE > (from + 1) / TABSIZE {
            out.push('\t');
            from += TABSIZE - from % TABSIZE;
        } else {
            out.push(' ');
            from += 1;
        }
    }
}

/// MSYS maps the primary group (the RID-513 "None"/"Domain Users" group) to
/// gid `0x100000 + 513` and the user to her SID's RID plus the same offset; a
/// listing shows the owner by NAME and the group by NUMBER (its name never
/// resolves), the exact shape `ls -l` prints in Git Bash.
const MSYS_GID: u32 = 0x100000 + 513;

fn ls_user_name() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "user".to_owned())
}

fn ls_plain_name(entry: &LsEntry, classify: bool) -> String {
    let mut name = entry.name.clone();
    if classify {
        if entry.metadata.is_dir() {
            name.push('/');
        } else if ls_executable(entry) {
            name.push('*');
        }
    }
    name
}

fn ls_color(plain: &str, entry: &LsEntry) -> String {
    if entry.metadata.is_dir() {
        format!("\x1b[01;34m{plain}\x1b[0m")
    } else if ls_executable(entry) {
        format!("\x1b[01;32m{plain}\x1b[0m")
    } else {
        plain.to_owned()
    }
}

/// The Windows executable extensions MSYS marks with the execute bits — `.msi`
/// is data, not a program, and Git Bash neither greens it nor sets its `x`.
fn ls_executable(entry: &LsEntry) -> bool {
    !entry.metadata.is_dir()
        && entry
            .name
            .rsplit_once('.')
            .map(|(_, extension)| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "exe" | "com" | "bat" | "cmd"
                )
            })
            .unwrap_or(false)
}

fn ls_mode(entry: &LsEntry) -> &'static str {
    if entry.metadata.is_dir() {
        return "drwxr-xr-x";
    }
    match (
        ls_executable(entry),
        entry.metadata.permissions().readonly(),
    ) {
        (true, true) => "-r-xr-xr-x",
        (true, false) => "-rwxr-xr-x",
        (false, true) => "-r--r--r--",
        (false, false) => "-rw-r--r--",
    }
}

/// GNU's "recent" clock: a Gregorian half-year. Within it the date column
/// shows the time, beyond it the year.
const SIX_MONTHS: i64 = 31_556_952 / 2;

fn ls_time(metadata: &std::fs::Metadata) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let now = now_unix();
    let civil = unix_to_local(mtime);
    if mtime >= now - SIX_MONTHS {
        format!(
            "{} {:>2} {:02}:{:02}",
            MONTHS[(civil.month as usize - 1).min(11)],
            civil.day,
            civil.hour,
            civil.minute
        )
    } else {
        format!(
            "{} {:>2}  {}",
            MONTHS[(civil.month as usize - 1).min(11)],
            civil.day,
            civil.year
        )
    }
}

/// MSYS answers `st_size == 0` for a directory — its stream's allocation shows
/// up only in the block count.
fn ls_size(entry: &LsEntry) -> u64 {
    if entry.metadata.is_dir() {
        0
    } else {
        entry.metadata.len()
    }
}

/// The 1-K block count GNU's `total` line sums: a file's allocated size (a
/// resident small file one block, a non-resident one its cluster-padded size),
/// a directory its stream's allocation — the numbers MSYS stat reports and std
/// can only reconstruct.
fn ls_blocks(metadata: &std::fs::Metadata) -> u64 {
    if metadata.is_dir() {
        return metadata.len() / 1024;
    }
    let size = metadata.len();
    if size == 0 {
        0
    } else if size <= 1024 {
        1
    } else {
        size.div_ceil(4096) * 4
    }
}

fn mtime_secs(path: &Path) -> u64 {
    std::fs::symlink_metadata(path)
        .map(|metadata| mtime_of(&metadata))
        .unwrap_or(0)
}

fn mtime_of(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The visible width of a listing cell — wide glyphs count two columns.
fn display_width(text: &str) -> usize {
    text.chars().map(super::lineedit::char_width).sum()
}

/// The console's width for the column listing; anything but a real console
/// (a pipe, a capture) answers none and the caller falls back to 80. The
/// dimension pair itself serves `tput`/`stty size` through sysinfo.
#[cfg(windows)]
pub(crate) fn terminal_dimensions() -> Option<(usize, usize)> {
    #[repr(C)]
    struct Coord {
        x: i16,
        y: i16,
    }
    #[repr(C)]
    struct SmallRect {
        left: i16,
        top: i16,
        right: i16,
        bottom: i16,
    }
    #[repr(C)]
    struct ScreenBufferInfo {
        size: Coord,
        cursor: Coord,
        attributes: u16,
        window: SmallRect,
        maximum_size: Coord,
    }
    extern "system" {
        fn GetStdHandle(which: i32) -> *mut core::ffi::c_void;
        fn GetConsoleScreenBufferInfo(
            handle: *mut core::ffi::c_void,
            info: *mut ScreenBufferInfo,
        ) -> i32;
    }
    unsafe {
        let handle = GetStdHandle(-11); // STD_OUTPUT_HANDLE
        let mut info = std::mem::zeroed();
        if GetConsoleScreenBufferInfo(handle, &mut info) == 1 {
            let columns = (info.window.right - info.window.left + 1).max(1) as usize;
            let rows = (info.window.bottom - info.window.top + 1).max(1) as usize;
            Some((columns, rows))
        } else {
            None
        }
    }
}

/// The console's width alone — `ls -C`'s line budget.
#[cfg(windows)]
fn terminal_columns() -> Option<usize> {
    terminal_dimensions().map(|(columns, _)| columns)
}

#[cfg(not(windows))]
fn terminal_columns() -> Option<usize> {
    None
}

/// Is the process's own stdout a console — the real isatty question GNU ls
/// asks before coloring or columnating? The `Io` sink alone cannot answer it:
/// an inherited stdout may still be a pipe (`ggs-bash -c 'ls …' | head`).
#[cfg(windows)]
fn stdout_is_console() -> bool {
    extern "system" {
        fn GetStdHandle(which: i32) -> *mut core::ffi::c_void;
        fn GetConsoleMode(handle: *mut core::ffi::c_void, mode: *mut u32) -> i32;
    }
    unsafe {
        let handle = GetStdHandle(-11); // STD_OUTPUT_HANDLE
        let mut mode = 0u32;
        GetConsoleMode(handle, &mut mode) == 1
    }
}

#[cfg(not(windows))]
fn stdout_is_console() -> bool {
    extern "C" {
        fn isatty(fd: i32) -> i32;
    }
    unsafe { isatty(1) == 1 }
}

/* ---------- cat ---------- */

fn cat(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (flags, paths) = parse_flags(args);
    let number = flags.contains('n');
    let mut status = 0;
    let mut stdin_used = false;
    let mut io_mut = io.clone();
    let emit = |io: &Io, text: &str| {
        if !number {
            io.out_str(text);
            return;
        }
        for (index, line) in lines_of(text).iter().enumerate() {
            io.out_str(&format!("{:>6}  {line}\n", index + 1));
        }
    };
    if paths.is_empty() {
        emit(io, &io_mut.read_all_stdin());
        return Ok(0);
    }
    for operand in &paths {
        // `-` is stdin, GNU's own convention (`cat -`).
        let content = if operand == "-" {
            if stdin_used {
                continue;
            }
            stdin_used = true;
            io_mut.read_all_stdin()
        } else {
            match std::fs::read(shell.resolve_working_path(operand)) {
                Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                Err(error) => {
                    io.err_str(&format!("cat: {operand}: {}\n", io_error_text(&error)));
                    status = 1;
                    continue;
                }
            }
        };
        emit(io, &content);
    }
    Ok(status)
}

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
    let mut read_failed = false;
    // Expand directories into their files when -r.
    let mut sources: Vec<String> = Vec::new();
    for file in &files {
        let path = resolve_paths(shell, std::slice::from_ref(file)).remove(0);
        if path.is_dir() {
            if recursive {
                collect_files_labeled(&path, file, &mut sources, &include, &exclude);
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
                    io.err_str(&format!(
                        "grep: {source}: {}\n",
                        io_error_text(&error)
                    ));
                    read_failed = true;
                }
            }
        }
    }
    let mut matches = 0usize;
    let quiet = flags.contains('q');
    let mut status = if read_failed { 2 } else { 1 };
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
/// [`collect_files_filtered`] with GNU's labelling: entries print as the
/// operand-relative path (`grep -r x sub` says `sub/deep/i.txt:`).
fn collect_files_labeled(
    dir: &Path,
    label: &str,
    out: &mut Vec<String>,
    include: &Option<String>,
    exclude: &Option<String>,
) {
    let mut entries: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(entries) => entries.flatten().map(|e| e.path()).collect(),
        Err(_) => return,
    };
    entries.sort();
    let base = label.trim_end_matches('/');
    for entry in entries {
        let child = format!(
            "{}/{}",
            base,
            entry.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
        );
        if entry.is_dir() {
            collect_files_labeled(&entry, &child, out, include, exclude);
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
        out.push(child);
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
            io.err_str(&format!("find: \u{2018}{root}\u{2019}: No such file or directory\n"));
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
                            io.err_str(&format!("find: \u{2018}{display}': {}\n", io_error_text(&error)));
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
    // One entry per operand — a missing file reports and does not end the walk
    // (GNU's shape for every multi-file reader).
    let multiple = paths.len() > 1;
    let mut status = 0;
    for (position, operand) in paths.iter().enumerate() {
        let resolved = shell.resolve_working_path(operand);
        let bytes_content = match std::fs::read(&resolved) {
            Ok(data) => data,
            Err(error) => {
                io.err_str(&format!(
                    "head: cannot open '{operand}' for reading: {}\n",
                    io_error_text(&error)
                ));
                status = 1;
                continue;
            }
        };
        if multiple {
            if position > 0 {
                io.out_str("\n");
            }
            io.out_str(&format!("==> {operand} <==\n"));
        }
        if let Some(bytes) = bytes {
            io.write_out(&bytes_content[..bytes.min(bytes_content.len())]);
            continue;
        }
        let mut printed = 0i64;
        let mut at = 0usize;
        while at < bytes_content.len() && printed < count {
            let end = match bytes_content[at..].iter().position(|b| *b == b'\n') {
                Some(off) => at + off + 1,
                None => bytes_content.len(),
            };
            io.write_out(&bytes_content[at..end]);
            at = end;
            printed += 1;
        }
    }
    Ok(status)
}

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
    // `-c N` (attached or separate) counts bytes; `-n N`/`-n +K` the lines.
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
    let (count, from_start, rest) = split_count_args(&scanned, 10);
    let from_line: Option<usize> = from_start.then_some(count.max(1) as usize);
    let (_flags, paths) = parse_flags(&rest);
    if paths.is_empty() {
        let mut io_mut = io.clone();
        let data = io_mut.read_all_stdin_bytes();
        emit_tail(io, &data, bytes, from_line, count);
        return Ok(0);
    }
    let multiple = paths.len() > 1;
    let mut status = 0;
    for (position, operand) in paths.iter().enumerate() {
        let resolved = shell.resolve_working_path(operand);
        let data = match std::fs::read(&resolved) {
            Ok(data) => data,
            Err(error) => {
                io.err_str(&format!(
                    "tail: cannot open '{operand}' for reading: {}\n",
                    io_error_text(&error)
                ));
                status = 1;
                continue;
            }
        };
        if multiple {
            if position > 0 {
                io.out_str("\n");
            }
            io.out_str(&format!("==> {operand} <==\n"));
        }
        emit_tail(io, &data, bytes, from_line, count);
    }
    Ok(status)
}

/// One tail rendering over bytes: the byte form slices the tail of the buffer,
/// the line form walks whole lines from the skip point.
fn emit_tail(io: &Io, data: &[u8], bytes: Option<usize>, from_line: Option<usize>, count: i64) {
    if let Some(skip) = bytes {
        let from = data.len().saturating_sub(skip);
        io.write_out(&data[from..]);
        return;
    }
    match from_line {
        Some(start) => {
            let mut at = 0usize;
            let mut seen = 0usize;
            while at < data.len() {
                let end = match data[at..].iter().position(|b| *b == b'\n') {
                    Some(off) => at + off + 1,
                    None => data.len(),
                };
                seen += 1;
                if seen >= start {
                    io.write_out(&data[at..end]);
                }
                at = end;
            }
        }
        None => {
            let take = count.max(0) as usize;
            let total = data.iter().filter(|b| **b == b'\n').count()
                + data.last().map(|b| *b != b'\n').unwrap_or(false) as usize;
            let skip_lines = total.saturating_sub(take);
            let mut at = 0usize;
            let mut seen = 0usize;
            while at < data.len() {
                let end = match data[at..].iter().position(|b| *b == b'\n') {
                    Some(off) => at + off + 1,
                    None => data.len(),
                };
                if seen >= skip_lines {
                    io.write_out(&data[at..end]);
                }
                seen += 1;
                at = end;
            }
        }
    }
}

/* ---------- wc ---------- */

fn wc(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (flags, paths) = parse_flags(args);
    let want_lines = flags.contains('l');
    let want_words = flags.contains('w');
    let want_chars = flags.contains('c') || flags.contains('m');
    let everything = !want_lines && !want_words && !want_chars;
    let columns = [
        (want_lines || everything),
        (want_words || everything),
        (want_chars || everything),
    ];
    // One entry per operand — a missing file reports and continues.
    let mut rows: Vec<(String, (usize, usize, usize))> = Vec::new();
    let mut status = 0;
    if paths.is_empty() {
        let mut io_mut = io.clone();
        let text = io_mut.read_all_stdin();
        rows.push((
            String::new(),
            (
                text.matches('\n').count(),
                text.split_whitespace().count(),
                text.len(),
            ),
        ));
    } else {
        for operand in &paths {
            let resolved = shell.resolve_working_path(operand);
            match std::fs::read_to_string(&resolved) {
                Ok(text) => rows.push((
                    operand.clone(),
                    (
                        text.matches('\n').count(),
                        text.split_whitespace().count(),
                        text.len(),
                    ),
                )),
                Err(error) => {
                    io.err_str(&format!(
                        "wc: {operand}: {}\n",
                        io_error_text(&error)
                    ));
                    status = 1;
                }
            }
        }
        if rows.is_empty() {
            return Ok(status);
        }
    }
    let mut totals = (0usize, 0usize, 0usize);
    for (_, counts) in &rows {
        totals.0 += counts.0;
        totals.1 += counts.1;
        totals.2 += counts.2;
    }
    // GNU's layout: the number width is the digit count of the LARGEST of all
    // three counters (the unshown columns included) over every row and the
    // total. One column reads bare ("2 file"); a single row whose width is 1
    // reads compact ("2 2 file"); everything else pads every field with its own
    // leading space and joins with one more (" 2  2  6 file").
    let number_width = rows
        .iter()
        .map(|(_, c)| c.0.max(c.1).max(c.2))
        .chain([totals.0.max(totals.1).max(totals.2)])
        .map(|v| v.to_string().len())
        .max()
        .unwrap_or(1);
    let multiple = paths.len() > 1;
    let single_column = columns.iter().filter(|show| **show).count() == 1;
    let single_row = rows.len() == 1;
    let render = |counts: (usize, usize, usize), name: &str| -> String {
        let values: Vec<usize> = [counts.0, counts.1, counts.2]
            .iter()
            .zip(&columns)
            .filter(|(_, show)| **show)
            .map(|(value, _)| *value)
            .collect();
        // One count reads bare; a lone row of single-digit counts reads
        // compact; everything else right-aligns every count to at least two
        // columns and joins with single spaces (GNU's own layout).
        let mut line = if single_column || (single_row && !multiple && number_width == 1) {
            values
                .iter()
                .map(|v| v.to_string())
                .collect::<Vec<String>>()
                .join(" ")
        } else {
            let field = number_width.max(2);
            values
                .iter()
                .map(|v| format!("{v:>field$}", v = v, field = field))
                .collect::<Vec<String>>()
                .join(" ")
        };
        if !name.is_empty() {
            line.push_str(&format!(" {name}"));
        }
        line
    };
    for (name, counts) in &rows {
        io.out_str(&format!("{}\n", render(*counts, name)));
    }
    if multiple {
        io.out_str(&format!("{}\n", render(totals, "total")));
    }
    Ok(status)
}


/* ---------- Filesystem applets ---------- */

fn mkdir(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (flags, paths) = parse_flags(args);
    let parents = flags.contains('p');
    let mut status = 0;
    for (operand, path) in paths.iter().zip(resolve_paths(shell, &paths)) {
        let result = if parents {
            std::fs::create_dir_all(&path)
        } else {
            std::fs::create_dir(&path)
        };
        if let Err(error) = result {
            io.err_str(&format!(
                "mkdir: cannot create directory \u{2018}{operand}\u{2019}: {}\n",
                io_error_text(&error)
            ));
            status = 1;
        }
    }
    Ok(status)
}

fn rmdir(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (_, paths) = parse_flags(args);
    let mut status = 0;
    for (operand, path) in paths.iter().zip(resolve_paths(shell, &paths)) {
        if let Err(error) = std::fs::remove_dir(&path) {
            io.err_str(&format!(
                "rmdir: failed to remove \'{operand}\': {}\n",
                io_error_text(&error)
            ));
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
    for (operand, path) in paths.iter().zip(resolve_paths(shell, &paths)) {
        let metadata = std::fs::symlink_metadata(&path);
        let result = match &metadata {
            Err(_) if force => continue,
            Err(error) => Err(std::io::Error::from(error.kind())),
            Ok(m) if m.is_dir() && recursive => std::fs::remove_dir_all(&path),
            Ok(m) if m.is_dir() => std::fs::remove_dir(&path),
            Ok(_) => std::fs::remove_file(&path),
        };
        if let Err(error) = result {
            io.err_str(&format!(
                "rm: cannot remove \'{operand}\': {}\n",
                io_error_text(&error)
            ));
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
        if !from.exists() {
            io.err_str(&format!(
                "cp: cannot stat \'{source}': No such file or directory\n"
            ));
            status = 1;
            continue;
        }
        if let Err(error) = copy_tree(&from, &to, recursive) {
            io.err_str(&format!("cp: cannot create regular file: {error}\n"));
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
        std::fs::create_dir_all(to).map_err(|e| io_error_text(&e))?;
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
        .map_err(|e| io_error_text(&e))
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
                io.err_str(&format!("mv: cannot stat \'{source}\': {error}\n"));
                status = 1;
            }
        }
    }
    Ok(status)
}

fn touch(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (flags, paths) = parse_flags(args);
    // -c/--no-create: a missing file is quietly skipped, never made.
    let no_create = flags.contains('c');
    let mut status = 0;
    for (operand, path) in paths.iter().zip(resolve_paths(shell, &paths)) {
        match if no_create && !path.exists() {
            // -c over a missing file: skipped before any create attempt.
            Err(std::io::Error::from(std::io::ErrorKind::NotFound))
        } else {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
        } {
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
                if no_create {
                    continue;
                }
                io.err_str(&format!("touch: cannot touch \'{operand}': {}\n", io_error_text(&error)));
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
    // GNU's shape: -c counts, -d only dups, -u only uniques, -f N skips N fields,
    // -s N skips N chars, -w N compares N chars — attached or separated values.
    let mut count = false;
    let mut only_dups = false;
    let mut only_uniques = false;
    let mut skip_fields = 0usize;
    let mut skip_chars = 0usize;
    let mut compare_chars = usize::MAX;
    let mut operands: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if let Some(body) = arg.strip_prefix('-').filter(|b| !b.is_empty() && *b != "-") {
            if body.chars().all(|c| c.is_ascii_alphanumeric()) {
                let chars: Vec<char> = body.chars().collect();
                let mut at = 0usize;
                while at < chars.len() {
                    match chars[at] {
                        'c' => count = true,
                        'd' => only_dups = true,
                        'u' => only_uniques = true,
                        'f' | 's' | 'w' => {
                            let rest: String = chars[at + 1..].iter().collect();
                            let value: usize = if rest.is_empty() {
                                iter.next().and_then(|v| v.parse().ok()).unwrap_or(0)
                            } else {
                                rest.parse().unwrap_or(0)
                            };
                            match chars[at] {
                                'f' => skip_fields = value,
                                's' => skip_chars = value,
                                _ => compare_chars = value,
                            }
                            at = chars.len();
                            continue;
                        }
                        'i' => {}
                        _ => {}
                    }
                    at += 1;
                }
                continue;
            }
        }
        if arg == "--" {
            continue;
        }
        operands.push(arg.clone());
    }
    let (input, output) = match operands.as_slice() {
        [input] => (input.clone(), None),
        [input, output] => (input.clone(), Some(output.clone())),
        [] => (String::new(), None),
        _ => {
            io.err_str("uniq: extra operand\n");
            return Ok(1);
        }
    };
    let text = if input.is_empty() || input == "-" {
        let mut io_mut = io.clone();
        io_mut.read_all_stdin()
    } else {
        match std::fs::read_to_string(shell.resolve_working_path(&input)) {
            Ok(text) => text,
            Err(error) => {
                io.err_str(&format!(
                    "uniq: {input}: {}\n",
                    io_error_text(&error)
                ));
                return Ok(1);
            }
        }
    };
    // The comparison key: the line past -f fields and -s chars, cut to -w chars.
    let key_of = |line: &str| -> String {
        let mut rest = line;
        for _ in 0..skip_fields {
            rest = rest.trim_start();
            match rest.find(char::is_whitespace) {
                Some(at) => rest = &rest[at..],
                None => {
                    rest = "";
                    break;
                }
            }
        }
        let rest = rest.chars().skip(skip_chars).collect::<String>();
        rest.chars().take(compare_chars).collect()
    };
    let mut out = String::new();
    let mut run: Option<(String, String, usize)> = None; // (key, line, times)
    let flush = |run: &mut Option<(String, String, usize)>, out: &mut String| {
        if let Some((_, line, times)) = run.take() {
            let keep = if only_dups {
                times > 1
            } else if only_uniques {
                times == 1
            } else {
                true
            };
            if keep {
                if count {
                    out.push_str(&format!("{:>7} {line}\n", times));
                } else {
                    out.push_str(&format!("{line}\n"));
                }
            }
        }
    };
    for line in lines_of(&text) {
        let key = key_of(line);
        match &mut run {
            Some((run_key, run_line, times)) if *run_key == key => {
                *times += 1;
                let _ = run_line;
            }
            _ => {
                flush(&mut run, &mut out);
                run = Some((key, line.to_owned(), 1));
            }
        }
    }
    flush(&mut run, &mut out);
    if let Some(output) = &output {
        let resolved = shell.resolve_working_path(output);
        if let Err(error) = std::fs::write(&resolved, &out) {
            io.err_str(&format!(
                "uniq: {output}: {}\n",
                io_error_text(&error)
            ));
            return Ok(1);
        }
    } else {
        io.out_str(&out);
    }
    Ok(0)
}

fn cut(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut delimiter = '\t';
    let mut fields: Option<String> = None;
    let mut chars: Option<String> = None;
    let mut only_delimited = false;
    let mut complement = false;
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
        } else if arg == "-s" || arg == "--only-delimited" {
            only_delimited = true;
        } else if arg == "--complement" {
            complement = true;
        } else if arg == "--" {
            // everything after is positional
        } else if arg.starts_with('-') && arg.len() > 1 {
            for c in arg[1..].chars() {
                if c == 's' { only_delimited = true }
            }
        } else {
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
    if list.is_empty() {
        io.err_str("cut: you must specify a list of bytes, characters, or fields\n");
        return Ok(1);
    }
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
            if by_chars {
                let chars: Vec<char> = line.chars().collect();
                let selected = |position: usize| -> bool {
                    // position is 1-based, like the user's list.
                    let inside = ranges
                        .iter()
                        .any(|range| position >= range.start && position <= range.end);
                    inside != complement
                };
                let mut picked = String::new();
                for (position, c) in chars.iter().enumerate() {
                    if selected(position + 1) {
                        picked.push(*c);
                    }
                }
                io.out_str(&format!("{picked}\n"));
                continue;
            }
            let pieces: Vec<&str> = line.split(delimiter).collect();
            // A line without the delimiter passes whole (or is skipped under -s) —
            // GNU's own rule for field mode.
            if !pieces.iter().skip(1).any(|_piece| true)
                && !line.contains(delimiter) {
                    if only_delimited {
                        continue;
                    }
                    io.out_str(&format!("{line}\n"));
                    continue;
                }
            let selected = |position: usize| -> bool {
                let inside = ranges
                    .iter()
                    .any(|range| position >= range.start && position <= range.end);
                inside != complement
            };
            let mut picked: Vec<&str> = Vec::new();
            for (position, piece) in pieces.iter().enumerate() {
                if selected(position + 1) {
                    picked.push(piece);
                }
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
    // The long spellings normalize to their letters before the flag walk.
    let normalized: Vec<String> = args
        .iter()
        .map(|arg| match arg.as_str() {
            "--delete" => "-d".to_owned(),
            "--squeeze-repeats" => "-s".to_owned(),
            "--complement" => "-c".to_owned(),
            other => other.to_owned(),
        })
        .collect();
    let (flags, rest) = parse_flags(&normalized);
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
                // Only SET1's members go; everything else crosses untouched.
                if set1.contains(&c) {
                    None
                } else {
                    Some(c)
                }
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
    Transliterate {
        from: Vec<char>,
        to: Vec<char>,
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
                    SedCmd::Transliterate { from, to } => {
                        current = current
                            .chars()
                            .map(|c| match from.iter().position(|f| *f == c) {
                                Some(at) => to.get(at).copied().unwrap_or(c),
                                None => c,
                            })
                            .collect();
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
        // y/from/to/: per-character transliteration, both sets same length.
        'y' => {
            let Some(delim) = chars.next() else {
                return Err("y needs a delimiter".into());
            };
            let body: Vec<char> = script.chars().skip(2).collect();
            let mut sets: Vec<String> = Vec::new();
            let mut current = String::new();
            let mut index = 0usize;
            while index < body.len() {
                let c = body[index];
                if c == '\\' && index + 1 < body.len() {
                    current.push(c);
                    current.push(body[index + 1]);
                    index += 2;
                    continue;
                }
                if c == delim {
                    sets.push(std::mem::take(&mut current));
                } else {
                    current.push(c);
                }
                index += 1;
                if sets.len() == 2 {
                    break;
                }
            }
            if sets.len() != 2 {
                return Err("y needs y/from/to/".into());
            }
            let from: Vec<char> = sets[0].chars().collect();
            let to: Vec<char> = sets[1].chars().collect();
            if from.len() != to.len() {
                return Err("y's strings differ in length".into());
            }
            let rest: String = body[index.min(body.len())..].iter().collect();
            Ok((SedCmd::Transliterate { from, to }, rest))
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
    let mut unset: Vec<String> = Vec::new();
    let mut ignore_env = false;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "--" {
            index += 1;
            break;
        }
        if arg == "-i" || arg == "--ignore-environment" {
            ignore_env = true;
            index += 1;
            continue;
        }
        if arg == "-u" || arg == "--unset" {
            if let Some(name) = args.get(index + 1) {
                unset.push(name.clone());
            }
            index += 2;
            continue;
        }
        if arg.starts_with("-u") && arg.len() > 2 {
            unset.push(arg[2..].to_owned());
            index += 1;
            continue;
        }
        if arg.contains('=') && !arg.starts_with('-') {
            if let Some((key, value)) = arg.split_once('=') {
                extra.push((key.to_owned(), value.to_owned()));
                index += 1;
                continue;
            }
        }
        if arg.starts_with('-') && arg.len() > 1 {
            index += 1;
            continue;
        }
        break;
    }
    let _ = ignore_env;
    // A command looked up without PATH fails the way execvp does.
    let path_gone = unset.iter().any(|name| name == "PATH");
    if index >= args.len() {
        for (key, value) in shell.child_env(&extra) {
            io.out_str(&format!("{key}={value}\n"));
        }
        return Ok(0);
    }
    let name = args[index].clone();
    if path_gone && !super::builtins::is_builtin(&name) {
        io.err_str(&format!(
            "env: \u{2018}{name}\u{2019}: No such file or directory\n"
        ));
        return Ok(127);
    }
    if resolve_on_path(&name, &shell.path_var()).is_none()
        && !super::builtins::is_builtin(&name)
        && !is_applet(&name)
    {
        io.err_str(&format!(
            "env: \u{2018}{name}\u{2019}: No such file or directory\n"
        ));
        return Ok(127);
    }
    // The pairs ride the command's environment: externals through the
    // spawn env, applets and builtins through the shell's own variables
    // for the call's lifetime.
    if super::builtins::is_builtin(&name) || is_applet(&name) {
        let unset_saved: Vec<(String, Option<String>)> = unset
            .iter()
            .map(|key| {
                let had = shell.get_var(key).map(|value| value.to_owned());
                (key.clone(), had)
            })
            .collect();
        for key in &unset {
            shell.vars.remove(key);
        }
        let saved: Vec<(String, Option<String>)> = extra
            .iter()
            .map(|(key, value)| {
                let had = shell.get_var(key).map(|value| value.to_owned());
                shell.set_var(key, value);
                shell.export_var(key, None);
                (key.clone(), had)
            })
            .collect();
        let mut argv: Vec<String> = vec![name.clone()];
        argv.extend_from_slice(&args[index + 1..]);
        let result = shell.run_argv(&argv, io);
        for (key, had) in unset_saved {
            match had {
                Some(value) => shell.set_var(&key, &value),
                None => {
                    shell.vars.remove(&key);
                }
            }
        }
        for (key, had) in saved {
            match had {
                Some(value) => shell.set_var(&key, &value),
                None => {
                    shell.vars.remove(&key);
                }
            }
        }
        return result;
    }
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
            // The PATH hit prints in the MSYS dialect; a Git Bash `usr/bin` hit
            // answers exactly what Git Bash's own `which` says.
            if let Some(usr_bin) = super::exec::git_usr_bin_from(&shell.path_var()) {
                if path.starts_with(&usr_bin) {
                    io.out_str(&format!("/usr/bin/{name}\n"));
                    continue;
                }
            }
            io.out_str(&format!("{}\n", super::msys::to_msys(&path)));
        } else {
            io.err_str(&format!(
                "which: no {name} in ({})\n",
                shell.path_var()
            ));
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
    let format = args
        .iter()
        .find(|a| a.starts_with('+'))
        .map(|a| a[1..].to_owned())
        .unwrap_or_else(|| "%a %b %e %H:%M:%S %Z %Y".to_owned());
    // `-d @N` names a moment; `-r FILE` a file's mtime; neither means now.
    let mut moment: Option<Civil> = None;
    let mut moment_unix: Option<i64> = None;
    let mut index = 0usize;
    while index < args.len() {
        match args[index].as_str() {
            "-d" | "--date" => {
                if let Some(value) = args.get(index + 1) {
                    if let Some(epoch) = value.strip_prefix('@').and_then(|n| n.parse::<i64>().ok()) {
                        moment_unix = Some(epoch);
                        moment = Some(unix_to_local(epoch));
                    }
                    index += 1;
                }
            }
            "-r" | "--reference" => {
                if let Some(file) = args.get(index + 1) {
                    let resolved = shell.resolve_working_path(file);
                    match std::fs::metadata(&resolved).and_then(|m| m.modified()) {
                        Ok(stamp) => {
                            let secs = stamp
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|span| span.as_secs() as i64)
                                .unwrap_or(0);
                            moment_unix = Some(secs);
                            moment = Some(unix_to_local(secs));
                        }
                        Err(error) => {
                            io.err_str(&format!(
                                "date: {file}: {}\n",
                                io_error_text(&error)
                            ));
                            return Ok(1);
                        }
                    }
                    index += 1;
                }
            }
            _ => {}
        }
        index += 1;
    }
    let now = moment.unwrap_or_else(local_now);
    let unix_now = moment_unix.unwrap_or_else(super::localtime::now_unix);
    io.out_str(&format_date_at(&format, &now, unix_now));
    io.out_str("\n");
    Ok(0)
}


fn format_date_at(format: &str, now: &Civil, unix_now: i64) -> String {
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
            Some('s') => out.push_str(&unix_now.to_string()),
            Some('z') => {
                let sign = if offset < 0 { '-' } else { '+' };
                let minutes = offset.abs() / 60;
                out.push_str(&format!("{sign}{:02}{:02}", minutes / 60, minutes % 60));
            }
            Some('Z') => out.push_str(""),
            Some('a') => out.push_str(DAYS[now.weekday() as usize]),
            Some('A') => out.push_str(
                ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
                    [now.weekday() as usize],
            ),
            Some('b') | Some('h') => out.push_str(MONTHS[(now.month as usize - 1).min(11)]),
            Some('B') => out.push_str(
                [
                    "January", "February", "March", "April", "May", "June", "July", "August",
                    "September", "October", "November", "December",
                ][(now.month as usize - 1).min(11)],
            ),
            Some('D') => out.push_str(&format!(
                "{:02}/{:02}/{:02}",
                now.month,
                now.day,
                now.year.rem_euclid(100)
            )),
            Some('I') => {
                let twelve = match now.hour % 12 {
                    0 => 12,
                    other => other,
                };
                out.push_str(&format!("{twelve:02}"));
            }
            Some('j') => {
                // The day of the year, 001-based.
                let start = super::localtime::days_from_civil(now.year, 1, 1);
                let today = super::localtime::days_from_civil(now.year, now.month, now.day);
                out.push_str(&format!("{:03}", today - start + 1));
            }
            Some('p') => out.push_str(if now.hour < 12 { "AM" } else { "PM" }),
            Some('P') => out.push_str(if now.hour < 12 { "am" } else { "pm" }),
            Some('r') => {
                let twelve = match now.hour % 12 {
                    0 => 12,
                    other => other,
                };
                let half = if now.hour < 12 { "AM" } else { "PM" };
                out.push_str(&format!(
                    "{twelve:02}:{:02}:{:02} {half}",
                    now.minute, now.second
                ));
            }
            Some('u') => out.push_str(&match now.weekday() {
                0 => "7".to_owned(),
                other => other.to_string(),
            }),
            Some('V') => {
                // ISO week number: the week of the first Thursday's year.
                let start = super::localtime::days_from_civil(now.year, 1, 1);
                let today = super::localtime::days_from_civil(now.year, now.month, now.day);
                let iso = today - start + 1 + 3;
                let jan1 = start.rem_euclid(7);
                let week = (iso + 6) / 7;
                if week == 0 {
                    out.push_str(&format!("{:02}", (jan1 + 364) / 7));
                } else {
                    out.push_str(&format!("{week:02}"));
                }
            }
            Some('w') => out.push_str(&now.weekday().to_string()),
            Some('W') => {
                let start = super::localtime::days_from_civil(now.year, 1, 1);
                let today = super::localtime::days_from_civil(now.year, now.month, now.day);
                let days = today - start;
                out.push_str(&format!("{:02}", (days + 6) / 7));
            }
            Some('x') => out.push_str(&format!(
                "{:02}/{:02}/{}",
                now.month,
                now.day,
                now.year.rem_euclid(100)
            )),
            Some('X') => out.push_str(&format!(
                "{:02}:{:02}:{:02}",
                now.hour, now.minute, now.second
            )),
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
    let _ = shell;
    let mut separator = "\n".to_owned();
    let mut equal_width = false;
    let mut format: Option<String> = None;
    let mut operands: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if let Some(body) = arg.strip_prefix('-').filter(|b| !b.is_empty() && !b.starts_with('-')) {
            // A negative number is an operand (`seq 5 -1 3`), never a flag.
            if body.parse::<f64>().is_ok() {
                operands.push(arg.clone());
                continue;
            }
            // Attached clusters (-sX, -fX, -w) and the separated forms.
            let chars: Vec<char> = body.chars().collect();
            let mut at = 0usize;
            while at < chars.len() {
                match chars[at] {
                    'w' => equal_width = true,
                    's' | 'f' => {
                        let takes_value = chars[at] == 's';
                        let rest: String = chars[at + 1..].iter().collect();
                        let value = if rest.is_empty() {
                            iter.next().cloned().unwrap_or_default()
                        } else {
                            rest
                        };
                        if takes_value {
                            separator = unescape_delims(&value).join("");
                        } else {
                            format = Some(value);
                        }
                        at = chars.len();
                        continue;
                    }
                    _ => {}
                }
                at += 1;
            }
            continue;
        }
        if arg == "--" {
            continue;
        }
        operands.push(arg.clone());
    }
    let numbers: Vec<i64> = operands.iter().filter_map(|a| a.parse().ok()).collect();
    let values: Vec<i64> = match numbers.len() {
        1 => (1..=numbers[0]).collect(),
        2 => {
            if numbers[0] > numbers[1] {
                Vec::new()
            } else {
                (numbers[0]..=numbers[1]).collect()
            }
        }
        3 => {
            let (first, step, last) = (numbers[0], numbers[1], numbers[2]);
            if step == 0 {
                io.err_str("seq: invalid Zero increment value: '0'\n");
                return Ok(1);
            }
            let mut out = Vec::new();
            let mut value = first;
            while (step > 0 && value <= last) || (step < 0 && value >= last) {
                out.push(value);
                value += step;
            }
            out
        }
        _ => {
            io.err_str("seq: missing operand\n");
            return Ok(1);
        }
    };
    // -f renders each value through the spec (one % verb, GNU's own limit);
    // -w zero-pads integers to the widest value.
    let width = if equal_width {
        values
            .iter()
            .map(|v| v.to_string().len())
            .max()
            .unwrap_or(1)
    } else {
        0
    };
    let rendered: Vec<String> = values
        .iter()
        .map(|value| {
            if let Some(spec) = &format {
                let mut out = String::new();
                let mut chars = spec.chars().peekable();
                while let Some(c) = chars.next() {
                    if c != '%' {
                        out.push(c);
                        continue;
                    }
                    if chars.peek() == Some(&'%') {
                        chars.next();
                        out.push('%');
                        continue;
                    }
                    let mut left = false;
                    let mut pad = String::new();
                    loop {
                        match chars.peek() {
                            Some('-') => {
                                left = true;
                                chars.next();
                            }
                            Some(d) if d.is_ascii_digit() => pad.push(chars.next().unwrap()),
                            _ => break,
                        }
                    }
                    let verb = chars.next().unwrap_or('g');
                    let body = match verb {
                        'g' => value.to_string(),
                        'd' => value.to_string(),
                        'e' => format!("{:e}", *value as f64),
                        'f' => format!("{:.6}", *value as f64),
                        other => format!("%{other}"),
                    };
                    let width: usize = pad.parse().unwrap_or(0);
                    if body.len() < width {
                        if left {
                            out.push_str(&format!("{:<width$}", body, width = width));
                        } else {
                            out.push_str(&format!("{:>width$}", body, width = width));
                        }
                    } else {
                        out.push_str(&body);
                    }
                }
                out
            } else if equal_width {
                format!("{:0>width$}", value.to_string(), width = width)
            } else {
                value.to_string()
            }
        })
        .collect();
    let joined = rendered.join(&separator);
    if !joined.is_empty() {
        io.out_str(&joined);
        io.out_str("\n");
    }
    Ok(0)
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
    // GNU's three shapes: the normal ed-style report (default), `-u`'s unified
    // hunks with three context lines, and `-q`'s one-liner.
    let mut unified = false;
    let mut brief = false;
    let mut operands: Vec<String> = Vec::new();
    for arg in args {
        match arg.as_str() {
            "-u" | "--unified" => unified = true,
            "-q" | "--brief" => brief = true,
            "-i" | "-w" | "-b" | "-B" | "--ignore-case" | "--ignore-all-space"
            | "--ignore-blank-lines" | "--text" | "-a" | "--" => {}
            other if other.starts_with('-') && other.len() > 1 => {
                for c in other[1..].chars() {
                    match c {
                        'u' => unified = true,
                        'q' => brief = true,
                        _ => {}
                    }
                }
            }
            other => operands.push(other.to_owned()),
        }
    }
    if operands.len() != 2 {
        io.err_str("diff: two files are required\n");
        return Ok(2);
    }
    let resolved = resolve_paths(shell, &operands);
    let (left_name, right_name) = (operands[0].clone(), operands[1].clone());
    let left = match std::fs::read_to_string(&resolved[0]) {
        Ok(text) => text,
        Err(error) => {
            io.err_str(&format!(
                "diff: {left_name}: {}\n",
                io_error_text(&error)
            ));
            return Ok(2);
        }
    };
    let right = match std::fs::read_to_string(&resolved[1]) {
        Ok(text) => text,
        Err(error) => {
            io.err_str(&format!(
                "diff: {right_name}: {}\n",
                io_error_text(&error)
            ));
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
    if brief {
        io.out_str(&format!("Files {left_name} and {right_name} differ\n"));
        return Ok(1);
    }
    if !unified {
        // The normal format: one `Ra,rbXd` command per change block, `<`/`>` lines
        // and a `---` separator between the sides.
        let mut a_line = 0usize;
        let mut b_line = 0usize;
        let mut index = 0usize;
        while index < edits.len() {
            if matches!(edits[index].0, DiffEdit::Keep) {
                a_line += 1;
                b_line += 1;
                index += 1;
                continue;
            }
            let start = index;
            let mut end = index;
            while end < edits.len() && !matches!(edits[end].0, DiffEdit::Keep) {
                end += 1;
            }
            let removed = edits[start..end]
                .iter()
                .filter(|(e, _)| matches!(e, DiffEdit::Remove))
                .count();
            let added = edits[start..end]
                .iter()
                .filter(|(e, _)| matches!(e, DiffEdit::Add))
                .count();
            let a_start = a_line + 1;
            let b_start = b_line + 1;
            // GNU's ranges: `start,end` multi-line, a bare number single-line.
            let range = |start: usize, count: usize| -> String {
                if count <= 1 {
                    format!("{start}")
                } else {
                    format!("{},{}", start, start + count - 1)
                }
            };
            let (command, left_range, right_range) = if removed > 0 && added > 0 {
                ('c', range(a_start, removed), range(b_start, added))
            } else if removed > 0 {
                ('d', range(a_start, removed), format!("{b_line}"))
            } else {
                ('a', format!("{a_line}"), range(b_start, added))
            };
            io.out_str(&format!("{left_range}{command}{right_range}\n"));
            // GNU prints the whole left block, `---`, then the whole right block.
            for (edit, line) in &edits[start..end] {
                if matches!(edit, DiffEdit::Remove) {
                    io.out_str(&format!("< {line}\n"));
                }
            }
            if removed > 0 && added > 0 {
                io.out_str("---\n");
            }
            for (edit, line) in &edits[start..end] {
                if matches!(edit, DiffEdit::Add) {
                    io.out_str(&format!("> {line}\n"));
                }
            }
            a_line += removed;
            b_line += added;
            index = end;
        }
        return Ok(1);
    }
    // GNU stamps each header with the file's mtime (a tab between).
    let stamp = |operand: &str| -> String {
        match std::fs::metadata(shell.resolve_working_path(operand)).and_then(|m| m.modified()) {
            Ok(moment) => moment
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|_span| stat_time(Ok(moment)) )
                .unwrap_or_default(),
            Err(_) => String::new(),
        }
    };
    io.out_str(&format!("--- {left_name}\t{}\n", stamp(&left_name)));
    io.out_str(&format!("+++ {right_name}\t{}\n", stamp(&right_name)));
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
    // GNU's attached spellings (-n1, -I{}) split before the walk.
    let args: Vec<String> = args
        .iter()
        .flat_map(|arg| {
            if let Some(rest) = arg.strip_prefix("-n").filter(|r| !r.is_empty()) {
                if rest.chars().all(|c| c.is_ascii_digit()) {
                    return vec!["-n".to_owned(), rest.to_owned()];
                }
            }
            vec![arg.clone()]
        })
        .collect();
    // GNU warns when --max-args and --replace ride together (replace wins).
    let has_n = args.iter().any(|a| {
        a == "-n"
            || (a.starts_with("-n")
                && a[2..]
                    .chars()
                    .all(|c| c.is_ascii_digit())
                && a.len() > 2)
    });
    let has_i = args.iter().any(|a| a == "-I" || a == "-i" || a.starts_with("-I") || a.starts_with("-i"));
    if has_n && has_i {
        io.err_str(
            "xargs: warning: options --max-args and --replace/-I/-i are mutually exclusive, ignoring previous --max-args value\n",
        );
    }
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
    // GNU splits stdin into WORDS (whitespace runs separate them; -0 into
    // NUL-terminated records) — `printf 'a b' | xargs -n1 echo` is two runs.
    let items: Vec<String> = if null_split {
        input
            .split('\0')
            .filter(|item| !item.is_empty())
            .map(str::to_owned)
            .collect()
    } else {
        input
            .split_whitespace()
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
            "sha224sum" => super::hashes::sha224(data),
            "sha256sum" => super::hashes::sha256(data),
            "sha384sum" => super::hashes::sha384(data),
            "sha512sum" => super::hashes::sha512(data),
            "b2sum" => super::hashes::blake2b512(data),
            _ => super::hashes::sha256(data),
        }
    };
    if args.iter().any(|arg| arg == "-c" || arg == "--check") {
        // One checksum line: the digest, the marker ("  " text, " *" binary — a
        // Git Bash-written file carries the star), the path.
        let parse_line = |line: &str| -> Option<(String, String)> {
            let (hash, rest) = line.split_once(' ')?;
            let path = rest.trim_start_matches(['*', ' ']);
            Some((hash.to_owned(), path.to_owned()))
        };
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
                .filter_map(&parse_line)
                .collect()
        } else {
            let mut entries = Vec::new();
            for path in &list {
                match std::fs::read_to_string(shell.resolve_working_path(path)) {
                    Ok(text) => {
                        entries.extend(text.lines().filter_map(&parse_line))
                    }
                    Err(error) => {
                        io.err_str(&format!("{name}: {path}: {error}\n"));
                        status = 1;
                    }
                }
            }
            entries
        };
        let mut failed = 0usize;
        let mut failed_open = 0usize;
        for (expected, path) in entries {
            let resolved = shell.resolve_working_path(&path);
            match std::fs::read(&resolved) {
                Ok(data) => {
                    let actual = digest(&data);
                    if actual == expected {
                        io.out_str(&format!("{path}: OK\n"));
                    } else {
                        io.out_str(&format!("{path}: FAILED\n"));
                        failed += 1;
                        status = 1;
                    }
                }
                Err(_) => {
                    io.out_str(&format!("{path}: FAILED open or read\n"));
                    failed_open += 1;
                    status = 1;
                }
            }
        }
        // GNU's summary: one line for each failure class, then the warning.
        if failed > 0 {
            io.err_str(&format!(
                "{name}: WARNING: {failed} computed checksum{} did NOT match\n",
                if failed == 1 { "" } else { "s" }
            ));
        }
        if failed_open > 0 {
            io.err_str(&format!(
                "{name}: WARNING: {failed_open} listed file{} could not be read\n",
                if failed_open == 1 { "" } else { "s" }
            ));
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
        io.out_str(&format!("{} *-\n", digest(&data)));
        return Ok(0);
    }
    let mut status = 0;
    for path in &paths {
        let resolved = shell.resolve_working_path(path);
        match std::fs::read(&resolved) {
            Ok(data) => io.out_str(&format!("{} *{path}\n", digest(&data))),
            Err(error) => {
                io.err_str(&format!(
                    "{name}: {path}: {}\n",
                    io_error_text(&error)
                ));
                status = 1;
            }
        }
    }
    Ok(status)
}

/// `base64` — encode, `-d` decode, `-w 0` unlimited width (the default wraps at 76).
fn base64_applet(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
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
    let mut operands: Vec<String> = Vec::new();
    for arg in args {
        if arg.starts_with('-') && arg.len() > 1 {
            continue;
        }
        operands.push(arg.clone());
    }
    let mut input = String::new();
    if operands.is_empty() {
        let mut io_mut = io.clone();
        input = io_mut.read_all_stdin();
    } else {
        for operand in &operands {
            match std::fs::read(shell.resolve_working_path(operand)) {
                Ok(bytes) => input.push_str(&String::from_utf8_lossy(&bytes)),
                Err(error) => {
                    io.err_str(&format!(
                        "base64: {operand}: {}\n",
                        io_error_text(&error)
                    ));
                    return Ok(1);
                }
            }
        }
    }
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
                human_size(dir_blocks(&resolved), human),
                target
            ));
        } else {
            walk_du(io, &resolved, human, target);
        }
    }
    Ok(0)
}

/// GNU's du accounting: each FILE claims ceil(size / 1024) KiB (an empty file
/// 0), directories nothing of their own — the numbers `du -s` prints for a Git
/// Bash tree of small files.
fn dir_blocks(path: &std::path::Path) -> u64 {
    if path.is_file() {
        return std::fs::metadata(path)
            .map(|m| m.len().div_ceil(1024))
            .unwrap_or(0);
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries.flatten().map(|entry| dir_blocks(&entry.path())).sum()
}

fn walk_du(io: &Io, current: &std::path::Path, human: bool, label: &str) {
    io.out_str(&format!(
        "{}\t{}\n",
        human_size(dir_blocks(current), human),
        label
    ));
    if !current.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(current) else {
        return;
    };
    let mut names: Vec<_> = entries.flatten().collect();
    names.sort_by_key(|entry| entry.file_name());
    for entry in names {
        let child = format!(
            "{}/{}",
            label.trim_end_matches('/'),
            entry.file_name().to_string_lossy()
        );
        walk_du(io, &entry.path(), human, &child);
    }
}

/// du's own humanizer: the count is KiB — `-h` scales it through the units
/// (a 1-KiB tree prints `1K`), anything else prints the bare block count.
fn human_size(kib: u64, human: bool) -> String {
    if !human {
        return kib.to_string();
    }
    let bytes = kib * 1024;
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
            // Git Bash's own default (winsymlinks unset): a symlink the process
            // may not create becomes a COPY of the target.
            match std::fs::metadata(&target) {
                Ok(metadata) if metadata.is_dir() => {
                    if copy_dir_recursive(&target, &link).is_ok() {
                        return Ok(0);
                    }
                }
                Ok(_) => {
                    if std::fs::copy(&target, &link).is_ok() {
                        return Ok(0);
                    }
                }
                Err(_) => {}
            }
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
    let mut operands = args.iter().filter(|arg| !arg.starts_with('-'));
    let _mode = operands.next();
    let mut status = 0;
    for arg in operands {
        if !shell.resolve_working_path(arg).exists() {
            io.err_str(&format!(
                "chmod: cannot access '{arg}': No such file or directory\n"
            ));
            status = 1;
        }
    }
    Ok(status)
}

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
            Err(_error) => {
                io.err_str(&format!("timeout: failed to run command \u{2018}{}\u{2019}: No such file or directory\n", rest[0]));
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

/* ---------- The Git Bash parity batch ---------- */
//
// The curated list had covered the AI-high-frequency tools; this batch closes the
// rest of what a Git Bash install answers (2026-10-14): the coreutils text tools
// (`nl`, `tac`, `paste`, `join`, `comm`, `fold`, `expand`/`unexpand`, `tsort`,
// `expr`, `factor`, `numfmt`, `shuf`, `yes`), the byte inspectors (`od`, `xxd`,
// `cmp`), the digests (`sha224sum`…`b2sum`, `cksum`, `sum`, `base32`), the file
// metadata and shaping tools (`stat`, `file`, `truncate`, `mktemp`, `shred`,
// `install`, `link`, `unlink`, `dd`, `sync`), the converters (`iconv`, the
// `dos2unix` family, `zcat`, `dircolors`), the run-with wrappers (`nohup`, `nice`,
// `stdbuf`), the terminal probes (`tput`, `stty`, `reset`) and `printenv`/`dir`/
// `vdir`/`egrep`/`fgrep`. The OS-facing half (`df`, `free`, `ps`, `id`, …) lives in
// `sysinfo.rs`. Where the shapes are visible GNU output (od's offsets, stat's
// columns, file's padding, dd's stats line) they were byte-checked against a live
// Git Bash.

/// A tiny seeded RNG (xorshift64*) — `shuf`'s and `mktemp`'s random source; the
/// sidecar carries no rand crate.
pub(crate) fn next_random(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    state.wrapping_mul(0x2545_f491_4f6c_dd1d)
}

/// A fresh RNG state seeded from the clock and the pid.
fn random_state() -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|span| span.as_nanos() as u64)
        .unwrap_or(0x9e37_79b9_7f4a_7c15);
    (nanos ^ ((std::process::id() as u64) << 32) | 1) | 1
}

/// FNV-1a — the stable fake `stat` builds its device/inode numbers from (a bundled
/// shell has no volume serials to read without APIs; a path-derived value is at
/// least deterministic across calls).
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    hash
}

/// The binary-input reader: operands (labelled with the text as typed) or stdin's
/// raw bytes.
fn read_byte_inputs(
    shell: &mut Shell,
    io: &Io,
    args: &[String],
    applet: &str,
) -> (Vec<(String, Vec<u8>)>, i32) {
    let paths: Vec<String> = args
        .iter()
        .filter(|arg| !arg.starts_with('-'))
        .cloned()
        .collect();
    if paths.is_empty() {
        let mut io_mut = io.clone();
        return (vec![(String::new(), io_mut.read_all_stdin_bytes())], 0);
    }
    let mut out = Vec::new();
    let mut status = 0;
    for (operand, resolved) in paths.iter().zip(resolve_paths(shell, &paths)) {
        match std::fs::read(&resolved) {
            Ok(data) => out.push((operand.clone(), data)),
            Err(error) => {
                io.err_str(&format!("{applet}: {operand}: {}\n", io_error_text(&error)));
                status = 1;
            }
        }
    }
    (out, status)
}

/// The `-d` delimiter lists of `paste` (and `join`): `\t`, `\n`, `\\` and `\0`
/// decode to their bytes, everything else is itself.
fn unescape_delims(text: &str) -> Vec<String> {
    text.chars()
        .map(|c| match c {
            't' => "\t".to_owned(),
            'n' => "\n".to_owned(),
            '0' => "\0".to_owned(),
            other => other.to_string(),
        })
        .collect()
}

/* ---------- printenv ---------- */

fn printenv(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let names: Vec<String> = args
        .iter()
        .filter(|arg| !arg.starts_with('-'))
        .cloned()
        .collect();
    let env = shell.child_env(&[]);
    // PATH prints the way a Git Bash session sees it: /c/... pieces joined
    // by colons, never the stored Windows form.
    let present = |key: &str, value: &str| -> String {
        if key == "PATH" {
            value
                .split(';')
                .filter(|piece| !piece.is_empty())
                .map(|piece| super::msys::to_msys(std::path::Path::new(piece)))
                .collect::<Vec<String>>()
                .join(":")
        } else {
            value.to_owned()
        }
    };
    if names.is_empty() {
        for (key, value) in env {
            io.out_str(&format!("{}={}\n", key, present(&key, &value)));
        }
        return Ok(0);
    }
    let mut status = 0;
    for name in &names {
        match env.iter().find(|(key, _)| key == name) {
            Some((_, value)) => io.out_str(&format!("{}\n", present(name, value))),
            None => status = 1,
        }
    }
    Ok(status)
}

/* ---------- cksum / sum ---------- */

fn cksum_applet(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (inputs, status) = read_byte_inputs(shell, io, args, "cksum");
    for (name, data) in &inputs {
        let crc = super::hashes::cksum_crc(data);
        if name.is_empty() {
            io.out_str(&format!("{crc} {}\n", data.len()));
        } else {
            io.out_str(&format!("{crc} {} {name}\n", data.len()));
        }
    }
    Ok(status)
}

fn sum_applet(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let sysv = args.iter().any(|arg| arg.starts_with('-') && arg[1..].contains('s'));
    let (inputs, status) = read_byte_inputs(shell, io, args, "sum");
    let multiple = inputs.len() > 1;
    for (name, data) in &inputs {
        if sysv {
            let checksum = super::hashes::sysv_sum(data);
            let blocks = data.len().div_ceil(512);
            if name.is_empty() {
                io.out_str(&format!("{checksum} {blocks}\n"));
            } else {
                io.out_str(&format!("{checksum} {blocks} {name}\n"));
            }
        } else {
            let checksum = super::hashes::bsd_sum(data);
            let blocks = data.len().div_ceil(1024);
            // BSD shape: the checksum zero-padded to 5, blocks right in 6; the name
            // only once several operands asked for it.
            let line = format!("{checksum:05}{blocks:6}");
            if name.is_empty() || !multiple {
                io.out_str(&format!("{line}\n"));
            } else {
                io.out_str(&format!("{line} {name}\n"));
            }
        }
    }
    Ok(status)
}

/* ---------- base32 ---------- */

const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn base32_encode(data: &[u8]) -> String {
    let mut out = String::new();
    for chunk in data.chunks(5) {
        let mut buffer = 0u64;
        for byte in chunk {
            buffer = (buffer << 8) | *byte as u64;
        }
        buffer <<= 8 * (5 - chunk.len()) as u64;
        let chars = (chunk.len() * 8).div_ceil(5);
        for at in 0..8 {
            if at < chars {
                out.push(B32[((buffer >> (35 - at * 5)) & 31) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn base32_applet(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
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
    let mut operands: Vec<String> = Vec::new();
    for arg in args {
        if arg.starts_with('-') && arg.len() > 1 {
            continue;
        }
        operands.push(arg.clone());
    }
    let mut input: Vec<u8> = Vec::new();
    if operands.is_empty() {
        let mut io_mut = io.clone();
        input = io_mut.read_all_stdin_bytes();
    } else {
        for operand in &operands {
            match std::fs::read(shell.resolve_working_path(operand)) {
                Ok(bytes) => input.extend_from_slice(&bytes),
                Err(error) => {
                    io.err_str(&format!(
                        "base32: {operand}: {}\n",
                        io_error_text(&error)
                    ));
                    return Ok(1);
                }
            }
        }
    }
    if decode {
        let mut bits = 0u32;
        let mut buffer = 0u32;
        let mut out = Vec::new();
        for byte in &input {
            let c = *byte as char;
            if c == '=' || c.is_ascii_whitespace() {
                continue;
            }
            let Some(value) = B32.iter().position(|b| *b as char == c.to_ascii_uppercase())
            else {
                io.err_str("base32: invalid input\n");
                return Ok(1);
            };
            buffer = (buffer << 5) | value as u32;
            bits += 5;
            if bits >= 8 {
                bits -= 8;
                out.push((buffer >> bits) as u8);
            }
        }
        io.write_out(&out);
        return Ok(0);
    }
    let encoded = base32_encode(&input);
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

/* ---------- zcat / uncompress ---------- */

fn zcat(shell: &mut Shell, io: &Io, name: &str, args: &[String]) -> ExecResult {
    let (inputs, status) = read_byte_inputs(shell, io, args, "gzip");
    let mut out_status = status;
    for (_, data) in &inputs {
        match super::compress::gunzip(data) {
            Ok(plain) => io.write_out(&plain),
            Err(error) => {
                io.err_str(&format!("gzip: stdin: {error}\n"));
                out_status = 1;
            }
        }
    }
    let _ = name;
    Ok(out_status)
}

/* ---------- cmp ---------- */

/// A recursive directory copy for the `ln -s` fallback.
fn copy_dir_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let destination = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir_recursive(&entry.path(), &destination)?;
        } else {
            std::fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

/// GNU's operand quoting: file names print inside \u{2018}\u{2019}.
fn q(text: &str) -> String {
    format!("\u{2018}{text}\u{2019}")
}

fn cmp(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut list_all = false;
    let mut silent = false;
    let mut operands: Vec<String> = Vec::new();
    for arg in args {
        match arg.as_str() {
            "-l" | "--list" => list_all = true,
            "-s" | "--quiet" | "--silent" => silent = true,
            "--" => {}
            other if other.starts_with('-') && other.len() > 1 => {
                for c in other[1..].chars() {
                    if c == 'l' {
                        list_all = true;
                    } else if c == 's' {
                        silent = true;
                    }
                }
            }
            other => operands.push(other.to_owned()),
        }
    }
    if operands.len() != 2 {
        io.err_str("cmp: two operands are required\n");
        return Ok(2);
    }
    let read_side = |shell: &Shell, operand: &str| -> Result<Vec<u8>, String> {
        if operand == "-" {
            let mut io_mut = io.clone();
            return Ok(io_mut.read_all_stdin_bytes());
        }
        std::fs::read(shell.resolve_working_path(operand))
            .map_err(|e| format!("{operand}: {}", io_error_text(&e)))
    };
    let left = match read_side(shell, &operands[0]) {
        Ok(bytes) => bytes,
        Err(error) => {
            if !silent {
                io.err_str(&format!("cmp: {error}\n"));
            }
            return Ok(2);
        }
    };
    let right = match read_side(shell, &operands[1]) {
        Ok(bytes) => bytes,
        Err(error) => {
            if !silent {
                io.err_str(&format!("cmp: {error}\n"));
            }
            return Ok(2);
        }
    };
    if left == right {
        return Ok(0);
    }
    let common = left.len().min(right.len());
    let mut listed_diffs = false;
    for at in 0..common {
        if left[at] != right[at] {
            if list_all {
                io.out_str(&format!("{} {:o} {:o}\n", at + 1, left[at], right[at]));
                listed_diffs = true;
            } else if !silent {
                // The line number counts the newlines strictly before the byte.
                let line = left[..at].iter().filter(|byte| **byte == b'\n').count() + 1;
                io.out_str(&format!(
                    "{} {} differ: byte {}, line {}\n",
                    q(&operands[0]),
                    q(&operands[1]),
                    at + 1,
                    line
                ));
                return Ok(1);
            } else {
                return Ok(1);
            }
        }
    }
    if !listed_diffs {
        // One input is a prefix of the other.
        let (which, size) = if left.len() < right.len() {
            (&operands[0], left.len())
        } else {
            (&operands[1], right.len())
        };
        if !silent && !list_all {
            let line = left[..size].iter().filter(|b| **b == b'\n').count() + 1;
            io.err_str(&format!(
                "cmp: EOF on {} after byte {}, in line {}\n",
                q(which),
                size,
                line
            ));
        } else if !silent {
            io.err_str(&format!("cmp: EOF on {} after byte {}\n", q(which), size));
        }
    }
    Ok(1)
}

/* ---------- nl ---------- */

fn nl(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut style = 't';
    let mut width = 6usize;
    let mut separator = "\t".to_owned();
    let mut justify = 'r';
    let mut number = 1i64;
    let mut files: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-ba" | "-at" | "-ta" => style = 'a',
            "-bt" | "-tt" => style = 't',
            "-bn" | "-tn" => style = 'n',
            "-n" => match iter.next().map(String::as_str) {
                Some("ln") => justify = 'l',
                Some("rz") => justify = 'z',
                _ => justify = 'r',
            },
            "-s" => {
                if let Some(sep) = iter.next() {
                    separator = sep.clone();
                }
            }
            "-w" => {
                if let Some(value) = iter.next() {
                    if let Ok(parsed) = value.parse() {
                        width = parsed;
                    }
                }
            }
            "-v" => {
                if let Some(value) = iter.next() {
                    if let Ok(parsed) = value.parse() {
                        number = parsed;
                    }
                }
            }
            "--" => {}
            other if other.starts_with("-w") => {
                if let Ok(parsed) = other[2..].parse() {
                    width = parsed;
                }
            }
            other if other.starts_with("-v") && other.len() > 2 => {
                if let Ok(parsed) = other[2..].parse() {
                    number = parsed;
                }
            }
            other if other.starts_with("-s") && other.len() > 2 => {
                separator = other[2..].to_owned();
            }
            other if other.starts_with('-') && other.len() > 1 => {
                let chars: Vec<char> = other[1..].chars().collect();
                let mut at = 0usize;
                while at < chars.len() {
                    match chars[at] {
                        'a' => style = 'a',
                        't' => style = 't',
                        'p' | 'd' | 'f' | 'h' | 'b' => {}
                        // -n's own argument rides in the cluster: -nrz, -nln.
                        'n' => {
                            let rest: String = chars[at + 1..].iter().collect();
                            if rest == "ln" || rest == "rn" || rest == "rz" {
                                justify = match rest.as_str() {
                                    "ln" => 'l',
                                    "rz" => 'z',
                                    _ => 'r',
                                };
                                at = chars.len();
                                continue;
                            }
                        }
                        _ => {}
                    }
                    at += 1;
                }
            }
            other => files.push(other.to_owned()),
        }
    }
    let inputs = match read_input(shell, &mut io.clone(), &files) {
        Ok(inputs) => inputs,
        Err(error) => {
            io.err_str(&format!("nl: {error}\n"));
            return Ok(1);
        }
    };
    let mut counter = number;
    for (_, text) in &inputs {
        for line in lines_of(text) {
            let numbered = match style {
                'a' => true,
                't' => !line.trim().is_empty(),
                _ => false,
            };
            if !numbered {
                // GNU blanks the whole label — the number field's width plus the
                // separator's own length, all spaces.
                let blank = " ".repeat(width + separator.chars().count());
                io.out_str(&format!("{blank}{line}\n"));
                continue;
            }
            let label = match justify {
                'l' => format!("{counter:<width$}"),
                'z' => format!("{counter:0width$}", width = width),
                _ => format!("{counter:>width$}"),
            };
            io.out_str(&format!("{label}{separator}{line}\n"));
            counter += 1;
        }
    }
    Ok(0)
}

/* ---------- tac ---------- */

fn tac(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut separator = "\n".to_owned();
    let mut before = false;
    let mut files: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-s" => {
                if let Some(sep) = iter.next() {
                    separator = unescape_delims(sep).join("");
                }
            }
            other if other.starts_with("-s") && other.len() > 2 => {
                separator = unescape_delims(&other[2..]).join("");
            }
            "--" => {}
            other if other.starts_with('-') && other.len() > 1 => {
                for c in other[1..].chars() {
                    if c == 'b' {
                        before = true;
                    }
                }
            }
            other => files.push(other.to_owned()),
        }
    }
    let inputs = match read_input(shell, &mut io.clone(), &files) {
        Ok(inputs) => inputs,
        Err(error) => {
            io.err_str(&format!("tac: {error}\n"));
            return Ok(1);
        }
    };
    for (_, text) in &inputs {
        // Records keep their separator attached; the final one may have none.
        let mut records: Vec<String> = Vec::new();
        let mut current = String::new();
        let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            current.push(c);
            let mut sep_chars = separator.chars();
            if c == sep_chars.next().unwrap_or('\0') {
                let mut full = true;
                for want in sep_chars {
                    if chars.peek() != Some(&want) {
                        full = false;
                        break;
                    }
                    current.push(chars.next().unwrap());
                }
                if full {
                    records.push(std::mem::take(&mut current));
                }
            }
        }
        if !current.is_empty() {
            records.push(current);
        }
        if before {
            // `-b`: the separator belongs to the record that follows it — split it
            // off the tail and re-attach to the next record's head.
            let mut split: Vec<String> = Vec::new();
            for record in &records {
                let body = record.strip_suffix(&separator).unwrap_or(record);
                split.push(body.to_owned());
            }
            for (index, record) in split.iter().enumerate().rev() {
                if index + 1 < split.len() {
                    io.out_str(&format!("{separator}{record}"));
                } else {
                    io.out_str(record);
                }
            }
        } else {
            for record in records.iter().rev() {
                io.out_str(record);
            }
        }
    }
    Ok(0)
}

/* ---------- od ---------- */

/// One `od` format: how wide each item prints and how the bytes become text.
enum OdFormat {
    Char,
    Octal1,
    Octal2,
    Hex1,
    Hex2,
    Dec1,
    Dec2,
    Uns1,
    Uns2,
}

impl OdFormat {
    fn parse(text: &str) -> Option<OdFormat> {
        Some(match text {
            "c" => OdFormat::Char,
            "o" | "o2" => OdFormat::Octal2,
            "o1" => OdFormat::Octal1,
            "x" | "x2" => OdFormat::Hex2,
            "x1" => OdFormat::Hex1,
            "d" | "d2" => OdFormat::Dec2,
            "d1" => OdFormat::Dec1,
            "u" | "u2" => OdFormat::Uns2,
            "u1" => OdFormat::Uns1,
            _ => return None,
        })
    }

    /// How many bytes one item consumes.
    fn width_bytes(&self) -> usize {
        match self {
            OdFormat::Char | OdFormat::Octal1 | OdFormat::Hex1 | OdFormat::Dec1
            | OdFormat::Uns1 => 1,
            _ => 2,
        }
    }

    fn item_width(&self) -> usize {
        match self {
            OdFormat::Char => 4,
            OdFormat::Octal1 => 3,
            OdFormat::Octal2 => 6,
            OdFormat::Hex1 => 2,
            OdFormat::Hex2 => 4,
            OdFormat::Dec1 => 4,
            OdFormat::Dec2 => 6,
            OdFormat::Uns1 => 3,
            OdFormat::Uns2 => 5,
        }
    }
}

fn od_char_cell(byte: u8) -> String {
    match byte {
        0 => "\\0".to_owned(),
        7 => "\\a".to_owned(),
        8 => "\\b".to_owned(),
        9 => "\\t".to_owned(),
        b'\n' => "\\n".to_owned(),
        11 => "\\v".to_owned(),
        12 => "\\f".to_owned(),
        b'\r' => "\\r".to_owned(),
        0x20..=0x7e => (byte as char).to_string(),
        // GNU's od -c prints every other non-printable as bare octal, no backslash
        // (an ESC is `033`, a 0xC3 is `303`).
        other => format!("{:03o}", other),
    }
}

fn od(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut radix = 'o';
    let mut formats: Vec<OdFormat> = Vec::new();
    let mut limit: Option<usize> = None;
    let mut skip: usize = 0;
    let mut show_all = false;
    let mut files: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        // Combined spellings first: `-An`, `-tc`.
        if let Some(rest) = arg.strip_prefix("-A") {
            if let Some(c) = rest.chars().next() {
                radix = c;
                continue;
            }
        }
        if let Some(rest) = arg.strip_prefix("-t").filter(|rest| !rest.is_empty()) {
            match OdFormat::parse(rest) {
                Some(format) => {
                    formats.push(format);
                    continue;
                }
                None => {
                    io.err_str(&format!("od: invalid format '{rest}'\n"));
                    return Ok(1);
                }
            }
        }
        let stripped = arg.strip_prefix('-').unwrap_or(arg);
        match stripped {
            "A" => {
                if let Some(value) = iter.next() {
                    if let Some(c) = value.chars().next() {
                        radix = c;
                    }
                }
            }
            "t" | "-format" => {
                if let Some(value) = iter.next() {
                    match OdFormat::parse(value) {
                        Some(format) => formats.push(format),
                        None => {
                            io.err_str(&format!("od: invalid format '{value}'\n"));
                            return Ok(1);
                        }
                    }
                }
            }
            "N" => {
                if let Some(value) = iter.next() {
                    limit = value.parse().ok();
                }
            }
            "j" => {
                if let Some(value) = iter.next() {
                    skip = value
                        .strip_prefix("0x")
                        .and_then(|hex| usize::from_str_radix(hex, 16).ok())
                        .or_else(|| value.parse().ok())
                        .unwrap_or(0);
                }
            }
            "v" => show_all = true,
            "b" => formats.push(OdFormat::Octal1),
            "c" => formats.push(OdFormat::Char),
            "d" => formats.push(OdFormat::Dec2),
            "o" => formats.push(OdFormat::Octal2),
            "x" => formats.push(OdFormat::Hex2),
            "u" => formats.push(OdFormat::Uns2),
            "" => {}
            other => {
                if let Some(format) = OdFormat::parse(other) {
                    formats.push(format);
                } else {
                    files.push(arg.clone());
                }
            }
        }
    }
    let formats = if formats.is_empty() {
        vec![OdFormat::Octal2]
    } else {
        formats
    };
    let (inputs, status) = read_byte_inputs(shell, io, &files, "od");
    let mut data: Vec<u8> = Vec::new();
    for (_, bytes) in &inputs {
        data.extend_from_slice(bytes);
    }
    if skip > 0 {
        data = data.split_off(skip.min(data.len()));
    }
    if let Some(limit) = limit {
        data.truncate(limit);
    }
    let offset_text = |offset: usize| -> String {
        match radix {
            'd' => format!("{offset:07}"),
            'x' => format!("{offset:07x}"),
            'o' => format!("{offset:07o}"),
            _ => String::new(),
        }
    };
    let mut printed_dedup = false;
    let mut previous_line: Option<String> = None;
    let mut offset = 0usize;
    while offset < data.len() {
        let line_bytes: Vec<u8> = data[offset..(offset + 16).min(data.len())].to_vec();
        let mut line = offset_text(offset);
        for format in &formats {
            let width = format.width_bytes();
            let item_width = format.item_width();
            let mut items: Vec<String> = Vec::new();
            let mut at = 0usize;
            while at < line_bytes.len() {
                let take = width.min(line_bytes.len() - at);
                let item = match format {
                    OdFormat::Char => od_char_cell(line_bytes[at]),
                    OdFormat::Octal1 => format!("{:03o}", line_bytes[at]),
                    OdFormat::Octal2 if take == 2 => {
                        format!("{:06o}", u16::from_le_bytes([line_bytes[at], line_bytes[at + 1]]))
                    }
                    OdFormat::Octal2 => format!("{:06o}", line_bytes[at] as u16),
                    OdFormat::Hex1 => format!("{:02x}", line_bytes[at]),
                    OdFormat::Hex2 if take == 2 => {
                        format!("{:04x}", u16::from_le_bytes([line_bytes[at], line_bytes[at + 1]]))
                    }
                    OdFormat::Hex2 => format!("{:04x}", line_bytes[at] as u16),
                    OdFormat::Dec1 => format!("{:4}", line_bytes[at] as i8),
                    OdFormat::Dec2 if take == 2 => {
                        format!("{:6}", i16::from_le_bytes([
                            line_bytes[at],
                            line_bytes[at + 1]
                        ]))
                    }
                    OdFormat::Dec2 => format!("{:6}", line_bytes[at] as i8 as i16),
                    OdFormat::Uns1 => format!("{:3}", line_bytes[at]),
                    OdFormat::Uns2 if take == 2 => {
                        format!("{:5}", u16::from_le_bytes([
                            line_bytes[at],
                            line_bytes[at + 1]
                        ]))
                    }
                    OdFormat::Uns2 => format!("{:5}", line_bytes[at] as u16),
                };
                items.push(format!("{item:>item_width$}"));
                at += take;
            }
            if !items.is_empty() {
                if matches!(format, OdFormat::Char) {
                    line.push_str(&items.join(""));
                } else {
                    line.push_str(&format!(" {}", items.join(" ")));
                }
            }
        }
        offset += line_bytes.len();
        let line = format!("{}\n", line.trim_end());
        // GNU folds runs of identical byte lines into a lone `*` — the offsets
        // march on, so the comparison ignores them.
        let fold_key = line[7..].to_owned();
        if !show_all && previous_line.as_deref() == Some(fold_key.as_str()) {
            if !printed_dedup {
                io.out_str("*\n");
                printed_dedup = true;
            }
        } else {
            io.out_str(&line);
            printed_dedup = false;
        }
        previous_line = Some(fold_key);
    }
    // The closing offset line — the one line an empty input still prints.
    io.out_str(&format!("{}\n", offset_text(offset).trim_end()));
    Ok(status)
}

/* ---------- xxd ---------- */

fn xxd(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut columns = 16usize;
    let mut group = 2usize;
    let mut limit: Option<usize> = None;
    let mut seek: usize = 0;
    let mut plain = false;
    let mut reverse = false;
    let mut upper = false;
    let mut files: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-c" => {
                if let Some(value) = iter.next() {
                    if let Ok(parsed) = value.parse::<usize>() {
                        columns = parsed.clamp(1, 256);
                    }
                }
            }
            "-g" => {
                if let Some(value) = iter.next() {
                    if let Ok(parsed) = value.parse::<usize>() {
                        group = parsed.clamp(1, 16);
                    }
                }
            }
            "-l" => {
                if let Some(value) = iter.next() {
                    limit = value.parse().ok();
                }
            }
            "-s" => {
                if let Some(value) = iter.next() {
                    seek = value.parse().unwrap_or(0);
                }
            }
            "-p" | "-ps" => plain = true,
            "-r" => reverse = true,
            "-u" => upper = true,
            _ => {
                if let Some(value) = arg.strip_prefix("-c") {
                    if let Ok(parsed) = value.parse::<usize>() {
                        columns = parsed.clamp(1, 256);
                        continue;
                    }
                }
                if let Some(value) = arg.strip_prefix("-g") {
                    if let Ok(parsed) = value.parse::<usize>() {
                        group = parsed.clamp(1, 16);
                        continue;
                    }
                }
                if let Some(value) = arg.strip_prefix("-l") {
                    if let Ok(parsed) = value.parse() {
                        limit = Some(parsed);
                        continue;
                    }
                }
                if let Some(value) = arg.strip_prefix("-s") {
                    if let Ok(parsed) = value.parse() {
                        seek = parsed;
                        continue;
                    }
                }
                files.push(arg.clone());
            }
        }
    }
    let (inputs, status) = read_byte_inputs(shell, io, &files, "xxd");
    let mut data: Vec<u8> = Vec::new();
    for (_, bytes) in &inputs {
        data.extend_from_slice(bytes);
    }
    let hex_case = |byte: u8| -> String {
        if upper {
            format!("{byte:02X}")
        } else {
            format!("{byte:02x}")
        }
    };
    if reverse && plain {
        let mut out = Vec::new();
        let mut high: Option<u8> = None;
        for byte in &data {
            let c = *byte as char;
            if !c.is_ascii_hexdigit() {
                continue;
            }
            let digit = c.to_digit(16).unwrap() as u8;
            match high.take() {
                Some(top) => out.push((top << 4) | digit),
                None => high = Some(digit),
            }
        }
        io.write_out(&out);
        return Ok(status);
    }
    if reverse {
        // Classic reverse: each line carries an offset header and the ASCII column;
        // both are skipped — the hex groups between them are the bytes.
        let text = String::from_utf8_lossy(&data).into_owned();
        let mut out = Vec::new();
        let mut position: Option<usize> = None;
        for line in text.lines() {
            let line = line.trim();
            let body = if let Some(at) = line.find(':') {
                let offset_text = &line[..at];
                if let Ok(offset) = usize::from_str_radix(
                    if offset_text.trim_start_matches('0').trim().is_empty() {
                        "0"
                    } else {
                        offset_text.trim()
                    },
                    16,
                ) {
                    position = Some(offset);
                }
                &line[at + 1..]
            } else {
                line
            };
            let chars = body.chars().peekable();
            let mut hex_run = String::new();
            let mut reading_hex = false;
            for c in chars {
                if c.is_ascii_hexdigit() {
                    hex_run.push(c);
                    reading_hex = true;
                } else if reading_hex && c == ' ' {
                    hex_run.push(' ');
                } else if c.is_ascii_whitespace() {
                    if reading_hex {
                        // The double space before the ASCII column ends the hex.
                        break;
                    }
                } else if reading_hex {
                    break;
                }
            }
            for pair in hex_run.split(' ') {
                if pair.len() == 2 {
                    if let Ok(byte) = u8::from_str_radix(pair, 16) {
                        if let Some(at) = position {
                            while out.len() < at {
                                out.push(0);
                            }
                            position = Some(at + 1);
                        }
                        out.push(byte);
                    }
                }
            }
        }
        io.write_out(&out);
        return Ok(status);
    }
    if plain {
        let mut hex = String::new();
        for byte in &data {
            hex.push_str(&hex_case(*byte));
        }
        for chunk in hex.as_bytes().chunks(60) {
            io.out_str(&String::from_utf8_lossy(chunk));
            io.out_str("\n");
        }
        return Ok(status);
    }
    if seek > 0 {
        data = data.split_off(seek.min(data.len()));
    }
    if let Some(limit) = limit {
        data.truncate(limit);
    }
    let groups_per_line = columns.div_ceil(group);
    let hex_area = groups_per_line * (2 * group + 1);
    let mut offset = 0usize;
    while offset < data.len() {
        let line_bytes: Vec<u8> = data[offset..(offset + columns).min(data.len())].to_vec();
        let mut hex_part = String::new();
        for (index, byte) in line_bytes.iter().enumerate() {
            if index % group == 0 && index > 0 {
                hex_part.push(' ');
            }
            hex_part.push_str(&hex_case(*byte));
        }
        let used = hex_part.chars().count();
        let padding = hex_area.saturating_sub(used) + 1;
        let ascii: String = line_bytes
            .iter()
            .map(|byte| {
                if byte.is_ascii_graphic() || *byte == b' ' {
                    *byte as char
                } else {
                    '.'
                }
            })
            .collect();
        io.out_str(&format!(
            "{offset:08x}: {hex_part}{}{ascii}\n",
            " ".repeat(padding)
        ));
        offset += line_bytes.len();
    }
    Ok(status)
}

/* ---------- split ---------- */

fn split_applet(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut lines_per: Option<usize> = None;
    let mut bytes_per: Option<usize> = None;
    let mut numeric = false;
    let mut suffix_len = 2usize;
    let mut extra_suffix = String::new();
    let mut operands: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-l" | "--lines" => {
                if let Some(value) = iter.next() {
                    lines_per = value.parse().ok();
                }
            }
            "-b" | "--bytes" => {
                if let Some(value) = iter.next() {
                    let digits_end = value
                        .find(|c: char| !c.is_ascii_digit())
                        .unwrap_or(value.len());
                    let (number, suffix) = value.split_at(digits_end);
                    let base: usize = number.parse().unwrap_or(0);
                    bytes_per = Some(match suffix {
                        "K" => base * 1024,
                        "M" => base * 1024 * 1024,
                        "G" => base * 1024 * 1024 * 1024,
                        _ => base,
                    });
                }
            }
            "-d" | "--numeric-suffixes" => numeric = true,
            "-a" | "--suffix-length" => {
                if let Some(value) = iter.next() {
                    suffix_len = value.parse().unwrap_or(2).max(1);
                }
            }
            "--additional-suffix" => {
                if let Some(value) = iter.next() {
                    extra_suffix = value.clone();
                }
            }
            "--" => {}
            other => {
                if let Some(value) = other.strip_prefix("--additional-suffix=") {
                    extra_suffix = value.to_owned();
                } else if let Some(value) = other.strip_prefix("-l") {
                    if let Ok(parsed) = value.parse() {
                        lines_per = Some(parsed);
                    }
                } else if let Some(value) = other.strip_prefix("-a").filter(|v| !v.is_empty()) {
                    if let Ok(parsed) = value.parse::<usize>() {
                        suffix_len = parsed.max(1);
                    }
                } else if other.starts_with('-') && other.len() > 1 {
                    for c in other[1..].chars() {
                        if c == 'd' {
                            numeric = true;
                        }
                    }
                } else {
                    operands.push(other.to_owned());
                }
            }
        }
    }
    let (data, prefix) = if operands.is_empty() {
        let mut io_mut = io.clone();
        (io_mut.read_all_stdin_bytes(), "x".to_owned())
    } else if operands.len() == 1 {
        let path = shell.resolve_working_path(&operands[0]);
        match std::fs::read(&path) {
            Ok(bytes) => (bytes, "x".to_owned()),
            Err(error) => {
                io.err_str(&format!(
                    "split: {}: {}
",
                    operands[0],
                    io_error_text(&error)
                ));
                return Ok(1);
            }
        }
    } else {
        let path = shell.resolve_working_path(&operands[0]);
        match std::fs::read(&path) {
            Ok(bytes) => (bytes, operands[1].clone()),
            Err(error) => {
                io.err_str(&format!(
                    "split: {}: {}
",
                    operands[0],
                    io_error_text(&error)
                ));
                return Ok(1);
            }
        }
    };
    // The chunks: by lines (the trailing newline belongs to its line) or bytes.
    let chunks: Vec<&[u8]> = if let Some(bytes_per) = bytes_per.filter(|n| *n > 0) {
        data.chunks(bytes_per).collect()
    } else {
        let per = lines_per.filter(|n| *n > 0).unwrap_or(1000);
        let mut pieces: Vec<&[u8]> = Vec::new();
        let mut start = 0usize;
        let mut seen = 0usize;
        for (at, byte) in data.iter().enumerate() {
            if *byte == b'\n' {
                seen += 1;
                if seen == per {
                    pieces.push(&data[start..=at]);
                    start = at + 1;
                    seen = 0;
                }
            }
        }
        if start < data.len() {
            pieces.push(&data[start..]);
        }
        if pieces.is_empty() {
            pieces.push(&[]);
        }
        pieces
    };
    let alphabet: Vec<u8> = if numeric {
        (b'0'..=b'9').collect()
    } else {
        (b'a'..=b'z').collect()
    };
    let per_digit = alphabet.len();
    for (index, chunk) in chunks.iter().enumerate() {
        let mut suffix = String::new();
        let mut rest = index;
        let mut digits = Vec::new();
        for _ in 0..suffix_len {
            digits.push(alphabet[rest % per_digit]);
            rest /= per_digit;
        }
        for digit in digits.iter().rev() {
            suffix.push(*digit as char);
        }
        let name = format!("{prefix}{suffix}{extra_suffix}");
        let resolved = shell.resolve_working_path(&name);
        if let Err(error) = std::fs::write(&resolved, chunk) {
            io.err_str(&format!(
                "split: cannot open '{name}' for writing: {}
",
                io_error_text(&error)
            ));
            return Ok(1);
        }
    }
    Ok(0)
}

/* ---------- paste ---------- */

fn paste(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut delims_arg = "\t".to_owned();
    let mut serial = false;
    let mut files: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if let Some(body) = arg.strip_prefix('-').filter(|body| !body.is_empty()) {
            // A flag cluster: -s, -dLIST, -sd, ... — the 'd' flag takes the rest
            // of the cluster (or the next argument) as its list.
            let chars: Vec<char> = body.chars().collect();
            let mut at = 0usize;
            while at < chars.len() {
                match chars[at] {
                    's' => serial = true,
                    'd' => {
                        let rest: String = chars[at + 1..].iter().collect();
                        if rest.is_empty() {
                            if let Some(list) = iter.next() {
                                delims_arg = list.clone();
                            }
                        } else {
                            delims_arg = rest;
                        }
                        at = chars.len();
                        continue;
                    }
                    _ => {}
                }
                at += 1;
            }
            continue;
        }
        if arg == "--" {
            continue;
        }
        files.push(arg.clone());
    }
    let delimiters = unescape_delims(&delims_arg);
    let read_file = |shell: &mut Shell, name: &str| -> Vec<String> {
        if name == "-" {
            let mut io_mut = io.clone();
            return lines_of(&io_mut.read_all_stdin()).iter().map(|s| s.to_string()).collect();
        }
        std::fs::read_to_string(shell.resolve_working_path(name))
            .map(|text| lines_of(&text).iter().map(|s| s.to_string()).collect())
            .unwrap_or_default()
    };
    if serial {
        for name in &files {
            let lines = read_file(shell, name);
            let mut line = String::new();
            for (index, _) in lines.iter().enumerate() {
                if index > 0 {
                    let at = if delimiters.is_empty() {
                        0
                    } else {
                        (index - 1) % delimiters.len()
                    };
                    if let Some(delim) = delimiters.get(at).or_else(|| delimiters.last()) {
                        line.push_str(delim);
                    }
                }
                line.push_str(&lines[index]);
            }
            io.out_str(&format!("{line}\n"));
        }
        return Ok(0);
    }
    if files.is_empty() {
        files.push("-".to_owned());
    }
    let columns: Vec<Vec<String>> = files.iter().map(|name| read_file(shell, name)).collect();
    let rows = columns.iter().map(Vec::len).max().unwrap_or(0);
    for row in 0..rows {
        let mut line = String::new();
        for (column, cells) in columns.iter().enumerate() {
            if column > 0 {
                let at = if delimiters.is_empty() {
                    0
                } else {
                    // The last delimiter repeats once the list runs out.
                    (column - 1).min(delimiters.len() - 1)
                };
                if let Some(delim) = delimiters.get(at) {
                    line.push_str(delim);
                }
            }
            if let Some(cell) = cells.get(row) {
                line.push_str(cell);
            }
        }
        io.out_str(&format!("{line}\n"));
    }
    Ok(0)
}

/* ---------- join ---------- */

fn split_join_fields(line: &str, separator: Option<&str>) -> Vec<String> {
    match separator {
        Some(sep) => line.split(sep).map(str::to_owned).collect(),
        None => line.split_whitespace().map(str::to_owned).collect(),
    }
}

fn join(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut separator: Option<String> = None;
    let mut key1 = 1usize;
    let mut key2 = 1usize;
    let mut unpaired: Vec<usize> = Vec::new();
    let mut unpaired_only: Vec<usize> = Vec::new();
    let mut format: Option<String> = None;
    let mut empty = String::new();
    let mut ignore_case = false;
    let mut files: Vec<String> = Vec::new();
    // GNU's combined side flags (-a1, -v2) split before the walk.
    let normalized: Vec<String> = args
        .iter()
        .flat_map(|arg| {
            if let Some(rest) = arg.strip_prefix("-a").filter(|rest| rest.chars().all(|c| c.is_ascii_digit()) && !rest.is_empty()) {
                vec!["-a".to_owned(), rest.to_owned()]
            } else if let Some(rest) = arg.strip_prefix("-v").filter(|rest| rest.chars().all(|c| c.is_ascii_digit()) && !rest.is_empty()) {
                vec!["-v".to_owned(), rest.to_owned()]
            } else if let Some(rest) = arg.strip_prefix("-t").filter(|rest| !rest.is_empty()) {
                vec!["-t".to_owned(), rest.to_owned()]
            } else {
                vec![arg.clone()]
            }
        })
        .collect();
    let mut iter = normalized.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-t" => {
                if let Some(sep) = iter.next() {
                    separator = Some(unescape_delims(sep).join(""));
                }
            }
            "-1" | "-2" | "-j" => {
                let field = iter.next().and_then(|v| v.parse().ok()).unwrap_or(1);
                if arg == "-1" || arg == "-j" {
                    key1 = field;
                }
                if arg == "-2" || arg == "-j" {
                    key2 = field;
                }
            }
            "-a" | "-v" => {
                let side = iter.next().and_then(|v| v.parse::<usize>().ok()).unwrap_or(1);
                if arg == "-a" {
                    unpaired.push(side);
                } else {
                    unpaired_only.push(side);
                }
            }
            "-o" => {
                if let Some(value) = iter.next() {
                    format = Some(value.clone());
                }
            }
            "-e" => {
                if let Some(value) = iter.next() {
                    empty = value.clone();
                }
            }
            "-i" | "--ignore-case" => ignore_case = true,
            "--nocheck-order" | "--check-order" | "--header" => {}
            "--" => {}
            other if other.starts_with('-') && other.len() > 1 => {
                io.err_str(&format!("join: {other}: unsupported option\n"));
                return Ok(1);
            }
            other => files.push(other.to_owned()),
        }
    }
    if files.len() != 2 {
        io.err_str("join: two operands are required\n");
        return Ok(1);
    }
    let read_lines = |shell: &mut Shell, name: &str| -> Vec<String> {
        if name == "-" {
            let mut io_mut = io.clone();
            lines_of(&io_mut.read_all_stdin())
                .iter()
                .map(|s| s.to_string())
                .collect()
        } else {
            std::fs::read_to_string(shell.resolve_working_path(name))
                .map(|text| lines_of(&text).iter().map(|s| s.to_string()).collect())
                .unwrap_or_default()
        }
    };
    let left = read_lines(shell, &files[0]);
    let right = read_lines(shell, &files[1]);
    let sep = separator.clone();
    let fields_of = |line: &str| -> Vec<String> { split_join_fields(line, sep.as_deref()) };
    let key_of = |fields: &[String], which: usize| -> String {
        fields
            .get(which.saturating_sub(1))
            .cloned()
            .unwrap_or_default()
    };
    let keys_equal = |a: &str, b: &str| -> bool {
        if ignore_case {
            a.to_lowercase() == b.to_lowercase()
        } else {
            a == b
        }
    };
    // The output fields of one matched pair — the -o spec's view or the default
    // key-then-both-sides layout. A field a side lacks prints -e's value.
    let format_fields = |a: &[String], b: &[String], key: &str| -> Vec<String> {
        let field = |source: &[String], which: usize| -> String {
            source
                .get(which.saturating_sub(1))
                .cloned()
                .unwrap_or_else(|| empty.clone())
        };
        match &format {
            Some(spec) if spec == "auto" => {
                let mut out = a.to_vec();
                out.extend(b.iter().skip(1).cloned());
                out
            }
            Some(spec) => spec
                .split(',')
                .map(|token| match token {
                    "0" => key.to_owned(),
                    other => {
                        let (file, field_number) = other
                            .split_once('.')
                            .map(|(f, n)| (f, n.parse::<usize>().unwrap_or(1)))
                            .unwrap_or(("1", 1));
                        let source = if file == "2" { b } else { a };
                        field(source, field_number)
                    }
                })
                .collect(),
            None => {
                let mut out = vec![key.to_owned()];
                out.extend(a.iter().skip(1).cloned());
                out.extend(b.iter().skip(1).cloned());
                out
            }
        }
    };
    let out_sep = separator.clone().unwrap_or_else(|| " ".to_owned());
    let emit = |fields: &[String]| {
        io.out_str(&format!("{}\n", fields.join(&out_sep)));
    };
    let show_unpaired = |side: usize| -> bool {
        unpaired.contains(&side) || unpaired_only.contains(&side)
    };
    let emit_side = |fields: &[String], other: &[String], key: &str| {
        if format.is_some() {
            emit(&format_fields(fields, other, key));
        } else {
            emit(fields);
        }
    };
    let show_pairs = unpaired_only.is_empty();
    let mut at_left = 0usize;
    let mut at_right = 0usize;
    while at_left < left.len() && at_right < right.len() {
        let lf = fields_of(&left[at_left]);
        let rf = fields_of(&right[at_right]);
        let lk = key_of(&lf, key1);
        let rk = key_of(&rf, key2);
        if !keys_equal(&lk, &rk) {
            // Whichever key sorts first advances; its line is unpaired output if
            // that side asked for it.
            if lk < rk {
                if show_unpaired(1) {
                    emit_side(&lf, &[], &lk);
                }
                at_left += 1;
            } else {
                if show_unpaired(2) {
                    emit_side(&rf, &[], &rk);
                }
                at_right += 1;
            }
            continue;
        }
        // Equal keys: every pairing of the two runs of equal-key lines.
        let run_left_start = at_left;
        while at_left < left.len() && keys_equal(&key_of(&fields_of(&left[at_left]), key1), &lk) {
            at_left += 1;
        }
        let run_right_start = at_right;
        while at_right < right.len() && keys_equal(&key_of(&fields_of(&right[at_right]), key2), &rk)
        {
            at_right += 1;
        }
        if show_pairs {
            for left_line in &left[run_left_start..at_left] {
                for right_line in &right[run_right_start..at_right] {
                    emit(&format_fields(
                        &fields_of(left_line),
                        &fields_of(right_line),
                        &lk,
                    ));
                }
            }
        }
    }
    while at_left < left.len() {
        if show_unpaired(1) {
            let lf = fields_of(&left[at_left]);
            let key = key_of(&lf, key1);
            emit_side(&lf, &[], &key);
        }
        at_left += 1;
    }
    while at_right < right.len() {
        if show_unpaired(2) {
            let rf = fields_of(&right[at_right]);
            let key = key_of(&rf, key2);
            emit_side(&rf, &[], &key);
        }
        at_right += 1;
    }
    Ok(0)
}

/* ---------- comm ---------- */

fn comm(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    // The column flags are digits (-1, -2, -3, combined -12) — a walk of its own,
    // parse_flags only takes letters.
    let mut flags = String::new();
    let mut paths: Vec<String> = Vec::new();
    for arg in args {
        if let Some(body) = arg.strip_prefix('-').filter(|body| !body.is_empty()) {
            if body.chars().all(|c| matches!(c, '1' | '2' | '3')) {
                flags.push_str(body);
                continue;
            }
        }
        if arg == "--" {
            continue;
        }
        paths.push(arg.clone());
    }
    let read_side = |shell: &Shell, operand: &str| -> Vec<String> {
        if operand == "-" {
            let mut io_mut = io.clone();
            return lines_of(&io_mut.read_all_stdin())
                .iter()
                .map(|s| s.to_string())
                .collect();
        }
        std::fs::read_to_string(shell.resolve_working_path(operand))
            .map(|text| lines_of(&text).iter().map(|s| s.to_string()).collect())
            .unwrap_or_default()
    };
    if paths.len() != 2 {
        io.err_str("comm: two operands are required\n");
        return Ok(1);
    }
    let left = read_side(shell, &paths[0]);
    let right = read_side(shell, &paths[1]);
    let suppress_left = flags.contains('1');
    let suppress_middle = flags.contains('2');
    let suppress_right = flags.contains('3');
    // A suppressed column takes its separator tab with it (GNU's alignment):
    // `comm -12` prints the common lines bare.
    let middle_prefix = if suppress_left { "" } else { "\t" };
    let right_tabs = "\t".repeat((!suppress_left) as usize + (!suppress_middle) as usize);
    let mut li = 0usize;
    let mut ri = 0usize;
    while li < left.len() || ri < right.len() {
        match (left.get(li), right.get(ri)) {
            (Some(l), Some(r)) => {
                if l == r {
                    if !suppress_right {
                        io.out_str(&format!("{right_tabs}{l}\n"));
                    }
                    li += 1;
                    ri += 1;
                } else if l < r {
                    if !suppress_left {
                        io.out_str(&format!("{l}\n"));
                    }
                    li += 1;
                } else {
                    if !suppress_middle {
                        io.out_str(&format!("{middle_prefix}{r}\n"));
                    }
                    ri += 1;
                }
            }
            (Some(l), None) => {
                if !suppress_left {
                    io.out_str(&format!("{l}\n"));
                }
                li += 1;
            }
            (None, Some(r)) => {
                if !suppress_middle {
                    io.out_str(&format!("{middle_prefix}{r}\n"));
                }
                ri += 1;
            }
            (None, None) => break,
        }
    }
    Ok(0)
}

/* ---------- column ---------- */

fn column(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut table = false;
    let mut separators: Option<Vec<char>> = None;
    let mut files: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-t" => table = true,
            "-s" => {
                if let Some(list) = iter.next() {
                    separators = Some(list.chars().collect());
                }
            }
            _ => {
                if let Some(list) = arg.strip_prefix("-s") {
                    separators = Some(list.chars().collect());
                } else if arg.starts_with('-') && arg.len() > 1 && arg[1..].contains('t') {
                    table = true;
                } else {
                    files.push(arg.clone());
                }
            }
        }
    }
    let inputs = match read_input(shell, &mut io.clone(), &files) {
        Ok(inputs) => inputs,
        Err(error) => {
            io.err_str(&format!("column: {error}\n"));
            return Ok(1);
        }
    };
    if table {
        let rows: Vec<Vec<String>> = inputs
            .iter()
            .flat_map(|(_, text)| text.lines())
            .map(|line| match &separators {
                Some(chars) => line
                    .split(|c| chars.contains(&c))
                    .map(str::to_owned)
                    .collect(),
                None => line.split_whitespace().map(str::to_owned).collect(),
            })
            .collect();
        let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
        let widths: Vec<usize> = (0..columns)
            .map(|column| {
                rows.iter()
                    .filter_map(|row| row.get(column))
                    .map(|cell| cell.chars().count())
                    .max()
                    .unwrap_or(0)
            })
            .collect();
        for row in &rows {
            for (column, cell) in row.iter().enumerate() {
                if column + 1 == columns {
                    io.out_str(&format!("{cell}\n"));
                } else {
                    let width = widths.get(column).copied().unwrap_or(0);
                    io.out_str(&format!("{cell:<width$}  ", width = width));
                }
            }
        }
        return Ok(0);
    }
    // The default column fill: entries flow down each column, 80 columns wide —
    // util-linux's own layout: as many columns as fit, then the rows trimmed so
    // the last column carries entries too.
    let entries: Vec<String> = inputs
        .iter()
        .flat_map(|(_, text)| text.split_whitespace())
        .map(str::to_owned)
        .collect();
    if entries.is_empty() {
        return Ok(0);
    }
    let width = entries
        .iter()
        .map(|entry| entry.chars().count())
        .max()
        .unwrap_or(1);
    let gap = 2;
    let mut columns = 80 / (width + gap);
    if columns < 1 {
        columns = 1;
    }
    let mut rows = entries.len().div_ceil(columns);
    while columns > 1 && rows * (columns - 1) >= entries.len() {
        columns -= 1;
        rows = entries.len().div_ceil(columns);
    }
    for row in 0..rows {
        let mut line = String::new();
        for column in 0..columns {
            let at = column * rows + row;
            let Some(entry) = entries.get(at) else {
                break;
            };
            if column + 1 == columns {
                line.push_str(entry);
            } else {
                line.push_str(&format!("{entry:<width$}", width = width + gap));
            }
        }
        io.out_str(&format!("{line}\n"));
    }
    Ok(0)
}

/* ---------- fold ---------- */

fn fold(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut width = 80usize;
    let mut break_at_spaces = false;
    let mut files: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-w" => {
                if let Some(value) = iter.next() {
                    if let Ok(parsed) = value.parse::<usize>() {
                        width = parsed.max(1);
                    }
                }
            }
            _ => {
                if arg == "-s" {
                    break_at_spaces = true;
                } else if let Some(value) = arg.strip_prefix("-w") {
                    if let Ok(parsed) = value.parse::<usize>() {
                        width = parsed.max(1);
                    }
                } else if arg.starts_with('-') && arg.len() > 1 && arg[1..].contains('s') {
                    break_at_spaces = true;
                } else {
                    files.push(arg.clone());
                }
            }
        }
    }
    let inputs = match read_input(shell, &mut io.clone(), &files) {
        Ok(inputs) => inputs,
        Err(error) => {
            io.err_str(&format!("fold: {error}\n"));
            return Ok(1);
        }
    };
    for (_, text) in &inputs {
        for line in lines_of(text) {
            let chars: Vec<char> = line.chars().collect();
            if chars.len() <= width {
                io.out_str(&format!("{line}\n"));
                continue;
            }
            let mut start = 0usize;
            while start < chars.len() {
                let end = (start + width).min(chars.len());
                if break_at_spaces && end < chars.len() {
                    // Break at the last blank inside the window (it stays at the
                    // line's end); never before position start+1, so a blank longer
                    // than the width still hard-breaks.
                    if let Some(blank) = (start..end).rev().find(|at| chars[*at] == ' ') {
                        if blank > start {
                            let out: String = chars[start..=blank].iter().collect();
                            io.out_str(&format!("{out}\n"));
                            start = blank + 1;
                            continue;
                        }
                    }
                }
                let out: String = chars[start..end].iter().collect();
                io.out_str(&format!("{out}\n"));
                start = end;
            }
        }
    }
    Ok(0)
}

/* ---------- expand / unexpand ---------- */

/// The tab stops a `-t` list names: a single number repeats at that width, a list
/// extends beyond its last entry by the final gap (GNU's rule).
fn tab_stops(spec: &str) -> Vec<usize> {
    let values: Vec<usize> = spec
        .split(',')
        .filter_map(|piece| piece.parse().ok())
        .filter(|value| *value > 0)
        .collect();
    match values.len() {
        0 => (1..=512).map(|multiple| multiple * 8).collect(),
        1 => (1..=512).map(|multiple| multiple * values[0]).collect(),
        _ => {
            let last = *values.last().unwrap();
            let gap = values
                .get(values.len() - 2)
                .map(|penultimate| last - penultimate)
                .filter(|gap| *gap > 0)
                .unwrap_or(8);
            let mut stops = values.clone();
            let mut next = last + gap;
            while stops.len() < 512 {
                stops.push(next);
                next += gap;
            }
            stops
        }
    }
}

fn expand_applet(shell: &mut Shell, io: &Io, args: &[String], unexpand: bool) -> ExecResult {
    let mut stops_spec = "8".to_owned();
    let mut leading_only = false;
    let mut all_blanks = false;
    let mut files: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-t" => {
                if let Some(value) = iter.next() {
                    stops_spec = value.clone();
                }
            }
            "-i" => leading_only = true,
            "-a" => all_blanks = true,
            "--" => {}
            other if other.starts_with('-') && other.len() > 1 => {
                if let Some(value) = other.strip_prefix("-t") {
                    stops_spec = value.to_owned();
                } else {
                    for c in other[1..].chars() {
                        if c == 'i' {
                            leading_only = true;
                        }
                        if c == 'a' {
                            all_blanks = true;
                        }
                    }
                }
            }
            other => files.push(other.to_owned()),
        }
    }
    let _ = all_blanks;
    let inputs = match read_input(shell, &mut io.clone(), &files) {
        Ok(inputs) => inputs,
        Err(error) => {
            io.err_str(&format!("{}: {error}\n", if unexpand { "unexpand" } else { "expand" }));
            return Ok(1);
        }
    };
    let stops = tab_stops(&stops_spec);
    for (_, text) in &inputs {
        for line in lines_of(text) {
            if !unexpand {
                // expand: blanks become spaces at the stops; -i leaves everything
                // after the first non-blank alone.
                let mut out = String::new();
                let mut column = 0usize;
                let mut seen_text = false;
                for c in line.chars() {
                    match c {
                        '\t' if !seen_text || !leading_only => {
                            let stop = stops.iter().copied().find(|stop| *stop > column);
                            let next = stop.unwrap_or(column + 8);
                            for _ in column..next {
                                out.push(' ');
                            }
                            column = next;
                        }
                        _ => {
                            out.push(c);
                            column += 1;
                            if c != ' ' && c != '\t' {
                                seen_text = true;
                            }
                        }
                    }
                }
                io.out_str(&format!("{out}\n"));
            } else {
                // unexpand: a run of two or more blanks becomes tabs for every stop
                // the run spans — the leading run only, unless -a says every run.
                let convert = |text: &str| -> String {
                    let mut out = String::new();
                    let mut column = 0usize;
                    // Where the current blank run began: its column and its
                    // position in `out` (an input tab is one char but many
                    // columns — both anchors are needed to splice).
                    let mut run_start_col: Option<usize> = None;
                    let mut run_out_at: Option<usize> = None;
                    let flush = |out: &mut String, column: &mut usize, start_col, out_at| {
                        let (Some(start_col), Some(out_at)) = (start_col, out_at) else {
                            return;
                        };
                        let mut walk = start_col;
                        let mut tabs = 0usize;
                        let run_end = *column;
                        while let Some(&stop) = stops
                            .iter()
                            .find(|&&s| s > walk && s <= run_end)
                        {
                            walk = stop;
                            tabs += 1;
                        }
                        let spaces = *column - walk;
                        out.truncate(out_at);
                        out.push_str(&"\t".repeat(tabs));
                        out.push_str(&" ".repeat(spaces));
                    };
                    for c in text.chars() {
                        if c == ' ' || c == '\t' {
                            if run_start_col.is_none() {
                                run_start_col = Some(column);
                                run_out_at = Some(out.len());
                            }
                            if c == '\t' {
                                let stop = stops
                                    .iter()
                                    .copied()
                                    .find(|stop| *stop > column)
                                    .unwrap_or(column + 8);
                                out.push('\t');
                                column = stop;
                            } else {
                                out.push(' ');
                                column += 1;
                            }
                            continue;
                        }
                        flush(
                            &mut out,
                            &mut column,
                            run_start_col.take(),
                            run_out_at.take(),
                        );
                        out.push(c);
                        column += 1;
                    }
                    flush(&mut out, &mut column, run_start_col.take(), run_out_at.take());
                    out
                };
                // GNU's default and -a agree on the span rule (the leading-only
                // behaviour belongs to --first-only); both walk the whole line.
                io.out_str(&format!("{}\n", convert(line)));
            }
        }
    }
    Ok(0)
}

/* ---------- tsort ---------- */

fn tsort(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (_, files) = parse_flags(args);
    let inputs = match read_input(shell, &mut io.clone(), &files) {
        Ok(inputs) => inputs,
        Err(error) => {
            io.err_str(&format!("tsort: {error}\n"));
            return Ok(1);
        }
    };
    let tokens: Vec<String> = inputs
        .iter()
        .flat_map(|(_, text)| text.split_whitespace())
        .map(str::to_owned)
        .collect();
    if !tokens.len().is_multiple_of(2) {
        io.err_str("tsort: input contains an odd number of tokens\n");
        return Ok(1);
    }
    // Kahn's algorithm over the declared pairs, insertion order breaking ties.
    let mut names: Vec<String> = Vec::new();
    let mut edges: Vec<(usize, usize)> = Vec::new();
    for pair in tokens.chunks(2) {
        let from = names.iter().position(|n| n == &pair[0]).unwrap_or_else(|| {
            names.push(pair[0].clone());
            names.len() - 1
        });
        let to = names.iter().position(|n| n == &pair[1]).unwrap_or_else(|| {
            names.push(pair[1].clone());
            names.len() - 1
        });
        edges.push((from, to));
    }
    let mut pending_in: Vec<usize> = vec![0; names.len()];
    for (_, to) in &edges {
        pending_in[*to] += 1;
    }
    let mut order: Vec<usize> = Vec::new();
    loop {
        let ready: Vec<usize> = (0..names.len())
            .filter(|at| pending_in[*at] == 0 && !order.contains(at))
            .collect();
        if ready.is_empty() {
            break;
        }
        for at in ready {
            order.push(at);
            for (from, to) in &edges {
                if *from == at {
                    pending_in[*to] -= 1;
                }
            }
        }
    }
    let looped = order.len() != names.len();
    for at in &order {
        io.out_str(&format!("{}\n", names[*at]));
    }
    if looped {
        // GNU prints the unresolved members, each on its own error line.
        let mut remaining: Vec<String> = names.clone();
        for at in &order {
            remaining.retain(|n| n != &names[*at]);
        }
        for name in &remaining {
            io.out_str(&format!("{name}\n"));
        }
        io.err_str("tsort: -: input contains a loop:\n");
        for name in &remaining {
            io.err_str(&format!("tsort: {name}\n"));
        }
        return Ok(1);
    }
    Ok(0)
}

/* ---------- expr ---------- */

fn expr(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let _ = shell;
    let tokens: Vec<String> = args.to_vec();
    let mut position = 0usize;

    fn is_number(text: &str) -> bool {
        let body = text.strip_prefix('-').unwrap_or(text);
        !body.is_empty() && body.chars().all(|c| c.is_ascii_digit()) && text.parse::<i64>().is_ok()
    }

    fn truthy(text: &str) -> bool {
        !text.is_empty() && text != "0"
    }

    // The match operator: the matched length, or the first group's text.
    let do_match = |text: &str, pattern: &str, io: &Io| -> String {
        match Regex::compile(pattern, false, false) {
            Ok(regex) => match regex.find(text) {
                Some(found) => {
                    if found.groups.len() > 1 {
                        found.groups[1]
                            .map(|(start, end)| text[start..end].to_owned())
                            .unwrap_or_default()
                    } else {
                        (found.end - found.start).to_string()
                    }
                }
                None => "0".to_owned(),
            },
            Err(error) => {
                io.err_str(&format!("{error}\n"));
                String::new()
            }
        }
    };

    fn compare_text(a: &str, b: &str) -> std::cmp::Ordering {
        if is_number(a) && is_number(b) {
            let (left, right): (i64, i64) = (a.parse().unwrap(), b.parse().unwrap());
            left.cmp(&right)
        } else {
            a.cmp(b)
        }
    }

    fn parse_primary(
        tokens: &[String],
        position: &mut usize,
        io: &Io,
        do_match: &dyn Fn(&str, &str, &Io) -> String,
    ) -> Result<String, String> {
        let token = tokens.get(*position).cloned();
        let Some(token) = token else {
            return Err("expr: syntax error".to_owned());
        };
        *position += 1;
        match token.as_str() {
            "(" => {
                let inner = parse_or(tokens, position, io, do_match)?;
                if tokens.get(*position).map(String::as_str) != Some(")") {
                    return Err("expr: syntax error".to_owned());
                }
                *position += 1;
                Ok(inner)
            }
            "length" => {
                let operand = parse_primary(tokens, position, io, do_match)?;
                Ok(operand.chars().count().to_string())
            }
            "index" => {
                let haystack = parse_primary(tokens, position, io, do_match)?;
                let needles = parse_primary(tokens, position, io, do_match)?;
                let found = haystack
                    .chars()
                    .position(|c| needles.contains(c))
                    .map(|at| at + 1)
                    .unwrap_or(0);
                Ok(found.to_string())
            }
            "substr" => {
                let text = parse_primary(tokens, position, io, do_match)?;
                let start = parse_primary(tokens, position, io, do_match)?;
                let length = parse_primary(tokens, position, io, do_match)?;
                let start = as_int_public(&start);
                let length = as_int_public(&length);
                if start < 1 || length < 0 {
                    return Ok(String::new());
                }
                let chars: Vec<char> = text.chars().collect();
                let from = (start as usize - 1).min(chars.len());
                let to = (from + length as usize).min(chars.len());
                Ok(chars[from..to].iter().collect())
            }
            "match" => {
                let text = parse_primary(tokens, position, io, do_match)?;
                let pattern = parse_primary(tokens, position, io, do_match)?;
                Ok(do_match(&text, &pattern, io))
            }
            other => Ok(other.to_owned()),
        }
    }

    fn as_int_public(text: &str) -> i64 {
        text.parse().unwrap_or(0)
    }

    fn parse_mul(
        tokens: &[String],
        position: &mut usize,
        io: &Io,
        do_match: &dyn Fn(&str, &str, &Io) -> String,
    ) -> Result<String, String> {
        let mut left = parse_primary(tokens, position, io, do_match)?;
        // The match operator binds tighter than the arithmetic ones.
        while tokens.get(*position).map(String::as_str) == Some(":") {
            *position += 1;
            let right = parse_primary(tokens, position, io, do_match)?;
            left = do_match(&left, &right, io);
        }
        loop {
            let op = tokens.get(*position).cloned();
            let Some(op) = op else { break };
            if !matches!(op.as_str(), "*" | "/" | "%") {
                break;
            }
            *position += 1;
            let right = parse_primary(tokens, position, io, do_match)?;
            let (a, b) = (as_int_public(&left), as_int_public(&right));
            left = match (op.as_str(), b) {
                ("/", 0) | ("%", 0) => {
                    return Err("expr: division by zero".to_owned());
                }
                ("/", _) => (a / b).to_string(),
                ("%", _) => (a % b).to_string(),
                _ => (a * b).to_string(),
            };
        }
        Ok(left)
    }

    fn parse_add(
        tokens: &[String],
        position: &mut usize,
        io: &Io,
        do_match: &dyn Fn(&str, &str, &Io) -> String,
    ) -> Result<String, String> {
        let mut left = parse_mul(tokens, position, io, do_match)?;
        loop {
            let op = tokens.get(*position).cloned();
            let Some(op) = op else { break };
            if op != "+" && op != "-" {
                break;
            }
            *position += 1;
            let right = parse_mul(tokens, position, io, do_match)?;
            let (a, b) = (as_int_public(&left), as_int_public(&right));
            left = if op == "+" { a + b } else { a - b }.to_string();
        }
        Ok(left)
    }

    fn parse_rel(
        tokens: &[String],
        position: &mut usize,
        io: &Io,
        do_match: &dyn Fn(&str, &str, &Io) -> String,
    ) -> Result<String, String> {
        let mut left = parse_add(tokens, position, io, do_match)?;
        loop {
            let op = tokens.get(*position).cloned();
            let Some(op) = op else { break };
            if !matches!(op.as_str(), "<" | "<=" | ">" | ">=" | "=" | "==" | "!=") {
                break;
            }
            *position += 1;
            let right = parse_add(tokens, position, io, do_match)?;
            use std::cmp::Ordering::*;
            let ordering = compare_text(&left, &right);
            let result = match op.as_str() {
                "<" => ordering == Less,
                "<=" => ordering != Greater,
                ">" => ordering == Greater,
                ">=" => ordering != Less,
                "!=" => ordering != Equal,
                _ => ordering == Equal,
            };
            left = if result { "1" } else { "0" }.to_owned();
        }
        Ok(left)
    }

    fn parse_and(
        tokens: &[String],
        position: &mut usize,
        io: &Io,
        do_match: &dyn Fn(&str, &str, &Io) -> String,
    ) -> Result<String, String> {
        let mut left = parse_rel(tokens, position, io, do_match)?;
        while tokens.get(*position).map(String::as_str) == Some("&") {
            *position += 1;
            let right = parse_rel(tokens, position, io, do_match)?;
            left = if truthy(&left) && truthy(&right) {
                left
            } else {
                "0".to_owned()
            };
        }
        Ok(left)
    }

    fn parse_or(
        tokens: &[String],
        position: &mut usize,
        io: &Io,
        do_match: &dyn Fn(&str, &str, &Io) -> String,
    ) -> Result<String, String> {
        let mut left = parse_and(tokens, position, io, do_match)?;
        while tokens.get(*position).map(String::as_str) == Some("|") {
            *position += 1;
            let right = parse_and(tokens, position, io, do_match)?;
            left = if truthy(&left) { left } else { right };
        }
        Ok(left)
    }

    match parse_or(&tokens, &mut position, io, &do_match) {
        Ok(result) => {
            if !result.is_empty() {
                io.out_str(&format!("{result}\n"));
            }
            Ok(if truthy(&result) { 0 } else { 1 })
        }
        Err(error) => {
            io.err_str(&format!("{error}\n"));
            Ok(2)
        }
    }
}

/* ---------- factor ---------- */

fn factor(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let (_, operands) = parse_flags(args);
    let mut values: Vec<String> = operands.clone();
    if values.is_empty() {
        let mut io_mut = io.clone();
        values = lines_of(&io_mut.read_all_stdin())
            .iter()
            .flat_map(|line| line.split_whitespace())
            .map(str::to_owned)
            .collect();
    }
    let _ = shell;
    let mut status = 0;
    for value in &values {
        let Ok(number) = value.parse::<u64>() else {
            io.err_str(&format!("factor: \u{2018}{value}\u{2019} is not a valid positive integer\n"));
            status = 1;
            continue;
        };
        let mut primes: Vec<String> = Vec::new();
        let mut rest = number;
        let mut divisor = 2u64;
        while divisor * divisor <= rest {
            while rest % divisor == 0 {
                primes.push(divisor.to_string());
                rest /= divisor;
            }
            divisor += if divisor == 2 { 1 } else { 2 };
        }
        if rest > 1 {
            primes.push(rest.to_string());
        }
        if primes.is_empty() {
            io.out_str(&format!("{number}:\n"));
        } else {
            io.out_str(&format!("{number}: {}\n", primes.join(" ")));
        }
    }
    Ok(status)
}

/* ---------- numfmt ---------- */

fn numfmt(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let _ = shell;
    let mut to: Option<String> = None;
    let mut from: Option<String> = None;
    let mut from_unit: f64 = 1.0;
    let mut to_unit: f64 = 1.0;
    let mut suffix = String::new();
    let mut fields: Vec<String> = Vec::new();
    for arg in args {
        if let Some(value) = arg.strip_prefix("--to=") {
            to = Some(value.to_owned());
        } else if let Some(value) = arg.strip_prefix("--from=") {
            from = Some(value.to_owned());
        } else if let Some(value) = arg.strip_prefix("--from-unit=") {
            from_unit = value.parse().unwrap_or(1.0);
        } else if let Some(value) = arg.strip_prefix("--to-unit=") {
            to_unit = value.parse().unwrap_or(1.0);
        } else if let Some(value) = arg.strip_prefix("--suffix=") {
            suffix = value.to_owned();
        } else if arg.starts_with('-') && arg != "-" {
            // --round, --padding, --header, --field and friends: accepted, inert.
            continue;
        } else {
            fields.push(arg.clone());
        }
    }
    if fields.is_empty() {
        let mut io_mut = io.clone();
        fields = lines_of(&io_mut.read_all_stdin())
            .iter()
            .map(|line| (*line).to_owned())
            .collect();
    }
    const IEC_UNITS: &[(&str, f64)] = &[
        ("K", 1024.0),
        ("M", 1_048_576.0),
        ("G", 1_073_741_824.0),
        ("T", 1_099_511_627_776.0),
        ("P", 1_125_899_906_842_624.0),
        ("E", 1_152_921_504_606_846_976.0),
        ("Z", 1_180_591_620_717_411_303_424.0),
        ("Y", 1_208_925_819_614_629_174_706_176.0),
    ];
    const SI_UNITS: &[(&str, f64)] = &[
        ("K", 1.0e3),
        ("M", 1.0e6),
        ("G", 1.0e9),
        ("T", 1.0e12),
        ("P", 1.0e15),
        ("E", 1.0e18),
        ("Z", 1.0e21),
        ("Y", 1.0e24),
    ];
    // A suffixed number: "1.5K", "2Gi", "-3 M" (the suffix mode is the caller's).
    // IEC input demands the capital letters (GNU: `--from=iec 1.5k` errors);
    // si and auto take either case.
    let parse_number = |text: &str, iec: bool| -> Result<f64, String> {
        let cleaned: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        let body = cleaned.trim_end_matches(|c: char| c.is_ascii_alphabetic());
        let unit = cleaned[body.len()..].to_owned();
        let value: f64 = body
            .parse()
            .map_err(|_| format!("invalid number: '{text}'"))?;
        if unit.is_empty() {
            return Ok(value);
        }
        let letter_raw = unit.chars().next().ok_or("empty suffix")?;
        // GNU rejects the lowercase spellings in every mode (1.5k errors).
        if !letter_raw.is_ascii_uppercase() {
            return Err(format!("invalid suffix in input: \u{2018}{text}\u{2019}"));
        }
        let letter = letter_raw.to_ascii_uppercase();
        let factor: f64 = if iec { 1024.0 } else { 1000.0 };
        let exponent = "KMGTPEZY"
            .find(letter)
            .ok_or_else(|| format!("invalid suffix in input: \u{2018}{text}\u{2019}"))?
            as f64
            + 1.0;
        Ok(value * factor.powf(exponent))
    };
    let status = 0;
    for field in &fields {
        let tokens: Vec<&str> = field.split_whitespace().collect();
        let mut rendered: Vec<String> = Vec::new();
        for token in tokens {
            let mode = from.as_deref().unwrap_or("auto");
            let value = match mode {
                "iec" | "auto" => parse_number(token, true),
                "si" => parse_number(token, false),
                "none" => token
                    .parse::<f64>()
                    .map_err(|_| format!("invalid number: '{token}'")),
                other => {
                    io.err_str(&format!("numfmt: --from={other}: unsupported\n"));
                    return Ok(1);
                }
            };
            let value = match value {
                Ok(value) => value,
                Err(reason) => {
                    io.err_str(&format!("numfmt: {reason}\n"));
                    return Ok(2);
                }
            };
            let scaled = value * from_unit / to_unit;
            let rendered_value = match to.as_deref() {
                Some("iec") | Some("iec-i") => {
                    let with_i = to.as_deref() == Some("iec-i");
                    let mut chosen = (1.0f64, "");
                    for (label, factor) in IEC_UNITS {
                        if scaled / factor >= 1.0 {
                            chosen = (*factor, label);
                        }
                    }
                    let ratio = scaled / chosen.0;
                    // One decimal, rounded from zero — GNU's default.
                    let rounded = (ratio.abs() * 10.0).ceil() / 10.0 * ratio.signum();
                    let unit = if with_i {
                        format!("{}i", chosen.1)
                    } else {
                        chosen.1.to_owned()
                    };
                    format!("{rounded:.1}{unit}")
                }
                Some("si") => {
                    let mut chosen = (1.0f64, "");
                    for (label, factor) in SI_UNITS {
                        if scaled / factor >= 1.0 {
                            chosen = (*factor, label);
                        }
                    }
                    let ratio = scaled / chosen.0;
                    let rounded = (ratio.abs() * 10.0).ceil() / 10.0 * ratio.signum();
                    format!("{rounded:.1}{}", chosen.1)
                }
                Some("none") | None => {
                    if scaled.fract() == 0.0 && scaled.abs() < 9.0e15 {
                        format!("{}", scaled as i64)
                    } else {
                        format!("{scaled}")
                    }
                }
                Some(other) => {
                    io.err_str(&format!("numfmt: --to={other}: unsupported\n"));
                    return Ok(1);
                }
            };
            rendered.push(format!("{rendered_value}{suffix}"));
        }
        io.out_str(&format!("{}\n", rendered.join(" ")));
    }
    Ok(status)
}

/* ---------- shuf / yes ---------- */

fn shuf(io: &Io, args: &[String]) -> ExecResult {
    let mut echo_items = false;
    let mut range: Option<String> = None;
    let mut count: Option<usize> = None;
    let mut repeat = false;
    let mut items: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-e" | "--echo" => echo_items = true,
            "-i" | "--input-range" => {
                if let Some(value) = iter.next() {
                    range = Some(value.clone());
                }
            }
            "-n" | "--head-count" => {
                if let Some(value) = iter.next() {
                    count = value.parse().ok();
                }
            }
            "-r" | "--repeat" => repeat = true,
            "--random-source" => {
                let _ = iter.next();
            }
            "--" => {}
            other if other.starts_with("--") => {}
            other if other.starts_with('-') && other.len() > 1 => {
                for c in other[1..].chars() {
                    match c {
                        'e' => echo_items = true,
                        'r' => repeat = true,
                        'i' | 'n' => {}
                        _ => {}
                    }
                }
            }
            other => items.push(other.to_owned()),
        }
    }
    let lines: Vec<String> = if echo_items {
        items
    } else if let Some(range) = &range {
        let (start, end) = range
            .split_once('-')
            .and_then(|(a, b)| Some((a.parse::<i64>().ok()?, b.parse::<i64>().ok()?)))
            .unwrap_or((0, -1));
        if start > end {
            io.err_str(&format!("shuf: invalid range '{range}'\n"));
            return Ok(1);
        }
        (start..=end).map(|n| n.to_string()).collect()
    } else {
        let mut io_mut = io.clone();
        lines_of(&io_mut.read_all_stdin())
            .iter()
            .map(|s| s.to_string())
            .collect()
    };
    let mut rng = random_state();
    if repeat {
        // `--repeat` streams forever (or to the head count); the broken pipe of a
        // reader like `head` is the stop.
        let mut emitted = 0usize;
        loop {
            let index = (next_random(&mut rng) as usize) % lines.len().max(1);
            io.out_str(&format!("{}\n", lines[index]));
            emitted += 1;
            if io.broken_pipe() {
                break;
            }
            if let Some(count) = count {
                if emitted >= count {
                    break;
                }
            }
        }
        return Ok(0);
    }
    let mut shuffled = lines;
    for at in (1..shuffled.len()).rev() {
        let swap = (next_random(&mut rng) as usize) % (at + 1);
        shuffled.swap(at, swap);
    }
    if let Some(count) = count {
        shuffled.truncate(count);
    }
    for line in &shuffled {
        io.out_str(&format!("{line}\n"));
    }
    Ok(0)
}

fn yes(io: &Io, args: &[String]) -> ExecResult {
    let text = if args.is_empty() {
        "y".to_owned()
    } else {
        args.join(" ")
    };
    let line = format!("{text}\n");
    while !io.broken_pipe() {
        io.out_str(&line);
    }
    Ok(0)
}

/* ---------- stat ---------- */

/// The file's permission bits, MSYS-fashion: 0644 for a plain file, 0755 for a
/// directory or an executable extension, 0444 when the OS marks it read-only.
fn stat_mode_bits(path: &Path, metadata: &std::fs::Metadata) -> u32 {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let executable = matches!(
        extension.as_str(),
        "exe" | "bat" | "cmd" | "com" | "msi" | "ps1" | "sh"
    );
    let readonly = metadata.permissions().readonly();
    if metadata.is_dir() || executable {
        0o755
    } else if readonly {
        0o444
    } else {
        0o644
    }
}

fn mode_symbolic(mode: u32, is_dir: bool) -> String {
    let bit = |flag: u32, letter: char| -> char {
        if mode & flag != 0 {
            letter
        } else {
            '-'
        }
    };
    let head = if is_dir { 'd' } else { '-' };
    format!(
        "{}{}{}{}{}{}{}{}{}{}",
        head,
        bit(0o400, 'r'),
        bit(0o200, 'w'),
        bit(0o100, 'x'),
        bit(0o040, 'r'),
        bit(0o020, 'w'),
        bit(0o010, 'x'),
        bit(0o004, 'r'),
        bit(0o002, 'w'),
        bit(0o001, 'x'),
    )
}

/// A file's time as GNU prints it: `2026-10-14 09:31:57.733175300 +0800`.
fn stat_time(time: std::io::Result<std::time::SystemTime>) -> String {
    let Ok(moment) = time else {
        return "-".to_owned();
    };
    let Ok(span) = moment.duration_since(std::time::UNIX_EPOCH) else {
        return "-".to_owned();
    };
    let secs = span.as_secs() as i64;
    let nanos = span.subsec_nanos();
    let civil = unix_to_local(secs);
    let offset = local_offset_seconds();
    let sign = if offset < 0 { '-' } else { '+' };
    let offset = offset.abs();
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:09} {}{:02}{:02}",
        civil.year,
        civil.month,
        civil.day,
        civil.hour,
        civil.minute,
        civil.second,
        nanos,
        sign,
        offset / 3600,
        (offset % 3600) / 60
    )
}

fn stat(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut format: Option<String> = None;
    let mut operands: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-c" | "--format" | "--printf" => {
                if let Some(value) = iter.next() {
                    format = Some(value.clone());
                }
            }
            "--" => {}
            other => {
                if let Some(value) = other.strip_prefix("--format=") {
                    format = Some(value.to_owned());
                } else if other.starts_with('-') && other.len() > 1 {
                    // -L and friends: accepted, inert (the shell's Windows has no
                    // symlink hop to follow that std can walk).
                } else {
                    operands.push(other.to_owned());
                }
            }
        }
    }
    if operands.is_empty() {
        io.err_str("stat: an operand is required\n");
        return Ok(1);
    }
    let (uid, gid, user) = super::sysinfo::current_identity();
    let group = "UNKNOWN";
    let mut status = 0;
    for operand in &operands {
        let resolved = shell.resolve_working_path(operand);
        let metadata = match std::fs::symlink_metadata(&resolved) {
            Ok(metadata) => metadata,
            Err(error) => {
                io.err_str(&format!(
                    "stat: cannot stat '{operand}': {}
",
                    io_error_text(&error)
                ));
                status = 1;
                continue;
            }
        };
        let is_dir = metadata.is_dir();
        let is_link = resolved.is_symlink();
        let kind = if is_link {
            "symbolic link"
        } else if is_dir {
            "directory"
        } else {
            "regular file"
        };
        let mode = if is_link {
            0o777
        } else {
            stat_mode_bits(&resolved, &metadata)
        };
        let size = metadata.len();
        let blocks = size.div_ceil(512);
        let nlink: u32 = 1;
        // A stable stand-in for the volume/inode pair the OS tables carry.
        let device_source = resolved
            .ancestors()
            .nth(2)
            .unwrap_or(&resolved)
            .display()
            .to_string();
        let device = (fnv1a(device_source.as_bytes()) & 0xffff_ffff) as u32;
        let inode = fnv1a(resolved.display().to_string().to_lowercase().as_bytes());
        let mtime = stat_time(metadata.modified());
        let atime = stat_time(metadata.accessed());
        // Windows tables no change time; mtime is the honest stand-in, and Birth
        // reads the real creation stamp.
        let ctime = mtime.clone();
        let birth = stat_time(metadata.created());
        let mtime_secs = metadata
            .modified()
            .ok()
            .and_then(|moment| {
                moment
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()
                    .map(|span| span.as_secs() as i64)
            })
            .unwrap_or(0);
        let Some(spec) = &format else {
            io.out_str(&format!("  File: {operand}\n"));
            io.out_str(&format!(
                "  Size: {size:<10}\tBlocks: {blocks:<10} IO Block: {:<6} {kind}\n",
                65536
            ));
            io.out_str(&format!(
                "Device: {:08x}h/{}d\tInode: {inode:<19}Links: {nlink}\n",
                device, device
            ));
            io.out_str(&format!(
                "Access: ({mode:04o}/{})  Uid: ({uid}/{user})   Gid: ({gid}/{group:>8})\n",
                mode_symbolic(mode, is_dir)
            ));
            io.out_str(&format!("Access: {atime}\n"));
            io.out_str(&format!("Modify: {mtime}\n"));
            io.out_str(&format!("Change: {ctime}\n"));
            io.out_str(&format!(" Birth: {birth}\n"));
            continue;
        };
        let mut out = String::new();
        let mut chars = spec.chars().peekable();
        while let Some(c) = chars.next() {
            if c != '%' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('n') => out.push_str(operand),
                Some('N') => out.push_str(&format!("'{operand}'")),
                Some('s') => out.push_str(&size.to_string()),
                Some('F') => out.push_str(kind),
                Some('f') => out.push_str(&format!("{mode:04x}")),
                Some('a') => out.push_str(&format!("{mode:o}")),
                Some('A') => out.push_str(&mode_symbolic(mode, is_dir).to_string()),
                Some('u') => out.push_str(&uid.to_string()),
                Some('U') => out.push_str(&user),
                Some('g') => out.push_str(&gid.to_string()),
                Some('G') => out.push_str(group),
                Some('h') => out.push_str(&nlink.to_string()),
                Some('i') => out.push_str(&inode.to_string()),
                Some('d') => out.push_str(&device.to_string()),
                Some('D') => out.push_str(&format!("{device:x}")),
                Some('b') => out.push_str(&blocks.to_string()),
                Some('o') => out.push_str("65536"),
                Some('B') => out.push_str("512"),
                Some('y') => out.push_str(&mtime),
                Some('Y') => out.push_str(&mtime_secs.to_string()),
                Some('x') => out.push_str(&atime),
                Some('z') | Some('Z') => out.push_str(&ctime),
                Some('w') | Some('W') => out.push_str(&birth),
                Some('%') => out.push('%'),
                Some(other) => {
                    out.push('%');
                    out.push(other);
                }
                None => out.push('%'),
            }
        }
        io.out_str(&format!("{out}\n"));
    }
    Ok(status)
}

/* ---------- file ---------- */

fn file(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let brief = args
        .iter()
        .any(|arg| arg == "-b" || arg == "--brief" || (arg.starts_with('-') && arg[1..].contains('b') && !arg.starts_with("--")));
    let operands: Vec<String> = args
        .iter()
        .filter(|arg| !arg.starts_with('-'))
        .cloned()
        .collect();
    if operands.is_empty() {
        io.err_str("file: an operand is required\n");
        return Ok(1);
    }
    // GNU aligns the descriptions when at least two names are asked for AND the
    // longest of them runs 7 characters or more; the column is longest+2.
    let longest = operands.iter().map(|name| name.len()).max().unwrap_or(0);
    let padded = operands.len() > 1 && longest >= 7;
    let label_width = longest + 2;
    let status = 0;
    for operand in &operands {
        let resolved = shell.resolve_working_path(operand);
        let head = match std::fs::metadata(&resolved) {
            Ok(metadata) if metadata.is_dir() => "directory".to_owned(),
            Ok(_) => match std::fs::read(
                &resolved,
            ) {
                Ok(bytes) => describe_bytes(&bytes, &resolved),
                Err(error) => format!(
                    "cannot open `{operand}' ({})",
                    io_error_text(&error)
                )
            },
            Err(error) => {
                format!(
                    "cannot open `{operand}' ({})",
                    io_error_text(&error)
                )
            }
        };
        if brief {
            io.out_str(&format!("{head}\n"));
        } else if padded {
            io.out_str(&format!("{:<width$}{}\n", format!("{operand}:"), head, width = label_width));
        } else {
            io.out_str(&format!("{operand}: {head}\n"));
        }
    }
    Ok(status)
}

/// The magic byte-census behind `file` — the common formats a Git Bash machine
/// actually meets, text detection included. It reads the whole file (the applet
/// already buffered it); the magic tables live in the first 512 bytes.
fn describe_bytes(bytes: &[u8], path: &Path) -> String {
    if bytes.is_empty() {
        return "empty".to_owned();
    }
    let head = &bytes[..bytes.len().min(512)];
    if head.starts_with(b"MZ") {
        return describe_pe(head);
    }
    if head.starts_with(b"\x7fELF") {
        return describe_elf(head);
    }
    if head.starts_with(b"\x1f\x8b") {
        return "gzip compressed data".to_owned();
    }
    if head.starts_with(b"PK\x03\x04") {
        return "Zip archive data".to_owned();
    }
    if head.len() > 261 && &head[257..262] == b"ustar" {
        return "POSIX tar archive".to_owned();
    }
    let png: bool = head.starts_with(b"\x89PNG\r\n\x1a\n");
    let jpg: bool = head.starts_with(b"\xff\xd8\xff");
    let gif: bool = head.starts_with(b"GIF8");
    let bmp: bool = head.starts_with(b"BM") && bytes.len() > 2;
    let ico: bool = head.starts_with(b"\x00\x00\x01\x00");
    let pdf: bool = head.starts_with(b"%PDF");
    if png {
        return "PNG image data".to_owned();
    }
    if jpg {
        return "JPEG image data".to_owned();
    }
    if gif {
        return "GIF image data".to_owned();
    }
    if ico {
        return "MS Windows icon resource".to_owned();
    }
    if bmp {
        return "PC bitmap".to_owned();
    }
    if pdf {
        return "PDF document".to_owned();
    }
    if head.starts_with(b"#!") {
        let line: String = String::from_utf8_lossy(head)
            .lines()
            .next()
            .unwrap_or("")
            .to_owned();
        let mut interpreter = line[2..].split_whitespace().next().unwrap_or("");
        // `/usr/bin/env python3` — the interpreter is env's argument.
        if interpreter.ends_with("env") {
            if let Some(real) = line[2..].split_whitespace().nth(1) {
                if !real.starts_with('-') {
                    interpreter = real;
                }
            }
        }
        let name = std::path::Path::new(interpreter)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let script = match name.as_str() {
            "sh" | "bash" | "dash" | "ash" | "ksh" | "zsh" => "POSIX shell script",
            "python" | "python3" => "Python script",
            "perl" => "Perl script",
            "node" => "Node.js script",
            "ruby" => "Ruby script",
            other => {
                return format!("{other} script, ASCII text executable");
            }
        };
        let charset = if head[..2.min(head.len())].is_ascii() {
            "ASCII"
        } else {
            "Unicode text, UTF-8"
        };
        return format!("{script}, {charset} text executable");
    }
    // Text or data: a NUL or a control char (bar the whitespace ones) makes data.
    let sample = &bytes[..bytes.len().min(1 << 20)];
    let is_text = sample.iter().all(|byte| {
        *byte >= 0x20 || *byte == b'\t' || *byte == b'\n' || *byte == b'\r' || *byte == 0x0c
    });
    if !is_text {
        return "data".to_owned();
    }
    let charset = if sample.iter().all(|byte| byte.is_ascii()) {
        if head.starts_with(b"\xef\xbb\xbf") {
            "UTF-8 Unicode (with BOM)"
        } else {
            "ASCII"
        }
    } else if std::str::from_utf8(sample).is_ok() {
        // GNU's wording for non-ASCII UTF-8.
        "Unicode text, UTF-8"
    } else {
        "ISO-8859"
    };
    let mut description = format!("{charset} text");
    let ends_nl = sample.last() == Some(&b'\n');
    let crlf = sample
        .windows(2)
        .any(|pair| pair == b"\r\n");
    if crlf {
        description.push_str(", with CRLF line terminators");
    } else if !ends_nl {
        description.push_str(", with no line terminators");
    }
    let _ = path;
    description
}

fn describe_pe(head: &[u8]) -> String {
    // e_lfanew at 0x3c; the PE signature, then the COFF machine, then the optional
    // header's magic, OS version and subsystem.
    let read_u16 = |at: usize| -> u16 {
        if at + 2 <= head.len() {
            u16::from_le_bytes([head[at], head[at + 1]])
        } else {
            0
        }
    };
    let pe_at = if head.len() > 0x40 {
        u32::from_le_bytes([head[0x3c], head[0x3d], head[0x3e], head[0x3f]]) as usize
    } else {
        0
    };
    if pe_at + 26 > head.len() || &head[pe_at..pe_at + 4] != b"PE\0\0" {
        return "MS-DOS executable".to_owned();
    }
    let machine = read_u16(pe_at + 4);
    let arch = match machine {
        0x14c => "x86",
        0x8664 => "x86-64",
        0xaa64 => "ARM64",
        0x1c0 => "ARM",
        0x1c4 => "ARM Thumb-2",
        _ => "unknown",
    };
    let optional_at = pe_at + 24;
    let magic = read_u16(optional_at);
    let (class, base_offset) = match magic {
        0x20b => ("PE32+", true),
        0x10b => ("PE32", false),
        _ => return "PE executable".to_owned(),
    };
    let _ = base_offset;
    let major = read_u16(optional_at + 40);
    let minor = read_u16(optional_at + 42);
    let subsystem = read_u16(optional_at + 68);
    let purpose = match subsystem {
        2 => "GUI",
        3 => "console",
        _ => "native",
    };
    let sections = read_u16(pe_at + 6);
    format!(
        "{class} executable for MS Windows {major}.{minor:02} ({purpose}), {arch}, {sections} sections"
    )
}

fn describe_elf(head: &[u8]) -> String {
    if head.len() < 20 {
        return "ELF".to_owned();
    }
    let bits = match head[4] {
        1 => "32-bit",
        _ => "64-bit",
    };
    let order = match head[5] {
        1 => "LSB",
        _ => "MSB",
    };
    let machine = u16::from_le_bytes([head[18], head[19]]);
    let arch = match machine {
        0x03 => "x86",
        0x3e => "x86-64",
        0xb7 => "AArch64",
        0xf3 => "RISC-V",
        _ => "unknown",
    };
    let kind = match head[16] {
        2 => "executable",
        3 => "shared object",
        _ => "object",
    };
    format!("ELF {bits} {order} {kind}, {arch} (SYSV)")
}

/* ---------- truncate ---------- */

fn truncate(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut size: Option<String> = None;
    let mut no_create = false;
    let mut operands: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-s" | "--size" => {
                if let Some(value) = iter.next() {
                    size = Some(value.clone());
                }
            }
            "-c" | "--no-create" => no_create = true,
            "-r" | "--reference" => {
                if let Some(reference) = iter.next() {
                    let resolved = shell.resolve_working_path(reference);
                    size = std::fs::metadata(&resolved)
                        .ok()
                        .map(|metadata| metadata.len().to_string());
                }
            }
            "--" => {}
            other => {
                if let Some(value) = other.strip_prefix("--size=") {
                    size = Some(value.to_owned());
                } else if let Some(value) = other.strip_prefix("-s").filter(|v| !v.is_empty()) {
                    size = Some(value.to_owned());
                } else if other.starts_with('-') && other.len() > 1 && other[1..].contains('c') {
                    no_create = true;
                } else {
                    operands.push(other.to_owned());
                }
            }
        }
    }
    let Some(size) = size else {
        io.err_str("truncate: a size is required (-s)\n");
        return Ok(1);
    };
    if operands.is_empty() {
        io.err_str("truncate: an operand is required\n");
        return Ok(1);
    }
    // GNU: only the bare/K/M/G/T suffixes parse — anything else is an error,
    // never a silent prefix read.
    let multiplier = |text: &str| -> Option<u64> {
        let digits_end = text
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(text.len());
        let (number, suffix) = text.split_at(digits_end);
        let base: u64 = number.parse().ok()?;
        match suffix.to_ascii_uppercase().as_str() {
            "K" => Some(base * 1024),
            "M" => Some(base * 1024 * 1024),
            "G" => Some(base * 1024 * 1024 * 1024),
            "T" => Some(base * 1024_u64.pow(4)),
            "" => Some(base),
            _ => None,
        }
    };
    let mut status = 0;
    for operand in &operands {
        let resolved = shell.resolve_working_path(operand);
        let exists = resolved.exists();
        if !exists && no_create {
            continue;
        }
        let open = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&resolved);
        let file = match open {
            Ok(file) => file,
            Err(error) => {
                io.err_str(&format!(
                    "truncate: cannot open '{operand}' for writing: {}\n",
                    io_error_text(&error)
                ));
                status = 1;
                continue;
            }
        };
        let current = file.metadata().map(|m| m.len()).unwrap_or(0);
        let target = match size.as_bytes().first() {
            Some(b'+') => multiplier(&size[1..]).map(|delta| current.saturating_add(delta)),
            Some(b'-') => multiplier(&size[1..]).map(|delta| current.saturating_sub(delta)),
            Some(b'/') => multiplier(&size[1..])
                .map(|unit| (current / unit.max(1)) * unit.max(1)),
            _ => multiplier(&size),
        };
        let Some(target) = target else {
            io.err_str(&format!(
                "truncate: Invalid number: \u{2018}{size}\u{2019}\n"
            ));
            status = 1;
            continue;
        };
        if let Err(error) = file.set_len(target) {
            io.err_str(&format!(
                "truncate: cannot open '{operand}' for writing: {error}\n"
            ));
            status = 1;
        }
    }
    Ok(status)
}

/* ---------- mktemp ---------- */

fn mktemp(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut directory = false;
    let mut quiet = false;
    let mut prefix_dir: Option<String> = None;
    // The tmpdir-pinning forms: the legacy `-t` and `--tmpdir[=DIR]` both place the
    // template under DIR — the bare form under $TMPDIR — never the caller's shape.
    let mut to_tmpdir = false;
    let mut suffix = String::new();
    let mut template: Option<String> = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-d" => directory = true,
            "-q" => quiet = true,
            "-p" => {
                if let Some(value) = iter.next() {
                    prefix_dir = Some(value.clone());
                }
            }
            "--tmpdir" | "-t" => to_tmpdir = true,
            "--suffix" => {
                if let Some(value) = iter.next() {
                    suffix = value.clone();
                }
            }
            "--" => {}
            other if other.starts_with("--tmpdir=") => {
                prefix_dir = Some(other["--tmpdir=".len()..].to_owned());
            }
            other if other.starts_with("--") => {}
            other if other.starts_with('-') && other.len() > 1 => {
                for c in other[1..].chars() {
                    if c == 'd' {
                        directory = true;
                    }
                    if c == 'q' {
                        quiet = true;
                    }
                }
            }
            other => template = Some(other.to_owned()),
        }
    }
    let _ = quiet;
    let temp_root = shell
        .get_var("TMPDIR")
        .map(|value| shell.resolve_working_path(&value))
        .unwrap_or_else(|| shell.resolve_working_path("/tmp"));
    let had_template = template.is_some();
    let template = template.unwrap_or_else(|| "tmp.XXXXXXXXXX".to_owned());
    let contains_slash = template.contains('/');
    let (dir_part, name_part) = if contains_slash {
        let path = std::path::Path::new(&template);
        let dir = path
            .parent()
            .map(|p| p.display().to_string())
            .filter(|p| !p.is_empty())
            .unwrap_or_default();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or(template.clone());
        (dir, name)
    } else {
        (String::new(), template.clone())
    };
    // GNU's placement (pinned against a live Git Bash, 2026-10-14): a template
    // carrying its own directory is used exactly as given; `-p DIR` and the
    // tmpdir forms pin the base; a bare template — no slash, no modifiers —
    // lands in the CURRENT directory; only the template-less call defaults
    // into $TMPDIR. The printed name keeps the caller's shape (relative stays
    // relative); the tmpdir-based forms print the absolute MSYS path.
    let (base_dir, label, absolute_label) = if !dir_part.is_empty() {
        (
            shell.resolve_working_path(&dir_part),
            format!("{dir_part}/"),
            false,
        )
    } else if let Some(prefix) = &prefix_dir {
        (
            shell.resolve_working_path(prefix),
            format!("{prefix}/"),
            false,
        )
    } else if to_tmpdir || !had_template {
        (temp_root.clone(), String::new(), true)
    } else {
        (shell.cwd.clone(), String::new(), false)
    };
    // The X-run must end the name (before --suffix) and carry at least three X.
    let stem = name_part.strip_suffix(&suffix).unwrap_or(&name_part);
    let x_count = stem.chars().rev().take_while(|c| *c == 'X').count();
    if x_count < 3 {
        io.err_str(&format!(
            "mktemp: too few X's in template \u{2018}{template}\u{2019}\n"
        ));
        return Ok(1);
    }
    let prefix = &stem[..stem.len() - x_count];
    let mut rng = random_state();
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    for _ in 0..100 {
        let mut name = prefix.to_owned();
        for _ in 0..x_count {
            name.push(ALPHABET[(next_random(&mut rng) as usize) % ALPHABET.len()] as char);
        }
        name.push_str(&suffix);
        let candidate = base_dir.join(&name);
        let made = if directory {
            std::fs::create_dir(&candidate)
        } else {
            std::fs::write(&candidate, b"").and(Ok(()))
        };
        if made.is_ok() {
            let shown = if absolute_label {
                super::msys::to_msys(&candidate)
            } else {
                format!("{label}{name}")
            };
            io.out_str(&format!("{shown}\n"));
            return Ok(0);
        }
    }
    io.err_str("mktemp: failed to create file via template\n");
    Ok(1)
}

/* ---------- shred ---------- */

fn shred(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut passes = 3usize;
    let mut remove = false;
    let mut zero = false;
    let mut operands: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-n" | "--iterations" => {
                if let Some(value) = iter.next() {
                    passes = value.parse().unwrap_or(3);
                }
            }
            "-u" => remove = true,
            "-z" | "--zero" => zero = true,
            "--" => {}
            other if other.starts_with("--") => {}
            other if other.starts_with('-') && other.len() > 1 => {
                for c in other[1..].chars() {
                    if c == 'u' {
                        remove = true;
                    }
                    if c == 'z' {
                        zero = true;
                    }
                }
            }
            other => operands.push(other.to_owned()),
        }
    }
    if operands.is_empty() {
        io.err_str("shred: an operand is required\n");
        return Ok(1);
    }
    let mut status = 0;
    let mut rng = random_state();
    for operand in &operands {
        let resolved = shell.resolve_working_path(operand);
        let size = match std::fs::metadata(&resolved) {
            Ok(metadata) => metadata.len() as usize,
            Err(error) => {
                io.err_str(&format!(
                    "shred: {operand}: {}\n",
                    io_error_text(&error)
                ));
                status = 1;
                continue;
            }
        };
        let Ok(mut file) = std::fs::OpenOptions::new().write(true).open(&resolved) else {
            io.err_str(&format!("shred: {operand}: Permission denied\n"));
            status = 1;
            continue;
        };
        for pass in 0..passes + if zero { 1 } else { 0 } {
            let mut buffer = vec![0u8; size.min(1 << 20)];
            let mut written = 0usize;
            while written < size {
                if zero && pass == passes {
                    buffer.iter_mut().for_each(|byte| *byte = 0);
                } else {
                    buffer.iter_mut().for_each(|byte| {
                        *byte = next_random(&mut rng) as u8;
                    });
                }
                let chunk = buffer.len().min(size - written);
                use std::io::Write;
                let _ = file.write_all(&buffer[..chunk]);
                written += chunk;
            }
            let _ = file.sync_all();
        }
        drop(file);
        if remove {
            let _ = std::fs::remove_file(&resolved);
        }
    }
    Ok(status)
}

/* ---------- install ---------- */

fn install(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut make_dirs = false;
    let mut target_dir: Option<String> = None;
    let mut create_leading = false;
    let mut sources: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-d" | "--directory" => make_dirs = true,
            "-D" => create_leading = true,
            "-t" | "--target-directory" => {
                if let Some(value) = iter.next() {
                    target_dir = Some(value.clone());
                }
            }
            "-m" | "--mode" | "-o" | "--owner" | "-g" | "--group" | "-p" | "--preserve-timestamps" => {
                // Modes, owners and stamps: accepted; the shell's Windows tables
                // have no place to keep them.
                if matches!(arg.as_str(), "-m" | "-o" | "-g") || matches!(arg.as_str(), "--mode" | "--owner" | "--group") {
                    let _ = iter.next();
                }
            }
            "--" => {}
            other if other.starts_with('-') && other.len() > 1 => {
                for c in other[1..].chars() {
                    if c == 'd' {
                        make_dirs = true;
                    }
                    if c == 'D' {
                        create_leading = true;
                    }
                }
            }
            other => sources.push(other.to_owned()),
        }
    }
    if make_dirs {
        let mut status = 0;
        for dir in &sources {
            let resolved = shell.resolve_working_path(dir);
            if let Err(error) = std::fs::create_dir_all(&resolved) {
                io.err_str(&format!(
                    "install: cannot create directory '{dir}': {}\n",
                    io_error_text(&error)
                ));
                status = 1;
            }
        }
        return Ok(status);
    }
    if sources.is_empty() {
        io.err_str("install: an operand is required\n");
        return Ok(1);
    }
    let (sources, destination) = if let Some(dir) = &target_dir {
        (sources.clone(), shell.resolve_working_path(dir))
    } else if sources.len() < 2 {
        io.err_str("install: a destination is required\n");
        return Ok(1);
    } else {
        let last = sources.last().unwrap().clone();
        (
            sources[..sources.len() - 1].to_vec(),
            shell.resolve_working_path(&last),
        )
    };
    let mut status = 0;
    for source in &sources {
        let from = shell.resolve_working_path(source);
        let to = if destination.is_dir() || target_dir.is_some() {
            destination.join(
                std::path::Path::new(source)
                    .file_name()
                    .unwrap_or_default(),
            )
        } else {
            destination.clone()
        };
        if create_leading || target_dir.is_some() {
            if let Some(parent) = to.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
        }
        match std::fs::read(&from).map(|data| std::fs::write(&to, data)) {
            Ok(Ok(())) => {}
            Ok(Err(error)) | Err(error) => {
                io.err_str(&format!(
                    "install: cannot copy '{source}' to '{}': {}\n",
                    to.display(),
                    io_error_text(&error)
                ));
                status = 1;
            }
        }
    }
    Ok(status)
}

/* ---------- link / unlink ---------- */

fn link_applet(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let operands: Vec<String> = args
        .iter()
        .filter(|arg| !arg.starts_with('-'))
        .cloned()
        .collect();
    if operands.len() != 2 {
        io.err_str("link: two operands are required\n");
        return Ok(1);
    }
    let (existing, new) = (
        shell.resolve_working_path(&operands[0]),
        shell.resolve_working_path(&operands[1]),
    );
    match std::fs::hard_link(&existing, &new) {
        Ok(()) => Ok(0),
        Err(error) => {
            io.err_str(&format!(
                "link: cannot create link '{}' to '{}': {}\n",
                operands[1],
                operands[0],
                io_error_text(&error)
            ));
            Ok(1)
        }
    }
}

fn unlink_applet(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let operands: Vec<String> = args
        .iter()
        .filter(|arg| !arg.starts_with('-'))
        .cloned()
        .collect();
    let Some(operand) = operands.first() else {
        io.err_str("unlink: an operand is required\n");
        return Ok(1);
    };
    let resolved = shell.resolve_working_path(operand);
    match std::fs::remove_file(&resolved) {
        Ok(()) => Ok(0),
        Err(error) => {
            io.err_str(&format!(
                "unlink: cannot unlink '{operand}': {}\n",
                io_error_text(&error)
            ));
            Ok(1)
        }
    }
}

/* ---------- dd ---------- */

fn dd(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut input: Option<String> = None;
    let mut output: Option<String> = None;
    let mut input_block = 512usize;
    let mut output_block = 512usize;
    let mut skip = 0usize;
    let mut seek = 0usize;
    let mut count: Option<usize> = None;
    let mut no_transfer_stats = false;
    let mut notrunc = false;
    for arg in args {
        let Some((key, value)) = arg.split_once('=') else {
            io.err_str(&format!("dd: unrecognized operand '{arg}'\n"));
            return Ok(1);
        };
        let parse_size = |text: &str| -> Option<usize> {
            let digits_end = text
                .find(|c: char| !c.is_ascii_digit() && c != 'x' && c != 'b')
                .unwrap_or(text.len());
            let (number, suffix) = text.split_at(digits_end);
            let base: usize = number.parse().ok()?;
            match suffix {
                "kB" => Some(base * 1000),
                "K" => Some(base * 1024),
                "MB" => Some(base * 1000 * 1000),
                "M" => Some(base * 1024 * 1024),
                "GB" => Some(base * 1000 * 1000 * 1000),
                "G" => Some(base * 1024 * 1024 * 1024),
                "b" | "" => Some(base),
                _ => None,
            }
        };
        match key {
            "if" => input = Some(value.to_owned()),
            "of" => output = Some(value.to_owned()),
            "bs" => {
                let Some(size) = parse_size(value) else {
                    io.err_str(&format!("dd: invalid number '{value}'\n"));
                    return Ok(1);
                };
                input_block = size;
                output_block = size;
            }
            "ibs" => input_block = parse_size(value).unwrap_or(512),
            "obs" => output_block = parse_size(value).unwrap_or(512),
            "skip" => skip = value.parse().unwrap_or(0),
            "seek" => seek = value.parse().unwrap_or(0),
            "count" => count = value.parse().ok(),
            "status" => no_transfer_stats = value == "none" || value == "noxfer",
            "conv" => notrunc = value.split(',').any(|piece| piece == "notrunc"),
            other => {
                io.err_str(&format!("dd: invalid operand '{other}={value}'\n"));
                return Ok(1);
            }
        }
    }
    let started = std::time::Instant::now();
    let mut data: Vec<u8> = match &input {
        Some(path) => {
            let resolved = shell.resolve_working_path(path);
            match std::fs::read(&resolved) {
                Ok(bytes) => bytes,
                Err(error) => {
                    io.err_str(&format!(
                        "dd: failed to open '{path}': {}\n",
                        io_error_text(&error)
                    ));
                    return Ok(1);
                }
            }
        }
        None => {
            let mut io_mut = io.clone();
            io_mut.read_all_stdin_bytes()
        }
    };
    if skip > 0 {
        data = data.split_off((skip * input_block).min(data.len()));
    }
    if let Some(count) = count {
        data.truncate(count * input_block);
    }
    let total = data.len();
    let mut sink: Box<dyn std::io::Write> = match &output {
        Some(path) => {
            let resolved = shell.resolve_working_path(path);
            match std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(!notrunc)
                .open(&resolved)
            {
                Ok(file) => {
                    let mut file = file;
                    if seek > 0 {
                        use std::io::Seek;
                        let _ = file.seek(std::io::SeekFrom::Start(
                            (seek * output_block) as u64,
                        ));
                    }
                    Box::new(file)
                }
                Err(error) => {
                    io.err_str(&format!(
                        "dd: failed to open '{path}': {}\n",
                        io_error_text(&error)
                    ));
                    return Ok(1);
                }
            }
        }
        None => Box::new(std::io::stdout()),
    };
    use std::io::Write;
    let mut written = 0usize;
    while written < total {
        let chunk = output_block.min(total - written);
        if sink.write_all(&data[written..written + chunk]).is_err() {
            io.err_str("dd: write error\n");
            return Ok(1);
        }
        written += chunk;
    }
    let _ = sink.flush();
    let _ = io;
    if !no_transfer_stats {
        let full_in = total / input_block;
        let part_in = !total.is_multiple_of(input_block) as usize;
        let full_out = total / output_block;
        let part_out = !total.is_multiple_of(output_block) as usize;
        let elapsed = started.elapsed().as_secs_f64();
        let line = if total > 0 {
            let rate = total as f64 / elapsed.max(1e-9) / 1000.0;
            format!(
                "{total} bytes copied, {elapsed:.4} s, {rate:.1} kB/s\n"
            )
        } else {
            "0 bytes copied, 0.0000 s\n".to_string()
        };
        io.err_str(&format!("{full_in}+{part_in} records in\n"));
        io.err_str(&format!("{full_out}+{part_out} records out\n"));
        io.err_str(&line);
    }
    Ok(0)
}

/* ---------- iconv ---------- */

fn normalize_charset(text: &str) -> String {
    text.chars()
        .filter(|c| *c != '-' && *c != '_' && *c != ' ')
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn iconv(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut from = "utf8".to_owned();
    let mut to = "utf8".to_owned();
    let mut list = false;
    let mut files: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-f" | "--from-code" => {
                if let Some(value) = iter.next() {
                    from = normalize_charset(value);
                }
            }
            "-t" | "--to-code" => {
                if let Some(value) = iter.next() {
                    to = normalize_charset(value);
                }
            }
            "-l" | "--list" => list = true,
            "--" => {}
            other => {
                if let Some(value) = other.strip_prefix("--from-code=") {
                    from = normalize_charset(value);
                } else if let Some(value) = other.strip_prefix("--to-code=") {
                    to = normalize_charset(value);
                } else if !other.starts_with('-') {
                    files.push(other.to_owned());
                }
            }
        }
    }
    let supported: &[&str] = &[
        "utf8", "utf16", "utf16le", "utf16be", "utf32", "utf32le", "utf32be", "ascii",
        "usascii", "ansi", "iso88591", "latin1", "cp1252", "windows1252", "1252",
    ];
    if list {
        for name in supported {
            io.out_str(&format!("{name}\n"));
        }
        return Ok(0);
    }
    let known = |name: &str| -> bool {
        supported.contains(&name) || codepage_of(name).is_some()
    };
    if !known(&from) || !known(&to) {
        io.err_str(&format!(
            "iconv: conversion from '{from}' to '{to}' is not supported\n"
        ));
        return Ok(1);
    }
    if from == to {
        // Same codeset: the byte passthrough GNU grants.
        let (inputs, status) = read_byte_inputs(shell, io, &files, "iconv");
        for (_, data) in &inputs {
            io.write_out(data);
        }
        return Ok(status);
    }
    let cp1252_high: [Option<char>; 32] = [
        Some('€'), None, Some('‚'), Some('ƒ'), Some('„'), Some('…'), Some('†'),
        Some('‡'), Some('ˆ'), Some('‰'), Some('Š'), Some('‹'), Some('Œ'), None,
        Some('Ž'), None, Some('‘'), Some('’'), Some('“'), Some('”'), Some('•'),
        Some('–'), Some('—'), Some('˜'), Some('™'), Some('š'), Some('›'), Some('œ'),
        None, Some('ž'), Some('Ÿ'), None,
    ];
    // decode → String → encode; every illegal byte reports its offset. The BOM'd
    // `utf-16`/`utf-32` spellings resolve to their endian form before the walk.
    fn decode(charset: &str, data: &[u8]) -> Result<String, usize> {
        match charset {
            "utf8" => std::str::from_utf8(data)
                .map(str::to_owned)
                .map_err(|error| error.valid_up_to()),
            "utf16le" | "utf16be" => {
                let be = charset == "utf16be";
                let mut units = Vec::new();
                let mut at = 0usize;
                while at + 1 < data.len() {
                    let unit = if be {
                        u16::from_be_bytes([data[at], data[at + 1]])
                    } else {
                        u16::from_le_bytes([data[at], data[at + 1]])
                    };
                    units.push(unit);
                    at += 2;
                }
                if at < data.len() {
                    return Err(at);
                }
                String::from_utf16(&units).map_err(|_| data.len())
            }
            "utf16" => {
                if data.starts_with(&[0xfe, 0xff]) {
                    return decode("utf16be", &data[2..]);
                }
                if data.starts_with(&[0xff, 0xfe]) {
                    return decode("utf16le", &data[2..]);
                }
                decode("utf16le", data)
            }
            "utf32le" | "utf32be" => {
                let mut text = String::new();
                let mut at = 0usize;
                while at < data.len() {
                    if at + 4 > data.len() {
                        return Err(at);
                    }
                    let word = if charset == "utf32be" {
                        u32::from_be_bytes([
                            data[at],
                            data[at + 1],
                            data[at + 2],
                            data[at + 3],
                        ])
                    } else {
                        u32::from_le_bytes([
                            data[at],
                            data[at + 1],
                            data[at + 2],
                            data[at + 3],
                        ])
                    };
                    match char::from_u32(word) {
                        Some(c) => text.push(c),
                        None => return Err(at),
                    }
                    at += 4;
                }
                Ok(text)
            }
            "utf32" => {
                if data.starts_with(&[0x00, 0x00, 0xfe, 0xff]) {
                    return decode("utf32be", &data[4..]);
                }
                if data.starts_with(&[0xff, 0xfe, 0x00, 0x00]) {
                    return decode("utf32le", &data[4..]);
                }
                decode("utf32le", data)
            }
            "ascii" | "usascii" => {
                for (at, byte) in data.iter().enumerate() {
                    if *byte > 0x7f {
                        return Err(at);
                    }
                }
                Ok(String::from_utf8_lossy(data).into_owned())
            }
            // latin1 and friends: every byte is its code point.
            _ => Ok(data.iter().map(|byte| *byte as char).collect::<String>()),
        }
    }
    fn encode(charset: &str, text: &str, cp1252_high: &[Option<char>; 32]) -> Result<Vec<u8>, String> {
        match charset {
            "utf8" => Ok(text.as_bytes().to_vec()),
            "utf16le" => Ok(text
                .encode_utf16()
                .flat_map(|unit| unit.to_le_bytes())
                .collect()),
            "utf16be" => Ok(text
                .encode_utf16()
                .flat_map(|unit| unit.to_be_bytes())
                .collect()),
            "utf16" => {
                let mut bytes = vec![0xff, 0xfe];
                bytes.extend(text.encode_utf16().flat_map(|unit| unit.to_le_bytes()));
                Ok(bytes)
            }
            "utf32le" | "utf32be" => {
                let mut bytes = Vec::new();
                for c in text.chars() {
                    let word = c as u32;
                    if charset == "utf32be" {
                        bytes.extend(word.to_be_bytes());
                    } else {
                        bytes.extend(word.to_le_bytes());
                    }
                }
                Ok(bytes)
            }
            "utf32" => {
                let mut bytes = vec![0xff, 0xfe, 0x00, 0x00];
                bytes.extend(text.chars().flat_map(|c| (c as u32).to_le_bytes()));
                Ok(bytes)
            }
            "ascii" | "usascii" => {
                for c in text.chars() {
                    if (c as u32) > 0x7f {
                        return Err("iconv: cannot convert".to_owned());
                    }
                }
                Ok(text.as_bytes().to_vec())
            }
            "cp1252" | "windows1252" | "1252" => {
                let mut bytes = Vec::new();
                for c in text.chars() {
                    let code = c as u32;
                    let byte = if code <= 0x7f || (0xa0..=0xff).contains(&code) {
                        code as u8
                    } else if let Some(slot) = cp1252_high.iter().position(|mapped| *mapped == Some(c)) {
                        0x80 + slot as u8
                    } else {
                        return Err("iconv: cannot convert".to_owned());
                    };
                    bytes.push(byte);
                }
                Ok(bytes)
            }
            // latin1 / iso88591 / ansi: code points ≤ 0xff.
            _ => {
                let mut bytes = Vec::new();
                for c in text.chars() {
                    let code = c as u32;
                    if code > 0xff {
                        return Err("iconv: cannot convert".to_owned());
                    }
                    bytes.push(code as u8);
                }
                Ok(bytes)
            }
        }
    }
    let (inputs, status) = read_byte_inputs(shell, io, &files, "iconv");
    let mut out_status = status;
    for (_, data) in &inputs {
        // A codepage charset rides Win32's own converters (cp936/GBK, big5,
        // shift_jis, euc-kr, koi8-r…): bytes -> UTF-16 -> the target.
        let from_cp = codepage_of(&from);
        let to_cp = codepage_of(&to);
        let text: String = if let Some(cp) = from_cp {
            match mb_to_wide(cp, data) {
                Ok(text) => text,
                Err(at) => {
                    io.err_str(&format!(
                        "iconv: (stdin):1:{at}: cannot convert\n"
                    ));
                    out_status = 1;
                    continue;
                }
            }
        } else {
            match decode(&from, data) {
                Ok(text) => text,
                Err(position) => {
                    io.err_str(&format!(
                        "iconv: illegal input sequence at position {position}\n"
                    ));
                    out_status = 1;
                    continue;
                }
            }
        };
        let bytes: Vec<u8> = if let Some(cp) = to_cp {
            match wide_to_mb(cp, &text) {
                Ok(bytes) => bytes,
                Err(_) => {
                    io.err_str("iconv: cannot convert\n");
                    out_status = 1;
                    continue;
                }
            }
        } else {
            match encode(&to, &text, &cp1252_high) {
                Ok(bytes) => bytes,
                Err(_) => {
                    // GNU emits the convertible PREFIX, then the column it
                    // stopped at (the bytes converted so far).
                    let mut prefix = String::new();
                    let mut consumed = 0usize;
                    for c in text.chars() {
                        let mut piece = prefix.clone();
                        piece.push(c);
                        match encode(&to, &piece, &cp1252_high) {
                            Ok(_) => {
                                prefix = piece;
                                consumed += c.len_utf8();
                            }
                            Err(_) => break,
                        }
                    }
                    io.out_str(&prefix);
                    io.err_str(&format!(
                        "\niconv: (stdin):1:{}: cannot convert\n",
                        consumed
                    ));
                    out_status = 1;
                    continue;
                }
            }
        };
        io.write_out(&bytes);
    }
    Ok(out_status)
}

/// The Windows codepage behind an iconv charset name — every cp/Windows-NNN
/// spelling plus the classic aliases.
fn codepage_of(name: &str) -> Option<u32> {
    let digits: String = name
        .trim_start_matches("cp")
        .trim_start_matches("windows")
        .trim_start_matches('-')
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if !digits.is_empty() {
        if let Ok(cp) = digits.parse::<u32>() {
            return Some(cp);
        }
    }
    match name {
        "gbk" | "gb2312" | "csgb2312" => Some(936),
        "big5" | "big5hkscs" => Some(950),
        "shiftjis" | "sjis" | "pck" | "mskanji" => Some(932),
        "eucjp" | "eucjpms" | "ujis" => Some(20932),
        "euckr" => Some(949),
        "koi8r" => Some(20866),
        "koi8u" => Some(21866),
        "tis620" => Some(874),
        "cp1252" | "windows1252" | "1252" => None, // the pure table already serves it
        _ => None,
    }
}

#[cfg(windows)]
fn mb_to_wide(codepage: u32, bytes: &[u8]) -> Result<String, usize> {
    // MultiByteToWideChar in two passes: count, convert; 0x8 for errors, and the
    // failing offset recovered by a forward scan of decodable prefixes.
    use std::os::raw::c_int;
    #[link(name = "kernel32")]
    extern "system" {
        fn MultiByteToWideChar(
            codepage: u32,
            flags: u32,
            bytes: *const u8,
            length: c_int,
            wide: *mut u16,
            wide_length: c_int,
        ) -> c_int;
    }
    unsafe {
        let size = MultiByteToWideChar(codepage, 0x8, bytes.as_ptr(), bytes.len() as c_int, std::ptr::null_mut(), 0);
        if size <= 0 {
            // Walk prefixes to name the failing byte position (1-based col).
            let mut at = 0usize;
            while at < bytes.len() {
                let probe = MultiByteToWideChar(codepage, 0x8, bytes.as_ptr(), (at + 1) as c_int, std::ptr::null_mut(), 0);
                if probe <= 0 {
                    return Err(at + 1);
                }
                at += 1;
            }
            return Err(bytes.len());
        }
        let mut wide = vec![0u16; size as usize];
        MultiByteToWideChar(codepage, 0x8, bytes.as_ptr(), bytes.len() as c_int, wide.as_mut_ptr(), size);
        Ok(String::from_utf16_lossy(&wide))
    }
}

#[cfg(not(windows))]
fn mb_to_wwide(_codepage: u32, _bytes: &[u8]) -> Result<String, usize> {
    Err(0)
}

#[cfg(not(windows))]
fn mb_to_wide(_codepage: u32, _bytes: &[u8]) -> Result<String, usize> {
    Err(0)
}

#[cfg(windows)]
fn wide_to_mb(codepage: u32, text: &str) -> Result<Vec<u8>, ()> {
    use std::os::raw::c_int;
    #[link(name = "kernel32")]
    extern "system" {
        fn WideCharToMultiByte(
            codepage: u32,
            flags: u32,
            wide: *const u16,
            wide_length: c_int,
            bytes: *mut u8,
            byte_length: c_int,
            default_char: *const u8,
            used_default: *mut i32,
        ) -> c_int;
    }
    let wide: Vec<u16> = text.encode_utf16().collect();
    unsafe {
        let size = WideCharToMultiByte(codepage, 0, wide.as_ptr(), wide.len() as c_int, std::ptr::null_mut(), 0, std::ptr::null(), std::ptr::null_mut());
        if size <= 0 {
            return Err(());
        }
        let mut bytes = vec![0u8; size as usize];
        WideCharToMultiByte(codepage, 0, wide.as_ptr(), wide.len() as c_int, bytes.as_mut_ptr(), size, std::ptr::null(), std::ptr::null_mut());
        Ok(bytes)
    }
}

#[cfg(not(windows))]
fn wide_to_mb(_codepage: u32, _text: &str) -> Result<Vec<u8>, ()> {
    Err(())
}

/* ---------- dos2unix & family ---------- */

enum LineEndings {
    ToUnix,
    ToDos,
    ToMac,
    MacToUnix,
}

impl LineEndings {
    fn apply(&self, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len());
        match self {
            LineEndings::ToUnix => {
                let mut at = 0usize;
                while at < data.len() {
                    if data[at] == b'\r' && data.get(at + 1) == Some(&b'\n') {
                        out.push(b'\n');
                        at += 2;
                    } else {
                        out.push(data[at]);
                        at += 1;
                    }
                }
            }
            LineEndings::ToDos => {
                let mut at = 0usize;
                while at < data.len() {
                    let byte = data[at];
                    // A \n the \r does not already cover gains one.
                    if byte == b'\n' && data.get(at.wrapping_sub(1)) != Some(&b'\r') {
                        out.push(b'\r');
                    }
                    out.push(byte);
                    at += 1;
                }
            }
            LineEndings::ToMac => {
                let mut at = 0usize;
                while at < data.len() {
                    let byte = data[at];
                    if byte == b'\n' && data.get(at.wrapping_sub(1)) != Some(&b'\r') {
                        out.push(b'\r');
                    } else {
                        out.push(byte);
                    }
                    at += 1;
                }
            }
            LineEndings::MacToUnix => {
                let mut at = 0usize;
                while at < data.len() {
                    let byte = data[at];
                    // A CR its LF already covers stays (a CRLF line is not a CR line).
                    if byte == b'\r' && data.get(at + 1) != Some(&b'\n') {
                        out.push(b'\n');
                    } else {
                        out.push(byte);
                    }
                    at += 1;
                }
            }
        }
        out
    }
}

fn line_endings(shell: &mut Shell, io: &Io, args: &[String], mode: LineEndings) -> ExecResult {
    let mut pair: Option<(String, String)> = None;
    let mut files: Vec<String> = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-n" => {
                if let (Some(input), Some(output)) = (iter.next(), iter.next()) {
                    pair = Some((input.clone(), output.clone()));
                }
            }
            "--" => {}
            other if other.starts_with('-') && other.len() > 1 => {}
            other => files.push(other.to_owned()),
        }
    }
    if let Some((input, output)) = &pair {
        let resolved_in = shell.resolve_working_path(input);
        let resolved_out = shell.resolve_working_path(output);
        match std::fs::read(&resolved_in) {
            Ok(data) => {
                if let Err(error) = std::fs::write(&resolved_out, mode.apply(&data)) {
                    io.err_str(&format!(
                        "dos2unix: cannot write '{output}': {}\n",
                        io_error_text(&error)
                    ));
                    return Ok(1);
                }
            }
            Err(error) => {
                io.err_str(&format!(
                    "dos2unix: cannot open '{input}': {}\n",
                    io_error_text(&error)
                ));
                return Ok(1);
            }
        }
        return Ok(0);
    }
    if files.is_empty() {
        let mut io_mut = io.clone();
        let data = io_mut.read_all_stdin_bytes();
        io.write_out(&mode.apply(&data));
        return Ok(0);
    }
    let mut status = 0;
    for file in &files {
        let resolved = shell.resolve_working_path(file);
        match std::fs::read(&resolved) {
            Ok(data) => {
                if let Err(error) = std::fs::write(&resolved, mode.apply(&data)) {
                    io.err_str(&format!(
                        "dos2unix: cannot write '{file}': {}\n",
                        io_error_text(&error)
                    ));
                    status = 1;
                }
            }
            Err(error) => {
                io.err_str(&format!(
                    "dos2unix: cannot open '{file}': {}\n",
                    io_error_text(&error)
                ));
                status = 1;
            }
        }
    }
    Ok(status)
}

/* ---------- dircolors ---------- */

fn dircolors(io: &Io, args: &[String]) -> ExecResult {
    let (flags, operands) = parse_flags(args);
    let _ = (flags, operands);
    // The default database's shape: the common keys a `eval "$(dircolors -b)"`
    // bashrc consumes. Off-GNU codepoints are omitted rather than guessed.
    const DEFAULT_COLORS: &str = "rs=0:di=01;34:ln=01;36:mh=00:pi=40;33:so=01;35:\
         do=01;35:bd=40;33;01:cd=40;33;01:or=40;31;01:mi=00:su=37;41:sg=30;43:\
         ca=30;41:tw=30;42:ow=34;42:st=37;44:ex=01;32:*.tar=01;31:*.tgz=01;31:\
         *.zip=01;31:*.gz=01;31:*.bz2=01;31:*.xz=01;31:*.7z=01;31:*.jpg=01;35:\
         *.jpeg=01;35:*.png=01;35:*.gif=01;35:*.bmp=01;35:*.svg=01;35:*.pdf=00;33:\
         *.exe=01;32:*.dll=01;32:*.sh=01;32";
    io.out_str(&format!(
        "LS_COLORS='{DEFAULT_COLORS}';\nexport LS_COLORS\n"
    ));
    Ok(0)
}

/* ---------- nohup / nice / stdbuf ---------- */

fn nohup(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    if args.is_empty() {
        io.err_str("nohup: missing operand\n");
        return Ok(125);
    }
    if resolve_on_path(&args[0], &shell.path_var()).is_none()
        && !super::builtins::is_builtin(&args[0])
        && !is_applet(&args[0])
    {
        io.err_str(&format!(
            "nohup: failed to run command '{}': No such file or directory\n",
            args[0]
        ));
        return Ok(127);
    }
    let mut io_mut = io.clone();
    // A terminal stdout becomes nohup.out — the whole point of the wrapper.
    if matches!(io.stdout, super::exec::Sink::Inherit) && super::sysinfo::stdout_is_terminal() {
        let path = shell.cwd.join("nohup.out");
        match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            Ok(file) => {
                io_mut.stdout = super::exec::Sink::File(Arc::new(std::sync::Mutex::new(file)));
            }
            Err(error) => {
                io.err_str(&format!(
                    "nohup: failed to open '{}': {}\n",
                    path.display(),
                    io_error_text(&error)
                ));
                return Ok(125);
            }
        }
    }
    shell.run_argv(args, &io_mut)
}

fn nice(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut rest: Vec<String> = args.to_vec();
    if rest.first().map(String::as_str) == Some("-n") {
        if rest.len() > 1 {
            rest.drain(..2);
        } else {
            rest.clear();
        }
    }
    // The adjustment is accepted and inert: the bundled shell's children run at
    // their own default priority.
    if rest.is_empty() {
        io.err_str("nice: missing operand\n");
        return Ok(125);
    }
    shell.run_argv(&rest, io)
}

fn stdbuf(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    // The buffering advice (-oL, -e0, -i0) is dropped: the applets stream their
    // own output already, and a spawned child manages its own buffers.
    let rest: Vec<String> = args
        .iter()
        .filter(|arg| {
            !(arg.starts_with("-o") || arg.starts_with("-e") || arg.starts_with("-i"))
        })
        .cloned()
        .collect();
    if rest.is_empty() {
        io.err_str("stdbuf: a command is required\n");
        return Ok(125);
    }
    shell.run_argv(&rest, io)
}

/* ---------- tput / stty ---------- */

fn tput(io: &Io, args: &[String]) -> ExecResult {
    // GNU's shape: one capability per invocation, the operands after it its
    // parameters (`tput setaf 1`, `tput cup 5 10`).
    let operands: Vec<&String> = args.iter().filter(|arg| !arg.starts_with('-')).collect();
    let Some(head) = operands.first() else {
        return Ok(0);
    };
    let capability = head.as_str();
    let params: Vec<usize> = operands[1..]
        .iter()
        .filter_map(|value| value.parse().ok())
        .collect();
    let (first, second) = (params.first().copied(), params.get(1).copied());
    let (columns, rows) = super::sysinfo::console_dimensions();
    let mut status = 0;
    {
        let mut parts = capability.split(' ');
        let name = parts.next().unwrap_or("");
        let _ = parts;
        match name {
            "clear" => io.out_str("\x1b[H\x1b[2J"),
            "cup" => {
                let (y, x) = (first.unwrap_or(0), second.unwrap_or(0));
                io.out_str(&format!("\x1b[{};{}H", y + 1, x + 1));
            }
            "cols" => io.out_str(&format!("{columns}\n")),
            "lines" => io.out_str(&format!("{rows}\n")),
            "setaf" | "setf" => {
                let color = first.unwrap_or(0);
                if color < 8 {
                    io.out_str(&format!("\x1b[3{color}m"));
                } else if color < 16 {
                    io.out_str(&format!("\x1b[9{}m", color - 8));
                }
            }
            "setab" | "setb" => {
                let color = first.unwrap_or(0);
                if color < 8 {
                    io.out_str(&format!("\x1b[4{color}m"));
                } else if color < 16 {
                    io.out_str(&format!("\x1b[10{}m", color - 8));
                }
            }
            "bold" => io.out_str("\x1b[1m"),
            "dim" => io.out_str("\x1b[2m"),
            "sgr0" => io.out_str("\x1b(B\x1b[m"),
            "rev" | "smso" => io.out_str("\x1b[7m"),
            "rmso" => io.out_str("\x1b[27m"),
            "el" => io.out_str("\x1b[K"),
            "ed" => io.out_str("\x1b[J"),
            "cr" => io.out_str("\r"),
            "bel" => io.out_str("\x07"),
            "civis" => io.out_str("\x1b[?25l"),
            "cnorm" => io.out_str("\x1b[?12l\x1b[?25h"),
            "smcup" => io.out_str("\x1b[?1049h"),
            "rmcup" => io.out_str("\x1b[?1049l"),
            other => {
                io.err_str(&format!("tput: unknown terminfo capability '{other}'\n"));
                status = 2;
            }
        }
    }
    Ok(status)
}

fn stty(io: &Io, args: &[String]) -> ExecResult {
    // `stty size` reads the console; a settings print answers the canonical
    // shape; the setting forms are accepted (the line editor owns the console
    // mode only while a line is read, so a set cannot persist).
    if args.iter().any(|arg| arg == "size") {
        if !matches!(io.stdin, super::exec::Source::Inherit) || !super::sysinfo::stdin_is_terminal() {
            io.err_str("stty: 'standard input': Inappropriate ioctl for device\n");
            return Ok(1);
        }
        let (columns, rows) = super::sysinfo::console_dimensions();
        io.out_str(&format!("{rows} {columns}\n"));
        return Ok(0);
    }
    if args.iter().any(|arg| arg == "-a" || arg == "--all") {
        io.out_str(
            "speed 115200 baud; rows 30; columns 120; line = 0;\n\
             intr = ^C; quit = ^\\; erase = ^?; kill = ^U; eof = ^D; eol = <undef>;\n\
             eol2 = <undef>; swtch = <undef>; start = ^Q; stop = ^S; susp = ^Z; rprnt = ^R;\n\
             werase = ^W; lnext = ^V; discard = ^O; min = 1; time = 0;\n\
             -parenb -parodd -cmspar cs8 -hupcl -cstopb cread -clocal -crtscts\n\
             -ignbrk -brkint -ignpar -parmrk -inpck -istrip -inlcr -igncr icrnl ixon -ixoff\n\
             -iuany -imaxbel iutf8 -opost -olcuc -ocrnl onlcr -onocr -onlret -ofill -ofdel\n\
             isig icanon iexten echo echoe echok -echonl -noflsh -xcase -tostop -echoprt\n\
             echoctl echoke -flusho -extproc\n",
        );
        return Ok(0);
    }
    let touching_settings = args.iter().any(|arg| arg.starts_with('-') && arg.len() > 1 || !arg.starts_with('-'));
    if touching_settings && !matches!(io.stdin, super::exec::Source::Inherit) {
        io.err_str("stty: 'standard input': Inappropriate ioctl for device\n");
        return Ok(1);
    }
    Ok(0)
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

#[cfg(test)]
mod ls_column_tests {
    use super::{gnu_column_widths, gnu_indent};

    /// Every expected answer below was measured against a live Git Bash
    /// (`ls -C -w N` with the same name sets): seven unit names take 3 columns
    /// at width 8, 4 at 10 and 6 at 16 (a candidate whose names never grow past
    /// the pre-seeded 3-wide minimum stays valid — its two trailing columns
    /// print empty, which is why 16 LOOKS like 4), one row at 20; the uneven
    /// set lands 2 columns at 22.
    #[test]
    fn gnu_column_widths_match_the_measured_answers() {
        let seven = vec![1usize; 7];
        assert_eq!(gnu_column_widths(&seven, 8), vec![3, 3, 3]);
        assert_eq!(gnu_column_widths(&seven, 10), vec![3, 3, 3, 3]);
        assert_eq!(gnu_column_widths(&seven, 16), vec![3, 3, 3, 3, 3, 3]);
        assert_eq!(gnu_column_widths(&seven, 20), vec![3, 3, 3, 3, 3, 3, 3]);
        assert_eq!(gnu_column_widths(&[1, 2, 3, 13, 1, 1, 1], 22), vec![15, 3]);
    }

    #[test]
    fn gnu_indent_prefers_tabs_that_land_within_the_target() {
        // A tab to 8, then seven spaces to 15 — the measured `a^I       e` row.
        let mut out = String::new();
        gnu_indent(&mut out, 1, 15);
        assert_eq!(out, "\t       ");
        // A tab would overshoot, so plain spaces.
        let mut out = String::new();
        gnu_indent(&mut out, 1, 3);
        assert_eq!(out, "  ");
        let mut out = String::new();
        gnu_indent(&mut out, 7, 9);
        assert_eq!(out, "  ");
    }
}
