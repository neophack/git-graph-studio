//! The file probe that routes an open: the size, a binary sniff, a long-lines check —
//! one small read that decides hex viewer vs windowed viewer vs editor, so no path
//! ever reads a large file only to find out it should not have.

use serde::Serialize;

/// What the editor learns about a file before reading its body: the size, and whether the
/// first bytes look binary. One small read routes the open - a binary file straight to the
/// hex viewer, a very large text file to the windowed viewer, the rest to the editor -
/// so no path ever reads a large file only to find out it should not have.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileProbe {
    pub size: u64,
    pub binary: bool,
    /// The head shows no line breaks within multi-kilobyte runs: a minified single-line
    /// file, whose few enormous lines defeat a line-windowed editor (its window would be
    /// the whole file). Those open in the full editor instead.
    pub long_lines: bool,
}

/// The probe behind the app's `file_probe` command, reading at most the sniff window.
pub fn probe(path: &str) -> Result<FileProbe, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let size = file.metadata().map_err(|e| format!("{path}: {e}"))?.len();
    let mut head = Vec::with_capacity(crate::encoding::SNIFF_BYTES);
    file.by_ref()
        .take(crate::encoding::SNIFF_BYTES as u64)
        .read_to_end(&mut head)
        .map_err(|e| format!("{path}: {e}"))?;
    Ok(FileProbe {
        size,
        binary: crate::encoding::looks_binary(&head),
        long_lines: head_has_long_lines(&head, size),
    })
}

/// A sniffed head with any run of 4 KiB without a line break — or no break at all in a file
/// over 1 MiB — marks the file as minified-style. (The sniff window is 8000 bytes, so the
/// threshold has to sit inside it; the frontend only consults this for files it would
/// otherwise window, where even a 4 KiB line is a sign the file has few, huge lines.)
fn head_has_long_lines(head: &[u8], size: u64) -> bool {
    const LONG_LINE: usize = 4 * 1024;
    let mut run = 0usize;
    let mut saw_break = false;
    for &byte in head {
        if byte == b'\n' {
            saw_break = true;
            run = 0;
        } else {
            run += 1;
            if run >= LONG_LINE {
                return true;
            }
        }
    }
    // No break anywhere in the sniff window: a file this size is one huge (minified) line.
    !saw_break && size > 1024 * 1024
}

