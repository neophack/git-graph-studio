//! The main window's platform chrome (module 1): devtools, the boot stamps, the asset
//! revalidation hook, WebKitGTK's DMABUF compat, and the keep-awake probe helper.
//! Extracted from lib.rs's composition root (P4-1).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Process-start stamp, so boot timings from the frontend are printed against the same clock.
static BOOT: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

pub fn boot_started() -> std::time::Instant {
    *BOOT.get_or_init(std::time::Instant::now)
}

/// One backend boot stamp, in the line format `scripts/boot-bench.mjs` parses:
/// `[boot] <stage>: +<ms> ms since process start`.
pub fn stamp(stage: &str) {
    println!(
        "[boot] {stage}: +{:.0} ms since process start",
        boot_started().elapsed().as_secs_f64() * 1000.0
    );
}

/// The automated harness runs' App Nap guard (macOS): an occluded or napping WKWebView
/// stops firing page timers, so the dev harness's bounded waits — and their timeouts —
/// stall for wall-clock minutes (the sandbox probe froze exactly there, at 0% CPU).
/// An NSProcessInfo activity assertion plus an always-on-top window keeps the run
/// alive to completion. Debug builds only, and only when a probe asked for the harness.
/// `pub` for lib.rs's run loop (same cfg there); every other target compiles neither
/// half.
#[cfg(all(debug_assertions, target_os = "macos"))]
pub fn keep_awake_for_probe_runs(window: &tauri::WebviewWindow) {
    let activity = hold_activity("ggs dev-harness probe run (GGS_DEV_HARNESS)");
    std::mem::forget(activity); // held for the process lifetime — endActivity never comes
    let _ = window.set_always_on_top(true);
}

/// One App Nap exclusion assertion (macOS): the same failure mode the probe guard above
/// documents, as the shipping Remote Access path — while remote sessions ride this
/// instance the app is exactly what macOS naps (the Relay webview is hidden by design,
/// the desktop window may be hidden too), and a napped process stalls the workbench
/// timers behind the Relay's coalescing windows, so the remote runs in lurches. Held for
/// the Relay webview's lifetime; `UserInitiatedAllowingIdleSystemSleep` so a session left
/// open in a browser tab never keeps the machine itself from sleeping. Unlike the probe
/// guard this is release too — the remote is the product here. No-op off macOS.
#[cfg(target_os = "macos")]
pub fn remote_sessions_awake(awake: bool) {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    /// The begin/end activity token. `Send` by hand for its one job — crossing from the
    /// control-channel thread that began it to whichever ends it.
    ///
    /// SAFETY: the token is an opaque NSObject with no thread affinity. Apple's activity
    /// API takes begin and end on any thread (NSProcessInfo itself is thread-safe, and
    /// the token is only ever fed back to `endActivity:`), so moving it between threads
    /// is what the API is designed for; objc2's blanket non-`Send` is conservatism about
    /// ObjC objects at large, not a real constraint here.
    struct Token(objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_foundation::NSObjectProtocol>>);
    unsafe impl Send for Token {}

    static HELD: std::sync::Mutex<Option<Token>> = std::sync::Mutex::new(None);
    let mut held = HELD.lock().unwrap_or_else(|p| p.into_inner());
    if awake {
        if held.is_none() {
            let reason = NSString::from_str("ggs remote sessions attached");
            *held = Some(Token(
                NSProcessInfo::processInfo().beginActivityWithOptions_reason(
                    NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
                    &reason,
                ),
            ));
        }
    } else if let Some(activity) = held.take() {
        // SAFETY: the object is exactly what beginActivityWithOptions_reason returned.
        unsafe {
            NSProcessInfo::processInfo().endActivity(&activity.0);
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn remote_sessions_awake(_awake: bool) {}

#[cfg(all(debug_assertions, target_os = "macos"))]
fn hold_activity(
    reason: &str,
) -> objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_foundation::NSObjectProtocol>> {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    // UserInitiated — the probe's own bar: nothing stalls a harness run, idle sleep
    // included. The remote path (remote_sessions_awake above) is the gentler variant.
    NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        NSActivityOptions::UserInitiated,
        &NSString::from_str(reason),
    )
}

/// The Help menu's "Open Developer Tools" entry: the webview's own context menu is
/// suppressed (it otherwise shows the host browser's chrome - back/refresh/save as/print),
/// so this is the only way left to reach devtools once installed.
#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

#[tauri::command]
pub fn boot_stage(stage: String, page_ms: f64) {
    let line = format!(
        "[boot] {stage}: +{:.0} ms since process start (page: {:.0} ms)\n",
        boot_started().elapsed().as_secs_f64() * 1000.0,
        page_ms
    );
    print!("{line}");
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("git-graph-studio-boot.log"))
        .and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()));
}

/// The main window's liveness watcher (2026-10-27, the gray-window hang): two failure
/// modes together leave the desktop window a gray rectangle the only way out of which is
/// killing the process.
///
///  * The WebView2 renderer process dies — long-running sessions, memory exhaustion —
///    and wry (0.57) never subscribes `ICoreWebView2::ProcessFailed`: nothing notices,
///    nothing recovers, the page is gray forever.
///  * The close is entirely the page's to perform: Tauri's manager prevents the native
///    close the moment a `tauri://close-requested` JS listener exists
///    (`if window.has_js_listener(..) { api.prevent_close(); }` — tauri 2.12's
///    manager/window.rs) and the JS wrapper then drives the destroy itself. A dead page
///    can run neither half, so the X button does nothing, ever.
///
/// The watcher answers both. The sweep thread probes the page on a period — the page
/// answers through the `webview_beat` command — and two consecutive silent probes reload
/// the window (the only recovery a crashed renderer allows; §17's never-reload invariant
/// covers show/hide, and a page that answers nothing has no state left to keep). And
/// every close request must be acked (`window_close_ack`, the handler's first statement
/// in boot.ts, before any await) within a short grace; an unacked request means the page
/// cannot run the handler at all, and Rust performs the close itself — hiding the window
/// when remote sessions still ride the instance (the page policy's own move), destroying
/// it otherwise.
const PROBE_PERIOD: Duration = Duration::from_secs(20);
/// One probe's deadline: a period plus slack — a healthy page answers in milliseconds, so
/// an expired probe means the page could not run the answer, not that it was slow.
const PROBE_DEADLINE: Duration = Duration::from_secs(21);
/// The grace an unacked close request waits before Rust performs the close itself.
const CLOSE_GRACE: Duration = Duration::from_secs(4);
/// Reloads with no answered probe in between before the sweep stands down: a page that
/// dies before its first beat would otherwise be reloaded forever.
const MAX_RELOAD_STRIKES: u32 = 5;
/// The probe script, eval'd into the main window's page: the workbench's own hook
/// (`__ggsAliveProbe`, main.ts) when present, Tauri's injected IPC bridge on any other
/// page this webview shows (the dev harness), and nothing to execute at all where the
/// renderer itself is gone — which is exactly the silence the sweep judges.
const PROBE_JS: &str = "window.__ggsAliveProbe?window.__ggsAliveProbe():window.__TAURI_INTERNALS__&&window.__TAURI_INTERNALS__.invoke('webview_beat')";

/// What one sweep tick decided to do.
#[derive(Debug, PartialEq, Eq)]
enum TickAction {
    /// The in-flight probe still has time on its deadline; nothing to do.
    Wait,
    /// No probe is in flight (or the previous one just expired): eval one into the page.
    Probe,
    /// Two consecutive probes went unanswered: the page is dead or hung — reload it.
    Reload,
}

/// The liveness state machine the sweep thread drives. Pure bookkeeping — the actions are
/// the caller's to perform, so the tests drive this with a synthetic clock.
#[derive(Default)]
struct Liveness {
    probe_issued: Option<Instant>,
    misses: u32,
    reload_strikes: u32,
    exhausted: bool,
}

impl Liveness {
    fn tick(&mut self, now: Instant) -> TickAction {
        if self.exhausted {
            return TickAction::Wait;
        }
        if let Some(issued) = self.probe_issued {
            if now.duration_since(issued) < PROBE_DEADLINE {
                return TickAction::Wait;
            }
            self.misses += 1;
            self.probe_issued = None;
            // Two consecutive misses, not one: a single silent probe is also what a
            // machine that slept through its deadline looks like on wake, and the probe
            // issued after the wake is answered by the very same healthy page.
            if self.misses >= 2 {
                self.misses = 0;
                self.reload_strikes += 1;
                self.exhausted = self.reload_strikes >= MAX_RELOAD_STRIKES;
                return TickAction::Reload;
            }
        }
        self.probe_issued = Some(now);
        TickAction::Probe
    }

    /// The page proved itself alive: the in-flight probe is answered, and the misses and
    /// the reload strikes all start over.
    fn beat(&mut self) {
        self.probe_issued = None;
        self.misses = 0;
        self.reload_strikes = 0;
    }

    /// The sweep cannot judge the page this tick — devtools paused on a breakpoint, a
    /// hidden window on macOS (App Nap stalls injected tasks exactly like page timers).
    /// The clock starts over rather than charging the silence to the page.
    fn hold(&mut self) {
        self.probe_issued = None;
        self.misses = 0;
    }
}

/// The close-request bookkeeping behind the atomics: generations of requests, each
/// satisfied by an ack that proves the page alive (the handlers for queued close events
/// run back to back, so one ack covers every request already delivered, and none
/// delivered after it).
fn ack_next(acked: u64, requested: u64) -> u64 {
    acked.max(requested)
}
fn ack_covers(acked: u64, generation: u64) -> bool {
    acked >= generation
}

static LIVENESS: Mutex<Liveness> = Mutex::new(Liveness {
    probe_issued: None,
    misses: 0,
    reload_strikes: 0,
    exhausted: false,
});
static CLOSE_REQUESTED: AtomicU64 = AtomicU64::new(0);
static CLOSE_ACKED: AtomicU64 = AtomicU64::new(0);

fn with_liveness<R>(apply: impl FnOnce(&mut Liveness) -> R) -> R {
    let mut guard = LIVENESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    apply(&mut guard)
}

/// The run loop's word that the main window's close was requested: starts the grace
/// watchdog that performs the close the page cannot (see the section comment above).
pub fn note_close_requested(app: tauri::AppHandle) {
    let generation = CLOSE_REQUESTED.fetch_add(1, Ordering::Relaxed) + 1;
    std::thread::Builder::new()
        .name("ggs-close-watchdog".to_owned())
        .spawn(move || {
            std::thread::sleep(CLOSE_GRACE);
            if ack_covers(CLOSE_ACKED.load(Ordering::Relaxed), generation) {
                return;
            }
            use tauri::Manager;
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            // The page policy's own move when remote sessions ride the instance
            // (boot.ts's handler): hide, keep the instance alive — the sweep reloads the
            // hidden dead page back to life on platforms that probe hidden windows.
            if crate::remote_host::session_count() > 0 || crate::remote_host::remote_host_only() {
                eprintln!(
                    "[webview] a close request went unacked for {CLOSE_GRACE:?} — the page is dead or hung; hiding the window for its remote sessions"
                );
                let _ = crate::remote_host::remote_host_hide_main(app.clone());
                return;
            }
            eprintln!(
                "[webview] a close request went unacked for {CLOSE_GRACE:?} — the page is dead or hung; destroying the window"
            );
            let _ = window.destroy();
        })
        .expect("the close watchdog thread starts");
}

/// The close handler's first word from the page (boot.ts), before any await: proof the
/// page is alive and handling the request, which stands the watchdog down.
#[tauri::command]
pub fn window_close_ack() {
    let acked = ack_next(
        CLOSE_ACKED.load(Ordering::Relaxed),
        CLOSE_REQUESTED.load(Ordering::Relaxed),
    );
    CLOSE_ACKED.store(acked, Ordering::Relaxed);
}

/// The page's answer to a liveness probe (or any other proof of life it cares to send).
#[tauri::command]
pub fn webview_beat() {
    with_liveness(|state| state.beat());
}

/// The sweep thread, started once from the composition root's setup. One probe per
/// period into the main window's page; the reload decision is the state machine's.
pub fn start_liveness_sweep(app: tauri::AppHandle) {
    std::thread::Builder::new()
        .name("ggs-webview-liveness".to_owned())
        .spawn(move || loop {
            std::thread::sleep(PROBE_PERIOD);
            use tauri::Manager;
            let Some(window) = app.get_webview_window("main") else {
                continue;
            };
            // Devtools paused on a breakpoint freezes the page's scripts on purpose; a
            // hidden window on macOS is napped (WKWebView suspends it) and App Nap
            // stalls injected tasks exactly like the page timers window.rs documents
            // elsewhere. Silence proves nothing in either case.
            if window.is_devtools_open()
                || (cfg!(target_os = "macos") && !window.is_visible().unwrap_or(true))
            {
                with_liveness(|state| state.hold());
                continue;
            }
            match with_liveness(|state| state.tick(Instant::now())) {
                TickAction::Wait => {}
                TickAction::Probe => {
                    let _ = window.eval(PROBE_JS);
                }
                TickAction::Reload => {
                    eprintln!(
                        "[webview] the main window's page answered no liveness probe — reloading it (a dead renderer stays gray otherwise)"
                    );
                    let _ = window.reload();
                }
            }
        })
        .expect("the webview liveness sweep thread starts");
}

/// Lets the webview keep the app's assets between launches. Tauri serves every asset
/// from the binary with no caching headers, so each launch fetches, parses and compiles
/// the workbench, CodeMirror and the graph view's bundle afresh. With `no-cache` plus a
/// content ETag, every request still reaches this handler (an in-process round trip),
/// but an unchanged asset is answered 304 without its body: the browser reuses its
/// copy and, for a script, the bytecode it compiled from it on an earlier launch. An
/// upgraded asset changes its ETag and is fetched whole, so nothing stale ever runs.
pub fn revalidate_assets(
    request: tauri::http::Request<Vec<u8>>,
    response: &mut tauri::http::Response<std::borrow::Cow<'static, [u8]>>,
) {
    use std::hash::{Hash, Hasher};
    use tauri::http::{header, StatusCode};
    if response.status() != StatusCode::OK {
        return;
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    response.body().hash(&mut hasher);
    let etag = format!("\"{:016x}\"", hasher.finish());
    let unchanged = request
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|tag| tag.trim() == etag));
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-cache"),
    );
    if let Ok(value) = header::HeaderValue::from_str(&etag) {
        headers.insert(header::ETAG, value);
    }
    if unchanged {
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        *response.body_mut() = std::borrow::Cow::Borrowed(&[]);
    }
}

#[cfg(not(target_os = "linux"))]
pub fn apply_webkit_compat() {}

/// The `linuxDmabuf` setting as written by the Settings form; anything the
/// form does not produce (missing file, bad JSON, unknown value) is `auto`.
#[cfg(target_os = "linux")]
fn linux_dmabuf_mode(settings: Option<&str>) -> String {
    settings
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|value| {
            value
                .get("linuxDmabuf")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "auto".to_owned())
}

/// `auto` disables DMABUF only on NVIDIA-driver machines; `disable` always;
/// `keep` (and any unknown value) never.
#[cfg(target_os = "linux")]
fn should_disable_dmabuf(mode: &str, nvidia_driver: bool) -> bool {
    match mode {
        "disable" => true,
        "auto" => nvidia_driver,
        _ => false,
    }
}

/// WebKitGTK's DMABUF renderer fails on machines whose X server runs on the
/// NVIDIA proprietary driver: GBM falls back from the broken EGL-GBM image
/// allocation to KMS dumb buffers, which a render node cannot create
/// (EACCES), leaving the window black. Like RustDesk's
/// `allow-always-software-render` option, the behaviour is driven by a user
/// setting (`linuxDmabuf` in `~/.ggs/settings.json`, taking effect on the
/// next launch): `auto` disables DMABUF only when the NVIDIA driver is
/// detected, `disable` always disables it, `keep` never touches it. An
/// environment variable set by the user always wins over everything.
#[cfg(target_os = "linux")]
pub fn apply_webkit_compat() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some()
        || std::env::var_os("EGL_VENDOR_LIBRARY_FILENAMES").is_some()
    {
        return;
    }
    // The `~/.ggs` layout — `GGS_HOME` relocation included — is computed in exactly
    // one place, ggs_base::paths; `mod desktop`'s same-named helper is its Windows-gated
    // wrapper, unreachable (and unneeded) from this linux-only function.
    let settings_text =
        std::fs::read_to_string(ggs_base::paths::settings_file().unwrap_or_default()).ok();
    let mode = linux_dmabuf_mode(settings_text.as_deref());
    let nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists();
    if should_disable_dmabuf(&mode, nvidia) {
        // Must run before the webview picks its renderer; we are first in
        // `run`, so no threads have spawned yet.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

#[cfg(all(test, target_os = "linux"))]
mod webkit_compat_tests {
    use super::{linux_dmabuf_mode, should_disable_dmabuf};

    #[test]
    fn mode_falls_back_to_auto() {
        assert_eq!(linux_dmabuf_mode(None), "auto");
        assert_eq!(linux_dmabuf_mode(Some("not json")), "auto");
        assert_eq!(linux_dmabuf_mode(Some("{}")), "auto");
        assert_eq!(
            linux_dmabuf_mode(Some(r#"{"linuxDmabuf":"disable"}"#)),
            "disable"
        );
        assert_eq!(linux_dmabuf_mode(Some(r#"{"linuxDmabuf":42}"#)), "auto");
    }

    #[test]
    fn auto_disables_only_on_nvidia() {
        assert!(should_disable_dmabuf("auto", true));
        assert!(!should_disable_dmabuf("auto", false));
        assert!(should_disable_dmabuf("disable", false));
        assert!(!should_disable_dmabuf("keep", true));
    }
}

#[cfg(test)]
mod liveness_tests {
    use super::{ack_covers, ack_next, Liveness, TickAction, MAX_RELOAD_STRIKES};
    use std::time::{Duration, Instant};

    /// The synthetic clock: `at(n)` is n seconds past the sweep's epoch.
    fn at(seconds: u64) -> Instant {
        Instant::now() + Duration::from_secs(seconds)
    }

    #[test]
    fn a_probe_waits_out_its_deadline() {
        let mut state = Liveness::default();
        assert_eq!(state.tick(at(0)), TickAction::Probe);
        assert_eq!(state.tick(at(19)), TickAction::Wait);
    }

    #[test]
    fn two_silent_probes_reload_but_one_does_not() {
        let mut state = Liveness::default();
        assert_eq!(state.tick(at(0)), TickAction::Probe);
        // The first expiry only re-probes: one silent probe is also what a machine that
        // slept through its deadline looks like on wake, and the re-probe is answered.
        assert_eq!(state.tick(at(21)), TickAction::Probe);
        assert_eq!(state.tick(at(42)), TickAction::Reload);
    }

    #[test]
    fn a_late_beat_resets_the_misses() {
        let mut state = Liveness::default();
        state.tick(at(0));
        state.tick(at(21)); // miss 1, re-probe issued
        state.beat();
        // The next tick starts a fresh probe, not a reload.
        assert_eq!(state.tick(at(42)), TickAction::Probe);
        assert_eq!(state.tick(at(63)), TickAction::Probe);
    }

    #[test]
    fn the_sweep_stands_down_after_reload_strikes_without_a_single_beat() {
        let mut state = Liveness::default();
        for round in 0..MAX_RELOAD_STRIKES {
            let base = u64::from(round) * 60;
            state.tick(at(base));
            state.tick(at(base + 21));
            assert_eq!(state.tick(at(base + 42)), TickAction::Reload);
        }
        assert_eq!(state.tick(at(600)), TickAction::Wait);
    }

    #[test]
    fn a_beat_between_reloads_resets_the_strikes() {
        let mut state = Liveness::default();
        for _ in 0..(MAX_RELOAD_STRIKES + 1) {
            state.tick(at(0));
            state.tick(at(21));
            assert_eq!(state.tick(at(42)), TickAction::Reload);
            state.beat(); // the reloaded page answered its first probe
        }
        // Never exhausted: every reload was followed by proof the new page lives.
        assert_eq!(state.tick(at(1200)), TickAction::Probe);
    }

    #[test]
    fn an_ack_covers_every_request_delivered_before_it_and_none_after() {
        let mut acked = 0;
        let first = 1u64;
        assert!(!ack_covers(acked, first));
        acked = ack_next(acked, first);
        assert!(ack_covers(acked, first));
        // A second click queued behind the first: the handlers run back to back, so the
        // single ack (the page is alive) satisfies both.
        let second = 2u64;
        assert!(!ack_covers(acked, second));
        acked = ack_next(acked, second);
        assert!(ack_covers(acked, second));
        assert!(ack_covers(acked, first)); // the older generation stays satisfied
    }
}

#[cfg(test)]
mod asset_cache_tests {
    use super::*;
    use std::borrow::Cow;
    use tauri::http::{header, Request, Response, StatusCode};

    fn asset(body: &'static [u8]) -> Response<Cow<'static, [u8]>> {
        Response::builder()
            .status(200)
            .body(Cow::Borrowed(body))
            .unwrap()
    }

    #[test]
    fn an_unchanged_asset_is_answered_304_and_a_changed_one_whole() {
        let body: &[u8] = b"console.log('workbench')";
        let mut first = asset(body);
        revalidate_assets(Request::builder().body(Vec::new()).unwrap(), &mut first);
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(first.headers()[header::CACHE_CONTROL], "no-cache");
        let etag = first.headers()[header::ETAG].to_str().unwrap().to_owned();
        assert!(etag.starts_with('"') && etag.ends_with('"'));

        let revalidate = || {
            Request::builder()
                .header(header::IF_NONE_MATCH, &etag)
                .body(Vec::new())
                .unwrap()
        };
        let mut same = asset(body);
        revalidate_assets(revalidate(), &mut same);
        assert_eq!(same.status(), StatusCode::NOT_MODIFIED);
        assert!(same.body().is_empty());

        let mut changed = asset(b"console.log('workbench v2')");
        revalidate_assets(revalidate(), &mut changed);
        assert_eq!(changed.status(), StatusCode::OK);
        assert_ne!(changed.headers()[header::ETAG], etag.as_str());
        assert!(!changed.body().is_empty());

        // An error response is left alone.
        let mut missing = Response::builder()
            .status(404)
            .body(Cow::Borrowed(&b""[..]))
            .unwrap();
        revalidate_assets(revalidate(), &mut missing);
        assert!(missing.headers().get(header::ETAG).is_none());
    }
}
