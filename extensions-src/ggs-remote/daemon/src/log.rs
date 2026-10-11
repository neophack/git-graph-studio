//! The daemon's log, `~/.ggs/logs/remote.log`, rotated past 1 MB (docs/ggs-remote-plan.md
//! §4.1). A dozen lines instead of `tracing`: the daemon logs a handful of events per minute
//! and every resident kilobyte counts. Never log passwords, tokens or file contents (§16);
//! [`redact_path`] masks a resource token inside a request path.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

static LOG: Mutex<Option<PathBuf>> = Mutex::new(None);
const ROTATE_BYTES: u64 = 1 << 20;

pub fn init(path: PathBuf) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    *LOG.lock().unwrap() = Some(path);
}

pub fn write(level: &str, message: &str) {
    let line = format!("{} {level} {message}\n", crate::util::now_rfc3339());
    eprint!("{line}");
    let guard = LOG.lock().unwrap();
    let Some(path) = guard.as_ref() else { return };
    if std::fs::metadata(path)
        .map(|m| m.len() > ROTATE_BYTES)
        .unwrap_or(false)
    {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = file.write_all(line.as_bytes());
    }
}

#[macro_export]
macro_rules! info {
    ($($arg:tt)*) => { $crate::log::write("INFO", &format!($($arg)*)) };
}

#[macro_export]
macro_rules! warn {
    ($($arg:tt)*) => { $crate::log::write("WARN", &format!($($arg)*)) };
}

/// Mask the resource token of a `/w/<inst>/ggs/<tok>/…` path down to its first six characters.
pub fn redact_path(path: &str) -> String {
    let mut parts: Vec<String> = path.split('/').map(str::to_owned).collect();
    for i in 0..parts.len().saturating_sub(1) {
        if parts[i] == "ggs" && i >= 2 && parts[i - 2] == "w" {
            let token = &parts[i + 1];
            parts[i + 1] = format!("{}…", &token[..token.len().min(6)]);
        }
    }
    parts.join("/")
}

#[cfg(test)]
mod tests {
    #[test]
    fn redacts_resource_tokens() {
        assert_eq!(
            super::redact_path("/w/ggs-1/ggs/abcdefghijklmnop/pkg/index.html"),
            "/w/ggs-1/ggs/abcdef…/pkg/index.html"
        );
        assert_eq!(
            super::redact_path("/w/ggs-1/v/0.1/remote.html"),
            "/w/ggs-1/v/0.1/remote.html"
        );
    }
}
