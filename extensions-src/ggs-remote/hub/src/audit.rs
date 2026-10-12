//! The operator's audit trail (docs/ggs-remote-plan.md §20.6): one JSON line per tunnel
//! lifecycle, browser session and proxied HTTP answer *head* — never a body, never a
//! cookie, tokens in paths masked. Off by default (`audit_log` empty): the Hub's own
//! posture is "nothing persisted", and this file is the one deliberate exception an
//! operator running a public relay turns on — takedowns and abuse forensics need a trail,
//! and the logs an operator keeps are the logs they can answer with.

use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// One line per event, appended under a mutex — a proxied request already does far more
/// work than a small sequential write, and a lost log line must never take a request down.
pub struct Audit {
    sink: Option<Mutex<std::fs::File>>,
}

impl Audit {
    /// Open for append (or stay a no-op when the path is empty). A path whose directory
    /// does not exist yet is created; a file that cannot be opened at all disables the
    /// trail with one warning rather than refusing to serve.
    pub fn open(path: &str) -> Audit {
        if path.is_empty() {
            return Audit { sink: None };
        }
        if let Some(parent) = Path::new(path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            Ok(file) => Audit {
                sink: Some(Mutex::new(file)),
            },
            Err(e) => {
                crate::warn!("audit log {path}: {e} — the trail is off");
                Audit { sink: None }
            }
        }
    }

    pub fn log(&self, event: &str, fields: &[(&str, serde_json::Value)]) {
        let Some(sink) = &self.sink else {
            return;
        };
        let mut line = serde_json::Map::new();
        line.insert("ts".into(), serde_json::Value::String(iso_now()));
        line.insert("event".into(), serde_json::Value::String(event.to_owned()));
        for (name, value) in fields {
            line.insert((*name).to_owned(), value.clone());
        }
        let mut text = serde_json::to_string(&serde_json::Value::Object(line))
            .unwrap_or_else(|_| "{}".to_owned());
        text.push('\n');
        if let Err(e) = sink.lock().unwrap().write_all(text.as_bytes()) {
            crate::debug!("audit write: {e}");
        }
    }

    pub fn enabled(&self) -> bool {
        self.sink.is_some()
    }
}

/// The one credential the plan allows in a path (§16): the package token in
/// `/w/<inst>/ggs/<tok>/…` — masked to its first 6 characters, the same shape the daemon's
/// own access log keeps. Everything else in a path is a route name; queries never ride
/// along (callers log the path only).
pub fn mask_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut prev = "";
    for (at, segment) in path.split('/').enumerate() {
        if at > 0 {
            out.push('/');
        }
        if prev == "ggs" && segment.len() > 8 {
            if let Some(head) = segment.get(..6) {
                out.push_str(head);
                out.push('…');
                prev = segment;
                continue;
            }
        }
        out.push_str(segment);
        prev = segment;
    }
    out
}

/// UTC to the millisecond, spelled ISO 8601 — no clock dependency beyond std.
fn iso_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let (year, month, day) = civil_from_days((now.as_secs() / 86_400) as i64);
    let secs = now.as_secs() % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        secs / 3600,
        secs % 3600 / 60,
        secs % 60,
        now.subsec_millis()
    )
}

/// Howard Hinnant's `civil_from_days`: days since the Unix epoch → (year, month, day).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (
        if month <= 2 { year + 1 } else { year },
        month as u32,
        day as u32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_package_token_is_masked_and_routes_survive_verbatim() {
        assert_eq!(
            mask_path("/w/ggs-101/ggs/9f8e7d6c5b4a3f2e1d0c/pkg/index.html"),
            "/w/ggs-101/ggs/9f8e7d…/pkg/index.html"
        );
        assert_eq!(mask_path("/api/session"), "/api/session");
        assert_eq!(mask_path("/login"), "/login");
        assert_eq!(mask_path("/"), "/");
    }

    #[test]
    fn lines_carry_a_timestamp_and_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.jsonl");
        let audit = Audit::open(path.to_str().unwrap());
        assert!(audit.enabled());
        audit.log(
            "http",
            &[
                ("uuid", serde_json::json!("3f9c2a6e")),
                ("status", serde_json::json!(200)),
                ("path", serde_json::json!("/login\"quoted")),
            ],
        );
        let text = std::fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(text.trim_end()).unwrap();
        assert_eq!(value["event"], "http");
        assert_eq!(value["uuid"], "3f9c2a6e");
        assert_eq!(value["status"], 200);
        assert_eq!(value["path"], "/login\"quoted");
        assert!(value["ts"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn an_empty_path_is_a_no_op() {
        let audit = Audit::open("");
        assert!(!audit.enabled());
        audit.log("http", &[]);
    }

    #[test]
    fn the_calendar_matches_known_days() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(10_957), (2000, 1, 1));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }
}
