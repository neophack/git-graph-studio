//! The asset cache (docs/ggs-remote-plan.md §10.2): the remote workbench's files, fetched
//! once from an instance over the control channel, compressed with brotli and kept — the
//! most recent 16 MB in memory, everything (up to 64 MB) on disk under `cache/`. Keys carry
//! the instance version, so two versions of GGS on one PC never mix.

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

pub const MEMORY_BYTES: usize = 16 << 20;
pub const DISK_BYTES: u64 = 64 << 20;

#[derive(Clone, Debug)]
pub struct Entry {
    pub content_type: String,
    pub etag: String,
    /// The stored body: brotli when `br`, else identity (already-compressed formats).
    pub body: Vec<u8>,
    pub br: bool,
}

impl Entry {
    fn meta_line(&self) -> String {
        format!(
            "{}\n{}\n{}\n",
            self.content_type,
            self.etag,
            if self.br { "br" } else { "identity" }
        )
    }
}

pub struct AssetCache {
    memory: Mutex<Memory>,
    dir: Option<PathBuf>,
}

#[derive(Default)]
struct Memory {
    map: HashMap<String, Entry>,
    order: VecDeque<String>,
    bytes: usize,
}

pub fn brotli(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() / 3 + 64);
    {
        let mut writer = brotli::CompressorWriter::new(&mut out, 4096, 9, 22);
        let _ = writer.write_all(data);
    }
    out
}

pub fn unbrotli(data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut reader = brotli::Decompressor::new(data, 4096);
    // A stream that fails to inflate answers None — the caller treats it as a corrupt
    // entry and evicts it, instead of serving the silently partial prefix under a 200
    // (immutable assets carry a year-long max-age; the browser would keep the broken
    // bytes).
    std::io::Read::read_to_end(&mut reader, &mut out)
        .ok()
        .map(|_| out)
}

/// Whether a content type is worth compressing.
pub fn compressible(content_type: &str) -> bool {
    content_type.starts_with("text/")
        || content_type.contains("javascript")
        || content_type.contains("json")
        || content_type.contains("svg")
        || content_type.contains("xml")
        || content_type.contains("wasm")
}

impl AssetCache {
    pub fn new(dir: Option<PathBuf>) -> AssetCache {
        AssetCache {
            memory: Mutex::new(Memory::default()),
            dir,
        }
    }

    fn disk_path(&self, key: &str) -> Option<PathBuf> {
        let name = crate::util::hex(&crate::util::sha256(key.as_bytes()));
        self.dir.as_ref().map(|d| d.join(format!("{name}.bin")))
    }

    /// The memory layer alone — the cheap half every async fetch answers inline.
    fn get_memory(&self, key: &str) -> Option<Entry> {
        let mut memory = self.memory.lock().unwrap();
        let entry = memory.map.get(key).cloned()?;
        memory.order.retain(|k| k != key);
        memory.order.push_back(key.to_owned());
        Some(entry)
    }

    pub fn get(&self, key: &str) -> Option<Entry> {
        if let Some(entry) = self.get_memory(key) {
            return Some(entry);
        }
        let path = self.disk_path(key)?;
        let bytes = std::fs::read(&path).ok()?;
        let entry = parse_disk(&bytes)?;
        self.remember(key, entry.clone());
        Some(entry)
    }

    /// The async door the HTTP handlers use (2026-10-16): the memory layer answers inline;
    /// the disk half — a read of up to 64 MB — runs on the blocking pool. The daemon's
    /// runtime is single-threaded (§4.1), and an inline disk read once froze every
    /// listener, WebSocket and the tray for its duration.
    pub async fn fetch(&self, key: &str) -> Option<Entry> {
        if let Some(entry) = self.get_memory(key) {
            return Some(entry);
        }
        let dir = self.dir.clone();
        let pool_key = key.to_owned();
        let entry = tokio::task::spawn_blocking(move || {
            let name = crate::util::hex(&crate::util::sha256(pool_key.as_bytes()));
            let path = dir.as_ref().map(|d| d.join(format!("{name}.bin")));
            let bytes = std::fs::read(path?).ok()?;
            parse_disk(&bytes)
        })
        .await
        .ok()
        .flatten();
        if let Some(entry) = &entry {
            self.remember(key, entry.clone());
        }
        entry
    }

    pub fn put(&self, key: &str, entry: Entry) {
        if write_disk(self.dir.as_deref(), key, &entry) {
            self.trim_disk();
        }
        self.remember(key, entry);
    }

    /// The async store (2026-10-16): the disk write and the trim walk — whole-body writes
    /// of multi-megabyte assets — belong on the blocking pool, not the one JS-thread-shaped
    /// runtime every listener shares.
    pub async fn store(&self, key: &str, entry: Entry) {
        let dir = self.dir.clone();
        let pool_key = key.to_owned();
        let disk_entry = entry.clone();
        let _written = tokio::task::spawn_blocking(move || {
            if !write_disk(dir.as_deref(), &pool_key, &disk_entry) {
                return false;
            }
            trim_disk_in(dir.as_deref());
            true
        })
        .await
        .unwrap_or(false);
        self.remember(key, entry);
    }

    /// Drop a corrupt entry from both layers: a failed inflate must not poison the next
    /// request for the same asset.
    pub async fn evict(&self, key: &str) {
        {
            let mut memory = self.memory.lock().unwrap();
            if let Some(old) = memory.map.remove(key) {
                memory.bytes -= old.body.len();
            }
            memory.order.retain(|k| k != key);
        }
        let dir = self.dir.clone();
        let pool_key = key.to_owned();
        let _ = tokio::task::spawn_blocking(move || {
            let name = crate::util::hex(&crate::util::sha256(pool_key.as_bytes()));
            if let Some(dir) = dir.as_ref() {
                let _ = std::fs::remove_file(dir.join(format!("{name}.bin")));
            }
        })
        .await;
    }

    fn remember(&self, key: &str, entry: Entry) {
        let mut memory = self.memory.lock().unwrap();
        if let Some(old) = memory.map.remove(key) {
            memory.bytes -= old.body.len();
            memory.order.retain(|k| k != key);
        }
        if entry.body.len() > MEMORY_BYTES / 4 {
            return;
        }
        memory.bytes += entry.body.len();
        memory.order.push_back(key.to_owned());
        memory.map.insert(key.to_owned(), entry);
        while memory.bytes > MEMORY_BYTES {
            let Some(old) = memory.order.pop_front() else {
                break;
            };
            if let Some(gone) = memory.map.remove(&old) {
                memory.bytes -= gone.body.len();
            }
        }
    }

    /// Drop every memory entry of an instance version that is no longer running.
    pub fn forget_prefix(&self, prefix: &str) {
        let mut memory = self.memory.lock().unwrap();
        let gone: Vec<String> = memory
            .map
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect();
        for key in gone {
            if let Some(entry) = memory.map.remove(&key) {
                memory.bytes -= entry.body.len();
            }
            memory.order.retain(|k| *k != key);
        }
    }

    /// Least-recently-modified files go first once the directory passes its cap.
    fn trim_disk(&self) {
        trim_disk_in(self.dir.as_deref());
    }

    pub fn memory_bytes(&self) -> usize {
        self.memory.lock().unwrap().bytes
    }
}

fn parse_disk(bytes: &[u8]) -> Option<Entry> {
    let mut lines = 0;
    let mut at = 0;
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            lines += 1;
            if lines == 3 {
                at = i + 1;
                break;
            }
        }
    }
    if lines < 3 {
        return None;
    }
    let head = std::str::from_utf8(&bytes[..at]).ok()?;
    let mut parts = head.lines();
    let content_type = parts.next()?.to_owned();
    let etag = parts.next()?.to_owned();
    let br = parts.next()? == "br";
    Some(Entry {
        content_type,
        etag,
        body: bytes[at..].to_vec(),
        br,
    })
}

/// One disk entry: header lines then the body, written to a temp sibling and RENAMED into
/// place. `fs::write` truncates first, so a crash or power loss mid-write used to leave a
/// permanently truncated body that still parses as a valid entry — and immutable assets
/// carry a year-long max-age, so a browser kept the broken file for a year. The rename is
/// atomic; a failed write leaves at most a temp file the next store overwrites.
fn write_disk(dir: Option<&std::path::Path>, key: &str, entry: &Entry) -> bool {
    use std::sync::atomic::{AtomicU64, Ordering};
    static TMP: AtomicU64 = AtomicU64::new(0);
    let Some(dir) = dir else {
        return false;
    };
    let name = crate::util::hex(&crate::util::sha256(key.as_bytes()));
    let file = dir.join(format!("{name}.bin"));
    let tmp = dir.join(format!("{name}.tmp{}", TMP.fetch_add(1, Ordering::Relaxed)));
    let mut bytes = entry.meta_line().into_bytes();
    bytes.extend_from_slice(&entry.body);
    if std::fs::write(&tmp, bytes).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    if std::fs::rename(&tmp, &file).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    true
}

/// The disk cap's trim, as a free function the blocking pool can run (2026-10-16).
fn trim_disk_in(dir: Option<&std::path::Path>) {
    let Some(dir) = dir else { return };
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = read
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some((meta.modified().ok()?, meta.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= DISK_BYTES {
        return;
    }
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= DISK_BYTES {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brotli_round_trips() {
        let text = "function f() { return 1; }\n".repeat(200);
        let packed = brotli(text.as_bytes());
        assert!(packed.len() < text.len() / 4);
        assert_eq!(unbrotli(&packed).unwrap(), text.as_bytes());
        // A corrupt stream is a miss, never a partial body.
        assert!(unbrotli(b"not a brotli stream at all, just bytes").is_none());
    }

    #[test]
    fn memory_and_disk_layers() {
        let dir = tempfile::tempdir().unwrap();
        let cache = AssetCache::new(Some(dir.path().to_path_buf()));
        let entry = Entry {
            content_type: "text/javascript".into(),
            etag: "\"abc\"".into(),
            body: brotli(b"let x = 1;"),
            br: true,
        };
        cache.put("0.1.10|assets/a.js", entry.clone());
        assert_eq!(cache.get("0.1.10|assets/a.js").unwrap().etag, "\"abc\"");
        // A fresh cache over the same directory still finds it (the disk layer).
        let again = AssetCache::new(Some(dir.path().to_path_buf()));
        let hit = again.get("0.1.10|assets/a.js").unwrap();
        assert!(hit.br);
        assert_eq!(unbrotli(&hit.body).unwrap(), b"let x = 1;");
        again.forget_prefix("0.1.10|");
        assert_eq!(again.memory_bytes(), 0);
    }

    #[test]
    fn disk_writes_land_atomically_without_temp_litter() {
        let dir = tempfile::tempdir().unwrap();
        let cache = AssetCache::new(Some(dir.path().to_path_buf()));
        cache.put(
            "k",
            Entry {
                content_type: "text/plain".into(),
                etag: "\"e\"".into(),
                body: b"hello".to_vec(),
                br: false,
            },
        );
        cache.put(
            "k",
            Entry {
                content_type: "text/plain".into(),
                etag: "\"e2\"".into(),
                body: b"hello again".to_vec(),
                br: false,
            },
        );
        // Two stores, one file on disk — the temp siblings renamed away, nothing left
        // behind for the trim walk to count.
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert_eq!(names.len(), 1, "exactly the .bin remains: {names:?}");
        assert_eq!(cache.get("k").unwrap().body, b"hello again");
    }

    #[tokio::test]
    async fn evict_removes_both_layers() {
        let dir = tempfile::tempdir().unwrap();
        let cache = AssetCache::new(Some(dir.path().to_path_buf()));
        cache.put(
            "k",
            Entry {
                content_type: "text/plain".into(),
                etag: "\"e\"".into(),
                body: b"hello".to_vec(),
                br: false,
            },
        );
        cache.evict("k").await;
        assert!(cache.get("k").is_none());
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "the disk copy left with the memory one"
        );
    }

    #[test]
    fn memory_is_capped() {
        let cache = AssetCache::new(None);
        for i in 0..40 {
            cache.put(
                &format!("k{i}"),
                Entry {
                    content_type: "font/woff2".into(),
                    etag: String::new(),
                    body: vec![0; 1 << 20],
                    br: false,
                },
            );
        }
        assert!(cache.memory_bytes() <= MEMORY_BYTES);
        assert!(cache.get("k39").is_some());
        assert!(cache.get("k0").is_none());
    }
}
