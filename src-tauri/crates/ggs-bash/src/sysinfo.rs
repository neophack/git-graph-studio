//! The system-information applets — the OS-facing half of the Git Bash parity batch
//! (2026-10-13, the owner's direction: `ggs-bash` was missing many of the commands a
//! Git Bash install carries — `df -h` the reported example). `df`, `free`, `ps`,
//! `mount`, `id`/`groups`/`logname`, `tty`, `nproc`, `arch` and `start` read what only
//! the OS knows: drive space, memory, the process list, the user's token. Windows
//! answers through direct Win32 declarations — the sidecar's no-dependency rule keeps:
//! no `windows-sys`, the same `extern "system"` shapes `is_stdin_tty` already uses —
//! Linux through `/proc` and the libc calls POSIX owns, macOS through its own tools.

use super::exec::{Io, Shell};

/* ---------- df ---------- */

/// One filesystem row: the numbers `df` prints, in bytes.
struct DfRow {
    filesystem: String,
    kind: String,
    total: u64,
    used: u64,
    available: u64,
    mounted: String,
}

/// `df` — Git Bash's coreutils shape: the drives as `C:` rows mounted at `/c`
/// (`-h` humanizes, `-T` adds the type column, an operand narrows to its drive).
pub fn df(shell: &Shell, io: &Io, args: &[String]) -> super::exec::ExecResult {
    let (human, si, show_type, paths) = match parse_df_args(args) {
        Ok(parsed) => parsed,
        Err(usage) => {
            io.err_str(&usage);
            return Ok(1);
        }
    };
    #[cfg(target_os = "macos")]
    {
        let _ = (human, si, show_type);
        return passthrough("/bin/df", args);
    }
    #[cfg(any(windows, target_os = "linux"))]
    {
        let rows = match df_rows(shell, &paths) {
            Ok(rows) => rows,
            Err(message) => {
                io.err_str(&format!("df: {message}\n"));
                return Ok(1);
            }
        };
        if paths.is_empty() && rows.is_empty() {
            io.err_str("df: no file systems processed\n");
            return Ok(1);
        }
        io.out_str(&format_df_table(&rows, human, si, show_type));
        Ok(0)
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = (shell, human, si, show_type, paths);
        io.err_str("df: unsupported on this platform\n");
        Ok(1)
    }
}

type ParsedDf = (bool, bool, bool, Vec<String>);

fn parse_df_args(args: &[String]) -> Result<ParsedDf, String> {
    let mut human = false;
    let mut si = false;
    let mut show_type = false;
    let mut paths = Vec::new();
    for arg in args {
        match arg.as_str() {
            "-h" => human = true,
            "-H" | "--si" => si = true,
            "-k" | "-P" | "--portability" => {}
            "-T" | "--print-type" => show_type = true,
            "--" => {}
            long if long.starts_with("--") => {
                return Err(format!("{long}: unsupported option\nusage: df [-h] [-T] [path...]"))
            }
            letters if letters.starts_with('-') && letters.len() > 1 => {
                for c in letters[1..].chars() {
                    match c {
                        'h' => human = true,
                        'H' => si = true,
                        'k' | 'P' => {}
                        'T' => show_type = true,
                        other => {
                            return Err(format!(
                                "-{other}: unsupported option\nusage: df [-h] [-T] [path...]"
                            ))
                        }
                    }
                }
            }
            path => paths.push(path.to_owned()),
        }
    }
    Ok((human, si, show_type, paths))
}

/// The byte numbers, Windows: every ready logical drive, an operand narrowing to its
/// own. A drive whose numbers cannot be read (an empty CD tray) is skipped, not an
/// error — Git Bash lists the filesystems that answer.
#[cfg(windows)]
fn df_rows(shell: &Shell, paths: &[String]) -> Result<Vec<DfRow>, String> {
    let mut wanted: Vec<char> = Vec::new();
    for path in paths {
        let resolved = shell.resolve_working_path(path);
        let text = resolved.display().to_string();
        let bytes = text.as_bytes();
        if bytes.len() < 2 || bytes[1] != b':' || !bytes[0].is_ascii_alphabetic() {
            return Err(format!("{path}: cannot resolve to a drive"));
        }
        wanted.push(bytes[0].to_ascii_uppercase() as char);
    }
    let mask = unsafe { win::GetLogicalDrives() };
    let mut rows = Vec::new();
    for index in 0..26u32 {
        if mask & (1 << index) == 0 {
            continue;
        }
        let letter = (b'A' + index as u8) as char;
        if !wanted.is_empty() && !wanted.contains(&letter) {
            continue;
        }
        let root = format!("{letter}:\\");
        let mut available = 0u64;
        let mut total = 0u64;
        let mut free = 0u64;
        let root_w = wide(&root);
        let ok = unsafe {
            win::GetDiskFreeSpaceExW(root_w.as_ptr(), &mut available, &mut total, &mut free)
        } == 1;
        if !ok || total == 0 {
            continue;
        }
        let used = total - free.min(total);
        rows.push(DfRow {
            filesystem: format!("{letter}:"),
            kind: volume_kind(&root),
            total,
            used,
            available: available.min(total),
            mounted: format!("/{}", letter.to_ascii_lowercase()),
        });
    }
    if !wanted.is_empty() && rows.is_empty() {
        return Err("no file systems processed".to_owned());
    }
    Ok(rows)
}

/// The filesystem type name of a drive root (`ntfs`, `fat32`, …), for `df -T` and
/// `mount`; `ntfs` when the query does not answer.
#[cfg(windows)]
fn volume_kind(root: &str) -> String {
    let mut buffer = [0u16; 64];
    let root_w = wide(root);
    let ok = unsafe {
        win::GetVolumeInformationW(
            root_w.as_ptr(),
            core::ptr::null_mut(),
            0,
            core::ptr::null_mut(),
            core::ptr::null_mut(),
            core::ptr::null_mut(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
        )
    } == 1;
    if !ok {
        return "ntfs".to_owned();
    }
    let len = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..len]).to_lowercase()
}

/// The byte numbers, Linux: `/proc/self/mounts` crossed with `statvfs`.
#[cfg(target_os = "linux")]
fn df_rows(shell: &Shell, paths: &[String]) -> Result<Vec<DfRow>, String> {
    let mounts = std::fs::read_to_string("/proc/self/mounts")
        .map_err(|e| format!("cannot read /proc/self/mounts: {e}"))?;
    let mut entries: Vec<(String, String, String)> = mounts
        .lines()
        .filter_map(|line| {
            let mut fields = line.split(' ');
            Some((
                fields.next()?.to_owned(),
                fields
                    .next()?
                    .replace("\\040", " ")
                    .replace("\\011", "\t"),
                fields.next()?.to_owned(),
            ))
        })
        .collect();
    // The same mountpoint twice (bind mounts, overlay layers) is one df row.
    entries.dedup_by(|a, b| a.1 == b.1);
    if !paths.is_empty() {
        let mut selected: Vec<(String, String, String)> = Vec::new();
        for path in paths {
            let absolute = shell
                .resolve_working_path(path)
                .canonicalize()
                .map_err(|_| format!("{path}: No such file or directory"))?;
            let best = entries
                .iter()
                .filter(|(_, dir, _)| absolute.starts_with(std::path::Path::new(dir)))
                .max_by_key(|(_, dir, _)| dir.len());
            match best {
                Some(entry) => {
                    if !selected.iter().any(|kept| kept.1 == entry.1) {
                        selected.push(entry.clone());
                    }
                }
                None => return Err(format!("{path}: not a mounted filesystem")),
            }
        }
        entries = selected;
    }
    let mut rows = Vec::new();
    for (device, dir, kind) in entries {
        let mut stats = Statvfs {
            f_bsize: 0,
            f_frsize: 0,
            f_blocks: 0,
            f_bfree: 0,
            f_bavail: 0,
            f_files: 0,
            f_ffree: 0,
            f_favail: 0,
            f_fsid: 0,
            f_flag: 0,
            f_namemax: 0,
            __spare: [0; 6],
        };
        let path_c = std::ffi::CString::new(dir.clone()).map_err(|e| e.to_string())?;
        if unsafe { statvfs(path_c.as_ptr(), &mut stats) } != 0 || stats.f_blocks == 0 {
            continue;
        }
        let unit = if stats.f_frsize > 0 {
            stats.f_frsize
        } else {
            stats.f_bsize
        };
        rows.push(DfRow {
            filesystem: device,
            kind,
            total: stats.f_blocks * unit,
            used: (stats.f_blocks - stats.f_bfree) * unit,
            available: stats.f_bavail * unit,
            mounted: dir,
        });
    }
    Ok(rows)
}

/// glibc's `struct statvfs` on LP64 — the counters `df` reads.
#[cfg(target_os = "linux")]
#[repr(C)]
struct Statvfs {
    f_bsize: u64,
    f_frsize: u64,
    f_blocks: u64,
    f_bfree: u64,
    f_bavail: u64,
    f_files: u64,
    f_ffree: u64,
    f_favail: u64,
    f_fsid: u64,
    f_flag: u64,
    f_namemax: u64,
    __spare: [i32; 6],
}

#[cfg(target_os = "linux")]
extern "C" {
    fn statvfs(path: *const std::os::raw::c_char, buf: *mut Statvfs) -> i32;
}

/// The GNU column layout: widths computed over header and rows, numbers
/// right-aligned, the filesystem and the mount point left-aligned.
fn format_df_table(rows: &[DfRow], human: bool, si: bool, show_type: bool) -> String {
    let mut table: Vec<Vec<String>> = Vec::new();
    for row in rows {
        let capacity = row.used + row.available;
        let percent = if capacity == 0 {
            0
        } else {
            (((row.used as f64 / capacity as f64) * 100.0).ceil() as u64).min(100)
        };
        let number = |bytes: u64| {
            if human || si {
                human_bytes(bytes, si)
            } else {
                (bytes / 1024).to_string()
            }
        };
        let mut cells = vec![row.filesystem.clone()];
        if show_type {
            cells.push(row.kind.clone());
        }
        cells.extend([
            number(row.total),
            number(row.used),
            number(row.available),
            format!("{percent}%"),
            row.mounted.clone(),
        ]);
        table.push(cells);
    }
    let mut headers = vec!["Filesystem"];
    if show_type {
        headers.push("Type");
    }
    if human || si {
        headers.extend(["Size", "Used", "Avail", "Use%", "Mounted on"]);
    } else {
        headers.extend(["1K-blocks", "Used", "Available", "Use%", "Mounted on"]);
    }
    let count = headers.len();
    let mut widths = vec![0usize; count];
    for index in 0..count {
        widths[index] = headers[index].len();
        for cells in &table {
            widths[index] = widths[index].max(cells.get(index).map(String::len).unwrap_or(0));
        }
    }
    let mut output = String::new();
    let line = |cells: &[&str], output: &mut String| {
        for index in 0..count {
            let width = widths[index];
            let last = index + 1 == count;
            // The filesystem, the type and the mount point read left-aligned; GNU's
            // numbers read right-aligned; the final column never pads.
            if last {
                output.push_str(cells[index]);
            } else if index == 0 || (show_type && index == 1) {
                output.push_str(&format!("{:<width$}", cells[index]));
            } else {
                output.push_str(&format!("{:>width$}", cells[index]));
            }
            if !last {
                output.push(' ');
            }
        }
        output.push('\n');
    };
    line(&headers, &mut output);
    for cells in &table {
        let borrowed: Vec<&str> = cells.iter().map(String::as_str).collect();
        line(&borrowed, &mut output);
    }
    output
}

/// GNU's `df -h` humanization: powers of 1024 (1000 under `-H`), one decimal below
/// ten, an integer from ten up, `0` for zero.
fn human_bytes(bytes: u64, si: bool) -> String {
    if bytes == 0 {
        return "0".to_owned();
    }
    let base = if si { 1000.0 } else { 1024.0 };
    let units = ["B", "K", "M", "G", "T", "P", "E"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= base && unit + 1 < units.len() {
        value /= base;
        unit += 1;
    }
    if unit == 0 {
        return format!("{value:.0}{}", units[unit]);
    }
    if value < 10.0 {
        format!("{value:.1}{}", units[unit])
    } else {
        format!("{value:.0}{}", units[unit])
    }
}

/* ---------- free ---------- */

/// `free` — procps' table over the machine's memory. Windows answers from
/// `GlobalMemoryStatusEx`, Linux from `/proc/meminfo`, macOS from `sysctl`.
pub fn free(io: &Io, args: &[String]) -> super::exec::ExecResult {
    let unit = match args.iter().find(|arg| arg.starts_with('-') && arg.len() > 1) {
        Some(flag) => match flag.trim_start_matches('-') {
            "m" => 'm',
            "g" => 'g',
            "h" => 'h',
            "k" | "" => 'k',
            other => {
                io.err_str(&format!("free: invalid option -- '{other}'\n"));
                return Ok(1);
            }
        },
        None => 'k',
    };
    #[cfg(target_os = "macos")]
    {
        let _ = unit;
        return free_macos(io);
    }
    #[cfg(any(windows, target_os = "linux"))]
    {
        let (mem, swap) = memory_numbers();
        io.out_str(&format_free_table(mem, swap, unit));
        Ok(0)
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = unit;
        io.out_str(&format_free_table((0, 0, 0, 0, 0, 0), (0, 0, 0), 'k'));
        Ok(0)
    }
}

/// (total, used, free, shared, buff/cache, available) in KiB.
type MemRow = (u64, u64, u64, u64, u64, u64);

#[cfg(any(windows, target_os = "linux"))]
fn memory_numbers() -> (MemRow, (u64, u64, u64)) {
    #[cfg(windows)]
    {
        let mut status = win::MemoryStatusEx {
            dw_length: std::mem::size_of::<win::MemoryStatusEx>() as u32,
            dw_memory_load: 0,
            ull_total_phys: 0,
            ull_avail_phys: 0,
            ull_total_page_file: 0,
            ull_avail_page_file: 0,
            ull_total_virtual: 0,
            ull_avail_virtual: 0,
            ull_avail_extended_virtual: 0,
        };
        if unsafe { win::GlobalMemoryStatusEx(&mut status) } != 1 {
            return ((0, 0, 0, 0, 0, 0), (0, 0, 0));
        }
        let total = status.ull_total_phys / 1024;
        let avail = status.ull_avail_phys / 1024;
        let used = total.saturating_sub(avail);
        // The commit limit covers RAM plus page files; the swap halves are what
        // spills past the physical total, best-effort like MSYS' own free.
        let commit_total = status.ull_total_page_file / 1024;
        let commit_avail = status.ull_avail_page_file / 1024;
        let swap_total = commit_total.saturating_sub(total);
        let swap_used = commit_total
            .saturating_sub(commit_avail)
            .saturating_sub(used)
            .min(swap_total);
        (
            (total, used, avail, 0, 0, avail),
            (swap_total, swap_used, swap_total.saturating_sub(swap_used)),
        )
    }
    #[cfg(target_os = "linux")]
    {
        let info =
            parse_meminfo(&std::fs::read_to_string("/proc/meminfo").unwrap_or_default());
        let get = |key: &str| *info.get(key).unwrap_or(&0);
        let total = get("MemTotal");
        let free = get("MemFree");
        let buffers = get("Buffers");
        let cached = get("Cached") + get("SReclaimable");
        let used = total
            .saturating_sub(free)
            .saturating_sub(buffers)
            .saturating_sub(cached);
        let available = if get("MemAvailable") > 0 {
            get("MemAvailable")
        } else {
            total.saturating_sub(used)
        };
        let swap_total = get("SwapTotal");
        let swap_free = get("SwapFree");
        (
            (total, used, free, get("Shmem"), buffers + cached, available),
            (swap_total, swap_total.saturating_sub(swap_free), swap_free),
        )
    }
}

#[cfg(target_os = "linux")]
fn parse_meminfo(text: &str) -> std::collections::HashMap<String, u64> {
    let mut map = std::collections::HashMap::new();
    for line in text.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let value = rest
            .split_whitespace()
            .next()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        map.insert(key.to_owned(), value);
    }
    map
}

#[cfg(target_os = "macos")]
fn free_macos(io: &Io) -> super::exec::ExecResult {
    let mut total: u64 = 0;
    let name = b"hw.memsize\0";
    let mut length = std::mem::size_of::<u64>();
    let ok = unsafe {
        sysctlbyname(
            name.as_ptr() as *const std::os::raw::c_char,
            &mut total as *mut u64 as *mut core::ffi::c_void,
            &mut length,
            core::ptr::null(),
            0,
        )
    };
    if ok != 0 {
        io.err_str("free: cannot read memory size\n");
        return Ok(1);
    }
    let kib = total / 1024;
    io.out_str(&format_free_table((kib, 0, kib, 0, 0, kib), (0, 0, 0), 'h'));
    Ok(0)
}

#[cfg(target_os = "macos")]
extern "C" {
    fn sysctlbyname(
        name: *const std::os::raw::c_char,
        old: *mut core::ffi::c_void,
        oldlen: *mut usize,
        new: *const core::ffi::c_void,
        newlen: usize,
    ) -> i32;
}

/// procps' layout: a 5-wide label column, the totals column 15 wide and every
/// other value 12, right-aligned.
fn format_free_table(mem: MemRow, swap: (u64, u64, u64), unit: char) -> String {
    let conv = |kib: u64| -> String {
        match unit {
            'm' => format!("{}", kib / 1024),
            'g' => format!("{}", kib / (1024 * 1024)),
            'h' => human_free(kib),
            _ => format!("{kib}"),
        }
    };
    let mut out = format!(
        "{:<5}{:>15}{:>12}{:>12}{:>12}{:>12}{:>12}\n",
        "", "total", "used", "free", "shared", "buff/cache", "available"
    );
    out.push_str(&format!(
        "{:<5}{:>15}{:>12}{:>12}{:>12}{:>12}{:>12}\n",
        "Mem:",
        conv(mem.0),
        conv(mem.1),
        conv(mem.2),
        conv(mem.3),
        conv(mem.4),
        conv(mem.5)
    ));
    out.push_str(&format!(
        "{:<5}{:>15}{:>12}{:>12}\n",
        "Swap:",
        conv(swap.0),
        conv(swap.1),
        conv(swap.2)
    ));
    out
}

/// `free -h`'s own human shape: Ki/Mi/Gi with the same below-ten rule.
fn human_free(kib: u64) -> String {
    if kib == 0 {
        return "0".to_owned();
    }
    let units = ["Ki", "Mi", "Gi", "Ti"];
    let mut value = kib as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < units.len() {
        value /= 1024.0;
        unit += 1;
    }
    if value < 10.0 {
        format!("{value:.1}{}", units[unit])
    } else {
        format!("{value:.0}{}", units[unit])
    }
}

/* ---------- ps ---------- */

/// `ps` — MSYS' process listing: every process with the PID/PPID/PGID/WINPID/TTY/UID/
/// ST/TIME/COMMAND columns. The COMMAND carries the image name (the Windows snapshot
/// has no command lines to read without opening every process); flags are accepted
/// and ignored — every form (`ps`, `ps aux`, `ps -ef`, `-W`) lists the same table.
pub fn ps(io: &Io, args: &[String]) -> super::exec::ExecResult {
    #[cfg(target_os = "macos")]
    {
        let _ = io;
        return passthrough("/bin/ps", args);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = args;
        io.out_str(&format!(
            "{:>7}{:>8}{:>8}{:>10}{:>4}{:>12}{:>8} {}\n",
            "PID", "PPID", "PGID", "WINPID", "TTY", "UID", "STIME", "COMMAND"
        ));
        let mut rows = process_rows();
        rows.sort();
        for (pid, ppid, pgid, uid, time, command) in rows {
            io.out_str(&format!(
                "{pid:>7}{ppid:>8}{pgid:>8}{pid:>10}{:>4}{uid:>12}{time:>8} {command}\n",
                "?",
            ));
        }
        Ok(0)
    }
}

/// (pid, ppid, pgid, uid, "m:ss.cc", command) per process.
#[cfg(windows)]
fn process_rows() -> Vec<(u32, u32, u32, u32, String, String)> {
    let mut rows = Vec::new();
    let snapshot = unsafe { win::CreateToolhelp32Snapshot(0x2, 0) }; // TH32CS_SNAPPROCESS
    if snapshot.is_null() {
        return rows;
    }
    let mut entry = win::ProcessEntry32W {
        dw_size: std::mem::size_of::<win::ProcessEntry32W>() as u32,
        cnt_usage: 0,
        th32_process_id: 0,
        th32_default_heap_id: 0,
        th32_module_id: 0,
        cnt_threads: 0,
        th32_parent_process_id: 0,
        pc_pri_class_base: 0,
        dw_flags: 0,
        sz_exe_file: [0; 260],
    };
    let uid = current_identity().0;
    let mut more = unsafe { win::Process32FirstW(snapshot, &mut entry) } == 1;
    while more {
        let name_len = entry
            .sz_exe_file
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(entry.sz_exe_file.len());
        let command = String::from_utf16_lossy(&entry.sz_exe_file[..name_len]);
        rows.push((
            entry.th32_process_id,
            entry.th32_parent_process_id,
            entry.th32_process_id,
            uid,
            process_time(entry.th32_process_id),
            command,
        ));
        more = unsafe { win::Process32NextW(snapshot, &mut entry) } == 1;
    }
    unsafe { win::CloseHandle(snapshot) };
    rows
}

/// The kernel+user CPU time as MSYS prints it, `m:ss.cc`.
#[cfg(windows)]
fn process_time(pid: u32) -> String {
    let mut created = win::FileTime::default();
    let mut exited = win::FileTime::default();
    let mut kernel = win::FileTime::default();
    let mut user = win::FileTime::default();
    let handle = unsafe { win::OpenProcess(0x1000, 0, pid) }; // QUERY_LIMITED_INFORMATION
    if handle.is_null() {
        return "0:00.00".to_owned();
    }
    let ok = unsafe {
        win::GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user)
    } == 1;
    unsafe { win::CloseHandle(handle) };
    if !ok {
        return "0:00.00".to_owned();
    }
    let ticks = kernel.as_u64().saturating_add(user.as_u64());
    format_cpu_time(ticks / 10_000) // 100 ns units → microseconds
}

#[cfg(target_os = "linux")]
fn process_rows() -> Vec<(u32, u32, u32, u32, String, String)> {
    let mut rows = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return rows;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some((comm, after_comm)) = stat.rsplit_once(')') else {
            continue;
        };
        let fields: Vec<&str> = after_comm.split_whitespace().collect();
        if fields.len() < 13 {
            continue;
        }
        let pid = name.parse::<u32>().unwrap_or(0);
        let ppid = fields[1].parse::<u32>().unwrap_or(0);
        let pgid = fields[2].parse::<u32>().unwrap_or(0);
        let ticks =
            fields[11].parse::<u64>().unwrap_or(0) + fields[12].parse::<u64>().unwrap_or(0);
        let uid = std::fs::read_to_string(entry.path().join("status"))
            .ok()
            .and_then(|status| {
                status
                    .lines()
                    .find(|line| line.starts_with("Uid:"))
                    .and_then(|line| line.split_whitespace().nth(1).map(String::from))
            })
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0);
        let comm_name = comm.rsplit('(').next().unwrap_or("").to_owned();
        let command = match std::fs::read_to_string(entry.path().join("cmdline")) {
            Ok(raw) if raw.contains('\0') => {
                let joined = raw.replace('\0', " ").trim().to_owned();
                if joined.is_empty() {
                    format!("[{comm_name}]")
                } else {
                    joined
                }
            }
            _ => format!("[{comm_name}]"),
        };
        rows.push((
            pid,
            ppid,
            pgid,
            uid,
            format_cpu_time(ticks * 10_000), // USER_HZ assumed 100 → microseconds
            command,
        ));
    }
    rows
}

/// Microseconds → `m:ss.cc`, the shape MSYS' ps and GNU time print.
fn format_cpu_time(micros: u64) -> String {
    let centis = micros / 10_000;
    format!(
        "{}:{:02}.{:02}",
        centis / 6000,
        (centis / 100) % 60,
        centis % 100
    )
}

/* ---------- mount / umount ---------- */

/// `mount` — the listing only: Git Bash's own implicit mounts, one row per drive
/// plus `/tmp`, in its `C: on /c type ntfs (binary,noacl,mixed)` shape. Mounting is
/// not a thing a bundled shell does; an operand explains exactly that.
pub fn mount(io: &Io, args: &[String]) -> super::exec::ExecResult {
    let operands: Vec<&String> = args.iter().filter(|arg| !arg.starts_with('-')).collect();
    if !operands.is_empty() {
        io.err_str("mount: only the listing is supported (ggs-bash carries no mounts to make)\n");
        return Ok(1);
    }
    #[cfg(windows)]
    {
        let mask = unsafe { win::GetLogicalDrives() };
        for index in 0..26u32 {
            if mask & (1 << index) == 0 {
                continue;
            }
            let letter = (b'A' + index as u8) as char;
            let root = format!("{letter}:\\");
            let kind = volume_kind(&root);
            io.out_str(&format!(
                "{letter}: on /{} type {kind} (binary,noacl,posix=0,user,noumount,auto)\n",
                letter.to_ascii_lowercase()
            ));
        }
        Ok(0)
    }
    #[cfg(target_os = "linux")]
    {
        let mounts = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
        for line in mounts.lines() {
            let mut fields = line.split(' ');
            let (Some(device), Some(dir), Some(kind)) =
                (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            let options = line.split(' ').nth(3).unwrap_or("rw");
            io.out_str(&format!(
                "{device} on {} type {kind} ({options})\n",
                dir.replace("\\040", " ")
            ));
        }
        Ok(0)
    }
    #[cfg(target_os = "macos")]
    {
        passthrough("/sbin/mount", &[])
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = io;
        Ok(0)
    }
}

/// `umount` — nothing of ours is ever mounted; the honest refusal.
pub fn umount(io: &Io, args: &[String]) -> super::exec::ExecResult {
    let target = args
        .iter()
        .find(|arg| !arg.starts_with('-'))
        .map(String::as_str)
        .unwrap_or("?");
    io.err_str(&format!("umount: {target}: not mounted\n"));
    Ok(1)
}

/* ---------- id / groups / logname ---------- */

/// The MSYS-style identity: (uid, gid, name). Windows folds the user's SID the way
/// Cygwin does — the domain halves XOR-folded above the RID, the primary group at
/// RID 513 ("None") — so the numbers answer exactly as Git Bash's own `id`.
pub fn current_identity() -> (u32, u32, String) {
    let name = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default()
        .to_lowercase();
    let name = if name.is_empty() { "user".to_owned() } else { name };
    #[cfg(windows)]
    {
        if let Some((uid, gid)) = token_identity() {
            return (uid, gid, name);
        }
        (197609, 197121, name)
    }
    #[cfg(unix)]
    {
        extern "C" {
            fn getuid() -> u32;
            fn getgid() -> u32;
        }
        let (uid, gid) = unsafe { (getuid(), getgid()) };
        (uid, gid, name)
    }
    #[cfg(not(any(windows, unix)))]
    {
        (0, 0, name)
    }
}

/// Read the current process token's user SID and fold it MSYS-style.
#[cfg(windows)]
fn token_identity() -> Option<(u32, u32)> {
    use std::os::raw::c_void;
    let mut token: *mut c_void = core::ptr::null_mut();
    if unsafe { win::OpenProcessToken(win::GetCurrentProcess(), 0x0008, &mut token) } != 1 {
        return None;
    }
    let mut needed = 0u32;
    unsafe { win::GetTokenInformation(token, 1, core::ptr::null_mut(), 0, &mut needed) };
    if needed == 0 {
        unsafe { win::CloseHandle(token) };
        return None;
    }
    let mut buffer = vec![0u8; needed as usize];
    let ok = unsafe {
        win::GetTokenInformation(
            token,
            1, // TokenUser
            buffer.as_mut_ptr() as *mut c_void,
            needed,
            &mut needed,
        )
    } == 1;
    unsafe { win::CloseHandle(token) };
    if !ok || buffer.len() < std::mem::size_of::<usize>() {
        return None;
    }
    // TOKEN_USER { SID_AND_ATTRIBUTES { Sid, Attributes } } — the SID pointer first.
    let sid = usize::from_le_bytes(
        buffer[..std::mem::size_of::<usize>()]
            .try_into()
            .ok()?,
    ) as *const u8;
    unsafe {
        let count = *sid.add(1) as usize;
        if count == 0 || count > 8 {
            return None;
        }
        let mut authority = [0u8; 6];
        for (index, slot) in authority.iter_mut().enumerate() {
            *slot = *sid.add(2 + index);
        }
        let mut sub = [0u32; 8];
        for (index, slot) in sub.iter_mut().enumerate().take(count) {
            *slot = u32::from_le_bytes(
                core::slice::from_raw_parts(sid.add(8 + index * 4), 4)
                    .try_into()
                    .unwrap(),
            );
        }
        if authority == [0, 0, 0, 0, 0, 5] && sub[0] == 21 && count >= 3 {
            // Cygwin folds EVERY machine subauthority into the high half.
            let fold = sub[1..count - 1].iter().fold(0u32, |acc, value| acc ^ value) & 0xFFFF;
            let rid = sub[count - 1] & 0xFFFF;
            Some(((fold << 16) | rid, (fold << 16) | 513))
        } else {
            // Non-domain SIDs (the well-known accounts): the RID stands alone.
            let rid = sub[count - 1];
            Some((rid, rid))
        }
    }
}

/// `id` — the identity line with `-u`/`-g`/`-G`/`-n` selectors.
pub fn id(io: &Io, args: &[String]) -> super::exec::ExecResult {
    let flags: String = args
        .iter()
        .filter(|arg| arg.starts_with('-') && arg.len() > 1)
        .flat_map(|arg| arg[1..].chars())
        .collect();
    if flags.chars().any(|c| !matches!(c, 'u' | 'g' | 'G' | 'n' | 'r')) {
        io.err_str("id: invalid option\n");
        return Ok(1);
    }
    let (uid, gid, name) = current_identity();
    // Git Bash without mkpasswd lists the primary group by number alone.
    let group_name = if cfg!(windows) {
        String::new()
    } else {
        name.clone()
    };
    if flags.contains('u') {
        io.out_str(&format!(
            "{}\n",
            if flags.contains('n') {
                name
            } else {
                uid.to_string()
            }
        ));
        return Ok(0);
    }
    if flags.contains('g') || flags.contains('G') {
        io.out_str(&format!(
            "{}\n",
            if flags.contains('n') {
                group_name
            } else {
                gid.to_string()
            }
        ));
        return Ok(0);
    }
    if group_name.is_empty() {
        io.out_str(&format!("uid={uid}({name}) gid={gid} groups={gid}\n"));
    } else {
        io.out_str(&format!(
            "uid={uid}({name}) gid={gid}({group_name}) groups={gid}({group_name})\n"
        ));
    }
    Ok(0)
}

/// `groups` — the primary group's name (Windows has no group list to walk without a
/// token query per group; Git Bash's own answer for a local user is `None`).
pub fn groups(io: &Io) -> super::exec::ExecResult {
    let (_uid, gid, _name) = current_identity();
    // No group database on this side of the bridge: the number, with
    // GNU's cannot-find-name warning ahead of it.
    io.err_str(&format!("groups: cannot find name for group ID {gid}\n"));
    io.out_str(&format!("{gid}\n"));
    Ok(0)
}

/// `logname` — the session user, Git Bash's lowercase shape.
pub fn logname(io: &Io) -> super::exec::ExecResult {
    let (_, _, name) = current_identity();
    io.out_str(&format!("{name}\n"));
    Ok(0)
}

/* ---------- tty / nproc / arch ---------- */

/// `tty` — `/dev/tty` when the shell's own stdin is a terminal, `not a tty`
/// (exit 1) otherwise. A pipeline's stdin is never the terminal.
pub fn tty(io: &Io) -> super::exec::ExecResult {
    if matches!(io.stdin, super::exec::Source::Inherit) && stdin_is_terminal() {
        io.out_str("/dev/tty\n");
        Ok(0)
    } else {
        io.err_str("not a tty\n");
        Ok(1)
    }
}

/// The terminal's (columns, rows) — `tput cols`/`stty size`'s answer. Windows reads
/// the console buffer, elsewhere the COLUMNS/LINES convention with an 80x24 floor.
pub fn console_dimensions() -> (u16, u16) {
    #[cfg(windows)]
    {
        if let Some((columns, rows)) = super::applets::terminal_dimensions() {
            return (columns as u16, rows as u16);
        }
    }
    let columns = std::env::var("COLUMNS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(80);
    let rows = std::env::var("LINES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(24);
    (columns.max(1), rows.max(1))
}

/// Whether the process's own stdout is a terminal — `nohup`'s redirect question.
pub fn stdout_is_terminal() -> bool {
    #[cfg(windows)]
    {
        let mut mode = 0u32;
        unsafe {
            let handle = win::GetStdHandle(-11);
            win::GetConsoleMode(handle, &mut mode) == 1
        }
    }
    #[cfg(not(windows))]
    {
        extern "C" {
            #[link_name = "isatty"]
            fn libc_isatty(fd: i32) -> i32;
        }
        unsafe { libc_isatty(1) == 1 }
    }
}

#[cfg(windows)]
pub fn stdin_is_terminal() -> bool {
    let mut mode = 0u32;
    unsafe {
        let handle = win::GetStdHandle(-10);
        win::GetConsoleMode(handle, &mut mode) == 1
    }
}

#[cfg(unix)]
fn stdin_is_terminal() -> bool {
    extern "C" {
        #[link_name = "isatty"]
        fn libc_isatty(fd: i32) -> i32;
    }
    unsafe { libc_isatty(0) == 1 }
}

#[cfg(not(any(windows, unix)))]
fn stdin_is_terminal() -> bool {
    false
}

/// `nproc` — the parallelism the runtime sees.
pub fn nproc(io: &Io) -> super::exec::ExecResult {
    let count = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    io.out_str(&format!("{count}\n"));
    Ok(0)
}

/// `arch` — `uname -m`'s answer (`x86_64` under MSYS' identity).
pub fn arch(io: &Io) -> super::exec::ExecResult {
    let machine = if cfg!(windows) {
        "x86_64".to_owned()
    } else {
        std::env::consts::ARCH.to_owned()
    };
    io.out_str(&format!("{machine}\n"));
    Ok(0)
}

/* ---------- start ---------- */

/// `start` — Git Bash's opener: hand a file, a folder or a URL to the OS (`open`
/// through the shell, `xdg-open`/`open` elsewhere). Every operand opens once.
pub fn start(shell: &Shell, io: &Io, args: &[String]) -> super::exec::ExecResult {
    let targets: Vec<&String> = args.iter().filter(|arg| !arg.starts_with('-')).collect();
    if targets.is_empty() {
        io.err_str("start: a file, folder or URL is required\n");
        return Ok(1);
    }
    let mut status = 0;
    for target in targets {
        let looks_like_url = target.contains("://");
        #[cfg(windows)]
        {
            let path = if looks_like_url {
                target.to_owned()
            } else if target == "." {
                shell.cwd.display().to_string().replace('\\', "/")
            } else {
                shell
                    .resolve_working_path(target)
                    .display()
                    .to_string()
                    .replace('\\', "/")
            };
            let opened = unsafe {
                win::ShellExecuteW(
                    core::ptr::null_mut(),
                    wide("open").as_ptr(),
                    wide(&path).as_ptr(),
                    core::ptr::null(),
                    core::ptr::null(),
                    1, // SW_SHOWNORMAL
                )
            };
            if opened <= 32 {
                io.err_str(&format!("start: {target}: cannot open\n"));
                status = 1;
            }
        }
        #[cfg(not(windows))]
        {
            let opener = if cfg!(target_os = "macos") {
                "open"
            } else {
                "xdg-open"
            };
            let path = if looks_like_url {
                std::path::PathBuf::from(target.as_str())
            } else {
                shell.resolve_working_path(target)
            };
            let attempt = std::process::Command::new(opener)
                .arg(path)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
            if attempt.is_err() {
                io.err_str(&format!("start: {opener}: command not found\n"));
                status = 1;
            }
        }
    }
    Ok(status)
}

/* ---------- The OS surfaces ---------- */

/// UTF-16 with the terminator, the string shape the W APIs take.
#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Run one of the OS's own tools with the process's stdio — the macOS shape for the
/// listings its kernel has no stable text interface for.
#[cfg(target_os = "macos")]
fn passthrough(program: &str, args: &[String]) -> super::exec::ExecResult {
    let status = std::process::Command::new(program)
        .args(args)
        .status()
        .map_err(|e| format!("{program}: {e}"))?;
    Ok(status.code().unwrap_or(1))
}

/// The Win32 surface, declared directly — no `windows-sys` dependency rides in.
#[cfg(windows)]
mod win {
    use std::os::raw::c_void;

    #[repr(C)]
    #[derive(Default)]
    pub(super) struct FileTime {
        pub dw_low_date_time: u32,
        pub dw_high_date_time: u32,
    }

    impl FileTime {
        pub fn as_u64(&self) -> u64 {
            (self.dw_high_date_time as u64) << 32 | self.dw_low_date_time as u64
        }
    }

    #[repr(C)]
    pub(super) struct MemoryStatusEx {
        pub dw_length: u32,
        pub dw_memory_load: u32,
        pub ull_total_phys: u64,
        pub ull_avail_phys: u64,
        pub ull_total_page_file: u64,
        pub ull_avail_page_file: u64,
        pub ull_total_virtual: u64,
        pub ull_avail_virtual: u64,
        pub ull_avail_extended_virtual: u64,
    }

    #[repr(C)]
    pub(super) struct ProcessEntry32W {
        pub dw_size: u32,
        pub cnt_usage: u32,
        pub th32_process_id: u32,
        pub th32_default_heap_id: usize,
        pub th32_module_id: u32,
        pub cnt_threads: u32,
        pub th32_parent_process_id: u32,
        pub pc_pri_class_base: i32,
        pub dw_flags: u32,
        pub sz_exe_file: [u16; 260],
    }

    extern "system" {
        pub fn GetLogicalDrives() -> u32;
        pub fn GetDiskFreeSpaceExW(
            directory: *const u16,
            free_bytes_available: *mut u64,
            total_bytes: *mut u64,
            total_free_bytes: *mut u64,
        ) -> i32;
        pub fn GetVolumeInformationW(
            root: *const u16,
            volume_name: *mut u16,
            volume_name_size: u32,
            volume_serial: *mut u32,
            max_component_length: *mut u32,
            filesystem_flags: *mut u32,
            filesystem_name: *mut u16,
            filesystem_name_size: u32,
        ) -> i32;
        pub fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
        pub fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> *mut c_void;
        pub fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        pub fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        pub fn OpenProcess(
            desired_access: u32,
            inherit_handle: i32,
            process_id: u32,
        ) -> *mut c_void;
        pub fn GetProcessTimes(
            process: *mut c_void,
            creation_time: *mut FileTime,
            exit_time: *mut FileTime,
            kernel_time: *mut FileTime,
            user_time: *mut FileTime,
        ) -> i32;
        pub fn GetCurrentProcess() -> *mut c_void;
        pub fn OpenProcessToken(
            process: *mut c_void,
            desired_access: u32,
            token: *mut *mut c_void,
        ) -> i32;
        pub fn GetTokenInformation(
            token_handle: *mut c_void,
            token_information_class: u32,
            token_information: *mut c_void,
            token_information_length: u32,
            return_length: *mut u32,
        ) -> i32;
        pub fn GetStdHandle(which: i32) -> *mut c_void;
        pub fn GetConsoleMode(handle: *mut c_void, mode: *mut u32) -> i32;
        pub fn CloseHandle(handle: *mut c_void) -> i32;
    }

    #[link(name = "shell32")]
    extern "system" {
        pub fn ShellExecuteW(
            hwnd: *mut c_void,
            verb: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> isize;
    }
}

/* ---------- Tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn df_humanization_follows_gnu() {
        assert_eq!(human_bytes(0, false), "0");
        assert_eq!(human_bytes(500, false), "500B");
        assert_eq!(human_bytes(1024, false), "1.0K");
        assert_eq!(human_bytes(9 * 1024 * 1024, false), "9.0M");
        assert_eq!(human_bytes(466 * 1024 * 1024 * 1024, false), "466G");
        // -H counts decimal thousands.
        assert_eq!(human_bytes(1000, true), "1.0K");
    }

    #[test]
    fn df_table_aligns_columns() {
        let rows = vec![DfRow {
            filesystem: "C:".to_owned(),
            kind: "ntfs".to_owned(),
            total: 500_000_000_000,
            used: 300_000_000_000,
            available: 200_000_000_000,
            mounted: "/c".to_owned(),
        }];
        let table = format_df_table(&rows, false, false, false);
        let mut lines = table.lines();
        let header = lines.next().unwrap();
        assert!(header.starts_with("Filesystem 1K-blocks"), "{header}");
        assert!(header.ends_with("Use% Mounted on"), "{header}");
        let row = lines.next().unwrap();
        assert!(row.starts_with("C:"), "{row}");
        assert!(row.ends_with(" 60% /c"), "{row}");
        // -T inserts the type after the filesystem; -h swaps the headers.
        let table = format_df_table(&rows, true, false, true);
        assert!(table.contains(" ntfs "), "{table}");
        assert!(table.contains("Size"), "{table}");
    }

    #[test]
    fn free_humanizes_with_the_i_suffixes() {
        assert_eq!(human_free(0), "0");
        assert_eq!(human_free(512), "512Ki");
        assert_eq!(human_free(9 * 1024 * 1024), "9.0Gi");
        assert_eq!(human_free(16 * 1024 * 1024), "16Gi");
        let table = format_free_table((1000, 400, 600, 0, 0, 600), (100, 10, 90), 'k');
        assert!(
            table.starts_with("               total        used        free"),
            "{table}"
        );
        assert!(table.contains("Mem:"), "{table}");
        assert!(table.contains("Swap:"), "{table}");
    }

    #[test]
    fn cpu_time_formats_minutes_seconds_and_centis() {
        assert_eq!(format_cpu_time(0), "0:00.00");
        assert_eq!(format_cpu_time(650_000), "0:00.65");
        assert_eq!(format_cpu_time(61_230_000), "1:01.23");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn meminfo_parses_kib_values() {
        let map = parse_meminfo("MemTotal:       16384000 kB\nMemFree:         6000000 kB\n");
        assert_eq!(map["MemTotal"], 16_384_000);
        assert_eq!(map["MemFree"], 600_000);
    }

    #[test]
    fn df_arguments_parse_flags_and_paths() {
        let (human, _, show_type, paths) =
            parse_df_args(&["-h".to_owned(), "-T".to_owned(), "/c".to_owned()]).unwrap();
        assert!(human && show_type);
        assert_eq!(paths, vec!["/c".to_owned()]);
        assert!(parse_df_args(&["-Z".to_owned()]).is_err());
    }
}
