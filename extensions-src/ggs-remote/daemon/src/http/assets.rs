//! The instance-backed routes (docs/ggs-remote-plan.md §7.3, §10.2, §12.2): the remote
//! workbench's files under `/w/<inst>/v/<ver>/…` (cached, immutable when hashed), installed
//! packages' files under `/w/<inst>/ggs/<tok>/…` (the resource token stands in for the cookie
//! a sandboxed iframe cannot send), and one-time downloads.

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use super::pages::accepts_br;
use super::{safe_rel_path, session_of};
use crate::cache::{brotli, compressible, unbrotli, Entry};
use crate::control_msg::{AssetKind, ToInstance};
use crate::state::Daemon;

pub const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_ASSET: usize = 64 << 20;

pub struct Fetched {
    pub status: u16,
    pub content_type: String,
    pub etag: String,
    pub body: Vec<u8>,
}

/// Ask an instance for one file over the control channel and collect the chunks.
pub async fn fetch_from_instance(
    daemon: &Arc<Daemon>,
    instance: &str,
    kind: AssetKind,
    path: &str,
) -> Result<Fetched, StatusCode> {
    let (req, mut rx) = daemon
        .registry
        .open_request(instance)
        .ok_or(StatusCode::NOT_FOUND)?;
    if !daemon.registry.send(
        instance,
        ToInstance::FetchAsset {
            req,
            kind,
            path: path.to_owned(),
        },
    ) {
        daemon.registry.cancel_request(instance, req);
        return Err(StatusCode::BAD_GATEWAY);
    }
    let collect = async {
        let mut out: Option<Fetched> = None;
        while let Some(chunk) = rx.recv().await {
            let fetched = out.get_or_insert_with(|| Fetched {
                status: chunk.status,
                content_type: chunk.content_type.clone(),
                etag: chunk.etag.clone(),
                body: Vec::new(),
            });
            if fetched.body.len() + chunk.body.len() > MAX_ASSET {
                return Err(StatusCode::PAYLOAD_TOO_LARGE);
            }
            fetched.body.extend_from_slice(&chunk.body);
            if chunk.done {
                break;
            }
        }
        out.ok_or(StatusCode::BAD_GATEWAY)
    };
    match tokio::time::timeout(FETCH_TIMEOUT, collect).await {
        Ok(result) => result,
        Err(_) => {
            daemon.registry.cancel_request(instance, req);
            Err(StatusCode::GATEWAY_TIMEOUT)
        }
    }
}

/// Files whose names carry a content hash never change: cache them for a year — the
/// remote build's and the desktop build's (`main/assets/…`, the replica's stylesheets).
fn immutable(path: &str) -> bool {
    let path = path.strip_prefix("main/").unwrap_or(path);
    path.starts_with("assets/")
        && path
            .rsplit('/')
            .next()
            .is_some_and(|name| name.contains('-'))
}

pub async fn app_asset(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    Path((inst, ver, path)): Path<(String, String, String)>,
) -> Response {
    if session_of(&daemon, &headers).is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(path) = safe_rel_path(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match daemon.registry.version_of(&inst) {
        None => return StatusCode::NOT_FOUND.into_response(),
        // The window was upgraded under an open tab (§6.6): a 409 tells the page to reload.
        Some(running) if running != ver => return StatusCode::CONFLICT.into_response(),
        _ => {}
    }
    // Only content-hashed files are cached: their names change whenever their bytes do.
    // Everything else (remote.html, sw.js, the theme and icon files) is asked of the instance
    // on every load — a rebuild reinstalled under the same version number (0.1.10 → 0.1.10)
    // must reach the browser, and a version-keyed copy of remote.html kept naming the old
    // build's scripts forever (2026-10-12: a reinstalled phone shell never appeared).
    let cacheable = immutable(&path);
    let key = format!("{inst}|{ver}|{path}");
    let cached = if cacheable {
        daemon.cache.get(&key)
    } else {
        None
    };
    let entry = match cached {
        Some(entry) => entry,
        None => {
            let fetched = match fetch_from_instance(&daemon, &inst, AssetKind::App, &path).await {
                Ok(f) if f.status == 200 => f,
                Ok(f) => {
                    return StatusCode::from_u16(f.status)
                        .unwrap_or(StatusCode::NOT_FOUND)
                        .into_response()
                }
                Err(status) => return status.into_response(),
            };
            let etag = if fetched.etag.is_empty() {
                format!(
                    "\"{}\"",
                    &crate::util::hex(&crate::util::sha256(&fetched.body))[..16]
                )
            } else {
                fetched.etag.clone()
            };
            let content_type = if fetched.content_type.is_empty() {
                mime_guess::from_path(&path)
                    .first_or_octet_stream()
                    .to_string()
            } else {
                fetched.content_type.clone()
            };
            let br = compressible(&content_type);
            let body = fetched.body;
            let body = if br {
                tokio::task::spawn_blocking(move || brotli(&body))
                    .await
                    .unwrap_or_default()
            } else {
                body
            };
            let entry = Entry {
                content_type,
                etag,
                body,
                br,
            };
            if cacheable {
                daemon.cache.put(&key, entry.clone());
            }
            entry
        }
    };
    let cache_control = if immutable(&path) {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    respond(&headers, entry, cache_control)
}

fn respond(headers: &HeaderMap, entry: Entry, cache_control: &str) -> Response {
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|tag| tag == entry.etag)
    {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, &entry.etag)
            .header(header::CACHE_CONTROL, cache_control)
            .body(Body::empty())
            .expect("valid 304");
    }
    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, &entry.content_type)
        .header(header::ETAG, &entry.etag)
        .header(header::CACHE_CONTROL, cache_control)
        .header(header::VARY, "accept-encoding");
    let body = if entry.br && accepts_br(headers) {
        builder = builder.header(header::CONTENT_ENCODING, "br");
        entry.body
    } else if entry.br {
        unbrotli(&entry.body)
    } else {
        entry.body
    };
    builder
        .body(Body::from(body))
        .expect("valid asset response")
}

/// `/sw.js` (§10.2): the Service Worker comes from the remote build of whichever instance is
/// up; served at the root so its scope covers the base path. Session-gated (audit F2,
/// 2026-10-13): the fetch buffers and compresses instance output, which no unauthenticated
/// LAN peer should be able to make the daemon do — and the workbench's own pages, the only
/// things a service worker can serve, all carry a session cookie anyway.
pub async fn service_worker(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    if super::session_of(&daemon, &headers).is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(first) = daemon.registry.snapshot().into_iter().next() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match fetch_from_instance(&daemon, &first.id, AssetKind::App, "sw.js").await {
        Ok(f) if f.status == 200 => {
            let base = super::base_path(&headers);
            Response::builder()
                .header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")
                .header(header::CACHE_CONTROL, "no-cache")
                .header("service-worker-allowed", base)
                .body(Body::from(f.body))
                .expect("valid sw response")
        }
        Ok(f) => StatusCode::from_u16(f.status)
            .unwrap_or(StatusCode::NOT_FOUND)
            .into_response(),
        Err(status) => status.into_response(),
    }
}

/// An installed package's file for a sandboxed page (§12.2): the resource token is the
/// credential, and the answer allows any origin — an opaque-origin frame's module scripts
/// load CORS-checked.
pub async fn ext_asset(
    State(daemon): State<Arc<Daemon>>,
    Path((inst, tok, path)): Path<(String, String, String)>,
) -> Response {
    if !daemon.check_resource_token(&tok, &inst) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(path) = safe_rel_path(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let fetched = match fetch_from_instance(&daemon, &inst, AssetKind::Ext, &path).await {
        Ok(f) => f,
        Err(status) => return status.into_response(),
    };
    let base = format!("/w/{inst}/ggs/{tok}/");
    let mut body = fetched.body;
    if fetched.content_type.starts_with("text/html") {
        body = rewrite_ggs_urls(&String::from_utf8_lossy(&body), &base).into_bytes();
    }
    Response::builder()
        .status(StatusCode::from_u16(fetched.status).unwrap_or(StatusCode::OK))
        .header(header::CONTENT_TYPE, fetched.content_type)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "private, max-age=300")
        .body(Body::from(body))
        .expect("valid ext response")
}

/// The pages a package serves address their own files as `ggs://localhost/…` and allow the
/// `ggs:` scheme in their CSP; remotely both become the token path on this origin (§12.2).
/// The extension host frame's document (`ext-host.html`) is an app asset whose build spells
/// its hashed scripts as root-absolute `/assets/…` — correct under the desktop's `ggs://`
/// origin, wrong under this origin's `/w/<inst>/ggs/<tok>/` path, where they would fall out
/// of the token route and 404 at the root (no frame extension would ever activate). The
/// same rewrite folds those references onto the token path too.
pub fn rewrite_ggs_urls(html: &str, base: &str) -> String {
    html.replace("ggs://localhost/", base)
        .replace("http://ggs.localhost/", base)
        .replace(" ggs: ", " 'self' ")
        .replace(" ggs:;", " 'self';")
        .replace("=\"/assets/", &format!("=\"{base}assets/"))
        .replace("='/assets/", &format!("='{base}assets/"))
}

pub async fn download(
    State(daemon): State<Arc<Daemon>>,
    Path(inst): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(ticket) = query
        .get("t")
        .and_then(|t| daemon.tickets.lock().unwrap().take_download(t))
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if ticket.instance != inst || !daemon.session_valid(&ticket.token_hash) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some((req, mut rx)) = daemon.registry.open_request(&inst) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    daemon.registry.send(
        &inst,
        ToInstance::FetchFile {
            req,
            path: ticket.path.clone(),
            zip: ticket.zip,
        },
    );
    let first = match tokio::time::timeout(FETCH_TIMEOUT, rx.recv()).await {
        Ok(Some(chunk)) => chunk,
        _ => {
            daemon.registry.cancel_request(&inst, req);
            return StatusCode::GATEWAY_TIMEOUT.into_response();
        }
    };
    if first.status != 200 {
        return StatusCode::from_u16(first.status)
            .unwrap_or(StatusCode::NOT_FOUND)
            .into_response();
    }
    let name = first.name.clone();
    let total = first.total;
    let done = first.done;
    let head = first.body;
    let stream =
        futures_util::stream::unfold((Some(head), rx, done), |(head, mut rx, done)| async move {
            if let Some(bytes) = head {
                return Some((Ok::<_, std::io::Error>(bytes), (None, rx, done)));
            }
            if done {
                return None;
            }
            let chunk = rx.recv().await?;
            let finished = chunk.done;
            // A failure after the headers crossed (the zip build died mid-pack,
            // 2026-10-13): abort the body rather than end it — a truncated archive must
            // surface as an interrupted download, never land as a complete file.
            if chunk.status != 200 {
                return Some((
                    Err(std::io::Error::other(format!(
                        "the instance failed mid-stream ({})",
                        chunk.status
                    ))),
                    (None, rx, true),
                ));
            }
            Some((Ok(chunk.body), (None, rx, finished)))
        });
    let mut builder = Response::builder()
        .header(
            header::CONTENT_TYPE,
            if ticket.zip {
                "application/zip"
            } else {
                "application/octet-stream"
            },
        )
        .header(header::CONTENT_DISPOSITION, content_disposition(&name))
        .header(header::CACHE_CONTROL, "no-store");
    if total > 0 && !ticket.zip {
        builder = builder.header(header::CONTENT_LENGTH, total);
    }
    builder
        .body(Body::from_stream(stream))
        .expect("valid download response")
}

/// A download's Content-Disposition (RFC 5987): the plain `filename` is an ASCII-only
/// fallback (quotes, CR/LF and every non-ASCII byte become `_`), and the real name rides
/// `filename*` percent-encoded in UTF-8 — without it a browser reads the plain form as
/// Latin-1 and a Chinese file name downloads as mojibake.
fn content_disposition(name: &str) -> String {
    let fallback: String = name
        .chars()
        .map(|c| {
            if c.is_ascii() && c != '"' && c != '\\' && c != '\r' && c != '\n' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut encoded = String::new();
    for &byte in name.as_bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'!'
            | b'#'
            | b'$'
            | b'&'
            | b'+'
            | b'-'
            | b'.'
            | b'^'
            | b'_'
            | b'`'
            | b'|'
            | b'~' => encoded.push(byte as char),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn hashed_assets_are_immutable() {
        assert!(super::immutable("assets/workbench-3f9a.js"));
        assert!(!super::immutable("remote.html"));
        assert!(!super::immutable("sw.js"));
        // The desktop build's stylesheets the replica viewer renders with.
        assert!(super::immutable("main/assets/index-9c1e.css"));
        assert!(!super::immutable("main/theme/dark-modern.css"));
    }

    #[test]
    fn ggs_urls_become_token_paths() {
        let html = r#"<meta http-equiv="Content-Security-Policy" content="default-src ggs: 'unsafe-inline'"><script src="ggs://localhost/pkg-1.0/a.js"></script>"#;
        let out = super::rewrite_ggs_urls(html, "/w/i/ggs/t/");
        assert!(out.contains(r#"src="/w/i/ggs/t/pkg-1.0/a.js""#));
        assert!(out.contains("default-src 'self' 'unsafe-inline'"));
    }

    #[test]
    fn root_absolute_app_assets_fold_onto_the_token_path() {
        // ext-host.html's shape: the main build's hashed scripts, root-absolute.
        let html = r#"<script type="module" crossorigin src="/assets/extHost-WxvcU2fk.js"></script><link rel="modulepreload" crossorigin href="/assets/modulepreload-B5Qt9EMX.js">"#;
        let out = super::rewrite_ggs_urls(html, "/w/i/ggs/t/");
        assert!(out.contains(r#"src="/w/i/ggs/t/assets/extHost-WxvcU2fk.js""#));
        assert!(out.contains(r#"href="/w/i/ggs/t/assets/modulepreload-B5Qt9EMX.js""#));
        assert!(!out.contains("src=\"/assets/"));
        // A page's own relative references stay untouched.
        let relative = r#"<script src="webview/app.js"></script><a href="/docs">docs</a>"#;
        let out = super::rewrite_ggs_urls(relative, "/w/i/ggs/t/");
        assert!(out.contains(r#"src="webview/app.js""#));
        assert!(out.contains(r#"href="/docs""#));
    }

    #[test]
    fn content_disposition_carries_utf8_names() {
        // ASCII passes through verbatim in both forms.
        assert_eq!(
            super::content_disposition("notes.txt"),
            "attachment; filename=\"notes.txt\"; filename*=UTF-8''notes.txt"
        );
        // A Chinese name: the fallback degrades to underscores, the real name rides
        // filename* percent-encoded (报 = E6 8A A5, 告 = E5 91 8A), the space included.
        let header = super::content_disposition("报告 2026.txt");
        assert!(header.starts_with("attachment; filename=\"__ 2026.txt\"; "));
        assert!(header.contains("filename*=UTF-8''%E6%8A%A5%E5%91%8A%202026.txt"));
        // Header injection is impossible: a hostile name's quotes, CR and LF never survive
        // (the fallback replaces them, the encoded form percent-escapes them).
        let hostile = super::content_disposition("a\"\r\nb.txt");
        assert_eq!(hostile.matches('"').count(), 2); // the fallback's own framing only
        assert!(!hostile.contains(['\r', '\n']));
    }
}
