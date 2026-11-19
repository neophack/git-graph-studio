//! Media commands (module 7's media viewer): `media_info` answers a video/audio file's
//! container-level facts (ggs_fs::media's parsers), and the `ggsmedia://` protocol serves
//! the file's bytes to the player element — HTTP Range requests included, so the webview
//! streams and seeks instead of holding a whole film in memory. Every byte read is
//! confined to the open workspace roots, the same discipline the extension pages' `ggs://`
//! protocol keeps to the extensions home.

use ggs_base::workspace::WorkspaceRoots;
use ggs_fs::media::{self, MediaInfo};
use tauri::State;

/// A video or audio file's container facts for the media viewer's information panel.
#[tauri::command]
pub async fn media_info(path: String) -> Result<MediaInfo, String> {
    media::probe(&path)
}

/// One served window: `[start, end]` byte offsets of the file (inclusive, HTTP style).
type Window = (u64, u64);

/// The largest byte window one protocol response carries (8 MiB): the webview asks in
/// ranges as it plays, so no response ever holds more than this however huge the file is.
const MAX_WINDOW: u64 = 8 * 1024 * 1024;

/// Percent-decode the path the webview spelled in the protocol URL (`convertFileSrc`).
fn url_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' && at + 2 < bytes.len() {
            let hi = bytes.get(at + 1).and_then(|b| (*b as char).to_digit(16));
            let lo = bytes.get(at + 2).and_then(|b| (*b as char).to_digit(16));
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                at += 3;
                continue;
            }
        }
        out.push(bytes[at]);
        at += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The absolute path a protocol request names (its URL path, decoded), or None.
fn request_path(request: &tauri::http::Request<Vec<u8>>) -> Option<String> {
    let path = request.uri().path();
    let decoded = url_decode(path);
    let trimmed = decoded.trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    // The URL's leading slash is not part of the path: a Windows drive arrives as
    // `/C:/…`, a POSIX absolute as `/home/…`, a UNC as `\\server\…`.
    if trimmed.as_bytes().get(1) == Some(&b':')
        || trimmed.starts_with("\\\\")
        || trimmed.starts_with('/')
    {
        Some(trimmed.to_string())
    } else {
        Some(format!("/{trimmed}"))
    }
}

/// Whether `path` sits under one of the open roots (a case-insensitive prefix on Windows,
/// where the same folder arrives with either drive-letter case).
fn under_a_root(path: &str, roots: &[String]) -> bool {
    let lower = path.replace('/', "\\").to_lowercase();
    roots.iter().any(|root| {
        let root_lower = root.replace('/', "\\").to_lowercase();
        let root_trimmed = root_lower.trim_end_matches('\\');
        lower == root_trimmed || lower.starts_with(&format!("{root_trimmed}\\"))
    })
}

/// The byte window a request's `Range` header names (`bytes=a-b`, `bytes=a-`, `bytes=-n`),
/// clamped to the file. None with a malformed header — the caller answers the whole file.
fn range_window(header: Option<&str>, size: u64) -> Option<Window> {
    let spec = header?.trim().strip_prefix("bytes=")?.trim();
    let (start_text, end_text) = spec.split_once('-')?;
    let window = if start_text.is_empty() {
        // The last `n` bytes.
        let n: u64 = end_text.parse().ok()?;
        if n == 0 {
            return None;
        }
        (size.saturating_sub(n), size.saturating_sub(1))
    } else {
        let start: u64 = start_text.parse().ok()?;
        let end = if end_text.is_empty() {
            size.saturating_sub(1)
        } else {
            end_text.parse().ok()?
        };
        if start > end {
            return None; // `bytes=5-2` is malformed, not a window
        }
        (start, end)
    };
    if window.0 >= size {
        return None; // unsatisfiable
    }
    Some((window.0, window.1.min(size.saturating_sub(1))))
}

/// The Content-Type a media extension serves as (the webview's own element sniffs too,
/// but an honest type keeps the range requests coming).
fn content_type(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" | "m4a" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

/// The response body: the request's path decoded, confined to an open root, ranged and
/// window-capped. The variants the webview never plays from still carry a status it can
/// show (403 outside the roots, 404 gone, 416 past the end).
fn media_response(
    request: &tauri::http::Request<Vec<u8>>,
    roots: &[String],
) -> tauri::http::Response<Vec<u8>> {
    let not_found = |status: u16, body: &'static str| {
        tauri::http::Response::builder()
            .status(status)
            .body(body.as_bytes().to_vec())
            .unwrap()
    };
    let Some(path) = request_path(request) else {
        return not_found(404, "no path");
    };
    if !under_a_root(&path, roots) {
        return not_found(403, "outside the open folders");
    }
    let Ok(meta) = std::fs::metadata(&path) else {
        return not_found(404, "gone");
    };
    if !meta.is_file() {
        return not_found(404, "not a file");
    }
    let size = meta.len();
    // An empty file answers 200 with no body: every range spelling of it is unsatisfiable,
    // and the window arithmetic below reads nonsense past zero.
    if size == 0 {
        return tauri::http::Response::builder()
            .status(200u16)
            .header("Content-Type", content_type(&path))
            .header("Accept-Ranges", "bytes")
            .header("Content-Length", "0")
            .body(Vec::new())
            .unwrap();
    }
    let range_header = request.headers().get("range").and_then(|v| v.to_str().ok());
    let requested = range_window(range_header, size);
    // A malformed or unsatisfiable Range asks 416 (the webview shows it), no Range asks
    // the whole file at 200.
    if range_header.is_some() && requested.is_none() {
        return tauri::http::Response::builder()
            .status(416u16)
            .header("Content-Range", format!("bytes */{size}"))
            .body(b"unsatisfiable range".to_vec())
            .unwrap();
    }
    let (start, end, status) = match requested {
        None => (0u64, size.saturating_sub(1), 200u16),
        Some((start, end)) => (start, end, 206u16),
    };
    // One bounded window per response: the webview re-requests as it reads, so playback
    // streams no matter the file's size.
    let window_end = (start + MAX_WINDOW.saturating_sub(1)).min(end);
    let length = window_end - start + 1;
    let mut builder = tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", content_type(&path))
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", length.to_string());
    if status == 206 {
        builder = builder.header(
            "Content-Range",
            format!("bytes {start}-{window_end}/{size}"),
        );
    }
    let mut file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(_) => return not_found(404, "gone"),
    };
    use std::io::{Read, Seek, SeekFrom};
    if file.seek(SeekFrom::Start(start)).is_err() {
        return not_found(404, "unreadable");
    }
    let mut body = vec![0u8; length as usize];
    let mut filled = 0;
    while filled < body.len() {
        match file.read(&mut body[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => break,
        }
    }
    body.truncate(filled);
    builder.body(body).unwrap()
}

/// The `ggsmedia://` protocol handler lib.rs registers: the read runs off the main thread
/// (a several-megabyte seek-and-read must not hold the webview's event thread).
pub fn serve_media(
    roots: State<'_, WorkspaceRoots>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let roots = roots.inner().list();
    tauri::async_runtime::spawn(async move {
        responder.respond(media_response(&request, &roots));
    });
}

#[cfg(test)]
mod media_command_tests {
    use super::*;

    fn roots(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_range_header_names_a_clamped_window() {
        assert_eq!(range_window(Some("bytes=0-99"), 1000), Some((0, 99)));
        assert_eq!(range_window(Some("bytes=500-"), 1000), Some((500, 999)));
        assert_eq!(range_window(Some("bytes=-200"), 1000), Some((800, 999)));
        assert_eq!(range_window(Some("bytes=900-2000"), 1000), Some((900, 999)));
        assert_eq!(range_window(Some("bytes=1000-"), 1000), None); // past the end
        assert_eq!(range_window(Some("bytes=garbage"), 1000), None);
        assert_eq!(range_window(Some("bytes=5-2"), 1000), None); // start past end is malformed
        assert_eq!(range_window(Some("bytes=999-999"), 1000), Some((999, 999)));
        assert_eq!(range_window(None, 1000), None);
    }

    #[test]
    fn paths_outside_every_open_root_are_refused() {
        let open = roots(&["C:\\repo", "D:\\media"]);
        assert!(under_a_root("C:\\repo\\video\\clip.mp4", &open));
        assert!(under_a_root("c:/REPO/clip.mp4", &open)); // case and slash spellings agree
        assert!(under_a_root("D:\\media\\song.flac", &open));
        assert!(!under_a_root("C:\\elsewhere\\clip.mp4", &open));
        // A sibling folder that shares the root's name as a prefix is not inside it.
        assert!(!under_a_root("C:\\repo2\\clip.mp4", &open));
        assert!(!under_a_root("C:\\", &open));
    }

    #[test]
    fn the_url_path_decodes_to_the_file() {
        let request = tauri::http::Request::builder()
            .uri("http://ggsmedia.localhost/C%3A%5Crepo%5Cclip%20one.mp4")
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            request_path(&request).as_deref(),
            Some("C:\\repo\\clip one.mp4")
        );
        let posix = tauri::http::Request::builder()
            .uri("ggsmedia://localhost/home/user/clip.mp4")
            .body(Vec::new())
            .unwrap();
        assert_eq!(request_path(&posix).as_deref(), Some("/home/user/clip.mp4"));
    }

    #[test]
    fn a_ranged_read_answers_a_bounded_window_with_its_content_range() {
        let dir = std::env::temp_dir().join(format!("ggs-media-proto-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("clip.bin");
        std::fs::write(
            &file,
            (0..100_000u32).map(|i| (i % 251) as u8).collect::<Vec<_>>(),
        )
        .unwrap();
        // The spelling the webview hands over: a Windows drive path (`C:\…`) or the POSIX
        // absolute form — `request_path` strips the URL's leading slash from both.
        let path = if cfg!(windows) {
            file.to_str().unwrap().replace('/', "\\")
        } else {
            file.to_str().unwrap().to_string()
        };
        let open = roots(&[&path]);

        let make_with = |range: Option<&str>, file: &str| {
            let mut builder = tauri::http::Request::builder()
                .uri(format!("http://ggsmedia.localhost/{}", url::encode(file)));
            if let Some(range) = range {
                builder = builder.header("Range", range);
            }
            builder.body(Vec::new()).unwrap()
        };
        let make = |range: Option<&str>| make_with(range, &path);

        // A mid-file window: 206, the asked range spelled back, exactly 1000 bytes.
        let response = media_response(&make(Some("bytes=1000-1999")), &open);
        assert_eq!(response.status(), 206);
        assert_eq!(
            response.headers()["Content-Range"],
            "bytes 1000-1999/100000"
        );
        assert_eq!(response.body().len(), 1000);

        // An open-ended range caps at the serving window, not the whole file.
        let response = media_response(&make(Some("bytes=0-")), &open);
        assert_eq!(response.status(), 206);
        assert_eq!(response.body().len() as u64, MAX_WINDOW.min(100_000));
        assert_eq!(response.headers()["Accept-Ranges"], "bytes");

        // No range: the whole (small) file at 200.
        let response = media_response(&make(None), &open);
        assert_eq!(response.status(), 200);
        assert_eq!(response.body().len(), 100_000);

        // Outside the roots: 403, the bytes never leave the disk.
        let response = media_response(&make(None), &roots(&["C:\\elsewhere"]));
        assert_eq!(response.status(), 403);

        // Past the end: 416.
        let response = media_response(&make(Some("bytes=200000-")), &open);
        assert_eq!(response.status(), 416);

        // An empty file answers 200 with an empty body, whatever was asked.
        let empty = dir.join("empty.bin");
        std::fs::write(&empty, b"").unwrap();
        let empty_path = if cfg!(windows) {
            empty.to_str().unwrap().replace('/', "\\")
        } else {
            empty.to_str().unwrap().to_string()
        };
        let empty_roots = roots(&[&empty_path]);
        for range in [None, Some("bytes=0-"), Some("bytes=-10")] {
            let response = media_response(&make_with(range, &empty_path), &empty_roots);
            assert_eq!(response.status(), 200);
            assert_eq!(response.body().len(), 0);
            assert_eq!(response.headers()["Content-Length"], "0");
        }

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The percent spelling `convertFileSrc` produces (a minimal stand-in for the test).
    mod url {
        pub fn encode(path: &str) -> String {
            let mut out = String::new();
            if path.len() > 1 && path.as_bytes()[1] == b':' {
                out.push('/');
            }
            for byte in path.bytes() {
                match byte {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'.' | b'-' | b'_' => {
                        out.push(byte as char)
                    }
                    _ => out.push_str(&format!("%{byte:02X}")),
                }
            }
            out
        }
    }
}
