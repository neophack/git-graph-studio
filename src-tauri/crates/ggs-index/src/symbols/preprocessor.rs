//! C/C++ conditional compilation evaluator, macro expansion preview, and read-only
//! Base/SDK project registry (Area 4).
//!
//! - **Conditional Parsing**: per-project macro definitions stored in
//!   `<root>/.ggs/conditions.json` evaluate `#ifdef` / `#ifndef` / `#if` / `#elif` /
//!   `#else` / `#endif` blocks and report 0-based inactive line ranges so the editor
//!   can dim dead branches like Source Insight.
//! - **Macro Expansion Preview**: extracts `#define` bodies (including `\` multi-line
//!   continuations) and performs parameter substitution for function-like macros at a
//!   call site.
//! - **Base / SDK Projects**: per-project read-only external roots persisted in
//!   `<root>/.ggs/base-projects.json` for cross-library symbol fallback without
//!   polluting the primary workspace index.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::scan::read_searchable;
use crate::symbols::store::{SymbolStore, PROJECT_ANALYSIS_DIR};

/// One 0-based inclusive range of lines inside an inactive preprocessor branch.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InactiveRange {
    pub start_line: usize,
    pub end_line: usize,
}

/// Persisted per-project conditional compilation settings (`<root>/.ggs/conditions.json`).
/// Value `Some(n)` means `#define NAME n`; `None` means explicitly `#undef NAME`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConditionsConfig {
    pub macros: HashMap<String, Option<i64>>,
}

/// Macro expansion preview payload for a symbol or call site.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MacroExpansion {
    pub name: String,
    pub params: Vec<String>,
    pub definition: String,
    pub expanded: String,
    pub path: String,
    /// 0-based declaration line.
    pub line: usize,
}

fn conditions_path(root: &str) -> PathBuf {
    Path::new(root).join(PROJECT_ANALYSIS_DIR).join("conditions.json")
}

fn base_projects_path(root: &str) -> PathBuf {
    Path::new(root).join(PROJECT_ANALYSIS_DIR).join("base-projects.json")
}

pub fn load_conditions(root: &str) -> ConditionsConfig {
    fs::read_to_string(conditions_path(root))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_conditions(root: &str, config: &ConditionsConfig) -> Result<(), String> {
    let path = conditions_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    ggs_base::fsx::atomic_write(&path, json.as_bytes())
}

pub fn load_base_projects(root: &str) -> Vec<String> {
    fs::read_to_string(base_projects_path(root))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_base_projects(root: &str, roots: &[String]) -> Result<(), String> {
    let path = base_projects_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(roots).map_err(|e| e.to_string())?;
    ggs_base::fsx::atomic_write(&path, json.as_bytes())
}

/* ---------- Conditional compilation evaluator ---------- */

#[derive(Clone, Copy)]
struct BranchFrame {
    parent_active: bool,
    any_taken: bool,
    currently_active: bool,
}

/// Evaluate a C/C++ `#if` / `#elif` constant expression against `macros`.
/// Returns `Some(true)` / `Some(false)` when all referenced symbols are known (or a
/// literal `0`/`1` is present), and `None` when an unknown macro leaves the branch
/// indeterminate (indeterminate branches stay active so we never wrongly dim live code).
fn eval_expr(expr: &str, macros: &HashMap<String, Option<i64>>) -> Option<bool> {
    let s = strip_line_comment(expr).trim();
    if s.is_empty() {
        return None;
    }
    // Logical OR
    if let Some((lhs, rhs)) = split_top_level(s, "||") {
        let a = eval_expr(lhs, macros);
        let b = eval_expr(rhs, macros);
        return match (a, b) {
            (Some(true), _) | (_, Some(true)) => Some(true),
            (Some(false), Some(false)) => Some(false),
            _ => None,
        };
    }
    // Logical AND
    if let Some((lhs, rhs)) = split_top_level(s, "&&") {
        let a = eval_expr(lhs, macros);
        let b = eval_expr(rhs, macros);
        return match (a, b) {
            (Some(false), _) | (_, Some(false)) => Some(false),
            (Some(true), Some(true)) => Some(true),
            _ => None,
        };
    }
    // Outer parentheses
    if s.starts_with('(') && s.ends_with(')') && is_wrapped_parens(s) {
        return eval_expr(&s[1..s.len() - 1], macros);
    }
    // Unary logical NOT
    if let Some(rest) = s.strip_prefix('!') {
        if !rest.starts_with('=') {
            return eval_expr(rest, macros).map(|v| !v);
        }
    }
    // `defined(NAME)` or `defined NAME`
    if let Some(rest) = s
        .strip_prefix("defined")
        .filter(|r| r.starts_with(|c: char| c.is_whitespace() || c == '('))
    {
        let rest = rest.trim();
        let name = if let Some(inner) = rest.strip_prefix('(').and_then(|r| r.strip_suffix(')')) {
            inner.trim()
        } else {
            rest
        };
        if let Some(entry) = macros.get(name) {
            return Some(entry.is_some());
        }
        return None;
    }
    // Comparisons: `==`, `!=`, `>=`, `<=`, `>`, `<`
    for op in ["==", "!=", ">=", "<=", ">", "<"] {
        if let Some((lhs, rhs)) = split_top_level(s, op) {
            let lv = eval_int(lhs.trim(), macros)?;
            let rv = eval_int(rhs.trim(), macros)?;
            return Some(match op {
                "==" => lv == rv,
                "!=" => lv != rv,
                ">=" => lv >= rv,
                "<=" => lv <= rv,
                ">" => lv > rv,
                "<" => lv < rv,
                _ => false,
            });
        }
    }
    eval_int(s, macros).map(|v| v != 0)
}

fn eval_int(tok: &str, macros: &HashMap<String, Option<i64>>) -> Option<i64> {
    let tok = tok.trim();
    if let Some(hex) = tok.strip_prefix("0x").or_else(|| tok.strip_prefix("0X")) {
        return i64::from_str_radix(hex.trim_end_matches(['u', 'U', 'l', 'L']), 16).ok();
    }
    if let Ok(n) = tok.trim_end_matches(['u', 'U', 'l', 'L']).parse::<i64>() {
        return Some(n);
    }
    match macros.get(tok)? {
        Some(v) => Some(*v),
        None => Some(0),
    }
}

fn strip_line_comment(s: &str) -> &str {
    let s = s.split("//").next().unwrap_or(s);
    s.split("/*").next().unwrap_or(s)
}

fn is_wrapped_parens(s: &str) -> bool {
    let mut depth = 0i32;
    for (i, c) in s.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 && i + 1 < s.len() {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

fn split_top_level<'a>(s: &'a str, op: &str) -> Option<(&'a str, &'a str)> {
    let bytes = s.as_bytes();
    let op_bytes = op.as_bytes();
    let mut depth = 0i32;
    let mut i = 0;
    while i + op_bytes.len() <= bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            _ if depth == 0 && &bytes[i..i + op_bytes.len()] == op_bytes => {
                // Guard `<` / `>` against `<=` / `>=` / `<<` / `>>`.
                if op.len() == 1
                    && (bytes.get(i + 1) == Some(&b'=')
                        || bytes.get(i + 1) == Some(&op_bytes[0])
                        || (i > 0 && bytes[i - 1] == op_bytes[0]))
                {
                    i += 1;
                    continue;
                }
                return Some((&s[..i], &s[i + op_bytes.len()..]));
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Compute 0-based inclusive inactive line ranges for `text` under `macros` (plus
/// in-file `#define` / `#undef` overrides encountered along active branches).
pub fn eval_inactive_ranges(
    text: &str,
    project_macros: &HashMap<String, Option<i64>>,
) -> Vec<InactiveRange> {
    let mut macros = project_macros.clone();
    let mut stack: Vec<BranchFrame> = Vec::new();
    let mut ranges: Vec<InactiveRange> = Vec::new();
    let mut cur_inactive_start: Option<usize> = None;

    for (line_no, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        let active_now = stack.last().is_none_or(|f| f.currently_active);

        if let Some(after_hash) = trimmed.strip_prefix('#') {
            let rest = after_hash.trim_start();
            let (kw, arg) = match rest.find(|c: char| c.is_whitespace() || c == '(') {
                Some(at) => (&rest[..at], rest[at..].trim()),
                None => (rest, ""),
            };
            match kw {
                "ifdef" => {
                    let name = strip_line_comment(arg).split_whitespace().next().unwrap_or("");
                    let cond = macros.get(name).map(|v| v.is_some());
                    let take = active_now && cond.unwrap_or(true);
                    stack.push(BranchFrame {
                        parent_active: active_now,
                        any_taken: active_now && cond == Some(true),
                        currently_active: take,
                    });
                }
                "ifndef" => {
                    let name = strip_line_comment(arg).split_whitespace().next().unwrap_or("");
                    let cond = macros.get(name).map(|v| v.is_none());
                    let take = active_now && cond.unwrap_or(true);
                    stack.push(BranchFrame {
                        parent_active: active_now,
                        any_taken: active_now && cond == Some(true),
                        currently_active: take,
                    });
                }
                "if" => {
                    let cond = eval_expr(arg, &macros);
                    let take = active_now && cond.unwrap_or(true);
                    stack.push(BranchFrame {
                        parent_active: active_now,
                        any_taken: active_now && cond == Some(true),
                        currently_active: take,
                    });
                }
                "elif" => {
                    if let Some(frame) = stack.last_mut() {
                        if !frame.parent_active || frame.any_taken {
                            frame.currently_active = false;
                        } else {
                            let cond = eval_expr(arg, &macros);
                            frame.currently_active = cond.unwrap_or(true);
                            if cond == Some(true) {
                                frame.any_taken = true;
                            }
                        }
                    }
                }
                "else" => {
                    if let Some(frame) = stack.last_mut() {
                        frame.currently_active = frame.parent_active && !frame.any_taken;
                        frame.any_taken = true;
                    }
                }
                "endif" => {
                    stack.pop();
                }
                "define" if active_now => {
                    let parts: Vec<&str> = strip_line_comment(arg).split_whitespace().collect();
                    if let Some(&name) = parts.first() {
                        if !name.contains('(') {
                            let val = parts.get(1).and_then(|v| v.parse::<i64>().ok()).unwrap_or(1);
                            macros.insert(name.to_owned(), Some(val));
                        }
                    }
                }
                "undef" if active_now => {
                    if let Some(name) = strip_line_comment(arg).split_whitespace().next() {
                        macros.insert(name.to_owned(), None);
                    }
                }
                _ => {}
            }
            // Directive lines themselves are not dimmed; close any open inactive run.
            if let Some(start) = cur_inactive_start.take() {
                ranges.push(InactiveRange {
                    start_line: start,
                    end_line: line_no.saturating_sub(1),
                });
            }
            continue;
        }

        if !active_now {
            cur_inactive_start.get_or_insert(line_no);
        } else if let Some(start) = cur_inactive_start.take() {
            ranges.push(InactiveRange {
                start_line: start,
                end_line: line_no.saturating_sub(1),
            });
        }
    }

    if let Some(start) = cur_inactive_start {
        let total = text.lines().count();
        if total > 0 {
            ranges.push(InactiveRange {
                start_line: start,
                end_line: total - 1,
            });
        }
    }
    ranges
}

/* ---------- Macro expansion preview ---------- */

/// Extract a `#define` definition (joining `\` continuations) from `store` and, when
/// `call_line` contains a function-like invocation `NAME(arg1, arg2)`, substitute the
/// actual arguments into the macro body.
pub fn expand_macro_at(
    store: &SymbolStore,
    name: &str,
    call_line: Option<&str>,
) -> Option<MacroExpansion> {
    let def = store
        .lookup(name)
        .into_iter()
        .find(|s| s.kind == "macro")?;
    let abs = Path::new(store.root()).join(&def.path);
    let (bytes, _) = read_searchable(&abs)?;
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().collect();
    let mut joined = String::new();
    let mut idx = def.line;
    while idx < lines.len() {
        let raw = lines[idx].trim_end_matches('\r');
        if let Some(stripped) = raw.strip_suffix('\\') {
            joined.push_str(stripped);
            joined.push(' ');
            idx += 1;
        } else {
            joined.push_str(raw);
            break;
        }
    }
    let after_define = joined
        .trim_start()
        .strip_prefix('#')?
        .trim_start()
        .strip_prefix("define")?
        .trim_start();
    let rest = after_define.strip_prefix(name)?;

    let (params, body) = if let Some(after_paren) = rest.strip_prefix('(') {
        let close = after_paren.find(')')?;
        let params: Vec<String> = after_paren[..close]
            .split(',')
            .map(|p| p.trim().to_owned())
            .filter(|p| !p.is_empty())
            .collect();
        let body = after_paren[close + 1..].trim().to_owned();
        (params, body)
    } else {
        (Vec::new(), rest.trim().to_owned())
    };

    let expanded = if !params.is_empty() {
        if let Some(args) = call_line.and_then(|l| extract_call_args(l, name)) {
            substitute_macro_params(&body, &params, &args)
        } else {
            body.clone()
        }
    } else {
        body.clone()
    };

    Some(MacroExpansion {
        name: name.to_owned(),
        params,
        definition: joined.trim().to_owned(),
        expanded,
        path: def.path,
        line: def.line,
    })
}

fn extract_call_args(line: &str, name: &str) -> Option<Vec<String>> {
    let at = line.find(name)?;
    let after = line[at + name.len()..].trim_start();
    let inner = after.strip_prefix('(')?;
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut depth = 1usize;
    for c in inner.chars() {
        match c {
            '(' => {
                depth += 1;
                cur.push(c);
            }
            ')' => {
                depth -= 1;
                if depth == 0 {
                    if !cur.trim().is_empty() || !args.is_empty() {
                        args.push(cur.trim().to_owned());
                    }
                    return Some(args);
                }
                cur.push(c);
            }
            ',' if depth == 1 => {
                args.push(cur.trim().to_owned());
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    None
}

fn substitute_macro_params(body: &str, params: &[String], args: &[String]) -> String {
    let map: HashMap<&str, &str> = params
        .iter()
        .zip(args.iter())
        .map(|(p, a)| (p.as_str(), a.as_str()))
        .collect();
    let mut out = String::with_capacity(body.len());
    let chars: Vec<char> = body.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_alphabetic() || chars[i] == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let tok: String = chars[start..i].iter().collect();
            if let Some(rep) = map.get(tok.as_str()) {
                out.push_str(rep);
            } else {
                out.push_str(&tok);
            }
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluates_inactive_preprocessor_branches() {
        let src = "\
#ifdef FEATURE_A
int a = 1;
#elif FEATURE_B == 2
int b = 2;
#else
int c = 3;
#endif
#if 0
int dead = 4;
#endif
";
        let mut macros = HashMap::new();
        macros.insert("FEATURE_A".to_owned(), None);
        macros.insert("FEATURE_B".to_owned(), Some(2));
        let ranges = eval_inactive_ranges(src, &macros);
        assert_eq!(
            ranges,
            vec![
                InactiveRange { start_line: 1, end_line: 1 },
                InactiveRange { start_line: 5, end_line: 5 },
                InactiveRange { start_line: 8, end_line: 8 },
            ]
        );
    }

    #[test]
    fn expands_function_like_macro_with_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let src = "#define CLAMP(v, lo, hi) \\\n    ((v) < (lo) ? (lo) : ((v) > (hi) ? (hi) : (v)))\n";
        fs::write(dir.path().join("math.h"), src).unwrap();
        let root = dir.path().display().to_string();
        let store = SymbolStore::build(&root, 2, &|_, _| {}, &|| false).unwrap();
        let exp = expand_macro_at(&store, "CLAMP", Some("int x = CLAMP(speed, 0, 100);")).unwrap();
        assert_eq!(exp.params, vec!["v", "lo", "hi"]);
        assert_eq!(exp.expanded, "((speed) < (0) ? (0) : ((speed) > (100) ? (100) : (speed)))");
    }

    #[test]
    fn indeterminate_ifdef_never_dims_else_and_defined_requires_boundary() {
        let src = "\
#ifdef UNKNOWN_FLAG
int a = 1;
#else
int b = 2;
#endif
#if defined_flag
int c = 3;
#endif
";
        let mut macros = HashMap::new();
        macros.insert("defined_flag".to_owned(), Some(0));
        let ranges = eval_inactive_ranges(src, &macros);
        // UNKNOWN_FLAG is indeterminate: neither branch dims. `defined_flag == 0` dims line 6.
        assert_eq!(ranges, vec![InactiveRange { start_line: 6, end_line: 6 }]);
    }
}
