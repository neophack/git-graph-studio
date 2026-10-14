//! The main window's platform chrome (module 1): devtools, the boot stamps, the asset
//! revalidation hook, WebKitGTK's DMABUF compat, and the keep-awake probe helper.
//! Extracted from lib.rs's composition root (P4-1).

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
#[cfg(all(debug_assertions, target_os = "macos"))]
fn keep_awake_for_probe_runs(window: &tauri::WebviewWindow) {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    let reason = NSString::from_str("ggs dev-harness probe run (GGS_DEV_HARNESS)");
    let activity = NSProcessInfo::processInfo()
        .beginActivityWithOptions_reason(NSActivityOptions::UserInitiated, &reason);
    std::mem::forget(activity); // held for the process lifetime — endActivity never comes
    let _ = window.set_always_on_top(true);
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
    let settings_text = std::fs::read_to_string(settings_file().unwrap_or_default()).ok();
    let mode = linux_dmabuf_mode(settings_text.as_deref());
    let nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists();
    if should_disable_dmabuf(&mode, nvidia) {
        // Must run before the webview picks its renderer; we are first in
        // `run`, so no threads have spawned yet.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}
