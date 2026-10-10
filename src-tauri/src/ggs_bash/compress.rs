//! DEFLATE and gzip, pure Rust (module 18): an inflater (fixed and dynamic Huffman —
//! `tar -xzf`, `gunzip` and `unzip` all read compressed streams through it) and a
//! gzip writer that emits STORED blocks — a valid gzip stream whose payload rides
//! uncompressed, exactly the format GNU tools accept, without carrying a compressor.

/* ---------- inflate ---------- */

pub fn inflate(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut reader = BitReader::new(data);
    let mut out = Vec::new();
    loop {
        let last = reader.bits(1)?;
        let kind = reader.bits(2)?;
        match kind {
            0 => {
                // A stored block: byte-aligned LEN/NLEN.
                reader.align();
                let len = reader.bytes(2)? as usize;
                let nlen = reader.bytes(2)? as usize;
                if len != (!nlen & 0xFFFF) {
                    return Err("corrupt stored block".into());
                }
                for _ in 0..len {
                    out.push(reader.bytes(1)? as u8);
                }
            }
            1 => {
                // Fixed Huffman.
                decompress_block(
                    &mut reader,
                    &fixed_literals()?,
                    &fixed_distances()?,
                    &mut out,
                )?;
            }
            2 => {
                // Dynamic Huffman: the code-length code, then the two trees.
                let literals = reader.bits(5)? + 257;
                let distances = reader.bits(5)? + 1;
                let codes = reader.bits(4)? + 4;
                const ORDER: [usize; 19] = [
                    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
                ];
                let mut lengths = [0usize; 19];
                for at in 0..codes as usize {
                    lengths[ORDER[at]] = reader.bits(3)? as usize;
                }
                let code_tree = build_tree(&lengths)?;
                let mut all: Vec<usize> = Vec::new();
                while all.len() < (literals + distances) as usize {
                    let symbol = decode_symbol(&mut reader, &code_tree)?;
                    match symbol {
                        0..=15 => all.push(symbol),
                        16 => {
                            let previous = *all.last().ok_or("no repeat base")?;
                            let repeat = 3 + reader.bits(2)? as usize;
                            for _ in 0..repeat {
                                all.push(previous);
                            }
                        }
                        17 => {
                            let repeat = 3 + reader.bits(3)? as usize;
                            all.extend(std::iter::repeat_n(0, repeat));
                        }
                        18 => {
                            let repeat = 11 + reader.bits(7)? as usize;
                            all.extend(std::iter::repeat_n(0, repeat));
                        }
                        _ => return Err("bad code length".into()),
                    }
                }
                let literal_lengths: Vec<usize> = all[..literals as usize].to_vec();
                let distance_lengths: Vec<usize> = all[literals as usize..].to_vec();
                let literal_tree = build_tree(&literal_lengths)?;
                let distance_tree = build_tree(&distance_lengths)?;
                decompress_block(&mut reader, &literal_tree, &distance_tree, &mut out)?;
            }
            _ => return Err("reserved block type".into()),
        }
        if last == 1 {
            break;
        }
    }
    Ok(out)
}

/// The length/distance payload of one Huffman block.
fn decompress_block(
    reader: &mut BitReader,
    literals: &Node,
    distances: &Node,
    out: &mut Vec<u8>,
) -> Result<(), String> {
    const LENGTH_BASE: [u16; 29] = [
        3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
        131, 163, 195, 227, 258,
    ];
    const LENGTH_EXTRA: [u16; 29] = [
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
    ];
    const DISTANCE_BASE: [u16; 30] = [
        1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
        2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
    ];
    const DISTANCE_EXTRA: [u16; 30] = [
        0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
        13, 13,
    ];
    loop {
        let symbol = decode_symbol(reader, literals)?;
        match symbol {
            0..=255 => out.push(symbol as u8),
            256 => return Ok(()),
            257..=285 => {
                let at = symbol - 257;
                let length =
                    LENGTH_BASE[at] as usize + reader.bits(LENGTH_EXTRA[at] as u8)? as usize;
                let distance_symbol = decode_symbol(reader, distances)?;
                if distance_symbol > 29 {
                    return Err("bad distance symbol".into());
                }
                let distance = DISTANCE_BASE[distance_symbol] as usize
                    + reader.bits(DISTANCE_EXTRA[distance_symbol] as u8)? as usize;
                if distance > out.len() {
                    return Err("distance reaches before the stream".into());
                }
                let start = out.len() - distance;
                for offset in 0..length {
                    let byte = out[start + offset];
                    out.push(byte);
                }
            }
            _ => return Err("bad literal symbol".into()),
        }
    }
}

fn fixed_literals() -> Result<Node, String> {
    let mut lengths = vec![8usize; 144];
    lengths.extend(std::iter::repeat_n(9, 112));
    lengths.extend(std::iter::repeat_n(7, 24));
    lengths.extend(std::iter::repeat_n(8, 8));
    build_tree(&lengths)
}

/// The fixed-Huffman distance tree: thirty five-bit codes for symbols 0..29. (A
/// single-leaf tree here would decode every distance as 1 and never consume a bit —
/// fixed blocks with back-references, i.e. most gzipped data, would never end.)
fn fixed_distances() -> Result<Node, String> {
    build_tree(&vec![5usize; 30])
}

/* ---------- the Huffman plumbing ---------- */

pub struct Node {
    pub symbol: usize,
    pub left: Option<Box<Node>>,
    pub right: Option<Box<Node>>,
}

struct BitReader<'a> {
    data: &'a [u8],
    at: usize,
    bit: u32,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> BitReader<'a> {
        BitReader {
            data,
            at: 0,
            bit: 0,
        }
    }
    fn bits(&mut self, count: u8) -> Result<u32, String> {
        let mut value = 0u32;
        for index in 0..count {
            let byte = *self.data.get(self.at).ok_or("stream ended early")?;
            let bit = (byte >> self.bit) & 1;
            value |= (bit as u32) << index;
            self.bit += 1;
            if self.bit == 8 {
                self.bit = 0;
                self.at += 1;
            }
        }
        Ok(value)
    }
    fn bytes(&mut self, count: usize) -> Result<u64, String> {
        let mut value = 0u64;
        for index in 0..count {
            let byte = *self.data.get(self.at).ok_or("stream ended early")?;
            value |= (byte as u64) << (8 * index);
            self.at += 1;
        }
        self.bit = 0;
        Ok(value)
    }
    fn align(&mut self) {
        if self.bit != 0 {
            self.bit = 0;
            self.at += 1;
        }
    }
}

fn build_tree(lengths: &[usize]) -> Result<Node, String> {
    // Canonical Huffman (RFC 1951 §3.2.2): count by length, assign codes per length.
    let mut counts = [0usize; 16];
    for &len in lengths {
        if len > 15 {
            return Err("code length too long".into());
        }
        if len > 0 {
            counts[len] += 1;
        }
    }
    let mut next_code = [0u16; 16];
    let mut code = 0u16;
    for bits in 1..=15usize {
        code = (code + counts[bits - 1] as u16) << 1;
        next_code[bits] = code;
    }
    let mut codes: Vec<(usize, u16, usize)> = Vec::new(); // (len, code, symbol)
    for (symbol, &len) in lengths.iter().enumerate() {
        if len == 0 {
            continue;
        }
        codes.push((len, next_code[len], symbol));
        next_code[len] += 1;
    }
    let mut root = Node {
        symbol: usize::MAX,
        left: None,
        right: None,
    };
    for (len, code, symbol) in codes {
        let mut node = &mut root;
        for at in (0..len).rev() {
            let bit = (code >> at) & 1;
            let slot = if bit == 0 {
                &mut node.left
            } else {
                &mut node.right
            };
            if slot.is_none() {
                *slot = Some(Box::new(Node {
                    symbol: usize::MAX,
                    left: None,
                    right: None,
                }));
            }
            node = slot.as_mut().expect("just created");
        }
        node.symbol = symbol;
    }
    Ok(root)
}

fn decode_symbol(reader: &mut BitReader, tree: &Node) -> Result<usize, String> {
    let mut node = tree;
    loop {
        let bit = reader.bits(1)?;
        let next = if bit == 0 { &node.left } else { &node.right };
        match next {
            None => return Err("broken Huffman path".into()),
            Some(child) => {
                if child.symbol != usize::MAX {
                    return Ok(child.symbol);
                }
                node = child;
            }
        }
    }
}

/* ---------- gzip ---------- */

/// Wrap DEFLATE data in the gzip container (RFC 1952): header, the raw deflate
/// stream, CRC-32 and the size. `raw_deflate` must already be a deflate stream —
/// the writer below produces the stored-block form.
pub fn gzip_wrap(deflate: &[u8], payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(deflate.len() + 18);
    out.extend_from_slice(&[0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]);
    out.extend_from_slice(deflate);
    out.extend_from_slice(&crc32(payload).to_le_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out
}

/// A deflate stream of STORED blocks: no compression, fully valid.
pub fn stored_deflate(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    if payload.is_empty() {
        out.push(0x01);
        out.extend_from_slice(&[0x00, 0x00, 0xff, 0xff]);
        return out;
    }
    let mut chunks = payload.chunks(65_535).peekable();
    while let Some(chunk) = chunks.next() {
        let last = chunks.peek().is_none();
        out.push(if last { 0x01 } else { 0x00 });
        out.extend_from_slice(&(chunk.len() as u16).to_le_bytes());
        out.extend_from_slice(&(!(chunk.len() as u16)).to_le_bytes());
        out.extend_from_slice(chunk);
    }
    out
}

/// Strip the gzip container; answers the payload.
pub fn gunzip(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 18 || data[0] != 0x1f || data[1] != 0x8b {
        return Err("not a gzip stream".into());
    }
    if data[2] != 0x08 {
        return Err("unsupported gzip compression".into());
    }
    let flags = data[3];
    let mut at = 10;
    if flags & 0x04 != 0 {
        let extra = u16::from_le_bytes([
            data.get(at).copied().unwrap_or(0),
            data.get(at + 1).copied().unwrap_or(0),
        ]) as usize;
        at += 2 + extra;
    }
    for name_or_comment in [0x08, 0x10] {
        if flags & name_or_comment != 0 {
            while at < data.len() && data[at] != 0 {
                at += 1;
            }
            at += 1;
        }
    }
    if flags & 0x02 != 0 {
        at += 2;
    }
    let deflate_end = data.len() - 8;
    if at > deflate_end {
        return Err("truncated gzip stream".into());
    }
    inflate(&data[at..deflate_end])
}

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (n, slot) in table.iter_mut().enumerate() {
        let mut c = n as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
        *slot = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc = table[((crc ^ *byte as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_deflate_round_trips_through_inflate() {
        let payload = b"hello hello hello deflate world".repeat(10);
        let wrapped = gzip_wrap(&stored_deflate(&payload), &payload);
        let back = gunzip(&wrapped).unwrap();
        assert_eq!(back, payload);
        // Empty and exact-boundary sizes too.
        for size in [0usize, 1, 65_535, 65_536, 70_000] {
            let payload = vec![b'x'; size];
            let wrapped = gzip_wrap(&stored_deflate(&payload), &payload);
            assert_eq!(gunzip(&wrapped).unwrap(), payload, "size {size}");
        }
    }

    #[test]
    fn crc32_matches_the_reference_vector() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn inflate_reads_fixed_huffman_blocks() {
        // One hand-assembled fixed-Huffman block: BFINAL=1, BTYPE=01, the literal
        // 'A' (code 0x71, 8 bits, MSB-first), then end-of-block (seven zero bits).
        let stream = [0x73u8, 0x04, 0x00];
        assert_eq!(inflate(&stream).unwrap(), b"A");
    }

    #[test]
    fn inflate_reads_fixed_huffman_back_references() {
        // zlib's own fixed-Huffman output (level 9, short input — BTYPE=01) for a text
        // full of repeats: every `abc` and `hello` after the first is a back-reference,
        // so each one decodes a five-bit fixed distance code. The single-leaf distance
        // tree this replaced decoded every distance as 1 and consumed no bits.
        let stream = [
            75u8, 76, 74, 78, 68, 69, 10, 25, 169, 57, 57, 249, 200, 36, 23, 0,
        ];
        assert_eq!(
            inflate(&stream).unwrap(),
            b"abcabcabcabcabcabc hello hello hello\n"
        );
    }
}
