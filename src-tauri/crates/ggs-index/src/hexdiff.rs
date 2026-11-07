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
    /// The differing 16-byte rows, in order, capped at `MAX_HEX_ROWS`.
    pub rows: Vec<HexRow>,
    /// More differing rows existed than `rows` holds: the cap stopped the collection, so
    /// the consumer cannot mistake a truncated diff for the whole difference.
    pub truncated: bool,
}

const HEX_ROW: usize = 16;
const MAX_HEX_ROWS: usize = 400;

/// The differing 16-byte rows of two byte strings, in order, capped — with `truncated`
/// saying when the cap stopped the collection.
pub fn hex_of(a: Vec<u8>, b: Vec<u8>) -> HexDiff {
    let identical = a == b;
    let mut rows = Vec::new();
    let mut truncated = false;
    if !identical {
        for row in 0..a.len().div_ceil(HEX_ROW).max(b.len().div_ceil(HEX_ROW)) {
            let start = row * HEX_ROW;
            let sa = &a[start.min(a.len())..(start + HEX_ROW).min(a.len())];
            let sb = &b[start.min(b.len())..(start + HEX_ROW).min(b.len())];
            if sa == sb {
                continue;
            }
            if rows.len() >= MAX_HEX_ROWS {
                truncated = true;
                break;
            }
            rows.push(HexRow {
                offset: start as u64,
                a: sa.to_vec(),
                b: sb.to_vec(),
            });
        }
    }
    HexDiff {
        identical,
        size_a: a.len() as u64,
        size_b: b.len() as u64,
        rows,
        truncated,
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
        assert!(!diff.truncated);
        assert_eq!(diff.rows.len(), 1);
        assert_eq!(diff.rows[0].offset, 16);
        assert_eq!(diff.rows[0].b[4], 1);
        assert!(hex_of(vec![1, 2], vec![1, 2]).identical);
    }

    #[test]
    fn past_the_row_cap_the_diff_says_truncated() {
        // MAX_HEX_ROWS + 4 differing rows: the cap collects MAX and says the rest exists.
        let a = vec![0u8; (MAX_HEX_ROWS + 8) * HEX_ROW];
        let mut b = a.clone();
        for row in 0..MAX_HEX_ROWS + 4 {
            b[row * HEX_ROW] = 1;
        }
        let diff = hex_of(a, b);
        assert!(diff.truncated);
        assert_eq!(diff.rows.len(), MAX_HEX_ROWS);
        assert_eq!(
            diff.rows[MAX_HEX_ROWS - 1].offset,
            ((MAX_HEX_ROWS - 1) * 16) as u64
        );

        // Exactly at the cap nothing is dropped, so nothing is truncated either.
        let a = vec![0u8; (MAX_HEX_ROWS + 2) * HEX_ROW];
        let mut b = a.clone();
        for row in 0..MAX_HEX_ROWS {
            b[row * HEX_ROW] = 1;
        }
        let diff = hex_of(a, b);
        assert!(!diff.truncated);
        assert_eq!(diff.rows.len(), MAX_HEX_ROWS);
    }
}
