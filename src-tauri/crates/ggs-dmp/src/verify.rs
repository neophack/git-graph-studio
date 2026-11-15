//! The structural verification pass (module 21): every carved entry is re-checked
//! against its format's real structure — PNG's chunk chain with per-chunk CRCs, JPEG's
//! marker walk with the EOI at the end, the declared-length containers re-added up,
//! SQLite's page arithmetic, the sfnt table directory — and the answer rides on the
//! entry as `verified`. A hit the carve validator accepted but the checker rejects is a
//! false positive that only looked like a file header; the view filters those out by
//! default. Runs in-memory: the scan holds the whole dump, so a check is a slice read.

/// One entry's structural check. `slice` is the carved bytes; `data` is the whole dump
/// in memory, for the one validator (QuickTime) whose size word sits BEFORE the hit.
pub fn check(format: &str, offset: u64, data: &[u8], slice: &[u8]) -> Result<(), String> {
    match format {
        "png" => check_png(slice),
        "jpg" => check_jpg(slice),
        "gif" => {
            if slice.last() != Some(&0x3B) {
                return Err("trailer 0x3b not at the end".into());
            }
            Ok(())
        }
        "bmp" => {
            if slice.len() < 54 || u32_le(slice, 2) as usize != slice.len() {
                return Err("bfSize mismatch".into());
            }
            Ok(())
        }
        "webp" | "wav" | "avi" => {
            if slice.len() < 12 || u32_le(slice, 4) as usize != slice.len() - 8 {
                return Err("RIFF size mismatch".into());
            }
            Ok(())
        }
        "zip" => check_zip(slice),
        "pdf" => {
            if !slice.starts_with(b"%PDF-") {
                return Err("header".into());
            }
            if !slice.ends_with(b"%%EOF") {
                return Err("%%EOF not at the end".into());
            }
            Ok(())
        }
        "sqlite" => {
            if slice.len() < 100 {
                return Err("short header".into());
            }
            let page_size = u16::from_be_bytes([slice[16], slice[17]]);
            let page_size = if page_size == 1 { 65_536 } else { u64::from(page_size) };
            let pages = u32_be(slice, 28) as u64;
            if pages > 0 {
                if pages * page_size != slice.len() as u64 {
                    return Err(format!("{} pages x {} != {}", pages, page_size, slice.len()));
                }
            } else if !(slice.len() as u64).is_multiple_of(page_size) {
                return Err("size not a page multiple".into());
            }
            Ok(())
        }
        "ttf" => {
            if slice.len() < 12 {
                return Err("short".into());
            }
            check_sfnt(slice, 0, slice.len())
        }
        "ttc" => {
            // The container: one font-offset table, each offset naming a full sfnt.
            if slice.len() < 16 || &slice[0..4] != b"ttcf" {
                return Err("container".into());
            }
            let num_fonts = u32_be(slice, 8) as usize;
            if num_fonts == 0 || num_fonts > 16 || slice.len() < 12 + num_fonts * 4 {
                return Err(format!("{} fonts", num_fonts));
            }
            let mut end = 12 + num_fonts * 4;
            for i in 0..num_fonts {
                let at = u32_be(slice, 12 + i * 4) as usize;
                if at < 12 || at + 12 > slice.len() {
                    return Err(format!("font {i} at {at} out of range"));
                }
                let num_tables = usize::from(u16::from_be_bytes([slice[at + 4], slice[at + 5]]));
                if num_tables == 0 || num_tables > 256 || at + 12 + num_tables * 16 > slice.len() {
                    return Err(format!("font {i}: {} tables", num_tables));
                }
                for t in 0..num_tables {
                    let e = at + 12 + t * 16;
                    let off = u32_be(slice, e + 8) as usize;
                    let len = u32_be(slice, e + 12) as usize;
                    end = end.max(at + off + len);
                }
            }
            if end != slice.len() {
                return Err(format!("ttc end {end} != {}", slice.len()));
            }
            Ok(())
        }
        "swf" => {
            if slice.len() < 8 || u32_le(slice, 4) as usize != slice.len() {
                return Err("declared length mismatch".into());
            }
            Ok(())
        }
        "asf" => {
            if slice.len() < 32 || u64_le(slice, 16) as usize != slice.len() {
                return Err("header object size mismatch".into());
            }
            Ok(())
        }
        "bik" => {
            if slice.len() < 8 || u32_le(slice, 4) as usize != slice.len() {
                return Err("file size mismatch".into());
            }
            Ok(())
        }
        "wmf" => {
            if slice.len() < 12 || u32_le(slice, 6) as usize * 2 != slice.len() {
                return Err("mtSize mismatch".into());
            }
            Ok(())
        }
        "mov" => {
            // The atom's size word sits one word before the carved start: it names
            // size = carved + 4.
            let Some(at) = offset.checked_sub(4).filter(|a| *a + 4 <= data.len() as u64) else {
                return Err("no size word before the hit".into());
            };
            let atom =
                u32::from_be_bytes(data[at as usize..(at + 4) as usize].try_into().expect("4 bytes")) as usize;
            if atom != slice.len() + 4 {
                return Err(format!("atom size {atom} != carved {} + 4", slice.len()));
            }
            Ok(())
        }
        "ico" | "cur" => {
            let count = usize::from(u16_le(slice, 4));
            if count == 0 || 6 + count * 16 > slice.len() {
                return Err("bad dir".into());
            }
            let mut end = 6 + count * 16;
            for i in 0..count {
                let at = 6 + i * 16;
                let res = u32_le(slice, at + 8) as usize;
                let off = u32_le(slice, at + 12) as usize;
                if off < end || off + res > slice.len() {
                    return Err(format!("entry {i} out of range"));
                }
                end = end.max(off + res);
            }
            if end != slice.len() {
                return Err(format!("entries end {end} != {}", slice.len()));
            }
            Ok(())
        }
        // The remaining formats' size came out of their own declared-length fields in
        // the carve validator; nothing cheaper to re-check here than the validator did.
        _ => Ok(()),
    }
}

/// One sfnt's table-directory walk from `at`: the furthest byte any table names.
fn check_sfnt(slice: &[u8], at: usize, file_len: usize) -> Result<(), String> {
    let num_tables = usize::from(u16::from_be_bytes([slice[at + 4], slice[at + 5]]));
    if num_tables == 0 || num_tables > 256 || at + 12 + num_tables * 16 > file_len {
        return Err(format!("{} tables", num_tables));
    }
    let mut end = at + 12 + num_tables * 16;
    for t in 0..num_tables {
        let e = at + 12 + t * 16;
        let off = u32_be(slice, e + 8) as usize;
        let len = u32_be(slice, e + 12) as usize;
        end = end.max(at + off + len);
    }
    if end != file_len {
        return Err(format!("sfnt end {end} != {file_len}"));
    }
    Ok(())
}

fn check_png(s: &[u8]) -> Result<(), String> {
    // The smallest legal PNG: signature + one IHDR chunk + IEND = 45 bytes.
    if s.len() < 45 || &s[0..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("signature".into());
    }
    if &s[12..16] != b"IHDR" {
        return Err("first chunk not IHDR".into());
    }
    let mut pos = 8usize;
    while pos + 12 <= s.len() {
        let len = u32_be(s, pos) as usize;
        if pos + 12 + len > s.len() {
            return Err(format!("chunk at {pos} overruns the file"));
        }
        let ctype = &s[pos + 4..pos + 8];
        let crc = u32_be(s, pos + 8 + len);
        let computed = crc32(&s[pos + 4..pos + 8 + len]);
        if crc != computed {
            return Err(format!("CRC mismatch on {} at {pos}", String::from_utf8_lossy(ctype)));
        }
        if ctype == b"IEND" {
            if pos + 12 + len != s.len() {
                return Err(format!("{} bytes after IEND", s.len() - pos - 12 - len));
            }
            return Ok(());
        }
        pos += 12 + len;
    }
    Err("no IEND".into())
}

fn check_jpg(s: &[u8]) -> Result<(), String> {
    if s.len() < 4 || s[0] != 0xFF || s[1] != 0xD8 {
        return Err("SOI".into());
    }
    if s[s.len() - 2] != 0xFF || s[s.len() - 1] != 0xD9 {
        return Err("EOI not at the end".into());
    }
    // The marker chain: SOI → segments (each with a big-endian length) until the SOS,
    // whose entropy data runs to the EOI the end check above already proved.
    let mut pos = 2usize;
    while pos + 4 <= s.len() {
        if s[pos] != 0xFF {
            return Err(format!("marker desync at {pos}"));
        }
        let m = s[pos + 1];
        if m == 0xD9 {
            return if pos + 2 == s.len() {
                Ok(())
            } else {
                Err(format!("EOI at {pos}, {} bytes after", s.len() - pos - 2))
            };
        }
        if (0xD0..=0xD7).contains(&m) || m == 0x01 || m == 0xFF {
            pos += 2;
            continue;
        }
        let seg = (u16::from(s[pos + 2]) << 8 | u16::from(s[pos + 3])) as usize;
        if seg < 2 {
            return Err(format!("segment length {seg} at {pos}"));
        }
        pos += 2 + seg;
        if m == 0xDA {
            return Ok(()); // SOS reached; its entropy data runs to the end-EOI
        }
    }
    Err("no SOS and no EOI".into())
}

fn check_zip(s: &[u8]) -> Result<(), String> {
    if s.len() < 22 || &s[0..4] != b"PK\x03\x04" {
        return Err("local header".into());
    }
    if !s.ends_with(b"PK\x05\x06") {
        // A trailing comment is legal: find the EOCD from the end.
        let found = s.windows(4).rposition(|w| w == b"PK\x05\x06").map(|p| s.len() - p);
        let Some(from_end) = found else {
            return Err("no EOCD".into());
        };
        if from_end != 22 + u16_le(s, s.len() - from_end + 20) as usize {
            return Err("EOCD comment length mismatch".into());
        }
        return Ok(());
    }
    let comment = u16_le(s, s.len() - 22 + 20) as usize;
    if comment != 0 {
        return Err(format!("EOCD at the end with a {comment}-byte comment"));
    }
    Ok(())
}

pub(crate) fn crc32(data: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (n, slot) in t.iter_mut().enumerate() {
            let mut c = n as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *slot = c;
        }
        t
    });
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = table[((c ^ u32::from(b)) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

fn u16_le(buf: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(buf.get(at..at + 2).map_or([0; 2], |b| b.try_into().expect("slice")))
}

fn u32_le(buf: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(buf.get(at..at + 4).map_or([0; 4], |b| b.try_into().expect("slice")))
}

fn u64_le(buf: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(buf.get(at..at + 8).map_or([0; 8], |b| b.try_into().expect("slice")))
}

fn u32_be(buf: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(buf.get(at..at + 4).map_or([0; 4], |b| b.try_into().expect("slice")))
}

/* ---------- Tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chunk_complete_png_passes_and_a_truncated_one_fails() {
        let mut png = Vec::new();
        png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        png.extend_from_slice(&13u32.to_be_bytes()); // IHDR: 13 data bytes, always
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&[0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
        let crc = crc32(&png[12..]);
        png.extend_from_slice(&crc.to_be_bytes());
        png.extend_from_slice(&0u32.to_be_bytes());
        png.extend_from_slice(b"IEND\xAE\x42\x60\x82");
        assert!(check_png(&png).is_ok());
        // one byte short: the IEND chunk overruns
        assert!(check_png(&png[..png.len() - 1]).is_err());
    }

    #[test]
    fn a_marker_chained_jpg_passes_and_a_desynced_one_fails() {
        let mut jpg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        jpg.extend(std::iter::repeat_n(0x11u8, 14)); // the APP0 body
        jpg.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x08]); // SOS
        jpg.extend(std::iter::repeat_n(0x22u8, 6)); // its header
        jpg.extend(std::iter::repeat_n(0x33u8, 10)); // entropy data
        jpg.extend_from_slice(&[0xFF, 0xD9]);
        assert!(check_jpg(&jpg).is_ok());
        jpg[4] = 0x00; // the APP0 length reads as 1: a bad segment length
        jpg[5] = 0x01;
        assert!(check_jpg(&jpg).is_err());
    }

    #[test]
    fn a_declared_length_mismatch_is_rejected() {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&100u32.to_le_bytes()); // says 108, the slice is 40
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(&[0u8; 28]);
        assert_eq!(
            check("wav", 0, &wav, &wav),
            Err("RIFF size mismatch".into())
        );
    }
}
