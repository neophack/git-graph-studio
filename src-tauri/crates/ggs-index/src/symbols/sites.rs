//! The site-level scanner: the masked token walk that answers where a text spells a
//! call — `name(` — and which object the call rides, plus the per-language import
//! spellings and the visibility reading of a declaration line. It reads only what the
//! comment/string mask leaves, the same discipline the relation graph's scans keep, so
//! a name inside a comment or a string is never a call site. This is what the
//! store-backed reports (Dead Code, Security, the Import Graph) and the MCP bridge
//! read instead of building the Code Analysis engine: the project volumes' store
//! carries the file table, this turns each file's text into the sites those reports
//! need, one read per file at report time.

use std::collections::HashSet;

use super::mask::{self, CodeMask};

/// One call site the walk found: the callee's spelling, the object it rides (the
/// identifier before the `.`/`->`/`::` — the last segment, `self.ctx.load()` reading
/// `ctx`), and where the name stands (0-based line, 0-based byte column).
pub struct SiteCall {
    pub name: String,
    pub receiver: Option<String>,
    pub line: usize,
    pub column: usize,
}

/// The syntax keywords that are always followed by a `(` without being calls, per
/// language family — the walk's own suppression table. A name outside its family's
/// table (a JS method named `match`, say) stays a call site.
fn keywords_of(ext: &str) -> &'static [&'static str] {
    match ext {
        "rs" => &[
            "if", "for", "while", "loop", "match", "return", "catch", "unsafe", "as", "use",
            "impl", "fn", "else",
        ],
        "py" => &[
            "if", "for", "while", "elif", "else", "return", "lambda", "and", "or", "not", "in",
            "is", "await", "with", "assert", "print", "raise", "except", "finally", "import",
            "from", "del", "global", "yield",
        ],
        "go" => &[
            "if", "for", "range", "switch", "return", "go", "defer", "func", "var", "const",
            "type", "map", "make", "len", "cap", "append", "import", "package", "chan", "else",
        ],
        "js" | "jsx" | "ts" | "tsx" => &[
            "if", "for", "while", "switch", "return", "catch", "new", "delete", "typeof",
            "await", "function", "constructor", "super", "import", "require", "export", "else",
        ],
        "java" | "cs" => &[
            "if", "for", "while", "switch", "return", "catch", "new", "super", "this", "lock",
            "using", "import", "package", "synchronized", "base", "sizeof", "foreach", "else",
        ],
        "c" | "h" | "cpp" | "hpp" | "cc" | "hh" => &[
            "if", "for", "while", "switch", "return", "sizeof", "alignof", "typeof", "decltype",
            "defined", "new", "delete", "throw", "catch", "static_assert", "_Alignof", "and",
            "or", "not", "compl", "typeid", "operator", "else",
        ],
        // Every other extension the smallest shared table.
        _ => &["if", "for", "while", "do", "switch", "return", "catch", "new", "else"],
    }
}

/// One identifier-ish token the walk stepped on: its text, its line, its byte column
/// within the line, and its byte range in the whole text.
struct Tok<'a> {
    text: &'a str,
    line: usize,
    column: usize,
    start: usize,
    end: usize,
}

/// Whether a byte runs an identifier: letters, digits, `_`, `$` and the non-ASCII
/// letters (the parser layer's own identifiers may carry them).
fn ident_byte(text: &str, at: usize, first: bool) -> bool {
    let b = text.as_bytes()[at];
    if b.is_ascii_alphanumeric() || b == b'_' || b == b'$' {
        return true;
    }
    if b < 0x80 {
        return false;
    }
    text[at..]
        .chars()
        .next()
        .is_some_and(|c| if first { c.is_alphabetic() } else { c.is_alphanumeric() })
}

/// The whole walk of one text: every identifier-ish token outside the mask, with the
/// byte offsets where it starts and ends. Keywords are NOT filtered here — the call
/// reader asks its own question about the token it holds.
fn walk_tokens(text: &str, mask: &CodeMask, mut visit: impl FnMut(Tok<'_>)) {
    let mut line = 0usize;
    let mut line_start = 0usize;
    let bytes = text.as_bytes();
    let mut at = 0usize;
    while at < bytes.len() {
        let b = bytes[at];
        if b == b'\n' {
            line += 1;
            line_start = at + 1;
            at += 1;
            continue;
        }
        if !ident_byte(text, at, true) {
            at += 1;
            continue;
        }
        let start = at;
        at += 1;
        while at < bytes.len() && ident_byte(text, at, false) {
            at += 1;
        }
        let span = &text[start..at];
        let column = start - line_start;
        // The mask answers in character columns; both ends checked so a token never
        // straddles a span edge unnoticed.
        let chars = span.chars().count();
        let masked = mask.is_masked(line, column) || mask.is_masked(line, column + chars - 1);
        if !masked {
            visit(Tok {
                text: span,
                line,
                column,
                start,
                end: at,
            });
        }
    }
}

/// Whether the token ending at byte `end` reads as a call: horizontal whitespace, an
/// optional Rust `!`, and then `(`. The lookahead never crosses a newline — a call
/// spelled `foo\n(x)` stays invisible, which only ever keeps a live function alive.
fn reads_call(text: &str, end: usize) -> bool {
    let bytes = text.as_bytes();
    let mut at = end;
    while at < bytes.len() && (bytes[at] == b' ' || bytes[at] == b'\t' || bytes[at] == b'\r') {
        at += 1;
    }
    if at < bytes.len() && bytes[at] == b'!' {
        at += 1;
        while at < bytes.len() && (bytes[at] == b' ' || bytes[at] == b'\t' || bytes[at] == b'\r') {
            at += 1;
        }
    }
    at < bytes.len() && bytes[at] == b'('
}

/// The object a call at byte `start` rides, read backwards: horizontal whitespace, one
/// of the member operators (`.`/`?.`/`->`/`::`), whitespace again, then the identifier
/// ending there. `None` when the bytes before the token read as anything else — a
/// plain call, an operator run, the start of the file.
fn receiver_of(text: &str, start: usize) -> Option<String> {
    let bytes = text.as_bytes();
    let mut at = start;
    while at > 0 && (bytes[at - 1] == b' ' || bytes[at - 1] == b'\t' || bytes[at - 1] == b'\r') {
        at -= 1;
    }
    let operator_len = if at >= 2
        && ((bytes[at - 2] == b'-' && bytes[at - 1] == b'>')
            || (bytes[at - 2] == b':' && bytes[at - 1] == b':'))
    {
        2 // `->` and `::`
    } else if at >= 1 && bytes[at - 1] == b'.' {
        1 // `.` and `?.` alike — the optional mark rides the operator
    } else {
        return None;
    };
    at -= operator_len;
    while at > 0 && (bytes[at - 1] == b' ' || bytes[at - 1] == b'\t' || bytes[at - 1] == b'\r') {
        at -= 1;
    }
    let end = at;
    while at > 0 && ident_byte(text, at - 1, false) {
        at -= 1;
    }
    if at == end {
        return None; // nothing identifier-ish before the operator
    }
    let receiver = text[at..end].to_owned();
    // A keyword is never an object (`super.fn()` reads as a plain call).
    if matches!(
        receiver.as_str(),
        "super" | "this" | "self" | "base" | "global" | "crate"
    ) {
        return None;
    }
    Some(receiver)
}

/// The declaration keywords whose next identifier is a DECLARED name, not a call —
/// `def run(cmd):` reads `run(`, and no report wants that as a call site.
const DECL_KEYWORDS: &[&str] = &["def", "fn", "func", "function", "macro_rules"];

/// Every unmasked call site of `text` whose callee `wanted` keeps. The keyword table
/// of `ext`'s family suppresses the syntax forms (`if (`, `return (`); a declaration
/// keyword's next identifier (`def eval(cmd)`) is skipped. `wanted` runs before the
/// receiver lookahead, so an unmatched name costs one keyword lookup and nothing more.
pub fn call_sites(ext: &str, text: &str, wanted: &dyn Fn(&str) -> bool) -> Vec<SiteCall> {
    let keywords: HashSet<&str> = keywords_of(ext).iter().copied().collect();
    let mut sites_out = Vec::new();
    let code_mask = mask::mask(text);
    let mut prev_text: Option<String> = None;
    walk_tokens(text, &code_mask, |tok| {
        let after_decl = prev_text
            .as_deref()
            .is_some_and(|prev| DECL_KEYWORDS.contains(&prev));
        prev_text = Some(tok.text.to_owned());
        if after_decl || keywords.contains(tok.text) || !wanted(tok.text) {
            return;
        }
        if !reads_call(text, tok.end) {
            return;
        }
        sites_out.push(SiteCall {
            name: tok.text.to_owned(),
            receiver: receiver_of(text, tok.start),
            line: tok.line,
            column: tok.column,
        });
    });
    sites_out
}

/* ---------- the import spellings ---------- */

/// The line's code prefix — its text up to the first masked character (a comment or a
/// string that opens on this line). A span carried over from a previous line (a
/// multi-line string, a block comment) masks the whole line. Character offsets in,
/// byte offset out.
fn code_prefix<'a>(mask: &CodeMask, line: usize, line_text: &'a str) -> &'a str {
    let Some(&line_at) = mask.line_starts.get(line) else {
        return line_text;
    };
    let line_chars = line_text.chars().count();
    let mut cut = line_chars;
    for &(start, stop) in &mask.spans {
        if stop <= line_at {
            continue;
        }
        if start >= line_at + line_chars {
            break;
        }
        if start < line_at {
            return ""; // the line rides inside a span opened above it
        }
        cut = start - line_at;
        break; // spans ascend; the first overlapping one cuts earliest
    }
    let byte_cut = line_text
        .char_indices()
        .nth(cut)
        .map(|(byte, _)| byte)
        .unwrap_or(line_text.len());
    &line_text[..byte_cut]
}

/// The first quoted string's content of `text` (`'spec'`, `"spec"`, backticks), with
/// the byte offset the quote stands at.
fn quoted_spec_at(text: &str) -> Option<(usize, String)> {
    let open = text.find(['"', '\'', '`'])?;
    let quote = text.as_bytes()[open];
    let rest = &text[open + 1..];
    let close = rest.find(quote as char)?;
    let spec = rest[..close].trim();
    if spec.is_empty() {
        return None;
    }
    Some((open, spec.to_owned()))
}

/// A Python module path: dotted identifiers with the leading relative dots.
fn is_module_path(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|c| c == '.' || c == '_' || c.is_alphanumeric())
}

/// One import statement's spellings on one line, per language family — the same
/// normalizations the parse layer applies (`lib.helpers` for Python, the quoted spec
/// unquoted for JS/Go/C, the `use` head up to the first `{` for Rust). The statement
/// keyword must stand in the line's code prefix (a commented-out import yields
/// nothing); the spec itself is read off the raw line, because for the quoted forms it
/// IS a masked span.
fn import_line(ext: &str, code: &str, raw: &str, out: &mut Vec<String>) {
    let code_trim = code.trim_start();
    let raw_trim = raw.trim();
    let after = |word: &str| code_trim.strip_prefix(word).map(str::trim_start);
    match ext {
        "py" => {
            if let Some(rest) = after("import") {
                // `import a, b as c` — every comma-separated module, first token each.
                for part in rest.split(',') {
                    let module = part.split_whitespace().next().unwrap_or("");
                    if is_module_path(module) {
                        out.push(module.to_owned());
                    }
                }
            } else if let Some(rest) = after("from") {
                // `from a.b import x` / `from . import sibling` — the module head.
                if let Some((module, _)) = rest.split_once(" import ") {
                    let module = module.trim();
                    if is_module_path(module) {
                        out.push(module.to_owned());
                    }
                }
            }
        }
        "rs" => {
            if let Some(rest) = after("use") {
                // `use a::b::{c, d};` — the head up to the first `{` (the parse
                // layer's rule), the trailing `;` off.
                let head = rest.split('{').next().unwrap_or(rest);
                let head = head.trim().trim_end_matches(';').trim();
                if !head.is_empty() {
                    out.push(head.to_owned());
                }
            }
        }
        "js" | "jsx" | "ts" | "tsx" => {
            if code_trim.starts_with("import") || code_trim.starts_with("export") {
                if let Some((_, spec)) = quoted_spec_at(raw_trim) {
                    out.push(spec);
                }
            } else if let Some(at) = code_trim.find("require") {
                // `const c = require('./c.js')` — the spec after that keyword.
                if let Some((_, spec)) = quoted_spec_at(&raw_trim[at..]) {
                    out.push(spec);
                }
            }
        }
        "go" => {
            if code_trim.starts_with("import") {
                if let Some((_, spec)) = quoted_spec_at(raw_trim) {
                    out.push(spec);
                }
            }
            // The `import (` block's member lines land in `import_spellings`'s own
            // walk — a whole-line string has an empty code prefix.
        }
        "java" => {
            if let Some(rest) = after("import") {
                let spec = rest.trim_end_matches(';').trim();
                if !spec.is_empty()
                    && spec
                        .chars()
                        .all(|c| c.is_alphanumeric() || c == '.' || c == '_' || c == '$' || c == '*')
                {
                    out.push(spec.to_owned());
                }
            }
        }
        "cs" => {
            if let Some(rest) = after("using") {
                // `using (var x = …)` is a statement, not an import: only the
                // identifier path of a directive survives the character check.
                let spec = rest.trim_end_matches(';').trim();
                if !spec.is_empty()
                    && spec
                        .chars()
                        .all(|c| c.is_alphanumeric() || c == '.' || c == '_')
                {
                    out.push(spec.to_owned());
                }
            }
        }
        // `#include "local.h"` — the quoted local form only (the parse layer's own
        // capture; the angle form names a system header).
        "c" | "h" | "cpp" | "hpp" | "cc" | "hh" if code_trim.starts_with("#include") => {
            if let Some((_, spec)) = quoted_spec_at(raw_trim) {
                out.push(spec);
            }
        }
        _ => {}
    }
}

/// Every import spelling of `text`, per `ext`'s language. Go's `import (` block runs
/// its own little state machine over the lines. Order follows the text.
pub fn import_spellings(ext: &str, text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let code_mask = mask::mask(text);
    let mut go_block = false;
    for (line_no, line_text) in text.lines().enumerate() {
        let code = code_prefix(&code_mask, line_no, line_text);
        let code_trim = code.trim_start();
        if ext == "go" && go_block {
            // A block member: a quoted spec, optionally behind an alias — the bytes
            // before the quote must be nothing or one identifier, so a commented
            // `"fmt"` (its code prefix empty, its raw line not starting with a quote)
            // never counts. The `)` closes the block.
            if code_trim.starts_with(')') {
                go_block = false;
                continue;
            }
            let raw_trim = line_text.trim();
            if let Some((open, spec)) = quoted_spec_at(raw_trim) {
                let before = raw_trim[..open].trim();
                let alias_ok = before.is_empty()
                    || (before.len() == 1 && before.starts_with('_'))
                    || before.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.');
                if alias_ok {
                    out.push(spec);
                }
            }
            continue;
        }
        if ext == "go" && code_trim.starts_with("import") && code_trim.contains('(') {
            go_block = true;
            // The same line may carry no spec (`import (` alone); try anyway.
            import_line(ext, code, line_text, &mut out);
            continue;
        }
        import_line(ext, code, line_text, &mut out);
    }
    out
}

/* ---------- the visibility reading ---------- */

/// Whether the declaration whose name stands on `decl_line` (0-based line text, the
/// line above alongside for the languages that let `export`/`pub` ride its own line)
/// reaches outside its file — the parser layer's `exported_of`, read off the line
/// text instead of the tree: the store-backed dead code's visibility half.
pub fn exported_of_line(ext: &str, prev_line: &str, decl_line: &str, name: &str) -> bool {
    let line = decl_line.trim_start();
    match ext {
        "rs" => line.starts_with("pub") || prev_line.trim_start().starts_with("#[macro_export]"),
        "go" => name.chars().next().is_some_and(char::is_uppercase),
        "py" => !name.starts_with('_'),
        "js" | "jsx" | "ts" | "tsx" => {
            line.starts_with("export") || prev_line.trim_start().starts_with("export")
        }
        "java" | "cs" => line.contains("public"),
        // C/C++: the file-private `static` is the one visibility the line spells.
        "c" | "h" | "cpp" | "hpp" | "cc" | "hh" => !line.starts_with("static"),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names_of(ext: &str, text: &str) -> Vec<(String, Option<String>, usize)> {
        call_sites(ext, text, &|_| true)
            .into_iter()
            .map(|site| (site.name, site.receiver, site.line))
            .collect()
    }

    #[test]
    fn calls_read_with_receivers_and_lines() {
        let text = "import os\n\
                    def run(cmd):\n    os.system(cmd)\n    eval(cmd)\n    md5(x)\n";
        let sites = names_of("py", text);
        // The declaration's own `run(` never counts — a declaration keyword's next
        // identifier is the declared name, not a call.
        assert_eq!(sites.len(), 3, "{sites:?}");
        assert_eq!(sites[0], ("system".to_owned(), Some("os".to_owned()), 2));
        assert_eq!(sites[1], ("eval".to_owned(), None, 3));
        assert_eq!(sites[2], ("md5".to_owned(), None, 4));
    }

    #[test]
    fn declaration_keywords_suppress_their_next_identifier() {
        let text = "fn helper() {}\nfunc runner() {}\nfunction worker() {}\ncall_site();\n";
        let sites = names_of("rs", text);
        let names: Vec<&str> = sites.iter().map(|(n, _, _)| n.as_str()).collect();
        assert!(!names.contains(&"helper"), "{names:?}");
        let go = names_of("go", text);
        assert!(!go.iter().any(|(n, _, _)| n == "runner"), "{go:?}");
        let js = names_of("js", text);
        assert!(!js.iter().any(|(n, _, _)| n == "worker"), "{js:?}");
    }

    #[test]
    fn keywords_are_not_calls() {
        let text = "void f(int x) {\n  if (ready) { run(x); }\n  return stop(x);\n}\n";
        let sites = names_of("c", text);
        let names: Vec<&str> = sites.iter().map(|(n, _, _)| n.as_str()).collect();
        assert!(names.contains(&"run") && names.contains(&"stop"), "{names:?}");
        assert!(!names.contains(&"if") && !names.contains(&"return"), "{names:?}");
    }

    #[test]
    fn comments_and_strings_hide_calls() {
        let text = "// call_me();\n/* helper(); */\nlet s = \"ghost();\";\nreal();\n";
        let sites = names_of("js", text);
        let names: Vec<&str> = sites.iter().map(|(n, _, _)| n.as_str()).collect();
        assert_eq!(names, vec!["real"], "{names:?}");
    }

    #[test]
    fn declarations_read_as_calls_the_caller_excludes_lines() {
        // `void f(char *s)` reads as a call site — the report excludes declaration
        // lines; the scanner's job is only to see every `name(` spelling.
        let text = "void f(char *s) { strcpy(b, s); }\n";
        let sites = names_of("c", text);
        let names: Vec<&str> = sites.iter().map(|(n, _, _)| n.as_str()).collect();
        assert!(names.contains(&"f") && names.contains(&"strcpy"), "{names:?}");
    }

    #[test]
    fn receivers_walk_chains_and_skip_keywords() {
        let text = "self.ctx.load(x);\na.b.fine();\nsuper.go();\nptr->field->method(1);\nq::run();\n";
        let sites = call_sites("cpp", text, &|_| true);
        let by_name: std::collections::HashMap<&str, Option<&str>> = sites
            .iter()
            .map(|s| (s.name.as_str(), s.receiver.as_deref()))
            .collect();
        assert_eq!(by_name["load"], Some("ctx"));
        assert_eq!(by_name["fine"], Some("b"));
        assert_eq!(by_name["go"], None);
        assert_eq!(by_name["method"], Some("field"));
        assert_eq!(by_name["run"], Some("q"));
    }

    #[test]
    fn wanted_filter_skips_early() {
        let text = "alpha(1);\nbeta(2);\nalpha(3);\n";
        let sites = call_sites("py", text, &|name| name == "alpha");
        assert_eq!(sites.len(), 2);
        assert!(sites.iter().all(|s| s.name == "alpha"));
    }

    #[test]
    fn imports_read_per_language() {
        let py = import_spellings(
            "py",
            "import os\nfrom lib.helpers import tool\nfrom . import sibling\n# import ghost\nimport a, b as c\n",
        );
        assert_eq!(py, vec!["os", "lib.helpers", ".", "a", "b"]);
        let js = import_spellings(
            "js",
            "import x from './a.js';\nimport './b.js';\nconst c = require('./c.js');\n// import './ghost.js';\n",
        );
        assert_eq!(js, vec!["./a.js", "./b.js", "./c.js"]);
        let rs = import_spellings("rs", "use std::sync::Arc;\nuse a::b::{c, d};\n// use x::ghost;\n");
        assert_eq!(rs, vec!["std::sync::Arc", "a::b::"]);
        let c = import_spellings("c", "#include \"local.h\"\n#include <stdio.h>\n// #include \"ghost.h\"\n");
        assert_eq!(c, vec!["local.h"]);
        let go = import_spellings(
            "go",
            "import \"fmt\"\nimport (\n\t\"os\"\n\talias \"path/filepath\"\n\t// \"ghost\"\n)\n",
        );
        assert_eq!(go, vec!["fmt", "os", "path/filepath"]);
        let java = import_spellings("java", "import com.x.Y;\nimport com.z.*;\n");
        assert_eq!(java, vec!["com.x.Y", "com.z.*"]);
        let cs = import_spellings("cs", "using System.IO;\nusing System;\nusing (var s = open()) { }\n");
        assert_eq!(cs, vec!["System.IO", "System"]);
    }

    #[test]
    fn visibility_reads_off_lines() {
        assert!(exported_of_line("rs", "", "pub fn start() {}", "start"));
        assert!(!exported_of_line("rs", "", "fn hidden() {}", "hidden"));
        assert!(exported_of_line("py", "", "def run(self):", "run"));
        assert!(!exported_of_line("py", "", "def _run(self):", "_run"));
        assert!(exported_of_line("go", "", "func Start() {}", "Start"));
        assert!(!exported_of_line("go", "", "func start() {}", "start"));
        assert!(exported_of_line("ts", "", "export function a() {}", "a"));
        assert!(exported_of_line("ts", "export", "function b() {}", "b"));
        assert!(!exported_of_line("java", "", "private void c() {}", "c"));
        assert!(!exported_of_line("c", "", "static void d() {}", "d"));
        assert!(exported_of_line("c", "", "void e(void) {}", "e"));
    }
}
