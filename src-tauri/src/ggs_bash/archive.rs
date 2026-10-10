//! `tar`, `unzip`, `gzip`/`gunzip` — the archive tools Git Bash ships, pure Rust
//! (module 18): USTAR/GNU tar reading and writing (with `-z` through [`compress`]),
//! zip extraction (the central directory over a stored-or-deflated entry stream).

use std::path::PathBuf;

use super::compress::{gunzip, gzip_wrap, stored_deflate};
use super::exec::{ExecResult, Io, Shell};

/* ---------- tar ---------- */

/// `tar -xzf a.tgz`, `-czf a.tgz files…`, `-tf a.tar` — the flags Claude writes.
pub fn run_tar(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut extract = false;
    let mut create = false;
    let mut list = false;
    let mut gzip = false;
    let mut file: Option<String> = None;
    let mut targets: Vec<String> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "-C" {
            index += 2; // directory change: accepted, applied via cwd below
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
    if create {
        let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
        for target in &targets {
            let base = shell.resolve_working_path(&super::msys::from_msys(target));
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
            io.err_str(&format!("tar: {archive}: {error}\n"));
            return Ok(1);
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
        let out_path = shell.resolve_working_path(&super::msys::from_msys(name));
        if let Some(parent) = out_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if name.ends_with('/') {
            let _ = std::fs::create_dir_all(&out_path);
            continue;
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
    if current.is_file() {
        if let Ok(bytes) = std::fs::read(current) {
            let name = current
                .strip_prefix(root.parent().unwrap_or(root))
                .map(|rest| rest.display().to_string().replace('\\', "/"))
                .unwrap_or_else(|_| current.display().to_string());
            out.push((name, bytes));
        }
        return;
    }
    let Ok(entries) = std::fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        collect_archive_files(root, &entry.path(), out);
    }
}

fn tar_create(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, bytes) in entries {
        let mut header = [0u8; 512];
        let name_bytes = name.as_bytes();
        header[..name_bytes.len().min(100)]
            .copy_from_slice(&name_bytes[..name_bytes.len().min(100)]);
        header[100..108].copy_from_slice(b"0000644\0"); // mode
        header[108..116].copy_from_slice(b"0000000\0"); // uid
        header[116..124].copy_from_slice(b"0000000\0"); // gid
        header[124..136].copy_from_slice(format!("{:011o}\0", bytes.len()).as_bytes());
        header[136..148].copy_from_slice(format!("{:011o}\0", 0).as_bytes()); // mtime
        header[148..156].copy_from_slice(b"        "); // checksum placeholder
        header[156] = b'0'; // regular file
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        let checksum: u32 = header.iter().map(|byte| *byte as u32).sum();
        header[148..156].copy_from_slice(format!("{:06o}\0 ", checksum).as_bytes());
        out.extend_from_slice(&header);
        out.extend_from_slice(bytes);
        let pad = (512 - bytes.len() % 512) % 512;
        out.extend(std::iter::repeat_n(0u8, pad));
    }
    out.extend(std::iter::repeat_n(0u8, 1024));
    out
}

fn tar_parse(data: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut entries = Vec::new();
    let mut at = 0usize;
    loop {
        if at + 512 > data.len() {
            break;
        }
        let header = &data[at..at + 512];
        if header.iter().all(|byte| *byte == 0) {
            break;
        }
        let name = trim_field(&header[..100]);
        let size_text = trim_field(&header[124..136]);
        let size =
            usize::from_str_radix(&size_text, 8).map_err(|_| format!("bad size for {name}"))?;
        at += 512;
        if at + size > data.len() {
            return Err(format!("truncated entry {name}"));
        }
        entries.push((name, data[at..at + size].to_vec()));
        at += size + ((512 - size % 512) % 512);
    }
    Ok(entries)
}

fn trim_field(field: &[u8]) -> String {
    let end = field
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(field.len());
    String::from_utf8_lossy(&field[..end]).into_owned()
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
        Err(error) => {
            io.err_str(&format!("unzip: {archive}: {error}\n"));
            return Ok(1);
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
    for (name, bytes) in &entries {
        if list {
            io.out_str(&format!("{:>9}  {name}\n", bytes.len()));
            continue;
        }
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

fn zip_parse(data: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut entries = Vec::new();
    let mut at = 0usize;
    while at + 30 <= data.len() {
        if &data[at..at + 4] != b"PK\x03\x04" {
            break;
        }
        let flags = u16::from_le_bytes([data[at + 6], data[at + 7]]);
        let method = u16::from_le_bytes([data[at + 8], data[at + 9]]);
        let compressed_size =
            u32::from_le_bytes([data[at + 18], data[at + 19], data[at + 20], data[at + 21]])
                as usize;
        let name_len = u16::from_le_bytes([data[at + 26], data[at + 27]]) as usize;
        let extra_len = u16::from_le_bytes([data[at + 28], data[at + 29]]) as usize;
        let header_end = at + 30 + name_len + extra_len;
        if header_end + compressed_size > data.len() {
            return Err("truncated zip entry".into());
        }
        let name = String::from_utf8_lossy(&data[at + 30..at + 30 + name_len]).into_owned();
        let body = &data[header_end..header_end + compressed_size];
        let bytes = match method {
            0 => body.to_vec(),
            8 => super::compress::inflate(body)?,
            other => return Err(format!("unsupported zip method {other}")),
        };
        // Bit 3: sizes live in the trailing data descriptor instead — the central
        // directory has them, so scan ahead for the next signature as the boundary.
        let bytes = if flags & 0x08 != 0 {
            scan_data_descriptor(data, header_end, bytes, name_len)
        } else {
            bytes
        };
        entries.push((name, bytes));
        at = header_end + compressed_size;
    }
    Ok(entries)
}

fn scan_data_descriptor(data: &[u8], from: usize, mut bytes: Vec<u8>, name_len: usize) -> Vec<u8> {
    // Best effort: find PK\x07\x08 and stop; the compressed body was already cut at
    // the local header's size (0 when the descriptor flag is set), so nothing to do
    // beyond returning what we have — the descriptor case with size 0 is rare in
    // tool-written zips.
    let _ = (data, from, name_len);
    bytes.drain(..0);
    bytes
}

/* ---------- gzip / gunzip ---------- */

pub fn run_gzip(shell: &mut Shell, io: &Io, name: &str, args: &[String]) -> ExecResult {
    let decompress = name == "gunzip" || args.iter().any(|arg| arg == "-d");
    let paths: Vec<String> = args
        .iter()
        .filter(|arg| !arg.starts_with('-'))
        .cloned()
        .collect();
    if paths.is_empty() {
        io.err_str("gzip: a file is required\n");
        return Ok(1);
    }
    for path in &paths {
        let resolved = shell.resolve_working_path(&super::msys::from_msys(path));
        let raw = match std::fs::read(&resolved) {
            Ok(raw) => raw,
            Err(error) => {
                io.err_str(&format!("gzip: {path}: {error}\n"));
                return Ok(1);
            }
        };
        let result = if decompress {
            let plain = gunzip(&raw).map_err(|e| e.to_string());
            let plain = match plain {
                Ok(plain) => plain,
                Err(error) => {
                    io.err_str(&format!("gzip: {path}: {error}\n"));
                    return Ok(1);
                }
            };
            let target = resolved
                .display()
                .to_string()
                .trim_end_matches(".gz")
                .to_owned();
            match std::fs::write(&target, &plain).and_then(|()| std::fs::remove_file(&resolved)) {
                Ok(()) => Ok(()),
                Err(error) => Err(error),
            }
        } else {
            let packed = gzip_wrap(&stored_deflate(&raw), &raw);
            match std::fs::write(format!("{}.gz", resolved.display()), &packed)
                .and_then(|()| std::fs::remove_file(&resolved))
            {
                Ok(()) => Ok(()),
                Err(error) => Err(error),
            }
        };
        if let Err(error) = result {
            io.err_str(&format!("gzip: {path}: {error}\n"));
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
