//! Host-request routing across one instance's frontends (docs/ggs-remote-plan.md §8.6 #1)
//! and the registration journal a frontend that attaches late replays.
//!
//! A backend-hosted extension (ggs-node, the real-Node host) runs once per instance, while
//! the instance can have several frontends: the desktop window (`"main"`) and every remote
//! session behind the Relay (`"remote/<session>"` — through a Hub, sessions of different
//! people). Every `ggs.hostRequest` is answered by exactly one of them, so each request
//! needs an address:
//!
//! - every request about a webview panel or webview view goes to the desktop window
//!   ([`WEBVIEW_HOME`]): a webview's page is ONE live document per instance — Claude Code's
//!   chat keeps its conversation in its page — and a remote page that runs its own
//!   workbench shows a live copy of it (§22.6, `src/remote/mirror/webviewShare.ts`), so a
//!   question asked on either side streams on both. Before 2026-10-12 a webview followed
//!   the frontend that last resolved or messaged it, and the other side's chat froze;
//! - any other request made while a frontend's call into the backend is in flight goes to
//!   that frontend (the latest such call wins) — a remote quick pick opens in the remote
//!   page, not on the desktop;
//! - the rest — the activation's own requests, timers, background work — has no caller,
//!   and the composition root's default policy decides.
//!
//! The activation's registrations (commands, `setContext` keys, providers, views, status
//! bar items) land only in the frontend that served them; the journal keeps them, compacted,
//! so a frontend that attaches to an already-running backend can replay them and show the
//! same entries (Claude Code's activity-bar container is gated on a `setContext` key). The
//! live webview panels ride along, so the attaching page opens their copies.
//!
//! The module is pure bookkeeping — no Tauri types — so `ext_process` stays the only owner
//! of the wire and this stays testable.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::{Map, Value};

/// The journal's bound per extension: registrations are few (claude-code's activation is a
/// few dozen), so a backend past this is churning — later entries are dropped, not the
/// activation's.
const JOURNAL_CAP: usize = 4096;

/// The frontend every webview lives in (see the module doc).
pub const WEBVIEW_HOME: &str = "main";

/// The frontend a call came from: the desktop window is `"main"`; a call through the Relay
/// carries its session in the `x-ggs-frontend` header the Relay stamps on every invoke
/// (`remote/<session>`), and only the Relay's own webview is believed when it says so.
/// A Relay call without one is the remote side at large (`"remote"`).
pub fn frontend_of(label: &str, header: Option<&str>) -> String {
    if label == "main" {
        return "main".into();
    }
    match header {
        Some(id) if is_session(id) => id.to_owned(),
        _ => "remote".into(),
    }
}

/// `remote/<digits>` — one remote session's frontend id.
pub fn is_session(id: &str) -> bool {
    id.strip_prefix("remote/")
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

#[derive(Default)]
struct ExtRoutes {
    /// The frontend calls into the backend in flight, in start order.
    calls: Vec<(u64, String)>,
    /// The state-carrying requests, in arrival order (see [`journal_key`]).
    journal: Vec<(Option<String>, String, Value)>,
    /// Each live webview panel's `webview.create` arguments (the title kept current), in
    /// creation order — what a frontend that attaches later needs to show the panel.
    panels: Vec<(String, Value)>,
}

fn routes() -> &'static Mutex<HashMap<String, ExtRoutes>> {
    static ROUTES: OnceLock<Mutex<HashMap<String, ExtRoutes>>> = OnceLock::new();
    ROUTES.get_or_init(Default::default)
}

fn with<T>(ext_id: &str, edit: impl FnOnce(&mut ExtRoutes) -> T) -> T {
    let mut all = routes().lock().unwrap_or_else(|p| p.into_inner());
    edit(all.entry(ext_id.to_owned()).or_default())
}

/// A frontend call in flight; dropping it ends the call's claim on the requests.
pub struct CallGuard {
    ext_id: String,
    seq: u64,
}

impl Drop for CallGuard {
    fn drop(&mut self) {
        with(&self.ext_id, |routes| {
            routes.calls.retain(|(seq, _)| *seq != self.seq)
        });
    }
}

/// Whether a host request is about a webview panel or a webview view.
fn is_webview(method: &str) -> bool {
    method.starts_with("webview.") || method.starts_with("webviewView.")
}

/// A panel id as [`ExtRoutes::panels`] keys it.
fn panel_key(id: &Value) -> Option<String> {
    match id {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// A frontend's call into `ext_id`'s backend begins.
pub fn call_begin(ext_id: &str, frontend: &str) -> CallGuard {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    with(ext_id, |routes| {
        routes.calls.push((seq, frontend.to_owned()))
    });
    CallGuard {
        ext_id: ext_id.to_owned(),
        seq,
    }
}

/// The latest frontend call in flight — whose click a request answers, if anyone's.
pub fn caller(ext_id: &str) -> Option<String> {
    with(ext_id, |routes| {
        routes.calls.last().map(|(_, frontend)| frontend.clone())
    })
}

/// The frontend a request should reach, when one claims it: the desktop window for a
/// webview, else the latest frontend call in flight. `None` leaves it to the default
/// policy.
pub fn preferred(ext_id: &str, method: &str) -> Option<String> {
    if is_webview(method) {
        return Some(WEBVIEW_HOME.into());
    }
    caller(ext_id)
}

/// The desktop window closed a webview panel's tab (the `webviewDisposed` event it pushes
/// into the backend): the panel is gone, and the other frontends drop their copies of it.
/// Answers the panel id when the event is such a close.
pub fn panel_closed(ext_id: &str, event: &Value) -> Option<Value> {
    if event.get("event").and_then(Value::as_str) != Some("webviewDisposed") {
        return None;
    }
    let id = event.get("panelId")?.clone();
    let key = panel_key(&id)?;
    with(ext_id, |routes| {
        routes.panels.retain(|(panel, _)| *panel != key)
    });
    Some(id)
}

/// A request was delivered: a panel's life (create, title, reveal, dispose) is tracked,
/// and a state-carrying request joins the journal. Answers whether the request carries
/// state the other frontends should mirror — a registration, or a panel whose copy they
/// show.
pub fn routed(ext_id: &str, method: &str, args: &Value) -> bool {
    let key = args.get(0).and_then(panel_key);
    with(ext_id, |routes| {
        match (method, key) {
            ("webview.create", Some(key)) => {
                routes.panels.retain(|(panel, _)| *panel != key);
                routes.panels.push((key, args.clone()));
                return true;
            }
            ("webview.setTitle", Some(key)) => {
                let create = routes
                    .panels
                    .iter_mut()
                    .find(|(panel, _)| *panel == key)
                    .and_then(|(_, create)| create.get_mut(2));
                if let (Some(slot), Some(title)) = (create, args.get(1)) {
                    *slot = title.clone();
                }
                return true;
            }
            ("webview.reveal", Some(_)) => return true,
            ("webview.dispose", Some(key)) => {
                routes.panels.retain(|(panel, _)| *panel != key);
                return true;
            }
            _ => {}
        }
        let Some(key) = journal_key(method, args) else {
            return false;
        };
        record(&mut routes.journal, key, method, args);
        true
    })
}

/// Whether a request carries registration state, and the key that compacts it: `Some(None)`
/// appends, `Some(Some(key))` replaces (a context key) or merges (a status bar item's
/// fields) the entry with the same key.
fn journal_key(method: &str, args: &Value) -> Option<Option<String>> {
    match method {
        "commands.execute" if args.get(0).and_then(Value::as_str) == Some("setContext") => {
            let key = args.pointer("/1/0").and_then(Value::as_str)?;
            Some(Some(format!("ctx:{key}")))
        }
        "statusbar.set" => {
            let id = args.get(0).and_then(Value::as_str)?;
            Some(Some(format!("statusbar:{id}")))
        }
        "commands.register"
        | "commands.registerBatch"
        | "commands.unregister"
        | "docProvider.register"
        | "docProvider.unregister"
        | "fsProvider.register"
        | "fsProvider.unregister"
        | "treeView.register"
        | "treeView.dispose"
        | "webviewView.register"
        | "webviewView.dispose"
        | "statusbar.create"
        | "statusbar.dispose"
        | "fileDecorations.register"
        | "fileDecorations.unregister"
        | "decoration.type"
        | "decoration.dispose" => Some(None),
        // A view's html is the page's only copy: a frontend that re-attaches (a page
        // reload) replays it into the view it just mounted — without this, the sidebar's
        // webview views stayed blank until the backend happened to set html again.
        "webviewView.setHtml" => {
            let id = args.get(0).and_then(Value::as_str)?;
            Some(Some(format!("viewhtml:{id}")))
        }
        _ if method.starts_with("languages.register")
            || method.starts_with("languages.unregister") =>
        {
            Some(None)
        }
        _ => None,
    }
}

fn record(
    journal: &mut Vec<(Option<String>, String, Value)>,
    key: Option<String>,
    method: &str,
    args: &Value,
) {
    if let Some(key) = &key {
        if let Some(at) = journal
            .iter()
            .position(|(existing, _, _)| existing.as_ref() == Some(key))
        {
            if method == "statusbar.set" {
                // A status bar update is partial (`Object.assign`): the fields merge.
                if let (Some(Value::Object(old)), Some(Value::Object(new))) =
                    (journal[at].2.get_mut(1), args.get(1))
                {
                    for (field, value) in new {
                        old.insert(field.clone(), value.clone());
                    }
                    return;
                }
            }
            journal.remove(at);
        }
    }
    if journal.len() >= JOURNAL_CAP {
        return;
    }
    journal.push((key, method.to_owned(), args.clone()));
}

/// The journal, in order, as `{ method, args }` — what a late frontend replays — with
/// one `webview.create` per live panel at its end, so the frontend opens their copies.
pub fn journal(ext_id: &str) -> Vec<Value> {
    let entry = |method: &str, args: &Value| {
        let mut entry = Map::new();
        entry.insert("method".into(), Value::String(method.to_owned()));
        entry.insert("args".into(), args.clone());
        Value::Object(entry)
    };
    with(ext_id, |routes| {
        routes
            .journal
            .iter()
            .map(|(_, method, args)| entry(method, args))
            .chain(
                routes
                    .panels
                    .iter()
                    .map(|(_, create)| entry("webview.create", create)),
            )
            .collect()
    })
}

/// A fresh process for `ext_id`: its predecessor's registrations and webviews are gone.
pub fn reset(ext_id: &str) {
    with(ext_id, |routes| {
        routes.journal.clear();
        routes.panels.clear();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_call_names_its_frontend_and_only_the_relay_may_name_a_session() {
        assert_eq!(frontend_of("main", None), "main");
        // The desktop window cannot pose as a remote session.
        assert_eq!(frontend_of("main", Some("remote/7")), "main");
        assert_eq!(frontend_of("remote-relay", Some("remote/7")), "remote/7");
        assert_eq!(frontend_of("remote-relay", None), "remote");
        assert_eq!(frontend_of("remote-relay", Some("remote/x")), "remote");
        assert_eq!(frontend_of("remote-relay", Some("main")), "remote");
    }

    #[test]
    fn a_request_follows_the_call_in_flight() {
        let ext = "test.call-in-flight";
        assert_eq!(preferred(ext, "notify"), None);
        let desktop = call_begin(ext, "main");
        assert_eq!(preferred(ext, "notify").as_deref(), Some("main"));
        let remote = call_begin(ext, "remote/3");
        assert_eq!(
            preferred(ext, "window.showQuickPick").as_deref(),
            Some("remote/3")
        );
        assert_eq!(caller(ext).as_deref(), Some("remote/3"));
        drop(remote);
        assert_eq!(preferred(ext, "notify").as_deref(), Some("main"));
        drop(desktop);
        assert_eq!(preferred(ext, "notify"), None);
        assert_eq!(caller(ext), None);
    }

    #[test]
    fn every_webview_lives_in_the_desktop_window_whoever_asked() {
        // One live chat per instance: a remote page's click that opens a panel, resolves
        // a view or messages either still lands in the desktop window, whose page the
        // remote copies — the conversation streams on both sides (2026-10-12).
        let ext = "test.webview-home";
        reset(ext);
        let _remote = call_begin(ext, "remote/4");
        for method in [
            "webview.create",
            "webview.setHtml",
            "webview.postMessage",
            "webview.reveal",
            "webviewView.setHtml",
            "webviewView.postMessage",
            "webviewView.show",
        ] {
            assert_eq!(
                preferred(ext, method).as_deref(),
                Some(WEBVIEW_HOME),
                "{method}"
            );
        }
    }

    #[test]
    fn a_panels_life_is_mirrored_and_replayed_to_late_frontends() {
        let ext = "test.panel-life";
        reset(ext);
        assert!(routed(
            ext,
            "webview.create",
            &json!([1, "view", "Git Graph", 1, false])
        ));
        assert!(routed(
            ext,
            "webview.create",
            &json!([2, "claudeVSCodePanel", "Claude Code", 2, false])
        ));
        // The title a frontend attaching now opens the copy with is the current one.
        assert!(routed(
            ext,
            "webview.setTitle",
            &json!([2, "Fix the build"])
        ));
        assert!(routed(ext, "webview.reveal", &json!([1])));
        // The page's own traffic is not state: a copy follows the live page instead.
        assert!(!routed(ext, "webview.setHtml", &json!([1, "<p>graph</p>"])));
        assert!(!routed(ext, "webview.postMessage", &json!([2, {}])));
        let panels = |ext: &str| -> Vec<Value> {
            journal(ext)
                .into_iter()
                .filter(|entry| entry["method"] == "webview.create")
                .map(|entry| entry["args"].clone())
                .collect()
        };
        assert_eq!(
            panels(ext),
            vec![
                json!([1, "view", "Git Graph", 1, false]),
                json!([2, "claudeVSCodePanel", "Fix the build", 2, false]),
            ]
        );
        // The extension disposes one; the desktop's user closes the other's tab.
        assert!(routed(ext, "webview.dispose", &json!([1])));
        assert_eq!(
            panel_closed(ext, &json!({ "event": "webviewMessage", "panelId": 2 })),
            None
        );
        assert_eq!(
            panel_closed(ext, &json!({ "event": "webviewDisposed", "panelId": 2 })),
            Some(json!(2))
        );
        assert!(panels(ext).is_empty());
    }

    #[test]
    fn a_views_html_joins_the_journal_for_the_next_frontend() {
        // The page is the only place a webview view's html lives: a frontend that
        // re-attaches (a reload) replays the journalled setHtml into the view it mounts,
        // instead of a blank sidebar section until the backend sets html again.
        let ext = "test.view-html-journal";
        reset(ext);
        routed(
            ext,
            "webviewView.setHtml",
            &json!(["sessions", "<b>first</b>"]),
        );
        routed(
            ext,
            "webviewView.setHtml",
            &json!(["sessions", "<b>second</b>"]),
        );
        let replayed: Vec<Value> = journal(ext)
            .into_iter()
            .filter(|entry| entry["method"] == "webviewView.setHtml")
            .map(|entry| entry["args"].clone())
            .collect();
        assert_eq!(replayed, vec![json!(["sessions", "<b>second</b>"])]);
    }

    #[test]
    fn the_journal_keeps_registrations_compacted() {
        let ext = "test.journal";
        reset(ext);
        assert!(routed(
            ext,
            "commands.registerBatch",
            &json!([["a.one", "a.two"]])
        ));
        assert!(routed(
            ext,
            "commands.execute",
            &json!(["setContext", ["a:flag", false]])
        ));
        assert!(routed(ext, "statusbar.create", &json!(["item", 1])));
        assert!(routed(
            ext,
            "statusbar.set",
            &json!(["item", { "text": "one", "visible": true }])
        ));
        assert!(routed(
            ext,
            "commands.execute",
            &json!(["setContext", ["a:flag", true]])
        ));
        assert!(routed(
            ext,
            "statusbar.set",
            &json!(["item", { "text": "two" }])
        ));
        assert!(routed(
            ext,
            "languages.registerHover",
            &json!([{ "id": "h1" }])
        ));
        // Not state: requests the journal never keeps.
        assert!(!routed(ext, "notify", &json!(["info", "hi"])));
        assert!(!routed(
            ext,
            "commands.execute",
            &json!(["vscode.open", []])
        ));
        assert_eq!(
            journal(ext),
            vec![
                json!({ "method": "commands.registerBatch", "args": [["a.one", "a.two"]] }),
                json!({ "method": "statusbar.create", "args": ["item", 1] }),
                json!({ "method": "statusbar.set", "args": ["item", { "text": "two", "visible": true }] }),
                json!({ "method": "commands.execute", "args": ["setContext", ["a:flag", true]] }),
                json!({ "method": "languages.registerHover", "args": [{ "id": "h1" }] }),
            ]
        );
        reset(ext);
        assert!(journal(ext).is_empty());
    }
}
