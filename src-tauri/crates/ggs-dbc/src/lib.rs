//! ggs-dbc (module 13): the CAN Database Viewer's engine — a DBC (Vector CAN database,
//! the text format CANoe/candb++ write) parsed into messages, signals, value tables and
//! comments, plus the frame decoder the view's Decode panel runs: payload bytes in,
//! physical signal values out, byte order (Intel little-endian / Motorola big-endian),
//! scaling and multiplexing all honoured. The crate is pure Rust; `cmd_dbc.rs` is the
//! only file that may name tauri.
//!
//! The grammar is the de-facto Vector one (the spec was never published): `BO_`/`SG_`
//! lines carry the frames, `VAL_` the named values, `CM_` the comments (which span
//! lines), `BU_` the nodes; `NS_`/`BS_`/`BA_*`/`EV_` and friends are tolerated and
//! skipped. Extended frames are recognised the way the writers spell them: the
//! 0x80000000 flag bit (Vector/J1939), or a raw id past 0x7ff.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

/* ---------- The document ---------- */

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbcSignal {
    pub name: String,
    /// The start bit in the DBC's own numbering: the LSB position for a little-endian
    /// signal, the MSB position for a big-endian one.
    pub start_bit: u32,
    pub length: u32,
    /// `@0` in the file: Intel byte order, bits flowing up from the LSB.
    pub little_endian: bool,
    /// `@…-` in the file: two's-complement raw value.
    pub signed: bool,
    pub scale: f64,
    pub offset: f64,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub unit: String,
    pub receivers: Vec<String>,
    /// `"M"` the multiplexer switch, `"m3"` a member of group 3, `None` an ordinary
    /// signal.
    pub multiplex: Option<String>,
    pub comment: Option<String>,
    /// The `VAL_` table: raw value → its label, in file order.
    pub values: Vec<(f64, String)>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbcMessage {
    /// The canonical 11- or 29-bit identifier (any 0x80000000 flag cleared).
    pub id: u32,
    pub name: String,
    pub dlc: u32,
    pub transmitter: String,
    pub extended: bool,
    pub comment: Option<String>,
    pub signals: Vec<DbcSignal>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbcDocument {
    pub version: String,
    pub nodes: Vec<String>,
    pub messages: Vec<DbcMessage>,
}

/* ---------- The decoder's answer ---------- */

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DecodedSignal {
    pub name: String,
    /// The unscaled bit pattern, as the wire carries it.
    pub raw: i64,
    /// `raw * scale + offset`, and the `VAL_` label when one names this raw value.
    pub value: f64,
    pub unit: String,
    pub label: Option<String>,
}

/* ---------- Line scanning ---------- */

/// A line's whitespace-separated tokens, quoted regions kept whole (a unit or comment
/// may carry spaces; the quotes themselves are kept so the parser can tell a string
/// token from a bare one).
fn tokens(line: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    let mut in_quotes = false;
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if in_quotes {
            if b == b'"' && !escaped_at(bytes, i) {
                in_quotes = false;
            }
        } else if b == b'"' {
            in_quotes = true;
            if start.is_none() {
                start = Some(i);
            }
        } else if b <= b' ' {
            if let Some(s) = start.take() {
                if i > s {
                    out.push(&line[s..i]);
                }
            }
        } else if start.is_none() {
            start = Some(i);
        }
        i += 1;
    }
    if let Some(s) = start {
        if bytes.len() > s {
            out.push(&line[s..]);
        }
    }
    out
}

/// Whether the quote at byte `at` is escaped (an odd run of backslashes precedes it).
fn escaped_at(bytes: &[u8], at: usize) -> bool {
    let mut back = 0;
    while back < at && bytes[at - 1 - back] == b'\\' {
        back += 1;
    }
    back % 2 == 1
}

/// Unescapes a DBC string literal's body (`\"` and `\\` — the two the format defines).
fn unescape(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn parse_num(tok: &str) -> Option<f64> {
    let t = tok.trim();
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        u64::from_str_radix(hex, 16).ok().map(|v| v as f64)
    } else {
        t.parse::<f64>().ok()
    }
}

fn parse_int(tok: &str) -> Option<i64> {
    let t = tok.trim();
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        u64::from_str_radix(hex, 16).ok().map(|v| v as i64)
    } else {
        t.parse::<i64>().ok()
    }
}

/// A keyword line's keyword: the token before the first whitespace, `BO_` style —
/// with a trailing colon stripped (`BS_:`, `NS_:` spell their marker attached).
fn keyword(line: &str) -> &str {
    let trimmed = line.trim_start();
    let word = match trimmed.find(char::is_whitespace) {
        Some(at) => &trimmed[..at],
        None => trimmed,
    };
    word.trim_end_matches(':')
}

/* ---------- Parsing ---------- */

/// Whether a token between the name and the colon is a multiplexer mark: `M`, `m3`,
/// or the extended `m4M` pair spelling.
fn is_mux_mark(tok: &str) -> bool {
    if tok == "M" {
        return true;
    }
    let Some(rest) = tok.strip_prefix('m') else { return false };
    let digits = rest.trim_end_matches('M');
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// One `SG_` line's body: `Name [mN|M] : start|len@order+sign (scale,offset)
/// [min|max] "unit" receivers…` — the multiplexer mark rides between the name and the
/// colon (the Vector spelling), or glued to the name (`Name_m0`) as some writers do.
fn parse_signal_line(rest: &str) -> Option<DbcSignal> {
    let mut toks = tokens(rest);
    let mut multiplex: Option<String> = None;
    let mut name = toks.first()?.to_string();
    // The colon separator may share the next token or stand alone.
    let colon_at = toks.iter().position(|t| *t == ":")?;
    if colon_at == 2 && toks.get(1).is_some_and(|s| is_mux_mark(s)) {
        multiplex = Some(toks[1].to_string());
    }
    if multiplex.is_none() {
        // Glued marks (`Voltage_m0`): the `mN`/`M` suffix strips off the name.
        if let Some(at) = name.rfind(['m', 'M']) {
            let mark = &name[at..];
            let head = &name[..at];
            if (mark == "M" || (mark.len() > 1 && mark.starts_with('m') && mark[1..].bytes().all(|b| b.is_ascii_digit())))
                && !head.is_empty()
                && head.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                multiplex = Some(mark.to_string());
                name.truncate(at);
            }
        }
    }
    if name.is_empty() {
        return None;
    }
    toks.drain(..=colon_at);
    if toks.len() < 2 {
        return None;
    }
    // `start|len@order+sign`
    let bits_tok = toks.remove(0);
    let (bits, order) = bits_tok.split_once('@')?;
    let (start, len) = bits.split_once('|')?;
    let start: u32 = start.trim().parse().ok()?;
    let length: u32 = len.trim().parse().ok()?;
    let (order, sign) = order.split_at(order.len().saturating_sub(1));
    let little_endian = order == "0";
    let signed = sign == "-";
    // `(scale,offset)`
    let scale_tok = toks.remove(0);
    let scale_tok = scale_tok.trim_start_matches('(');
    let scale_tok = scale_tok.trim_end_matches(')');
    let (scale, offset) = scale_tok.split_once(',')?;
    let scale = parse_num(scale).unwrap_or(1.0);
    let offset = parse_num(offset).unwrap_or(0.0);
    // `[min|max]` — optional (some writers leave `[]`)
    let mut min = None;
    let mut max = None;
    if let Some(range_tok) = toks.first() {
        if range_tok.starts_with('[') {
            let range = range_tok.trim_start_matches('[').trim_end_matches(']');
            toks.remove(0);
            if let Some((lo, hi)) = range.split_once('|') {
                min = parse_num(lo);
                max = parse_num(hi);
            }
        }
    }
    // `"unit"` then the receivers.
    let mut unit = String::new();
    if let Some(unit_tok) = toks.first() {
        if unit_tok.starts_with('"') {
            unit = unescape(unit_tok.trim_matches('"'));
            toks.remove(0);
        }
    }
    let receivers = toks
        .into_iter()
        .filter(|r| !r.is_empty())
        .map(|r| r.to_string())
        .collect();
    Some(DbcSignal {
        name: name.to_string(),
        start_bit: start,
        length,
        little_endian,
        signed,
        scale,
        offset,
        min,
        max,
        unit,
        receivers,
        multiplex,
        comment: None,
        values: Vec::new(),
    })
}

/// The document's parse. Comments (`CM_`, multi-line) and value tables (`VAL_`) fold
/// into the messages after the main walk; anything unrecognised is skipped, not fatal —
/// a real database mixes dialects.
pub fn parse(text: &str) -> Result<DbcDocument, String> {
    if text.len() > 64 * 1024 * 1024 {
        return Err("the file is past the 64 MiB this parser accepts".to_string());
    }
    let mut version = String::new();
    let mut nodes: Vec<String> = Vec::new();
    let mut messages: Vec<DbcMessage> = Vec::new();
    let mut by_id: HashMap<u32, usize> = HashMap::new();
    let mut values: Vec<((u32, String), (f64, String))> = Vec::new();
    let mut comments: Vec<((u32, Option<String>), String)> = Vec::new();
    let mut i = 0;
    let lines: Vec<&str> = text.lines().collect();
    while i < lines.len() {
        let line = lines[i].trim();
        i += 1;
        if line.is_empty() {
            continue;
        }
        let kw = keyword(line);
        // Everything after the keyword token (attached colons included): `BU_: A B`
        // yields " A B", `BO_ 256 …` yields " 256 …".
        let kw_end = line.find(char::is_whitespace).unwrap_or(line.len());
        let rest = &line[kw_end..];
        match kw {
            "VERSION" => {
                if let Some(tok) = tokens(rest).first() {
                    version = unescape(tok.trim_matches('"'));
                }
            }
            // `NS_`'s service list spans indented lines (`NS_DESC_`, `CM_`, `BA_DEF_` —
            // every member starts with whitespace); the block ends at the next
            // column-0 line, whatever keyword it carries.
            "NS_" => {
                while i < lines.len() && (lines[i].starts_with(' ') || lines[i].starts_with('\t')) {
                    i += 1;
                }
            }
            "BS_" => {}
            "BU_" => {
                for tok in tokens(rest) {
                    let node = tok.trim_matches(':');
                    if !node.is_empty() {
                        nodes.push(node.to_string());
                    }
                }
            }
            "BO_" => {
                let toks = tokens(rest);
                if toks.len() >= 3 {
                    let raw_id = parse_int(toks[0]).unwrap_or(0) as u64;
                    let (extended, id) = canonical_id(raw_id);
                    let head = toks[1];
                    let name = head.strip_suffix(':').unwrap_or(head).to_string();
                    let dlc = parse_int(toks[2]).unwrap_or(0).max(0) as u32;
                    let transmitter = toks.get(3).map(|t| t.to_string()).unwrap_or_default();
                    by_id.insert(id, messages.len());
                    messages.push(DbcMessage {
                        id,
                        name,
                        dlc,
                        transmitter,
                        extended,
                        comment: None,
                        signals: Vec::new(),
                    });
                }
            }
            "SG_" => {
                if let Some(last) = messages.last_mut() {
                    if let Some(sig) = parse_signal_line(rest) {
                        last.signals.push(sig);
                    }
                }
            }
            "VAL_" => {
                let toks = tokens(rest);
                if toks.len() >= 3 {
                    if let Some(id) = parse_int(toks[0]).map(|v| v as u64) {
                        let (_, id) = canonical_id(id);
                        let sig = toks[1].to_string();
                        let mut k = 2;
                        while k + 1 < toks.len() {
                            if let (Some(v), Some(label)) = (parse_num(toks[k]), toks.get(k + 1)) {
                                values.push(((id, sig.clone()), (v, unescape(label.trim_matches('"')))));
                            }
                            k += 2;
                        }
                    }
                }
            }
            "CM_" => {
                // `CM_ BO_ <id> "text";` / `CM_ SG_ <id> <sig> "text";` — the text may
                // span lines. A comment on anything else is collected and dropped, so
                // its quotes cannot spawn phantom keyword lines.
                let toks = tokens(rest);
                let kind = toks.first().copied().unwrap_or("");
                let id_tok = toks.get(1).copied().unwrap_or("");
                let sig = if kind == "SG_" { toks.get(2).map(|s| s.to_string()) } else { None };
                let text = collect_quoted(&lines, &mut i, line);
                if (kind == "BO_" || kind == "SG_") && !id_tok.is_empty() {
                    if let Some(raw) = parse_int(id_tok) {
                        let (_, id) = canonical_id(raw as u64);
                        comments.push(((id, sig), text));
                    }
                }
                continue;
            }
            _ => {
                // BA_DEF_ / BA_ / VAL_TABLE_ / EV_ / SIG_GROUP_ … — a keyword this
                // parser does not consume. If the line lacks its terminating `;`
                // (multi-line attribute lists), swallow the following lines until one
                // carries it.
                if !line.contains(';') {
                    while i < lines.len() && !lines[i].contains(';') {
                        i += 1;
                    }
                    i += 1;
                }
            }
        }
    }
    // Fold the value tables and the comments in.
    for ((id, sig), pair) in values {
        if let Some(&mi) = by_id.get(&id) {
            if let Some(s) = messages[mi].signals.iter_mut().find(|s| s.name == sig) {
                s.values.push(pair);
            }
        }
    }
    for ((id, sig), text) in comments {
        if let Some(&mi) = by_id.get(&id) {
            match sig {
                Some(name) => {
                    if let Some(s) = messages[mi].signals.iter_mut().find(|s| s.name == name) {
                        s.comment = Some(text);
                    }
                }
                None => messages[mi].comment = Some(text),
            }
        }
    }
    if messages.is_empty() {
        return Err("no BO_ frames found — is this a DBC file?".to_string());
    }
    Ok(DbcDocument { version, nodes, messages })
}

/// The raw id as the file writes it → (extended?, canonical id). The 0x80000000 flag
/// bit some writers carry marks extended; a bare id past 0x7ff is extended too.
fn canonical_id(raw: u64) -> (bool, u32) {
    if raw >= 0x8000_0000 {
        (true, (raw & 0x1FFF_FFFF) as u32)
    } else if raw > 0x7ff {
        (true, raw as u32)
    } else {
        (false, raw as u32)
    }
}

/// Collects one string literal starting at `line`'s first `"`, walking `lines` (and
/// advancing `*i` past every extra line it consumed) until the unescaped closing quote.
fn collect_quoted(lines: &[&str], i: &mut usize, line: &str) -> String {
    let mut stream = line.to_string();
    let mut consumed = 0usize;
    // The opening quote.
    let bytes = stream.as_bytes();
    let mut start = None;
    for k in 0..bytes.len() {
        if bytes[k] == b'"' && !escaped_at(bytes, k) {
            start = Some(k + 1);
            break;
        }
    }
    let Some(start) = start else {
        return String::new();
    };
    let out;
    loop {
        let bytes = stream.as_bytes();
        let mut close = None;
        let mut k = start;
        while k < bytes.len() {
            if bytes[k] == b'"' && !escaped_at(bytes, k) {
                close = Some(k);
                break;
            }
            k += 1;
        }
        if let Some(close) = close {
            out = unescape(&stream[start..close]);
            break;
        }
        if *i + consumed >= lines.len() {
            // Unterminated: take what the stream holds.
            out = unescape(&stream[start..]);
            break;
        }
        stream.push('\n');
        stream.push_str(lines[*i + consumed]);
        consumed += 1;
    }
    *i += consumed;
    out
}

/* ---------- Decoding ---------- */

/// Little-endian extraction: `start` names the LSB, bits flow upward through the bytes.
fn extract_le(data: &[u8], start: usize, len: u32) -> Option<u64> {
    let len = len as usize;
    if len == 0 || len > 64 {
        return None;
    }
    let mut value: u64 = 0;
    for i in 0..len {
        let p = start + i;
        let byte = *data.get(p / 8)?;
        let bit = (byte >> (p % 8)) & 1;
        value |= (bit as u64) << i;
    }
    Some(value)
}

/// Big-endian extraction: `start` names the MSB in the DBC's numbering, bits descend
/// with the sawtooth walk (byte boundary jumps to the next byte's MSB).
fn extract_be(data: &[u8], start: usize, len: u32) -> Option<u64> {
    let len = len as usize;
    if len == 0 || len > 64 {
        return None;
    }
    let mut value: u64 = 0;
    let mut p = start;
    for _ in 0..len {
        let byte = *data.get(p / 8)?;
        let bit = (byte >> (p % 8)) & 1;
        value = (value << 1) | bit as u64;
        if p.is_multiple_of(8) {
            p += 15; // the sawtooth: bit 0 of this byte → bit 7 of the next
        } else {
            p -= 1;
        }
    }
    Some(value)
}

fn signal_raw(sig: &DbcSignal, data: &[u8]) -> Option<i64> {
    let start = sig.start_bit as usize;
    let raw = if sig.little_endian {
        extract_le(data, start, sig.length)?
    } else {
        extract_be(data, start, sig.length)?
    };
    if sig.signed {
        let bits = sig.length;
        let sign_bit = 1u64 << (bits - 1);
        Some(if raw & sign_bit != 0 {
            (raw as i64) - (1i64 << bits)
        } else {
            raw as i64
        })
    } else {
        Some(raw as i64)
    }
}

/// Decodes one frame: `id` is the canonical identifier, `data` the payload bytes. The
/// answer carries every signal that fits the bytes — an ordinary one always, a
/// multiplexed member only when the frame's multiplexer switch points at its group.
pub fn decode_message(doc: &DbcDocument, id: u32, data: &[u8]) -> Option<Vec<DecodedSignal>> {
    let msg = doc
        .messages
        .iter()
        .find(|m| m.id == id && m.extended == (id > 0x7ff))?;
    let mut out = Vec::new();
    let mut mux_value: Option<i64> = None;
    // The switch first, so the members know their group.
    if let Some(sw) = msg.signals.iter().find(|s| s.multiplex.as_deref() == Some("M")) {
        if let Some(raw) = signal_raw(sw, data) {
            mux_value = Some(raw);
            out.push(physical(sw, raw));
        }
    }
    for sig in &msg.signals {
        if sig.multiplex.as_deref() == Some("M") {
            continue;
        }
        if let Some(mark) = sig.multiplex.as_deref() {
            let group: Option<i64> = mark.strip_prefix('m').and_then(|g| g.parse().ok());
            match (group, mux_value) {
                (Some(g), Some(v)) if g != v => continue,
                (Some(_), None) => continue,
                _ => {}
            }
        }
        if let Some(raw) = signal_raw(sig, data) {
            out.push(physical(sig, raw));
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn physical(sig: &DbcSignal, raw: i64) -> DecodedSignal {
    let value = raw as f64 * sig.scale + sig.offset;
    let label = sig
        .values
        .iter()
        .find(|(v, _)| *v == raw as f64)
        .map(|(_, l)| l.clone());
    DecodedSignal {
        name: sig.name.clone(),
        raw,
        value,
        unit: sig.unit.clone(),
        label,
    }
}

/* ---------- The document store ---------- */

/// The open documents — `dbc_open` registering, the view's reads and `dbc_close`
/// releasing. The decode panel's calls ride the same store.
#[derive(Default)]
pub struct DbcState {
    next_id: AtomicU32,
    docs: Mutex<HashMap<u32, Arc<DbcDocument>>>,
}

impl DbcState {
    pub fn register(&self, doc: Arc<DbcDocument>) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.docs.lock().unwrap().insert(id, doc);
        id
    }

    pub fn get(&self, doc_id: u32) -> Option<Arc<DbcDocument>> {
        self.docs.lock().unwrap().get(&doc_id).map(Arc::clone)
    }

    pub fn release(&self, doc_id: u32) {
        self.docs.lock().unwrap().remove(&doc_id);
    }
}

/// Parses the file at `path` (whole file; a database is small).
pub fn open_doc(path: &Path) -> Result<Arc<DbcDocument>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(format!("{}: past the 64 MiB this parser accepts", path.display()));
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    parse(&text).map(Arc::new)
}

/* ---------- Tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    /// A database exercising every shape the parser answers: Intel and Motorola signals,
    /// a value table, a multi-line comment, a multiplexed frame, an extended id with the
    /// flag bit, and the skipped directives.
    const SAMPLE: &str = r#"VERSION "Sample 1.0"

NS_ :
    NS_DESC_
    CM_
    BA_DEF_

BS_:

BU_: Engine Gateway Diagnostics

BO_ 256 EngineData: 8 Engine
 SG_ VehicleSpeed : 24|16@0+ (0.01,0) [0|655.35] "km/h" Gateway
 SG_ EngineSpeed : 0|16@0+ (0.25,0) [0|16383.75] "rpm" Gateway
 SG_ Temperature : 40|8@0- (1,-40) [-40|215] "degC" Gateway,Diag

BO_ 123 DiagRequest: 3 Diagnostics
 SG_ ReqId : 0|8@0+ (1,0) [0|255] "" Engine

BO_ 2147487745 Status: 8 Engine
 SG_ FaultCode : 7|16@1+ (1,0) [0|65535] "" Gateway
 SG_ Running : 0|1@0+ (1,0) [0|1] "" Gateway

BO_ 512 MuxFrame: 8 Engine
 SG_ MuxSwitch M : 0|8@0+ (1,0) [0|255] "" Vector__XXX
 SG_ Voltage m0 : 8|16@0+ (0.001,0) [0|65.535] "V" Gateway
 SG_ Current m1 : 8|16@0+ (0.01,0) [0|655.35] "A" Gateway

CM_ BO_ 256 "The engine data frame;
its periodic rate is 10 ms.";
CM_ SG_ 256 VehicleSpeed "Wheel speed, filtered";
VAL_ 256 VehicleSpeed 0 "Stopped" 65535 "Invalid" ;
"#;

    #[test]
    fn parses_messages_and_signals() {
        let doc = parse(SAMPLE).unwrap();
        assert_eq!(doc.version, "Sample 1.0");
        assert_eq!(doc.nodes, vec!["Engine", "Gateway", "Diagnostics"]);
        assert_eq!(doc.messages.len(), 4);
        let engine = &doc.messages[0];
        assert_eq!(engine.id, 256);
        assert!(!engine.extended);
        assert_eq!(engine.dlc, 8);
        assert_eq!(engine.transmitter, "Engine");
        assert_eq!(engine.signals.len(), 3);
        let speed = &engine.signals[0];
        assert_eq!(speed.name, "VehicleSpeed");
        assert_eq!(speed.start_bit, 24);
        assert_eq!(speed.length, 16);
        assert!(speed.little_endian);
        assert!(!speed.signed);
        assert_eq!(speed.scale, 0.01);
        assert_eq!(speed.unit, "km/h");
        assert_eq!(speed.receivers, vec!["Gateway"]);
        let temp = &engine.signals[2];
        assert!(temp.signed);
        assert_eq!(temp.offset, -40.0);
    }

    #[test]
    fn recognises_extended_ids_both_ways() {
        let doc = parse(SAMPLE).unwrap();
        // 2147487745 = 0x80001001: the flag bit → extended, canonical id 0x1001.
        let status = doc.messages.iter().find(|m| m.name == "Status").unwrap();
        assert!(status.extended);
        assert_eq!(status.id, 0x1001);
        // A bare id past 0x7ff is extended too (some writers skip the flag).
        let doc = parse("BO_ 4096 Bare: 1 N\n SG_ S : 0|1@0+ (1,0) [0|1] \"\" R\n").unwrap();
        assert!(doc.messages[0].extended);
        assert_eq!(doc.messages[0].id, 4096);
    }

    #[test]
    fn folds_value_tables_and_comments() {
        let doc = parse(SAMPLE).unwrap();
        let speed = &doc.messages[0].signals[0];
        assert_eq!(speed.values, vec![(0.0, "Stopped".to_string()), (65535.0, "Invalid".to_string())]);
        let comment = doc.messages[0].comment.clone().unwrap();
        assert!(comment.contains("periodic rate is 10 ms"));
        assert_eq!(doc.messages[0].signals[0].comment.as_deref(), Some("Wheel speed, filtered"));
    }

    #[test]
    fn decodes_little_endian() {
        let doc = parse(SAMPLE).unwrap();
        // VehicleSpeed at bits 24..39, scale 0.01: 0x3039 = 12345 → 123.45 km/h.
        let mut data = [0u8; 8];
        data[3] = 0x39;
        data[4] = 0x30;
        let out = decode_message(&doc, 256, &data).unwrap();
        let speed = out.iter().find(|s| s.name == "VehicleSpeed").unwrap();
        assert_eq!(speed.raw, 12345);
        assert!((speed.value - 123.45).abs() < 1e-9);
        // EngineSpeed at bits 0..15, scale 0.25: 0x0100 = 256 → 64 rpm.
        data[0] = 0x00;
        data[1] = 0x01;
        let out = decode_message(&doc, 256, &data).unwrap();
        let rpm = out.iter().find(|s| s.name == "EngineSpeed").unwrap();
        assert_eq!(rpm.value, 64.0);
        // Temperature signed, offset -40: 0xC8 wraps to raw -56 → -96 degC — the
        // two's-complement reading the signedness flag asks for.
        data[5] = 0xC8;
        let out = decode_message(&doc, 256, &data).unwrap();
        let temp = out.iter().find(|s| s.name == "Temperature").unwrap();
        assert_eq!(temp.raw, -56);
        assert_eq!(temp.value, -96.0);
        // Temperature negative: raw 10 → -30 degC.
        data[5] = 10;
        let out = decode_message(&doc, 256, &data).unwrap();
        let temp = out.iter().find(|s| s.name == "Temperature").unwrap();
        assert_eq!(temp.value, -30.0);
    }

    #[test]
    fn decodes_big_endian_across_the_byte_boundary() {
        // FaultCode: 16 bits big-endian starting at bit 7 (byte 0's MSB) — the classic
        // Motorola 16-bit signal spanning bytes 0-1. The sawtooth walk reads byte 0's
        // bit 7 first, then byte 1's bit 7 once the boundary crossed.
        let text = "BO_ 100 Big: 8 Node\n SG_ FaultCode : 7|16@1+ (1,0) [0|65535] \"\" GW\n";
        let doc = parse(text).unwrap();
        let out = decode_message(&doc, 100, &[0x12, 0x34, 0, 0, 0, 0, 0, 0]).unwrap();
        assert_eq!(out[0].name, "FaultCode");
        assert_eq!(out[0].raw, 0x1234);
        let out = decode_message(&doc, 100, &[0x80, 0x00, 0, 0, 0, 0, 0, 0]).unwrap();
        assert_eq!(out[0].raw, 0x8000);
        let out = decode_message(&doc, 100, &[0x00, 0x01, 0, 0, 0, 0, 0, 0]).unwrap();
        assert_eq!(out[0].raw, 1);
        // A big-endian nibble wholly inside byte 0: start 4, length 4 → bits 4..1.
        let text = "BO_ 101 Nib: 8 Node\n SG_ Nibble : 4|4@1+ (1,0) [0|15] \"\" GW\n";
        let doc = parse(text).unwrap();
        let out = decode_message(&doc, 101, &[0b0000_1100, 0, 0, 0, 0, 0, 0, 0]).unwrap();
        assert_eq!(out[0].raw, 0b0110);
    }

    #[test]
    fn decode_honours_the_multiplexer() {
        let doc = parse(SAMPLE).unwrap();
        // MuxSwitch = 0 → Voltage visible, Current not.
        let mut data = [0u8; 8];
        data[1] = 0x10;
        data[2] = 0x27; // 0x2710 = 10000 → 10.000 V
        let out = decode_message(&doc, 512, &data).unwrap();
        assert!(out.iter().any(|s| s.name == "Voltage"));
        assert!(!out.iter().any(|s| s.name == "Current"));
        // MuxSwitch = 1 → the other member (raw 10000 → 100.00 A).
        data[0] = 1;
        let out = decode_message(&doc, 512, &data).unwrap();
        let current = out.iter().find(|s| s.name == "Current").unwrap();
        assert_eq!(current.value, 100.0);
        assert!(!out.iter().any(|s| s.name == "Voltage"));
    }

    #[test]
    fn decode_labels_named_values() {
        let doc = parse(SAMPLE).unwrap();
        let out = decode_message(&doc, 256, &[0, 0, 0, 0xFF, 0xFF, 0, 0, 0]).unwrap();
        let speed = out.iter().find(|s| s.name == "VehicleSpeed").unwrap();
        assert_eq!(speed.label.as_deref(), Some("Invalid"));
    }

    #[test]
    fn a_signal_past_the_payload_is_dropped_not_fatal() {
        let doc = parse(SAMPLE).unwrap();
        // EngineData needs 8 bytes; 2 arrive — the low signals still decode.
        let out = decode_message(&doc, 256, &[0x00, 0x01]).unwrap();
        assert!(out.iter().any(|s| s.name == "EngineSpeed"));
        assert!(!out.iter().any(|s| s.name == "VehicleSpeed"));
    }

    #[test]
    fn unknown_ids_answer_none() {
        let doc = parse(SAMPLE).unwrap();
        assert!(decode_message(&doc, 0x5AA, &[0; 8]).is_none());
        // A standard id never matches an extended frame sharing its canonical number.
        assert!(decode_message(&doc, 0x101, &[0; 8]).is_none());
    }

    #[test]
    fn the_state_registers_and_releases() {
        let state = DbcState::default();
        let doc = Arc::new(parse(SAMPLE).unwrap());
        let id = state.register(Arc::clone(&doc));
        assert!(state.get(id).is_some());
        assert!(state.get(id + 1).is_none());
        state.release(id);
        assert!(state.get(id).is_none());
    }

    #[test]
    fn open_doc_reads_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.dbc");
        std::fs::write(&path, SAMPLE).unwrap();
        let doc = open_doc(&path).unwrap();
        assert_eq!(doc.messages.len(), 4);
        let missing = dir.path().join("nope.dbc");
        assert!(open_doc(&missing).is_err());
    }

    #[test]
    fn junk_is_an_error_not_a_panic() {
        assert!(parse("this is not a database at all").is_err());
        assert!(parse("").is_err());
    }
}
