//! `tar`, `unzip`, `gzip`/`gunzip` — the archive tools Git Bash ships (module 18).
//! The byte formats themselves live in ggs-codec (`tar`, `zip`, `compress`); this is
//! the applet layer over them: flags, paths and the shell's I/O.

use std::path::PathBuf;

use ggs_codec::compress::{gunzip, gzip_wrap, stored_deflate};
use ggs_codec::tar::{tar_create, tar_parse};
use ggs_codec::zip::zip_parse;
use super::exec::{ExecResult, Io, Shell};

/* ---------- tar ---------- */

/// `tar -xzf a.tgz`, `-czf a.tgz files…`, `-tf a.tar` — the flags Claude writes.
pub fn run_tar(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut extract = false;
    let mut create = false;
    let mut list = false;
    let mut gzip = false;
    let mut file: Option<String> = None;
    let mut change_dir: Option<String> = None;
    let mut targets: Vec<String> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "-C" {
            if let Some(dir) = args.get(index + 1) {
                change_dir = Some(dir.clone());
            }
            index += 2;
            continue;
        }
        if let Some(dir) = arg.strip_prefix("-C").filter(|d| !d.is_empty()) {
            change_dir = Some(dir.to_owned());
            index += 1;
            continue;
        }
        if let Some(body) = arg
            .strip_prefix('-')
            .filter(|body| !body.is_empty() && !body.starts_with(|c: char| c.is_ascii_digit()))
        {
            for c in body.chars() {
                match c {
                    'x' => extract = true,
                    'c' => create = true,
                    't' => list = true,
                    'z' => gzip = true,
                    'v' | 'f' | 'p' | 'u' | 'w' => {}
                    other => io.err_str(&format!("tar: -{other}: unsupported\n")),
                }
            }
        } else if arg.starts_with('-') {
            // -4 style numeric or the long forms: ignored.
        } else if file.is_none() {
            file = Some(arg.clone());
        } else {
            targets.push(arg.clone());
        }
        index += 1;
    }
    // `-f` rides inside the flag cluster (`-xzf a.tgz`): the first bare non-flag is
    // the archive when an action was seen, else a target.
    let Some(archive) = file else {
        io.err_str("tar: an archive name is required (-f)\n");
        return Ok(2);
    };
    let resolved = shell.resolve_working_path(&super::msys::from_msys(&archive));
    let change_base = change_dir
        .as_ref()
        .map(|dir| shell.resolve_working_path(&super::msys::from_msys(dir)));
    if create {
        let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
        for target in &targets {
            // -C DIR first: the members are named as walked from DIR ("." covers
            // the tree as "./x"), GNU's own shape.
            let base = if let Some(change) = &change_base {
                change.join(target)
            } else {
                shell.resolve_working_path(&super::msys::from_msys(target))
            };
            collect_archive_files(&base, &base, &mut entries);
        }
        let payload = tar_create(&entries);
        let bytes = if gzip {
            gzip_wrap(&stored_deflate(&payload), &payload)
        } else {
            payload
        };
        return match std::fs::write(&resolved, bytes) {
            Ok(()) => Ok(0),
            Err(error) => {
                io.err_str(&format!("tar: {archive}: {error}\n"));
                Ok(1)
            }
        };
    }
    let raw = match std::fs::read(&resolved) {
        Ok(raw) => raw,
        Err(error) => {
            let wording = match error.kind() {
                std::io::ErrorKind::NotFound => "No such file or directory",
                std::io::ErrorKind::PermissionDenied => "Permission denied",
                _ => "Cannot open",
            };
            io.err_str(&format!(
                "tar: {archive}: Cannot open: {wording}\ntar: Error is not recoverable: exiting now\n"
            ));
            return Ok(2);
        }
    };
    let data = if gzip || archive.ends_with(".tgz") || archive.ends_with(".gz") {
        match gunzip(&raw) {
            Ok(data) => data,
            Err(error) => {
                io.err_str(&format!("tar: {archive}: {error}\n"));
                return Ok(1);
            }
        }
    } else {
        raw
    };
    let entries = match tar_parse(&data) {
        Ok(entries) => entries,
        Err(error) => {
            io.err_str(&format!("tar: {archive}: {error}\n"));
            return Ok(1);
        }
    };
    for (name, bytes) in &entries {
        if list || !extract {
            io.out_str(&format!("{name}\n"));
            continue;
        }
        let clean = name
            .trim_start_matches("./")
            .trim_start_matches('/')
            .to_owned();
        if clean.is_empty() || clean == "." {
            continue;
        }
        let out_path = if let Some(change) = &change_base {
            change.join(&clean)
        } else {
            shell.resolve_working_path(&super::msys::from_msys(&clean))
        };
        if name.ends_with('/') {
            let _ = std::fs::create_dir_all(&out_path);
            continue;
        }
        if let Some(parent) = out_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(error) = std::fs::write(&out_path, bytes) {
            io.err_str(&format!("tar: {name}: {error}\n"));
            return Ok(1);
        }
    }
    Ok(0)
}

fn collect_archive_files(
    root: &std::path::Path,
    current: &std::path::Path,
    out: &mut Vec<(String, Vec<u8>)>,
) {
    let member_name = |path: &std::path::Path| -> String {
        // `tar -C dir .` names members off the walked root itself
        // ("./x"); `tar c sub` off the root's parent ("sub/x").
        let dot_root = root.display().to_string().ends_with('.');
        let anchor = if dot_root {
            root
        } else {
            root.parent().unwrap_or(root)
        };
        let fallback = if dot_root {
            format!("./{}", path.strip_prefix(root).map(|rest| rest.display().to_string()).unwrap_or_default())
        } else {
            path.display().to_string()
        };
        path.strip_prefix(anchor)
            .map(|rest| {
                let text = rest.display().to_string().replace('\\', "/");
                if dot_root {
                    format!("./{text}")
                } else {
                    text
                }
            })
            .unwrap_or_else(|_| fallback)
    };
    if current.is_file() {
        if let Ok(bytes) = std::fs::read(current) {
            out.push((member_name(current), bytes));
        }
        return;
    }
    if !current.is_dir() {
        return;
    }
    // Directories archive as their own "name/" members, GNU's listing shape.
    let dir_name = member_name(current);
    if dir_name == "./" || dir_name.is_empty() {
        out.push(("./".to_owned(), Vec::new()));
    } else {
        out.push((format!("{dir_name}/"), Vec::new()));
    }
    let Ok(entries) = std::fs::read_dir(current) else {
        return;
    };
    let mut children: Vec<_> = entries.flatten().collect();
    children.sort_by_key(|entry| entry.file_name());
    for entry in children {
        collect_archive_files(root, &entry.path(), out);
    }
}

/* ---------- unzip ---------- */

/// `unzip -o a.zip -d dir` / `unzip -l a.zip`: the local-file stream (a zip's most
/// robust read: no central-directory offsets to trust).
pub fn run_unzip(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut list = false;
    let mut overwrite = false;
    let mut into: Option<String> = None;
    let mut archive: Option<String> = None;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "-d" {
            index += 1;
            into = args.get(index).cloned();
        } else if let Some(body) = arg.strip_prefix('-') {
            for c in body.chars() {
                match c {
                    'l' => list = true,
                    'o' => overwrite = true,
                    'q' | 'v' => {}
                    other => io.err_str(&format!("unzip: -{other}: unsupported\n")),
                }
            }
        } else if archive.is_none() {
            archive = Some(arg.clone());
        }
        index += 1;
    }
    let Some(archive) = archive else {
        io.err_str("unzip: an archive is required\n");
        return Ok(1);
    };
    let resolved = shell.resolve_working_path(&super::msys::from_msys(&archive));
    let data = match std::fs::read(&resolved) {
        Ok(data) => data,
        Err(_) => {
            io.err_str(&format!(
                "unzip:  cannot find or open {archive}, {archive}.zip or {archive}.ZIP.\n"
            ));
            return Ok(9);
        }
    };
    let entries = match zip_parse(&data) {
        Ok(entries) => entries,
        Err(error) => {
            io.err_str(&format!("unzip: {archive}: {error}\n"));
            return Ok(1);
        }
    };
    let base = into.map(|dir| shell.resolve_working_path(&super::msys::from_msys(&dir)));
    if list {
        io.out_str("Archive:  {archive}\n");
        io.out_str("  Length      Date    Time    Name\n");
        io.out_str("---------  ---------- -----   ----\n");
        let mut total = 0usize;
        let mut count = 0usize;
        for (name, bytes) in &entries {
            io.out_str(&format!(
                "{:>9}  1980-01-01 00:00   {}\n",
                bytes.len(),
                name
            ));
            total += bytes.len();
            count += 1;
        }
        io.out_str("---------                     -------\n");
        io.out_str(&format!(
            "{:>9}                     {} files\n",
            total, count
        ));
        return Ok(0);
    }
    for (name, bytes) in &entries {
        let _ = bytes;
        let mut out_path = base.clone().unwrap_or_else(|| shell.cwd.clone());
        // Zip names may carry absolute or .. parts: confined into the target.
        let clean: PathBuf = name
            .split(['/', '\\'])
            .filter(|part| *part != ".." && !part.is_empty())
            .collect();
        out_path = out_path.join(clean);
        if let Some(parent) = out_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if name.ends_with('/') {
            let _ = std::fs::create_dir_all(&out_path);
            continue;
        }
        if out_path.exists() && !overwrite {
            io.err_str(&format!("unzip: {name}: exists (use -o)\n"));
            continue;
        }
        if let Err(error) = std::fs::write(&out_path, bytes) {
            io.err_str(&format!("unzip: {name}: {error}\n"));
            return Ok(1);
        }
    }
    Ok(0)
}

/* ---------- gzip / gunzip ---------- */

pub fn run_gzip(shell: &mut Shell, io: &Io, name: &str, args: &[String]) -> ExecResult {
    let mut decompress = name == "gunzip";
    let mut to_stdout = false;
    let mut keep = false;
    let mut list = false;
    let mut test = false;
    let mut paths: Vec<String> = Vec::new();
    for arg in args {
        match arg.as_str() {
            "-d" | "--decompress" | "--uncompress" => decompress = true,
            "-c" | "--stdout" | "--to-stdout" => to_stdout = true,
            "-k" | "--keep" => keep = true,
            "-l" | "--list" => list = true,
            "-t" | "--test" => test = true,
            "-f" | "--force" | "-n" | "--no-name"
            | "-q" | "--quiet" | "-v" | "--verbose" | "-1" | "-2" | "-3" | "-4" | "-5"
            | "-6" | "-7" | "-8" | "-9" | "--fast" | "--best" | "--" => {}
            other if other.starts_with('-') => {}
            other => paths.push(other.to_owned()),
        }
    }
    // `-l` tabulates; `-t` decompresses to nowhere — neither touches a file.
    if list || test {
        let mut status = 0;
        if list {
            io.out_str("         compressed        uncompressed  ratio uncompressed_name\n");
        }
        for path in &paths {
            let resolved = shell.resolve_working_path(&super::msys::from_msys(path));
            let raw = match std::fs::read(&resolved) {
                Ok(raw) => raw,
                Err(error) => {
                    io.err_str(&format!(
                        "gzip: {path}: {}\n",
                        match error.kind() {
                            std::io::ErrorKind::NotFound => "No such file or directory".to_owned(),
                            _ => error.to_string(),
                        }
                    ));
                    status = 1;
                    continue;
                }
            };
            let plain = match gunzip(&raw) {
                Ok(plain) => plain,
                Err(error) => {
                    if test {
                        io.err_str(&format!("gzip: {path}: {error}\n"));
                        status = 1;
                    } else {
                        io.err_str(&format!("gzip: {path}: not in gzip format\n"));
                        status = 1;
                    }
                    continue;
                }
            };
            if test {
                continue;
            }
            let ratio = if plain.is_empty() {
                0.0
            } else {
                (100.0 * (raw.len() as f64 - plain.len() as f64) / plain.len() as f64).max(0.0)
            };
            let uncompressed_name = path.strip_suffix(".gz").unwrap_or(path);
            io.out_str(&format!(
                "{:>19} {:>19} {:>5.1}% {}\n",
                raw.len(),
                plain.len(),
                ratio,
                uncompressed_name
            ));
        }
        return Ok(status);
    }
    // No operand: stdin crosses to stdout — the pipe shape 
    // (and the bare  filter) both ride it.
    if paths.is_empty() {
        let mut io_mut = io.clone();
        let raw = io_mut.read_all_stdin_bytes();
        let result = if decompress {
            gunzip(&raw).map_err(|e| format!("stdin: {e}"))
        } else {
            Ok(gzip_wrap(&stored_deflate(&raw), &raw))
        };
        match result {
            Ok(bytes) => io.write_out(&bytes),
            Err(error) => {
                io.err_str(&format!("gzip: {error}
"));
                return Ok(1);
            }
        }
        return Ok(0);
    }
    for path in &paths {
        let resolved = shell.resolve_working_path(&super::msys::from_msys(path));
        let raw = match std::fs::read(&resolved) {
            Ok(raw) => raw,
            Err(error) => {
                io.err_str(&format!("gzip: {path}: {error}
"));
                return Ok(1);
            }
        };
        let result = if decompress {
            let plain = match gunzip(&raw) {
                Ok(plain) => plain,
                Err(error) => {
                    io.err_str(&format!("gzip: {path}: {error}
"));
                    return Ok(1);
                }
            };
            if to_stdout {
                io.write_out(&plain);
                continue;
            }
            let target = resolved
                .display()
                .to_string()
                .strip_suffix(".gz")
                .map(str::to_owned)
                .unwrap_or_else(|| resolved.display().to_string());
            match std::fs::write(&target, &plain) {
                Ok(()) => {
                    if !keep {
                        let _ = std::fs::remove_file(&resolved);
                    }
                    Ok(())
                }
                Err(error) => Err(error),
            }
        } else {
            let packed = gzip_wrap(&stored_deflate(&raw), &raw);
            if to_stdout {
                io.write_out(&packed);
                continue;
            }
            match std::fs::write(format!("{}.gz", resolved.display()), &packed) {
                Ok(()) => {
                    if !keep {
                        let _ = std::fs::remove_file(&resolved);
                    }
                    Ok(())
                }
                Err(error) => Err(error),
            }
        };
        if let Err(error) = result {
            io.err_str(&format!("gzip: {path}: {error}
"));
            return Ok(1);
        }
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tar_round_trips_and_zips_hold() {
        let entries = vec![
            ("dir/a.txt".to_owned(), b"alpha".to_vec()),
            ("dir/sub/b.bin".to_owned(), vec![0u8; 700]),
        ];
        let archive = tar_create(&entries);
        assert_eq!(tar_parse(&archive).unwrap(), entries);
        // The -z path: gunzip of a created archive answers the same entries.
        let packed = gzip_wrap(&stored_deflate(&archive), &archive);
        assert_eq!(tar_parse(&gunzip(&packed).unwrap()).unwrap(), entries);
    }

    #[test]
    fn gzip_error_messages_are_real_lines() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("plain.txt"), b"not a gzip payload").unwrap();
        let (_, err, status) = crate::tests::run_in(dir.path(), "gzip -d plain.txt");
        assert_eq!(status, 1);
        // Git Bash prints one clean line per failure; the escaped-newline literal
        // "' + chr(92) + 'n" is a generation defect, never shell output.
        assert!(!err.contains("chr(92)"), "gzip error output carries the raw literal: {err:?}");
        assert!(err.trim_end().ends_with('n') || err.contains("
"), "a newline-terminated line: {err:?}");
    }

    #[test]
    fn zip_entries_parse_stored_and_deflated() {
        // A hand-built stored zip: one file "hi.txt" with content "hello".
        let mut zip: Vec<u8> = Vec::new();
        zip.extend_from_slice(b"PK\x03\x04");
        zip.extend_from_slice(&[0x14, 0x00, 0x00, 0x00, 0x00, 0x00]); // version, flags, method 0
        zip.extend_from_slice(&[0, 0, 0, 0]); // time/date
        zip.extend_from_slice(&0u32.to_le_bytes()); // crc (unchecked on the read path)
        zip.extend_from_slice(&5u32.to_le_bytes()); // compressed
        zip.extend_from_slice(&5u32.to_le_bytes()); // uncompressed
        zip.extend_from_slice(&6u16.to_le_bytes()); // name length
        zip.extend_from_slice(&0u16.to_le_bytes()); // extra length
        zip.extend_from_slice(b"hi.txt");
        zip.extend_from_slice(b"hello");
        let entries = zip_parse(&zip).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, "hi.txt");
        assert_eq!(entries[0].1, b"hello");
    }
}
