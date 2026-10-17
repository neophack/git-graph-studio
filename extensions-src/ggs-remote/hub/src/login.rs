//! The joint login (docs/ggs-remote-plan.md §20.14, the owner's 2026-10-16 direction): the
//! Hub — the server — serves the login page and checks the password itself against the
//! Argon2id verifier the daemon pushed over the tunnel, then forwards the very same login
//! to the daemon, which runs its own check and issues its own session. One password entry
//! authenticates on BOTH halves; neither alone lets a browser through. Until it succeeds,
//! the Hub proxies nothing toward the PC: a relay cannot be turned into a content host by
//! whoever holds the link's uuid — every byte a browser can pull through `/u/<uuid>/`
//! belongs to a password holder's session. (The LAN keeps its own, unchanged rule: the
//! daemon's password, the daemon's login page.)

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::frame::{flag, ty, Frame};
use crate::front::{forward_headers, hub_extras};
use crate::http_proxy::{body_frames, cookie_secure, wait_head, SessionSlot};
use crate::msg::{HttpReq, HttpRes};
use crate::state::{Credential, Hub, ToConn, Tunnel};

/// The Hub-side half's cookie (the daemon's own stays `ggsr`): HttpOnly, Strict, scoped to
/// the link's `/u/<uuid>/` path — one browser may hold logins on several links of one Hub,
/// and they never mix.
pub const COOKIE: &str = "ggsrh";

/// A login body is small JSON (the daemon's `LoginBody`: password, device, remember); the
/// forwarded answer is smaller. Anything past this is refused rather than buffered.
const MAX_LOGIN_BODY: usize = 4096;
const MAX_ANSWER_BODY: usize = 64 * 1024;
/// The PC answers a login in well under a second; thirty covers a cold daemon.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(30);

// ---- the page ----

/// The login page, served by the Hub itself (never proxied): the PC's display language —
/// carried by the credential frame — picks the strings, so the page reads like the daemon's
/// own on the LAN.
pub fn page(tunnel: &Arc<Tunnel>, base_path: &str) -> Response {
    let Some(credential) = tunnel.credential() else {
        return not_presenting(tunnel);
    };
    let html = render_page(&credential, base_path);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(
            header::CONTENT_SECURITY_POLICY,
            // `connect-src 'self'`: the page signs in with its own `fetch('api/hub-login')` —
            // under `default-src 'none'` alone every browser blocked that request, and no
            // one could sign in through a relay at all.
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        )
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .body(Body::from(html))
        .expect("a static page")
}

fn render_page(credential: &Credential, base_path: &str) -> String {
    let zh = credential.lang.eq_ignore_ascii_case("zh-cn") || credential.lang.starts_with("zh");
    let strings = strings_for(zh);
    let mut html = include_str!("../web/login.html").to_owned();
    html = html.replace("__LANG__", if zh { "zh-cn" } else { "en" });
    html = html.replace("__BASE__", base_path);
    for (token, value) in strings {
        html = html.replace(&format!("__{token}__"), value.as_str());
    }
    html
}

/// The string table, mirroring the daemon's login page (`daemon/web/i18n.js`) so the two
/// halves of one product speak with one voice.
fn strings_for(zh: bool) -> Vec<(&'static str, String)> {
    let pairs: &[(&str, &str, &str)] = &[
        // (token, en, zh-cn)
        (
            "TITLE",
            "Git Graph Studio Remote",
            "Git Graph Studio 远程访问",
        ),
        ("PASSWORD", "Access password", "访问密码"),
        ("DEVICE", "Device name (optional)", "设备名称（可选）"),
        (
            "REMEMBER",
            "Keep me signed in on this device (30 days)",
            "在此设备上保持登录（30 天）",
        ),
        ("SIGN_IN", "Sign in", "登录"),
        ("WRONG", "Wrong password.", "密码错误。"),
        (
            "LOCKED",
            "Too many attempts. Try again in {n} s.",
            "尝试次数过多，请 {n} 秒后再试。",
        ),
        ("FAILED", "Sign-in failed: {msg}", "登录失败：{msg}"),
        (
            "OFFLINE",
            "This PC is not answering through the relay.",
            "这台电脑没有通过中继服务器应答。",
        ),
        (
            "REASON_PASSWORD_CHANGED",
            "The password was changed. Please sign in again.",
            "密码已更改，请重新登录。",
        ),
        (
            "REASON_CREDENTIALS_CHANGED",
            "The password was changed. Please sign in again.",
            "密码已更改，请重新登录。",
        ),
        (
            "REASON_REVOKED",
            "This device was signed out.",
            "此设备已被登出。",
        ),
        (
            "REASON_EXPIRED",
            "Your session expired. Please sign in again.",
            "会话已过期，请重新登录。",
        ),
    ];
    pairs
        .iter()
        .map(|(token, en, zh_cn)| (*token, if zh { *zh_cn } else { *en }.to_owned()))
        .collect()
}

/// A tunnel that never presented a verifier: either it is still settling in — the frame
/// rides right behind `T_READY` — or the daemon predates the joint login and needs the
/// update. The first answer asks for a moment; the second is the upgrade page.
pub fn not_presenting(tunnel: &Arc<Tunnel>) -> Response {
    if tunnel.age() < Duration::from_secs(5) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "this PC is coming online — try again in a moment",
        )
            .into_response();
    }
    let html = include_str!("../web/upgrade.html");
    Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(html))
        .expect("a static page")
}

// ---- the gate ----

/// Everything a browser reaches through a link, beyond the Hub's own login corner, needs
/// the Hub-side session (§20.14): the joint proof that this browser's password was checked
/// HERE, before one byte is proxied toward the PC. Answers the denial response when it
/// must not pass. A tunnel that presented no verifier fails CLOSED — the login corner is
/// the only thing such a link serves until the PC's app is updated.
pub fn gate(
    hub: &Arc<Hub>,
    tunnel: &Arc<Tunnel>,
    base_path: &str,
    method: &Method,
    rest: &str,
    headers: &HeaderMap,
) -> Option<Response> {
    let Some(credential) = tunnel.credential() else {
        // No verifier yet: the settling-in answer or the upgrade page — never the proxy.
        return Some(not_presenting(tunnel));
    };
    let token = cookie_token(headers);
    let valid = token
        .as_deref()
        .is_some_and(|token| hub.link_session_valid(&tunnel.uuid, token, credential.epoch));
    if valid {
        return None;
    }
    Some(denial(base_path, method, rest, headers))
}

/// How a refusal reads: a navigation lands on the login page, a WebSocket is refused its
/// upgrade, and everything else is a plain 401 the app's fetch layer understands.
fn denial(base_path: &str, method: &Method, rest: &str, headers: &HeaderMap) -> Response {
    if rest == "ws"
        || headers.get("upgrade").is_some_and(|v| {
            v.to_str()
                .is_ok_and(|v| v.eq_ignore_ascii_case("websocket"))
        })
    {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "sign in first",
        )
            .into_response();
    }
    if wants_document(headers) && (method == Method::GET || method == Method::HEAD) {
        return Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, format!("{base_path}login"))
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::empty())
            .expect("valid redirect");
    }
    (
        StatusCode::UNAUTHORIZED,
        [(header::CONTENT_TYPE, "application/json")],
        "{\"error\":\"hub-session-required\"}",
    )
        .into_response()
}

/// A browser navigation for a document (the daemon's own `wants_document` rule): every
/// current browser says it with `Sec-Fetch-Dest`; an `Accept` led by `text/html` is the
/// pre-Sec-Fetch fallback.
fn wants_document(headers: &HeaderMap) -> bool {
    if headers
        .get("sec-fetch-dest")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == "document")
    {
        return true;
    }
    headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim_start().starts_with("text/html"))
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    for value in headers.get_all(header::COOKIE) {
        let Ok(text) = value.to_str() else { continue };
        for part in text.split(';') {
            if let Some((name, value)) = part.trim().split_once('=') {
                if name == COOKIE {
                    return Some(value.to_owned());
                }
            }
        }
    }
    None
}

/// State-changing login posts must be JSON and same-site — the daemon's own rule (§16),
/// applied at the Hub's door.
fn json_request_ok(headers: &HeaderMap) -> bool {
    let json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/json"));
    let site_ok = headers
        .get("sec-fetch-site")
        .and_then(|v| v.to_str().ok())
        .is_none_or(|v| v == "same-origin" || v == "none");
    json && site_ok
}

// ---- the joint check ----

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct LoginBody {
    password: String,
    device: String,
    remember: bool,
}

/// The ceiling on Argon2 verifications in flight at once — the daemon's own audit-F3 rule:
/// each hash holds ~19 MiB and a core, and unbounded concurrent junk logins are a memory
/// attack on the relay itself.
fn verify_permits() -> &'static tokio::sync::Semaphore {
    static PERMITS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    PERMITS.get_or_init(|| {
        tokio::sync::Semaphore::new(2 * std::thread::available_parallelism().map_or(2, |n| n.get()))
    })
}

/// The Argon2 check itself, on the blocking pool (a verify is ~50 ms of CPU and the Hub's
/// runtime serves every link). The verifier is the daemon's own PHC string, so its
/// parameters — 19 MiB, two passes — govern.
pub async fn verify_password(hash: &str, password: &str) -> bool {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    let hash = hash.to_owned();
    let password = password.to_owned();
    let Ok(_permit) = verify_permits().acquire().await else {
        return false;
    };
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash)
            .map(|parsed| {
                argon2::Argon2::default()
                    .verify_password(password.as_bytes(), &parsed)
                    .is_ok()
            })
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// `POST /u/<uuid>/api/hub-login` — the one password entry. First the Hub's own check
/// against the verifier (a wrong password never even wakes the PC), then the forwarded
/// login, which the daemon checks with its own Argon2 and answers with its own session
/// cookie; the Hub's cookie rides the same response. Both must pass — a verifier the Hub
/// holds can go stale without the daemon noticing, and the daemon's word is the one that
/// gates the content.
pub async fn submit(
    hub: Arc<Hub>,
    tunnel: Arc<Tunnel>,
    base_path: String,
    ip: IpAddr,
    // The DIRECT socket peer — the trusted-proxy gate for the forwarded headers.
    peer: IpAddr,
    request: Request,
) -> Response {
    let headers = request.headers().clone();
    if !json_request_ok(&headers) {
        return error_json(StatusCode::UNSUPPORTED_MEDIA_TYPE, "json-required");
    }
    let body = match axum::body::to_bytes(request.into_body(), MAX_LOGIN_BODY).await {
        Ok(body) => body,
        Err(_) => return error_json(StatusCode::PAYLOAD_TOO_LARGE, "too-large"),
    };
    let login: LoginBody = match serde_json::from_slice(&body) {
        Ok(login) => login,
        Err(_) => return error_json(StatusCode::BAD_REQUEST, "bad-request"),
    };
    if login.password.len() > 256 {
        return error_json(StatusCode::BAD_REQUEST, "bad-request");
    }
    // The same window the proxied login always had (§20.6): ten entries a minute per
    // address per link — junk logins never reach the Argon2 core.
    if !hub.login_entry(ip, &tunnel.uuid) {
        return crate::http_proxy::too_many_requests();
    }
    let Some(credential) = tunnel.credential() else {
        return not_presenting(&tunnel);
    };

    // The server's half: the Hub's own verification of the daemon's verifier.
    if !verify_password(&credential.hash, &login.password).await {
        if hub.audit.enabled() {
            hub.audit.log(
                "link_login",
                &[
                    ("uuid", serde_json::json!(tunnel.uuid)),
                    ("ip", serde_json::json!(ip.to_string())),
                    ("ok", serde_json::json!(false)),
                    ("half", serde_json::json!("hub")),
                ],
            );
        }
        crate::warn!("link login for {} from {ip}: wrong password", tunnel.uuid);
        return error_json(StatusCode::UNAUTHORIZED, "wrong-password");
    }

    // The plugin's half: the daemon runs its own check and issues its own session.
    match forward_login(&hub, &tunnel, &base_path, ip, peer, &headers, body.to_vec()).await {
        Forwarded::Answer { head, body } => {
            let ok = StatusCode::from_u16(head.status).is_ok_and(|s| s == StatusCode::OK);
            if hub.audit.enabled() {
                hub.audit.log(
                    "link_login",
                    &[
                        ("uuid", serde_json::json!(tunnel.uuid)),
                        ("ip", serde_json::json!(ip.to_string())),
                        ("ok", serde_json::json!(ok)),
                        ("half", serde_json::json!("daemon")),
                    ],
                );
            }
            let mut builder = Response::builder()
                .status(StatusCode::from_u16(head.status).unwrap_or(StatusCode::BAD_GATEWAY));
            for (name, value) in &head.headers {
                if name.eq_ignore_ascii_case("transfer-encoding")
                    || name.eq_ignore_ascii_case("connection")
                    || name.eq_ignore_ascii_case("keep-alive")
                    || name.eq_ignore_ascii_case("content-length")
                {
                    continue;
                }
                if let (Ok(name), Ok(value)) = (
                    axum::http::HeaderName::from_bytes(name.as_bytes()),
                    HeaderValue::from_str(value),
                ) {
                    // Repeatable headers (`set-cookie`) cross in full; singletons keep
                    // the first spelling.
                    if name != header::SET_COOKIE
                        && builder
                            .headers_ref()
                            .is_some_and(|set| set.contains_key(&name))
                    {
                        continue;
                    }
                    builder = builder.header(name, value);
                }
            }
            if ok {
                let (token, max_age) =
                    hub.issue_link_session(&tunnel.uuid, credential.epoch, login.remember, ip);
                let secure = cookie_secure(&hub, peer, &headers);
                let cookie = format!(
                    "{COOKIE}={token}; HttpOnly; SameSite=Strict; Path={base_path}; Max-Age={max_age}{}",
                    if secure { "; Secure" } else { "" }
                );
                if let Ok(value) = HeaderValue::from_str(&cookie) {
                    builder = builder.header(header::SET_COOKIE, value);
                }
                crate::info!("link login for {} from {ip}", tunnel.uuid);
            }
            builder.body(Body::from(body)).unwrap_or_else(|_| {
                crate::http_proxy::error_page(StatusCode::BAD_GATEWAY, "this PC did not answer")
            })
        }
        Forwarded::Offline => {
            crate::http_proxy::error_page(StatusCode::SERVICE_UNAVAILABLE, "this PC went offline")
        }
        Forwarded::BudgetSpent => crate::http_proxy::budget_spent(),
        Forwarded::Timeout => crate::http_proxy::error_page(
            StatusCode::GATEWAY_TIMEOUT,
            "this PC did not answer in time",
        ),
    }
}

enum Forwarded {
    Answer {
        head: HttpRes,
        body: Vec<u8>,
    },
    Offline,
    /// The link's daily byte budget is spent — the proxy path's own 429 answer, not the
    /// offline 503: the PC is not away, the link's allowance is.
    BudgetSpent,
    Timeout,
}

/// One full request/answer round trip toward the PC on a fresh session: the head, then the
/// body drained to its FIN (a login's answer is a few hundred bytes). The slot guard frees
/// the session however the round trip leaves.
async fn forward_login(
    hub: &Arc<Hub>,
    tunnel: &Arc<Tunnel>,
    base_path: &str,
    ip: IpAddr,
    peer: IpAddr,
    headers: &HeaderMap,
    body: Vec<u8>,
) -> Forwarded {
    let session = hub.alloc_session();
    let (conn_tx, mut conn_rx) = mpsc::unbounded_channel::<ToConn>();
    if !tunnel.reserve_conn(hub.config.sessions_per_tunnel, session, conn_tx) {
        return Forwarded::Offline;
    }
    let _slot = SessionSlot {
        tunnel: tunnel.clone(),
        session,
        armed: true,
    };
    let mut head = HttpReq {
        method: "POST".into(),
        path: "/api/login".into(),
        query: String::new(),
        headers: forward_headers(headers),
        ip: ip.to_string(),
        base_path: base_path.to_owned(),
    };
    for (name, value) in hub_extras(hub, peer, base_path, ip, headers) {
        head.headers.insert(name, value);
    }
    let mut frames = vec![Frame::msgpack(ty::HTTP_REQ, &head).with_session(session)];
    frames.extend(body_frames(session, &body));
    if let Some(last) = frames.last_mut() {
        last.flags |= flag::FIN;
    }
    let mut uplink = 0u64;
    let mut encoded = Vec::with_capacity(frames.len());
    for frame in frames {
        let bytes = frame.encode();
        uplink += bytes.len() as u64;
        encoded.push(bytes);
    }
    hub.counters
        .bytes_down
        .fetch_add(uplink, std::sync::atomic::Ordering::Relaxed);
    if !tunnel.spend(uplink) {
        return Forwarded::BudgetSpent;
    }
    for bytes in encoded {
        if tunnel.tx.send(bytes).is_err() {
            return Forwarded::Offline;
        }
    }
    let head = match tokio::time::timeout(ANSWER_TIMEOUT, wait_head(&mut conn_rx)).await {
        Ok(Some(head)) => head,
        Ok(None) => return Forwarded::Offline,
        Err(_) => return Forwarded::Timeout,
    };
    let mut body = Vec::new();
    let answer = loop {
        match tokio::time::timeout(ANSWER_TIMEOUT, conn_rx.recv()).await {
            Ok(Some(ToConn::Bytes(bytes))) => {
                let Some(frames) = Frame::decode_all(&bytes) else {
                    continue;
                };
                let mut fin = false;
                for frame in frames {
                    fin |= frame.fin();
                    body.extend_from_slice(&frame.payload);
                }
                if fin || body.len() > MAX_ANSWER_BODY {
                    break Forwarded::Answer { head, body };
                }
            }
            Ok(Some(ToConn::Close { .. })) | Ok(None) => {
                break Forwarded::Answer { head, body };
            }
            Err(_) => break Forwarded::Timeout,
        }
    };
    answer
}

fn error_json(status: StatusCode, message: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        format!("{{\"error\":\"{message}\"}}"),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_follows_the_pcs_language() {
        let en = render_page(
            &Credential {
                hash: String::new(),
                epoch: 1,
                lang: "en".into(),
            },
            "/u/abc/",
        );
        assert!(en.contains("Access password"));
        let zh = render_page(
            &Credential {
                hash: String::new(),
                epoch: 1,
                lang: "zh-cn".into(),
            },
            "/u/abc/",
        );
        assert!(zh.contains("访问密码"));
        // Every localization token is replaced in both renderings (the page's own comments
        // may spell the word "tokens", the served strings may not).
        for page in [&en, &zh] {
            for token in [
                "__LANG__",
                "__TITLE__",
                "__PASSWORD__",
                "__DEVICE__",
                "__REMEMBER__",
                "__SIGN_IN__",
                "__WRONG__",
                "__LOCKED__",
                "__FAILED__",
                "__OFFLINE__",
            ] {
                assert!(!page.contains(token), "{token} survived");
            }
        }
    }

    #[test]
    fn the_cookie_is_read_from_the_link_scope() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("ggsr=daemon; ggsrh=hub; other=1"),
        );
        assert_eq!(cookie_token(&headers).as_deref(), Some("hub"));
    }

    #[test]
    fn an_argon2_verifier_answers_for_its_password() {
        use argon2::password_hash::{PasswordHasher, SaltString};
        // A PHC string the way the daemon writes them (its parameters parse out of the
        // string itself, so a default-params hash verifies the same way).
        let hash = argon2::Argon2::default()
            .hash_password(
                b"tangerine-kayak-42",
                &SaltString::encode_b64(&[7u8; 16]).unwrap(),
            )
            .unwrap()
            .to_string();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        assert!(rt.block_on(verify_password(&hash, "tangerine-kayak-42")));
        assert!(!rt.block_on(verify_password(&hash, "nope")));
        assert!(!rt.block_on(verify_password("not-a-hash", "x")));
    }
}
