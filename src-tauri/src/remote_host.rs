//! Remote Access host surface (module 19, docs/ggs-remote-plan.md §8): registers this
//! instance with whatever local daemon listens on the `ggs-remote/1` control endpoint, serves
//! the remote workbench's assets and the installed packages' files to it, streams downloads,
//! and creates the hidden Relay webview while remote sessions are attached. It names no
//! plugin — the endpoint and the protocol are the whole contract — and an absent daemon
//! costs one reconnect attempt per 30 s.
//!
//! The control messages are this module's own copy of the daemon's (`control_msg.rs` there):
//! the two never share a crate, and the shared test vectors hold them together
//! (`src-tauri/tests/remote_control_vectors.rs`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use ggs_fs::{zip_tree, zip_trees};

/// The hidden Relay webview's label (its capability file is `capabilities/remote-relay.json`).
pub const RELAY_LABEL: &str = "remote-relay";
/// The control channel's reconnect pacing: the first retry is quick and the delay doubles up
/// to the cap. A daemon restart (an upgrade, a reinstall, the tray's own restart) used to
/// leave every open window out of the tray's Windows list and the remote window picker for
/// up to 30 s; a failed connect to an absent local pipe costs next to nothing.
const RECONNECT_FIRST: Duration = Duration::from_millis(500);
const RECONNECT_CAP: Duration = Duration::from_secs(5);
const MAX_MESSAGE: usize = 4 << 20;
const CHUNK: usize = 1 << 20;
const SUMMARY_THROTTLE: Duration = Duration::from_millis(500);

// ---- the control messages: ggs-remote-proto's ONE copy (the app and the daemon
// link the same crate; the daemon's test vectors pin the bytes) ----
pub use ggs_remote_proto::{decode, encode, AssetKind, FromInstance, LaunchSpec, Summary, SummaryTab, ToInstance};

// ---- the endpoint ----

/// `~/.ggs/remote`, honouring the same relocations the daemon does (`GGS_REMOTE_HOME`,
/// `GGS_HOME`) so a hermetic daemon and app find each other.
pub fn remote_root() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("GGS_REMOTE_HOME") {
        return Some(PathBuf::from(root));
    }
    let ggs = match std::env::var_os("GGS_HOME") {
        Some(home) => PathBuf::from(home),
        None => {
            #[cfg(windows)]
            let var = "USERPROFILE";
            #[cfg(not(windows))]
            let var = "HOME";
            PathBuf::from(std::env::var_os(var)?).join(".ggs")
        }
    };
    Some(ggs.join("remote"))
}

/// The endpoint this instance actually connects to: `GGS_REMOTE_CONTROL` when the
/// daemon set it (a sandboxed spawn — its relocated `GGS_HOME` would derive a different
/// endpoint and never find the daemon), the derivation otherwise.
pub fn control_endpoint(root: &Path) -> String {
    match std::env::var_os("GGS_REMOTE_CONTROL") {
        Some(endpoint) => endpoint.to_string_lossy().into_owned(),
        None => endpoint_name(root),
    }
}

/// The control endpoint's name — the daemon's derivation exactly: a named pipe from
/// sha256(user name ‖ 0 ‖ root path) on Windows, a socket file under the root elsewhere.
pub fn endpoint_name(root: &Path) -> String {
    #[cfg(windows)]
    {
        use sha2::{Digest, Sha256};
        let user = std::env::var("USERNAME").unwrap_or_default();
        let mut hasher = Sha256::new();
        hasher.update(user.as_bytes());
        hasher.update([0u8]);
        hasher.update(root.to_string_lossy().as_bytes());
        let digest = hasher.finalize();
        let hex: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
        format!("ggsr1-control-{hex}")
    }
    #[cfg(not(windows))]
    {
        root.join("control.sock").to_string_lossy().into_owned()
    }
}

async fn connect(endpoint: &str) -> std::io::Result<interprocess::local_socket::tokio::Stream> {
    use interprocess::local_socket::tokio::prelude::*;
    #[cfg(windows)]
    let name = {
        use interprocess::local_socket::{GenericNamespaced, ToNsName};
        endpoint.to_ns_name::<GenericNamespaced>()?
    };
    #[cfg(not(windows))]
    let name = {
        use interprocess::local_socket::{GenericFilePath, ToFsName};
        endpoint.to_fs_name::<GenericFilePath>()?
    };
    interprocess::local_socket::tokio::Stream::connect(name).await
}

async fn read_message<R: tokio::io::AsyncRead + Unpin>(reader: &mut R) -> std::io::Result<Vec<u8>> {
    let mut len = [0u8; 4];
    reader.read_exact(&mut len).await?;
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_MESSAGE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "control message too large",
        ));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).await?;
    Ok(body)
}

// ---- the link state ----

/// One frontend's latest content summary (R21), keyed by frontend id ("main" for the desktop
/// window, "remote/<n>" for a remote session).
#[derive(Default)]
struct Summaries {
    by_frontend: HashMap<String, Summary>,
    last_sent: Option<Instant>,
    pending: bool,
}

struct Link {
    tx: Mutex<Option<mpsc::UnboundedSender<FromInstance>>>,
    relay_url: Mutex<String>,
    summaries: Mutex<Summaries>,
    remote_host_only: AtomicBool,
    connected: AtomicBool,
}

fn link() -> &'static Link {
    static LINK: OnceLock<Link> = OnceLock::new();
    LINK.get_or_init(|| Link {
        tx: Mutex::new(None),
        relay_url: Mutex::new(String::new()),
        summaries: Mutex::new(Summaries::default()),
        remote_host_only: AtomicBool::new(false),
        connected: AtomicBool::new(false),
    })
}

fn send(message: FromInstance) {
    if let Some(tx) = link().tx.lock().unwrap().as_ref() {
        let _ = tx.send(message);
    }
}

/// Whether this instance runs without a desktop window (`--remote-host`).
pub fn remote_host_only() -> bool {
    link().remote_host_only.load(Ordering::Relaxed)
}

/// Start the registration loop (from the composition root's setup).
pub fn start(app: &AppHandle, remote_host_only: bool) {
    link()
        .remote_host_only
        .store(remote_host_only, Ordering::Relaxed);
    let Some(root) = remote_root() else { return };
    let endpoint = control_endpoint(&root);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut delay = RECONNECT_FIRST;
        loop {
            if let Ok(stream) = connect(&endpoint).await {
                if let Err(error) = session(&app, stream).await {
                    eprintln!("[remote] control channel ended: {error}");
                }
                link().connected.store(false, Ordering::Relaxed);
                *link().tx.lock().unwrap() = None;
                // The daemon was there a moment ago: it is likely restarting right now.
                delay = RECONNECT_FIRST;
            }
            tokio::time::sleep(delay).await;
            delay = next_reconnect_delay(delay);
        }
    });
}

fn next_reconnect_delay(delay: Duration) -> Duration {
    (delay * 2).min(RECONNECT_CAP)
}

/// The command line that starts another instance of this app (`cmd_app::instance_argv`
/// without the folder): what the daemon reuses for SPAWN and restart.
fn launch_spec() -> LaunchSpec {
    let (program, args_prefix) = crate::cmd_app::launch_prefix();
    LaunchSpec {
        program,
        args_prefix,
    }
}

fn folders(app: &AppHandle) -> Vec<String> {
    app.state::<ggs_base::workspace::WorkspaceRoots>().list()
}

fn main_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .is_some_and(|w| w.is_visible().unwrap_or(false))
}

fn title(app: &AppHandle) -> String {
    app.get_webview_window("main")
        .and_then(|w| w.title().ok())
        .filter(|t| !t.is_empty())
        .or_else(|| {
            folders(app).first().and_then(|f| {
                Path::new(f)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
            })
        })
        .unwrap_or_else(|| "Git Graph Studio".into())
}

async fn session(
    app: &AppHandle,
    stream: interprocess::local_socket::tokio::Stream,
) -> std::io::Result<()> {
    use interprocess::local_socket::tokio::prelude::*;
    let (mut rx, mut tx) = stream.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<FromInstance>();
    out_tx
        .send(FromInstance::Register {
            instance_id: ggs_ext::process::instance_id().to_owned(),
            pid: std::process::id(),
            version: app.package_info().version.to_string(),
            title: title(app),
            folders: folders(app),
            visible: main_visible(app),
            remote_host: remote_host_only(),
            launch: launch_spec(),
            sandboxed: std::env::var_os("GGS_SANDBOX").is_some_and(|v| v == "1"),
            control_token: std::env::var_os("GGS_REMOTE_CONTROL_TOKEN")
                .map(|v| v.to_string_lossy().into_owned())
                .unwrap_or_default(),
        })
        .ok();
    *link().tx.lock().unwrap() = Some(out_tx.clone());
    link().connected.store(true, Ordering::Relaxed);
    flush_summary(app, true);
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(message) = out_rx.recv().await {
            if tx.write_all(&encode(&message)).await.is_err() {
                break;
            }
        }
    });
    let result = loop {
        let body = match read_message(&mut rx).await {
            Ok(body) => body,
            Err(e) => break Err(e),
        };
        let Ok(message) = decode::<ToInstance>(&body) else {
            continue;
        };
        handle(app, message, &out_tx);
    };
    writer.abort();
    let _ = drop_relay(app);
    result
}

fn handle(app: &AppHandle, message: ToInstance, out: &mpsc::UnboundedSender<FromInstance>) {
    match message {
        ToInstance::Welcome { relay_url, .. } => *link().relay_url.lock().unwrap() = relay_url,
        ToInstance::Ping { nonce } => {
            let _ = out.send(FromInstance::Pong { nonce });
        }
        ToInstance::FetchAsset { req, kind, path } => {
            let (app, out) = (app.clone(), out.clone());
            tauri::async_runtime::spawn_blocking(move || {
                let (status, content_type, body) = match kind {
                    AssetKind::App => app_asset(&app, &path),
                    AssetKind::Ext => ext_asset(&app, &path),
                };
                reply_asset(&out, req, status, &content_type, body);
            });
        }
        ToInstance::FetchFile { req, path, zip, paths } => {
            let (app, out) = (app.clone(), out.clone());
            let paths = paths.clone();
            tauri::async_runtime::spawn_blocking(move || {
                serve_file(&app, &out, req, &path, zip, &paths)
            });
        }
        ToInstance::EnsureRelay { token } => {
            if let Err(error) = ensure_relay(app, &token) {
                eprintln!("[remote] relay webview: {error}");
            }
        }
        ToInstance::DropRelay => {
            let _ = drop_relay(app);
        }
        ToInstance::Show => {
            if let Err(error) = crate::ensure_main_window(app) {
                eprintln!("[remote] show the desktop window: {error}");
            }
            send_update(app);
        }
        // The replica model (§22): this instance IS the user's Git Graph Studio, a browser
        // only watches it — an idle exit would end a Claude Code turn the browser merely
        // walked away from. Only a person's close (from a remote page, the tray) quits.
        ToInstance::Quit { idle: true, .. } => {
            eprintln!("[remote] the daemon's idle exit was declined: the instance keeps running");
        }
        ToInstance::Quit { force, .. } => {
            let dirty = dirty_files();
            if !force && !dirty.is_empty() {
                let _ = out.send(FromInstance::CloseBlocked { dirty });
            } else {
                let _ = out.send(FromInstance::Bye);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    app.exit(0);
                });
            }
        }
    }
}

fn reply_asset(
    out: &mpsc::UnboundedSender<FromInstance>,
    req: u32,
    status: u16,
    content_type: &str,
    body: Vec<u8>,
) {
    let etag = if status == 200 {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(&body);
        format!(
            "\"{}\"",
            digest
                .iter()
                .take(8)
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        )
    } else {
        String::new()
    };
    let chunks: Vec<&[u8]> = if body.is_empty() {
        vec![&[][..]]
    } else {
        body.chunks(CHUNK).collect()
    };
    let last = chunks.len() - 1;
    for (i, chunk) in chunks.into_iter().enumerate() {
        let _ = out.send(FromInstance::AssetReply {
            req,
            status,
            content_type: content_type.to_owned(),
            etag: etag.clone(),
            body: chunk.to_vec(),
            done: i == last,
        });
    }
}

/// A path the daemon may ask for: relative, no `..`, no backslash, no NUL.
fn safe_rel(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains('\0')
        && path
            .split('/')
            .all(|seg| !seg.is_empty() && seg != ".." && seg != ".")
}

/// The desktop build's files a replica viewer renders the PC window with (§22): its
/// stylesheets and what they reference — fonts, images, the theme files. Never its scripts
/// or pages: the copy runs no code.
fn replica_static(path: &str) -> bool {
    matches!(
        path.rsplit('.').next().unwrap_or(""),
        "css"
            | "woff"
            | "woff2"
            | "ttf"
            | "otf"
            | "svg"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "ico"
    )
}

/// The remote workbench build, `remote/…` inside the embedded assets, plus the desktop
/// build's static files under `main/…` for the replica viewer — never anything else of
/// them. A debug build (`tauri dev`, no embedded assets) reads the build output on disk.
pub fn app_asset(app: &AppHandle, path: &str) -> (u16, String, Vec<u8>) {
    if !safe_rel(path) {
        return (404, "text/plain".into(), Vec::new());
    }
    let replica = path.strip_prefix("main/");
    let key = match replica {
        Some(rest) if replica_static(rest) => rest.to_owned(),
        Some(_) => return (404, "text/plain".into(), Vec::new()),
        None => format!("remote/{path}"),
    };
    // The desktop build's stylesheets name their fonts root-absolute (`url(/assets/…)`),
    // which a viewer would resolve against the daemon's root: rebased to relative paths.
    let rebase = |mime: String, bytes: Vec<u8>| match replica {
        Some(rest) if rest.ends_with(".css") => {
            let depth = rest.matches('/').count();
            let css = String::from_utf8_lossy(&bytes);
            (mime, rebase_root_urls(&css, depth).into_bytes())
        }
        _ => (mime, bytes),
    };
    if let Some(asset) = app.asset_resolver().get(key.clone()) {
        let (mime, bytes) = rebase(asset.mime_type, asset.bytes);
        return (200, mime, bytes);
    }
    #[cfg(debug_assertions)]
    {
        let dist = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../target/studio/dist")
            .join(&key);
        if let Ok(bytes) = std::fs::read(&dist) {
            let (mime, bytes) = rebase(guess_type(path).into(), bytes);
            return (200, mime, bytes);
        }
    }
    (404, "text/plain".into(), Vec::new())
}

/// `url(/x)` → `url(../x)` for a stylesheet `depth` directories below the build root (the
/// quoted forms too; protocol-relative `//host` URLs stay as they are).
fn rebase_root_urls(css: &str, depth: usize) -> String {
    let up = "../".repeat(depth);
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(at) = rest.find("url(") {
        let (head, tail) = rest.split_at(at + 4);
        out.push_str(head);
        let quote = tail.chars().next().filter(|c| *c == '"' || *c == '\'');
        let body = &tail[quote.map_or(0, char::len_utf8)..];
        if let Some(q) = quote {
            out.push(q);
        }
        if body.starts_with('/') && !body.starts_with("//") {
            out.push_str(&up);
            rest = &body[1..];
        } else {
            rest = body;
        }
    }
    out.push_str(rest);
    out
}

fn guess_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "webmanifest" => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

/// An installed package's file, through the `ggs` protocol's own serving function — the
/// same confinement rules as the desktop's page iframes.
pub fn ext_asset(app: &AppHandle, path: &str) -> (u16, String, Vec<u8>) {
    if !safe_rel(path) {
        return (404, "text/plain".into(), Vec::new());
    }
    let Ok(request) = tauri::http::Request::builder()
        .uri(format!("ggs://localhost/{path}"))
        .body(Vec::new())
    else {
        return (400, "text/plain".into(), Vec::new());
    };
    let response = crate::cmd_ext::serve_ext_asset(&request, &app.asset_resolver());
    let content_type = response
        .headers()
        .get(tauri::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    (
        response.status().as_u16(),
        content_type,
        response.into_body(),
    )
}

/// Whether a download path lies inside an open folder or the extension store (§7.8: the same
/// confinement `ext_fs` applies).
pub fn download_allowed(path: &Path, roots: &[PathBuf]) -> bool {
    let Ok(canonical) = std::fs::canonicalize(path) else {
        return false;
    };
    roots
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .any(|root| canonical.starts_with(root))
}

fn download_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = folders(app).into_iter().map(PathBuf::from).collect();
    if let Ok(home) = crate::cmd_ext::extensions_home_dir() {
        roots.push(home);
    }
    roots
}

fn serve_file(
    app: &AppHandle,
    out: &mpsc::UnboundedSender<FromInstance>,
    req: u32,
    path: &str,
    zip: bool,
    paths: &[String],
) {
    let fail = |status: u16| {
        let _ = out.send(FromInstance::FileReply {
            req,
            status,
            name: String::new(),
            total: 0,
            chunk: Vec::new(),
            done: true,
        });
    };
    // The multi-select pack (§6.7): every path must pass the same confinement a single
    // download passes, and the archive is named after the shared parent (the folder the
    // selection was made in).
    if paths.len() >= 2 {
        let roots = download_roots(app);
        let targets: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        if !targets.iter().all(|target| download_allowed(target, &roots)) {
            return fail(403);
        }
        let name = targets
            .first()
            .and_then(|first| first.parent())
            .and_then(|parent| parent.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "download".into());
        let _ = out.send(FromInstance::FileReply {
            req,
            status: 200,
            name: format!("{name}.zip"),
            total: 0,
            chunk: Vec::new(),
            done: false,
        });
        let fail_started = || {
            let _ = out.send(FromInstance::FileReply {
                req,
                status: 500,
                name: String::new(),
                total: 0,
                chunk: Vec::new(),
                done: true,
            });
        };
        let mut _scratch: Option<ggs_base::fsx::ScratchFileGuard> = None;
        let mut temp = match ggs_base::fsx::scratch_file("ggs-scratch") {
            Ok((file, guard)) => {
                _scratch = Some(guard);
                file
            }
            Err(_) => return fail_started(),
        };
        if zip_trees(&targets, &mut temp).is_err() {
            return fail_started();
        }
        use std::io::Seek;
        if temp.seek(std::io::SeekFrom::Start(0)).is_err() {
            return fail_started();
        }
        let total = temp.metadata().map(|m| m.len()).unwrap_or(0);
        stream_out(out, req, temp, format!("{name}.zip"), total);
        return;
    }
    let target = PathBuf::from(path);
    if !download_allowed(&target, &download_roots(app)) {
        return fail(403);
    }
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    // A folder (or an explicit zip) is packed into a temporary file first — the zip writer
    // needs to seek — and then streamed like any file. The headers cross before the tree
    // is walked (2026-10-13): a big folder's zip build can outlast the daemon's
    // first-chunk wait, and the download that dies there is retried by the browser against
    // the same one-time URL — the spent ticket answers 404, shown as "file not found". An
    // immediate empty first chunk starts the download; the bytes stream once the tree is
    // packed. A failure after it crosses as an error chunk mid-stream, which the daemon
    // turns into an aborted body — a truncated archive never lands as a complete file.
    let (file, name) = if target.is_dir() || zip {
        let zip_name = format!("{name}.zip");
        let _ = out.send(FromInstance::FileReply {
            req,
            status: 200,
            name: zip_name.clone(),
            total: 0,
            chunk: Vec::new(),
            done: false,
        });
        let fail_started = || {
            let _ = out.send(FromInstance::FileReply {
                req,
                status: 500,
                name: String::new(),
                total: 0,
                chunk: Vec::new(),
                done: true,
            });
        };
        // Declared before `temp` so it drops after it: the file handle closes first,
        // then the guard's delete can succeed on Windows too.
        let mut _scratch: Option<ggs_base::fsx::ScratchFileGuard> = None;
        let mut temp = match ggs_base::fsx::scratch_file("ggs-scratch") {
            Ok((file, guard)) => {
                _scratch = Some(guard);
                file
            }
            Err(_) => return fail_started(),
        };
        if zip_tree(&target, &mut temp).is_err() {
            return fail_started();
        }
        use std::io::Seek;
        if temp.seek(std::io::SeekFrom::Start(0)).is_err() {
            return fail_started();
        }
        (temp, zip_name)
    } else {
        match std::fs::File::open(&target) {
            Ok(file) => (file, name),
            Err(_) => return fail(404),
        }
    };
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    stream_out(out, req, file, name, total);
}

/// The read loop every served download ends in: the file (or the packed temporary) goes
/// out as CHUNK-sized `FileReply`s, the empty final chunk closing the stream.
fn stream_out(
    out: &mpsc::UnboundedSender<FromInstance>,
    req: u32,
    mut file: impl std::io::Read,
    name: String,
    total: u64,
) {
    let fail = |status: u16| {
        let _ = out.send(FromInstance::FileReply {
            req,
            status,
            name: String::new(),
            total: 0,
            chunk: Vec::new(),
            done: true,
        });
    };
    let mut buf = vec![0u8; CHUNK];
    let mut sent_any = false;
    loop {
        let n = match file.read(&mut buf) {
            Ok(n) => n,
            Err(_) => return fail(500),
        };
        let done = n == 0;
        if done && sent_any {
            let _ = out.send(FromInstance::FileReply {
                req,
                status: 200,
                name: name.clone(),
                total,
                chunk: Vec::new(),
                done: true,
            });
            return;
        }
        let _ = out.send(FromInstance::FileReply {
            req,
            status: 200,
            name: name.clone(),
            total,
            chunk: buf[..n].to_vec(),
            done,
        });
        sent_any = true;
        if done {
            return;
        }
    }
}

// The zip walk lives in cmd_fs (`zip_tree`) — the desktop export (fs_export) and this
// download path share the one tree-walking writer, `.git` skipped, unreadable entries
// skipped.

// ---- the Relay webview ----

fn ensure_relay(app: &AppHandle, token: &str) -> tauri::Result<()> {
    // The daemon asks again after a Relay link drop: tear the old webview down and
    // rebuild it. `destroy()` is asynchronous — the label stays registered until the
    // platform tears the window down, and a rebuild that races it fails with "a
    // webview with label `remote-relay` already exists" (which once left every remote
    // session dead: the drop was never recovered). Retry the build until the label
    // frees, bounded, so one control-frame handling cannot hang the reader loop.
    if let Some(window) = app.get_webview_window(RELAY_LABEL) {
        let _ = window.destroy();
    }
    let url = link().relay_url.lock().unwrap().clone();
    if url.is_empty() {
        return Ok(());
    }
    let config = serde_json::json!({ "url": url, "token": token });
    // The token travels in an initialization script, never in the URL: no history, no log.
    let build = || {
        tauri::WebviewWindowBuilder::new(
            app,
            RELAY_LABEL,
            tauri::WebviewUrl::App("relay.html".into()),
        )
        .title("GGS Remote Relay")
        .visible(false)
        .skip_taskbar(true)
        .focused(false)
        .inner_size(1.0, 1.0)
        .initialization_script(format!("window.__GGS_RELAY__ = {config};"))
        .build()
    };
    let mut attempt = build();
    let mut tries = 1;
    while let Err(error) = attempt {
        if tries >= 100 {
            return Err(error);
        }
        tries += 1;
        std::thread::sleep(std::time::Duration::from_millis(50));
        attempt = build();
    }
    Ok(())
}

fn drop_relay(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(RELAY_LABEL) {
        window.destroy()?;
    }
    Ok(())
}

/// Where a host request of a backend goes (§8.6 #1): the frontend that claims it (its call
/// is in flight, or it owns the webview the request names) while that frontend exists —
/// a remote click on "View Git Graph" opens the graph in that one session's page, never in
/// another user's — else the desktop window while it shows, the remote side otherwise
/// (the Relay picks the session). Registered as `ext_process`'s host-request target at the
/// composition root, so neither module names the other.
pub fn host_request_frontend(app: &AppHandle, claimed: Option<String>) -> String {
    let main = app.get_webview_window("main").is_some();
    let relay = app.get_webview_window(RELAY_LABEL).is_some();
    match claimed {
        Some(remote) if remote.starts_with("remote") && relay => remote,
        _ if main => "main".into(),
        _ => "remote".into(),
    }
}

// ---- updates from the rest of the app ----

/// Title, folders and visibility changed (non-blocking; dropped without a daemon).
pub fn send_update(app: &AppHandle) {
    if !link().connected.load(Ordering::Relaxed) {
        return;
    }
    send(FromInstance::Update {
        title: Some(title(app)),
        folders: Some(folders(app)),
        visible: Some(main_visible(app)),
        summary: None,
    });
}

/// The open folders changed (open / close folder, a workspace): pushed as they are.
pub fn notify_folders(folders: &[String]) {
    if link().connected.load(Ordering::Relaxed) {
        send(FromInstance::Update {
            title: None,
            folders: Some(folders.to_vec()),
            visible: None,
            summary: None,
        });
    }
}

/// The merged summary over every frontend: tabs de-duplicated by path (a tab is dirty or
/// active if any frontend says so), the terminal count from the backend's own sessions.
fn merged_summary(app: &AppHandle) -> Summary {
    let summaries = link().summaries.lock().unwrap();
    let mut tabs: Vec<SummaryTab> = Vec::new();
    let mut scm = 0;
    for summary in summaries.by_frontend.values() {
        scm = scm.max(summary.scm_changes);
        for tab in &summary.tabs {
            match tabs.iter_mut().find(|t| t.path == tab.path) {
                Some(existing) => {
                    existing.dirty |= tab.dirty;
                    existing.active |= tab.active;
                }
                None => tabs.push(tab.clone()),
            }
        }
    }
    let dirty = tabs.iter().filter(|t| t.dirty).count() as u32;
    Summary {
        tabs,
        terminals: crate::pty::session_count(app),
        dirty,
        scm_changes: scm,
    }
}

fn dirty_files() -> Vec<String> {
    let summaries = link().summaries.lock().unwrap();
    let mut dirty: Vec<String> = summaries
        .by_frontend
        .values()
        .flat_map(|s| s.tabs.iter().filter(|t| t.dirty).map(|t| t.path.clone()))
        .collect();
    dirty.sort();
    dirty.dedup();
    dirty
}

fn flush_summary(app: &AppHandle, force: bool) {
    {
        let mut summaries = link().summaries.lock().unwrap();
        let due = summaries
            .last_sent
            .is_none_or(|at| at.elapsed() >= SUMMARY_THROTTLE);
        if !force && !due {
            if !summaries.pending {
                summaries.pending = true;
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(SUMMARY_THROTTLE).await;
                    link().summaries.lock().unwrap().pending = false;
                    flush_summary(&app, true);
                });
            }
            return;
        }
        summaries.last_sent = Some(Instant::now());
    }
    if link().connected.load(Ordering::Relaxed) {
        send(FromInstance::Update {
            title: None,
            folders: None,
            visible: None,
            summary: Some(merged_summary(app)),
        });
    }
}

/// A frontend reports what it shows (R21): open editors, unsaved files, SCM changes. Sent on
/// change, throttled to one push per 500 ms.
#[tauri::command]
pub fn remote_host_set_summary(app: AppHandle, frontend: String, summary: Summary) {
    link()
        .summaries
        .lock()
        .unwrap()
        .by_frontend
        .insert(frontend, summary);
    flush_summary(&app, false);
}

/// A frontend went away (a remote session ended — the Relay reports it): its part of the
/// merged summary goes. (It owns no webviews to release: every webview lives in the
/// desktop window, `ext_routing`.)
#[tauri::command]
pub fn remote_host_frontend_gone(app: AppHandle, frontend: String) {
    link()
        .summaries
        .lock()
        .unwrap()
        .by_frontend
        .remove(&frontend);
    flush_summary(&app, false);
}

// ---- the replica (§22): the desktop window as the one real frontend ----

/// The desktop size the window had before a viewer's fit resized it (restored on show).
static DESKTOP_SIZE: Mutex<Option<tauri::LogicalSize<f64>>> = Mutex::new(None);

/// Size the hidden desktop window for a viewer's viewport: the copy then lays out at the
/// viewer's own proportions. A window the user can see is the user's — left as it is. The
/// desktop workbench's own floor applies (a phone never mirrors — it runs its own workbench,
/// docs/remote-client-plan.md §11 — so the old phone-sized fit path is gone and the window
/// minimum never has to step aside).
#[tauri::command]
pub fn remote_mirror_fit(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    if window.is_visible().unwrap_or(false) {
        return Ok(());
    }
    let (width, height) = (width.clamp(800.0, 3840.0), height.clamp(500.0, 4000.0));
    let mut saved = DESKTOP_SIZE.lock().unwrap_or_else(|p| p.into_inner());
    if saved.is_none() {
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let size = window.inner_size().map_err(|e| e.to_string())?;
        *saved = Some(size.to_logical(scale));
    }
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

/// Put the desktop size back before the window shows again (`ensure_main_window`).
pub fn restore_desktop_size(window: &tauri::WebviewWindow) {
    let saved = DESKTOP_SIZE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take();
    if let Some(size) = saved {
        let _ = window.set_min_size(Some(tauri::LogicalSize::new(800.0, 500.0)));
        let _ = window.set_size(size);
    }
}

/// While remote viewers drive the window, its page must believe it has the focus — a
/// hidden or background window otherwise drops focus events, and a focused editor, a
/// quick pick or a menu never behaves as focused. WebView2's DevTools protocol has exactly
/// that switch; elsewhere this is a no-op.
#[tauri::command]
pub fn remote_mirror_focus(app: AppHandle, enabled: bool) {
    if let Some(window) = app.get_webview_window("main") {
        emulate_focus(&window, enabled);
    }
}

#[cfg(windows)]
fn emulate_focus(window: &tauri::WebviewWindow, enabled: bool) {
    let params = format!("{{\"enabled\":{enabled}}}");
    let _ = window.with_webview(move |webview| unsafe {
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows_core::HSTRING;
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
        let method = HSTRING::from("Emulation.setFocusEmulationEnabled");
        let params = HSTRING::from(params);
        if let Err(error) = core.CallDevToolsProtocolMethod(&method, &params, &handler) {
            eprintln!("[remote] focus emulation: {error}");
        }
    });
}

#[cfg(not(windows))]
fn emulate_focus(_window: &tauri::WebviewWindow, _enabled: bool) {}

/// The desktop window's close while the replica keeps running (a viewer watches, or a
/// remote-host instance): hide it, and tell the daemon it is no longer visible.
#[tauri::command]
pub fn remote_host_hide_main(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    send_update(&app);
    Ok(())
}

/// Whether a local daemon is connected — the frontend's status line for Remote Access.
#[tauri::command]
pub fn remote_host_status(app: AppHandle) -> serde_json::Value {
    serde_json::json!({
        "connected": link().connected.load(Ordering::Relaxed),
        "remoteHostOnly": remote_host_only(),
        "folders": folders(&app),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Env mutation is process-wide: the override test holds the lock so a parallel
    /// endpoint test never races the variable away.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn the_control_endpoint_env_override_wins() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let derived = control_endpoint(Path::new("/home/u/.ggs/remote"));
        assert_eq!(derived, endpoint_name(Path::new("/home/u/.ggs/remote")));
        // SAFETY: single-threaded under the lock; restored before return.
        unsafe {
            std::env::set_var("GGS_REMOTE_CONTROL", "ggsr1-sbx-abcdef");
        }
        let overridden = control_endpoint(Path::new("/home/u/.ggs/remote"));
        unsafe {
            std::env::remove_var("GGS_REMOTE_CONTROL");
        }
        assert_eq!(overridden, "ggsr1-sbx-abcdef");
    }

    #[test]
    fn reconnects_quickly_and_never_waits_past_the_cap() {
        let mut delay = RECONNECT_FIRST;
        let mut waited = Duration::ZERO;
        for _ in 0..4 {
            waited += delay;
            delay = next_reconnect_delay(delay);
        }
        // Four tries within the first 8 s of a daemon restart, then one every 5 s at most.
        assert!(waited <= Duration::from_secs(8), "{waited:?}");
        for _ in 0..20 {
            delay = next_reconnect_delay(delay);
        }
        assert_eq!(delay, RECONNECT_CAP);
    }

    #[test]
    fn the_replica_stylesheets_name_their_fonts_relatively() {
        let css = r#"@font-face{src:url(/assets/codicon.ttf?x)}a{b:url("/theme/i.svg")}c{d:url('//cdn/x')}e{f:url(data:,x)}"#;
        assert_eq!(
            rebase_root_urls(css, 1),
            r#"@font-face{src:url(../assets/codicon.ttf?x)}a{b:url("../theme/i.svg")}c{d:url('//cdn/x')}e{f:url(data:,x)}"#
        );
        assert_eq!(rebase_root_urls("x{y:url(/a.png)}", 0), "x{y:url(a.png)}");
    }

    #[test]
    fn the_replica_reads_only_the_desktop_builds_static_files() {
        assert!(replica_static("assets/index-1a2b.css"));
        assert!(replica_static("theme/dark-modern.css"));
        assert!(replica_static("assets/codicon-9f.ttf"));
        assert!(!replica_static("assets/index-1a2b.js"));
        assert!(!replica_static("index.html"));
    }

    #[test]
    fn relative_paths_only() {
        assert!(safe_rel("assets/a.js"));
        for bad in ["", "/etc/passwd", "../x", "a/../b", "a\\b", "a//b", "./a"] {
            assert!(!safe_rel(bad), "{bad:?}");
        }
    }

    #[test]
    fn downloads_stay_inside_their_roots() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::write(repo.join("src/a.rs"), "fn main() {}").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "no").unwrap();
        let roots = vec![repo.clone()];
        assert!(download_allowed(&repo.join("src/a.rs"), &roots));
        assert!(download_allowed(&repo.join("src"), &roots));
        assert!(!download_allowed(&dir.path().join("secret.txt"), &roots));
        assert!(!download_allowed(
            &repo.join("src/../../secret.txt"),
            &roots
        ));
        assert!(!download_allowed(&repo.join("missing.rs"), &roots));
    }

    #[test]
    fn zips_a_tree_without_git() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::write(repo.join(".git/HEAD"), "ref").unwrap();
        std::fs::write(repo.join("src/a.rs"), "fn a() {}").unwrap();
        std::fs::write(repo.join("README.md"), "# r").unwrap();
        let bytes = zip_tree(&repo, std::io::Cursor::new(Vec::new())).unwrap();
        let mut archive = zip::ZipArchive::new(bytes).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["README.md", "src/a.rs"]);
    }

    #[test]
    fn endpoint_names_follow_the_root() {
        let a = endpoint_name(Path::new("/home/u/.ggs/remote"));
        let b = endpoint_name(Path::new("/tmp/other/remote"));
        assert_ne!(a, b);
        #[cfg(windows)]
        assert!(a.starts_with("ggsr1-control-"));
        #[cfg(not(windows))]
        assert!(a.ends_with("control.sock"));
    }
}
