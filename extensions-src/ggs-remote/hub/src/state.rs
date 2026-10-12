//! The Hub's whole memory (docs/ggs-remote-plan.md §20.2): the uuid → online-tunnel table and
//! the limits around it. Nothing is persisted — a restarted Hub loses nothing the PCs cannot
//! rebuild by reconnecting, which is why there is no database and nothing to back up.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::mpsc;
use tokio::sync::Notify;

use crate::audit::Audit;
use crate::blocklist::Blocklist;
use crate::config::Config;
use crate::frame::Frame;

/// What a browser-side connection (or a proxied HTTP request) hears from its tunnel: the
/// daemon asked for it to be closed (a 4401 kick, a replaced key), or nothing more is coming.
#[derive(Debug)]
pub enum ToConn {
    /// One encoded ggs-remote/1 message for this browser connection (session already 0).
    Bytes(Vec<u8>),
    Close {
        code: u16,
        reason: String,
    },
}

/// One online PC: the outbound tunnel's write half plus the browser connections riding it.
pub struct Tunnel {
    pub uuid: String,
    /// This tunnel's registration number — `unregister` matches on it, so a replaced tunnel
    /// unwinding never takes its successor off the table.
    pub id: u64,
    pub tx: mpsc::UnboundedSender<Vec<u8>>,
    /// session → that browser task's control channel.
    pub conns: Mutex<HashMap<u32, mpsc::UnboundedSender<ToConn>>>,
    pub since: Instant,
    /// The per-tunnel daily byte budget (§20.8 `bytes_per_day_per_tunnel`); `None` = off.
    pub budget: Option<AtomicU64>,
    /// The operator's kill switch lands here (`blocklist`): one stored permit wakes the run
    /// loop's `killed` arm, whose exit path unregisters the tunnel and tells its browsers
    /// the plain `pc-offline` — a blocked PC looks exactly like an away one.
    pub killed: Notify,
}

impl Tunnel {
    pub fn sessions(&self) -> usize {
        self.conns.lock().unwrap().len()
    }

    /// One downlink message for one browser connection; `false` when it is gone. A gone
    /// receiver's entry leaves with the failed send — nothing else would revisit it, and a
    /// table full of ghosts is a table whose ceiling (`sessions_per_tunnel`) fills with them.
    pub fn to_conn(&self, session: u32, bytes: Vec<u8>) -> bool {
        let mut conns = self.conns.lock().unwrap();
        let sent = conns
            .get(&session)
            .is_some_and(|tx| tx.send(ToConn::Bytes(bytes)).is_ok());
        if !sent {
            conns.remove(&session);
        }
        sent
    }

    /// The daemon closed a browser connection (CONN_CLOSE from the PC: a password change's
    /// 4401, a sign-out). No such session: nothing to do.
    pub fn close_conn(&self, session: u32, code: u16, reason: &str) {
        let sender = self.conns.lock().unwrap().remove(&session);
        if let Some(tx) = sender {
            let _ = tx.send(ToConn::Close {
                code,
                reason: reason.to_owned(),
            });
        }
    }

    /// Every browser connection on this tunnel ends — the tunnel is going away.
    pub fn close_all(&self, code: u16, reason: &str) {
        let senders: Vec<_> = self.conns.lock().unwrap().drain().collect();
        for (_, tx) in senders {
            let _ = tx.send(ToConn::Close {
                code,
                reason: reason.to_owned(),
            });
        }
    }

    pub fn send(&self, frame: &Frame) -> bool {
        self.tx.send(frame.encode()).is_ok()
    }

    /// The tunnel's remaining daily byte budget, when one is configured.
    #[allow(deprecated)] // `fetch_update` was renamed `try_update` in 1.99; the crate floor
                         // (1.94) predates the new name, so the old one stays until the floor passes it.
    pub fn spend(&self, bytes: u64) -> bool {
        let Some(budget) = &self.budget else {
            return true;
        };
        budget
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |left| {
                left.checked_sub(bytes)
            })
            .is_ok()
    }

    /// Take this tunnel off the air (§20.6 `blocklist`): the permit wakes the run loop's
    /// `killed` arm; its exit path unregisters and tells every browser `pc-offline`.
    pub fn kill(&self) {
        self.killed.notify_one();
    }
}

/// The per-IP counters that guard the front door (§20.6): tunnel handshakes, login entries,
/// proxied requests and offline-link probes, each with its own window.
#[derive(Default)]
pub struct IpWindows {
    pub hellos: Mutex<HashMap<IpAddr, (u32, Instant)>>,
    pub logins: Mutex<HashMap<(IpAddr, String), (u32, Instant)>>,
    pub requests: Mutex<HashMap<IpAddr, (u32, Instant)>>,
    pub offline: Mutex<HashMap<IpAddr, (u32, Instant)>>,
    pub banned: Mutex<HashMap<IpAddr, Instant>>,
}

pub struct Counters {
    pub tunnels_total: AtomicU64,
    pub sessions_total: AtomicU64,
    pub http_requests: AtomicU64,
    pub visitor_refused: AtomicU64,
    pub bytes_up: AtomicU64,
    pub bytes_down: AtomicU64,
}

/// One link's day bucket of distinct viewer IPs (§20.6): when the bucket started, and the
/// first-seen instant of each IP.
pub struct VisitorBucket {
    pub since: Instant,
    pub seen: HashMap<IpAddr, Instant>,
}

pub struct Hub {
    pub config: Config,
    pub tunnels: Mutex<HashMap<String, Arc<Tunnel>>>,
    next_session: AtomicU32,
    next_tunnel: AtomicU64,
    pub ips: IpWindows,
    pub counters: Counters,
    /// The distinct browser IPs each link has served inside its day bucket (§20.6
    /// `visitors_per_day_per_tunnel`) — keyed by uuid, not by tunnel, so a reconnect does
    /// not reset it: a personal remote-workbench link has a handful of viewers, a link
    /// shared like a public site hundreds, and cycling the tunnel must not launder the count.
    pub visitors: Mutex<HashMap<String, VisitorBucket>>,
    /// The operator's audit trail (§20.6 `audit_log`); a no-op when off.
    pub audit: Audit,
    /// The operator's kill switch (§20.6 `blocklist`); inert when off.
    pub blocklist: Blocklist,
    pub cache: crate::cache::AssetCache,
}

pub const HELLO_WINDOW: Duration = Duration::from_secs(60);
pub const LOGIN_WINDOW: Duration = Duration::from_secs(60);
pub const LOGIN_MAX: u32 = 10;
pub const REQUEST_WINDOW: Duration = Duration::from_secs(60);
pub const OFFLINE_WINDOW: Duration = Duration::from_secs(600);
pub const OFFLINE_MAX: u32 = 100;
pub const BAN: Duration = Duration::from_secs(600);
/// One day per visitor bucket — a rounded bucket, not a rolling window: simple to reason
/// about, and precise to the minute is not a property this guard needs.
pub const VISITOR_WINDOW: Duration = Duration::from_secs(24 * 3600);

impl Hub {
    pub fn new(config: Config) -> Arc<Hub> {
        let cache = crate::cache::AssetCache::new(config.asset_cache_mb.max(1) << 20);
        let audit = Audit::open(&config.audit_log);
        let blocklist = Blocklist::open(&config.blocklist);
        Arc::new(Hub {
            config,
            tunnels: Mutex::new(HashMap::new()),
            next_session: AtomicU32::new(1),
            next_tunnel: AtomicU64::new(1),
            ips: IpWindows::default(),
            counters: Counters {
                tunnels_total: AtomicU64::new(0),
                sessions_total: AtomicU64::new(0),
                http_requests: AtomicU64::new(0),
                visitor_refused: AtomicU64::new(0),
                bytes_up: AtomicU64::new(0),
                bytes_down: AtomicU64::new(0),
            },
            visitors: Mutex::new(HashMap::new()),
            audit,
            blocklist,
            cache,
        })
    }

    /// A cached immutable workbench asset, when this exact path was served before (§20.6).
    pub fn cache_get(&self, key: &str) -> Option<crate::cache::Entry> {
        self.cache.get(key)
    }

    pub fn cache_store(&self, key: &str, head: &crate::msg::HttpRes, body: Vec<u8>) {
        self.cache.store(key.to_owned(), head, body);
    }

    pub fn alloc_session(&self) -> u32 {
        self.next_session.fetch_add(1, Ordering::Relaxed)
    }

    /// Build a tunnel handle bound to this Hub's writer and registration sequence.
    pub fn new_tunnel(&self, uuid: String, tx: mpsc::UnboundedSender<Vec<u8>>) -> Tunnel {
        Tunnel {
            uuid,
            id: self.next_tunnel.fetch_add(1, Ordering::Relaxed),
            tx,
            conns: Mutex::new(HashMap::new()),
            since: Instant::now(),
            budget: (self.config.bytes_per_day_per_tunnel > 0)
                .then(|| AtomicU64::new(self.config.bytes_per_day_per_tunnel)),
            killed: Notify::new(),
        }
    }

    pub fn tunnel(&self, uuid: &str) -> Option<Arc<Tunnel>> {
        self.tunnels.lock().unwrap().get(uuid).cloned()
    }

    pub fn tunnel_count(&self) -> usize {
        self.tunnels.lock().unwrap().len()
    }

    /// Register a tunnel, replacing any earlier one for the same device key: the new key wins,
    /// the previous tunnel's task hears `replaced` and stops (§20.1). Answers the displaced
    /// tunnel, if any.
    pub fn register(&self, uuid: String, tunnel: Arc<Tunnel>) -> Option<Arc<Tunnel>> {
        let displaced = self.tunnels.lock().unwrap().insert(uuid, tunnel);
        if displaced.is_none() {
            self.counters.tunnels_total.fetch_add(1, Ordering::Relaxed);
        }
        displaced
    }

    pub fn unregister(&self, uuid: &str, id: u64) {
        let mut tunnels = self.tunnels.lock().unwrap();
        // Only remove it if this exact tunnel is the registered one — a replaced tunnel
        // unwinding must not take its successor off the table.
        if tunnels.get(uuid).is_some_and(|current| current.id == id) {
            tunnels.remove(uuid);
        }
    }

    pub fn metrics_text(&self) -> String {
        let tunnels = self.tunnel_count();
        let sessions: usize = self
            .tunnels
            .lock()
            .unwrap()
            .values()
            .map(|t| t.sessions())
            .sum();
        format!(
            "# HELP ggs_hub_tunnels_online Online PC tunnels.\n\
             # TYPE ggs_hub_tunnels_online gauge\n\
             ggs_hub_tunnels_online {tunnels}\n\
             # HELP ggs_hub_sessions_online Browser connections riding a tunnel.\n\
             # TYPE ggs_hub_sessions_online gauge\n\
             ggs_hub_sessions_online {sessions}\n\
             # HELP ggs_hub_tunnels_total Tunnels ever registered.\n\
             # TYPE ggs_hub_tunnels_total counter\n\
             ggs_hub_tunnels_total {}\n\
             # HELP ggs_hub_sessions_total Browser connections ever opened.\n\
             # TYPE ggs_hub_sessions_total counter\n\
             ggs_hub_sessions_total {}\n\
             # HELP ggs_hub_http_requests_total Proxied HTTP requests.\n\
             # TYPE ggs_hub_http_requests_total counter\n\
             ggs_hub_http_requests_total {}\n\
             # HELP ggs_hub_visitor_refused_total Requests refused by a link's daily distinct-viewer ceiling.\n\
             # TYPE ggs_hub_visitor_refused_total counter\n\
             ggs_hub_visitor_refused_total {}\n\
             # HELP ggs_hub_bytes_total Bytes proxied, down toward the PCs and up back.\n\
             # TYPE ggs_hub_bytes_total counter\n\
             ggs_hub_bytes_down_total {}\n\
             ggs_hub_bytes_up_total {}\n",
            self.counters.tunnels_total.load(Ordering::Relaxed),
            self.counters.sessions_total.load(Ordering::Relaxed),
            self.counters.http_requests.load(Ordering::Relaxed),
            self.counters.visitor_refused.load(Ordering::Relaxed),
            self.counters.bytes_down.load(Ordering::Relaxed),
            self.counters.bytes_up.load(Ordering::Relaxed),
        )
    }
}

/// Count one event in a window; answers the (kept) count — the caller rejects past the max.
fn count<K: std::hash::Hash + Eq + Clone>(
    window: &Mutex<HashMap<K, (u32, Instant)>>,
    key: K,
    span: Duration,
) -> u32 {
    let now = Instant::now();
    let mut map = window.lock().unwrap();
    // Compact only once the table has grown — a per-event `retain` made every counted
    // event O(table), and a many-IP scan turned the front door itself into the cost center.
    // Below the threshold stale entries merely sit until the next compaction; the count of
    // any touched key is exact either way (its own window resets it).
    if map.len() > 1024 {
        map.retain(|_, (_, at)| now.duration_since(*at) < span);
    }
    let entry = map.entry(key).or_insert((0, now));
    entry.0 += 1;
    if now.duration_since(entry.1) >= span {
        entry.0 = 1;
        entry.1 = now;
    }
    entry.0
}

impl Hub {
    pub fn hello_allowed(&self, ip: IpAddr) -> bool {
        if self.config.handshake_rate == 0 {
            return true;
        }
        count(&self.ips.hellos, ip, HELLO_WINDOW) <= self.config.handshake_rate
    }

    pub fn login_entry(&self, ip: IpAddr, uuid: &str) -> bool {
        count(&self.ips.logins, (ip, uuid.to_owned()), LOGIN_WINDOW) <= LOGIN_MAX
    }

    /// Every proxied request toward an online link one IP may make per minute (§20.6
    /// `http_rate`) — the guard a single address hammering one PC's pages otherwise lacks
    /// (the session ceiling caps concurrency, not rate). 0 = unlimited.
    pub fn request_allowed(&self, ip: IpAddr) -> bool {
        if self.config.http_rate == 0 {
            return true;
        }
        count(&self.ips.requests, ip, REQUEST_WINDOW) <= self.config.http_rate
    }

    /// Count one browser IP against a link's daily distinct-viewer ceiling (§20.6
    /// `visitors_per_day_per_tunnel`): an IP already seen costs nothing, a new one past the
    /// cap is refused. Keyed by uuid so a reconnecting PC cannot reset its own count.
    pub fn admit_visitor(&self, uuid: &str, ip: IpAddr) -> bool {
        let cap = self.config.visitors_per_day_per_tunnel;
        if cap == 0 {
            return true;
        }
        let now = Instant::now();
        let mut visitors = self.visitors.lock().unwrap();
        let bucket = visitors
            .entry(uuid.to_owned())
            .or_insert_with(|| VisitorBucket {
                since: now,
                seen: HashMap::new(),
            });
        if now.duration_since(bucket.since) >= VISITOR_WINDOW {
            bucket.since = now;
            bucket.seen.clear();
        }
        if bucket.seen.contains_key(&ip) {
            return true;
        }
        if bucket.seen.len() >= cap {
            return false;
        }
        bucket.seen.insert(ip, now);
        // Bounded by the day's active links: uuids whose bucket expired drop out once the
        // table is large, so a long-lived Hub does not accumulate one entry per ever-seen PC.
        if visitors.len() > 1024 {
            visitors.retain(|_, bucket| now.duration_since(bucket.since) < VISITOR_WINDOW);
        }
        true
    }

    /// The operator's kill switch (§20.6 `blocklist`): re-read the file, then take every
    /// listed PC's tunnel off the air — the run loop's exit path unregisters it and its
    /// browsers hear the plain `pc-offline` close, the same page a next load gets.
    pub fn enforce_blocklist(&self) {
        if !self.blocklist.enabled() {
            return;
        }
        self.blocklist.refresh();
        let tunnels: Vec<Arc<Tunnel>> = self
            .tunnels
            .lock()
            .unwrap()
            .iter()
            .filter(|(uuid, _)| self.blocklist.blocked(uuid))
            .map(|(_, tunnel)| tunnel.clone())
            .collect();
        for tunnel in tunnels {
            crate::warn!("tunnel {}: taken off the air by the blocklist", tunnel.uuid);
            tunnel.kill();
        }
    }

    /// A request for a link whose PC is not online (§20.6): the same page answers whether the
    /// uuid is malformed, unknown or merely gone — but probing them too fast gets an IP held
    /// off for ten minutes.
    pub fn offline_probe(&self, ip: IpAddr) -> bool {
        if self.is_banned(ip) {
            return false;
        }
        if count(&self.ips.offline, ip, OFFLINE_WINDOW) > OFFLINE_MAX {
            self.ips.banned.lock().unwrap().insert(ip, Instant::now());
            crate::warn!("{ip} probed too many offline links: held off for 10 minutes");
            return false;
        }
        true
    }

    pub fn is_banned(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut banned = self.ips.banned.lock().unwrap();
        banned.retain(|_, until| now.duration_since(*until) < BAN);
        banned.contains_key(&ip)
    }
}

impl Tunnel {
    pub fn age(&self) -> Duration {
        self.since.elapsed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hub() -> Arc<Hub> {
        Hub::new(Config::default())
    }

    #[test]
    fn register_replaces_and_unregister_spares_the_successor() {
        let hub = hub();
        let (tx_a, _rx_a) = mpsc::unbounded_channel();
        let (tx_b, _rx_b) = mpsc::unbounded_channel();
        let a = Arc::new(hub.new_tunnel("u".into(), tx_a));
        let b = Arc::new(hub.new_tunnel("u".into(), tx_b));
        assert!(hub.register("u".into(), a.clone()).is_none());
        let displaced = hub.register("u".into(), b).unwrap();
        assert_eq!(displaced.id, a.id);
        // The old tunnel's task unwinding must not unregister the new one.
        hub.unregister("u", a.id);
        assert!(hub.tunnel("u").is_some());
        hub.unregister("u", hub.tunnel("u").unwrap().id);
        assert!(hub.tunnel("u").is_none());
    }

    #[test]
    fn handshake_rate_governs_the_front_door_and_zero_opens_it() {
        let ip: IpAddr = "203.0.113.4".parse().unwrap();
        // The configured rate is the ceiling: 2 allowed, the third refused.
        let hub = Hub::new(Config {
            handshake_rate: 2,
            ..Config::default()
        });
        assert!(hub.hello_allowed(ip));
        assert!(hub.hello_allowed(ip));
        assert!(!hub.hello_allowed(ip));
        // 0 = unlimited (load tests, single-address fleets): the counter never gates.
        let open = Hub::new(Config {
            handshake_rate: 0,
            ..Config::default()
        });
        for _ in 0..100 {
            assert!(open.hello_allowed(ip));
        }
    }

    #[test]
    fn offline_probes_ban_past_the_limit() {
        let hub = hub();
        let ip: IpAddr = "203.0.113.9".parse().unwrap();
        for _ in 0..OFFLINE_MAX {
            assert!(hub.offline_probe(ip));
        }
        assert!(!hub.offline_probe(ip));
        assert!(hub.is_banned(ip));
        let other: IpAddr = "203.0.113.10".parse().unwrap();
        assert!(hub.offline_probe(other));
    }

    #[test]
    fn close_conn_reaches_only_its_session() {
        let hub = hub();
        let (tx, _rx) = mpsc::unbounded_channel();
        let t = Arc::new(hub.new_tunnel("u".into(), tx));
        let (tx1, mut rx1) = mpsc::unbounded_channel();
        let (tx2, mut rx2) = mpsc::unbounded_channel();
        t.conns.lock().unwrap().insert(1, tx1);
        t.conns.lock().unwrap().insert(2, tx2);
        t.close_conn(1, 4401, "credentials-changed");
        assert!(matches!(
            rx1.try_recv(),
            Ok(ToConn::Close { code: 4401, .. })
        ));
        assert!(rx2.try_recv().is_err());
        t.close_all(1001, "tunnel-closed");
        assert!(matches!(rx2.try_recv(), Ok(ToConn::Close { .. })));
    }

    #[test]
    fn a_dead_session_entry_leaves_with_its_failed_send() {
        let hub = hub();
        let (tx, _rx) = mpsc::unbounded_channel();
        let t = Arc::new(hub.new_tunnel("u".into(), tx));
        let (tx1, rx1) = mpsc::unbounded_channel();
        t.conns.lock().unwrap().insert(1, tx1);
        drop(rx1); // the browser task is gone — the entry must not linger as a ghost slot
        assert!(!t.to_conn(1, vec![0]));
        assert!(t.conns.lock().unwrap().is_empty());
        assert_eq!(t.sessions(), 0);
    }

    #[test]
    fn request_rate_governs_every_request_and_zero_opens_it() {
        let ip: IpAddr = "203.0.113.11".parse().unwrap();
        let hub = Hub::new(Config {
            http_rate: 2,
            ..Config::default()
        });
        assert!(hub.request_allowed(ip));
        assert!(hub.request_allowed(ip));
        assert!(!hub.request_allowed(ip));
        let open = Hub::new(Config {
            http_rate: 0,
            ..Config::default()
        });
        for _ in 0..100 {
            assert!(open.request_allowed(ip));
        }
    }

    #[test]
    fn visitors_admit_up_to_the_cap_and_a_new_day_resets() {
        let a: IpAddr = "203.0.113.21".parse().unwrap();
        let b: IpAddr = "203.0.113.22".parse().unwrap();
        let c: IpAddr = "203.0.113.23".parse().unwrap();
        let hub = Hub::new(Config {
            visitors_per_day_per_tunnel: 2,
            ..Config::default()
        });
        assert!(hub.admit_visitor("u", a));
        assert!(hub.admit_visitor("u", b));
        assert!(
            hub.admit_visitor("u", a),
            "an already-seen IP costs nothing"
        );
        assert!(!hub.admit_visitor("u", c));
        // The count hangs off the uuid, not the tunnel: a replaced tunnel inherits it.
        let (tx, _rx) = mpsc::unbounded_channel();
        let _t = hub.new_tunnel("u".into(), tx);
        assert!(
            !hub.admit_visitor("u", c),
            "a reconnect does not launder the count"
        );
        // A new day is a new bucket.
        let mut visitors = hub.visitors.lock().unwrap();
        let bucket = visitors.get_mut("u").unwrap();
        bucket.since = Instant::now() - VISITOR_WINDOW;
        drop(visitors);
        assert!(hub.admit_visitor("u", c));
    }
}
