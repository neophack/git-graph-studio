//! The extension logs: the store's own boot log (`~/.ggs/logs/extensions.log`, one line
//! per boot-pass action) and the extension host's log (`~/.ggs/logs/ext-host.log`, the
//! workbench's buffered records), both bounded with one rotated generation.

use std::path::Path;

use ggs_base::paths;

/// One line of the extension store's own log (`~/.ggs/logs/extensions.log`): what the boot
/// pass did to installs, readable after the fact — a GUI app has no console for stderr.
pub fn log_extensions(line: &str) {
    eprintln!("[extensions] {line}");
    let Ok(logs) = paths::logs_home() else {
        return;
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    append_bounded_log(
        &logs.join("extensions.log"),
        &[format!("{stamp} {line}")],
        1024 * 1024,
    );
}

/// Append lines to a bounded log: past `limit` bytes the file rotates to `<name>.1` (one
/// previous generation kept, so the lines leading up to a rotation stay readable).
pub fn append_bounded_log(path: &Path, lines: &[String], limit: u64) {
    if std::fs::metadata(path).is_ok_and(|m| m.len() > limit) {
        let mut previous = path.as_os_str().to_owned();
        previous.push(".1");
        let _ = std::fs::remove_file(&previous);
        let _ = std::fs::rename(path, &previous);
    }
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        for line in lines {
            let _ = writeln!(file, "{line}");
        }
    }
}

/// The extension host's log size bound (then one rotated generation beside it).
const EXT_HOST_LOG_LIMIT: u64 = 4 * 1024 * 1024;

/// Append the workbench's buffered extension-host log lines (`src/extLog.ts`) to
/// `~/.ggs/logs/ext-host.log`: activation failures, handler exceptions, unsupported API
/// calls, bridge errors — everything a foreign package trips over, readable after the
/// fact. Each line arrives already formatted (timestamp, level, source, message).
pub fn append_host_log(lines: Vec<String>) -> Result<(), String> {
    let logs = paths::logs_home().map_err(|_| "no ~/.ggs/logs directory".to_owned())?;
    // A single line never carries a newline into the file (a stack is joined with " | "
    // by the writer); a runaway line is capped so one message cannot flood the log.
    let lines: Vec<String> = lines
        .into_iter()
        .map(|line| {
            let flat = line.replace(['\r', '\n'], " | ");
            if flat.len() > 8192 {
                let mut cut = 8192;
                while !flat.is_char_boundary(cut) {
                    cut -= 1;
                }
                format!("{}…", &flat[..cut])
            } else {
                flat
            }
        })
        .collect();
    append_bounded_log(&logs.join("ext-host.log"), &lines, EXT_HOST_LOG_LIMIT);
    Ok(())
}

/// Where the extension host's log file lives (the "Open Extension Host Log" command).
pub fn host_log_path() -> Result<String, String> {
    let logs = paths::logs_home().map_err(|_| "no ~/.ggs/logs directory".to_owned())?;
    Ok(logs.join("ext-host.log").to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_log_appends_and_rotates_one_generation() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("ext-host.log");
        append_bounded_log(&path, &["one".to_owned(), "two".to_owned()], 1024);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "one\ntwo\n");
        // Past the bound the current file becomes `.1` and a fresh one starts.
        append_bounded_log(&path, &["x".repeat(2048)], 1024);
        append_bounded_log(&path, &["after".to_owned()], 1024);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after\n");
        let previous = std::fs::read_to_string(tmp.path().join("ext-host.log.1")).unwrap();
        assert!(previous.starts_with("one\ntwo\n"));
    }
}
