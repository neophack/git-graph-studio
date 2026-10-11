//! The session-resume ring (docs/ggs-remote-plan.md §6.5): the last 1 MB or 2000 downlink
//! frames of a browser connection, by sequence number. The browser acknowledges with
//! `ackSeq` (in PONG and CREDIT), which lets the ring drop what arrived; a reconnect with
//! `HELLO{resume:{sid,lastSeq}}` replays everything after `lastSeq` — or fails when frames it
//! needs were already evicted.

use std::collections::VecDeque;

pub const MAX_BYTES: usize = 1 << 20;
pub const MAX_FRAMES: usize = 2000;

#[derive(Default)]
pub struct ResumeBuffer {
    frames: VecDeque<(u32, Vec<u8>)>,
    bytes: usize,
    /// The highest sequence number evicted before it was acknowledged: a resume asking for
    /// anything at or below it cannot be served.
    lost_through: Option<u32>,
    acked: u32,
}

impl ResumeBuffer {
    pub fn push(&mut self, seq: u32, encoded: Vec<u8>) {
        self.bytes += encoded.len();
        self.frames.push_back((seq, encoded));
        while self.frames.len() > MAX_FRAMES || (self.bytes > MAX_BYTES && self.frames.len() > 1) {
            if let Some((old, bytes)) = self.frames.pop_front() {
                self.bytes -= bytes.len();
                if old > self.acked {
                    self.lost_through = Some(old);
                }
            }
        }
    }

    /// The browser has everything through `seq`.
    pub fn ack(&mut self, seq: u32) {
        if seq <= self.acked {
            return;
        }
        self.acked = seq;
        while self.frames.front().is_some_and(|(s, _)| *s <= seq) {
            if let Some((_, bytes)) = self.frames.pop_front() {
                self.bytes -= bytes.len();
            }
        }
    }

    pub fn acked(&self) -> u32 {
        self.acked
    }

    /// The frames after `last_seq`, or `None` when the ring no longer covers them.
    pub fn replay_after(&self, last_seq: u32) -> Option<Vec<Vec<u8>>> {
        if self.lost_through.is_some_and(|lost| lost > last_seq) {
            return None;
        }
        Some(
            self.frames
                .iter()
                .filter(|(seq, _)| *seq > last_seq)
                .map(|(_, bytes)| bytes.clone())
                .collect(),
        )
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replays_unacknowledged_frames() {
        let mut ring = ResumeBuffer::default();
        for seq in 1..=5 {
            ring.push(seq, vec![seq as u8; 10]);
        }
        ring.ack(2);
        assert_eq!(ring.bytes(), 30);
        let replay = ring.replay_after(3).unwrap();
        assert_eq!(replay, vec![vec![4u8; 10], vec![5u8; 10]]);
        assert_eq!(ring.replay_after(5).unwrap().len(), 0);
    }

    #[test]
    fn eviction_of_unacknowledged_frames_breaks_resume() {
        let mut ring = ResumeBuffer::default();
        for seq in 1..=(MAX_FRAMES as u32 + 10) {
            ring.push(seq, vec![0; 4]);
        }
        assert!(ring.replay_after(0).is_none());
        assert!(ring.replay_after(5).is_none());
        assert!(ring.replay_after(10).is_some());
    }

    #[test]
    fn byte_cap_evicts_oldest() {
        let mut ring = ResumeBuffer::default();
        ring.push(1, vec![0; MAX_BYTES / 2]);
        ring.ack(1);
        ring.push(2, vec![0; MAX_BYTES / 2 + 1]);
        ring.push(3, vec![0; MAX_BYTES / 2 + 1]);
        assert!(ring.bytes() <= MAX_BYTES);
        // Frame 2 was evicted unacknowledged: resuming from 1 is impossible, from 2 fine.
        assert!(ring.replay_after(1).is_none());
        assert_eq!(ring.replay_after(2).unwrap().len(), 1);
    }
}
