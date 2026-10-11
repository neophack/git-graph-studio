//! The Hub's whole memory (docs/ggs-remote-plan.md §20.2): the uuid → online-tunnel table and
//! the limits around it. Nothing is persisted — a restarted Hub loses nothing the PCs cannot
//! rebuild by reconnecting, which is why there is no database and nothing to back up.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

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
}

impl Tunnel {
    pub fn sessions(&self) -> usize {
        self.conns.lock().unwrap().len()
    }

    /// One downlink message for one browser connection; `false` when it is gone.
    pub fn to_conn(&self, session: u32, bytes: Vec<u8>) -> bool {
        let conns = self.conns.lock().unwrap();
        conns
            .get(&session)
            .is_some_and(|tx| tx.send(ToConn::Bytes(bytes)).is_ok())
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
}

/// The per-IP counters that guard the front door (§20.6): tunnel handshakes, login entries
/// and offline-link probes, each with its own window.
#[derive(Default)]
pub struct IpWindows {
    pub hellos: Mutex<HashMap<IpAddr, (u32, Instant)>>,
    pub logins: Mutex<HashMap<(IpAddr, String), (u32, Instant)>>,
    pub offline: Mutex<HashMap<IpAddr, (u32, Instant)>>,
    pub banned: Mutex<HashMap<IpAddr, Instant>>,
}

pub struct Counters {
    pub tunnels_total: AtomicU64,
    pub sessions_total: AtomicU64,
    pub http_requests: AtomicU64,
    pub bytes_up: AtomicU64,
    pub bytes_down: AtomicU64,
}

pub struct Hub {
    pub config: Config,
    pub tunnels: Mutex<HashMap<String, Arc<Tunnel>>>,
    next_session: AtomicU32,
    next_tunnel: AtomicU64,
    pub ips: IpWindows,
    pub counters: Counters,
    pub cache: crate::cache::AssetCache,
}

pub const HELLO_WINDOW: Duration = Duration::from_secs(60);
pub const LOGIN_WINDOW: Duration = Duration::from_secs(60);
pub const LOGIN_MAX: u32 = 10;
pub const OFFLINE_WINDOW: Duration = Duration::from_secs(600);
pub const OFFLINE_MAX: u32 = 100;
pub const BAN: Duration = Duration::from_secs(600);

impl Hub {
    pub fn new(config: Config) -> Arc<Hub> {
        let cache = crate::cache::AssetCache::new(config.asset_cache_mb.max(1) << 20);
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
                bytes_up: AtomicU64::new(0),
                bytes_down: AtomicU64::new(0),
            },
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
             # HELP ggs_hub_bytes_total Bytes proxied, down toward the PCs and up back.\n\
             # TYPE ggs_hub_bytes_total counter\n\
             ggs_hub_bytes_down_total {}\n\
             ggs_hub_bytes_up_total {}\n",
            self.counters.tunnels_total.load(Ordering::Relaxed),
            self.counters.sessions_total.load(Ordering::Relaxed),
            self.counters.http_requests.load(Ordering::Relaxed),
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
    map.retain(|_, (_, at)| now.duration_since(*at) < span);
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
}
