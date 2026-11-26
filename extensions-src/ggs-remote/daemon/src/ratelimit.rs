//! Password-guess throttling (docs/ggs-remote-plan.md §7.6): per IP, the 5th failure locks the
//! address for 60 s × 2^(n−5), capped at an hour; across all addresses, 30 failures within a
//! minute delay every login attempt by 2 s. A success clears its address. Memory only.

use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

const FREE_FAILURES: u32 = 4;
const BASE_LOCK: Duration = Duration::from_secs(60);
const MAX_LOCK: Duration = Duration::from_secs(3600);
const GLOBAL_WINDOW: Duration = Duration::from_secs(60);
const GLOBAL_LIMIT: usize = 30;
pub const GLOBAL_DELAY: Duration = Duration::from_secs(2);
const MAX_TRACKED_IPS: usize = 16_384;
const MAX_RECENT: usize = 1024;

/// Normalize an IP address for rate-limiting: IPv4 stays /32, IPv6 is masked to its /64
/// prefix so rotating host addresses inside one subnet cannot bypass per-IP lockouts.
fn bucket_ip(ip: IpAddr) -> IpAddr {
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

struct Entry {
    failures: u32,
    locked_until: Option<Instant>,
    last: Instant,
}

#[derive(Default)]
pub struct RateLimiter {
    by_ip: HashMap<IpAddr, Entry>,
    recent: Vec<Instant>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    /// Allowed, but only after the global slow-down delay.
    Delay(Duration),
    /// Locked out for this long.
    Locked(Duration),
}

impl RateLimiter {
    pub fn check(&mut self, ip: IpAddr, now: Instant) -> Verdict {
        let key = bucket_ip(ip);
        self.recent
            .retain(|t| now.duration_since(*t) < GLOBAL_WINDOW);
        if let Some(until) = self.by_ip.get(&key).and_then(|e| e.locked_until) {
            if until > now {
                return Verdict::Locked(until - now);
            }
        }
        if self.recent.len() >= GLOBAL_LIMIT {
            return Verdict::Delay(GLOBAL_DELAY);
        }
        Verdict::Allow
    }

    pub fn failure(&mut self, ip: IpAddr, now: Instant) -> Option<Duration> {
        let key = bucket_ip(ip);
        self.recent
            .retain(|t| now.duration_since(*t) < GLOBAL_WINDOW);
        if self.recent.len() < MAX_RECENT {
            self.recent.push(now);
        }
        if !self.by_ip.contains_key(&key) && self.by_ip.len() >= MAX_TRACKED_IPS {
            self.prune(now);
            if self.by_ip.len() >= MAX_TRACKED_IPS {
                if let Some(oldest) = self
                    .by_ip
                    .iter()
                    .min_by_key(|(_, e)| e.last)
                    .map(|(k, _)| *k)
                {
                    self.by_ip.remove(&oldest);
                }
            }
        }
        let entry = self.by_ip.entry(key).or_insert(Entry {
            failures: 0,
            locked_until: None,
            last: now,
        });
        entry.failures += 1;
        entry.last = now;
        if entry.failures > FREE_FAILURES {
            let exponent = (entry.failures - FREE_FAILURES - 1).min(10);
            let lock = (BASE_LOCK * 2u32.pow(exponent)).min(MAX_LOCK);
            entry.locked_until = Some(now + lock);
            return Some(lock);
        }
        None
    }

    pub fn success(&mut self, ip: IpAddr) {
        self.by_ip.remove(&bucket_ip(ip));
    }

    /// Forget entries whose lock expired long ago (called from the housekeeping tick).
    pub fn prune(&mut self, now: Instant) {
        self.recent
            .retain(|t| now.duration_since(*t) < GLOBAL_WINDOW);
        self.by_ip.retain(|_, e| {
            e.locked_until.is_some_and(|until| until > now) || now.duration_since(e.last) < MAX_LOCK
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locks_from_the_fifth_failure_and_doubles() {
        let mut limiter = RateLimiter::default();
        let ip: IpAddr = "10.0.0.9".parse().unwrap();
        let t0 = Instant::now();
        for _ in 0..4 {
            assert_eq!(limiter.check(ip, t0), Verdict::Allow);
            assert_eq!(limiter.failure(ip, t0), None);
        }
        assert_eq!(limiter.failure(ip, t0), Some(Duration::from_secs(60)));
        assert!(matches!(limiter.check(ip, t0), Verdict::Locked(_)));
        assert_eq!(
            limiter.check(ip, t0 + Duration::from_secs(61)),
            Verdict::Allow
        );
        assert_eq!(
            limiter.failure(ip, t0 + Duration::from_secs(61)),
            Some(Duration::from_secs(120))
        );
        // A different address is unaffected; a success clears the address.
        let other: IpAddr = "10.0.0.10".parse().unwrap();
        assert_eq!(limiter.check(other, t0), Verdict::Allow);
        limiter.success(ip);
        assert_eq!(
            limiter.check(ip, t0 + Duration::from_secs(62)),
            Verdict::Allow
        );
    }

    #[test]
    fn caps_at_an_hour() {
        let mut limiter = RateLimiter::default();
        let ip: IpAddr = "10.0.0.9".parse().unwrap();
        let t0 = Instant::now();
        let mut last = None;
        for _ in 0..20 {
            last = limiter.failure(ip, t0);
        }
        assert_eq!(last, Some(MAX_LOCK));
    }

    #[test]
    fn global_slowdown() {
        let mut limiter = RateLimiter::default();
        let t0 = Instant::now();
        for i in 0..30u8 {
            limiter.failure(IpAddr::from([10, 1, 0, i]), t0);
        }
        let fresh: IpAddr = "10.9.9.9".parse().unwrap();
        assert_eq!(limiter.check(fresh, t0), Verdict::Delay(GLOBAL_DELAY));
        assert_eq!(limiter.check(fresh, t0 + GLOBAL_WINDOW), Verdict::Allow);
    }
}
