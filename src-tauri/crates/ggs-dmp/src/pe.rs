//! Module reconstruction (module 21): a loaded module's image lives in the dump at its
//! base address in *loaded* layout — every section starts at its VirtualAddress, the
//! header fields the loader patched are patched — which no tool reads as a file. The
//! rebuild maps each section's memory bytes back to its `PointerToRawData` file slot,
//! producing the disk-layout PE the dump was made from: openable in a disassembler, diff-
//! able against the copy on disk. Pages the dumper skipped land as zeros, honestly.

use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;

use crate::{Dump, ModuleInfo, Region};

/// Copies `len` bytes of the process's memory at `va` out of the dump, zero-filling the
/// pages the dumper skipped. Runs chunked, each chunk re-resolving its VA through the
/// region map (a section can span several regions and holes).
fn read_memory(dump: &mut Dump, regions: &[Region], va: u64, len: usize) -> Vec<u8> {
    let mut out = vec![0u8; len];
    let mut done = 0usize;
    while done < len {
        let cur = va + done as u64;
        match dump.file_offset_for(regions, cur) {
            Some(off) => {
                // Contiguous run: until this region ends (or the read does).
                let region = regions
                    .iter()
                    .find(|r| cur >= r.va && cur - r.va < r.size)
                    .expect("the map resolved it, so a region contains it");
                let region_left = (region.va + region.size - cur) as usize;
                let want = (len - done).min(region_left);
                use std::io::{Read, Seek, SeekFrom};
                let file = dump.file();
                if file.seek(SeekFrom::Start(off)).is_err() {
                    break;
                }
                let mut buf = vec![0u8; want];
                let mut filled = 0;
                while filled < want {
                    match file.read(&mut buf[filled..]) {
                        Ok(0) => break,
                        Ok(n) => filled += n,
                        Err(_) => break,
                    }
                }
                out[done..done + filled].copy_from_slice(&buf[..filled]);
                done += filled.max(1); // a short read still makes progress past a bad page
            }
            None => {
                // The hole: jump to the next region that starts after this address.
                let next = regions
                    .iter()
                    .map(|r| r.va)
                    .filter(|start| *start > cur)
                    .min()
                    .unwrap_or(va + len as u64);
                if next <= cur {
                    break;
                }
                done = usize::try_from(next - va).unwrap_or(len);
            }
        }
    }
    out
}

/// Rebuilds one module's disk-layout PE from its dumped memory. Returns the file size.
pub fn extract_module(
    dump: &mut Dump,
    regions: &[Region],
    module: &ModuleInfo,
    out: &Path,
) -> Result<u64, String> {
    let headers = read_memory(dump, regions, module.base, 4 * 1024);
    if headers.len() < 0x100 || &headers[0..2] != b"MZ" {
        return Err("the module's base page is not in the dump (MZ missing)".to_string());
    }
    let lfanew = u32::from_le_bytes(headers[0x3C..0x40].try_into().expect("slice")) as usize;
    if lfanew < 0x40 || lfanew + 248 > headers.len() || &headers[lfanew..lfanew + 4] != b"PE\x00\x00" {
        return Err("the module's PE header is not in the dump".to_string());
    }
    let num_sections = usize::from(u16::from_le_bytes(
        headers[lfanew + 6..lfanew + 8].try_into().expect("slice"),
    ));
    let opt_size = usize::from(u16::from_le_bytes(
        headers[lfanew + 20..lfanew + 22].try_into().expect("slice"),
    ));
    if num_sections == 0 || num_sections > 96 {
        return Err(format!("an implausible section count ({num_sections})"));
    }
    // Both optional-header magics keep SizeOfImage at +56 and SizeOfHeaders at +60 from
    // the optional header's own start.
    let opt = lfanew + 24;
    let size_of_image = u32::from_le_bytes(headers[opt + 56..opt + 60].try_into().expect("slice"));
    let size_of_headers = u64::from(u32::from_le_bytes(
        headers[opt + 60..opt + 64].try_into().expect("slice"),
    ));
    let sections_at = opt + opt_size;
    if sections_at + num_sections * 40 > headers.len() {
        return Err("the section table runs past the dumped header page".to_string());
    }

    // The output's extent: headers plus the section with the farthest raw tail.
    let mut file_len = size_of_headers;
    let mut sections: Vec<(u64, u64, u64, u64)> = Vec::with_capacity(num_sections); // vaddr, vsize, rawptr, rawsize
    for i in 0..num_sections {
        let at = sections_at + i * 40;
        let vsize = u64::from(u32::from_le_bytes(headers[at + 8..at + 12].try_into().expect("slice")));
        let vaddr = u64::from(u32::from_le_bytes(headers[at + 12..at + 16].try_into().expect("slice")));
        let rawsize = u64::from(u32::from_le_bytes(headers[at + 16..at + 20].try_into().expect("slice")));
        let rawptr = u64::from(u32::from_le_bytes(headers[at + 20..at + 24].try_into().expect("slice")));
        if rawsize == 0 {
            continue; // BSS-like: nothing on disk, nothing in memory worth mapping
        }
        if rawptr
            .checked_add(rawsize)
            .is_none_or(|end| end > u64::from(size_of_image).max(file_len) + (64 << 20))
        {
            return Err(format!("section {i} points past any sane file size"));
        }
        file_len = file_len.max(rawptr + rawsize);
        sections.push((vaddr, vsize, rawptr, rawsize));
    }
    if file_len == 0 {
        return Err("the module declares no sections".to_string());
    }

    let mut file = File::create(out).map_err(|e| format!("{}: {}", out.display(), e))?;
    file.set_len(file_len).map_err(|e| e.to_string())?;
    let head_len = size_of_headers.min(headers.len() as u64) as usize;
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    file.write_all(&headers[..head_len]).map_err(|e| e.to_string())?;
    for (vaddr, vsize, rawptr, rawsize) in &sections {
        let (vaddr, vsize, rawptr, rawsize) = (*vaddr, *vsize, *rawptr, *rawsize);
        let copy = rawsize.min(if vsize == 0 { rawsize } else { vsize.max(rawsize) });
        let mem = read_memory(dump, regions, module.base + vaddr, copy as usize);
        file.seek(SeekFrom::Start(rawptr)).map_err(|e| e.to_string())?;
        file.write_all(&mem).map_err(|e| e.to_string())?;
    }
    Ok(file_len)
}

/* ---------- Tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    /// The smallest credible PE64: one section whose memory copy must land at its
    /// PointerToRawData, headers patched the way the loader leaves them.
    fn tiny_pe() -> Vec<u8> {
        let mut v = vec![0u8; 512];
        v[0..2].copy_from_slice(b"MZ");
        let lfanew = 0x80usize;
        v[0x3C..0x40].copy_from_slice(&(lfanew as u32).to_le_bytes());
        v[lfanew..lfanew + 4].copy_from_slice(b"PE\x00\x00");
        v[lfanew + 6..lfanew + 8].copy_from_slice(&1u16.to_le_bytes()); // one section
        let opt = lfanew + 24;
        v[opt..opt + 2].copy_from_slice(&0x20Bu16.to_le_bytes()); // PE32+
        v[opt + 56..opt + 60].copy_from_slice(&0x2000u32.to_le_bytes()); // SizeOfImage
        v[opt + 60..opt + 64].copy_from_slice(&512u32.to_le_bytes()); // SizeOfHeaders
        v[lfanew + 20..lfanew + 22].copy_from_slice(&240u16.to_le_bytes()); // opt size
        let sect = opt + 240;
        v[sect..sect + 8].copy_from_slice(b".text\0\0\0");
        v[sect + 8..sect + 12].copy_from_slice(&0x200u32.to_le_bytes()); // VirtualSize
        v[sect + 12..sect + 16].copy_from_slice(&0x1000u32.to_le_bytes()); // VirtualAddress
        v[sect + 16..sect + 20].copy_from_slice(&0x200u32.to_le_bytes()); // SizeOfRawData
        v[sect + 20..sect + 24].copy_from_slice(&512u32.to_le_bytes()); // PointerToRawData
        v
    }

    #[test]
    fn a_loaded_module_rebuilds_into_a_disk_layout_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pe = tiny_pe();
        // The module's image spans two dump regions with a hole between the header page
        // and the section's memory (the section sits at VirtualAddress 0x1000) — the
        // rebuild must read both through the region map and zero the rest.
        let mut payload = Vec::new();
        payload.extend_from_slice(&pe);
        payload.extend_from_slice(&[0x77u8; 0x100]); // the section's loaded bytes
        let f = crate::fixture::write(
            &dir,
            &[(0x40_0000, 0x2000, r"C:\bin\demo.dll")],
            &[(0x40_0000, pe.len() as u64), (0x401_000, 0x100)],
            &|buf| buf.extend_from_slice(&payload),
        );
        let mut dump = Dump::open(&f.path).expect("open");
        let regions = dump.regions().expect("regions");
        let module = crate::ModuleInfo {
            base: 0x40_0000,
            size: 0x2000,
            timestamp: 0,
            name: r"C:\bin\demo.dll".to_string(),
            file_name: "demo.dll".to_string(),
        };
        let out = dir.path().join("rebuilt.dll");
        let len = extract_module(&mut dump, &regions, &module, &out).expect("rebuild");
        assert_eq!(len, 512 + 0x200);
        let bytes = std::fs::read(&out).expect("read");
        assert_eq!(&bytes[0..2], b"MZ");
        // The section's memory bytes landed at their PointerToRawData slot: what the
        // dump carried first, then the hole's zeros.
        assert_eq!(&bytes[512..518], &[0x77u8; 6]);
        assert_eq!(&bytes[768..772], &[0u8; 4]);
        // The header page copied through from the dump's memory.
        assert_eq!(bytes[0x3C..0x40], (0x80u32).to_le_bytes());
    }

    #[test]
    fn a_module_whose_base_page_is_missing_is_an_honest_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let f = crate::fixture::write(
            &dir,
            &[],
            &[(0x40_0000, 64)],
            &|buf| buf.extend_from_slice(&[0u8; 64]), // no MZ here
        );
        let mut dump = Dump::open(&f.path).expect("open");
        let regions = dump.regions().expect("regions");
        let module = crate::ModuleInfo {
            base: 0x40_0000,
            size: 0x1000,
            timestamp: 0,
            name: String::new(),
            file_name: "ghost.dll".to_string(),
        };
        let err = extract_module(&mut dump, &regions, &module, &dir.path().join("x.dll"))
            .expect_err("rejected");
        assert!(err.contains("MZ"), "{err}");
    }
}
