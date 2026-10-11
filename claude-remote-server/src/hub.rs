//! The routing core: which windows and phones of a PC are online, and how opaque
//! end-to-end-encrypted frames travel between them. The relay reads exactly one field of
//! a frame — the routing envelope (`from`, `to`, `seq`, `ct`) — and never its content.
//!
//! Every window (an editor window running the extension) owns a replay ring: frames bank
//! there while it is offline or slow, addressed by a server-assigned cursor, so a
//! reconnecting window resyncs from where it stopped. A slow ring drops its oldest frames
//! and inserts a `gap` marker — the window (whose own PC produced the frames) replays the
//! gap from the conversation store. A phone is pushed live through a bounded channel with
//! no replay: when it overflows the connection is closed and the phone resyncs itself,
//! which keeps the relay's memory bounded per connection, never per traffic.

use crate::store::{now_ms, Device, User};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, watch};

/// WS close codes the clients switch on (axum keeps 4xxx application space).
pub const CLOSE_PROTOCOL: u16 = 4400;
pub const CLOSE_AUTH: u16 = 4401;
pub const CLOSE_OVERFLOW: u16 = 4413;
pub const CLOSE_RATE: u16 = 4429;

/// A window counts as online this long after its last long-poll.
const POLL_ONLINE_MS: u64 = 30_000;
/// Frames per connection in a sliding window before the relay closes it as a flood.
const RATE_FRAMES: usize = 240;
const RATE_WINDOW_MS: u64 = 10_000;

#[derive(Clone)]
pub struct Limits {
    pub max_windows: usize,
    pub queue_frames: usize,
    pub queue_bytes: usize,
}

#[derive(Clone)]
pub struct Hub {
    inner: Arc<Mutex<HubInner>>,
    limits: Limits,
    cursor: Arc<AtomicU64>,
}

#[derive(Default)]
struct HubInner {
    users: HashMap<String, UserOnline>,
}

#[derive(Default)]
pub(crate) struct UserOnline {
    windows: HashMap<String, WindowConn>,
    devices: HashMap<String, DeviceConn>,
}

struct WindowConn {
    meta_ct: Option<String>,
    host: Option<String>,
    seen: u64,
    ring: VecDeque<RingItem>,
    ring_bytes: usize,
    gap_pending: Option<u64>,
    cursor: watch::Sender<u64>,
    cancel: Option<tokio::sync::oneshot::Sender<()>>,
}

struct DeviceConn {
    id: String,
    sender: mpsc::Sender<String>,
    /// Fired when the phone's bounded queue overflows: the WS task closes the connection
    /// (the phone resyncs itself on reconnect — the relay's memory stays bounded).
    kill: std::sync::Arc<tokio::sync::Notify>,
}

enum RingItem {
    Frame { cursor: u64, frame: Value },
    Gap { after: u64 },
}

/// What the relay may tell a client without breaking encryption: window presence and the
/// opaque metadata blob a window chose to publish (itself a sealed frame body).
pub(crate) fn windows_view(user: &UserOnline) -> Value {
    let now = now_ms();
    let mut list: Vec<(u64, Value)> = user
        .windows
        .iter()
        .map(|(id, w)| {
            (
                w.seen,
                json!({
                    "id": id,
                    "meta_ct": w.meta_ct,
                    "host": w.host,
                    "seen": w.seen,
                    "online": now.saturating_sub(w.seen) < POLL_ONLINE_MS || w.cancel.is_some(),
                }),
            )
        })
        .collect();
    list.sort_by_key(|(seen, _)| std::cmp::Reverse(*seen));
    Value::Array(list.into_iter().map(|(_, v)| v).collect())
}

#[derive(Debug, PartialEq)]
pub enum RouteError {
    /// too many online windows for this PC (HTTP 409 / close 4400)
    TooManyWindows,
}

impl RouteError {
    pub fn close_code(&self) -> u16 {
        match self {
            RouteError::TooManyWindows => CLOSE_PROTOCOL,
        }
    }
    pub fn message(&self) -> &'static str {
        match self {
            RouteError::TooManyWindows => "too many online windows for this PC",
        }
    }
}

/// The frame envelope the relay validates. Everything but these fields is the client's to
/// shape; `ct` stays opaque.
#[derive(Debug, Clone)]
pub struct Frame {
    pub from: String,
    pub to: String,
    pub seq: u64,
    pub ct: String,
}

impl Frame {
    /// Parse and shape-check one client message. `kind` must be "frame"; unknown extra
    /// fields pass through untouched (forward compatibility).
    pub fn parse(message: &Value) -> Option<Frame> {
        if message.get("v")?.as_u64()? != 1 {
            return None;
        }
        if message.get("kind")?.as_str()? != "frame" {
            return None;
        }
        let from = member_id(message.get("from")?.as_str()?)?;
        let to_raw = message.get("to")?.as_str()?;
        let to = if to_raw == "*" { "*".to_string() } else { member_id(to_raw)? };
        let seq = message.get("seq")?.as_u64()?;
        let ct = message.get("ct")?.as_str()?;
        // The ciphertext is the sealed body's two base64url parts joined by a dot
        // ("<nonce>.<ciphertext‖tag>" — the shape both clients send); the relay never
        // parses it, so only emptiness, the length cap and a sane charset are checked.
        // The dot was missing from the charset once: the server then refused EVERY real
        // frame as malformed (the hand-written test ciphertexts carried no separator and
        // hid it) — the live e2e probe caught it on its first RPC.
        if ct.is_empty()
            || ct.len() > 1_572_864
            || !ct.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        {
            return None;
        }
        Some(Frame { from, to, seq, ct: ct.to_string() })
    }

    pub fn to_json(&self) -> Value {
        json!({ "v": 1, "kind": "frame", "from": self.from, "to": self.to, "seq": self.seq, "ct": self.ct })
    }
}

/// `w_…` / `d_…` identifiers the relay mints itself; a client may only claim ids of its
/// own kind, in the exact shape.
pub fn member_id(raw: &str) -> Option<String> {
    let (prefix, rest) = raw.split_once('_')?;
    let ok = matches!(prefix, "w" | "d") && rest.len() == 16 && rest.bytes().all(|b| b.is_ascii_alphanumeric());
    ok.then(|| raw.to_string())
}

pub fn window_id(raw: &str) -> Option<String> {
    let id = member_id(raw)?;
    (id.starts_with("w_")).then_some(id)
}

/// A connection's flood window.
#[derive(Default)]
pub struct RateCounter {
    hits: VecDeque<std::time::Instant>,
}

impl RateCounter {
    pub fn hit(&mut self) -> bool {
        let now = std::time::Instant::now();
        self.hits.retain(|t| (now.duration_since(*t).as_millis() as u64) < RATE_WINDOW_MS);
        self.hits.push_back(now);
        self.hits.len() > RATE_FRAMES
    }
}

impl Hub {
    pub fn new(limits: Limits) -> Hub {
        Hub { inner: Arc::new(Mutex::new(HubInner::default())), limits, cursor: Arc::new(AtomicU64::new(1)) }
    }

    fn next_cursor(&self) -> u64 {
        self.cursor.fetch_add(1, Ordering::Relaxed)
    }

    /// Attach a window: online from now, resumable by cursor. The previous connection of
    /// the same window id, if any, is cancelled. `Err` when the PC's window cap is hit.
    pub fn window_attach(
        &self,
        user: &User,
        window: &str,
        cancel: tokio::sync::oneshot::Sender<()>,
    ) -> Result<watch::Receiver<u64>, RouteError> {
        let mut inner = self.inner.lock().unwrap();
        let online = inner.users.entry(user.id.clone()).or_default();
        if !online.windows.contains_key(window) && online.windows.len() >= self.limits.max_windows {
            return Err(RouteError::TooManyWindows);
        }
        let entry = online.windows.entry(window.to_string()).or_insert_with(|| WindowConn {
            meta_ct: None,
            host: None,
            seen: 0,
            ring: VecDeque::new(),
            ring_bytes: 0,
            gap_pending: None,
            cursor: watch::channel(0).0,
            cancel: None,
        });
        entry.seen = now_ms();
        if let Some(old) = entry.cancel.take() {
            let _ = old.send(());
        }
        entry.cancel = Some(cancel);
        Ok(entry.cursor.subscribe())
    }

    /// A long-poll window checks in: online, and a watch to wait on.
    pub fn window_poll_attach(&self, user: &User, window: &str) -> Result<watch::Receiver<u64>, RouteError> {
        let mut inner = self.inner.lock().unwrap();
        let online = inner.users.entry(user.id.clone()).or_default();
        if !online.windows.contains_key(window) && online.windows.len() >= self.limits.max_windows {
            return Err(RouteError::TooManyWindows);
        }
        let entry = online.windows.entry(window.to_string()).or_insert_with(|| WindowConn {
            meta_ct: None,
            host: None,
            seen: now_ms(),
            ring: VecDeque::new(),
            ring_bytes: 0,
            gap_pending: None,
            cursor: watch::channel(0).0,
            cancel: None,
        });
        entry.seen = now_ms();
        Ok(entry.cursor.subscribe())
    }

    pub fn window_detach(&self, user_id: &str, window: &str) {
        let mut inner = self.inner.lock().unwrap();
        let Some(online) = inner.users.get_mut(user_id) else { return };
        let Some(entry) = online.windows.get_mut(window) else { return };
        entry.cancel = None; // the ring stays for a reconnect's cursor resync
    }

    /// The window's cursor high-water: what a reconnecting window resumes after.
    pub fn window_last_cursor(&self, user_id: &str, window: &str) -> u64 {
        let inner = self.inner.lock().unwrap();
        inner
            .users
            .get(user_id)
            .and_then(|u| u.windows.get(window))
            .map(|w| *w.cursor.borrow())
            .unwrap_or(0)
    }

    /// Frames after `cursor`, oldest first, up to `limit`.
    pub fn window_drain(&self, user_id: &str, window: &str, cursor: u64, limit: usize) -> Vec<(u64, Value)> {
        let inner = self.inner.lock().unwrap();
        let Some(online) = inner.users.get(user_id) else { return Vec::new() };
        let Some(entry) = online.windows.get(window) else { return Vec::new() };
        let mut out = Vec::new();
        for item in &entry.ring {
            match item {
                RingItem::Frame { cursor: c, frame } if *c > cursor => {
                    let mut frame = frame.clone();
                    frame["c"] = Value::from(*c);
                    out.push((*c, frame));
                }
                RingItem::Gap { after } if *after > cursor => {
                    // one marker per gap, even when several frames went
                    if let Some((_, last)) = out.last() {
                        if last.get("kind").and_then(Value::as_str) == Some("gap") {
                            continue;
                        }
                    }
                    out.push((*after, json!({ "v": 1, "kind": "gap", "after": after })));
                }
                _ => {}
            }
            if out.len() >= limit {
                break;
            }
        }
        out
    }

    /// Publish the window's sealed metadata (workspace name and friends); phones see the
    /// list change at once.
    pub fn window_meta(&self, user_id: &str, window: &str, meta_ct: Option<String>, host: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        let Some(online) = inner.users.get_mut(user_id) else { return };
        let Some(entry) = online.windows.get_mut(window) else { return };
        entry.meta_ct = meta_ct;
        if host.is_some() {
            entry.host = host;
        }
        entry.seen = now_ms();
        let list = windows_view(online);
        let devices: Vec<&DeviceConn> = online.devices.values().collect();
        for device in devices {
            push_device(device, format!(r#"{{"v":1,"kind":"windows","list":{list}}}"#));
        }
    }

    /// Attach a phone. Its channel is bounded; on overflow the hub fires the kill switch
    /// and the WS task closes the connection (`overflow`).
    pub fn device_attach(&self, device: &Device, sender: mpsc::Sender<String>) -> Arc<tokio::sync::Notify> {
        let mut inner = self.inner.lock().unwrap();
        let online = inner.users.entry(device.user.clone()).or_default();
        let kill = Arc::new(tokio::sync::Notify::new());
        online.devices.insert(
            device.id.clone(),
            DeviceConn { id: device.id.clone(), sender: sender.clone(), kill: kill.clone() },
        );
        // The window list is the phone's landing view; send it before the first await.
        let list = windows_view(online);
        let _ = sender.try_send(format!(r#"{{"v":1,"kind":"windows","list":{list}}}"#));
        kill
    }

    pub fn device_detach(&self, user_id: &str, device_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(online) = inner.users.get_mut(user_id) {
            online.devices.remove(device_id);
        }
    }

    /// Route one frame from an authenticated member. Returns the frame's cursor when it
    /// banked into a window ring.
    pub fn route(&self, user: &User, frame: Frame) -> Result<Option<u64>, RouteError> {
        let mut inner = self.inner.lock().unwrap();
        let online = inner.users.entry(user.id.clone()).or_default();
        match frame.to.as_str() {
            "*" => {
                let mut banked = None;
                for (id, entry) in online.windows.iter_mut() {
                    if id == &frame.from {
                        continue;
                    }
                    banked = self.bank(entry, &frame);
                }
                for device in online.devices.values() {
                    if device.id == frame.from {
                        continue;
                    }
                    push_device(device, frame.to_json().to_string());
                }
                Ok(banked)
            }
            to if to.starts_with("w_") => {
                // A window this PC never attached (or one a relay restart forgot) is a
                // dropped frame, not an error: the lookup is confined to this user's own
                // routing table, so nothing about another PC can leak through it, and
                // failing here once closed the sender's whole connection.
                match online.windows.get_mut(to) {
                    Some(entry) => Ok(self.bank(entry, &frame)),
                    None => Ok(None),
                }
            }
            to => {
                // A phone that is not connected right now (backgrounded, reconnecting)
                // misses the frame — phones resync by pulling; the sender carries on.
                if let Some(device) = online.devices.values().find(|d| d.id == to) {
                    push_device(device, frame.to_json().to_string());
                }
                Ok(None)
            }
        }
    }

    /// and arms a gap marker at the next append, so a draining client learns exactly what
    /// its cursor missed (`after` = the highest cursor that went).
    fn bank(&self, entry: &mut WindowConn, frame: &Frame) -> Option<u64> {
        let cursor = self.next_cursor();
        if let Some(after) = entry.gap_pending.take() {
            entry.ring.push_back(RingItem::Gap { after });
        }
        entry.ring_bytes += frame.ct.len();
        entry.ring.push_back(RingItem::Frame { cursor, frame: frame.to_json() });
        while entry.ring.len() > self.limits.queue_frames || entry.ring_bytes > self.limits.queue_bytes {
            match entry.ring.pop_front() {
                Some(RingItem::Frame { cursor: dropped, frame }) => {
                    entry.ring_bytes -= frame.get("ct").and_then(Value::as_str).map(str::len).unwrap_or(0);
                    entry.gap_pending = Some(dropped);
                }
                Some(RingItem::Gap { after }) => {
                    // A gap marker evicted by newer pressure folds into the pending one.
                    if entry.gap_pending.map_or(true, |pending| pending < after) {
                        entry.gap_pending = Some(after);
                    }
                }
                None => continue,
            }
        }
        let _ = entry.cursor.send_replace(cursor);
        Some(cursor)
    }

    /// Kick every phone of a PC (a rekey or a disable): close 4401 with the reason.
    pub fn kick_devices(&self, user_id: &str, reason: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(online) = inner.users.get_mut(user_id) {
            for (_, device) in online.devices.drain() {
                push_device(&device, format!(r#"{{"v":1,"kind":"kick","reason":"{reason}"}}"#));
            }
        }
    }

    pub fn kick_device(&self, user_id: &str, device_id: &str, reason: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(online) = inner.users.get_mut(user_id) {
            if let Some(device) = online.devices.remove(device_id) {
                push_device(&device, format!(r#"{{"v":1,"kind":"kick","reason":"{reason}"}}"#));
            }
        }
    }

    /// Tell every online window of a PC the pairing epoch moved (a rekey by another
    /// window of the same PC): each reloads the shared identity and re-derives its keys.
    pub fn notify_epoch(&self, user_id: &str, epoch: u64) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(online) = inner.users.get_mut(user_id) {
            for entry in online.windows.values_mut() {
                entry.seen = now_ms();
                let cursor = self.next_cursor();
                entry.ring.push_back(RingItem::Frame { cursor, frame: json!({"v":1,"kind":"epoch_changed","epoch":epoch}) });
                let _ = entry.cursor.send_replace(cursor);
            }
        }
    }

    /// Whether any phone of the PC is online right now.
    pub fn any_device_online(&self, user_id: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.users.get(user_id).map(|u| !u.devices.is_empty()).unwrap_or(false)
    }

    /// Whether one phone of the PC is online right now.
    pub fn device_is_online(&self, user_id: &str, device_id: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        inner
            .users
            .get(user_id)
            .map(|u| u.devices.contains_key(device_id))
            .unwrap_or(false)
    }

    /// The phone-facing window list snapshot.
    pub fn windows_of(&self, user_id: &str) -> Value {
        let inner = self.inner.lock().unwrap();
        inner.users.get(user_id).map(windows_view).unwrap_or_else(|| Value::Array(Vec::new()))
    }

    pub fn online_counts(&self) -> (usize, usize) {
        let inner = self.inner.lock().unwrap();
        let windows: usize = inner.users.values().map(|u| u.windows.len()).sum();
        let devices: usize = inner.users.values().map(|u| u.devices.len()).sum();
        (windows, devices)
    }
}

/// Push one text to a phone; a full queue is the plan's overflow rule — the connection
/// closes and the phone resyncs on reconnect.
fn push_device(device: &DeviceConn, text: String) {
    if device.sender.try_send(text).is_err() {
        device.kill.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    fn user_with(id: &str) -> User {
        User {
            id: id.into(),
            secret: "s".into(),
            auth: "a".into(),
            epoch: 1,
            password: None,
            disabled: false,
            created: 0,
        }
    }

    fn frame(from: &str, to: &str, seq: u64) -> Frame {
        Frame { from: from.into(), to: to.into(), seq, ct: "Y3J5cHRv".into() }
    }

    fn limits() -> Limits {
        Limits { max_windows: 2, queue_frames: 4, queue_bytes: 1024 * 1024 }
    }

    #[test]
    fn frames_parse_and_reject() {
        let good = json!({"v":1,"kind":"frame","from":"w_0123456789abcdef","to":"d_0123456789abcdef","seq":1,"ct":"Y3J5cHRv"});
        assert!(Frame::parse(&good).is_some());
        // The wire's real shape: "<nonce>.<ciphertext>" — the dot is part of it.
        let joined = json!({"v":1,"kind":"frame","from":"w_0123456789abcdef","to":"d_0123456789abcdef","seq":1,"ct":"AAAAAAAAAAAAAAAA.Y3J5cHRv"});
        assert!(Frame::parse(&joined).is_some());
        assert!(Frame::parse(&json!({"v":2,"kind":"frame","from":"w_0123456789abcdef","to":"*","seq":1,"ct":"Y3J5cHRv"})).is_none());
        assert!(Frame::parse(&json!({"v":1,"kind":"window.meta","ct":"e30"})).is_none());
        assert!(Frame::parse(&json!({"v":1,"kind":"frame","from":"x_bad","to":"*","seq":1,"ct":"Y3J5cHRv"})).is_none());
        assert!(Frame::parse(&json!({"v":1,"kind":"frame","from":"w_0123456789abcdef","to":"*","seq":1,"ct":"not base64url!!"})).is_none());
        assert!(Frame::parse(&json!({"v":1,"kind":"frame","from":"w_0123456789abcdef","to":"*","seq":1,"ct":""})).is_none());
    }

    #[test]
    fn a_window_banks_and_resyncs_by_cursor() {
        let hub = Hub::new(limits());
        let user = user_with("u_a");
        let (cancel_tx, _cancel_rx) = tokio::sync::oneshot::channel();
        let mut watch = hub.window_attach(&user, "w_0123456789abcdef", cancel_tx).unwrap();
        for seq in 1..=3u64 {
            let cursor = hub
                .route(&user, frame("d_0123456789abcdef", "w_0123456789abcdef", seq))
                .unwrap()
                .expect("banked");
            assert_eq!(cursor, seq);
        }
        let all = hub.window_drain("u_a", "w_0123456789abcdef", 0, 100);
        assert_eq!(all.len(), 3);
        let tail = hub.window_drain("u_a", "w_0123456789abcdef", 2, 100);
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].1["seq"], 3);
        assert_eq!(*watch.borrow_and_update(), 3);
    }

    #[test]
    fn an_unknown_or_offline_target_drops_the_frame() {
        let hub = Hub::new(limits());
        let user = user_with("u_a");
        // No window or phone of this user carries that id: the frame is dropped, the
        // sender's connection survives (an error here once closed it).
        assert_eq!(hub.route(&user, frame("d_0123456789abcdef", "w_ffffffffffffffff", 1)), Ok(None));
        assert_eq!(hub.route(&user, frame("w_0123456789abcdef", "d_ffffffffffffffff", 1)), Ok(None));
    }

    #[test]
    fn the_window_cap_holds() {
        let hub = Hub::new(limits());
        let user = user_with("u_a");
        for n in 0..2 {
            let (tx, _rx) = tokio::sync::oneshot::channel();
            assert!(hub.window_attach(&user, &format!("w_0123456789abcd{n:02}"), tx).is_ok());
        }
        let (tx, _rx) = tokio::sync::oneshot::channel();
        assert_eq!(
            hub.window_attach(&user, "w_0123456789abcd99", tx).unwrap_err(),
            RouteError::TooManyWindows
        );
        // But a reconnect of an existing window always fits:
        let (tx, _rx) = tokio::sync::oneshot::channel();
        assert!(hub.window_attach(&user, "w_0123456789abcd00", tx).is_ok());
    }

    #[test]
    fn a_flood_of_frames_marks_a_gap_and_keeps_the_tail() {
        let hub = Hub::new(Limits { max_windows: 2, queue_frames: 4, queue_bytes: 1024 * 1024 });
        let user = user_with("u_a");
        let (tx, _rx) = tokio::sync::oneshot::channel();
        hub.window_attach(&user, "w_0123456789abcdef", tx).unwrap();
        for seq in 1..=12 {
            hub.route(&user, frame("d_0123456789abcdef", "w_0123456789abcdef", seq)).unwrap();
        }
        let items = hub.window_drain("u_a", "w_0123456789abcdef", 0, 100);
        // The oldest went; a gap marker says so; the newest survive in order.
        assert!(items.len() < 12);
        assert!(items.iter().any(|(_, v)| v["kind"] == "gap"));
        let seqs: Vec<_> = items
            .iter()
            .filter(|(_, v)| v["kind"] == "frame")
            .map(|(_, v)| v["seq"].as_u64().unwrap())
            .collect();
        let mut sorted = seqs.clone();
        sorted.sort();
        assert_eq!(seqs, sorted);
        assert!(seqs.contains(&12));
        // A cursor from before a gap sees the marker; a cursor at or after the last gap's
        // `after` sees only the surviving tail.
        let after_last_gap = items
            .iter()
            .filter(|(_, v)| v["kind"] == "gap")
            .map(|(c, _)| *c)
            .max()
            .unwrap();
        let tail = hub.window_drain("u_a", "w_0123456789abcdef", after_last_gap, 100);
        assert!(tail.iter().all(|(_, v)| v["kind"] == "frame"));
    }

    #[tokio::test]
    async fn a_phone_receives_live_frames_and_a_kick() {
        let hub = Hub::new(limits());
        let user = user_with("u_a");
        let (tx, mut rx) = mpsc::channel(8);
        let device = Device {
            id: "d_0123456789abcdef".into(),
            user: "u_a".into(),
            token_hash: String::new(),
            epoch: 1,
            name: "phone".into(),
            created: 0,
            last_seen: 0,
        };
        hub.device_attach(&device, tx);
        // The attach pushes the window list first:
        let first = rx.recv().await.unwrap();
        assert!(first.contains("\"kind\":\"windows\""));
        hub.route(&user, frame("w_0123456789abcdef", "d_0123456789abcdef", 1)).unwrap();
        let second = rx.recv().await.unwrap();
        assert!(second.contains("\"kind\":\"frame\""));
        hub.kick_devices("u_a", "rekeyed");
        let third = rx.recv().await.unwrap();
        assert!(third.contains("rekeyed"));
        assert!(!hub.any_device_online("u_a"));
    }

    #[tokio::test]
    async fn a_broadcast_reaches_windows_and_phones_but_not_the_sender() {
        let hub = Hub::new(limits());
        let user = user_with("u_a");
        let (cancel, _rx) = tokio::sync::oneshot::channel();
        hub.window_attach(&user, "w_0123456789abcdef", cancel).unwrap();
        let (tx, mut phone) = mpsc::channel(8);
        let device = Device {
            id: "d_0123456789abcdef".into(),
            user: "u_a".into(),
            token_hash: String::new(),
            epoch: 1,
            name: "phone".into(),
            created: 0,
            last_seen: 0,
        };
        hub.device_attach(&device, tx);
        let _ = phone.recv().await; // windows list
        // A window broadcasts; its own ring is skipped, the phone gets a copy:
        hub.route(&user, frame("w_0123456789abcdef", "*", 7)).unwrap();
        let got = phone.recv().await.unwrap();
        assert!(got.contains("\"to\":\"*\""));
        assert!(hub.window_drain("u_a", "w_0123456789abcdef", 0, 10).is_empty());
    }

    #[test]
    fn epoch_change_reaches_the_window_ring() {
        let hub = Hub::new(limits());
        let user = user_with("u_a");
        let (tx, _rx) = tokio::sync::oneshot::channel();
        hub.window_attach(&user, "w_0123456789abcdef", tx).unwrap();
        hub.notify_epoch("u_a", 2);
        let items = hub.window_drain("u_a", "w_0123456789abcdef", 0, 10);
        assert!(items.iter().any(|(_, v)| v["kind"] == "epoch_changed" && v["epoch"] == 2));
    }

    #[test]
    fn two_users_never_share_a_routing_table() {
        let hub = Hub::new(limits());
        let store = Store::open(None).unwrap();
        let _ = store;
        let a = user_with("u_a");
        let b = user_with("u_b");
        let (tx, _rx) = tokio::sync::oneshot::channel();
        hub.window_attach(&a, "w_0123456789abcdef", tx).unwrap();
        // B's device frame to A's window id: the id exists only in A's table, so B's
        // frame goes nowhere — A's ring stays empty.
        assert_eq!(hub.route(&b, frame("d_0123456789abcdef", "w_0123456789abcdef", 1)), Ok(None));
        assert!(hub.window_drain("u_a", "w_0123456789abcdef", 0, 64).is_empty());
    }
}
