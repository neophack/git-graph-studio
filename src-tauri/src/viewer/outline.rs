//! Symbol outline: syntect only produces scopes, not a syntax tree, so the outline is a
//! per-language line scan with scope-free regexes over the rope's lines. Enough for the
//! functions/classes/structs navigation pane without pulling in a parser per language.

use serde::Serialize;

use ropey::Rope;

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    pub kind: SymbolKind,
    pub name: String,
    /// 0-based line the declaration starts on.
    pub line: usize,
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Struct,
    Interface,
    Enum,
    Module,
    Type,
}

/// The languages the scan knows. For any other, the outline is empty without walking the
/// document at all — a multi-million-line file must not be scanned for nothing.
fn known(language: &str) -> bool {
    matches!(
        language,
        "rs" | "py"
            | "go"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "java"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "cs"
    )
}

/// A pathological file cannot stall the pane: the scan stops at this many symbols.
const MAX_SYMBOLS: usize = 20_000;

/// The symbol one line declares, if any. `line` is the raw line (its newline may still be
/// on); the scan trims it here so both entry points share one rule.
fn symbol_of(language: &str, line: &str, index: usize) -> Option<Symbol> {
    let trimmed = line.trim_end_matches(['\n', '\r']).trim_start();
    let (kind, name) = match (language, trimmed) {
        ("rs", t) => rust_symbol(t),
        ("py", t) => python_symbol(t),
        ("go", t) => go_symbol(t),
        ("ts" | "tsx" | "js" | "jsx" | "java" | "c" | "h" | "cpp" | "hpp" | "cs", t) => {
            c_like_symbol(t)
        }
        _ => None,
    }?;
    Some(Symbol {
        kind,
        name: name.to_owned(),
        line: index,
    })
}

/// The scan over a rope. `viewer_symbols` works on a snapshot clone of the document's rope
/// (ropey clones share chunks), so the document lock is held only for that clone while the
/// scan itself runs free — a window fetch never queues behind a whole-file outline pass.
pub fn outline_rope(rope: &Rope, language: &str) -> Vec<Symbol> {
    let mut symbols = Vec::new();
    if !known(language) {
        return symbols;
    }
    for (i, line) in rope.lines().enumerate() {
        // A line inside one rope chunk is borrowed as it is; only a line straddling two
        // chunks is copied out — the scan of a huge file stays allocation-free.
        let owned;
        let text: &str = match line.as_str() {
            Some(text) => text,
            None => {
                owned = line.to_string();
                &owned
            }
        };
        if let Some(symbol) = symbol_of(language, text, i) {
            symbols.push(symbol);
            if symbols.len() >= MAX_SYMBOLS {
                break;
            }
        }
    }
    symbols
}

/// The same outline straight from decoded text: the open path scans the text it has just
/// decoded before the rope is built, and the workspace symbol index scans files it never
/// opens as documents. Line numbers match the rope's (the split keeps every `\n`).
pub fn outline_text(text: &str, language: &str) -> Vec<Symbol> {
    let mut symbols = Vec::new();
    if !known(language) {
        return symbols;
    }
    for (i, line) in text.split_inclusive('\n').enumerate() {
        if let Some(symbol) = symbol_of(language, line, i) {
            symbols.push(symbol);
            if symbols.len() >= MAX_SYMBOLS {
                break;
            }
        }
    }
    symbols
}

fn word_after<'a>(line: &'a str, marker: &str) -> Option<&'a str> {
    line.split(marker)
        .nth(1)?
        .trim_start()
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .next()
        .filter(|w| !w.is_empty())
}

fn rust_symbol(t: &str) -> Option<(SymbolKind, &str)> {
    // `pub(async unsafe) fn name`, `pub struct Name`, … — everything is prefix-optional so a
    // single starts-with chain covers the combinations.
    let rest = t
        .strip_prefix("pub ")
        .or_else(|| t.strip_prefix("pub(crate) "))
        .or_else(|| t.strip_prefix("pub(super) "))
        .map(|r| r.trim_start())
        .unwrap_or(t);
    // Modifier prefixes stack (`pub async unsafe extern "C" fn`), so peel them one by one.
    let mut rest = rest;
    loop {
        let stripped = ["async ", "unsafe ", "extern \"C\" ", "const "]
            .iter()
            .find_map(|p| rest.strip_prefix(p));
        match stripped {
            Some(r) => rest = r.trim_start(),
            None => break,
        }
    }
    for (prefix, kind) in [
        ("fn ", SymbolKind::Function),
        ("struct ", SymbolKind::Struct),
        ("enum ", SymbolKind::Enum),
        ("trait ", SymbolKind::Interface),
        ("mod ", SymbolKind::Module),
    ] {
        if let Some(name) = rest.strip_prefix(prefix) {
            let name = name.trim_start();
            let word = name
                .split(|c: char| !(c.is_alphanumeric() || c == '_'))
                .next()
                .unwrap_or("");
            if !word.is_empty() {
                return Some((kind, word));
            }
        }
    }
    None
}

fn python_symbol(t: &str) -> Option<(SymbolKind, &str)> {
    if let Some(name) = t.strip_prefix("def ") {
        let word = name.split('(').next().unwrap_or("").trim();
        if !word.is_empty() {
            return Some((SymbolKind::Function, word));
        }
    }
    if let Some(name) = t.strip_prefix("class ") {
        let word = name.split(['(', ':']).next().unwrap_or("").trim();
        if !word.is_empty() {
            return Some((SymbolKind::Class, word));
        }
    }
    None
}

fn go_symbol(t: &str) -> Option<(SymbolKind, &str)> {
    if let Some(rest) = t.strip_prefix("func ") {
        // `func Name(` vs `func (r *T) Name(` — the receiver form skips past the paren.
        let after_receiver = if rest.starts_with('(') {
            rest.split_once(')')
                .map(|(_, r)| r.trim_start())
                .unwrap_or(rest)
        } else {
            rest
        };
        let word = after_receiver.split('(').next().unwrap_or("").trim();
        if !word.is_empty() {
            return Some((SymbolKind::Function, word));
        }
    }
    if let Some(rest) = t.strip_prefix("type ") {
        if let Some((name, tail)) = rest.split_once(' ') {
            let tail = tail.trim_start();
            let kind = if tail.starts_with("struct") {
                SymbolKind::Struct
            } else if tail.starts_with("interface") {
                SymbolKind::Interface
            } else {
                SymbolKind::Type
            };
            if !name.is_empty() {
                return Some((kind, name));
            }
        }
    }
    None
}

fn c_like_symbol(t: &str) -> Option<(SymbolKind, &str)> {
    if let Some(rest) = t
        .strip_prefix("class ")
        .or_else(|| t.strip_prefix("interface "))
    {
        let kind = if t.starts_with("class ") {
            SymbolKind::Class
        } else {
            SymbolKind::Interface
        };
        let word = rest
            .split(|c: char| c.is_whitespace() || c == '{' || c == '<')
            .next()
            .unwrap_or("");
        if !word.is_empty() {
            return Some((kind, word));
        }
    }
    if let Some(rest) = t.strip_prefix("enum ") {
        let word = rest
            .split(|c: char| c.is_whitespace() || c == '{')
            .next()
            .unwrap_or("");
        if !word.is_empty() {
            return Some((SymbolKind::Enum, word));
        }
    }
    for kw in [
        "function ",
        "export function ",
        "export default function ",
        "async function ",
    ] {
        if let Some(word) = word_after(t, kw) {
            return Some((SymbolKind::Function, word));
        }
    }
    // Java/C methods: `Type name(args) {` at line start, heuristically skipping keywords.
    if t.ends_with('{') && t.contains('(') {
        let head = t.split('(').next().unwrap_or("").trim_end();
        if let Some(word) = head.rsplit(|c: char| c.is_whitespace()).next() {
            if !matches!(
                word,
                "if" | "for" | "while" | "switch" | "catch" | "return" | "else" | "do" | "try"
            ) && word.chars().next().is_some_and(char::is_alphabetic)
            {
                return Some((SymbolKind::Method, word));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outline(text: &str, language: &str) -> Vec<Symbol> {
        outline_rope(&Rope::from(text), language)
    }

    #[test]
    fn rust_outline() {
        let syms = outline(
            "pub fn alpha() {}\nstruct Beta;\nasync unsafe fn gamma(x: u8) {}\n",
            "rs",
        );
        assert_eq!(
            syms,
            vec![
                Symbol {
                    kind: SymbolKind::Function,
                    name: "alpha".into(),
                    line: 0
                },
                Symbol {
                    kind: SymbolKind::Struct,
                    name: "Beta".into(),
                    line: 1
                },
                Symbol {
                    kind: SymbolKind::Function,
                    name: "gamma".into(),
                    line: 2
                },
            ]
        );
    }

    #[test]
    fn python_and_go_outline() {
        assert_eq!(
            outline("class Foo:\n    def bar(self):\n        pass\n", "py"),
            vec![
                Symbol {
                    kind: SymbolKind::Class,
                    name: "Foo".into(),
                    line: 0
                },
                Symbol {
                    kind: SymbolKind::Function,
                    name: "bar".into(),
                    line: 1
                },
            ]
        );
        assert_eq!(
            outline(
                "func main() {}\nfunc (s *Server) Start() {}\ntype Reader interface {\n",
                "go"
            ),
            vec![
                Symbol {
                    kind: SymbolKind::Function,
                    name: "main".into(),
                    line: 0
                },
                Symbol {
                    kind: SymbolKind::Function,
                    name: "Start".into(),
                    line: 1
                },
                Symbol {
                    kind: SymbolKind::Interface,
                    name: "Reader".into(),
                    line: 2
                },
            ]
        );
    }

    #[test]
    fn text_scan_matches_the_rope_scan() {
        // The workspace index scans decoded text, the viewer scans the rope: same symbols,
        // same lines - including a CRLF file and a final line without a newline.
        let text = "pub fn alpha() {}\r\nstruct Beta;\r\n\r\nmod gamma";
        assert_eq!(outline_text(text, "rs"), outline(text, "rs"));
        assert_eq!(
            outline(text, "rs")
                .iter()
                .map(|s| s.line)
                .collect::<Vec<_>>(),
            [0, 1, 3]
        );
        assert!(outline_text("fn nothing() {}", "log").is_empty());
    }

    #[test]
    fn c_like_skips_control_flow() {
        let syms = outline(
            "class Widget {\n  render(items) {\n    if (x) {\n      return;\n    }\n  }\n}\nfunction setup() {}\n",
            "ts",
        );
        let names: Vec<&str> = syms.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["Widget", "render", "setup"]);
    }
}
