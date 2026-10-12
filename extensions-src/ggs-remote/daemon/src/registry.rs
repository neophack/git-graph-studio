//! The instance registry (docs/ggs-remote-plan.md §7.8, §13): every GGS instance that holds a
//! control connection, its Relay link while remote sessions are attached, the in-flight
//! asset and file requests, and the two-level heartbeat. Changes bump a generation the
//! browser connections watch, which is how `WINDOWS` is pushed in real time.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, watch};

use crate::control_msg::{LaunchSpec, ToInstance};
use crate::util::now_secs;
use crate::ws::msg::{Busy, InstanceInfo, Summary, SummaryTab};

/// Heartbeat cadence and tolerance (§7.8): a ping every 15 s, a miss after 10 s without the
/// pong, `unresponsive` after two misses in a row.
pub const PING_EVERY: Duration = Duration::from_secs(15);
pub const PONG_DEADLINE: Duration = Duration::from_secs(10);
pub const MISSES_TO_FLAG: u32 = 2;
/// How long a Relay outlives its last session (§3.2).
pub const RELAY_LINGER: Duration = Duration::from_secs(60);
/// How long an `EnsureRelay` token is good for.
pub const RELAY_TOKEN_TTL: Duration = Duration::from_secs(60);

/// One chunk of an asset or download reply.
#[derive(Debug)]
pub struct ReplyChunk {
    pub status: u16,
    pub content_type: String,
    pub etag: String,
    pub name: String,
    pub total: u64,
    pub body: Vec<u8>,
    pub done: bool,
}

#[derive(Default)]
pub struct Heartbeat {
    pub nonce: u64,
    /// When the outstanding ping went out (`None` once answered).
    pub sent: Option<Instant>,
    pub misses: u32,
    last_ping: Option<Instant>,
}

impl Heartbeat {
    /// Due for a new ping? Records a miss when the previous one went unanswered.
    pub fn tick(&mut self, now: Instant) -> Option<u64> {
        if self
            .last_ping
            .is_some_and(|last| now.duration_since(last) < PING_EVERY)
        {
            return None;
        }
        if self.sent.is_some() {
            self.misses += 1;
        }
        self.nonce += 1;
        self.sent = Some(now);
        self.last_ping = Some(now);
        Some(self.nonce)
    }

    pub fn pong(&mut self, nonce: u64) {
        if nonce == self.nonce {
            self.sent = None;
            self.misses = 0;
        }
    }

    /// Two misses in a row — the current ping counting once its deadline passed.
    pub fn overdue(&self, now: Instant) -> bool {
        let pending_miss = self
            .sent
            .is_some_and(|s| now.duration_since(s) > PONG_DEADLINE);
        self.misses + u32::from(pending_miss) >= MISSES_TO_FLAG
    }

    pub fn reset(&mut self) {
        *self = Heartbeat::default();
    }
}

pub struct Instance {
    pub info: InstanceInfo,
    pub pid: u32,
    pub launch: LaunchSpec,
    pub control: mpsc::UnboundedSender<ToInstance>,
    pub relay: Option<mpsc::UnboundedSender<Vec<u8>>>,
    pub relay_token: Option<(String, Instant)>,
    pub relay_ready: watch::Sender<bool>,
    pub relay_idle_since: Option<Instant>,
    pub control_beat: Heartbeat,
    pub relay_beat: Heartbeat,
    pub pending: HashMap<u32, mpsc::UnboundedSender<ReplyChunk>>,
    pub close_waiter: Option<oneshot::Sender<Vec<String>>>,
    pub idle_since: Option<Instant>,
    /// A control connection serial: a reconnect of the same instance id replaces the entry,
    /// and the old connection's teardown must not remove the new one.
    pub conn_serial: u64,
}

pub struct Registry {
    pub instances: Mutex<HashMap<String, Instance>>,
    next_req: AtomicU32,
    pub generation: watch::Sender<u64>,
    /// Waiters for the next instance to register (a SPAWN or a restart).
    pub register_waiters: Mutex<Vec<oneshot::Sender<String>>>,
    next_serial: AtomicU32,
}

impl Default for Registry {
    fn default() -> Registry {
        Registry {
            instances: Mutex::new(HashMap::new()),
            next_req: AtomicU32::new(1),
            generation: watch::channel(0).0,
            register_waiters: Mutex::new(Vec::new()),
            next_serial: AtomicU32::new(1),
        }
    }
}

pub struct Registration {
    pub instance_id: String,
    pub pid: u32,
    pub version: String,
    pub title: String,
    pub folders: Vec<String>,
    pub visible: bool,
    pub remote_host: bool,
    pub launch: LaunchSpec,
}

impl Registry {
    pub fn changed(&self) {
        self.generation.send_modify(|g| *g += 1);
    }

    pub fn next_req(&self) -> u32 {
        self.next_req.fetch_add(1, Ordering::Relaxed)
    }

    pub fn register(&self, reg: Registration, control: mpsc::UnboundedSender<ToInstance>) -> u64 {
        let serial = self.next_serial.fetch_add(1, Ordering::Relaxed) as u64;
        let now = now_secs();
        let instance = Instance {
            info: InstanceInfo {
                id: reg.instance_id.clone(),
                title: reg.title,
                folders: reg.folders,
                version: reg.version,
                visible: reg.visible,
                remote_sessions: 0,
                started_at: now,
                busy: Busy::default(),
                state: "ok".into(),
                last_seen: now,
                summary: Summary::default(),
                spawned: reg.remote_host,
            },
            pid: reg.pid,
            launch: reg.launch,
            control,
            relay: None,
            relay_token: None,
            relay_ready: watch::channel(false).0,
            relay_idle_since: None,
            control_beat: Heartbeat::default(),
            relay_beat: Heartbeat::default(),
            pending: HashMap::new(),
            close_waiter: None,
            idle_since: Some(Instant::now()),
            conn_serial: serial,
        };
        self.instances
            .lock()
            .unwrap()
            .insert(reg.instance_id.clone(), instance);
        for waiter in self.register_waiters.lock().unwrap().drain(..) {
            let _ = waiter.send(reg.instance_id.clone());
        }
        self.changed();
        serial
    }

    /// Remove an instance if the entry still belongs to the given control connection.
    pub fn unregister(&self, id: &str, serial: u64) -> Option<Instance> {
        let mut map = self.instances.lock().unwrap();
        if map.get(id).is_some_and(|i| i.conn_serial == serial) {
            let gone = map.remove(id);
            drop(map);
            self.changed();
            return gone;
        }
        None
    }

    pub fn snapshot(&self) -> Vec<InstanceInfo> {
        let mut list: Vec<InstanceInfo> = self
            .instances
            .lock()
            .unwrap()
            .values()
            .map(|i| i.info.clone())
            .collect();
        list.sort_by(|a, b| a.started_at.cmp(&b.started_at).then(a.id.cmp(&b.id)));
        list
    }

    pub fn exists(&self, id: &str) -> bool {
        self.instances.lock().unwrap().contains_key(id)
    }

    pub fn version_of(&self, id: &str) -> Option<String> {
        self.instances
            .lock()
            .unwrap()
            .get(id)
            .map(|i| i.info.version.clone())
    }

    pub fn send(&self, id: &str, message: ToInstance) -> bool {
        self.instances
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|i| i.control.send(message).is_ok())
    }

    pub fn with<R>(&self, id: &str, f: impl FnOnce(&mut Instance) -> R) -> Option<R> {
        self.instances.lock().unwrap().get_mut(id).map(f)
    }

    pub fn update(
        &self,
        id: &str,
        title: Option<String>,
        folders: Option<Vec<String>>,
        visible: Option<bool>,
        summary: Option<crate::control_msg::Summary>,
    ) {
        let touched = self.with(id, |i| {
            if let Some(title) = title {
                i.info.title = title;
            }
            if let Some(folders) = folders {
                i.info.folders = folders;
            }
            if let Some(visible) = visible {
                i.info.visible = visible;
            }
            if let Some(summary) = summary {
                i.info.busy = Busy {
                    terminals: summary.terminals,
                    dirty: summary.dirty,
                };
                i.info.summary = Summary {
                    tabs: summary
                        .tabs
                        .into_iter()
                        .map(|t| SummaryTab {
                            path: t.path,
                            dirty: t.dirty,
                            active: t.active,
                        })
                        .collect(),
                    terminals: summary.terminals,
                    dirty: summary.dirty,
                    scm_changes: summary.scm_changes,
                };
            }
            i.info.last_seen = now_secs();
        });
        if touched.is_some() {
            self.changed();
        }
    }

    /// Start an asset or file request; answers its id and the reply stream.
    pub fn open_request(&self, id: &str) -> Option<(u32, mpsc::UnboundedReceiver<ReplyChunk>)> {
        let req = self.next_req();
        let (tx, rx) = mpsc::unbounded_channel();
        self.with(id, |i| {
            i.pending.insert(req, tx);
        })?;
        Some((req, rx))
    }

    pub fn deliver(&self, id: &str, req: u32, chunk: ReplyChunk) {
        let done = chunk.done;
        self.with(id, |i| {
            if let Some(tx) = i.pending.get(&req) {
                let _ = tx.send(chunk);
            }
            if done {
                i.pending.remove(&req);
            }
        });
    }

    pub fn cancel_request(&self, id: &str, req: u32) {
        self.with(id, |i| {
            i.pending.remove(&req);
        });
    }

    /// Count of attached remote sessions per instance, written into the infos.
    pub fn set_session_counts(&self, counts: &HashMap<String, u32>) {
        let mut changed = false;
        for (id, inst) in self.instances.lock().unwrap().iter_mut() {
            let n = counts.get(id).copied().unwrap_or(0);
            if inst.info.remote_sessions != n {
                inst.info.remote_sessions = n;
                changed = true;
            }
        }
        if changed {
            self.changed();
        }
    }

    pub async fn wait_for_registration(&self, timeout: Duration) -> Option<String> {
        let (tx, rx) = oneshot::channel();
        self.register_waiters.lock().unwrap().push(tx);
        tokio::time::timeout(timeout, rx).await.ok()?.ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg(id: &str) -> Registration {
        Registration {
            instance_id: id.into(),
            pid: std::process::id(),
            version: "0.1.10".into(),
            title: "repo".into(),
            folders: vec!["/repo".into()],
            visible: true,
            remote_host: false,
            launch: LaunchSpec::default(),
        }
    }

    /// The heartbeat's own arithmetic (§7.8): the ping cadence, the miss counting behind the
    /// `unresponsive` flag, and a Pong healing it — the integration test drives the flag's
    /// push wiring with the state these boundaries compute.
    #[test]
    fn pings_come_no_faster_than_the_period() {
        let mut beat = Heartbeat::default();
        let t0 = Instant::now();
        assert!(beat.tick(t0).is_some(), "the first ping is due at once");
        assert!(
            beat.tick(t0 + PING_EVERY - Duration::from_secs(1))
                .is_none(),
            "not before the period"
        );
        assert!(beat.tick(t0 + PING_EVERY).is_some(), "due at the period");
        let nonce = beat.tick(t0 + PING_EVERY * 2).unwrap();
        assert_eq!(nonce, 3, "the nonce counts pings");
    }

    #[test]
    fn an_answered_ping_never_flags() {
        let mut beat = Heartbeat::default();
        let t0 = Instant::now();
        let nonce = beat.tick(t0).unwrap();
        beat.pong(nonce);
        let late = t0 + PONG_DEADLINE + Duration::from_secs(1);
        assert!(!beat.overdue(late));
        // A stale Pong (a late answer to an older ping) clears nothing it should not.
        beat.pong(nonce - 1);
        assert!(!beat.overdue(late));
    }

    #[test]
    fn two_misses_flag_and_a_pong_heals() {
        let mut beat = Heartbeat::default();
        let t0 = Instant::now();
        let _first = beat.tick(t0).unwrap();
        // The first ping's deadline passes unanswered; the second goes out and counts the
        // miss.
        let t1 = t0 + PING_EVERY;
        let second = beat.tick(t1).unwrap();
        assert!(
            !beat.overdue(t1 + Duration::from_secs(1)),
            "one unanswered ping is not yet two misses"
        );
        let t2 = t1 + PING_EVERY + PONG_DEADLINE + Duration::from_secs(1);
        assert!(
            beat.overdue(t2),
            "the counted miss plus the pending one past its deadline flag it"
        );
        beat.pong(second);
        assert!(!beat.overdue(t2), "answering the current ping heals it");
    }

    #[test]
    fn register_update_unregister() {
        let registry = Registry::default();
        let mut gen = registry.generation.subscribe();
        let (tx, _rx) = mpsc::unbounded_channel();
        let serial = registry.register(reg("ggs-1"), tx);
        assert!(gen.has_changed().unwrap());
        gen.mark_unchanged();
        registry.update(
            "ggs-1",
            Some("other".into()),
            None,
            None,
            Some(crate::control_msg::Summary {
                tabs: vec![crate::control_msg::SummaryTab {
                    path: "/repo/a.rs".into(),
                    dirty: true,
                    active: true,
                }],
                terminals: 2,
                dirty: 1,
                scm_changes: 3,
            }),
        );
        let snap = registry.snapshot();
        assert_eq!(snap[0].title, "other");
        assert_eq!(snap[0].busy.terminals, 2);
        assert_eq!(snap[0].summary.scm_changes, 3);
        assert!(gen.has_changed().unwrap());
        // A stale serial (an older control connection) cannot remove the entry.
        assert!(registry.unregister("ggs-1", serial + 100).is_none());
        assert!(registry.unregister("ggs-1", serial).is_some());
        assert!(registry.snapshot().is_empty());
    }

    #[test]
    fn requests_route_chunks_until_done() {
        let registry = Registry::default();
        let (tx, _rx) = mpsc::unbounded_channel();
        registry.register(reg("ggs-1"), tx);
        let (req, mut rx) = registry.open_request("ggs-1").unwrap();
        let chunk = |done| ReplyChunk {
            status: 200,
            content_type: "text/plain".into(),
            etag: String::new(),
            name: String::new(),
            total: 0,
            body: b"ab".to_vec(),
            done,
        };
        registry.deliver("ggs-1", req, chunk(false));
        registry.deliver("ggs-1", req, chunk(true));
        registry.deliver("ggs-1", req, chunk(true));
        assert!(!rx.try_recv().unwrap().done);
        assert!(rx.try_recv().unwrap().done);
        assert!(rx.try_recv().is_err());
        assert!(registry.open_request("missing").is_none());
    }

    #[test]
    fn heartbeat_flags_after_two_misses() {
        let mut beat = Heartbeat::default();
        let t0 = Instant::now();
        let n1 = beat.tick(t0).unwrap();
        beat.pong(n1);
        assert!(beat.tick(t0 + Duration::from_secs(5)).is_none());
        assert!(beat.tick(t0 + Duration::from_secs(17)).is_some());
        assert!(!beat.overdue(t0 + Duration::from_secs(18)));
        // No pong: the next tick records a miss, the one after a second.
        assert!(beat.tick(t0 + Duration::from_secs(33)).is_some());
        assert_eq!(beat.misses, 1);
        assert!(beat.tick(t0 + Duration::from_secs(49)).is_some());
        assert!(beat.overdue(t0 + Duration::from_secs(49)));
        let nonce = beat.nonce;
        beat.pong(nonce);
        assert!(!beat.overdue(t0 + Duration::from_secs(50)));
    }
}
