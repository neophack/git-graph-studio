//! The `ggs-remote/1` frame (docs/ggs-remote-plan.md §6.1): a 20-byte little-endian header
//! plus a payload, one or more frames per WebSocket binary message. Every link speaks it —
//! browser ↔ daemon, daemon ↔ Relay, daemon ↔ Hub — and `src/remote/frame.ts` is the
//! browser's copy, held to the same test vectors (`tests/vectors/frames.json`).
//!
//! The daemon routes on the header alone: an INVOKE's payload is never parsed here, which is
//! what keeps the daemon's memory and CPU independent of the workload.

use std::collections::HashMap;
use std::io::{Read, Write};

pub const HEADER_LEN: usize = 20;
/// The largest payload one frame carries; bigger messages are split into `MORE` fragments.
pub const MAX_PAYLOAD: usize = 1 << 20;
/// The largest message a reassembled fragment chain may grow to (§16 input validation).
pub const MAX_MESSAGE: usize = 256 << 20;
/// Payloads below this size are never compressed (§6.1).
pub const COMPRESS_THRESHOLD: usize = 1024;

/// Re-stamp the `session` field of every frame in an encoded message (in place): the Hub
/// tunnel link uses it between the browser side (session 0) and its own per-connection
/// numbers (docs/ggs-remote-plan.md §20.4).
pub fn stamp_session(message: &mut [u8], session: u32) -> bool {
    let mut at = 0;
    while at < message.len() {
        if message.len() - at < HEADER_LEN || message[at + 2] != 0 || message[at + 3] != 0 {
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

/// Frame types (§6.2). Types only ever get added; a receiver ignores the ones it does not know.
pub mod ty {
    pub const HELLO: u8 = 0x01;
    pub const HELLO_ACK: u8 = 0x02;
    pub const WINDOWS: u8 = 0x03;
    pub const ATTACH: u8 = 0x04;
    pub const ATTACHED: u8 = 0x05;
    pub const DETACH: u8 = 0x06;
    pub const SPAWN: u8 = 0x07;
    pub const SESSION_END: u8 = 0x08;
    pub const SPAWNED: u8 = 0x09;
    pub const INSTANCE_CLOSE: u8 = 0x0A;
    pub const INSTANCE_RESTART: u8 = 0x0B;
    pub const INVOKE: u8 = 0x10;
    pub const RESULT: u8 = 0x11;
    pub const CANCEL: u8 = 0x12;
    pub const CHAN_DATA: u8 = 0x20;
    pub const CHAN_CLOSE: u8 = 0x21;
    pub const LISTEN: u8 = 0x30;
    pub const UNLISTEN: u8 = 0x31;
    pub const EVENT: u8 = 0x32;
    pub const EMIT: u8 = 0x33;
    pub const FETCH: u8 = 0x40;
    pub const FETCH_DATA: u8 = 0x41;
    pub const UPLOAD: u8 = 0x42;
    pub const UPLOAD_ACK: u8 = 0x43;
    pub const CREDIT: u8 = 0x50;
    pub const PING: u8 = 0x51;
    pub const PONG: u8 = 0x52;
    pub const NOTICE: u8 = 0x60;
    pub const CLOSE: u8 = 0x7F;
    // The Hub tunnel's own frames (§20.4).
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

/// Flag bits (§6.1).
pub mod flag {
    pub const COMPRESSED: u8 = 0x01;
    pub const FIN: u8 = 0x02;
    pub const ENC_MASK: u8 = 0x0C;
    pub const ERROR: u8 = 0x10;
    pub const MORE: u8 = 0x20;
}

/// The payload encoding, flag bits 2..3.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Enc {
    Raw = 0,
    Json = 1,
    Msgpack = 2,
}

impl Enc {
    fn from_bits(bits: u8) -> Enc {
        match (bits & flag::ENC_MASK) >> 2 {
            1 => Enc::Json,
            2 => Enc::Msgpack,
            _ => Enc::Raw,
        }
    }
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

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    Short,
    TooLarge(usize),
    Reserved,
    BadCompression,
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Short => f.write_str("truncated frame"),
            FrameError::TooLarge(n) => write!(f, "frame payload too large ({n} bytes)"),
            FrameError::Reserved => f.write_str("reserved header bytes are not zero"),
            FrameError::BadCompression => f.write_str("payload does not inflate"),
        }
    }
}

impl std::error::Error for FrameError {}

impl Frame {
    pub fn new(ty: u8, enc: Enc, payload: Vec<u8>) -> Frame {
        Frame {
            ty,
            flags: (enc as u8) << 2,
            session: 0,
            stream: 0,
            seq: 0,
            payload,
        }
    }

    /// A frame with no payload (DETACH, CANCEL, PING, …).
    pub fn empty(ty: u8) -> Frame {
        Frame::new(ty, Enc::Raw, Vec::new())
    }

    /// A MessagePack control frame; field names ride along (`to_vec_named`), so the browser's
    /// decoder reads a plain object.
    pub fn msgpack<T: serde::Serialize>(ty: u8, value: &T) -> Frame {
        let payload = rmp_serde::to_vec_named(value).expect("control messages always serialize");
        Frame::new(ty, Enc::Msgpack, payload)
    }

    pub fn json(ty: u8, value: &serde_json::Value) -> Frame {
        Frame::new(ty, Enc::Json, serde_json::to_vec(value).unwrap_or_default())
    }

    pub fn with_stream(mut self, stream: u32) -> Frame {
        self.stream = stream;
        self
    }

    pub fn with_session(mut self, session: u32) -> Frame {
        self.session = session;
        self
    }

    pub fn enc(&self) -> Enc {
        Enc::from_bits(self.flags)
    }

    pub fn has(&self, bit: u8) -> bool {
        self.flags & bit != 0
    }

    /// Decode a MessagePack payload (the payload must already be inflated).
    pub fn decode_msgpack<T: serde::de::DeserializeOwned>(&self) -> Option<T> {
        rmp_serde::from_slice(&self.payload).ok()
    }

    pub fn encode_into(&self, out: &mut Vec<u8>) {
        out.reserve(HEADER_LEN + self.payload.len());
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

    /// Decode one frame from the front of `buf`; answers the frame and the bytes it used.
    pub fn decode_one(buf: &[u8]) -> Result<(Frame, usize), FrameError> {
        if buf.len() < HEADER_LEN {
            return Err(FrameError::Short);
        }
        if buf[2] != 0 || buf[3] != 0 {
            return Err(FrameError::Reserved);
        }
        let u32_at =
            |at: usize| u32::from_le_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]);
        let len = u32_at(16) as usize;
        if len > MAX_PAYLOAD {
            return Err(FrameError::TooLarge(len));
        }
        if buf.len() < HEADER_LEN + len {
            return Err(FrameError::Short);
        }
        let frame = Frame {
            ty: buf[0],
            flags: buf[1],
            session: u32_at(4),
            stream: u32_at(8),
            seq: u32_at(12),
            payload: buf[HEADER_LEN..HEADER_LEN + len].to_vec(),
        };
        Ok((frame, HEADER_LEN + len))
    }

    /// Decode a whole WebSocket message: one frame, or several packed back to back (§6.1's
    /// "one message, many frames" — the uplink's 16 ms keystroke batching).
    pub fn decode_all(buf: &[u8]) -> Result<Vec<Frame>, FrameError> {
        let mut frames = Vec::new();
        let mut at = 0;
        while at < buf.len() {
            let (frame, used) = Frame::decode_one(&buf[at..])?;
            frames.push(frame);
            at += used;
        }
        if frames.is_empty() {
            return Err(FrameError::Short);
        }
        Ok(frames)
    }

    /// Compress the payload in place when it is worth it (§6.1): above the threshold and of a
    /// compressible encoding. Raw payloads are left alone unless `text` says they are text.
    pub fn compress(&mut self, text: bool) {
        if self.has(flag::COMPRESSED) || self.payload.len() <= COMPRESS_THRESHOLD {
            return;
        }
        if self.enc() == Enc::Raw && !text {
            return;
        }
        let deflated = deflate_raw(&self.payload);
        if deflated.len() < self.payload.len() {
            self.payload = deflated;
            self.flags |= flag::COMPRESSED;
        }
    }

    /// Inflate a compressed payload in place.
    pub fn decompress(&mut self) -> Result<(), FrameError> {
        if !self.has(flag::COMPRESSED) {
            return Ok(());
        }
        self.payload = inflate_raw(&self.payload, MAX_MESSAGE)?;
        self.flags &= !flag::COMPRESSED;
        Ok(())
    }

    /// Split into `MORE` fragments of at most `max` payload bytes (§6.1). A frame within the
    /// limit is returned as is.
    pub fn split(self, max: usize) -> Vec<Frame> {
        if self.payload.len() <= max {
            return vec![self];
        }
        let chunks: Vec<&[u8]> = self.payload.chunks(max).collect();
        let last = chunks.len() - 1;
        chunks
            .iter()
            .enumerate()
            .map(|(i, chunk)| Frame {
                ty: self.ty,
                flags: if i < last {
                    self.flags | flag::MORE
                } else {
                    self.flags & !flag::MORE
                },
                session: self.session,
                stream: self.stream,
                seq: self.seq,
                payload: chunk.to_vec(),
            })
            .collect()
    }
}

/// deflate-raw, the format the browser's `CompressionStream('deflate-raw')` speaks.
pub fn deflate_raw(data: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
    let _ = encoder.write_all(data);
    encoder.finish().unwrap_or_default()
}

pub fn inflate_raw(data: &[u8], limit: usize) -> Result<Vec<u8>, FrameError> {
    let decoder = flate2::read::DeflateDecoder::new(data);
    let mut out = Vec::new();
    decoder
        .take(limit as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|_| FrameError::BadCompression)?;
    if out.len() > limit {
        return Err(FrameError::TooLarge(out.len()));
    }
    Ok(out)
}

/// Joins `MORE` fragment chains back into whole frames, keyed by `(session, stream, type)`.
#[derive(Default)]
pub struct Reassembler {
    partial: HashMap<(u32, u32, u8), Frame>,
    buffered: usize,
}

impl Reassembler {
    /// Feed one frame; answers the whole frame once its chain is complete.
    pub fn push(&mut self, frame: Frame) -> Result<Option<Frame>, FrameError> {
        let key = (frame.session, frame.stream, frame.ty);
        let more = frame.has(flag::MORE);
        match self.partial.remove(&key) {
            None if !more => Ok(Some(frame)),
            None => {
                self.buffered += frame.payload.len();
                self.check()?;
                self.partial.insert(key, frame);
                Ok(None)
            }
            Some(mut head) => {
                self.buffered += frame.payload.len();
                self.check()?;
                head.payload.extend_from_slice(&frame.payload);
                if more {
                    self.partial.insert(key, head);
                    Ok(None)
                } else {
                    self.buffered -= head.payload.len().min(self.buffered);
                    head.flags &= !flag::MORE;
                    Ok(Some(head))
                }
            }
        }
    }

    /// Drop every partial chain of one session (it ended).
    pub fn drop_session(&mut self, session: u32) {
        self.partial.retain(|key, _| key.0 != session);
        self.buffered = self.partial.values().map(|f| f.payload.len()).sum();
    }

    fn check(&self) -> Result<(), FrameError> {
        if self.buffered > MAX_MESSAGE {
            return Err(FrameError::TooLarge(self.buffered));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_round_trips() {
        let frame = Frame {
            ty: ty::INVOKE,
            flags: (Enc::Json as u8) << 2,
            session: 7,
            stream: 3,
            seq: 42,
            payload: br#"{"c":"list_dir","a":{"path":"/"}}"#.to_vec(),
        };
        let bytes = frame.encode();
        assert_eq!(bytes.len(), HEADER_LEN + frame.payload.len());
        assert_eq!(&bytes[..4], &[0x10, 0x04, 0, 0]);
        let (back, used) = Frame::decode_one(&bytes).unwrap();
        assert_eq!(used, bytes.len());
        assert_eq!(back, frame);
        assert_eq!(back.enc(), Enc::Json);
    }

    #[test]
    fn several_frames_share_one_message() {
        let mut message = Vec::new();
        for i in 0..3u32 {
            Frame::new(ty::INVOKE, Enc::Json, vec![b'x'; i as usize])
                .with_stream(i * 2 + 1)
                .encode_into(&mut message);
        }
        let frames = Frame::decode_all(&message).unwrap();
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[2].stream, 5);
        assert_eq!(frames[2].payload.len(), 2);
    }

    #[test]
    fn rejects_bad_headers() {
        assert_eq!(Frame::decode_one(&[1, 2, 3]), Err(FrameError::Short));
        let mut bytes = Frame::empty(ty::PING).encode();
        bytes[2] = 1;
        assert_eq!(Frame::decode_one(&bytes), Err(FrameError::Reserved));
        let mut big = Frame::empty(ty::PING).encode();
        big[16..20].copy_from_slice(&((MAX_PAYLOAD as u32) + 1).to_le_bytes());
        assert!(matches!(
            Frame::decode_one(&big),
            Err(FrameError::TooLarge(_))
        ));
        let mut short = Frame::new(ty::INVOKE, Enc::Raw, vec![0; 10]).encode();
        short.truncate(25);
        assert_eq!(Frame::decode_one(&short), Err(FrameError::Short));
    }

    #[test]
    fn compression_round_trips_and_skips_small_or_binary() {
        let text = "{\"rows\":[".to_owned() + &"\"line\",".repeat(500) + "0]}";
        let mut frame = Frame::new(ty::RESULT, Enc::Json, text.clone().into_bytes());
        frame.compress(false);
        assert!(frame.has(flag::COMPRESSED));
        assert!(frame.payload.len() < text.len());
        frame.decompress().unwrap();
        assert_eq!(frame.payload, text.as_bytes());

        let mut small = Frame::new(ty::RESULT, Enc::Json, b"{}".to_vec());
        small.compress(false);
        assert!(!small.has(flag::COMPRESSED));

        let mut binary = Frame::new(ty::RESULT, Enc::Raw, vec![7; 4096]);
        binary.compress(false);
        assert!(!binary.has(flag::COMPRESSED));
        binary.compress(true);
        assert!(binary.has(flag::COMPRESSED));
    }

    #[test]
    fn fragments_reassemble() {
        let payload: Vec<u8> = (0..2_500_000u32).map(|i| (i % 251) as u8).collect();
        let frame = Frame::new(ty::RESULT, Enc::Raw, payload.clone())
            .with_stream(9)
            .with_session(4);
        let parts = frame.split(MAX_PAYLOAD);
        assert_eq!(parts.len(), 3);
        assert!(parts[0].has(flag::MORE) && parts[1].has(flag::MORE) && !parts[2].has(flag::MORE));
        let mut joiner = Reassembler::default();
        assert_eq!(joiner.push(parts[0].clone()).unwrap(), None);
        assert_eq!(joiner.push(parts[1].clone()).unwrap(), None);
        let whole = joiner.push(parts[2].clone()).unwrap().unwrap();
        assert_eq!(whole.payload, payload);
        assert_eq!(whole.stream, 9);
        assert_eq!(joiner.buffered, 0);
    }

    #[test]
    fn matches_the_shared_test_vectors() {
        let raw = include_str!("../../tests/vectors/frames.json");
        let vectors: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
        assert!(!vectors.is_empty());
        for v in vectors {
            let hex = v["hex"].as_str().unwrap();
            let bytes: Vec<u8> = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect();
            let frames = Frame::decode_all(&bytes).unwrap();
            let expected = v["frames"].as_array().unwrap();
            assert_eq!(frames.len(), expected.len(), "{}", v["name"]);
            for (frame, want) in frames.iter().zip(expected) {
                assert_eq!(
                    frame.ty as u64,
                    want["type"].as_u64().unwrap(),
                    "{}",
                    v["name"]
                );
                assert_eq!(frame.flags as u64, want["flags"].as_u64().unwrap());
                assert_eq!(frame.session as u64, want["session"].as_u64().unwrap());
                assert_eq!(frame.stream as u64, want["stream"].as_u64().unwrap());
                assert_eq!(frame.seq as u64, want["seq"].as_u64().unwrap());
                if let Some(text) = want["payloadText"].as_str() {
                    let mut f = frame.clone();
                    f.decompress().unwrap();
                    assert_eq!(String::from_utf8(f.payload).unwrap(), text, "{}", v["name"]);
                }
                if let Some(msgpack) = want.get("payloadMsgpack") {
                    let value: serde_json::Value = frame.decode_msgpack().unwrap();
                    assert_eq!(&value, msgpack, "{}", v["name"]);
                }
                // Re-encoding gives the same bytes (deflate output is not canonical, so only
                // uncompressed frames are compared byte for byte).
                if !frame.has(flag::COMPRESSED) {
                    let mut again = Vec::new();
                    frame.encode_into(&mut again);
                    assert!(
                        hex.contains(&again.iter().map(|b| format!("{b:02x}")).collect::<String>())
                    );
                }
            }
        }
    }

    /// A tiny deterministic generator (an LCG — no rand crate in the daemon's tree): every
    /// run replays the same corpus, and a regression is a one-line repro.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 33
        }
        fn bytes(&mut self, len: usize) -> Vec<u8> {
            (0..len).map(|_| self.next() as u8).collect()
        }
    }

    /// M8.2's fuzz-lite: no byte sequence may panic the decoder — it answers None or a
    /// clean error, and the tunnel routes on. Structured mutations of valid frames too
    /// (the header fields an attacker controls), each one hundred times.
    #[test]
    fn random_and_mutated_input_never_panics_the_decoder() {
        let mut rng = Lcg(0x9E3779B97F4A7C15);
        for len in 0..80usize {
            let bytes = rng.bytes(len);
            let _ = Frame::decode_all(&bytes);
        }
        for _ in 0..200 {
            let len = 1 + (rng.next() % 400) as usize;
            let mut bytes = rng.bytes(len);
            if bytes.len() >= HEADER_LEN {
                bytes[0] = (rng.next() % 0x90) as u8; // any type, known or not
                bytes[1] = (rng.next() % 0x40) as u8; // any flags mix
                let len = (rng.next() % (MAX_PAYLOAD as u64 + 8)) as u32;
                bytes[16..20].copy_from_slice(&len.to_le_bytes());
            }
            let _ = Frame::decode_all(&bytes);
        }
        // Flip one bit at a time through a valid frame: decode or refuse, never panic.
        let valid = Frame::new(0x11, crate::ws::frame::Enc::Raw, rng.bytes(64)).with_session(7).encode();
        for bit in 0..(valid.len() as u32) * 8 {
            let mut mutated = valid.clone();
            mutated[(bit / 8) as usize] ^= 1 << (bit % 8);
            let _ = Frame::decode_all(&mutated);
        }
    }

    #[test]
    fn arbitrary_frames_round_trip_through_the_codec() {
        let mut rng = Lcg(42);
        for _ in 0..100 {
            let session = (rng.next() & 0xFFFF_FFFF) as u32;
            let len = 1 + (rng.next() % 3000) as usize;
            let payload = rng.bytes(len);
            let frame = Frame::new((rng.next() % 0x90) as u8, crate::ws::frame::Enc::Raw, payload).with_session(session);
            let bytes = frame.encode();
            let back = Frame::decode_all(&bytes).unwrap();
            assert_eq!(back.len(), 1);
            assert_eq!(back[0].ty, frame.ty);
            assert_eq!(back[0].session, frame.session);
            assert_eq!(back[0].payload, frame.payload);
        }
    }
}
