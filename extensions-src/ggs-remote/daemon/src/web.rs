//! The daemon's own small pages (docs/ggs-remote-plan.md §5 `web/`, §10.1 stages 1–2): login,
//! window picker and the loopback pair page, embedded in the binary. No build step: plain
//! ES2021 files, compressed with brotli once on first use and served with a content-hash
//! ETag.

use std::collections::HashMap;
use std::sync::OnceLock;

pub struct WebFile {
    pub name: &'static str,
    pub content_type: &'static str,
    pub body: &'static [u8],
}

macro_rules! web_file {
    ($name:literal, $type:literal) => {
        WebFile {
            name: $name,
            content_type: $type,
            body: include_bytes!(concat!("../web/", $name)),
        }
    };
}

pub static FILES: &[WebFile] = &[
    web_file!("login.html", "text/html; charset=utf-8"),
    web_file!("picker.html", "text/html; charset=utf-8"),
    web_file!("pair.html", "text/html; charset=utf-8"),
    web_file!("notice.html", "text/html; charset=utf-8"),
    web_file!("login.js", "text/javascript; charset=utf-8"),
    web_file!("picker.js", "text/javascript; charset=utf-8"),
    web_file!("pair.js", "text/javascript; charset=utf-8"),
    web_file!("notice.js", "text/javascript; charset=utf-8"),
    web_file!("i18n.js", "text/javascript; charset=utf-8"),
    web_file!("wire.js", "text/javascript; charset=utf-8"),
    web_file!("style.css", "text/css; charset=utf-8"),
    web_file!("icon.svg", "image/svg+xml"),
];

pub struct Prepared {
    pub content_type: &'static str,
    pub etag: String,
    pub identity: &'static [u8],
    pub br: Vec<u8>,
}

fn prepared() -> &'static HashMap<&'static str, Prepared> {
    static MAP: OnceLock<HashMap<&'static str, Prepared>> = OnceLock::new();
    MAP.get_or_init(|| {
        FILES
            .iter()
            .map(|f| {
                let etag = format!(
                    "\"{}\"",
                    &crate::util::hex(&crate::util::sha256(f.body))[..16]
                );
                (
                    f.name,
                    Prepared {
                        content_type: f.content_type,
                        etag,
                        identity: f.body,
                        br: crate::cache::brotli(f.body),
                    },
                )
            })
            .collect()
    })
}

pub fn get(name: &str) -> Option<&'static Prepared> {
    prepared().get(name)
}

/// An HTML page with the proxied base path written into `<base href>` (§20.5): every link
/// inside the pages is relative, so one source serves `/` and `/u/<uuid>/` alike.
pub fn html_with_base(name: &str, base_path: &str) -> Option<String> {
    let file = get(name)?;
    let text = std::str::from_utf8(file.identity).ok()?;
    let escaped: String = base_path
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || "/-_".contains(*c))
        .collect();
    Some(text.replace("<base href=\"/\">", &format!("<base href=\"{escaped}\">")))
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_page_carries_a_base_tag() {
        for name in ["login.html", "picker.html", "pair.html", "notice.html"] {
            let html = super::html_with_base(name, "/u/abc/").unwrap();
            assert!(html.contains("<base href=\"/u/abc/\">"), "{name}");
        }
    }

    #[test]
    fn files_are_prepared_with_etags() {
        let css = super::get("style.css").unwrap();
        assert!(css.etag.starts_with('"'));
        assert!(!css.br.is_empty());
    }
}
