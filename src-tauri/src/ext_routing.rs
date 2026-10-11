//! Host-request routing across one instance's frontends (docs/ggs-remote-plan.md §8.6 #1)
//! and the registration journal a frontend that attaches late replays.
//!
//! A backend-hosted extension (ggs-node, the real-Node host) runs once per instance, while
//! the instance can have several frontends: the desktop window (`"main"`) and every remote
//! session behind the Relay (`"remote/<session>"` — through a Hub, sessions of different
//! people). Every `ggs.hostRequest` is answered by exactly one of them, so each request
//! needs an address — a session's own, never "some remote page", or one person's click
//! would open in another person's browser:
//!
//! - a request about a webview panel or webview view goes to the frontend that owns it —
//!   the one whose call created the panel, or the one that last resolved, showed or
//!   messaged the view;
//! - any other request made while a frontend's call into the backend is in flight goes to
//!   that frontend (the latest such call wins) — a remote click on "View Git Graph" opens
//!   the graph in the remote page, not on the desktop;
//! - the rest — the activation's own requests, timers, background work — has no caller,
//!   and the composition root's default policy decides.
//!
//! The activation's registrations (commands, `setContext` keys, providers, views, status
//! bar items) land only in the frontend that served them; the journal keeps them, compacted,
//! so a frontend that attaches to an already-running backend can replay them and show the
//! same entries (Claude Code's activity-bar container is gated on a `setContext` key).
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
    /// Webview panel and view owners: `webview:<panel id>` / `view:<view id>`.
    owners: HashMap<String, String>,
    /// The state-carrying requests, in arrival order (see [`journal_key`]).
    journal: Vec<(Option<String>, String, Value)>,
    /// Each live webview panel's `webview.create` arguments and latest html, by
    /// `webview:<panel id>` — what it takes to show the panel in another frontend.
    panels: HashMap<String, (Value, Option<Value>)>,
}

/// A webview panel changing frontends (see [`panel_move`]).
#[derive(Debug, PartialEq)]
pub struct PanelMove {
    pub from: String,
    pub to: String,
    /// The panel's `webview.create` arguments (the title kept current).
    pub create: Value,
    /// Its latest html, when it set one.
    pub html: Option<Value>,
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

/// The id the owner map keys a webview request on, from its method and first argument.
fn owner_key(method: &str, args: &Value) -> Option<String> {
    let first = args.get(0)?;
    let id = match first {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => return None,
    };
    if method.starts_with("webviewView.") {
        Some(format!("view:{id}"))
    } else if method.starts_with("webview.") {
        Some(format!("webview:{id}"))
    } else {
        None
    }
}

/// A frontend's call into `ext_id`'s backend begins. A call that shows a webview view
/// (`webviewView.resolve` / `.setVisible`) makes its frontend the view's owner.
pub fn call_begin(ext_id: &str, frontend: &str, method: &str, args: &Value) -> CallGuard {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    with(ext_id, |routes| {
        routes.calls.push((seq, frontend.to_owned()));
        if method == "webviewView.resolve" || method == "webviewView.setVisible" {
            if let Some(key) = owner_key(method, args) {
                routes.owners.insert(key, frontend.to_owned());
            }
        }
    });
    CallGuard {
        ext_id: ext_id.to_owned(),
        seq,
    }
}

/// A frontend pushed an event into the backend: a webview's or a view's message makes the
/// pushing frontend its owner — the replies go where the conversation is.
pub fn note_event(ext_id: &str, frontend: &str, event: &Value) {
    let key = match event.get("event").and_then(Value::as_str) {
        Some("webviewMessage") => event.get("panelId").map(|id| format!("webview:{id}")),
        Some("webviewViewMessage" | "webviewViewVisible") => event
            .get("viewId")
            .and_then(Value::as_str)
            .map(|id| format!("view:{id}")),
        _ => None,
    };
    if let Some(key) = key {
        with(ext_id, |routes| {
            routes.owners.insert(key, frontend.to_owned())
        });
    }
}

/// The frontend a request should reach, when one claims it: the webview's owner, else the
/// latest frontend call in flight. `None` leaves it to the default policy.
pub fn preferred(ext_id: &str, method: &str, args: &Value) -> Option<String> {
    with(ext_id, |routes| {
        owner_key(method, args)
            .and_then(|key| routes.owners.get(&key).cloned())
            .or_else(|| routes.calls.last().map(|(_, frontend)| frontend.clone()))
    })
}

/// Whether a `webview.reveal` moves its panel: an extension that keeps ONE panel (Git
/// Graph's `createOrShow`) reveals it when someone asks again — and when that someone is a
/// different frontend from the panel's owner (another user's page), showing it in the
/// owner's page would leave the asker with nothing. The asker is the latest frontend call
/// in flight; only an explicit reveal moves a panel, never its background traffic.
pub fn panel_move(ext_id: &str, method: &str, args: &Value) -> Option<PanelMove> {
    if method != "webview.reveal" {
        return None;
    }
    let key = owner_key(method, args)?;
    with(ext_id, |routes| {
        // An absent owner is a frontend that went away since the panel was created (its
        // page reloaded; `frontend_gone` cleared the claim): the panel record is what
        // remains, and the asker takes it — the move re-creates the panel in the asking
        // page. Without this, the extension's "reveal the one panel I keep" reached a
        // frontend that had no record of it and nothing showed, forever.
        let from = routes.owners.get(&key).cloned();
        let (_, to) = routes.calls.last()?;
        if from.as_deref() == Some(to.as_str()) {
            return None;
        }
        let (create, html) = routes.panels.get(&key)?;
        Some(PanelMove {
            from: from.unwrap_or_default(),
            to: to.clone(),
            create: create.clone(),
            html: html.clone(),
        })
    })
}

/// The panel a `webview.*` request names now belongs to `frontend`.
pub fn set_owner(ext_id: &str, method: &str, args: &Value, frontend: &str) {
    if let Some(key) = owner_key(method, args) {
        with(ext_id, |routes| {
            routes.owners.insert(key, frontend.to_owned())
        });
    }
}

/// A frontend went away (a remote session ended): nothing it owned is addressed to it
/// anymore — its webviews' traffic falls back to the default policy instead of waiting
/// on a page no one shows.
pub fn frontend_gone(frontend: &str) {
    let mut all = routes().lock().unwrap_or_else(|p| p.into_inner());
    for routes in all.values_mut() {
        routes.owners.retain(|_, owner| owner != frontend);
    }
}

/// A request was delivered to `frontend`: a created panel belongs to it, a disposed panel
/// or view is forgotten, and a state-carrying request joins the journal. Answers whether
/// the request carries state the other frontends should mirror.
pub fn routed(ext_id: &str, method: &str, args: &Value, frontend: &str) -> bool {
    with(ext_id, |routes| {
        match method {
            "webview.create" => {
                if let Some(key) = owner_key(method, args) {
                    routes.owners.insert(key.clone(), frontend.to_owned());
                    routes.panels.insert(key, (args.clone(), None));
                }
            }
            "webview.setHtml" => {
                if let Some(panel) =
                    owner_key(method, args).and_then(|key| routes.panels.get_mut(&key))
                {
                    panel.1 = args.get(1).cloned();
                }
            }
            "webview.setTitle" => {
                if let Some(panel) =
                    owner_key(method, args).and_then(|key| routes.panels.get_mut(&key))
                {
                    if let (Some(slot), Some(title)) = (panel.0.get_mut(2), args.get(1)) {
                        *slot = title.clone();
                    }
                }
            }
            "webview.dispose" | "webviewView.dispose" => {
                if let Some(key) = owner_key(method, args) {
                    routes.owners.remove(&key);
                    routes.panels.remove(&key);
                }
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

/// The journal, in order, as `{ method, args }` — what a late frontend replays.
pub fn journal(ext_id: &str) -> Vec<Value> {
    with(ext_id, |routes| {
        routes
            .journal
            .iter()
            .map(|(_, method, args)| {
                let mut entry = Map::new();
                entry.insert("method".into(), Value::String(method.clone()));
                entry.insert("args".into(), args.clone());
                Value::Object(entry)
            })
            .collect()
    })
}

/// A fresh process for `ext_id`: its predecessor's registrations and webviews are gone.
pub fn reset(ext_id: &str) {
    with(ext_id, |routes| {
        routes.owners.clear();
        routes.journal.clear();
        routes.panels.clear();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn claim(ext: &str, method: &str, args: Value) -> Option<String> {
        preferred(ext, method, &args)
    }

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
        assert_eq!(claim(ext, "notify", json!([])), None);
        let desktop = call_begin(ext, "main", "runCommand", &json!({}));
        assert_eq!(claim(ext, "notify", json!([])).as_deref(), Some("main"));
        let remote = call_begin(ext, "remote/3", "runCommand", &json!({}));
        assert_eq!(
            claim(ext, "webview.create", json!([1])).as_deref(),
            Some("remote/3")
        );
        drop(remote);
        assert_eq!(claim(ext, "notify", json!([])).as_deref(), Some("main"));
        drop(desktop);
        assert_eq!(claim(ext, "notify", json!([])), None);
    }

    #[test]
    fn two_remote_users_never_get_each_others_pages() {
        // Through a Hub two people's browsers are two sessions of the same instance: each
        // one's Git Graph opens in its own page, and the traffic of each panel stays there
        // whoever clicked last.
        let ext = "test.two-users";
        reset(ext);
        let alice = call_begin(ext, "remote/1", "runCommand", &json!({}));
        let to = claim(ext, "webview.create", json!([1, "view", "Git Graph"])).unwrap();
        routed(ext, "webview.create", &json!([1, "view", "Git Graph"]), &to);
        drop(alice);
        let bob = call_begin(ext, "remote/2", "runCommand", &json!({}));
        let to = claim(ext, "webview.create", json!([2, "view", "Git Graph"])).unwrap();
        routed(ext, "webview.create", &json!([2, "view", "Git Graph"]), &to);
        // Bob's call is still in flight; Alice's panel's traffic still goes to Alice.
        assert_eq!(
            claim(ext, "webview.postMessage", json!([1, {}])).as_deref(),
            Some("remote/1")
        );
        assert_eq!(
            claim(ext, "webview.postMessage", json!([2, {}])).as_deref(),
            Some("remote/2")
        );
        drop(bob);
        // Alice leaves: her panel's leftovers fall back to policy, never to Bob.
        frontend_gone("remote/1");
        assert_eq!(claim(ext, "webview.postMessage", json!([1, {}])), None);
        assert_eq!(
            claim(ext, "webview.postMessage", json!([2, {}])).as_deref(),
            Some("remote/2")
        );
    }

    #[test]
    fn a_second_users_reveal_moves_the_one_panel_to_that_user() {
        // Git Graph keeps one panel: B opened it, A asks for it — A must get it, carrying
        // the page it shows; B's background traffic alone never moves it.
        let ext = "test.panel-move";
        reset(ext);
        let b = call_begin(ext, "remote/2", "runCommand", &json!({}));
        routed(
            ext,
            "webview.create",
            &json!([1, "view", "Git Graph", 1, false]),
            "remote/2",
        );
        routed(
            ext,
            "webview.setHtml",
            &json!([1, "<p>graph</p>"]),
            "remote/2",
        );
        routed(
            ext,
            "webview.setTitle",
            &json!([1, "Git Graph RS"]),
            "remote/2",
        );
        assert_eq!(panel_move(ext, "webview.reveal", &json!([1])), None);
        drop(b);
        assert_eq!(panel_move(ext, "webview.reveal", &json!([1])), None);
        let a = call_begin(ext, "remote/1", "runCommand", &json!({}));
        assert_eq!(
            panel_move(ext, "webview.postMessage", &json!([1, {}])),
            None
        );
        let moved = panel_move(ext, "webview.reveal", &json!([1])).unwrap();
        assert_eq!(
            moved,
            PanelMove {
                from: "remote/2".into(),
                to: "remote/1".into(),
                create: json!([1, "view", "Git Graph RS", 1, false]),
                html: Some(json!("<p>graph</p>")),
            }
        );
        set_owner(ext, "webview.reveal", &json!([1]), &moved.to);
        assert_eq!(
            claim(ext, "webview.postMessage", json!([1, {}])).as_deref(),
            Some("remote/1")
        );
        assert_eq!(panel_move(ext, "webview.reveal", &json!([1])), None);
        drop(a);
    }

    #[test]
    fn a_dead_owners_panel_moves_to_the_reloader() {
        // The panel's frontend went away (its page reloaded — `frontend_gone` cleared the
        // claim) and the extension's "reveal the one panel I keep" arrives from the NEW
        // frontend: the move hands the panel over, instead of the reveal landing on a
        // page that has no record of it and nothing showing, forever.
        let ext = "test.panel-reload";
        reset(ext);
        let old = call_begin(ext, "remote/4", "runCommand", &json!({}));
        routed(
            ext,
            "webview.create",
            &json!([1, "view", "Git Graph", 1, false]),
            "remote/4",
        );
        routed(ext, "webview.setHtml", &json!([1, "<p>graph</p>"]), "remote/4");
        drop(old);
        frontend_gone("remote/4");
        let fresh = call_begin(ext, "remote/5", "runCommand", &json!({}));
        let moved = panel_move(ext, "webview.reveal", &json!([1])).unwrap();
        assert_eq!(moved.from, "");
        assert_eq!(moved.to, "remote/5");
        assert_eq!(moved.html, Some(json!("<p>graph</p>")));
        set_owner(ext, "webview.reveal", &json!([1]), &moved.to);
        assert_eq!(panel_move(ext, "webview.reveal", &json!([1])), None);
        drop(fresh);
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
            "remote/1",
        );
        routed(
            ext,
            "webviewView.setHtml",
            &json!(["sessions", "<b>second</b>"]),
            "remote/1",
        );
        let replayed: Vec<(String, Value)> = journal(ext)
            .into_iter()
            .map(|entry| {
                (
                    entry["method"].as_str().unwrap().to_owned(),
                    entry["args"].clone(),
                )
            })
            .filter(|(method, _)| method == "webviewView.setHtml")
            .map(|(_, args)| ("webviewView.setHtml".to_owned(), args))
            .collect();
        assert_eq!(
            replayed,
            vec![("webviewView.setHtml".to_owned(), json!(["sessions", "<b>second</b>"]))]
        );
    }

    #[test]
    fn a_panel_belongs_to_the_frontend_that_created_it() {
        let ext = "test.panel-owner";
        reset(ext);
        let call = call_begin(ext, "remote/4", "runCommand", &json!({}));
        let target = claim(ext, "webview.create", json!([7, "view", "Git Graph"])).unwrap();
        routed(
            ext,
            "webview.create",
            &json!([7, "view", "Git Graph"]),
            &target,
        );
        drop(call);
        // Later, with the desktop calling, its traffic still reaches the remote page.
        let _desktop = call_begin(ext, "main", "runCommand", &json!({}));
        assert_eq!(
            claim(ext, "webview.setHtml", json!([7, "<html>"])).as_deref(),
            Some("remote/4")
        );
        assert_eq!(
            claim(ext, "webview.postMessage", json!([8, {}])).as_deref(),
            Some("main")
        );
        routed(ext, "webview.dispose", &json!([7]), "remote/4");
        assert_eq!(
            claim(ext, "webview.setHtml", json!([7, ""])).as_deref(),
            Some("main")
        );
    }

    #[test]
    fn a_view_follows_the_frontend_that_last_showed_or_messaged_it() {
        let ext = "test.view-owner";
        reset(ext);
        drop(call_begin(
            ext,
            "remote/5",
            "webviewView.resolve",
            &json!(["chat"]),
        ));
        assert_eq!(
            claim(ext, "webviewView.setHtml", json!(["chat", "<html>"])).as_deref(),
            Some("remote/5")
        );
        note_event(
            ext,
            "main",
            &json!({ "event": "webviewViewMessage", "viewId": "chat", "message": {} }),
        );
        assert_eq!(
            claim(ext, "webviewView.postMessage", json!(["chat", {}])).as_deref(),
            Some("main")
        );
        note_event(
            ext,
            "remote/5",
            &json!({ "event": "webviewMessage", "panelId": 3, "message": {} }),
        );
        assert_eq!(
            claim(ext, "webview.postMessage", json!([3, {}])).as_deref(),
            Some("remote/5")
        );
    }

    #[test]
    fn the_journal_keeps_registrations_compacted() {
        let ext = "test.journal";
        reset(ext);
        assert!(routed(
            ext,
            "commands.registerBatch",
            &json!([["a.one", "a.two"]]),
            "main"
        ));
        assert!(routed(
            ext,
            "commands.execute",
            &json!(["setContext", ["a:flag", false]]),
            "main"
        ));
        assert!(routed(ext, "statusbar.create", &json!(["item", 1]), "main"));
        assert!(routed(
            ext,
            "statusbar.set",
            &json!(["item", { "text": "one", "visible": true }]),
            "main"
        ));
        assert!(routed(
            ext,
            "commands.execute",
            &json!(["setContext", ["a:flag", true]]),
            "main"
        ));
        assert!(routed(
            ext,
            "statusbar.set",
            &json!(["item", { "text": "two" }]),
            "main"
        ));
        assert!(routed(
            ext,
            "languages.registerHover",
            &json!([{ "id": "h1" }]),
            "main"
        ));
        // Not state: requests the journal never keeps.
        assert!(!routed(ext, "notify", &json!(["info", "hi"]), "main"));
        assert!(!routed(
            ext,
            "commands.execute",
            &json!(["vscode.open", []]),
            "main"
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
