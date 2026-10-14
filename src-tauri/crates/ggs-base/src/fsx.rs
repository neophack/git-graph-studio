//! The small filesystem helpers every domain crate reuses: the multi-instance-safe
//! atomic write, URL percent-decoding, the memory-bounded line reader, and the
//! tempfile-shaped scratch directory/file guards that keep the runtime tree free of the
//! tempfile crate.

use std::path::{Path, PathBuf};

/// One user-data file write, safe across the app's processes: the app is multi-instance
/// (every launch is its own process and window), so two instances can write the same
/// `~/.ggs` file at once. The contents go to a process-unique temp sibling, then a single
/// rename replaces the target — a concurrent reader (another instance booting, the MCP
/// mode) sees the old or the new whole file, never a torn one, and two writers never
/// share a temp name.
pub fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let stem = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_owned());
    let tmp = path.with_file_name(format!(".{stem}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, contents).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("replace {}: {e}", path.display()))
}

/// Percent-decode a URL path; invalid escapes pass through untouched. Byte-wise on
/// purpose: slicing the `&str` at arbitrary offsets would panic inside multi-byte
/// characters. A literal `+` stays a `+` — URI PATH semantics (a plus-for-space decode
/// here would 404 every asset whose name carries one: `a+b.js`, `c++/`).
pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'%' if at + 2 < bytes.len() => {
                let hi = (bytes[at + 1] as char).to_digit(16);
                let lo = (bytes[at + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(hi), Some(lo)) => {
                        out.push((hi * 16 + lo) as u8);
                        at += 3;
                    }
                    _ => {
                        out.push(b'%');
                        at += 1;
                    }
                }
            }
            b'+' => {
                out.push(b'+');
                at += 1;
            }
            byte => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The line cap of [`read_line_bounded`]: a line past this is consumed and discarded —
/// a gigabyte without a newline cannot become a gigabyte string.
pub const MAX_LINE_BYTES: usize = 1 << 20;

/// The outcome of one [`read_line_bounded`] call.
pub enum LineRead {
    /// A whole line, its `\n` (and any `\r` before it) already stripped.
    Line,
    /// A line past `MAX_LINE_BYTES`: consumed and discarded.
    Overlong,
    /// The input ended.
    Eof,
}

/// Reads one `\n`-terminated line into `buf` (cleared first), never letting `buf` grow
/// past `MAX_LINE_BYTES`. `bytes` accumulates everything consumed, including discarded
/// overlong runs.
pub fn read_line_bounded<R: std::io::BufRead>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    bytes: &mut u64,
) -> std::io::Result<LineRead> {
    buf.clear();
    loop {
        let available = match reader.fill_buf() {
            Ok(a) => a,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if available.is_empty() {
            return Ok(if buf.is_empty() {
                LineRead::Eof
            } else {
                LineRead::Line
            });
        }
        let newline = memchr::memchr(b'\n', available);
        match newline {
            Some(i) => {
                if buf.len() + i <= MAX_LINE_BYTES {
                    buf.extend_from_slice(&available[..i]);
                }
                *bytes += i as u64 + 1;
                reader.consume(i + 1);
                if buf.len() + i > MAX_LINE_BYTES {
                    buf.clear();
                    return Ok(LineRead::Overlong);
                }
                // A Windows `\r\n` ends with the carriage return just before the newline.
                if buf.last() == Some(&b'\r') {
                    buf.pop();
                }
                return Ok(LineRead::Line);
            }
            None => {
                let take = if buf.len() + available.len() <= MAX_LINE_BYTES {
                    buf.extend_from_slice(available);
                    available.len()
                } else {
                    // Past the cap: stop storing, keep scanning for the newline.
                    buf.clear();
                    available.len()
                };
                *bytes += take as u64;
                reader.consume(take);
            }
        }
    }
}

/// A self-made scratch directory with tempfile's remove-on-drop shape: the runtime tree
/// carries no tempfile dependency (tests keep theirs in dev-dependencies), so the
/// headless probes and any binary linking a ggs crate stay free of it.
pub struct ScratchDir(pub PathBuf);

impl ScratchDir {
    pub fn new(prefix: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&path).expect("scratch dir");
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A scratch FILE with tempfile's remove-on-drop shape, without the crate. The guard
/// deletes the named file when it drops — after the File handle into it has closed
/// (declare guards before handles: locals drop in reverse). A crashed process may leave
/// the file behind in the OS temp dir — that is the temp dir's own cleanup story.
pub struct ScratchFileGuard(pub PathBuf);

impl Drop for ScratchFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Creates an unnamed-on-purpose unique scratch file: the handle and the guard that
/// removes it on drop.
pub fn scratch_file(prefix: &str) -> std::io::Result<(std::fs::File, ScratchFileGuard)> {
    static COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let unique = format!(
        "{prefix}-{}-{}",
        std::process::id(),
        COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let path = std::env::temp_dir().join(unique);
    let file = std::fs::File::options()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)?;
    Ok((file, ScratchFileGuard(path)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_whole_and_creates_parents() {
        let dir = ScratchDir::new("ggs-base-atomic");
        let nested = dir.path().join("a/b/settings.json");
        atomic_write(&nested, b"{\"theme\":\"dark\"}").unwrap();
        assert_eq!(std::fs::read(&nested).unwrap(), b"{\"theme\":\"dark\"}");
        atomic_write(&nested, b"{\"theme\":\"light\"}").unwrap();
        assert_eq!(std::fs::read(&nested).unwrap(), b"{\"theme\":\"light\"}");
        // No temp sibling survives.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path().join("a/b"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec!["settings.json".to_string()]);
    }

    #[test]
    fn percent_decode_passes_invalid_escapes_and_plus_through() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("a%2zb"), "a%2zb");
        assert_eq!(percent_decode("a+b%2Fc"), "a+b/c");
    }

    #[test]
    fn read_line_bounded_strips_crlf_and_reports_overlong() {
        let mut reader = std::io::Cursor::new(b"one\r\ntwo\n\n".to_vec());
        let mut buf = Vec::new();
        let mut bytes = 0u64;
        assert!(matches!(
            read_line_bounded(&mut reader, &mut buf, &mut bytes),
            Ok(LineRead::Line)
        ));
        assert_eq!(buf, b"one");
        assert!(matches!(
            read_line_bounded(&mut reader, &mut buf, &mut bytes),
            Ok(LineRead::Line)
        ));
        assert_eq!(buf, b"two");
        // The empty line before EOF still reads as a line, then EOF.
        assert!(matches!(
            read_line_bounded(&mut reader, &mut buf, &mut bytes),
            Ok(LineRead::Line)
        ));
        assert!(buf.is_empty());
        assert!(matches!(
            read_line_bounded(&mut reader, &mut buf, &mut bytes),
            Ok(LineRead::Eof)
        ));

        // An overlong line reports Overlong when its newline arrives; the bytes counter
        // still saw everything. An unterminated overlong run reads as Eof (buf stayed
        // empty) — the caller's `bytes` is what tells it content was consumed.
        let mut overlong = vec![b'x'; MAX_LINE_BYTES + 5];
        overlong.push(b'\n');
        let mut big = std::io::Cursor::new(overlong);
        assert!(matches!(
            read_line_bounded(&mut big, &mut buf, &mut bytes),
            Ok(LineRead::Overlong)
        ));
        assert!(buf.is_empty());

        let mut unterminated = std::io::Cursor::new(vec![b'y'; MAX_LINE_BYTES + 2]);
        let before = bytes;
        assert!(matches!(
            read_line_bounded(&mut unterminated, &mut buf, &mut bytes),
            Ok(LineRead::Eof)
        ));
        assert!(bytes > before);
    }
}
