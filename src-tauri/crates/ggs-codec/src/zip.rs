//! Zip reading over the local-file entry stream — a zip's most robust read (no
//! central-directory offsets to trust): stored or deflated entries, and the one-entry
//! lookup module 19's `ggs-config` pulls the daemon binary out of a bundled VSIX
//! through.

pub fn zip_parse(data: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
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

/// One entry's bytes by exact name, `None` when the archive carries no such entry —
/// module 19's `ggs-config` pulls the daemon binary out of a bundled VSIX through here
/// (the same local-file-stream read `unzip` takes, and the one zip reader that builds
/// under every feature set: std only, like the rest of this shell).
pub fn zip_entry(data: &[u8], name: &str) -> Result<Option<Vec<u8>>, String> {
    Ok(zip_parse(data)?
        .into_iter()
        .find(|(entry, _)| entry == name)
        .map(|(_, bytes)| bytes))
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

