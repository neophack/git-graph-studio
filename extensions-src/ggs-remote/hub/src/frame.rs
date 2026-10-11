//! The `ggs-remote/1` frame header (docs/ggs-remote-plan.md §6.1) — the Hub's own copy: the
//! Hub never looks inside a browser frame's payload, it only re-stamps the `session` field
//! between the browser and the tunnel. The tunnel's own frames (§20.4) carry MessagePack.
//! Held to the daemon's `tests/vectors/frames.json` like every other copy.

pub const HEADER_LEN: usize = 20;
pub const MAX_PAYLOAD: usize = 1 << 20;

pub mod ty {
    pub const HELLO: u8 = 0x01;
    pub const CLOSE: u8 = 0x7F;
    pub const NOTICE: u8 = 0x60;
    pub const T_HELLO: u8 = 0x80;
    pub const T_CHALLENGE: u8 = 0x81;
    pub const T_AUTH: u8 = 0x82;
    pub const T_READY: u8 = 0x83;
    pub const CONN_OPEN: u8 = 0x84;
    pub const CONN_CLOSE: u8 = 0x85;
    pub const HTTP_REQ: u8 = 0x86;
    pub const HTTP_RES: u8 = 0x87;
    pub const T_PING: u8 = 0x88;
    pub const T_REJECTED: u8 = 0x89;
    pub const T_REPLACED: u8 = 0x8A;
    pub const T_PONG: u8 = 0x8B;
}

pub mod flag {
    pub const COMPRESSED: u8 = 0x01;
    pub const FIN: u8 = 0x02;
    pub const ERROR: u8 = 0x10;
    pub const MORE: u8 = 0x20;
    pub const ENC_RAW: u8 = 0;
    pub const ENC_MSGPACK: u8 = 2 << 2;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub ty: u8,
    pub flags: u8,
    pub session: u32,
    pub stream: u32,
    pub seq: u32,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn raw(ty: u8, session: u32, payload: Vec<u8>) -> Frame {
        Frame {
            ty,
            flags: flag::ENC_RAW,
            session,
            stream: 0,
            seq: 0,
            payload,
        }
    }

    pub fn msgpack<T: serde::Serialize>(ty: u8, value: &T) -> Frame {
        Frame {
            ty,
            flags: flag::ENC_MSGPACK,
            session: 0,
            stream: 0,
            seq: 0,
            payload: rmp_serde::to_vec_named(value).expect("tunnel messages serialize"),
        }
    }

    pub fn with_session(mut self, session: u32) -> Frame {
        self.session = session;
        self
    }

    pub fn with_flags(mut self, extra: u8) -> Frame {
        self.flags |= extra;
        self
    }

    pub fn decode_msgpack<T: serde::de::DeserializeOwned>(&self) -> Option<T> {
        rmp_serde::from_slice(&self.payload).ok()
    }

    pub fn more(&self) -> bool {
        self.flags & flag::MORE != 0
    }

    pub fn fin(&self) -> bool {
        self.flags & flag::FIN != 0
    }

    pub fn has(&self, flag: u8) -> bool {
        self.flags & flag != 0
    }

    pub fn encode_into(&self, out: &mut Vec<u8>) {
        out.push(self.ty);
        out.push(self.flags);
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(&self.session.to_le_bytes());
        out.extend_from_slice(&self.stream.to_le_bytes());
        out.extend_from_slice(&self.seq.to_le_bytes());
        out.extend_from_slice(&(self.payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&self.payload);
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_LEN + self.payload.len());
        self.encode_into(&mut out);
        out
    }

    pub fn decode_all(buf: &[u8]) -> Option<Vec<Frame>> {
        let mut frames = Vec::new();
        let mut at = 0;
        while at < buf.len() {
            if buf.len() - at < HEADER_LEN || buf[at + 2] != 0 || buf[at + 3] != 0 {
                return None;
            }
            let u32_at = |i: usize| {
                u32::from_le_bytes([
                    buf[at + i],
                    buf[at + i + 1],
                    buf[at + i + 2],
                    buf[at + i + 3],
                ])
            };
            let len = u32_at(16) as usize;
            if len > MAX_PAYLOAD || buf.len() - at - HEADER_LEN < len {
                return None;
            }
            frames.push(Frame {
                ty: buf[at],
                flags: buf[at + 1],
                session: u32_at(4),
                stream: u32_at(8),
                seq: u32_at(12),
                payload: buf[at + HEADER_LEN..at + HEADER_LEN + len].to_vec(),
            });
            at += HEADER_LEN + len;
        }
        (!frames.is_empty()).then_some(frames)
    }
}

/// Re-stamp the `session` field of every frame in a message (in place, no re-encoding).
pub fn stamp_session(message: &mut [u8], session: u32) -> bool {
    let mut at = 0;
    while at < message.len() {
        if message.len() - at < HEADER_LEN {
            return false;
        }
        message[at + 4..at + 8].copy_from_slice(&session.to_le_bytes());
        let len = u32::from_le_bytes([
            message[at + 16],
            message[at + 17],
            message[at + 18],
            message[at + 19],
        ]) as usize;
        if len > MAX_PAYLOAD || message.len() - at - HEADER_LEN < len {
            return false;
        }
        at += HEADER_LEN + len;
    }
    true
}

/// The `session` of the first frame of a message.
pub fn session_of(message: &[u8]) -> Option<u32> {
    (message.len() >= HEADER_LEN)
        .then(|| u32::from_le_bytes([message[4], message[5], message[6], message[7]]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_every_frame_of_a_message() {
        let mut message = Vec::new();
        Frame::raw(0x10, 0, b"a".to_vec()).encode_into(&mut message);
        Frame::raw(0x10, 0, b"bc".to_vec()).encode_into(&mut message);
        assert!(stamp_session(&mut message, 77));
        let frames = Frame::decode_all(&message).unwrap();
        assert!(frames.iter().all(|f| f.session == 77));
        assert_eq!(session_of(&message), Some(77));
        let mut truncated = message[..30].to_vec();
        assert!(!stamp_session(&mut truncated, 1));
    }

    #[test]
    fn matches_the_shared_frame_vectors() {
        let raw = include_str!("../../daemon/tests/vectors/frames.json");
        let vectors: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
        for v in vectors {
            let hex = v["hex"].as_str().unwrap();
            let bytes: Vec<u8> = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect();
            let frames = Frame::decode_all(&bytes).unwrap();
            let expected = v["frames"].as_array().unwrap();
            assert_eq!(frames.len(), expected.len());
            for (frame, want) in frames.iter().zip(expected) {
                assert_eq!(frame.ty as u64, want["type"].as_u64().unwrap());
                assert_eq!(frame.session as u64, want["session"].as_u64().unwrap());
                assert_eq!(frame.stream as u64, want["stream"].as_u64().unwrap());
            }
            let mut again = Vec::new();
            for f in &frames {
                f.encode_into(&mut again);
            }
            assert_eq!(again, bytes);
        }
    }
}
