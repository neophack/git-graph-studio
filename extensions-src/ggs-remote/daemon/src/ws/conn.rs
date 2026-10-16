//! One browser connection's downlink state (docs/ggs-remote-plan.md §6.4–§6.5): sequence
//! numbers, the resume ring, the credit window and the hold queue. The state outlives its
//! socket for the 120 s resume window; whatever carries it — a local WebSocket or a Hub
//! tunnel session (§20.10's `Conn`) — is just the `live` sender of encoded messages.

use std::collections::VecDeque;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::Instant;
use tokio::sync::mpsc;

use super::frame::{flag, ty, Frame, MAX_PAYLOAD};
use super::msg::{Notice, INITIAL_CREDIT};
use super::resume::ResumeBuffer;

/// The per-connection hold queue cap (§6.4: the Relay's per-session queue limit).
pub const MAX_HELD_BYTES: usize = 32 << 20;
/// How long a dropped connection's state waits for a resume (§6.5).
pub const RESUME_WINDOW_SECS: u64 = 120;

pub struct Conn {
    /// The connection number: the `session` field on the Relay link.
    pub id: u32,
    /// The resume id the browser presents in `HELLO.resume.sid`.
    pub sid: String,
    pub token_hash: String,
    pub base_path: String,
    pub ip: IpAddr,
    inner: Mutex<Inner>,
}

struct Inner {
    instance: Option<String>,
    live: Option<mpsc::UnboundedSender<Vec<u8>>>,
    /// Which socket task `live` belongs to, bumped by every `go_live` / `resume`: a
    /// superseded socket (a half-open TCP the browser abandoned on a network switch, still
    /// running its loop until the idle check) must never tear down its successor's
    /// binding — its `go_offline` / end-of-life is a no-op against a newer generation.
    live_gen: u64,
    seq: u32,
    resume: ResumeBuffer,
    credit: i64,
    held: VecDeque<Frame>,
    held_bytes: usize,
    deflate: bool,
    detached_at: Option<Instant>,
    bytes_down: u64,
}

impl Conn {
    pub fn new(id: u32, sid: String, token_hash: String, base_path: String, ip: IpAddr) -> Conn {
        Conn {
            id,
            sid,
            token_hash,
            base_path,
            ip,
            inner: Mutex::new(Inner {
                instance: None,
                live: None,
                live_gen: 0,
                seq: 0,
                resume: ResumeBuffer::default(),
                credit: INITIAL_CREDIT as i64,
                held: VecDeque::new(),
                held_bytes: 0,
                deflate: false,
                detached_at: None,
                bytes_down: 0,
            }),
        }
    }

    /// Bind a fresh socket's writer (a new connection: nothing to replay); answers the
    /// generation the calling task owns.
    pub fn go_live(&self, live: mpsc::UnboundedSender<Vec<u8>>, deflate: bool) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        inner.live_gen += 1;
        inner.live = Some(live);
        inner.deflate = deflate;
        inner.detached_at = None;
        inner.credit = INITIAL_CREDIT as i64;
        inner.live_gen
    }

    /// Resume onto a new socket: replay what the browser missed. `None` when the ring no
    /// longer covers `last_seq` (the browser then soft-reloads); on success the generation
    /// the calling task owns.
    pub fn resume(
        &self,
        live: mpsc::UnboundedSender<Vec<u8>>,
        deflate: bool,
        last_seq: u32,
    ) -> Option<u64> {
        let mut inner = self.inner.lock().unwrap();
        let replay = inner.resume.replay_after(last_seq)?;
        inner.resume.ack(last_seq);
        for bytes in replay {
            let _ = live.send(bytes);
        }
        inner.live_gen += 1;
        let gen = inner.live_gen;
        inner.live = Some(live);
        inner.deflate = deflate;
        inner.detached_at = None;
        inner.credit = INITIAL_CREDIT as i64;
        drop(inner);
        self.flush_held();
        Some(gen)
    }

    /// The owning socket is gone: park the state for the resume window. A stale socket's
    /// exit (its generation superseded by a resume) must not take the live binding down.
    pub fn go_offline(&self, gen: u64) {
        let mut inner = self.inner.lock().unwrap();
        if inner.live.is_some() && inner.live_gen == gen {
            inner.live = None;
            inner.detached_at = Some(Instant::now());
        }
    }

    /// Whether the given generation still owns the live binding — a stale socket task's
    /// end-of-life (kick, expired session, protocol error) must not end the connection its
    /// successor is serving.
    pub fn owns_live(&self, gen: u64) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.live.is_some() && inner.live_gen == gen
    }

    pub fn is_live(&self) -> bool {
        self.inner.lock().unwrap().live.is_some()
    }

    /// Offline past the resume window: the state may be dropped.
    pub fn expired(&self, now: Instant) -> bool {
        self.inner
            .lock()
            .unwrap()
            .detached_at
            .is_some_and(|at| now.duration_since(at).as_secs() >= RESUME_WINDOW_SECS)
    }

    pub fn instance(&self) -> Option<String> {
        self.inner.lock().unwrap().instance.clone()
    }

    pub fn set_instance(&self, instance: Option<String>) {
        self.inner.lock().unwrap().instance = instance;
    }

    pub fn bytes_down(&self) -> u64 {
        self.inner.lock().unwrap().bytes_down
    }

    /// Queue one downlink frame. Workload frames (Relay results, channel data, events) spend
    /// credit and wait in the hold queue once it is exhausted; control frames always go.
    pub fn push(&self, frame: Frame) {
        let counted = matches!(
            frame.ty,
            ty::RESULT | ty::CHAN_DATA | ty::EVENT | ty::FETCH_DATA
        );
        let mut inner = self.inner.lock().unwrap();
        if counted && (inner.credit <= 0 || !inner.held.is_empty()) {
            if inner.held_bytes + frame.payload.len() > MAX_HELD_BYTES {
                let stream = frame.stream;
                drop(inner);
                self.overflow(stream);
                return;
            }
            inner.held_bytes += frame.payload.len();
            inner.held.push_back(frame);
            return;
        }
        Self::emit(&mut inner, frame, counted);
    }

    /// Split first, then compress each fragment: compression is per frame on the wire, so a
    /// receiver inflates every frame before it joins a fragment chain.
    fn emit(inner: &mut Inner, frame: Frame, counted: bool) {
        for mut part in frame.split(MAX_PAYLOAD) {
            if inner.deflate {
                part.compress(false);
            }
            inner.seq = inner.seq.wrapping_add(1);
            part.seq = inner.seq;
            part.session = 0;
            if counted {
                inner.credit -= part.payload.len() as i64;
            }
            let bytes = part.encode();
            inner.bytes_down += bytes.len() as u64;
            inner.resume.push(part.seq, bytes.clone());
            if let Some(live) = &inner.live {
                if live.send(bytes).is_err() {
                    inner.live = None;
                    inner.detached_at = Some(Instant::now());
                }
            }
        }
    }

    fn overflow(&self, stream: u32) {
        let notice = Notice {
            stream: Some(stream),
            ..Notice::kind("overflow")
        };
        self.push(Frame::msgpack(ty::NOTICE, &notice));
    }

    /// A CREDIT frame arrived: grow the window, acknowledge, and release held frames.
    pub fn grant(&self, bytes: u32, ack_seq: u32) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.credit = (inner.credit + bytes as i64).min(64 << 20);
            inner.resume.ack(ack_seq);
        }
        self.flush_held();
    }

    pub fn ack(&self, ack_seq: u32) {
        self.inner.lock().unwrap().resume.ack(ack_seq);
    }

    pub fn acked(&self) -> u32 {
        self.inner.lock().unwrap().resume.acked()
    }

    fn flush_held(&self) {
        let mut inner = self.inner.lock().unwrap();
        while inner.credit > 0 {
            let Some(frame) = inner.held.pop_front() else {
                break;
            };
            inner.held_bytes -= frame.payload.len();
            Self::emit(&mut inner, frame, true);
        }
    }

    pub fn held_bytes(&self) -> usize {
        self.inner.lock().unwrap().held_bytes
    }

    /// Send a CLOSE frame (the socket owner closes the WebSocket with the same code).
    pub fn close(&self, code: u16, reason: &str) {
        let frame = Frame::msgpack(
            ty::CLOSE,
            &super::msg::Close {
                code,
                reason: reason.to_owned(),
            },
        );
        let mut inner = self.inner.lock().unwrap();
        Self::emit(&mut inner, frame, false);
    }
}

/// True for frame types the browser may send on to the attached instance's Relay.
pub fn is_relay_bound(t: u8) -> bool {
    matches!(
        t,
        ty::INVOKE
            | ty::CANCEL
            | ty::LISTEN
            | ty::UNLISTEN
            | ty::EMIT
            | ty::CHAN_CLOSE
            | ty::FETCH
            | ty::UPLOAD
    )
}

/// Whether a frame is the last of its fragment chain.
pub fn is_final(frame: &Frame) -> bool {
    !frame.has(flag::MORE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> (Conn, mpsc::UnboundedReceiver<Vec<u8>>) {
        let conn = Conn::new(
            1,
            "sid".into(),
            "hash".into(),
            "/".into(),
            "127.0.0.1".parse().unwrap(),
        );
        let (tx, rx) = mpsc::unbounded_channel();
        conn.go_live(tx, false);
        (conn, rx)
    }

    fn drain(rx: &mut mpsc::UnboundedReceiver<Vec<u8>>) -> Vec<Frame> {
        let mut out = Vec::new();
        while let Ok(bytes) = rx.try_recv() {
            out.extend(Frame::decode_all(&bytes).unwrap());
        }
        out
    }

    #[test]
    fn sequences_and_session_zero() {
        let (conn, mut rx) = conn();
        conn.push(
            Frame::new(ty::RESULT, super::super::frame::Enc::Json, b"1".to_vec()).with_session(9),
        );
        conn.push(Frame::empty(ty::PONG));
        let frames = drain(&mut rx);
        assert_eq!(frames.iter().map(|f| f.seq).collect::<Vec<_>>(), vec![1, 2]);
        assert!(frames.iter().all(|f| f.session == 0));
    }

    #[test]
    fn credit_exhaustion_holds_workload_frames_but_not_control() {
        let (conn, mut rx) = conn();
        let big = vec![b'x'; 600_000];
        conn.push(Frame::new(
            ty::CHAN_DATA,
            super::super::frame::Enc::Raw,
            big.clone(),
        ));
        conn.push(Frame::new(
            ty::CHAN_DATA,
            super::super::frame::Enc::Raw,
            big.clone(),
        ));
        // Credit (1 MB) is now negative: the third waits, a PONG does not.
        conn.push(Frame::new(
            ty::CHAN_DATA,
            super::super::frame::Enc::Raw,
            big.clone(),
        ));
        conn.push(Frame::empty(ty::PONG));
        let frames = drain(&mut rx);
        assert_eq!(
            frames.iter().map(|f| f.ty).collect::<Vec<_>>(),
            vec![ty::CHAN_DATA, ty::CHAN_DATA, ty::PONG]
        );
        assert_eq!(conn.held_bytes(), 600_000);
        conn.grant(1 << 20, 3);
        let frames = drain(&mut rx);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].seq, 4);
        assert_eq!(conn.held_bytes(), 0);
    }

    #[test]
    fn offline_frames_replay_on_resume() {
        let (conn, mut rx) = conn();
        conn.push(Frame::empty(ty::PONG));
        drain(&mut rx);
        conn.go_offline(1);
        conn.push(Frame::new(
            ty::EVENT,
            super::super::frame::Enc::Json,
            b"{}".to_vec(),
        ));
        conn.push(Frame::new(
            ty::EVENT,
            super::super::frame::Enc::Json,
            b"[]".to_vec(),
        ));
        let (tx, mut rx2) = mpsc::unbounded_channel();
        assert!(conn.resume(tx, false, 1).is_some());
        let frames = drain(&mut rx2);
        assert_eq!(frames.iter().map(|f| f.seq).collect::<Vec<_>>(), vec![2, 3]);
        assert!(conn.is_live());
    }

    /// A stale socket's exit must not tear down the binding its successor took over
    /// (2026-10-16): the browser resumed onto a new socket while the old half-open one's
    /// loop was still alive; when that loop's idle check finally fired, its `go_offline`
    /// used to kill the conn the new socket was serving.
    #[test]
    fn a_stale_sockets_exit_leaves_the_resumed_binding_alone() {
        let (conn, mut rx) = conn(); // generation 1
        conn.push(Frame::empty(ty::PONG));
        drain(&mut rx);
        conn.go_offline(1);
        let (tx, mut rx2) = mpsc::unbounded_channel();
        let gen2 = conn.resume(tx, false, 1).unwrap();
        assert_ne!(gen2, 1);
        drain(&mut rx2);
        // The old socket's loop exits now: neither its offline nor its end-of-life gate
        // may touch the new binding.
        conn.go_offline(1);
        assert!(conn.is_live());
        assert!(conn.owns_live(gen2));
        assert!(!conn.owns_live(1));
        // A push still reaches the new socket, not the resume ring alone.
        conn.push(Frame::empty(ty::PONG));
        assert_eq!(drain(&mut rx2).len(), 1);
        // The owning socket's own exit still parks the conn.
        conn.go_offline(gen2);
        assert!(!conn.is_live());
    }

    #[test]
    fn hold_queue_overflow_notices() {
        let (conn, mut rx) = conn();
        conn.push(Frame::new(
            ty::CHAN_DATA,
            super::super::frame::Enc::Raw,
            vec![0; 1 << 20],
        ));
        drain(&mut rx);
        for _ in 0..33 {
            conn.push(
                Frame::new(
                    ty::CHAN_DATA,
                    super::super::frame::Enc::Raw,
                    vec![0; 1 << 20],
                )
                .with_stream(5),
            );
        }
        // The notice itself waits behind the held frames only if it is a workload frame —
        // NOTICE is control, so it went out immediately.
        let frames = drain(&mut rx);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].ty, ty::NOTICE);
        let notice: serde_json::Value = frames[0].decode_msgpack().unwrap();
        assert_eq!(notice["kind"], "overflow");
        assert_eq!(notice["stream"], 5);
    }
}
