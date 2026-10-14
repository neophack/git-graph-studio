//! Text encodings for the editor (docs/ggs-development-plan.md M3.5): what a file's bytes are
//! in, how they come back out, and which line endings it uses.
//!
//! Detection is VS Code's order of business: a byte-order mark wins; valid UTF-8 is UTF-8;
//! otherwise the legacy encodings a source tree is likely to hold are tried in turn -
//! GB18030 (the superset of GBK / GB2312, so any Chinese Windows file), Shift_JIS, EUC-KR,
//! Big5 - and a file that decodes cleanly under none of them is Windows-1252, which cannot
//! fail. The frontend shows the result in the status bar and saves the file back in the same
//! encoding unless the user picks another; the ids are `encoding_rs`'s WHATWG labels.

use serde::Serialize;

/// The encodings the status bar offers, as `(id, label)`. `utf8bom` is UTF-8 with a BOM.
pub const ENCODINGS: &[(&str, &str)] = &[
    ("utf8", "UTF-8"),
    ("utf8bom", "UTF-8 with BOM"),
    ("utf-16le", "UTF-16 LE"),
    ("utf-16be", "UTF-16 BE"),
    ("gb18030", "GB18030 (GBK)"),
    ("big5", "Big5"),
    ("shift_jis", "Shift JIS"),
    ("euc-kr", "EUC-KR"),
    ("windows-1252", "Western (Windows 1252)"),
    ("iso-8859-1", "Western (ISO 8859-1)"),
];

/// A decoded file: its text, the encoding id it was read with, and its line endings.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Decoded {
    pub text: String,
    pub encoding: &'static str,
    /// `lf` or `crlf` (the first line ending seen; `lf` for a single-line file).
    pub eol: &'static str,
}

fn known(id: &str) -> Option<&'static encoding_rs::Encoding> {
    match id {
        "utf8" | "utf8bom" => Some(encoding_rs::UTF_8),
        "iso-8859-1" => Some(encoding_rs::WINDOWS_1252),
        other => encoding_rs::Encoding::for_label(other.as_bytes()),
    }
}

fn canonical_id(encoding: &'static encoding_rs::Encoding) -> &'static str {
    ENCODINGS
        .iter()
        .find(|(id, _)| known(id) == Some(encoding) && *id != "utf8bom" && *id != "iso-8859-1")
        .map(|(id, _)| *id)
        .unwrap_or("utf8")
}

/// The line ending convention of a text.
pub fn detect_eol(text: &str) -> &'static str {
    match text.find('\n') {
        Some(at) if at > 0 && text.as_bytes()[at - 1] == b'\r' => "crlf",
        _ => "lf",
    }
}

/// How many leading bytes the binary sniff looks at: git's own heuristic window.
pub const SNIFF_BYTES: usize = 8000;

/// Git's binary heuristic over a file's first bytes: a NUL within the first 8000 bytes
/// means binary - unless a UTF-16 BOM explains the NULs (every other byte of such text is
/// one). Every open path (the editor's read, the viewer, the probe) shares this one rule.
pub fn looks_binary(head: &[u8]) -> bool {
    let sniff = &head[..head.len().min(SNIFF_BYTES)];
    let utf16 = matches!(encoding_rs::Encoding::for_bom(head), Some((e, _)) if e == encoding_rs::UTF_16LE || e == encoding_rs::UTF_16BE);
    sniff.contains(&0) && !utf16
}

/// Decode `bytes` as `forced` (an id from [`ENCODINGS`]), or by detection when `None`.
pub fn decode(bytes: &[u8], forced: Option<&str>) -> Decoded {
    if let Some(id) = forced {
        if let Some(encoding) = known(id) {
            let (text, _, _) = encoding.decode(bytes);
            let text = text.into_owned();
            let eol = detect_eol(&text);
            return Decoded {
                text,
                encoding: if id == "utf8bom" {
                    "utf8bom"
                } else {
                    canonical_id(encoding)
                },
                eol,
            };
        }
    }
    // A BOM settles it (and is stripped from the text).
    if let Some((encoding, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, _) = encoding.decode_without_bom_handling(&bytes[bom_len..]);
        let text = text.into_owned();
        let eol = detect_eol(&text);
        let id = if encoding == encoding_rs::UTF_8 {
            "utf8bom"
        } else {
            canonical_id(encoding)
        };
        return Decoded {
            text,
            encoding: id,
            eol,
        };
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Decoded {
            text: text.to_owned(),
            encoding: "utf8",
            eol: detect_eol(text),
        };
    }
    for candidate in [
        encoding_rs::GB18030,
        encoding_rs::SHIFT_JIS,
        encoding_rs::EUC_KR,
        encoding_rs::BIG5,
    ] {
        let (text, had_errors) = candidate.decode_without_bom_handling(bytes);
        if !had_errors {
            let text = text.into_owned();
            let eol = detect_eol(&text);
            return Decoded {
                text,
                encoding: canonical_id(candidate),
                eol,
            };
        }
    }
    let (text, _) = encoding_rs::WINDOWS_1252.decode_without_bom_handling(bytes);
    let text = text.into_owned();
    let eol = detect_eol(&text);
    Decoded {
        text,
        encoding: "windows-1252",
        eol,
    }
}

/// Encode `text` for saving as `id` (defaults to UTF-8 for an unknown id). `eol` converts the
/// line endings: the editor keeps `\n` internally, a CRLF file must go back out as CRLF.
pub fn encode(text: &str, id: &str, eol: &str) -> Vec<u8> {
    let normalised: std::borrow::Cow<str> = if eol == "crlf" {
        std::borrow::Cow::Owned(text.replace("\r\n", "\n").replace('\n', "\r\n"))
    } else {
        std::borrow::Cow::Borrowed(text)
    };
    let mut out = Vec::new();
    match id {
        "utf8bom" => {
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            out.extend_from_slice(normalised.as_bytes());
        }
        "utf-16le" | "utf-16be" => {
            let big = id == "utf-16be";
            out.extend_from_slice(if big { &[0xFE, 0xFF] } else { &[0xFF, 0xFE] });
            for unit in normalised.encode_utf16() {
                out.extend_from_slice(&if big {
                    unit.to_be_bytes()
                } else {
                    unit.to_le_bytes()
                });
            }
        }
        other => match known(other) {
            Some(encoding) if encoding != encoding_rs::UTF_8 => {
                let (bytes, _, _) = encoding.encode(&normalised);
                out.extend_from_slice(&bytes);
            }
            _ => out.extend_from_slice(normalised.as_bytes()),
        },
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_utf8_boms_utf16_and_gbk() {
        assert_eq!(
            decode("héllo\n".as_bytes(), None),
            Decoded {
                text: "héllo\n".into(),
                encoding: "utf8",
                eol: "lf"
            }
        );
        assert_eq!(
            decode(b"\xEF\xBB\xBFhi\r\n", None),
            Decoded {
                text: "hi\r\n".into(),
                encoding: "utf8bom",
                eol: "crlf"
            }
        );
        let utf16 = encode("你好\n", "utf-16le", "lf");
        assert_eq!(
            decode(&utf16, None),
            Decoded {
                text: "你好\n".into(),
                encoding: "utf-16le",
                eol: "lf"
            }
        );
        // 中文 in GBK: the bytes are not valid UTF-8 and decode cleanly as GB18030.
        let gbk = encode("中文注释\r\n", "gb18030", "crlf");
        assert_eq!(gbk, b"\xD6\xD0\xCE\xC4\xD7\xA2\xCA\xCD\r\n");
        assert_eq!(
            decode(&gbk, None),
            Decoded {
                text: "中文注释\r\n".into(),
                encoding: "gb18030",
                eol: "crlf"
            }
        );
        // Anything else falls back to Windows-1252, which never fails.
        assert_eq!(decode(b"caf\xE9", None).encoding, "windows-1252");
        assert_eq!(decode(b"caf\xE9", None).text, "café");
    }

    #[test]
    fn a_forced_encoding_reopens_the_same_bytes_differently() {
        let gbk = encode("中文", "gb18030", "lf");
        assert_eq!(decode(&gbk, Some("gb18030")).text, "中文");
        assert_ne!(decode(&gbk, Some("windows-1252")).text, "中文");
        assert_eq!(
            decode(&gbk, Some("nonsense")).encoding,
            "gb18030",
            "an unknown id falls back to detection"
        );
    }

    #[test]
    fn encoding_round_trips_and_restores_crlf() {
        // Detected on the way back: the unambiguous encodings, and GB18030 (tried first).
        for id in ["utf8", "utf8bom", "utf-16le", "utf-16be", "gb18030"] {
            let bytes = encode("第一行\n第二行\n", id, "crlf");
            let back = decode(&bytes, None);
            assert_eq!(back.text, "第一行\r\n第二行\r\n", "{id}");
            assert_eq!(back.eol, "crlf");
        }
        // Big5 / Shift_JIS / EUC-KR bytes are also valid GB18030, so detection cannot tell
        // them apart; they round-trip when reopened with their encoding (the status bar's
        // picker), which is what VS Code offers for the same ambiguity.
        for id in ["big5", "shift_jis", "euc-kr"] {
            let bytes = encode("第一行\n第二行\n", id, "crlf");
            assert_eq!(
                decode(&bytes, Some(id)).text,
                "第一行\r\n第二行\r\n",
                "{id}"
            );
        }
        assert_eq!(
            encode("a\r\nb\n", "utf8", "lf"),
            b"a\r\nb\n",
            "lf keeps the text as the editor holds it"
        );
        assert_eq!(
            encode("a\r\nb\n", "utf8", "crlf"),
            b"a\r\nb\r\n",
            "crlf never doubles an existing CR"
        );
    }
}
