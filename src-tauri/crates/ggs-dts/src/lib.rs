//! ggs-dts (module 22): the Device Tree Viewer's engine — a flattened device tree blob
//! (`.dtb`, the FDT format the DTB spec fixes: big-endian header, a token stream for
//! the structure block, a string table for the property names) parsed into the node
//! tree, and the device tree source (`.dts`/`.dtsi`, the preprocessor-mixed text
//! syntax) parsed into the same shape, so one view serves both. Values keep their four
//! readings — strings, 32-bit cells, raw bytes, `&phandle` references — and the view
//! renders whichever the property carried. The crate is pure Rust; `cmd_dts.rs` is the
//! only file that may name tauri.

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;

/* ---------- Shapes the bridge sees ---------- */

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum DtsValue {
    /// A NUL-separated string chunk (or one quoted string in source).
    Str { text: String },
    /// One 32-bit cell, big-endian on the wire, spelled hex.
    Cell { text: String },
    /// A raw byte run, spelled hex pairs.
    Bytes { text: String },
    /// A `&label` phandle reference.
    Ref { text: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DtsProperty {
    pub name: String,
    pub values: Vec<DtsValue>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DtsNode {
    /// The node's name as the tree shows it: `uart@101000` — or `&label` for an
    /// overlay/append block the source carried.
    pub name: String,
    /// The `label:` the source wrote, when it did.
    pub label: Option<String>,
    /// The part after `@` in the node's name.
    pub unit_address: Option<String>,
    pub properties: Vec<DtsProperty>,
    pub children: Vec<DtsNode>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DtsMemReserve {
    pub address: u64,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DtsDocument {
    /// `"dtb"` the binary read the magic of, `"dts"` the text parse.
    pub format: String,
    /// The boot CPU id a blob header carries (absent in source).
    pub boot_cpuid: Option<u32>,
    pub mem_reserve: Vec<DtsMemReserve>,
    /// Node and property counts over the whole tree — the view's summary chip.
    pub nodes: usize,
    pub properties: usize,
    pub total_bytes: u64,
    pub root: DtsNode,
}

/* ---------- The binary (.dtb) read ---------- */

const FDT_MAGIC: u32 = 0xd00dfeed;
const FDT_BEGIN_NODE: u32 = 1;
const FDT_END_NODE: u32 = 2;
const FDT_PROP: u32 = 3;
const FDT_NOP: u32 = 4;
const FDT_END: u32 = 9;

/// The whole file's bytes — a device tree is small; past 32 MiB is refused.
pub const MAX_FILE: u64 = 32 * 1024 * 1024;

fn u32be(bytes: &[u8], off: usize) -> Option<u32> {
    let b = bytes.get(off..off + 4)?;
    Some(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

fn u64be(bytes: &[u8], off: usize) -> Option<u64> {
    let b = bytes.get(off..off + 8)?;
    let mut arr = [0u8; 8];
    arr.copy_from_slice(b);
    Some(u64::from_be_bytes(arr))
}

pub fn open_doc(path: &Path) -> Result<Arc<DtsDocument>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    let total = bytes.len() as u64;
    if total > MAX_FILE {
        return Err(format!("{}: past the 32 MiB this viewer accepts", path.display()));
    }
    parse(&bytes, total).map(Arc::new)
}

/// One read for both formats: the magic says which.
pub fn parse(bytes: &[u8], total_bytes: u64) -> Result<DtsDocument, String> {
    if bytes.len() >= 4 && u32be(bytes, 0) == Some(FDT_MAGIC) {
        parse_dtb(bytes, total_bytes)
    } else {
        // Tolerate non-UTF-8 comments (e.g. Latin-1/GBK in vendor .dts/.dtsi files) and UTF-8 BOM.
        let owned;
        let text = match std::str::from_utf8(bytes) {
            Ok(s) => s,
            Err(_) => {
                // Reject obvious binary blobs with NUL bytes, but decode text with legacy encodings lossily.
                let sample = &bytes[..bytes.len().min(4096)];
                if sample.contains(&0) {
                    return Err("not a .dtb blob, and not UTF-8 source text".to_string());
                }
                owned = String::from_utf8_lossy(bytes).into_owned();
                &owned
            }
        };
        parse_dts(text.trim_start_matches('\u{feff}'), total_bytes)
    }
}

fn parse_dtb(bytes: &[u8], total_bytes: u64) -> Result<DtsDocument, String> {
    // FDT header size varies by format version: v1..v15 is 28 bytes, v16 is 36 bytes, v17+ is 40 bytes.
    if bytes.len() < 28 {
        return Err("truncated .dtb header".to_string());
    }
    let version = u32be(bytes, 20).unwrap_or(17);
    let min_hdr = if version >= 17 { 40 } else if version >= 16 { 36 } else { 28 };
    if bytes.len() < min_hdr {
        return Err("truncated .dtb header".to_string());
    }
    #[allow(clippy::needless_late_init)]
    let totalsize = u32be(bytes, 4).ok_or("truncated .dtb header")? as usize;
    let struct_off = u32be(bytes, 8).ok_or("truncated .dtb header")? as usize;
    let strings_off = u32be(bytes, 12).ok_or("truncated .dtb header")? as usize;
    let rsvmap_off = u32be(bytes, 16).ok_or("truncated .dtb header")? as usize;
    let boot_cpuid = if bytes.len() >= 32 { u32be(bytes, 28) } else { None };
    if struct_off >= bytes.len() || strings_off > bytes.len() {
        return Err(".dtb header cites offsets past the file's end".to_string());
    }
    let effective_end = totalsize.min(bytes.len());
    // The memory reservation block: u64 pairs, terminated by a 0,0 pair.
    let mut mem_reserve = Vec::new();
    let mut rsv = rsvmap_off;
    while rsv + 16 <= effective_end {
        let address = u64be(bytes, rsv).unwrap_or(0);
        let size = u64be(bytes, rsv + 8).unwrap_or(0);
        rsv += 16;
        if address == 0 && size == 0 {
            break;
        }
        mem_reserve.push(DtsMemReserve { address, size });
    }
    // The structure block walk.
    let mut root = DtsNode {
        name: "/".to_string(),
        label: None,
        unit_address: None,
        properties: Vec::new(),
        children: Vec::new(),
    };
    let mut nodes = 0usize;
    let mut properties = 0usize;
    let mut p = struct_off;
    // A stack of nodes the tokens descend and ascend through.
    let mut stack: Vec<DtsNode> = Vec::new();
    loop {
        let Some(token) = u32be(bytes, p) else {
            if nodes > 0 {
                break;
            }
            return Err(".dtb structure block ends mid-tree".to_string());
        };
        p += 4;
        match token {
            FDT_NOP => {}
            FDT_BEGIN_NODE => {
                let Some(end) = bytes[p..].iter().position(|&b| b == 0) else {
                    if nodes > 0 {
                        break;
                    }
                    return Err(".dtb node name runs off the file".to_string());
                };
                let name = String::from_utf8_lossy(&bytes[p..p + end]).into_owned();
                p += end + 1;
                p = (p + 3) & !3; // the name aligns to four bytes
                let (label, unit_address) = split_label_unit(&name);
                stack.push(DtsNode {
                    name: strip_label(&name),
                    label,
                    unit_address,
                    properties: Vec::new(),
                    children: Vec::new(),
                });
                nodes += 1;
            }
            FDT_END_NODE => {
                let Some(mut done) = stack.pop() else {
                    if nodes > 0 {
                        break;
                    }
                    return Err(".dtb structure block closes more nodes than it opened".to_string());
                };
                properties += done.properties.len();
                if stack.is_empty() {
                    // The root's own END: the tree is complete.
                    root.children.append(&mut done.children);
                    root.properties.append(&mut done.properties);
                    break;
                }
                stack.last_mut().unwrap().children.push(done);
            }
            FDT_PROP => {
                let len = u32be(bytes, p).unwrap_or(0) as usize;
                let nameoff = u32be(bytes, p + 4).unwrap_or(0) as usize;
                p += 8;
                let data_end = p.saturating_add(len).min(bytes.len());
                let value_bytes = bytes.get(p..data_end).unwrap_or(&[]);
                let name_start = strings_off.saturating_add(nameoff);
                let name = if name_start < bytes.len() {
                    let name_end = bytes[name_start..]
                        .iter()
                        .position(|&b| b == 0)
                        .map(|e| name_start + e)
                        .unwrap_or(bytes.len());
                    String::from_utf8_lossy(&bytes[name_start..name_end]).into_owned()
                } else {
                    String::new()
                };
                if let Some(top) = stack.last_mut() {
                    top.properties.push(DtsProperty {
                        name,
                        values: interpret_blob(value_bytes),
                    });
                }
                p = p.saturating_add(len);
                p = (p + 3) & !3;
            }
            FDT_END => break,
            other => {
                if nodes > 0 {
                    break;
                }
                return Err(format!(".dtb structure block carries unknown token {other}"));
            }
        }
        if p > bytes.len() + 4 {
            if nodes > 0 {
                break;
            }
            return Err(".dtb structure block runs off the file".to_string());
        }
    }
    // Fold any unclosed nodes from a slightly truncated DTB back into root rather than losing them.
    while let Some(mut done) = stack.pop() {
        properties += done.properties.len();
        if let Some(parent) = stack.last_mut() {
            parent.children.push(done);
        } else {
            root.children.append(&mut done.children);
            root.properties.append(&mut done.properties);
        }
    }
    Ok(DtsDocument {
        format: "dtb".to_string(),
        boot_cpuid,
        mem_reserve,
        nodes,
        properties,
        total_bytes,
        root,
    })
}

/// One property blob's reading: NUL-terminated printable runs are strings, a
/// four-aligned remainder is cells, anything else raw bytes.
fn interpret_blob(bytes: &[u8]) -> Vec<DtsValue> {
    if bytes.is_empty() {
        return Vec::new();
    }
    let printable = bytes.iter().all(|&b| b == 0 || (0x20..0x7f).contains(&b));
    if printable && bytes.last() == Some(&0) {
        let mut out = Vec::new();
        let mut run = Vec::new();
        for &b in bytes {
            if b == 0 {
                if !run.is_empty() {
                    out.push(DtsValue::Str { text: String::from_utf8_lossy(&run).into_owned() });
                }
                run.clear();
            } else {
                run.push(b);
            }
        }
        return out;
    }
    if bytes.len().is_multiple_of(4) {
        let mut out = Vec::new();
        for k in (0..bytes.len()).step_by(4) {
            let v = u32be(bytes, k).unwrap_or(0);
            out.push(DtsValue::Cell { text: format!("0x{v:08x}") });
        }
        return out;
    }
    let hex: Vec<String> = bytes.iter().map(|b| format!("{b:02x}")).collect();
    vec![DtsValue::Bytes { text: hex.join(" ") }]
}

/* ---------- The source (.dts) read ---------- */

/// `label: name@unit` → (label, unit) — the source spellings the blob lost.
fn split_label_unit(name: &str) -> (Option<String>, Option<String>) {
    let mut label = None;
    let mut rest = name;
    if let Some(at) = rest.find(':') {
        label = Some(rest[..at].to_string());
        rest = &rest[at + 1..];
    }
    let rest = rest.trim();
    let unit_address = rest.split_once('@').map(|(_, u)| u.to_string());
    (label, unit_address)
}

fn strip_label(name: &str) -> String {
    match name.find(':') {
        Some(at) => name[at + 1..].trim().to_string(),
        None => name.to_string(),
    }
}

/// The source's token stream: identifiers, strings (with the C escapes), cell/byte/
/// parenthesized punctuation, references — comments and preprocessor lines stripped.
#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Word(String),
    Str(String),
    Open(String),  // '<' '[' '{' '('
    Close(String), // '>' ']' '}' ')'
    Punct(char),   // '=' ';' ',' ':' '&' '/'
    /// A newline the source carried — nothing else sees it; the preprocessor
    /// directive skip stops here, so `#include <…>` never swallows the file.
    Eol,
}

fn tokenize(src: &str) -> Result<Vec<Tok>, String> {
    let b: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    let n = b.len();
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut Vec<Tok>| {
        if !word.is_empty() {
            out.push(Tok::Word(std::mem::take(word)));
        }
    };
    while i < n {
        let c = b[i];
        if c == '/' && i + 1 < n && b[i + 1] == '*' {
            flush(&mut word, &mut out);
            i += 2;
            while i + 1 < n && !(b[i] == '*' && b[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(n);
            continue;
        }
        if c == '/' && i + 1 < n && b[i + 1] == '/' {
            flush(&mut word, &mut out);
            while i < n && b[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' {
            if i + 1 < n && b[i + 1] == '*' {
                flush(&mut word, &mut out);
                i += 2;
                while i + 1 < n && !(b[i] == '*' && b[i + 1] == '/') {
                    i += 1;
                }
                i = (i + 2).min(n);
                continue;
            }
            if i + 1 < n && b[i + 1] == '/' {
                flush(&mut word, &mut out);
                while i < n && b[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            // `/keyword/` — the directives (/dts-v1/, /memreserve/, /delete-node/ …)
            // join into one word token; a lone '/' stays punctuation.
            if i + 1 < n && (b[i + 1].is_alphanumeric() || b[i + 1] == '_') {
                flush(&mut word, &mut out);
                let mut k = i + 1;
                while k < n && (b[k].is_alphanumeric() || b[k] == '_' || b[k] == '-') {
                    k += 1;
                }
                if k < n && b[k] == '/' {
                    out.push(Tok::Word(String::from_iter(&b[i..=k])));
                    i = k + 1;
                    continue;
                }
                out.push(Tok::Punct('/'));
                i += 1;
                continue;
            }
            flush(&mut word, &mut out);
            out.push(Tok::Punct('/'));
            i += 1;
            continue;
        }
        if c == '"' {
            flush(&mut word, &mut out);
            i += 1;
            let mut text = String::new();
            while i < n && b[i] != '"' {
                if b[i] == '\\' && i + 1 < n {
                    i += 1;
                    text.push(match b[i] {
                        'n' => '\n',
                        't' => '\t',
                        'r' => '\r',
                        '0' => '\0',
                        other => other,
                    });
                } else {
                    text.push(b[i]);
                }
                i += 1;
            }
            i = (i + 1).min(n);
            out.push(Tok::Str(text));
            continue;
        }
        if c == '<' || c == '[' || c == '{' || c == '(' {
            flush(&mut word, &mut out);
            out.push(Tok::Open(c.to_string()));
            i += 1;
            continue;
        }
        if c == '>' || c == ']' || c == '}' || c == ')' {
            flush(&mut word, &mut out);
            out.push(Tok::Close(c.to_string()));
            i += 1;
            continue;
        }
        if c == '\n' {
            flush(&mut word, &mut out);
            out.push(Tok::Eol);
            i += 1;
            continue;
        }
        if c.is_whitespace() {
            flush(&mut word, &mut out);
            i += 1;
            continue;
        }
        if c.is_alphanumeric() || c == '_' || c == ',' || c == '.' || c == '+' || c == '-' || c == '#' {
            // Part of a word: numbers (hex, decimal), names, and the joiners real
            // values use (`1,2` cell lists keep their commas inside one word token).
            word.push(c);
            i += 1;
            continue;
        }
        flush(&mut word, &mut out);
        out.push(Tok::Punct(c));
        i += 1;
    }
    flush(&mut word, &mut out);
    Ok(out)
}

fn is_cell_number(tok: &str) -> bool {
    let t = tok.trim();
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return !hex.is_empty() && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit())
}

/// The source's parse. Includes and preprocessor conditionals are skipped (their
/// contents are other files' or the C preprocessor's business); `/memreserve/` pairs
/// reach the answer; `/delete-node/` and `/delete-property/` statements are skipped
/// with their operand; `&label { … }` overlays become top-level `&label` nodes.
pub fn parse_dts(src: &str, total_bytes: u64) -> Result<DtsDocument, String> {
    if src.len() > 16 * 1024 * 1024 {
        return Err("the source is past the 16 MiB this parser accepts".to_string());
    }
    let toks = tokenize(src)?;
    let mut mem_reserve: Vec<DtsMemReserve> = Vec::new();
    let mut root = DtsNode {
        name: "/".to_string(),
        label: None,
        unit_address: None,
        properties: Vec::new(),
        children: Vec::new(),
    };
    let mut overlays: Vec<DtsNode> = Vec::new();
    let mut i = 0usize;
    let n = toks.len();
    // The preprocessor's leftovers: one directive's tokens up to a line-end-ish
    // boundary. (Property names like `#address-cells` never land here — the property
    // arm's whitelist catches them first.)
    while i < n {
        match &toks[i] {
            Tok::Punct(';') => i += 1,
            Tok::Word(w) if w == "/dts-v1/" || w == "/plugin/" || w == "/omit-if-no-ref/" => {
                i += 1;
                if toks.get(i) == Some(&Tok::Punct(';')) {
                    i += 1;
                }
            }
            Tok::Word(w) if w == "/include/" => {
                // `/include/ "foo.dtsi"` — skip the directive and its filename string.
                i += 1;
                while i < n && toks[i] != Tok::Eol && toks[i] != Tok::Punct(';') {
                    i += 1;
                }
                if i < n {
                    i += 1;
                }
            }
            Tok::Word(w) if w == "/memreserve/" => {
                i += 1;
                let mut pair = (0u64, 0u64);
                for slot in 0..2 {
                    if let Some(Tok::Word(num)) = toks.get(i) {
                        let v = parse_num_word(num).unwrap_or(0);
                        if slot == 0 {
                            pair.0 = v;
                        } else {
                            pair.1 = v;
                        }
                        i += 1;
                    }
                }
                mem_reserve.push(DtsMemReserve { address: pair.0, size: pair.1 });
                if toks.get(i) == Some(&Tok::Punct(';')) {
                    i += 1;
                }
            }
            Tok::Word(w) if w.starts_with('#') => {
                if matches!(toks.get(i + 1), Some(Tok::Punct('=')) | Some(Tok::Punct(';'))) {
                    // A property (`#address-cells = <2>;`), not a directive.
                    let (prop, next) = parse_property(&toks, i);
                    root.properties.push(prop);
                    i = next;
                } else {
                    // A preprocessor line: swallow its tokens to the line's end.
                    i += 1;
                    while i < n && toks[i] != Tok::Eol {
                        i += 1;
                    }
                    i += 1; // the Eol itself
                }
            }
            Tok::Word(w) if w == "/delete-node/" || w == "/delete-property/" => {
                let is_node = w == "/delete-node/";
                i += 1;
                if let Some(Tok::Word(victim)) = toks.get(i).cloned() {
                    i += 1;
                    if is_node {
                        root.children.retain(|c| c.name != victim);
                    } else {
                        root.properties.retain(|p| p.name != victim);
                    }
                    if toks.get(i) == Some(&Tok::Punct(';')) {
                        i += 1;
                    }
                } else if matches!(toks.get(i), Some(Tok::Open(_))) {
                    let mut depth = 0usize;
                    while i < n {
                        match &toks[i] {
                            Tok::Open(_) => depth += 1,
                            Tok::Close(_) => {
                                depth -= 1;
                                if depth == 0 {
                                    i += 1;
                                    break;
                                }
                            }
                            _ => {}
                        }
                        i += 1;
                    }
                    if toks.get(i) == Some(&Tok::Punct(';')) {
                        i += 1;
                    }
                }
            }
            Tok::Punct('&') => {
                // A top-level overlay: `&label { … } ;`
                let (mut node, next) = parse_node_header(&toks, i)?;
                i = next;
                parse_node_body(&toks, &mut i, &mut node)?;
                overlays.push(node);
            }
            Tok::Punct('/') if matches!(toks.get(i + 1), Some(Tok::Open(_))) => {
                // The root's own body: `/ { … }` — its contents merge into the root.
                i += 2;
                parse_node_body(&toks, &mut i, &mut root)?;
            }
            Tok::Word(_) => {
                if starts_node(&toks, i) {
                    let (mut node, next) = parse_node_header(&toks, i)?;
                    i = next;
                    parse_node_body(&toks, &mut i, &mut node)?;
                    if node.name == "/" {
                        root.properties.append(&mut node.properties);
                        root.children.append(&mut node.children);
                    } else {
                        root.children.push(node);
                    }
                } else {
                    // Tolerate preprocessor macro invocations or vendor directives at top level
                    // (e.g. multi-line #define continuations in .dtsi headers) by skipping the line.
                    while i < n && toks[i] != Tok::Eol && toks[i] != Tok::Punct(';') {
                        i += 1;
                    }
                    if i < n {
                        i += 1;
                    }
                }
            }
            _ => {
                i += 1;
            }
        }
    }
    for overlay in overlays {
        root.children.push(overlay);
    }
    let (nodes, properties) = count_tree(&root);
    Ok(DtsDocument {
        format: "dts".to_string(),
        boot_cpuid: None,
        mem_reserve,
        nodes,
        properties,
        total_bytes,
        root,
    })
}

/// The tree's node and property totals, one walk.
fn count_tree(root: &DtsNode) -> (usize, usize) {
    let mut nodes = 1usize;
    let mut properties = root.properties.len();
    for child in &root.children {
        let (cn, cp) = count_tree(child);
        nodes += cn;
        properties += cp;
    }
    (nodes, properties)
}

/// Whether a node header starts at `toks[i]`: a word (or `&label`) that reaches `{`
/// before any `=` or `;` — a property reaches those first. Bounded by the next brace.
fn starts_node(toks: &[Tok], i: usize) -> bool {
    if toks[i] == Tok::Punct('&') {
        return matches!(toks.get(i + 1), Some(Tok::Word(_)));
    }
    let mut j = i + 1;
    if matches!(toks.get(i + 1), Some(Tok::Punct(':'))) {
        j += 2; // label:
    }
    while j < toks.len() {
        match &toks[j] {
            Tok::Open(_) => return true,
            Tok::Punct(';') | Tok::Punct('=') => return false,
            _ => j += 1,
        }
    }
    false
}

/// The node header at `i` — `&label`, or `[label :] name [@ unit]` — consumed through
/// its opening `{`.
fn parse_node_header(toks: &[Tok], mut i: usize) -> Result<(DtsNode, usize), String> {
    let mut label = None;
    let overlay = toks[i] == Tok::Punct('&');
    if overlay {
        i += 1;
    }
    let mut parts: Vec<String> = Vec::new();
    while i < toks.len() {
        match &toks[i] {
            Tok::Word(w) => parts.push(w.clone()),
            Tok::Punct('@') => parts.push('@'.to_string()),
            Tok::Punct(':') => {
                label = Some(parts.join(""));
                parts.clear();
            }
            Tok::Open(open) if open == "{" => {
                i += 1;
                break;
            }
            _ => break,
        }
        i += 1;
    }
    let raw = parts.join("");
    if raw.is_empty() {
        return Err("a node header names nothing".to_string());
    }
    let (l2, unit) = split_label_unit(&raw);
    let node = DtsNode {
        name: if overlay { format!("&{raw}") } else { strip_label(&raw) },
        label: label.or(l2),
        unit_address: unit,
        properties: Vec::new(),
        children: Vec::new(),
    };
    Ok((node, i))
}

/// The body between the header's `{` and its matching `}` — nodes and properties,
/// recursively — then the `}` and the customary `;`.
fn parse_node_body(toks: &[Tok], i: &mut usize, node: &mut DtsNode) -> Result<(), String> {
    let n = toks.len();
    while *i < n {
        match &toks[*i] {
            Tok::Close(close) if close == "}" => {
                *i += 1;
                if toks.get(*i) == Some(&Tok::Punct(';')) {
                    *i += 1;
                }
                return Ok(());
            }
            Tok::Punct(';') => *i += 1,
            Tok::Word(w) if w == "/delete-node/" || w == "/delete-property/" => {
                let is_node = w == "/delete-node/";
                *i += 1;
                if let Some(Tok::Word(victim)) = toks.get(*i).cloned() {
                    *i += 1;
                    if is_node {
                        node.children.retain(|c| c.name != victim);
                    } else {
                        node.properties.retain(|p| p.name != victim);
                    }
                    if toks.get(*i) == Some(&Tok::Punct(';')) {
                        *i += 1;
                    }
                }
            }
            Tok::Word(_) => {
                if starts_node(toks, *i) {
                    let (mut child, next) = parse_node_header(toks, *i)?;
                    *i = next;
                    parse_node_body(toks, i, &mut child)?;
                    node.children.push(child);
                } else {
                    let (prop, next) = parse_property(toks, *i);
                    *i = next;
                    node.properties.push(prop);
                }
            }
            _ => {
                *i += 1;
            }
        }
    }
    Err("the source ends with a node body still open".to_string())
}

/// A property: name ['=' values] ';' — the values read by `parse_property_values`.
fn parse_property(toks: &[Tok], mut i: usize) -> (DtsProperty, usize) {
    let name = match toks.get(i) {
        Some(Tok::Word(w)) => w.clone(),
        _ => String::new(),
    };
    i += 1;
    let mut values = Vec::new();
    if toks.get(i) == Some(&Tok::Punct('=')) {
        i += 1;
        (values, i) = parse_property_values(toks, i);
    }
    if toks.get(i) == Some(&Tok::Punct(';')) {
        i += 1;
    }
    (DtsProperty { name, values }, i)
}

fn parse_num_word(w: &str) -> Option<u64> {
    let t = w.trim();
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return u64::from_str_radix(hex, 16).ok();
    }
    t.parse::<u64>().ok()
}

/// A property's values: strings, `<cells>` (numbers, refs, expression leftovers),
/// `[bytes]`, and bare `&label` refs — until the `;`.
fn parse_property_values(toks: &[Tok], mut i: usize) -> (Vec<DtsValue>, usize) {
    let mut out: Vec<DtsValue> = Vec::new();
    let n = toks.len();
    while i < n {
        match &toks[i] {
            Tok::Str(text) => {
                out.push(DtsValue::Str { text: text.clone() });
                i += 1;
            }
            Tok::Open(open) if open == "<" => {
                i += 1;
                while i < n {
                    match &toks[i] {
                        Tok::Close(close) if close == ">" => {
                            i += 1;
                            break;
                        }
                        Tok::Punct('&') => {
                            i += 1;
                            if let Some(Tok::Word(label)) = toks.get(i) {
                                out.push(DtsValue::Ref { text: format!("&{label}") });
                                i += 1;
                            }
                        }
                        Tok::Word(w) if is_cell_number(w) => {
                            let v = parse_num_word(w).unwrap_or(0);
                            out.push(DtsValue::Cell { text: format!("0x{v:08x}") });
                            i += 1;
                        }
                        Tok::Word(w) => {
                            // An expression's leftovers; keep the text, move on.
                            out.push(DtsValue::Cell { text: w.clone() });
                            i += 1;
                        }
                        _ => {
                            i += 1;
                        }
                    }
                }
            }
            Tok::Open(open) if open == "[" => {
                i += 1;
                let mut hex = String::new();
                while i < n {
                    match &toks[i] {
                        Tok::Close(close) if close == "]" => {
                            i += 1;
                            break;
                        }
                        Tok::Word(w) => {
                            hex.push_str(&w.replace(' ', ""));
                            i += 1;
                        }
                        _ => {
                            i += 1;
                        }
                    }
                }
                if !hex.is_empty() {
                    out.push(DtsValue::Bytes { text: hex.to_lowercase() });
                }
            }
            Tok::Punct('&') => {
                i += 1;
                if let Some(Tok::Word(label)) = toks.get(i) {
                    out.push(DtsValue::Ref { text: format!("&{label}") });
                    i += 1;
                }
            }
            Tok::Punct(';') => break,
            Tok::Punct(',') => {
                i += 1;
            }
            _ => {
                i += 1;
            }
        }
    }
    (out, i)
}

/* ---------- Tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    /// A hand-built blob: root with two children, a strings property, a cells
    /// property, a bytes property, one mem-reserve pair, boot cpu 2.
    fn dtb_image() -> Vec<u8> {
        let mut b: Vec<u8> = Vec::new();
        let u32b = |v: u32| v.to_be_bytes().to_vec();
        let u64b = |v: u64| v.to_be_bytes().to_vec();
        let push_aligned = |b: &mut Vec<u8>, v: &[u8]| {
            b.extend_from_slice(v);
            while !b.len().is_multiple_of(4) {
                b.push(0);
            }
        };
        // Strings block first (its offset goes into the header): "\0model\0compatible\0serial\0"
        let mut strings: Vec<u8> = Vec::new();
        let mut offs: Vec<usize> = Vec::new();
        for s in ["model", "compatible", "serial", "#address-cells"] {
            offs.push(strings.len());
            strings.extend_from_slice(s.as_bytes());
            strings.push(0);
        }
        // Reserve-space header (40 bytes) + one memreserve pair (16) + terminator (16).
        // Layout: header 40, memreserve 32, structure at 72, strings after.
        let struct_off = 72usize;
        let mut body: Vec<u8> = Vec::new();
        push_aligned(&mut body, &u32b(FDT_BEGIN_NODE));
        push_aligned(&mut body, b"\0"); // root
        push_aligned(&mut body, &u32b(FDT_PROP));
        let model = b"Acme Board\x00";
        push_aligned(&mut body, &u32b(model.len() as u32));
        push_aligned(&mut body, &u32b(offs[0] as u32));
        push_aligned(&mut body, model);
        push_aligned(&mut body, &u32b(FDT_BEGIN_NODE));
        push_aligned(&mut body, b"uart@101000\0");
        push_aligned(&mut body, &u32b(FDT_PROP));
        let compatible = b"acme,uart\0vendor,ns16550\0";
        push_aligned(&mut body, &u32b(compatible.len() as u32));
        push_aligned(&mut body, &u32b(offs[1] as u32));
        push_aligned(&mut body, compatible);
        push_aligned(&mut body, &u32b(FDT_PROP));
        let reg: [u8; 8] = [0x10, 0x10, 0, 0, 0, 0, 0, 0x64];
        push_aligned(&mut body, &u32b(8));
        push_aligned(&mut body, &u32b(offs[2] as u32));
        push_aligned(&mut body, &reg);
        push_aligned(&mut body, &u32b(FDT_PROP));
        push_aligned(&mut body, &u32b(4));
        push_aligned(&mut body, &u32b(offs[3] as u32));
        push_aligned(&mut body, &u32b(2)); // #address-cells = 2
        push_aligned(&mut body, &u32b(FDT_END_NODE));
        push_aligned(&mut body, &u32b(FDT_END_NODE));
        push_aligned(&mut body, &u32b(FDT_END));
        let totalsize = struct_off + body.len() + strings.len();
        // Header (the spec's ten big-endian fields, 40 bytes).
        b.extend_from_slice(&u32b(FDT_MAGIC));
        b.extend_from_slice(&u32b(totalsize as u32));
        b.extend_from_slice(&u32b(struct_off as u32));
        b.extend_from_slice(&u32b((struct_off + body.len()) as u32));
        b.extend_from_slice(&u32b(40)); // off_mem_rsvmap: right after the header
        b.extend_from_slice(&u32b(17)); // version
        b.extend_from_slice(&u32b(16)); // last comp
        b.extend_from_slice(&u32b(2)); // boot cpuid
        b.extend_from_slice(&u32b(strings.len() as u32));
        b.extend_from_slice(&u32b(body.len() as u32));
        // Mem reserve: one pair then the terminator.
        b.extend_from_slice(&u64b(0x8000_0000));
        b.extend_from_slice(&u64b(0x1000));
        b.extend_from_slice(&u64b(0));
        b.extend_from_slice(&u64b(0));
        debug_assert_eq!(b.len(), struct_off);
        b.extend_from_slice(&body);
        b.extend_from_slice(&strings);
        b
    }

    #[test]
    fn reads_a_blob_into_the_tree() {
        let img = dtb_image();
        let doc = parse(&img, img.len() as u64).unwrap();
        assert_eq!(doc.format, "dtb");
        assert_eq!(doc.boot_cpuid, Some(2));
        assert_eq!(doc.mem_reserve.len(), 1);
        assert_eq!(doc.mem_reserve[0].address, 0x8000_0000);
        assert_eq!(doc.root.name, "/");
        assert_eq!(doc.root.properties.len(), 1);
        assert_eq!(doc.root.properties[0].name, "model");
        assert_eq!(doc.root.properties[0].values, vec![DtsValue::Str { text: "Acme Board".into() }]);
        assert_eq!(doc.root.children.len(), 1);
        let uart = &doc.root.children[0];
        assert_eq!(uart.name, "uart@101000");
        assert_eq!(uart.unit_address.as_deref(), Some("101000"));
        assert_eq!(uart.properties.len(), 3);
        // The compatible property's two string chunks.
        assert_eq!(
            uart.properties[0].values,
            vec![
                DtsValue::Str { text: "acme,uart".into() },
                DtsValue::Str { text: "vendor,ns16550".into() }
            ]
        );
        // reg: two big-endian cells, spelled hex.
        assert_eq!(
            uart.properties[1].values,
            vec![DtsValue::Cell { text: "0x10100000".into() }, DtsValue::Cell { text: "0x00000064".into() }]
        );
        assert_eq!(uart.properties[2].values, vec![DtsValue::Cell { text: "0x00000002".into() }]);
    }

    #[test]
    fn counts_the_tree() {
        let img = dtb_image();
        let doc = parse(&img, img.len() as u64).unwrap();
        assert_eq!(doc.nodes, 2); // root + uart
        assert_eq!(doc.properties, 4);
    }

    #[test]
    fn parses_source_nodes_and_properties() {
        let src = r#"
/dts-v1/;
/memreserve/ 0x80000000 0x1000;

/ {
    model = "Acme Board";
    compatible = "acme,board", "generic";
    #address-cells = <2>;
    #size-cells = <2>;

    chosen {
        bootargs = "console=ttyS0 earlycon";
        stdout-path = &uart0;
    };

    soc {
        uart0: serial@101000 {
            compatible = "vendor,ns16550";
            reg = <0x10100000 0x64>;
            clock-frequency = <0x0f42400 25165824>;
            status = "okay";
        };
    };
};
"#;
        let doc = parse_dts(src, src.len() as u64).unwrap();
        assert_eq!(doc.format, "dts");
        assert_eq!(doc.mem_reserve.len(), 1);
        assert_eq!(doc.mem_reserve[0].address, 0x8000_0000);
        assert_eq!(doc.root.properties.len(), 4);
        assert_eq!(doc.root.children.len(), 2); // chosen + soc
        // #address-cells parsed as a property despite the leading '#'.
        assert_eq!(doc.root.properties[2].name, "#address-cells");
        assert_eq!(doc.root.properties[2].values, vec![DtsValue::Cell { text: "0x00000002".into() }]);
        // Chosen's ref value.
        let chosen = &doc.root.children[0];
        assert_eq!(chosen.name, "chosen");
        assert_eq!(chosen.properties[1].values, vec![DtsValue::Ref { text: "&uart0".into() }]);
        // The labelled node: label kept, unit address split off.
        let soc = &doc.root.children[1];
        assert_eq!(soc.children.len(), 1);
        let uart = &soc.children[0];
        assert_eq!(uart.name, "serial@101000");
        assert_eq!(uart.label.as_deref(), Some("uart0"));
        assert_eq!(uart.unit_address.as_deref(), Some("101000"));
        let reg = uart.properties.iter().find(|p| p.name == "reg").unwrap();
        assert_eq!(reg.values, vec![DtsValue::Cell { text: "0x10100000".into() }, DtsValue::Cell { text: "0x00000064".into() }]);
        // Both spellings of one number reach the same cell.
        let clock = uart.properties.iter().find(|p| p.name == "clock-frequency").unwrap();
        assert_eq!(clock.values, vec![DtsValue::Cell { text: "0x00f42400".into() }, DtsValue::Cell { text: "0x01800000".into() }]);
    }

    #[test]
    fn strips_comments_and_skips_preprocessor() {
        let src = r#"
/dts-v1/;

#include <dt-bindings/gpio/gpio.h>
#define BOARD_REV 3

/* the root
   spans lines */
/ {
    // a line comment
    model = "Board rev " "2";
    int-gpios = <&gpio1 5 GPIO_ACTIVE_LOW 0x1>;
};
"#;
        let doc = parse_dts(src, src.len() as u64).unwrap();
        assert_eq!(doc.root.children.len(), 0);
        let model = &doc.root.properties[0];
        assert_eq!(model.name, "model");
        // The two string chunks kept apart.
        assert_eq!(model.values.len(), 2);
        // The gpio cells: the constant name rides as text, the hex number as a cell.
        let gpios = &doc.root.properties[1];
        assert_eq!(gpios.name, "int-gpios");
        assert_eq!(gpios.values.len(), 4);
        assert_eq!(gpios.values[0], DtsValue::Ref { text: "&gpio1".into() });
        assert_eq!(gpios.values[1], DtsValue::Cell { text: "0x00000005".into() });
    }

    #[test]
    fn byte_arrays_and_refs_reach_their_own_readings() {
        let src = r#"
/ {
    mac = [de ad be ef 01 02];
    zero = <0x0 10>;
    ref = &friend;
    raw = [0102];
};
"#;
        let doc = parse_dts(src, src.len() as u64).unwrap();
        let mac = doc.root.properties.iter().find(|p| p.name == "mac").unwrap();
        assert_eq!(mac.values, vec![DtsValue::Bytes { text: "deadbeef0102".into() }]);
        let zero = doc.root.properties.iter().find(|p| p.name == "zero").unwrap();
        assert_eq!(zero.values, vec![DtsValue::Cell { text: "0x00000000".into() }, DtsValue::Cell { text: "0x0000000a".into() }]);
        let rf = doc.root.properties.iter().find(|p| p.name == "ref").unwrap();
        assert_eq!(rf.values, vec![DtsValue::Ref { text: "&friend".into() }]);
        let raw = doc.root.properties.iter().find(|p| p.name == "raw").unwrap();
        assert_eq!(raw.values, vec![DtsValue::Bytes { text: "0102".into() }]);
    }

    #[test]
    fn overlays_become_label_named_children() {
        let src = r#"
&uart0 {
    status = "disabled";
};

/ {
    x = <1>;
};
"#;
        let doc = parse_dts(src, src.len() as u64).unwrap();
        assert_eq!(doc.root.properties.len(), 1);
        assert_eq!(doc.root.children.len(), 1);
        assert_eq!(doc.root.children[0].name, "&uart0");
        assert_eq!(doc.root.children[0].properties[0].name, "status");
    }

    #[test]
    fn empty_properties_and_deletes_ride_through() {
        let src = r#"
/ {
    empty-prop;
    deleted;
    /delete-property/ deleted;
    node {
        inner;
    };
    /delete-node/ gone;
};
"#;
        let doc = parse_dts(src, src.len() as u64).unwrap();
        // `deleted`'s second spelling and `gone` were swallowed.
        assert_eq!(doc.root.properties.len(), 1);
        assert_eq!(doc.root.properties[0].name, "empty-prop");
        assert!(doc.root.properties[0].values.is_empty());
        assert_eq!(doc.root.children.len(), 1);
    }

    #[test]
    fn junk_is_an_error_not_a_panic() {
        assert!(parse(b"", 0).is_err());
        assert!(parse(b"neither a blob nor source", 24).is_err());
        // A blob whose header lies about its size.
        let mut bad = dtb_image();
        bad[4..8].copy_from_slice(&u32::to_be_bytes(9_999_999));
        assert!(parse(&bad, bad.len() as u64).is_err());
    }

    #[test]
    fn open_doc_reads_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("board.dtb");
        std::fs::write(&path, dtb_image()).unwrap();
        let doc = open_doc(&path).unwrap();
        assert_eq!(doc.format, "dtb");
        let src = dir.path().join("board.dts");
        std::fs::write(&src, "/ { x = <1>; };").unwrap();
        let doc = open_doc(&src).unwrap();
        assert_eq!(doc.format, "dts");
        assert_eq!(doc.root.properties[0].values, vec![DtsValue::Cell { text: "0x00000001".into() }]);
    }
}
