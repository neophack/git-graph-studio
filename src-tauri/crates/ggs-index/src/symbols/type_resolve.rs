//! Lightweight type resolution and member disambiguation (Area 1):
//! resolves receiver expressions (`ptr->foo`, `obj.bar`, `a->b.c`, `Ns::Type::fn`)
//! to their owning struct/class/trait container using declared local/parameter/field
//! types and the `SymbolStore` inheritance graph (`bases_of`).
//!
//! Powers:
//! - Receiver-disambiguated Go-to-Definition (`resolve_member_symbol`)
//! - `.` / `->` / `::` member auto-completion (`member_completions`)
//! - Receiver-aware `refsFrom` disambiguation in the Relation Window

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;

use serde::Serialize;

use crate::scan::read_searchable;
use crate::symbols::store::SymbolStore;
use crate::symbols::WorkspaceSymbol;

/// One member completion candidate returned for `.` / `->` / `::` access.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemberCompletion {
    pub name: String,
    pub kind: String,
    pub container: String,
    pub path: String,
    pub line: usize,
    /// `true` when inherited from a base class/interface rather than declared directly.
    pub inherited: bool,
}

const NON_TYPE_KEYWORDS: &[&str] = &[
    "return", "if", "else", "for", "while", "switch", "case", "break", "continue", "goto",
    "sizeof", "typeof", "new", "delete", "throw", "try", "catch", "const", "static", "extern",
    "volatile", "register", "inline", "virtual", "override", "public", "private", "protected",
    "struct", "class", "enum", "union", "typedef", "using", "namespace", "template", "typename",
    "auto", "let", "mut", "var", "val", "fn", "func", "function", "def", "pub", "async", "await",
    "import", "from", "export", "default", "void", "bool", "int", "char", "short", "long",
    "float", "double", "signed", "unsigned", "size_t", "ssize_t", "uint8_t", "uint16_t",
    "uint32_t", "uint64_t", "int8_t", "int16_t", "int32_t", "int64_t", "usize", "isize", "i32",
    "u32", "i64", "u64", "f32", "f64", "str", "string", "number", "boolean", "any", "unknown",
];

fn is_ident_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn is_candidate_type(tok: &str) -> bool {
    !tok.is_empty()
        && tok.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_')
        && !NON_TYPE_KEYWORDS.contains(&tok)
}

/// Strip leading/trailing C/C++/Rust/TS type qualifiers and generic arguments to recover
/// the core type identifier (e.g. `const struct Foo*` -> `Foo`, `Arc<Mutex<Bar>>` -> `Bar`,
/// `Vec<Item>` -> `Item`, `&mut Session` -> `Session`).
pub fn normalize_type_name(raw: &str) -> Option<String> {
    let mut s = raw.trim();
    loop {
        let before = s;
        for prefix in [
            "const ",
            "volatile ",
            "static ",
            "extern ",
            "struct ",
            "class ",
            "enum ",
            "union ",
            "typename ",
            "mut ",
            "ref ",
        ] {
            if let Some(rest) = s.strip_prefix(prefix) {
                s = rest.trim_start();
            }
        }
        if s == before {
            break;
        }
    }
    s = s.trim_start_matches(['&', '*']).trim();
    s = s.strip_prefix("mut ").unwrap_or(s).trim();

    // Unwrap common smart-pointer / wrapper generics (`Arc<T>`, `Box<T>`, `Option<T>`, `unique_ptr<T>`).
    for wrapper in [
        "Arc<",
        "Rc<",
        "Box<",
        "Option<",
        "Mutex<",
        "RwLock<",
        "RefCell<",
        "unique_ptr<",
        "shared_ptr<",
        "weak_ptr<",
        "std::unique_ptr<",
        "std::shared_ptr<",
    ] {
        if let Some(inner) = s.strip_prefix(wrapper) {
            if let Some(end) = inner.rfind('>') {
                return normalize_type_name(&inner[..end]);
            }
        }
    }

    // Drop trailing generics, pointers, references, array brackets, nullable `?`.
    if let Some(angle) = s.find('<') {
        s = &s[..angle];
    }
    s = s.trim_end_matches(['*', '&', '?', '[', ']']).trim();
    // Take the final path segment (`std::string` -> `string`, `crate::Foo` -> `Foo`).
    let base = s.rsplit("::").next().unwrap_or(s).trim();
    let base = base.rsplit('.').next().unwrap_or(base).trim();
    is_candidate_type(base).then(|| base.to_owned())
}

/// Extract `var_name -> TypeName` bindings visible at `cursor_line` (0-based) from `text`.
/// Covers C/C++, Rust, TypeScript, Go, Java, C#, and Python type annotations.
pub fn extract_var_types(text: &str, ext: &str, cursor_line: usize) -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return map;
    }
    let end = cursor_line.min(lines.len() - 1);
    let ext_lower = ext.to_ascii_lowercase();
    let colon_typed = matches!(ext_lower.as_str(), "rs" | "ts" | "tsx" | "py");

    // Scan lines up to cursor_line (capped to a generous 400-line window so huge files stay instant).
    let start = end.saturating_sub(400);
    for &line in &lines[start..=end] {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with("//")
            || trimmed.starts_with("/*")
            || trimmed.starts_with('*')
            || trimmed.starts_with('#')
        {
            continue;
        }
        // Track enclosing `impl TypeName` / `class TypeName` / `struct TypeName` for `self`/`this`.
        if let Some(rest) = trimmed.strip_prefix("impl ") {
            let clean = rest.split(['{', '<', ' ']).find(|p| is_candidate_type(p));
            if let Some(ty) = clean {
                map.insert("self".to_owned(), ty.to_owned());
                map.insert("Self".to_owned(), ty.to_owned());
            }
        } else if let Some(rest) = trimmed
            .strip_prefix("class ")
            .or_else(|| trimmed.strip_prefix("export class "))
            .or_else(|| trimmed.strip_prefix("public class "))
        {
            if let Some(ty) = rest.split(['{', ':', '<', ' ']).find(|p| is_candidate_type(p)) {
                map.insert("this".to_owned(), ty.to_owned());
                map.insert("self".to_owned(), ty.to_owned());
            }
        }

        // Go receiver: `func (r *MyType) Method(...)`
        if ext_lower == "go" {
            if let Some(rest) = trimmed.strip_prefix("func (") {
                if let Some(close) = rest.find(')') {
                    let parts: Vec<&str> = rest[..close].split_whitespace().collect();
                    if parts.len() == 2 {
                        if let Some(ty) = normalize_type_name(parts[1]) {
                            map.insert(parts[0].to_owned(), ty);
                        }
                    }
                }
            }
            // Go short composite literal: `x := &MyStruct{` or `x := MyStruct{`
            if let Some((lhs, rhs)) = trimmed.split_once(":=") {
                let var = lhs.trim();
                let rhs = rhs.trim().trim_start_matches('&');
                if let Some(brace) = rhs.find('{') {
                    if let Some(ty) = normalize_type_name(&rhs[..brace]) {
                        if is_candidate_type(var) {
                            map.insert(var.to_owned(), ty);
                        }
                    }
                }
            }
        }

        // Colon-typed declarations (`let x: Foo`, `param: &mut Bar`, `x: Baz = ...`).
        if colon_typed {
            parse_colon_bindings(trimmed, &mut map);
        }

        // Type-first declarations (C/C++/Java/C#): `Foo *ptr = ...;` or `(const Bar& b, Baz c)`.
        parse_type_first_bindings(trimmed, &mut map);
    }
    map
}

fn parse_colon_bindings(line: &str, out: &mut HashMap<String, String>) {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b':' && bytes.get(i + 1) != Some(&b':') && i > 0 && bytes[i - 1] != b':' {
            // Identifier immediately before `:`
            let mut left = i;
            while left > 0 && bytes[left - 1].is_ascii_whitespace() {
                left -= 1;
            }
            let end_id = left;
            while left > 0 && (bytes[left - 1].is_ascii_alphanumeric() || bytes[left - 1] == b'_') {
                left -= 1;
            }
            let var = &line[left..end_id];
            if is_candidate_type(var) {
                let rhs = &line[i + 1..];
                let end_ty = rhs
                    .find(['=', ',', ')', ';', '{'])
                    .unwrap_or(rhs.len());
                if let Some(ty) = normalize_type_name(&rhs[..end_ty]) {
                    out.insert(var.to_owned(), ty);
                }
            }
        }
        i += 1;
    }
}

fn parse_type_first_bindings(line: &str, out: &mut HashMap<String, String>) {
    // Also inspect parameter lists inside `(...)`.
    let mut segments: Vec<&str> = Vec::new();
    if let (Some(open), Some(close)) = (line.find('('), line.rfind(')')) {
        if close > open {
            for param in line[open + 1..close].split(',') {
                segments.push(param.trim());
            }
        }
    }
    // Strip trailing `= ...` initializer for statement-level declarations.
    let head = line.split('=').next().unwrap_or(line).trim_end_matches(';').trim();
    if !head.contains('(') {
        segments.push(head);
    }

    for seg in segments {
        let seg = seg.trim();
        if seg.is_empty() {
            continue;
        }
        // Tokenize by whitespace while keeping `*` / `&` attached cleanly.
        let tokens: Vec<&str> = seg.split_whitespace().collect();
        if tokens.len() < 2 {
            continue;
        }
        let raw_var = tokens[tokens.len() - 1]
            .trim_start_matches(['*', '&'])
            .trim_end_matches(['[', ']', ';', ',']);
        if raw_var.is_empty()
            || !raw_var.chars().all(is_ident_char)
            || NON_TYPE_KEYWORDS.contains(&raw_var)
        {
            continue;
        }
        let type_part = tokens[..tokens.len() - 1].join(" ");
        if let Some(ty) = normalize_type_name(&type_part) {
            if ty != raw_var {
                out.insert(raw_var.to_owned(), ty);
            }
        }
    }
}

/// Inspect `line_text` at 0-based character column `col` to see if the cursor sits on or
/// right after a member-access chain (`a->b.c`, `ptr->`, `Foo::bar`).
/// Returns `(receiver_chain, member_prefix)`.
pub fn member_access_at(line_text: &str, col_0based: usize) -> Option<(Vec<String>, String)> {
    let chars: Vec<char> = line_text.chars().collect();
    let mut pos = col_0based.min(chars.len());
    // Expand right if cursor is inside the member identifier.
    let mut member_end = pos;
    while member_end < chars.len() && is_ident_char(chars[member_end]) {
        member_end += 1;
    }
    let mut member_start = pos;
    while member_start > 0 && is_ident_char(chars[member_start - 1]) {
        member_start -= 1;
    }
    let member_prefix: String = chars[member_start..member_end].iter().collect();
    pos = member_start;

    // Walk backwards collecting `.` / `->` / `::` separated receiver identifiers.
    let mut chain_rev: Vec<String> = Vec::new();
    loop {
        while pos > 0 && chars[pos - 1].is_whitespace() {
            pos -= 1;
        }
        let has_op = if pos >= 2
            && ((chars[pos - 2] == '-' && chars[pos - 1] == '>')
                || (chars[pos - 2] == ':' && chars[pos - 1] == ':'))
        {
            pos -= 2;
            true
        } else if pos >= 1 && chars[pos - 1] == '.' {
            pos -= 1;
            true
        } else {
            false
        };
        if !has_op {
            break;
        }
        while pos > 0 && chars[pos - 1].is_whitespace() {
            pos -= 1;
        }
        // Skip optional balanced `(...)` or `[...]` (e.g. `get_ctx()->field` or `arr[i].field`).
        while pos > 0 && matches!(chars[pos - 1], ')' | ']') {
            let close = chars[pos - 1];
            let open = if close == ')' { '(' } else { '[' };
            let mut depth = 1usize;
            pos -= 1;
            while pos > 0 && depth > 0 {
                pos -= 1;
                if chars[pos] == close {
                    depth += 1;
                } else if chars[pos] == open {
                    depth -= 1;
                }
            }
            while pos > 0 && chars[pos - 1].is_whitespace() {
                pos -= 1;
            }
        }
        let end_id = pos;
        while pos > 0 && is_ident_char(chars[pos - 1]) {
            pos -= 1;
        }
        if pos == end_id {
            break;
        }
        let ident: String = chars[pos..end_id].iter().collect();
        chain_rev.push(ident);
    }
    if chain_rev.is_empty() {
        return None;
    }
    chain_rev.reverse();
    Some((chain_rev, member_prefix))
}

/// Collect `root_type` plus all transitive base types in BFS order (`(type_name, inherited)`).
fn type_hierarchy(store: &SymbolStore, root_type: &str) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    let mut visited = HashSet::new();
    let mut queue = VecDeque::new();
    visited.insert(root_type.to_owned());
    queue.push_back((root_type.to_owned(), false));
    while let Some((ty, inherited)) = queue.pop_front() {
        let bases = store.bases_of(&ty);
        out.push((ty, inherited));
        for base in bases {
            if visited.insert(base.clone()) {
                queue.push_back((base, true));
            }
        }
    }
    out
}

/// Infer the declared type of a field/method `member` inside `container` by reading its
/// declaration line from disk.
fn member_declared_type(store: &SymbolStore, container: &str, member: &str) -> Option<String> {
    for (ty, _) in type_hierarchy(store, container) {
        for (path, row) in store.members_of(&ty, 128, None) {
            if row.name != member {
                continue;
            }
            let abs = Path::new(store.root()).join(&path);
            let Some((bytes, _)) = read_searchable(&abs) else {
                continue;
            };
            let text = String::from_utf8_lossy(&bytes);
            let Some(line) = text.lines().nth(row.line) else {
                continue;
            };
            let mut bindings = HashMap::new();
            parse_colon_bindings(line, &mut bindings);
            parse_type_first_bindings(line, &mut bindings);
            if let Some(found) = bindings.get(member) {
                return Some(found.clone());
            }
        }
    }
    None
}

/// Resolve a receiver chain (`["ptr", "inner"]`) at `cursor_line` to the final container
/// type name in `store`.
pub fn resolve_chain_type(
    store: &SymbolStore,
    text: &str,
    ext: &str,
    cursor_line: usize,
    chain: &[String],
) -> Option<String> {
    let first = chain.first()?;
    let bindings = extract_var_types(text, ext, cursor_line);
    // Direct type/namespace name (`MyClass::method`) or bound variable (`ptr->method`).
    let mut current = if let Some(ty) = bindings.get(first) {
        ty.clone()
    } else if !store.members_of(first, 1, None).is_empty() {
        first.clone()
    } else {
        // Fallback: check if `first` is a global variable or function in the store whose
        // declaration line carries a type.
        let defs = store.lookup(first);
        let mut inferred = None;
        for def in defs {
            let abs = Path::new(store.root()).join(&def.path);
            if let Some((bytes, _)) = read_searchable(&abs) {
                let file_text = String::from_utf8_lossy(&bytes);
                if let Some(line) = file_text.lines().nth(def.line) {
                    let mut b = HashMap::new();
                    parse_colon_bindings(line, &mut b);
                    parse_type_first_bindings(line, &mut b);
                    if let Some(ty) = b.get(first) {
                        inferred = Some(ty.clone());
                        break;
                    }
                }
            }
        }
        inferred?
    };

    for segment in &chain[1..] {
        current = member_declared_type(store, &current, segment)?;
    }
    Some(current)
}

/// Receiver-disambiguated Go-to-Definition for `name` at `(cursor_line, col_0based)`.
/// Returns empty when `name` is not a member access or its receiver type cannot be
/// resolved, allowing callers to fall back to `store.lookup(name)`.
pub fn resolve_member_symbol(
    store: &SymbolStore,
    text: &str,
    ext: &str,
    cursor_line: usize,
    col_0based: usize,
    name: &str,
) -> Vec<WorkspaceSymbol> {
    let Some(line_text) = text.lines().nth(cursor_line) else {
        return Vec::new();
    };
    let Some((chain, _)) = member_access_at(line_text, col_0based) else {
        return Vec::new();
    };
    let Some(container) = resolve_chain_type(store, text, ext, cursor_line, &chain) else {
        return Vec::new();
    };
    let mut hits = Vec::new();
    for (ty, _) in type_hierarchy(store, &container) {
        for (path, row) in store.members_of(&ty, 256, None) {
            if row.name == name {
                hits.push(WorkspaceSymbol {
                    kind: row.kind.to_owned(),
                    name: row.name,
                    path,
                    line: row.line,
                    column: 0,
                    end_line: row.end_line,
                    container: row.container,
                });
            }
        }
        if !hits.is_empty() {
            break;
        }
    }
    hits
}

/// Member auto-completion candidates after `.` / `->` / `::` at `(cursor_line, col_0based)`.
pub fn member_completions(
    store: &SymbolStore,
    text: &str,
    ext: &str,
    cursor_line: usize,
    col_0based: usize,
    limit: usize,
) -> Vec<MemberCompletion> {
    if limit == 0 {
        return Vec::new();
    }
    let Some(line_text) = text.lines().nth(cursor_line) else {
        return Vec::new();
    };
    let Some((chain, prefix)) = member_access_at(line_text, col_0based) else {
        return Vec::new();
    };
    let Some(container) = resolve_chain_type(store, text, ext, cursor_line, &chain) else {
        return Vec::new();
    };
    let prefix_lower = prefix.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for (ty, inherited) in type_hierarchy(store, &container) {
        for (path, row) in store.members_of(&ty, limit.saturating_mul(2).max(64), None) {
            if !prefix_lower.is_empty() && !row.name.to_ascii_lowercase().starts_with(&prefix_lower)
            {
                continue;
            }
            if !seen.insert(row.name.clone()) {
                continue;
            }
            out.push(MemberCompletion {
                name: row.name,
                kind: row.kind.to_owned(),
                container: row.container.unwrap_or_else(|| ty.clone()),
                path,
                line: row.line,
                inherited,
            });
            if out.len() >= limit {
                return out;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn resolves_pointer_member_and_inherited_completions() {
        let dir = tempfile::tempdir().unwrap();
        let cpp = r#"class Base {
public:
    void reset() {}
};
class Motor : public Base {
public:
    int speed;
    void init() {}
};
class Sensor {
public:
    void init() {}
};
void drive(Motor *m, Sensor *s) {
    m->init();
    m->res
}
"#;
        fs::write(dir.path().join("motor.cpp"), cpp).unwrap();
        let root = dir.path().display().to_string();
        let store = SymbolStore::build(&root, 2, &|_, _| {}, &|| false).unwrap();

        // `m->init()` disambiguates to Motor::init (not Sensor::init).
        let hits = resolve_member_symbol(&store, cpp, "cpp", 14, 7, "init");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].container.as_deref(), Some("Motor"));

        // `m->res` completes inherited Base::reset.
        let comps = member_completions(&store, cpp, "cpp", 15, 10, 20);
        assert!(comps.iter().any(|c| c.name == "reset" && c.inherited));
    }

    #[test]
    fn empty_text_and_stacked_qualifiers_never_fail() {
        assert!(extract_var_types("", "cpp", 0).is_empty());
        assert_eq!(normalize_type_name("static const struct Foo *"), Some("Foo".to_owned()));
        assert_eq!(normalize_type_name("extern volatile const Bar&"), Some("Bar".to_owned()));
    }
}
