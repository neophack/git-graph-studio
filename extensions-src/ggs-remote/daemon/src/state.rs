//! The daemon's shared state: one `Arc<Daemon>` every listener, connection and background
//! task holds. Locks are std mutexes held for a few field updates at a time — the runtime is
//! current-thread (§4.1), so nothing contends across threads except the tray.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, watch, Notify};

use crate::auth::Auth;
use crate::config::Config;
use crate::paths::Paths;
use crate::ratelimit::RateLimiter;
use crate::registry::Registry;
use crate::session::{Session, Sessions};
use crate::util::{b64, now_secs, token};
use crate::ws::conn::Conn;

/// A forced disconnect: one session (`token_hash`) or everyone (`None`).
#[derive(Debug, Clone)]
pub struct Kick {
    pub token_hash: Option<String>,
    pub code: u16,
    pub reason: String,
}

/// What the tray shows (§7.9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrayState {
    Stopped,
    Listening,
    Active(u32),
    Error(String),
}

/// Short-lived one-time secrets: pair-page tickets, unlock tokens, download tickets.
#[derive(Default)]
pub struct Tickets {
    pair: HashMap<String, Instant>,
    unlock: HashMap<String, Instant>,
    download: HashMap<String, (Instant, DownloadTicket)>,
}

#[derive(Debug, Clone)]
pub struct DownloadTicket {
    pub token_hash: String,
    pub instance: String,
    pub path: String,
    pub zip: bool,
    /// The multi-select pack (docs/remote-client-plan.md §6.7): two or more paths zipped
    /// into one archive. Empty for the single-path form.
    pub paths: Vec<String>,
}

pub const PAIR_TICKET_TTL: Duration = Duration::from_secs(300);
pub const UNLOCK_TTL: Duration = Duration::from_secs(300);
pub const DOWNLOAD_TTL: Duration = Duration::from_secs(60);

impl Tickets {
    pub fn issue_pair(&mut self) -> String {
        let t = token(24);
        self.pair
            .insert(t.clone(), Instant::now() + PAIR_TICKET_TTL);
        t
    }

    /// A pair ticket opens the pair page; it stays usable for its whole lifetime (the page
    /// posts the unlock with it), never longer.
    pub fn check_pair(&mut self, t: &str) -> bool {
        let now = Instant::now();
        self.pair.retain(|_, until| *until > now);
        self.pair.contains_key(t)
    }

    pub fn issue_unlock(&mut self) -> String {
        let t = token(24);
        self.unlock.insert(t.clone(), Instant::now() + UNLOCK_TTL);
        t
    }

    pub fn check_unlock(&mut self, t: &str) -> bool {
        let now = Instant::now();
        self.unlock.retain(|_, until| *until > now);
        self.unlock.contains_key(t)
    }

    pub fn issue_download(&mut self, ticket: DownloadTicket) -> String {
        let t = token(24);
        self.download
            .insert(t.clone(), (Instant::now() + DOWNLOAD_TTL, ticket));
        t
    }

    /// One use only.
    pub fn take_download(&mut self, t: &str) -> Option<DownloadTicket> {
        let now = Instant::now();
        self.download.retain(|_, (until, _)| *until > now);
        self.download.remove(t).map(|(_, ticket)| ticket)
    }

    pub fn clear_unlocks(&mut self) {
        self.unlock.clear();
    }
}

pub struct Daemon {
    pub paths: Paths,
    pub config: Mutex<Config>,
    pub auth: Auth,
    pub sessions: Mutex<Sessions>,
    pub limiter: Mutex<RateLimiter>,
    pub registry: Registry,
    pub conns: Mutex<HashMap<u32, Arc<Conn>>>,
    next_conn: AtomicU32,
    pub tickets: Mutex<Tickets>,
    /// The recently opened folders (the picker's "recent paths" list), persisted as
    /// `recent.json` under the root.
    pub recent: Mutex<crate::recent::Recent>,
    /// Resource tokens of the `ggs` file paths (§12.2): token → (session hash, instance).
    pub resource_tokens: Mutex<HashMap<String, (String, String)>>,
    /// One-shot registration tokens issued to sandboxed spawns (§23): consumed by the
    /// Register that presents them, and expired by `sandbox::TOKEN_TTL`.
    pub sandbox_tokens: Mutex<HashMap<String, std::time::Instant>>,
    pub kicks: broadcast::Sender<Kick>,
    pub tray: watch::Sender<TrayState>,
    pub admin_token: String,
    /// The HMAC key behind resource tokens; regenerated at every start.
    pub secret: [u8; 32],
    pub loopback_port: AtomicU16,
    pub public_port: AtomicU16,
    pub listening: AtomicBool,
    /// Set once the server half has shut down: the tray loop exits on it.
    pub stopped: AtomicBool,
    pub last_foreign: AtomicU64,
    pub started: Instant,
    pub shutdown: Notify,
    pub rebind: Notify,
    pub relay_url_base: Mutex<String>,
    pub ca_fingerprint: Mutex<String>,
    pub cache: crate::cache::AssetCache,
    /// The outbound Hub tunnel client (§20): unconfigured unless hub.json says otherwise.
    pub hub: std::sync::Arc<crate::hub::HubClient>,
}

impl Daemon {
    pub fn new(paths: Paths, config: Config) -> std::io::Result<Arc<Daemon>> {
        paths.ensure()?;
        let admin_token = match std::fs::read_to_string(paths.admin_token()) {
            Ok(t) if t.trim().len() >= 32 => t.trim().to_owned(),
            _ => {
                let t = token(32);
                crate::paths::write_private(&paths.admin_token(), t.as_bytes())?;
                t
            }
        };
        let auth = Auth::load(&paths);
        let sessions = Sessions::load(&paths);
        Ok(Arc::new(Daemon {
            config: Mutex::new(config),
            auth,
            sessions: Mutex::new(sessions),
            limiter: Mutex::new(RateLimiter::default()),
            registry: Registry::default(),
            conns: Mutex::new(HashMap::new()),
            next_conn: AtomicU32::new(1),
            tickets: Mutex::new(Tickets::default()),
            recent: Mutex::new(crate::recent::Recent::load(&paths)),
            sandbox_tokens: Mutex::new(HashMap::new()),
            resource_tokens: Mutex::new(HashMap::new()),
            kicks: broadcast::channel(64).0,
            tray: watch::channel(TrayState::Stopped).0,
            admin_token,
            secret: crate::util::random_bytes::<32>(),
            loopback_port: AtomicU16::new(0),
            public_port: AtomicU16::new(0),
            listening: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            last_foreign: AtomicU64::new(0),
            started: Instant::now(),
            shutdown: Notify::new(),
            rebind: Notify::new(),
            relay_url_base: Mutex::new(String::new()),
            ca_fingerprint: Mutex::new(String::new()),
            cache: crate::cache::AssetCache::new(Some(paths.cache_dir())),
            hub: std::sync::Arc::new(crate::hub::HubClient::new(paths.clone())),
            paths,
        }))
    }

    pub fn config(&self) -> Config {
        self.config.lock().unwrap().clone()
    }

    /// The session a cookie token names, if it is valid under the current epoch.
    pub fn session_for(&self, token: &str) -> Option<Session> {
        let epoch = self.auth.epoch();
        self.sessions.lock().unwrap().touch(token, epoch)
    }

    pub fn session_valid(&self, token_hash: &str) -> bool {
        let epoch = self.auth.epoch();
        self.sessions.lock().unwrap().still_valid(token_hash, epoch)
    }

    pub fn csrf_of(&self, token_hash: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap()
            .by_hash(token_hash)
            .map(|s| s.csrf.clone())
    }

    pub fn new_conn(
        &self,
        sid: String,
        token_hash: String,
        base_path: String,
        ip: IpAddr,
    ) -> Arc<Conn> {
        let id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        let conn = Arc::new(Conn::new(id, sid, token_hash, base_path, ip));
        self.conns.lock().unwrap().insert(id, conn.clone());
        conn
    }

    pub fn conn(&self, id: u32) -> Option<Arc<Conn>> {
        self.conns.lock().unwrap().get(&id).cloned()
    }

    pub fn conn_by_sid(&self, sid: &str, token_hash: &str) -> Option<Arc<Conn>> {
        self.conns
            .lock()
            .unwrap()
            .values()
            .find(|c| c.sid == sid && c.token_hash == token_hash)
            .cloned()
    }

    pub fn live_conn_count(&self) -> u32 {
        self.conns
            .lock()
            .unwrap()
            .values()
            .filter(|c| c.is_live())
            .count() as u32
    }

    /// The password changed or every device was signed out: clear sessions, rotate resource
    /// tokens and kick every connection with 4401 (R9).
    pub fn credentials_changed(&self, reason: &str) {
        self.sessions.lock().unwrap().clear();
        self.resource_tokens.lock().unwrap().clear();
        self.tickets.lock().unwrap().clear_unlocks();
        let _ = self.kicks.send(Kick {
            token_hash: None,
            code: crate::ws::msg::code::CREDENTIALS,
            reason: reason.to_owned(),
        });
        crate::info!("credentials changed ({reason}): every session ended");
    }

    /// Sign one device out.
    pub fn revoke(&self, token_hash: &str) {
        self.sessions.lock().unwrap().remove_by_hash(token_hash);
        self.resource_tokens
            .lock()
            .unwrap()
            .retain(|_, (hash, _)| hash != token_hash);
        let _ = self.kicks.send(Kick {
            token_hash: Some(token_hash.to_owned()),
            code: crate::ws::msg::code::CREDENTIALS,
            reason: "revoked".into(),
        });
        crate::info!("device signed out");
    }

    /// The resource token for a session's view of an instance's package files (§12.2):
    /// base64url(HMAC-SHA256(secret, session ‖ instance ‖ epoch))[..22].
    pub fn resource_token(&self, token_hash: &str, instance: &str) -> String {
        use hmac::{Hmac, Mac};
        let mut mac = Hmac::<sha2::Sha256>::new_from_slice(&self.secret).expect("any key length");
        mac.update(token_hash.as_bytes());
        mac.update(b"\0");
        mac.update(instance.as_bytes());
        mac.update(b"\0");
        mac.update(&self.auth.epoch().to_le_bytes());
        let tok: String = b64(&mac.finalize().into_bytes()).chars().take(22).collect();
        self.resource_tokens
            .lock()
            .unwrap()
            .insert(tok.clone(), (token_hash.to_owned(), instance.to_owned()));
        tok
    }

    /// Validate a resource token for an instance; answers whether its session is alive.
    pub fn check_resource_token(&self, tok: &str, instance: &str) -> bool {
        let entry = self.resource_tokens.lock().unwrap().get(tok).cloned();
        match entry {
            Some((hash, inst)) => inst == instance && self.session_valid(&hash),
            None => false,
        }
    }

    pub fn note_foreign(&self, ip: IpAddr) {
        if !ip.is_loopback() {
            self.last_foreign.store(now_secs(), Ordering::Relaxed);
        }
    }

    pub fn update_tray(&self) {
        let next = if !self.listening.load(Ordering::Relaxed) {
            self.tray.borrow().clone()
        } else {
            match self.live_conn_count() {
                0 => TrayState::Listening,
                n => TrayState::Active(n),
            }
        };
        self.tray.send_if_modified(|state| {
            if matches!(state, TrayState::Error(_))
                && next == TrayState::Listening
                && !self.listening.load(Ordering::Relaxed)
            {
                return false;
            }
            if *state != next {
                *state = next;
                true
            } else {
                false
            }
        });
    }
}
