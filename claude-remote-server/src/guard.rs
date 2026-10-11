//! Per-address throttles: failed proofs lock an address out for a minute, and registration
//! is rate-limited so an open relay cannot be filled from one host. In-memory only — a
//! restart forgives, which is the right side to err on for a relay.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    /// a wrong HMAC proof (window or phone)
    Auth,
    /// a PC registration
    Register,
}

impl Kind {
    fn window(self) -> Duration {
        match self {
            Kind::Auth => Duration::from_secs(60),
            Kind::Register => Duration::from_secs(3600),
        }
    }
    fn limit(self) -> usize {
        match self {
            Kind::Auth => 10,
            Kind::Register => 20,
        }
    }
    fn lockout(self) -> Duration {
        match self {
            Kind::Auth => Duration::from_secs(60),
            Kind::Register => Duration::from_secs(3600),
        }
    }
}

#[derive(Default)]
struct Bucket {
    hits: Vec<Instant>,
    locked_until: Option<Instant>,
}

#[derive(Default)]
pub struct Guard {
    buckets: Mutex<HashMap<(IpAddr, Kind), Bucket>>,
}

impl Guard {
    pub fn locked(&self, ip: IpAddr, kind: Kind) -> bool {
        let buckets = self.buckets.lock().unwrap();
        buckets
            .get(&(ip, kind))
            .and_then(|b| b.locked_until)
            .is_some_and(|until| until > Instant::now())
    }

    /// How much of the lockout remains, so a 429 can carry an honest Retry-After
    /// instead of a guess (a phone that honors it stops hammering the handshake).
    pub fn locked_remaining(&self, ip: IpAddr, kind: Kind) -> Option<Duration> {
        let buckets = self.buckets.lock().unwrap();
        buckets
            .get(&(ip, kind))
            .and_then(|b| b.locked_until)
            .filter(|until| *until > Instant::now())
            .map(|until| until.saturating_duration_since(Instant::now()))
    }

    /// Count one event; `true` when this event tipped the address into a lockout.
    pub fn hit(&self, ip: IpAddr, kind: Kind) -> bool {
        let now = Instant::now();
        let mut buckets = self.buckets.lock().unwrap();
        if buckets.len() > 50_000 {
            buckets.retain(|_, b| b.locked_until.is_some_and(|u| u > now) || b.hits.iter().any(|t| now - *t < Duration::from_secs(3600)));
        }
        let bucket = buckets.entry((ip, kind)).or_default();
        bucket.hits.retain(|t| now - *t < kind.window());
        bucket.hits.push(now);
        if bucket.hits.len() >= kind.limit() {
            bucket.hits.clear();
            bucket.locked_until = Some(now + kind.lockout());
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ten_failures_lock_the_address_and_only_that_address() {
        let guard = Guard::default();
        let a: IpAddr = "10.0.0.1".parse().unwrap();
        let b: IpAddr = "10.0.0.2".parse().unwrap();
        for _ in 0..9 {
            assert!(!guard.hit(a, Kind::Auth));
        }
        assert!(!guard.locked(a, Kind::Auth));
        assert!(guard.hit(a, Kind::Auth));
        assert!(guard.locked(a, Kind::Auth));
        assert!(!guard.locked(b, Kind::Auth));
        assert!(!guard.locked(a, Kind::Register));
    }
}
