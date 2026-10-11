//! The cross-PC asset cache (docs/ggs-remote-plan.md §20.6): only the workbench's own
//! immutable build artifacts — every PC ships the same bytes for `/w/<inst>/v/<ver>/…` — so
//! the Hub may answer them for any tunnel. API answers, plugin files and downloads are never
//! cached: each request for those rides its own tunnel session. Bounded, in-memory, LRU.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::msg::HttpRes;

#[derive(Clone)]
pub struct Entry {
    pub head: HttpRes,
    pub body: Vec<u8>,
}

#[derive(Default)]
pub struct AssetCache {
    inner: Mutex<Inner>,
    cap_bytes: usize,
}

#[derive(Default)]
struct Inner {
    // key → (bytes, last-use ticket); the ticket climbs monotonically.
    entries: HashMap<String, (Entry, u64, usize)>,
    clock: u64,
    bytes: usize,
}

impl AssetCache {
    pub fn new(cap_bytes: usize) -> AssetCache {
        AssetCache {
            inner: Mutex::new(Inner::default()),
            cap_bytes,
        }
    }

    pub fn get(&self, key: &str) -> Option<Entry> {
        let mut inner = self.inner.lock().unwrap();
        inner.clock += 1;
        let clock = inner.clock;
        let entry = inner.entries.get_mut(key)?;
        entry.1 = clock;
        Some(entry.0.clone())
    }

    pub fn store(&self, key: String, head: &HttpRes, body: Vec<u8>) {
        let mut inner = self.inner.lock().unwrap();
        inner.clock += 1;
        let clock = inner.clock;
        let size = body.len();
        if let Some((_, _, old)) = inner.entries.remove(&key) {
            inner.bytes -= old;
        }
        while inner.bytes + size > self.cap_bytes && !inner.entries.is_empty() {
            match inner
                .entries
                .iter()
                .min_by_key(|(_, (_, used, _))| *used)
                .map(|(key, _)| key.clone())
            {
                Some(oldest) => {
                    if let Some((_, _, old)) = inner.entries.remove(&oldest) {
                        inner.bytes -= old;
                    }
                }
                None => break,
            }
        }
        if size <= self.cap_bytes {
            inner.bytes += size;
            inner.entries.insert(
                key,
                (
                    Entry {
                        head: head.clone(),
                        body,
                    },
                    clock,
                    size,
                ),
            );
        }
    }

    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head() -> HttpRes {
        HttpRes {
            status: 200,
            headers: vec![("content-type".into(), "application/javascript".into())],
        }
    }

    #[test]
    fn keeps_the_latest_and_evicts_the_oldest() {
        let cache = AssetCache::new(130);
        cache.store("a".into(), &head(), vec![b'a'; 60]);
        cache.store("b".into(), &head(), vec![b'b'; 60]);
        assert!(cache.get("a").is_some()); // refreshed: b is now the oldest
        cache.store("c".into(), &head(), vec![b'c'; 60]);
        assert!(cache.get("b").is_none());
        assert!(cache.get("a").is_some());
        assert!(cache.get("c").is_some());
    }

    #[test]
    fn an_entry_larger_than_the_whole_cache_is_not_kept() {
        let cache = AssetCache::new(10);
        cache.store("big".into(), &head(), vec![0; 40]);
        assert!(cache.is_empty());
    }
}
