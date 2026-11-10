//! The extension marketplace: the featured packages and one-click install over Open VSX's
//! public REST API — the registry the open-source VS Code ecosystem runs on (code-server
//! and Theia point here too), so a VSIX published anywhere in that ecosystem installs with
//! the same rules as a local file. The Extensions view offers exactly the [`FEATURED`]
//! packages (no free-text search — the owner's direction, 2026-09-27), each looked up by
//! exact id for THIS machine's target platform. The commands, all network-confined:
//! `ext_gallery_featured` / `ext_gallery_lookup` resolve ids to entries,
//! `ext_gallery_search` queries, `ext_gallery_asset` fetches an entry's icon (base64,
//! capped), and `ext_gallery_install` downloads the `.vsix` — streaming its progress
//! (bytes received, total, the recent speed, the remaining time) to the caller through a
//! [`GalleryProgress`] report, cancellable mid-body — and hands it to
//! [`crate::cmd_ext`]'s ordinary install path — the same manifest validation,
//! forward-only upgrades and unhostable-`.node` rejection a picked file meets.
//! The extension packages download from nowhere else: a GitHub-released `.vsix` beside
//! the installers could mismatch the running app, so the plugins ride the registry and
//! the installer's bundled packages only (2026-11-10, the owner's direction) — GitHub
//! serves THIS APPLICATION's updates, and this module lends the app update its raw
//! release fetch, its mirror rewrite and the streaming download below.
//!
//! Every URL a command touches is confined to the gallery's own origin (same scheme,
//! same host): the commands can neither fetch nor install from anywhere else, so a
//! crafted answer from the registry cannot turn the app into a downloader for arbitrary
//! hosts. The gallery base defaults to <https://open-vsx.org>; the commands accept an
//! override so a self-hosted registry can be pointed at later.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// The default marketplace: the public Open VSX registry.
pub const DEFAULT_GALLERY: &str = "https://open-vsx.org";
/// The packages the Extensions view offers, in display order — the only marketplace
/// entries it shows. Named here, beside `cmd_ext`'s bundled-package registry, so the
/// frontend names no plugin id (plan §3.2).
pub const FEATURED: &[&str] = &["Anthropic.claude-code", "neophack.git-graph-rs"];
/// The GitHub REST API the app's own update check rides (`repos/{repo}/releases/latest`).
/// The extension packages themselves download from nowhere but the registry and the
/// installer's bundled packages (2026-11-10, the owner's direction: ggs-remote.vsix
/// downloaded beside the installers could mismatch the running app — the plugin ships
/// only with the installer, whose boot pass upgrades it in lockstep).
pub const GITHUB_API: &str = "https://api.github.com";
/// The search page size — enough to fill the Extensions view without a second page.
const SEARCH_SIZE: u32 = 20;
/// One metadata request's ceiling — a search, a lookup, an icon: answers small enough
/// that twenty seconds means the link is down. A `.vsix` download does not share it; it
/// runs on the download ceilings below.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// A `.vsix` body's own budget: a platform build runs past a hundred megabytes
/// (claude-code's win32-x64 package is 115 MB — 41 s at full speed, but minutes on a
/// slow link) and the metadata ceiling once killed its install mid-body ("read the
/// marketplace answer: timeout").
const DOWNLOAD_BODY_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// The download's end-to-end backstop (DNS through the last byte), beyond the body
/// budget so the body keeps every minute it was given while a dead connect still fails
/// at its own 20 s.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// The icon cap: an extension icon is a few KB; anything megabyte-sized is not an icon.
pub const ASSET_CAP: usize = 2 * 1024 * 1024;
/// How often a download reports: one tick per 64 KiB chunk would flood the IPC wire —
/// the toast moves every 200 ms instead, plus one final tick with the complete size.
const REPORT_CADENCE: Duration = Duration::from_millis(200);
/// The speed window: the displayed speed and ETA come from the last few seconds'
/// samples, so a link that slows down moves the estimate instead of averaging it away.
const SPEED_WINDOW: Duration = Duration::from_secs(5);
/// The download's cancel answer: the report callback refused — the receiver is gone, or
/// the toast's Cancel ran — and the half-written package was removed.
const CANCELLED_MESSAGE: &str = "the download was cancelled";

/// One marketplace search result, as the Extensions view renders it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GalleryEntry {
    /// `{namespace}.{name}` — the same shape as an installed extension's id.
    pub id: String,
    pub name: String,
    pub namespace: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub version: String,
    pub download_count: u64,
    pub average_rating: Option<f64>,
    pub verified: bool,
    /// First-publish / last-update time, ISO 8601.
    pub timestamp: String,
    /// The icon's URL (gallery origin), when the listing carries one.
    pub icon_url: Option<String>,
    /// The `.vsix` download URL (gallery origin) — what `ext_gallery_install` takes.
    pub download_url: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GallerySearch {
    /// The registry's total match count (the view shows "of N").
    pub total_size: u64,
    pub entries: Vec<GalleryEntry>,
}

/// One download's progress tick, as the Extensions view's toast renders it.
#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GalleryProgress {
    /// Bytes written to the temp copy so far.
    pub received: u64,
    /// The body's total size (the answer's Content-Length), when the server sent one —
    /// null on a chunked answer, where the toast runs without a total.
    pub total: Option<u64>,
    /// The recent speed in bytes per second — the last [`SPEED_WINDOW`]'s samples, not
    /// the whole download's average. Zero while the window holds a single sample.
    pub bps: u64,
    /// Seconds left at the recent speed, when the total is known and something remains.
    pub eta_secs: Option<u64>,
}

/// The download loop's reporting brain: it keeps one `(instant, received)` sample per
/// report — a tick at most every [`REPORT_CADENCE`], the first chunk's own included —
/// and reads the speed off the last [`SPEED_WINDOW`] of those samples and the ETA off
/// that speed. A landing between reports is answered nothing and kept by nothing.
#[derive(Default)]
pub(crate) struct ProgressMeter {
    /// `(instant, bytes received)` samples, the ones past the window dropped.
    samples: VecDeque<(Instant, u64)>,
    last_report: Option<Instant>,
}

impl ProgressMeter {
    /// Feed one chunk's landing. `Some` when a report is due — the first chunk's own
    /// tick included, so the bar starts moving at once.
    fn sample(&mut self, now: Instant, received: u64, total: Option<u64>) -> Option<GalleryProgress> {
        if !self.last_report.is_none_or(|at| now.duration_since(at) >= REPORT_CADENCE) {
            return None;
        }
        self.last_report = Some(now);
        Some(self.tick(now, received, total))
    }

    /// The final tick: the complete size, whatever the cadence says.
    fn finish(&mut self, now: Instant, received: u64, total: Option<u64>) -> GalleryProgress {
        self.tick(now, received, total)
    }

    fn tick(&mut self, now: Instant, received: u64, total: Option<u64>) -> GalleryProgress {
        self.samples.push_back((now, received));
        while matches!(self.samples.front(), Some(&(at, _)) if now.duration_since(at) > SPEED_WINDOW) {
            self.samples.pop_front();
        }
        let bps = match (self.samples.front(), self.samples.back()) {
            (Some(&(start, from)), Some(&(end, to))) if end > start => {
                ((to - from) as f64 / end.duration_since(start).as_secs_f64()) as u64
            }
            _ => 0,
        };
        let eta_secs = match (total, bps) {
            (Some(total), bps) if total > received && bps > 0 => {
                Some((((total - received) as f64) / (bps as f64)).ceil() as u64)
            }
            _ => None,
        };
        GalleryProgress {
            received,
            total,
            bps,
            eta_secs,
        }
    }
}

/* ---------- Open VSX's wire shapes ---------- */

#[derive(Deserialize, Debug)]
struct OvsxSearch {
    #[serde(rename = "totalSize", default)]
    total_size: u64,
    #[serde(default)]
    extensions: Vec<OvsxExtension>,
}

#[derive(Deserialize, Debug)]
struct OvsxExtension {
    #[serde(default)]
    name: String,
    #[serde(default)]
    namespace: String,
    #[serde(default)]
    version: String,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(rename = "downloadCount", default)]
    download_count: u64,
    #[serde(rename = "averageRating", default)]
    average_rating: Option<f64>,
    #[serde(default)]
    verified: bool,
    #[serde(default)]
    timestamp: String,
    #[serde(default)]
    files: OvsxFiles,
}

#[derive(Deserialize, Debug, Default)]
struct OvsxFiles {
    download: Option<String>,
    icon: Option<String>,
}

/// The gallery base URL as the commands use it: trimmed, https (a marketplace reached
/// over plain http would let anything on the wire stand in for a package).
pub fn gallery_url(gallery: Option<String>) -> Result<String, String> {
    let base = gallery.unwrap_or_else(|| DEFAULT_GALLERY.to_owned());
    let trimmed = base.trim().trim_end_matches('/').to_owned();
    if !trimmed.starts_with("https://") || trimmed.len() == "https://".len() {
        return Err(format!("the marketplace URL must be https: {base}"));
    }
    Ok(trimmed)
}

/// The `host[:port]` of an https URL ("" when the URL is not one): enough origin to
/// compare, without pulling a URL crate in for two string splits.
fn authority_of(url: &str) -> &str {
    let Some(rest) = url.strip_prefix("https://") else {
        return "";
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    &rest[..end]
}

/// `url` must sit on the gallery's own origin — see the module doc.
fn confined(base: &str, url: &str) -> Result<String, String> {
    let url = url.trim();
    let origin = authority_of(base);
    if origin.is_empty() || authority_of(url) != origin {
        return Err(format!("refusing a non-marketplace URL: {url}"));
    }
    Ok(url.to_owned())
}

/// Percent-encode a query value (RFC 3986 unreserved characters pass through).
fn encode_query(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The Open VSX target platform of this machine (`win32-x64`, `linux-arm64`, …) — the
/// spelling `vsce package --target` and the registry share. None on a platform the
/// registry has no target for; the search then asks for universal packages only.
pub fn host_target_platform() -> Option<&'static str> {
    use std::env::consts::{ARCH, OS};
    // A musl build runs on Alpine, whose packages the registry keeps apart (a glibc
    // `linux-x64` binary does not load there).
    let musl = cfg!(target_env = "musl");
    Some(match (OS, ARCH) {
        ("linux", "x86_64") if musl => "alpine-x64",
        ("linux", "aarch64") if musl => "alpine-arm64",
        ("windows", "x86_64") => "win32-x64",
        ("windows", "aarch64") => "win32-arm64",
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("linux", "arm") => "linux-armhf",
        ("macos", "x86_64") => "darwin-x64",
        ("macos", "aarch64") => "darwin-arm64",
        _ => return None,
    })
}

/// The search endpoint URL. `targetPlatform` asks the registry for the universal
/// packages plus the builds of THIS machine's platform — ggs-node hosts a package's
/// N-API `.node` addon, so a platform build (a language server, a native engine) is
/// installable here; an other-platform build would carry binaries this machine cannot
/// load, and the search does not offer it.
fn search_url(base: &str, query: &str) -> String {
    let target = host_target_platform().unwrap_or("universal");
    format!(
        "{base}/api/-/search?query={}&size={SEARCH_SIZE}&targetPlatform={target}",
        encode_query(query)
    )
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(REQUEST_TIMEOUT))
        .build()
        .into()
}

/// The `.vsix` download's agent: a connect that still fails fast, a body budget sized
/// for a hundred-megabyte package on a slow link, and an end-to-end backstop — never
/// the metadata requests' 20 s global ceiling.
fn download_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(REQUEST_TIMEOUT))
        .timeout_recv_body(Some(DOWNLOAD_BODY_TIMEOUT))
        .timeout_global(Some(DOWNLOAD_TIMEOUT))
        .build()
        .into()
}

/// GET `url` (confined to the gallery origin) and return its body.
pub fn get(base: &str, url: &str) -> Result<Vec<u8>, String> {
    let url = confined(base, url)?;
    let mut response = agent()
        .get(&url)
        .call()
        .map_err(|e| format!("request to the marketplace failed: {e}"))?;
    response
        .body_mut()
        .read_to_vec()
        .map_err(|e| format!("read the marketplace answer: {e}"))
}

/// One registry listing as the view's entry. A listing without a `files.download` is not
/// installable here — None, never a dead row.
fn entry_of(extension: OvsxExtension) -> Option<GalleryEntry> {
    let download = extension.files.download?;
    if extension.name.is_empty() || extension.namespace.is_empty() {
        return None;
    }
    Some(GalleryEntry {
        id: format!("{}.{}", extension.namespace, extension.name),
        name: extension.name,
        namespace: extension.namespace,
        display_name: extension.display_name,
        description: extension.description,
        version: extension.version,
        download_count: extension.download_count,
        average_rating: extension.average_rating,
        verified: extension.verified,
        timestamp: extension.timestamp,
        icon_url: extension.files.icon,
        download_url: download,
    })
}

/// The registry's answer as the view's entries (listings without a download skipped).
fn search_map(parsed: OvsxSearch) -> GallerySearch {
    let entries = parsed.extensions.into_iter().filter_map(entry_of).collect();
    GallerySearch {
        total_size: parsed.total_size,
        entries,
    }
}

/// Run one search against the registry.
pub fn search(base: &str, query: &str) -> Result<GallerySearch, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(GallerySearch {
            total_size: 0,
            entries: Vec::new(),
        });
    }
    let bytes = get(base, &search_url(base, query))?;
    let parsed: OvsxSearch = serde_json::from_slice(&bytes)
        .map_err(|e| format!("the marketplace's answer is not valid JSON: {e}"))?;
    Ok(search_map(parsed))
}

/// `{namespace}.{name}` split at its first dot, both halves non-empty and made only of
/// what a URL path segment carries literally.
fn split_id(id: &str) -> Result<(&str, &str), String> {
    let (namespace, name) = id
        .trim()
        .split_once('.')
        .ok_or_else(|| format!("not an extension id: {id}"))?;
    let segment_ok = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
    };
    if !segment_ok(namespace) || !segment_ok(name) {
        return Err(format!("not an extension id: {id}"));
    }
    Ok((namespace, name))
}

/// The per-platform listing URLs to try for one id, most specific first: this machine's
/// target build, then the universal one. The bare `/api/{ns}/{name}` is never asked — it
/// answers with whichever platform the registry picks (for a platform-split package, e.g.
/// an `alpine-arm64` build on a Windows machine), whose binaries cannot load here.
fn lookup_urls(base: &str, namespace: &str, name: &str) -> Vec<String> {
    let mut urls = Vec::new();
    if let Some(target) = host_target_platform() {
        urls.push(format!("{base}/api/{namespace}/{name}/{target}"));
    }
    urls.push(format!("{base}/api/{namespace}/{name}/universal"));
    urls
}

/// Resolve one exact id to its entry for this machine. A 404 on the target build falls
/// through to the universal one; any other failure (offline, 5xx) is the answer — trying
/// on would mask it as "not found".
pub fn lookup(base: &str, id: &str) -> Result<GalleryEntry, String> {
    let (namespace, name) = split_id(id)?;
    for url in lookup_urls(base, namespace, name) {
        let url = confined(base, &url)?;
        let bytes = match agent().get(&url).call() {
            Ok(mut response) => response
                .body_mut()
                .read_to_vec()
                .map_err(|e| format!("read the marketplace answer: {e}"))?,
            Err(ureq::Error::StatusCode(404)) => continue,
            Err(e) => return Err(format!("request to the marketplace failed: {e}")),
        };
        let parsed: OvsxExtension = serde_json::from_slice(&bytes)
            .map_err(|e| format!("the marketplace's answer is not valid JSON: {e}"))?;
        return entry_of(parsed)
            .ok_or_else(|| format!("{id} has no downloadable package in the marketplace"));
    }
    Err(format!(
        "{id} is not in the marketplace for {}",
        host_target_platform().unwrap_or("this platform")
    ))
}

/* ---------- GitHub releases: the second update channel ---------- */

/// One GitHub release's wire shape — public because the app's own update check (the
/// installer for this platform off the same repository's releases) maps the same answer.
#[derive(Deserialize, Debug, Clone)]
pub struct GithubRelease {
    #[serde(rename = "tag_name", default)]
    pub tag_name: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "published_at", default)]
    pub published_at: String,
    #[serde(default)]
    pub assets: Vec<GithubAsset>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct GithubAsset {
    #[serde(default)]
    pub name: String,
    #[serde(rename = "browser_download_url", default)]
    pub browser_download_url: String,
}

/// A download mirror's usable form: trimmed https origin, or None for empty/absent —
/// the ghproxy URL-prefix convention (`{mirror}/{original-url}`); a plain-http mirror
/// would let anything on the wire stand in for the package, exactly like a plain-http
/// marketplace would.
pub fn github_mirror(mirror: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = mirror else {
        return Ok(None);
    };
    let trimmed = raw.trim().trim_end_matches('/').to_owned();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if !trimmed.starts_with("https://") || trimmed.len() == "https://".len() {
        return Err(format!("the download mirror must be https: {raw}"));
    }
    Ok(Some(trimmed))
}

/// The URL a GitHub download fetches: the release asset itself — the only shape this
/// path accepts (`/{owner}/{repo}/releases/download/{tag}/{file}` on github.com) — or,
/// with a mirror configured, the mirror carrying the whole original URL as its path.
pub fn github_download_url(mirror: Option<&str>, url: &str) -> Result<String, String> {
    let url = url.trim();
    let rest = url
        .strip_prefix("https://github.com/")
        .ok_or_else(|| format!("refusing a non-github URL: {url}"))?;
    if !rest.contains("/releases/download/") {
        return Err(format!("refusing a URL that is not a release asset: {url}"));
    }
    match mirror {
        None => Ok(url.to_owned()),
        Some(mirror) => Ok(format!("{mirror}/{url}")),
    }
}

/// The repo's newest release, as the raw wire shape the app update maps (its installer
/// pick lives in the app's `app_update.rs`; the extension packages never download from
/// GitHub — see [`GITHUB_API`]).
pub fn github_release_raw(api_base: &str, repo: &str) -> Result<GithubRelease, String> {
    if !github_repo_shape_ok(repo) {
        return Err(format!("not a GitHub repository: {repo}"));
    }
    let url = format!("{api_base}/repos/{repo}/releases/latest");
    let bytes = agent()
        .get(&url)
        .call()
        .map_err(|e| format!("request to GitHub failed: {e}"))
        .and_then(|mut response| {
            response
                .body_mut()
                .read_to_vec()
                .map_err(|e| format!("read GitHub's answer: {e}"))
        })?;
    serde_json::from_slice(&bytes).map_err(|e| format!("GitHub's answer is not valid JSON: {e}"))
}

/// The `owner/repo` shape a release path accepts.
pub fn github_repo_shape_ok(repo: &str) -> bool {
    repo.split_once('/')
        .is_some_and(|(owner, repo)| {
            !owner.is_empty()
                && !repo.is_empty()
                && owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && repo
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        })
}

/// The tag as a version: a leading `v`/`V` stripped, and it has to carry a digit.
pub fn version_of_tag(tag: &str) -> Option<String> {
    let version = tag.trim().strip_prefix(['v', 'V']).unwrap_or(tag.trim());
    (!version.is_empty() && version.bytes().any(|b| b.is_ascii_digit()))
        .then(|| version.to_owned())
}

/// Download the `.vsix` `download_url` names into a temp file (confined to the gallery
/// origin — nothing else on the network is reachable through this path). The body streams
/// to disk in chunks under the download ceilings, never whole in memory; `report` answers
/// at most every [`REPORT_CADENCE`] plus one final tick carrying the complete size, and a
/// `false` from it — the receiver gone, or the toast's Cancel run — stops the download,
/// removing the half-written package.
pub fn download_vsix(
    base: &str,
    download_url: &str,
    report: &mut dyn FnMut(GalleryProgress) -> bool,
) -> Result<PathBuf, String> {
    let url = confined(base, download_url)?;
    let name = download_url
        .rsplit('/')
        .next()
        .filter(|stem| stem.ends_with(".vsix"))
        .unwrap_or("extension.vsix");
    download_to_temp(&url, name, report)
}

/// The streaming half both download channels share: GET `url` (already resolved and
/// origin-checked by the caller's channel) into a temp file under the download ceilings,
/// reporting through `report`.
pub fn download_to_temp(
    url: &str,
    name: &str,
    report: &mut dyn FnMut(GalleryProgress) -> bool,
) -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!("ggs-gallery-{}-{name}", std::process::id()));
    let mut response = download_agent()
        .get(url)
        .call()
        .map_err(|e| format!("request to the marketplace failed: {e}"))?;
    let total = response
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let mut file =
        std::fs::File::create(&path).map_err(|e| format!("write the downloaded package: {e}"))?;
    let mut body = response.body_mut().as_reader();
    let mut meter = ProgressMeter::default();
    let mut buffer = [0u8; 64 * 1024];
    let mut received: u64 = 0;
    loop {
        let read = body.read(&mut buffer).map_err(|e| {
            let _ = std::fs::remove_file(&path);
            format!("read the marketplace answer: {e}")
        })?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read]).map_err(|e| {
            let _ = std::fs::remove_file(&path);
            format!("write the downloaded package: {e}")
        })?;
        received += read as u64;
        if let Some(tick) = meter.sample(Instant::now(), received, total) {
            if !report(tick) {
                let _ = std::fs::remove_file(&path);
                return Err(CANCELLED_MESSAGE.to_owned());
            }
        }
    }
    if !report(meter.finish(Instant::now(), received, total)) {
        let _ = std::fs::remove_file(&path);
        return Err(CANCELLED_MESSAGE.to_owned());
    }
    Ok(path)
}

// The featured ids live at the top of the file (`FEATURED`): no network answers them —
// the view lays its rows out at once and fills each one in as its lookup lands.
#[cfg(test)]
mod tests {
    use super::*;

    /// A real (trimmed) Open VSX search answer — two entries, one with every field, one
    /// without a rating — captured from the live registry, kept verbatim so the mapping
    /// is tested against the wire format, not a re-typing of it.
    const SAMPLE_SEARCH: &str = r#"{"extensions":[
        {"deprecated":false,"description":"Fancy, smooth and beautiful UI like Lazyvim",
         "displayName":"LazyVscode Theme","downloadCount":28367,
         "files":{"download":"https://open-vsx.org/api/lazyvscode-theme/lazyvscode-theme/6.5.2/file/lazyvscode-theme.lazyvscode-theme-6.5.2.vsix",
                  "icon":"https://open-vsx.org/api/lazyvscode-theme/lazyvscode-theme/6.5.2/file/logo.png"},
         "name":"lazyvscode-theme","namespace":"lazyvscode-theme","timestamp":"2026-01-05T10:18:55.324226Z",
         "url":"https://open-vsx.org/api/lazyvscode-theme/lazyvscode-theme","verified":true,"version":"6.5.2"},
        {"deprecated":false,"description":"MQL5 Syntax Highlighting and Themes",
         "displayName":"MQL5 Support","downloadCount":8199,
         "files":{"download":"https://open-vsx.org/api/MQL5-Theme-syntax/mql5-support/1.5.6/file/MQL5-Theme-syntax.mql5-support-1.5.6.vsix"},
         "name":"mql5-support","namespace":"MQL5-Theme-syntax","timestamp":"2026-02-10T10:18:55.191871Z",
         "url":"https://open-vsx.org/api/MQL5-Theme-syntax/mql5-support","verified":false,"version":"1.5.6"}],
        "offset":0,"totalSize":2351}"#;

    #[test]
    fn maps_the_open_vsx_search_answer() {
        let parsed: OvsxSearch = serde_json::from_str(SAMPLE_SEARCH).unwrap();
        let answer = search_map(parsed);
        assert_eq!(answer.total_size, 2351);
        assert_eq!(answer.entries.len(), 2);
        let first = &answer.entries[0];
        assert_eq!(first.id, "lazyvscode-theme.lazyvscode-theme");
        assert_eq!(first.display_name.as_deref(), Some("LazyVscode Theme"));
        assert_eq!(first.version, "6.5.2");
        assert_eq!(first.download_count, 28367);
        assert!(first.verified);
        assert!(first
            .icon_url
            .as_deref()
            .unwrap_or_default()
            .ends_with("logo.png"));
        assert!(first.download_url.ends_with(".vsix"));
        assert!(answer.entries[1].icon_url.is_none());
        assert!(!answer.entries[1].verified);
    }

    #[test]
    fn entries_without_a_download_are_skipped() {
        let answer: OvsxSearch = serde_json::from_str(
            r#"{"totalSize":1,"extensions":[
                {"name":"orphan","namespace":"acme","version":"1.0.0","files":{}}]}"#,
        )
        .unwrap();
        let mapped = search_map(answer);
        assert_eq!(mapped.total_size, 1);
        assert!(mapped.entries.is_empty());
    }

    #[test]
    fn the_query_is_percent_encoded_into_the_search_url() {
        let url = search_url("https://open-vsx.org", "c++ theme");
        assert!(url.starts_with("https://open-vsx.org/api/-/search?query=c%2B%2B%20theme&"));
        assert!(url.contains("size=20"));
        let target = host_target_platform().unwrap_or("universal");
        assert!(url.contains(&format!("targetPlatform={target}")));
    }

    /// A real (trimmed) single-extension answer for one target platform.
    const SAMPLE_LOOKUP: &str = r#"{"namespace":"Anthropic","name":"claude-code","version":"2.1.283",
        "targetPlatform":"win32-x64","displayName":"Claude Code for VS Code","downloadCount":1000,
        "verified":true,"timestamp":"2026-09-20T00:00:00Z",
        "files":{"download":"https://open-vsx.org/api/Anthropic/claude-code/win32-x64/2.1.283/file/Anthropic.claude-code-2.1.283@win32-x64.vsix",
                 "icon":"https://open-vsx.org/api/Anthropic/claude-code/win32-x64/2.1.283/file/claude-logo.png"}}"#;

    #[test]
    fn maps_a_single_extension_answer() {
        let parsed: OvsxExtension = serde_json::from_str(SAMPLE_LOOKUP).unwrap();
        let entry = entry_of(parsed).unwrap();
        assert_eq!(entry.id, "Anthropic.claude-code");
        assert_eq!(entry.version, "2.1.283");
        assert!(entry.download_url.ends_with("@win32-x64.vsix"));
    }

    #[test]
    fn a_lookup_asks_for_this_platform_then_universal_never_the_bare_listing() {
        let urls = lookup_urls("https://open-vsx.org", "Anthropic", "claude-code");
        assert_eq!(
            urls.last().unwrap(),
            "https://open-vsx.org/api/Anthropic/claude-code/universal"
        );
        if let Some(target) = host_target_platform() {
            assert_eq!(urls.len(), 2);
            assert_eq!(
                urls[0],
                format!("https://open-vsx.org/api/Anthropic/claude-code/{target}")
            );
        }
        assert!(!urls
            .iter()
            .any(|u| u == "https://open-vsx.org/api/Anthropic/claude-code"));
    }

    #[test]
    fn ids_split_into_url_safe_segments() {
        assert_eq!(
            split_id("neophack.git-graph-rs").unwrap(),
            ("neophack", "git-graph-rs")
        );
        assert!(split_id("nodot").is_err());
        assert!(split_id(".name").is_err());
        assert!(split_id("ns.").is_err());
        assert!(split_id("ns.a/../b").is_err());
        assert!(split_id("ns.a?b").is_err());
    }

    /* ---------- The app update's GitHub halves (the release fetch, the mirror) ---------- */

    #[test]
    fn tags_strip_their_v_and_versions_need_a_digit() {
        assert_eq!(version_of_tag("v1.1.2").as_deref(), Some("1.1.2"));
        assert_eq!(version_of_tag(" 1.2.3 ").as_deref(), Some("1.2.3"));
        assert_eq!(version_of_tag("release-2026-11").as_deref(), Some("release-2026-11"));
        assert!(version_of_tag("v").is_none());
        assert!(version_of_tag("").is_none());
    }

    #[test]
    fn the_mirror_must_be_https_and_the_rewrite_carries_the_whole_url() {
        assert_eq!(github_mirror(None).unwrap(), None);
        assert_eq!(github_mirror(Some(String::new())).unwrap(), None);
        assert_eq!(github_mirror(Some("   ".into())).unwrap(), None);
        assert_eq!(
            github_mirror(Some("https://ghfast.top/".into())).unwrap().as_deref(),
            Some("https://ghfast.top")
        );
        assert!(github_mirror(Some("http://ghfast.top".into())).is_err());

        let asset = "https://github.com/neophack/git-graph-studio/releases/download/v0.2.0/ggs_0.2.0_x64-setup.exe";
        assert_eq!(github_download_url(None, asset).unwrap(), asset);
        assert_eq!(
            github_download_url(Some("https://ghfast.top"), asset).unwrap(),
            "https://ghfast.top/https://github.com/neophack/git-graph-studio/releases/download/v0.2.0/ggs_0.2.0_x64-setup.exe"
        );
        // Only a github.com release asset rides this path — never another host, never
        // another corner of github.com.
        assert!(github_download_url(None, "https://evil.example/a.vsix").is_err());
        assert!(github_download_url(None, "https://github.com/neophack/git-graph-studio/archive/refs/tags/v0.2.0.zip").is_err());
        assert!(github_download_url(None, "not a url").is_err());
    }

    /// The release fetch refuses a repository that is not `owner/repo`, before any
    /// network — the app update names its own repository, but the shape stays a gate.
    #[test]
    fn a_release_fetch_refuses_a_bad_repository_shape() {
        assert!(github_repo_shape_ok("neophack/git-graph-studio"));
        assert!(!github_repo_shape_ok("neophack"));
        assert!(!github_repo_shape_ok("/repo"));
        assert!(!github_repo_shape_ok("owner/"));
        assert!(!github_repo_shape_ok("ow?ner/repo"));
        let error = github_release_raw(GITHUB_API, "not-a-repo").unwrap_err();
        assert!(error.contains("not a GitHub repository"), "{error}");
    }

    /// The live registry: each featured id resolves to THIS platform's build (network —
    /// run with `cargo test --all-features -- --ignored featured_ids_resolve_live`).
    #[test]
    #[ignore]
    fn featured_ids_resolve_live() {
        for id in FEATURED {
            let entry = lookup(DEFAULT_GALLERY, id).unwrap();
            assert!(entry.id.eq_ignore_ascii_case(id));
            assert!(entry.download_url.ends_with(".vsix"));
            if let Some(target) = host_target_platform() {
                assert!(
                    entry.download_url.contains(&format!("@{target}.vsix")),
                    "{id}: {} is not the {target} build",
                    entry.download_url
                );
            }
        }
        assert!(lookup(DEFAULT_GALLERY, "neophack.no-such-extension-xyz").is_err());
    }

    /// The live download of the largest featured package — claude-code's multi-megabyte
    /// `.vsix` — under the download ceilings, reporting progress as it goes (network —
    /// run with `cargo test --all-features -- --ignored claude_code_vsix_downloads_live`).
    /// This is the path a shared 20 s global timeout once killed mid-body.
    #[test]
    #[ignore]
    fn claude_code_vsix_downloads_live() {
        let entry = lookup(DEFAULT_GALLERY, "Anthropic.claude-code").unwrap();
        let started = std::time::Instant::now();
        let mut ticks = Vec::new();
        let package = download_vsix(DEFAULT_GALLERY, &entry.download_url, &mut |tick| {
            ticks.push(tick);
            true
        })
        .unwrap();
        let size = package.metadata().unwrap().len();
        let _ = std::fs::remove_file(&package);
        assert!(size > 1024 * 1024, "claude-code's package is {size} bytes");
        // The stream reported as it went, ending at the complete size.
        assert!(
            ticks.len() > 1,
            "a hundred-megabyte download reported {} ticks",
            ticks.len()
        );
        let last = ticks.last().unwrap();
        assert_eq!(last.received, size);
        assert!(last.total.is_none_or(|total| total >= size));
        eprintln!(
            "claude-code's .vsix: {} KB in {:.1}s, {} ticks",
            size / 1024,
            started.elapsed().as_secs_f32(),
            ticks.len()
        );
    }

    #[test]
    fn the_featured_list_names_exactly_the_two_packages() {
        assert_eq!(
            FEATURED,
            &["Anthropic.claude-code", "neophack.git-graph-rs"]
        );
        for id in FEATURED {
            split_id(id).unwrap();
        }
    }

    #[test]
    fn the_gallery_must_be_https_and_defaults_to_open_vsx() {
        assert_eq!(gallery_url(None).unwrap(), DEFAULT_GALLERY);
        assert_eq!(
            gallery_url(Some("https://self-hosted.example/".into())).unwrap(),
            "https://self-hosted.example"
        );
        assert!(gallery_url(Some("http://open-vsx.org".into())).is_err());
        assert!(gallery_url(Some("https://".into())).is_err());
    }

    #[test]
    fn only_the_gallery_origin_is_reachable() {
        let base = "https://open-vsx.org";
        assert_eq!(
            confined(
                base,
                "https://open-vsx.org/api/acme/demo/1.0.0/file/demo.vsix"
            )
            .unwrap(),
            "https://open-vsx.org/api/acme/demo/1.0.0/file/demo.vsix"
        );
        assert!(confined(base, "https://evil.example/demo.vsix").is_err());
        assert!(confined(base, "http://open-vsx.org/demo.vsix").is_err());
        assert!(confined(base, "not a url").is_err());
    }

    /// The download runs on its own ceilings, not the metadata requests' 20 s global
    /// one — that shared ceiling killed claude-code's install mid-body over a slow link.
    /// Read back off the agents so the wiring, not just the constants, is pinned.
    #[test]
    fn downloads_run_on_their_own_timeouts() {
        let meta = agent().config().timeouts();
        assert_eq!(meta.global, Some(REQUEST_TIMEOUT));

        let download = download_agent().config().timeouts();
        assert_eq!(download.connect, Some(REQUEST_TIMEOUT));
        assert_eq!(download.recv_body, Some(DOWNLOAD_BODY_TIMEOUT));
        assert_eq!(download.global, Some(DOWNLOAD_TIMEOUT));
        assert!(download.recv_body.unwrap() > REQUEST_TIMEOUT * 10);
        assert!(download.global.unwrap() > download.recv_body.unwrap());
    }

    /* ---------- The download's progress reports ---------- */

    /// The wire shape the Extensions view's toast reads: camelCase, every field.
    #[test]
    fn progress_ticks_cross_camel_case() {
        let json = serde_json::to_value(GalleryProgress {
            received: 1,
            total: Some(2),
            bps: 3,
            eta_secs: Some(4),
        })
        .unwrap();
        assert_eq!(json["received"], 1);
        assert_eq!(json["total"], 2);
        assert_eq!(json["bps"], 3);
        assert_eq!(json["etaSecs"], 4);
    }

    #[test]
    fn the_meter_reports_on_the_cadence_with_recent_speed_and_eta() {
        let start = Instant::now();
        let size = 100 * 1024 * 1024u64;
        let total = Some(size);
        let mut meter = ProgressMeter::default();
        // The first chunk reports at once — the toast starts moving within the
        // first-batch budget, without a speed yet (one sample is no window).
        let first = meter.sample(start, 1024, total).unwrap();
        assert_eq!(first.received, 1024);
        assert_eq!(first.bps, 0);
        assert_eq!(first.eta_secs, None);
        // Inside the cadence: sampled, not reported — and a sample is only a report
        // moment, so the 4 KiB landing never enters the window.
        assert!(meter.sample(start + Duration::from_millis(50), 4096, total).is_none());
        // Past the cadence: the window's (10 MiB - 1 KiB) over 2 s decides the speed
        // (the first tick's 1 KiB against this tick's 10 MiB), and the ETA is what is
        // left at that speed.
        let second = meter
            .sample(start + Duration::from_secs(2), 10 * 1024 * 1024, total)
            .unwrap();
        assert_eq!(second.bps, (10 * 1024 * 1024 - 1024) / 2);
        assert_eq!(second.eta_secs, Some(19)); // 90 MiB left at ~5.0 MiB/s, ceil
        // The complete download lands on the final tick, whatever the cadence says.
        let done = meter.finish(start + Duration::from_secs(3), size, total);
        assert_eq!(done.received, size);
        assert_eq!(done.eta_secs, None); // nothing left
    }

    #[test]
    fn the_speed_window_drops_samples_past_five_seconds() {
        let start = Instant::now();
        let mut meter = ProgressMeter::default();
        meter.sample(start, 0, None);
        meter.sample(start + Duration::from_secs(6), 1024 * 1024, None);
        // The t=0 sample is out of the window now: the speed is the last second's MiB.
        let tick = meter
            .sample(start + Duration::from_secs(7), 2 * 1024 * 1024, None)
            .unwrap();
        assert_eq!(tick.bps, 1024 * 1024);
        // No total: no ETA, whatever the speed says.
        assert_eq!(tick.eta_secs, None);
    }

    #[test]
    fn a_total_without_a_speed_yet_carries_no_eta() {
        let start = Instant::now();
        let mut meter = ProgressMeter::default();
        let tick = meter
            .sample(start, 1024, Some(10 * 1024 * 1024))
            .unwrap();
        assert_eq!(tick.bps, 0);
        assert_eq!(tick.eta_secs, None);
    }

    /// A stalled window — no bytes across the whole window — answers speed 0 rather
    /// than a division by a zero duration.
    #[test]
    fn a_single_sample_window_answers_speed_zero() {
        let start = Instant::now();
        let mut meter = ProgressMeter::default();
        meter.sample(start, 1024, None);
        let tick = meter.sample(start + Duration::from_secs(6), 1024, None).unwrap();
        assert_eq!(tick.bps, 0);
    }
}

