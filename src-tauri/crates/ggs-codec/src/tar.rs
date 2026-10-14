//! USTAR/GNU tar reading and writing, pure std (from GGS Bash's archive tools — the
//! same bytes Git Bash's `tar` reads and writes).

pub fn tar_create(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
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

pub fn tar_parse(data: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
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

