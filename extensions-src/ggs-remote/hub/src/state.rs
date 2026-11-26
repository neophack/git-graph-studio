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
    /// The day boundary is tracked (`DayBudget::day`): a new UTC day refills the allowance
    /// — before it was, "per day" was really per-connection, and a PC that spent day one's
    /// budget was refused for the whole life of the tunnel.
    budget: Option<Arc<Mutex<DayBudget>>>,
    /// The configured allowance each new day refills to.
    budget_cap: u64,
    /// The operator's kill switch lands here (`blocklist`): one stored permit wakes the run
    /// loop's `killed` arm, whose exit path unregisters the tunnel and tells its browsers
    /// the plain `pc-offline` — a blocked PC looks exactly like an away one.
    pub killed: Notify,
    /// The PC's password verifier (§20.14): pushed as `T_CREDENTIAL` right after `T_READY`
    /// and again on every password change. `None` until it arrives — an old daemon never
    /// sends one, and the joint login treats that link as needing an upgrade.
    credential: Mutex<Option<Credential>>,
}

/// What remains of today's byte allowance, and which UTC day it belongs to.
struct DayBudget {
    day: u64,
    left: u64,
}

/// The UTC day number since the Unix epoch — the budget's refill boundary.
fn today_number() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs() / 86_400)
        .unwrap_or(0)
}

/// The verifier half of the joint login (§20.14): the daemon's Argon2id hash, the credential
/// epoch it belongs to, and the PC's display language for the Hub's own login page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credential {
    pub hash: String,
    pub epoch: u64,
    pub lang: String,
}

impl Tunnel {
    pub fn credential(&self) -> Option<Credential> {
        self.credential.lock().unwrap().clone()
    }

    /// The PC presented (or changed) its verifier: store it, and — on an epoch change —
    /// end every Hub-side login issued under the old password, exactly as the daemon ends
    /// its own sessions (§7.6's rule carried across the relay). Answers whether the epoch
    /// moved, so the caller can drop the link sessions.
    pub fn set_credential(&self, next: Credential) -> bool {
        let mut slot = self.credential.lock().unwrap();
        let moved = slot.as_ref().is_some_and(|old| old.epoch != next.epoch);
        *slot = Some(next);
        moved
    }
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

    /// Reserve a session slot against the ceiling, the check and the insert under one
    /// lock — a critical section no concurrent claimant can interleave, so a burst of
    /// upgrades cannot each pass a check made before their inserts. Answers false when full.
    pub fn reserve_conn(
        &self,
        ceiling: usize,
        session: u32,
        tx: mpsc::UnboundedSender<ToConn>,
    ) -> bool {
        let mut conns = self.conns.lock().unwrap();
        if conns.len() >= ceiling {
            return false;
        }
        conns.insert(session, tx);
        true
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

    /// The tunnel's remaining daily byte budget, when one is configured. A spend that
    /// does not fit is refused whole (nothing deducted), the same accounting the atomic
    /// before it kept.
    pub fn spend(&self, bytes: u64) -> bool {
        self.spend_on_day(today_number(), bytes)
    }

    // Daily byte budgets are owned by `Hub.budgets` keyed by uuid so disconnecting and
    // reconnecting cannot reset a spent day's allowance.

    fn spend_on_day(&self, day: u64, bytes: u64) -> bool {
        let Some(budget) = &self.budget else {
            return true;
        };
        let mut budget = budget.lock().unwrap();
        if budget.day != day {
            budget.day = day;
            budget.left = self.budget_cap;
        }
        match budget.left.checked_sub(bytes) {
            Some(left) => {
                budget.left = left;
                true
            }
            None => false,
        }
    }

    /// Take this tunnel off the air (§20.6 `blocklist`): the permit wakes the run loop's
    /// `killed` arm; its exit path unregisters and tells every browser `pc-offline`.
    pub fn kill(&self) {
        self.killed.notify_one();
    }
}

/// Hard ceiling on tracked keys per rate-limit window so distributed IP scans cannot
/// exhaust Hub memory.
const MAX_WINDOW_ENTRIES: usize = 16_384;
/// Minimum interval between routine table compactions when active keys exceed 1024.
const PRUNE_INTERVAL: Duration = Duration::from_secs(10);

/// Normalize an IP address for rate-limiting and visitor caps: IPv4 stays /32, IPv6 is
/// masked to its /64 prefix so rotating host addresses inside one subnet cannot bypass
/// limits.
pub fn normalize_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(v4) => IpAddr::V4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return IpAddr::V4(v4);
            }
            let masked = u128::from(v6) & 0xffff_ffff_ffff_ffff_0000_0000_0000_0000;
            IpAddr::V6(std::net::Ipv6Addr::from(masked))
        }
    }
}

pub struct WindowTable<K> {
    map: HashMap<K, (u32, Instant)>,
    last_prune: Option<Instant>,
}

impl<K> Default for WindowTable<K> {
    fn default() -> Self {
        WindowTable {
            map: HashMap::new(),
            last_prune: None,
        }
    }
}

/// The per-IP counters that guard the front door (§20.6): tunnel handshakes, login entries,
/// proxied requests and offline-link probes, each with its own window.
#[derive(Default)]
pub struct IpWindows {
    pub hellos: Mutex<WindowTable<IpAddr>>,
    pub logins: Mutex<WindowTable<(IpAddr, String)>>,
    pub requests: Mutex<WindowTable<IpAddr>>,
    pub offline: Mutex<WindowTable<IpAddr>>,
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

/// One link's browser login on the Hub side of the joint login (§20.14): the cookie token's
/// SHA-256 (never the token), stamped with the credential epoch it was issued under. The
/// expiry rules mirror the daemon's own sessions — 30 days from issue when remembered, 12
/// hours sliding otherwise — so the two halves of a joint login age out together.
#[derive(Debug, Clone)]
pub struct LinkSession {
    pub epoch: u64,
    pub created: Instant,
    pub last_seen: Instant,
    pub remember: bool,
    pub ip: IpAddr,
}

/// A link's login lives 30 days from issue when remembered; an unremembered one 12 hours
/// from its last use (sliding) — the daemon's own constants (§7.6), mirrored.
pub const LINK_REMEMBER: Duration = Duration::from_secs(30 * 24 * 3600);
pub const LINK_SLIDING: Duration = Duration::from_secs(12 * 3600);
/// How many logins one link may carry at once — the daemon's device list holds the same
/// order of devices, and the oldest falls out past it.
pub const LINK_SESSIONS_CAP: usize = 64;

impl LinkSession {
    fn valid_at(&self, epoch: u64, now: Instant) -> bool {
        if self.epoch != epoch {
            return false;
        }
        let expires = if self.remember {
            self.created + LINK_REMEMBER
        } else {
            self.last_seen + LINK_SLIDING
        };
        now < expires
    }
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
    /// Per-link daily byte budgets keyed by uuid (survives disconnect + reconnect so a PC
    /// cannot launder a spent daily allowance by dropping and reconnecting).
    budgets: Mutex<HashMap<String, Arc<Mutex<DayBudget>>>>,
    /// The joint login's Hub-side sessions (§20.14): uuid → token hash → session. Nothing
    /// persisted — a Hub restart asks every browser for the password once more, which is
    /// the whole of what it costs.
    pub link_sessions: Mutex<HashMap<String, HashMap<String, LinkSession>>>,
    /// The operator's audit trail (§20.6 `audit_log`); a no-op when off.
    pub audit: Audit,
    /// The operator's kill switch (§20.6 `blocklist`); inert when off.
    pub blocklist: Blocklist,
    pub cache: crate::cache::AssetCache,
    /// `trusted_proxies` parsed once at start: the CIDR strings were re-parsed on every
    /// browser request and every tunnel handshake (`peer_ip`). Unparseable entries were
    /// silently ignored then and still are.
    pub trusted_nets: Vec<ipnet::IpNet>,
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
        let trusted_nets = config
            .trusted_proxies
            .iter()
            .filter_map(|cidr| cidr.parse::<ipnet::IpNet>().ok())
            .collect();
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
            budgets: Mutex::new(HashMap::new()),
            link_sessions: Mutex::new(HashMap::new()),
            audit,
            blocklist,
            cache,
            trusted_nets,
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
        // Session 0 is the browser-side spelling of "control" (§6.1); the counter wraps
        // eventually, and the wrap must not hand the reserved id out.
        let mut id = self.next_session.fetch_add(1, Ordering::Relaxed);
        if id == 0 {
            id = self.next_session.fetch_add(1, Ordering::Relaxed);
        }
        id
    }

    /// Build a tunnel handle bound to this Hub's writer and registration sequence.
    pub fn new_tunnel(&self, uuid: String, tx: mpsc::UnboundedSender<Vec<u8>>) -> Tunnel {
        // The day's remaining allowance is keyed by uuid on `Hub.budgets`, so BOTH a live
        // replacement AND a disconnect-then-reconnect keep the exact same daily budget.
        let budget = (self.config.bytes_per_day_per_tunnel > 0).then(|| {
            let today = today_number();
            let mut budgets = self.budgets.lock().unwrap();
            if budgets.len() > 1024 {
                budgets.retain(|_, b| b.lock().unwrap().day == today);
            }
            if let Some(existing) = budgets.get(&uuid) {
                existing.clone()
            } else {
                let fresh = Arc::new(Mutex::new(DayBudget {
                    day: today,
                    left: self.config.bytes_per_day_per_tunnel,
                }));
                if budgets.len() < MAX_WINDOW_ENTRIES {
                    budgets.insert(uuid.clone(), fresh.clone());
                }
                fresh
            }
        });
        Tunnel {
            uuid,
            id: self.next_tunnel.fetch_add(1, Ordering::Relaxed),
            tx,
            conns: Mutex::new(HashMap::new()),
            since: Instant::now(),
            budget,
            budget_cap: self.config.bytes_per_day_per_tunnel,
            killed: Notify::new(),
            credential: Mutex::new(None),
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

    /// Register a tunnel under the capacity ceiling with the check and the insert under
    /// ONE lock — the old check-then-register pair let two concurrent handshakes for
    /// different uuids each observe `count == max - 1` and both register, overshooting
    /// `max_tunnels`. A same-uuid replacement never counts against the ceiling. Answers
    /// `None` when refused at capacity; else the displaced tunnel, if any.
    pub fn register_within_limit(
        &self,
        uuid: String,
        tunnel: Arc<Tunnel>,
    ) -> Option<Option<Arc<Tunnel>>> {
        let mut tunnels = self.tunnels.lock().unwrap();
        if !tunnels.contains_key(&uuid) && tunnels.len() >= self.config.max_tunnels {
            return None;
        }
        let displaced = tunnels.insert(uuid, tunnel);
        if displaced.is_none() {
            self.counters.tunnels_total.fetch_add(1, Ordering::Relaxed);
        }
        Some(displaced)
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
    window: &Mutex<WindowTable<K>>,
    key: K,
    span: Duration,
) -> u32 {
    let now = Instant::now();
    let mut table = window.lock().unwrap();
    let due = table
        .last_prune
        .is_none_or(|at| now.duration_since(at) >= PRUNE_INTERVAL);
    if (table.map.len() > 1024 && due) || table.map.len() >= MAX_WINDOW_ENTRIES {
        table
            .map
            .retain(|_, (_, at)| now.duration_since(*at) < span);
        table.last_prune = Some(now);
    }
    if !table.map.contains_key(&key) && table.map.len() >= MAX_WINDOW_ENTRIES {
        if let Some(oldest) = table
            .map
            .iter()
            .min_by_key(|(_, (_, at))| *at)
            .map(|(k, _)| k.clone())
        {
            table.map.remove(&oldest);
        }
    }
    let entry = table.map.entry(key).or_insert((0, now));
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
        count(&self.ips.hellos, normalize_ip(ip), HELLO_WINDOW) <= self.config.handshake_rate
    }

    /// Issue the Hub-side half of a joint login (§20.14): a fresh 256-bit cookie token for
    /// one link, stamped with the credential epoch the password was verified under. Answers
    /// the cookie's clear value — the only time it exists — and its `Max-Age`.
    pub fn issue_link_session(
        &self,
        uuid: &str,
        epoch: u64,
        remember: bool,
        ip: IpAddr,
    ) -> (String, u64) {
        use base64::Engine;
        let raw = crate::util::random_bytes::<32>();
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
        let hash = token_hash(&token);
        let now = Instant::now();
        let mut links = self.link_sessions.lock().unwrap();
        let sessions = links.entry(uuid.to_owned()).or_default();
        sessions.retain(|_, session| session.valid_at(epoch, now));
        while sessions.len() >= LINK_SESSIONS_CAP {
            let oldest = sessions
                .iter()
                .min_by_key(|(_, session)| session.last_seen)
                .map(|(hash, _)| hash.clone());
            match oldest {
                Some(oldest) => {
                    sessions.remove(&oldest);
                }
                None => break,
            }
        }
        sessions.insert(
            hash,
            LinkSession {
                epoch,
                created: now,
                last_seen: now,
                remember,
                ip,
            },
        );
        // A dead link's table leaves with it — bounded by the ever-online links.
        if links.len() > 1024 {
            let live: std::collections::HashSet<String> =
                self.tunnels.lock().unwrap().keys().cloned().collect();
            links.retain(|uuid, sessions| live.contains(uuid) && !sessions.is_empty());
        }
        let max_age = if remember {
            LINK_REMEMBER.as_secs()
        } else {
            LINK_SLIDING.as_secs()
        };
        (token, max_age)
    }

    /// The gate's check (§20.14): the cookie names a still-valid login issued under the
    /// link's CURRENT credential epoch. A sliding session's `last_seen` moves with it.
    pub fn link_session_valid(&self, uuid: &str, token: &str, epoch: u64) -> bool {
        let hash = token_hash(token);
        let now = Instant::now();
        let mut links = self.link_sessions.lock().unwrap();
        let Some(session) = links.get_mut(uuid).and_then(|s| s.get_mut(&hash)) else {
            return false;
        };
        if !session.valid_at(epoch, now) {
            return false;
        }
        session.last_seen = now;
        true
    }

    /// The password changed on the PC (a new `T_CREDENTIAL` epoch): every login the Hub
    /// issued under the old verifier ends, exactly as the daemon ends its own sessions.
    pub fn drop_link_sessions(&self, uuid: &str) {
        if let Some(sessions) = self.link_sessions.lock().unwrap().get_mut(uuid) {
            sessions.clear();
        }
    }

    /// Sign out one Hub-side session immediately on `POST api/logout`.
    pub fn revoke_link_session(&self, uuid: &str, token: &str) {
        let hash = token_hash(token);
        if let Some(sessions) = self.link_sessions.lock().unwrap().get_mut(uuid) {
            sessions.remove(&hash);
        }
    }
}

/// hex(SHA-256(token)) — the stored form of a link-session cookie, so a Hub memory dump
/// holds no usable credentials (the same rule the daemon's sessions follow, §7.6).
fn token_hash(token: &str) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(token.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

impl Hub {
    pub fn login_entry(&self, ip: IpAddr, uuid: &str) -> bool {
        count(
            &self.ips.logins,
            (normalize_ip(ip), uuid.to_owned()),
            LOGIN_WINDOW,
        ) <= LOGIN_MAX
    }

    /// Every proxied request toward an online link one IP may make per minute (§20.6
    /// `http_rate`) — the guard a single address hammering one PC's pages otherwise lacks
    /// (the session ceiling caps concurrency, not rate). 0 = unlimited.
    pub fn request_allowed(&self, ip: IpAddr) -> bool {
        if self.config.http_rate == 0 {
            return true;
        }
        count(&self.ips.requests, normalize_ip(ip), REQUEST_WINDOW) <= self.config.http_rate
    }

    /// Count one browser IP against a link's daily distinct-viewer ceiling (§20.6
    /// `visitors_per_day_per_tunnel`): an IP already seen costs nothing, a new one past the
    /// cap is refused. Keyed by uuid so a reconnecting PC cannot reset its own count.
    pub fn admit_visitor(&self, uuid: &str, ip: IpAddr) -> bool {
        let cap = self.config.visitors_per_day_per_tunnel;
        if cap == 0 {
            return true;
        }
        let ip = normalize_ip(ip);
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
        let key = normalize_ip(ip);
        if self.is_banned(key) {
            return false;
        }
        if count(&self.ips.offline, key, OFFLINE_WINDOW) > OFFLINE_MAX {
            let now = Instant::now();
            let mut banned = self.ips.banned.lock().unwrap();
            if banned.len() >= MAX_WINDOW_ENTRIES {
                banned.retain(|_, until| now.duration_since(*until) < BAN);
                if banned.len() >= MAX_WINDOW_ENTRIES {
                    if let Some(oldest) = banned.iter().min_by_key(|(_, at)| **at).map(|(k, _)| *k)
                    {
                        banned.remove(&oldest);
                    }
                }
            }
            banned.insert(key, now);
            crate::warn!("{ip} probed too many offline links: held off for 10 minutes");
            return false;
        }
        true
    }

    pub fn is_banned(&self, ip: IpAddr) -> bool {
        let key = normalize_ip(ip);
        let now = Instant::now();
        let mut banned = self.ips.banned.lock().unwrap();
        if let Some(&since) = banned.get(&key) {
            if now.duration_since(since) < BAN {
                return true;
            }
            banned.remove(&key);
        }
        false
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
    fn the_daily_budget_spends_and_refills_on_a_new_day() {
        let hub = Hub::new(Config {
            bytes_per_day_per_tunnel: 100,
            ..Config::default()
        });
        let (tx, _rx) = mpsc::unbounded_channel();
        let t = Arc::new(hub.new_tunnel("u".into(), tx));
        assert!(t.spend_on_day(20_000, 60));
        assert!(t.spend_on_day(20_000, 40));
        assert!(!t.spend_on_day(20_000, 1), "the day's allowance is spent");
        // A refused spend deducts nothing; a new UTC day refills to the configured amount.
        assert!(!t.spend_on_day(20_000, 100));
        assert!(t.spend_on_day(20_001, 100));
        assert!(!t.spend_on_day(20_001, 1));
    }

    #[test]
    fn a_tunnel_without_a_budget_spends_freely() {
        let hub = hub();
        let (tx, _rx) = mpsc::unbounded_channel();
        let t = hub.new_tunnel("u".into(), tx);
        assert!(t.spend(u64::MAX / 2));
        assert!(t.spend(u64::MAX / 2));
    }

    #[test]
    fn a_reconnect_inherits_the_days_spent_budget() {
        // `new_tunnel` runs while the old tunnel is still registered (the swap happens
        // right after), so the replacement sees the link's remaining allowance — a
        // daemon reconnecting on a spent day must not draw a fresh one.
        let hub = Hub::new(Config {
            bytes_per_day_per_tunnel: 100,
            ..Config::default()
        });
        let (tx_a, _rx_a) = mpsc::unbounded_channel();
        let a = Arc::new(hub.new_tunnel("u".into(), tx_a));
        assert!(hub.register("u".into(), a.clone()).is_none());
        assert!(a.spend_on_day(20_000, 90));
        let (tx_b, _rx_b) = mpsc::unbounded_channel();
        let b = hub.new_tunnel("u".into(), tx_b);
        assert!(b.spend_on_day(20_000, 10), "the day's remainder carried");
        assert!(
            !b.spend_on_day(20_000, 1),
            "a reconnect cannot launder a spent daily budget"
        );
        // A brand-new link still starts the day full.
        let (tx_c, _rx_c) = mpsc::unbounded_channel();
        let c = hub.new_tunnel("fresh".into(), tx_c);
        assert!(c.spend_on_day(20_000, 100));
    }

    #[test]
    fn disconnect_then_reconnect_cannot_reset_daily_budget() {
        let hub = Hub::new(Config {
            bytes_per_day_per_tunnel: 100,
            ..Config::default()
        });
        let (tx_a, _rx_a) = mpsc::unbounded_channel();
        let a = Arc::new(hub.new_tunnel("u".into(), tx_a));
        hub.register("u".into(), a.clone());
        assert!(a.spend_on_day(20_000, 100));
        // Clean disconnect removes the tunnel from `tunnels` before reconnect.
        hub.unregister("u", a.id);
        assert!(hub.tunnel("u").is_none());
        let (tx_b, _rx_b) = mpsc::unbounded_channel();
        let b = hub.new_tunnel("u".into(), tx_b);
        assert!(
            !b.spend_on_day(20_000, 1),
            "disconnecting and reconnecting must not reset a spent daily budget"
        );
    }

    #[test]
    fn revoke_link_session_invalidates_cookie_server_side() {
        let hub = hub();
        let ip: IpAddr = "203.0.113.5".parse().unwrap();
        let (token, _) = hub.issue_link_session("u", 1, true, ip);
        assert!(hub.link_session_valid("u", &token, 1));
        hub.revoke_link_session("u", &token);
        assert!(!hub.link_session_valid("u", &token, 1));
    }

    #[test]
    fn ipv6_addresses_in_same_slash_64_share_rate_limits() {
        let hub = Hub::new(Config {
            handshake_rate: 2,
            ..Config::default()
        });
        let a: IpAddr = "2001:db8:1:2::1".parse().unwrap();
        let b: IpAddr = "2001:db8:1:2::2".parse().unwrap();
        let c: IpAddr = "2001:db8:1:2::3".parse().unwrap();
        assert!(hub.hello_allowed(a));
        assert!(hub.hello_allowed(b));
        assert!(!hub.hello_allowed(c));
    }

    #[test]
    fn registration_is_refused_atomically_at_the_ceiling() {
        let hub = Hub::new(Config {
            max_tunnels: 1,
            ..Config::default()
        });
        let (tx_a, _rx_a) = mpsc::unbounded_channel();
        let (tx_b, _rx_b) = mpsc::unbounded_channel();
        let (tx_c, _rx_c) = mpsc::unbounded_channel();
        let a = Arc::new(hub.new_tunnel("a".into(), tx_a));
        let b = Arc::new(hub.new_tunnel("b".into(), tx_b));
        let c = Arc::new(hub.new_tunnel("c".into(), tx_c));
        assert!(hub.register_within_limit("a".into(), a).is_some());
        // The second distinct PC is refused — one lock holds the check and the insert, so
        // a concurrent pair cannot each pass the other's count.
        assert!(hub.register_within_limit("b".into(), b).is_none());
        assert_eq!(hub.tunnel_count(), 1);
        // A same-uuid replacement never counts against the ceiling.
        let displaced = hub.register_within_limit("a".into(), c).unwrap().unwrap();
        assert_eq!(hub.tunnel_count(), 1);
        assert_eq!(displaced.uuid, "a");
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
    fn a_session_slot_reserve_is_atomic_against_the_ceiling() {
        let hub = hub();
        let (tx, _rx) = mpsc::unbounded_channel();
        let t = Arc::new(hub.new_tunnel("u".into(), tx));
        let (tx1, _rx1) = mpsc::unbounded_channel();
        let (tx2, _rx2) = mpsc::unbounded_channel();
        // Ceiling one: the first reserve takes the slot, the second is refused — the check
        // and the insert are one critical section, so a concurrent burst cannot overshoot.
        assert!(t.reserve_conn(1, 1, tx1));
        assert!(!t.reserve_conn(1, 2, tx2));
        assert_eq!(t.sessions(), 1);
        t.conns.lock().unwrap().remove(&1);
        let (tx3, _rx3) = mpsc::unbounded_channel();
        assert!(t.reserve_conn(1, 3, tx3));
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
