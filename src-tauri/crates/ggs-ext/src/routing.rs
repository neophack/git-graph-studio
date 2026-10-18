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
//!   the frontend that last resolved or messaged it, and the other side's chat froze.
//!   The exception (2026-10-18, the owner's direction) is the per-frontend webviews
//!   ([`per_frontend_webviews`], Git Graph): every frontend runs its OWN page of the
//!   view — its own size, its own scroll, nothing shared with the PC's copy — and the
//!   webview traffic the backend pushes mirrors to exactly the frontends hosting one
//!   ([`webview_hosted`]), never to everyone;
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

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::{Map, Value};

/// The journal's bound per extension: registrations are few (claude-code's activation is a
/// few dozen), so a backend past this is churning — later entries are dropped, not the
/// activation's.
const JOURNAL_CAP: usize = 4096;

/// The frontend every webview lives in (see the module doc).
pub const WEBVIEW_HOME: &str = "main";

/// The extensions whose webview pages are PER-FRONTEND instances (2026-10-18, the owner's
/// direction: 远程和 PC 尺寸不一样，git graph 一个 remote 是手机端页面一个是 pc 端页面，不需要
/// 同步滚动条): every frontend — the desktop window, a phone — runs its own page of the
/// view, laid out and scrolled where it lives, and the extension's pushes reach each of
/// them. Every other backend-hosted extension keeps the model below: ONE live page per
/// instance in the desktop window, with remote pages showing its copy (§22.6) — Claude
/// Code's chat keeps its conversation in its page. The ids are product knowledge, curated
/// here beside the marketplace's FEATURED list (gallery.rs); `src/` never names one.
pub fn per_frontend_webviews(ext_id: &str) -> bool {
    matches!(ext_id, "neophack.git-graph-rs")
}

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
    /// Each live webview panel (the create arguments with the title kept current, and the
    /// latest html delivered while it lives), in creation order — what a frontend that
    /// attaches later needs to open its own page of it.
    panels: Vec<PanelState>,
    /// The webview streams (a view's `view:<id>`, a panel's `panel:<ext>#<id>`) each
    /// frontend hosts a LIVE page of — its own instance of a per-frontend webview. The
    /// webview traffic a backend pushes (`webview.postMessage`, a panel's `setHtml`) is
    /// mirrored exactly to these, addressed per frontend, never broadcast: an extension
    /// the frontends show as a COPY follows the desktop's live page instead, and its
    /// traffic must not cross every phone's link only to be dropped there.
    hosted: HashMap<String, BTreeSet<String>>,
}

/// One live webview panel's replay state.
struct PanelState {
    key: String,
    create: Value,
    /// The latest `webview.setHtml` delivered while the panel lives. A frontend that
    /// attaches later replays it right after the create, so its own page of the panel
    /// boots instead of sitting blank until the backend happens to set html again.
    html: Option<String>,
}

fn routes() -> &'static Mutex<HashMap<String, ExtRoutes>> {
    static ROUTES: OnceLock<Mutex<HashMap<String, ExtRoutes>>> = OnceLock::new();
    ROUTES.get_or_init(Default::default)
}

/// Every frontend that has ever called into a backend of this instance, sticky for the
/// process's lifetime (`call_begin` adds) — the desktop `main` leads the list. What a
/// lifecycle probe reads as "the registered frontends" (§18.1): a remote that only
/// WATCHES a mirror never reaches a backend, so it is honestly absent from here.
fn seen_frontends() -> &'static Mutex<std::collections::BTreeSet<String>> {
    static SEEN: OnceLock<Mutex<std::collections::BTreeSet<String>>> = OnceLock::new();
    SEEN.get_or_init(Default::default)
}

/// The frontends the router has served, the desktop `main` first (§18.1's snapshot list).
pub fn frontends() -> Vec<String> {
    let mut out = vec![WEBVIEW_HOME.to_owned()];
    if let Ok(seen) = seen_frontends().lock() {
        out.extend(seen.iter().cloned());
    }
    out
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

/// How a delivered request mirrors to the other frontends: not at all, to everyone (a
/// registration, a panel's life, a view's html), or to the named few — webview traffic,
/// the frontends hosting a live page of the stream it addresses (their own instance of a
/// per-frontend webview).
pub enum Mirrored {
    No,
    Everyone,
    Frontends(Vec<String>),
}

/// The webview stream a TRAFFIC method addresses (`webview.setHtml` / `webview.postMessage`
/// of a panel, `webviewView.postMessage` of a view), in the frontend stream vocabulary —
/// or `None` for a method that carries none.
fn traffic_stream(ext_id: &str, method: &str, args: &Value) -> Option<String> {
    let key = args.get(0).and_then(panel_key)?;
    match method {
        "webview.setHtml" | "webview.postMessage" => Some(format!("panel:{ext_id}#{key}")),
        "webviewView.postMessage" => Some(format!("view:{key}")),
        _ => None,
    }
}

/// A frontend's call into `ext_id`'s backend begins.
pub fn call_begin(ext_id: &str, frontend: &str) -> CallGuard {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut seen) = seen_frontends().lock() {
        seen.insert(frontend.to_owned());
    }
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
        routes.panels.retain(|panel| panel.key != key)
    });
    Some(id)
}

/// A request was delivered: a panel's life (create, title, reveal, dispose) is tracked,
/// and a state-carrying request joins the journal. Answers how the other frontends mirror
/// it — a registration goes to everyone, a panel's life to everyone, webview traffic only
/// to the frontends hosting a live page of its stream (see [`Mirrored`]).
pub fn routed(ext_id: &str, method: &str, args: &Value) -> Mirrored {
    let key = args.get(0).and_then(panel_key);
    with(ext_id, |routes| {
        match (method, key.as_deref()) {
            ("webview.create", Some(key)) => {
                let key = key.to_owned();
                routes.panels.retain(|panel| panel.key != key);
                routes.panels.push(PanelState { key, create: args.clone(), html: None });
                return Mirrored::Everyone;
            }
            ("webview.setTitle", Some(key)) => {
                let title_slot = routes
                    .panels
                    .iter_mut()
                    .find(|panel| panel.key == key)
                    .and_then(|panel| panel.create.get_mut(2));
                if let (Some(slot), Some(title)) = (title_slot, args.get(1)) {
                    *slot = title.clone();
                }
                return Mirrored::Everyone;
            }
            ("webview.reveal", Some(_)) => return Mirrored::Everyone,
            ("webview.dispose", Some(key)) => {
                routes.panels.retain(|panel| panel.key != key);
                return Mirrored::Everyone;
            }
            _ => {}
        }
        // Webview traffic — the extension's pushes into a page, a panel's replacement
        // document — mirrors only to the frontends hosting a live page of the stream: a
        // frontend showing the copy follows the desktop's live page, and the traffic must
        // not cross its link only to be dropped there. The panel's html still waits in its
        // panel state for a frontend that attaches later.
        if let Some(stream) = traffic_stream(ext_id, method, args) {
            if method == "webview.setHtml" {
                if let (Some(key), Some(html)) = (key.as_deref(), args.get(1).and_then(Value::as_str)) {
                    if let Some(panel) = routes.panels.iter_mut().find(|panel| panel.key == key) {
                        panel.html = Some(html.to_owned());
                    }
                }
            }
            return Mirrored::Frontends(routes.hosting(&stream));
        }
        let Some(key) = journal_key(method, args) else {
            return Mirrored::No;
        };
        record(&mut routes.journal, key, method, args);
        Mirrored::Everyone
    })
}

impl ExtRoutes {
    /// The frontends hosting a live page of `stream`, in a stable order.
    fn hosting(&self, stream: &str) -> Vec<String> {
        self.hosted.get(stream).map(|frontends| frontends.iter().cloned().collect()).unwrap_or_default()
    }
}

/// A frontend mounted (or unmounted) its own live page of `stream` — a per-frontend
/// webview's instance in a remote session (`ext_webview_hosted`). The desktop never
/// registers: it hosts the served page itself.
pub fn webview_hosted(ext_id: &str, frontend: &str, stream: &str, up: bool) {
    with(ext_id, |routes| {
        let frontends = routes.hosted.entry(stream.to_owned()).or_default();
        if up {
            frontends.insert(frontend.to_owned());
        } else {
            frontends.remove(frontend);
            if frontends.is_empty() {
                routes.hosted.remove(stream);
            }
        }
    });
}

/// A frontend went away (its remote session ended — the Relay reports it): the live pages
/// it hosted are gone with it, and the traffic mirrors must stop addressing it.
pub fn frontend_gone(frontend: &str) {
    let mut all = routes().lock().unwrap_or_else(|p| p.into_inner());
    for routes in all.values_mut() {
        routes.hosted.retain(|_, frontends| {
            frontends.remove(frontend);
            !frontends.is_empty()
        });
    }
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
/// each live panel's `webview.create` (and the html its page boots from, when the backend
/// delivered one) at its end, so the frontend opens its own page of it.
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
            .chain(routes.panels.iter().flat_map(|panel| {
                let mut replay = vec![entry("webview.create", &panel.create)];
                if let (Some(id), Some(html)) = (panel.create.get(0), panel.html.as_deref()) {
                    replay.push(entry(
                        "webview.setHtml",
                        &Value::Array(vec![id.clone(), Value::String(html.to_owned())]),
                    ));
                }
                replay
            }))
            .collect()
    })
}

/// A fresh process for `ext_id`: its predecessor's registrations, webviews and hosted
/// pages are gone.
pub fn reset(ext_id: &str) {
    with(ext_id, |routes| {
        routes.journal.clear();
        routes.panels.clear();
        routes.hosted.clear();
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
        assert!(matches!(
            routed(ext, "webview.create", &json!([1, "view", "Git Graph", 1, false])),
            Mirrored::Everyone
        ));
        assert!(matches!(
            routed(
                ext,
                "webview.create",
                &json!([2, "claudeVSCodePanel", "Claude Code", 2, false])
            ),
            Mirrored::Everyone
        ));
        // The title a frontend attaching now opens the copy with is the current one.
        assert!(matches!(
            routed(ext, "webview.setTitle", &json!([2, "Fix the build"])),
            Mirrored::Everyone
        ));
        assert!(matches!(
            routed(ext, "webview.reveal", &json!([1])),
            Mirrored::Everyone
        ));
        // The page's own traffic mirrors to nobody until a frontend hosts a live page of
        // the stream (the copy follows the desktop's own page), and never joins the journal.
        assert!(matches!(
            routed(ext, "webview.setHtml", &json!([1, "<p>graph</p>"])),
            Mirrored::Frontends(targets) if targets.is_empty()
        ));
        assert!(matches!(
            routed(ext, "webview.postMessage", &json!([2, {}])),
            Mirrored::Frontends(targets) if targets.is_empty()
        ));
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
        assert!(matches!(
            routed(ext, "webview.dispose", &json!([1])),
            Mirrored::Everyone
        ));
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
    fn a_panels_html_rides_the_replay_behind_its_create() {
        // A frontend that attaches after the config page opened replays the create AND the
        // html its own page boots from — without the html the tab mounts blank until the
        // backend happens to set it again.
        let ext = "test.panel-html";
        reset(ext);
        routed(ext, "webview.create", &json!([3, "view", "Config", 1, false]));
        routed(ext, "webview.setHtml", &json!([3, "<p>first</p>"]));
        routed(ext, "webview.setHtml", &json!([3, "<p>second</p>"]));
        assert_eq!(
            journal(ext),
            vec![
                json!({ "method": "webview.create", "args": [3, "view", "Config", 1, false] }),
                json!({ "method": "webview.setHtml", "args": [3, "<p>second</p>"] }),
            ]
        );
    }

    #[test]
    fn webview_traffic_mirrors_only_to_the_frontends_hosting_a_live_page() {
        // The phone runs its own Git Graph page (per-frontend webviews): the backend's
        // pushes mirror to it alone, addressed — a frontend watching a COPY (the chat)
        // never carries another extension's traffic on its link, and the desktop consumes
        // the served request itself.
        let ext = "test.traffic";
        reset(ext);
        assert!(matches!(
            routed(ext, "webviewView.postMessage", &json!(["graph", { "rows": 1 }])),
            Mirrored::Frontends(targets) if targets.is_empty()
        ));
        webview_hosted(ext, "remote/7", "view:graph", true);
        webview_hosted(ext, "remote/9", "view:other", true);
        assert!(matches!(
            routed(ext, "webviewView.postMessage", &json!(["graph", { "rows": 1 }])),
            Mirrored::Frontends(targets) if targets == vec!["remote/7".to_owned()]
        ));
        // A panel's traffic addresses its own stream alone.
        webview_hosted(ext, "remote/7", "panel:test.traffic#4", true);
        assert!(matches!(
            routed(ext, "webview.postMessage", &json!([4, { "rows": 1 }])),
            Mirrored::Frontends(targets) if targets == vec!["remote/7".to_owned()]
        ));
        // The page unmounts, the session ends: the mirrors stop addressing both.
        webview_hosted(ext, "remote/7", "view:graph", false);
        frontend_gone("remote/7");
        assert!(matches!(
            routed(ext, "webviewView.postMessage", &json!(["graph", { "rows": 1 }])),
            Mirrored::Frontends(targets) if targets.is_empty()
        ));
        assert!(matches!(
            routed(ext, "webview.postMessage", &json!([4, {}])),
            Mirrored::Frontends(targets) if targets.is_empty()
        ));
    }

    #[test]
    fn the_per_frontend_curator_names_the_graph_viewer_alone() {
        assert!(per_frontend_webviews("neophack.git-graph-rs"));
        assert!(!per_frontend_webviews("Anthropic.claude-code"));
        assert!(!per_frontend_webviews("someone.else"));
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
        assert!(matches!(routed(ext,
            "commands.registerBatch",
            &json!([["a.one", "a.two"]])), Mirrored::Everyone));
        assert!(matches!(routed(ext,
            "commands.execute",
            &json!(["setContext", ["a:flag", false]])), Mirrored::Everyone));
        assert!(matches!(routed(ext, "statusbar.create", &json!(["item", 1])), Mirrored::Everyone));
        assert!(matches!(routed(ext,
            "statusbar.set",
            &json!(["item", { "text": "one", "visible": true }])), Mirrored::Everyone));
        assert!(matches!(routed(ext,
            "commands.execute",
            &json!(["setContext", ["a:flag", true]])), Mirrored::Everyone));
        assert!(matches!(routed(ext,
            "statusbar.set",
            &json!(["item", { "text": "two" }])), Mirrored::Everyone));
        assert!(matches!(routed(ext,
            "languages.registerHover",
            &json!([{ "id": "h1" }])), Mirrored::Everyone));
        // Not state: requests the journal never keeps.
        assert!(matches!(routed(ext, "notify", &json!(["info", "hi"])), Mirrored::No));
        assert!(matches!(
            routed(ext, "commands.execute", &json!(["vscode.open", []])),
            Mirrored::No
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
