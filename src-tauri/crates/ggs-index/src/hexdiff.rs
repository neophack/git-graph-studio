//! The byte-level comparison behind the hex view (module 7's `hexCompare`): the differing
//! 16-byte rows of two byte strings, in order, capped. The bytes at two revisions are the
//! app adapter's to fetch (the git read); this module only compares.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HexRow {
    pub offset: u64,
    pub a: Vec<u8>,
    pub b: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HexDiff {
    pub identical: bool,
    pub size_a: u64,
    pub size_b: u64,
    /// The differing 16-byte rows, in order, capped.
    pub rows: Vec<HexRow>,
}

const HEX_ROW: usize = 16;
const MAX_HEX_ROWS: usize = 400;

/// The differing 16-byte rows of two byte strings, in order, capped.
pub fn hex_of(a: Vec<u8>, b: Vec<u8>) -> HexDiff {
    let identical = a == b;
    let mut rows = Vec::new();
    if !identical {
        for row in 0..a.len().div_ceil(HEX_ROW).max(b.len().div_ceil(HEX_ROW)) {
            if rows.len() >= MAX_HEX_ROWS {
                break;
            }
            let start = row * HEX_ROW;
            let sa = &a[start.min(a.len())..(start + HEX_ROW).min(a.len())];
            let sb = &b[start.min(b.len())..(start + HEX_ROW).min(b.len())];
            if sa != sb {
                rows.push(HexRow {
                    offset: start as u64,
                    a: sa.to_vec(),
                    b: sb.to_vec(),
                });
            }
        }
    }
    HexDiff {
        identical,
        size_a: a.len() as u64,
        size_b: b.len() as u64,
        rows,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_rows_mark_differing_bytes() {
        let a = vec![0u8; 40];
        let mut b = vec![0u8; 40];
        b[20] = 1;
        let diff = hex_of(a, b);
        assert!(!diff.identical);
        assert_eq!(diff.rows.len(), 1);
        assert_eq!(diff.rows[0].offset, 16);
        assert_eq!(diff.rows[0].b[4], 1);
        assert!(hex_of(vec![1, 2], vec![1, 2]).identical);
    }
}
