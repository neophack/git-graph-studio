//! Word expansion — the step where a parsed word becomes fields. The order is bash's:
//! tilde, then the `$` forms (parameters, command substitution, arithmetic), then field
//! splitting on unquoted IFS whitespace, then pathname globbing of fields whose glob
//! characters were unquoted, and quote removal throughout. Which parts of a word were
//! quoted decides all of it, which is why the AST keeps the quoting structure.

use std::sync::{Arc, Mutex};

use super::ast::{DPart, ParamOp, Part, Word};
use super::exec::{ExecError, Io, Shell};
use super::lex;

/// One expanded run of text. `quoted` text neither splits nor globs; `boundary` closes
/// the current field after the fragment (the `"$@"` splice); `split` marks an unquoted
/// expansion result — the only text IFS field-splits (literals never split).
#[derive(Debug, Clone)]
struct Frag {
    text: String,
    quoted: bool,
    boundary: bool,
    split: bool,
}

/// Expand command words: fields, split and globbed.
pub fn expand_words(shell: &mut Shell, words: &[Word], io: &Io) -> Result<Vec<String>, ExecError> {
    let mut fields = Vec::new();
    for word in words {
        for variant in brace_expand(word) {
            fields.extend(expand_one_word(shell, &variant, io)?);
        }
    }
    Ok(fields)
}

/* ---------- Brace expansion ---------- */

/// One position of a word while braces are resolved: an unquoted character (the only
/// place a brace is syntax) or a whole opaque part (quoted text, `$x`, `$(…)`).
#[derive(Clone)]
enum Item {
    Ch(char),
    Opaque(Part),
}

fn items_of(word: &Word) -> Vec<Item> {
    let mut items = Vec::new();
    for part in &word.0 {
        match part {
            Part::Lit(text) => items.extend(text.chars().map(Item::Ch)),
            other => items.push(Item::Opaque(other.clone())),
        }
    }
    items
}

fn word_of(items: &[Item]) -> Word {
    let mut parts: Vec<Part> = Vec::new();
    let mut run = String::new();
    for item in items {
        match item {
            Item::Ch(c) => run.push(*c),
            Item::Opaque(part) => {
                if !run.is_empty() {
                    parts.push(Part::Lit(std::mem::take(&mut run)));
                }
                parts.push(part.clone());
            }
        }
    }
    if !run.is_empty() {
        parts.push(Part::Lit(run));
    }
    Word(parts)
}

/// Bash's brace expansion: `{a,b}` alternatives (nestable), `{1..5}` / `{a..e}` /
/// `{01..10}` / `{1..10..2}` sequences, with prefix and suffix text carried along.
/// A brace group with no top-level comma and no sequence (`{}`, `{a}`) stays literal.
pub fn brace_expand(word: &Word) -> Vec<Word> {
    let has_brace = word
        .0
        .iter()
        .any(|part| matches!(part, Part::Lit(text) if text.contains('{')));
    if !has_brace {
        return vec![word.clone()];
    }
    let mut out = Vec::new();
    expand_items(&items_of(word), &mut out);
    out
}

fn expand_items(items: &[Item], out: &mut Vec<Word>) {
    let mut search_from = 0;
    while let Some(open) = (search_from..items.len()).find(|&i| matches!(items[i], Item::Ch('{'))) {
        // The matching close, tracking nesting; commas count at depth one only.
        let mut depth = 0;
        let mut close = None;
        let mut commas: Vec<usize> = Vec::new();
        for (i, item) in items.iter().enumerate().skip(open) {
            match item {
                Item::Ch('{') => depth += 1,
                Item::Ch('}') => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(i);
                        break;
                    }
                }
                Item::Ch(',') if depth == 1 => commas.push(i),
                _ => {}
            }
        }
        let Some(close) = close else {
            return finish(items, out);
        };
        let prefix = &items[..open];
        let suffix = &items[close + 1..];
        let body = &items[open + 1..close];
        let alternatives: Vec<Vec<Item>> = if !commas.is_empty() {
            let mut pieces = Vec::new();
            let mut from = open + 1;
            for &comma in &commas {
                pieces.push(items[from..comma].to_vec());
                from = comma + 1;
            }
            pieces.push(items[from..close].to_vec());
            pieces
        } else if let Some(sequence) = sequence_of(body) {
            sequence
                .into_iter()
                .map(|text| text.chars().map(Item::Ch).collect())
                .collect()
        } else {
            search_from = open + 1;
            continue;
        };
        for alternative in alternatives {
            let mut joined = prefix.to_vec();
            joined.extend(alternative);
            joined.extend_from_slice(suffix);
            expand_items(&joined, out);
        }
        return;
    }
    finish(items, out);
}

fn finish(items: &[Item], out: &mut Vec<Word>) {
    out.push(word_of(items));
}

fn sequence_of(body: &[Item]) -> Option<Vec<String>> {
    let text: String = body
        .iter()
        .map(|item| match item {
            Item::Ch(c) => Some(*c),
            Item::Opaque(_) => None,
        })
        .collect::<Option<String>>()?;
    let pieces: Vec<&str> = text.split("..").collect();
    if pieces.len() < 2 || pieces.len() > 3 {
        return None;
    }
    let step = match pieces.get(2) {
        Some(raw) => raw.parse::<i64>().ok().filter(|n| *n != 0)?.abs(),
        None => 1,
    };
    if let (Ok(from), Ok(to)) = (pieces[0].parse::<i64>(), pieces[1].parse::<i64>()) {
        // Zero padding: `01..10` pads to the wider endpoint.
        let padded = |raw: &str| {
            let digits = raw.trim_start_matches('-');
            digits.len() > 1 && digits.starts_with('0')
        };
        let width = if padded(pieces[0]) || padded(pieces[1]) {
            pieces[0].len().max(pieces[1].len())
        } else {
            0
        };
        let mut values = Vec::new();
        let mut at = from;
        while values.len() < 100_000 {
            values.push(format!("{at:0width$}"));
            if at == to {
                break;
            }
            at = if from < to {
                if at + step > to {
                    break;
                }
                at + step
            } else {
                if at - step < to {
                    break;
                }
                at - step
            };
        }
        return Some(values);
    }
    let single = |raw: &str| {
        let mut chars = raw.chars();
        match (chars.next(), chars.next()) {
            (Some(c), None) if c.is_ascii_alphabetic() => Some(c as u32),
            _ => None,
        }
    };
    let (from, to) = (single(pieces[0])?, single(pieces[1])?);
    let mut values = Vec::new();
    let mut at = from as i64;
    loop {
        values.push(char::from_u32(at as u32)?.to_string());
        if at == to as i64 {
            break;
        }
        at = if from < to {
            if at + step > to as i64 {
                break;
            }
            at + step
        } else {
            if at - step < to as i64 {
                break;
            }
            at - step
        };
    }
    Some(values)
}

/// Expand one word to one unsplit string — assignments, `case` subjects, redirect
/// targets, `[[ ]]` words, herestrings.
pub fn expand_single(shell: &mut Shell, word: &Word, io: &Io) -> Result<String, ExecError> {
    let mut text = String::new();
    for frag in fragments(shell, word, io)? {
        text.push_str(&frag.text);
    }
    Ok(text)
}

/// Assignment values: expanded like a word but never split or globbed (`x=*` keeps the
/// star). [`expand_single`] is exactly that.
pub fn expand_assignment(shell: &mut Shell, word: &Word, io: &Io) -> Result<String, ExecError> {
    expand_single(shell, word, io)
}

/// A pattern (`case` arms): expansion without globbing the result back at the
/// filesystem — the pattern characters must survive.
pub fn expand_pattern(shell: &mut Shell, word: &Word, io: &Io) -> Result<String, ExecError> {
    expand_single(shell, word, io)
}

/// A heredoc body with expansion on: double-quote semantics over the whole text.
pub fn expand_heredoc(shell: &mut Shell, text: &str, io: &Io) -> Result<String, ExecError> {
    let parts = dquote_parts(text).map_err(ExecError::Io)?;
    let mut out = String::new();
    for part in parts {
        match part {
            DPart::Lit(literal) => out.push_str(&literal),
            DPart::Var { name, op, word } => {
                out.push_str(&param_value(shell, &name, op, word.as_ref(), io, true)?)
            }
            DPart::CmdSub(script) => out.push_str(&command_substitution(shell, &script, io)?),
            DPart::ProcSub(script, out_form) => {
                out.push_str(&process_substitution(shell, &script, out_form, io)?)
            }
            DPart::Arith(text) => out.push_str(&eval_arith(shell, &text, io)?.to_string()),
        }
    }
    Ok(out)
}

/// Alias splicing: the alias text must lex to plain words (no operators); they replace
/// the command word, keeping the arguments. `None` means "not that simple" and the
/// command runs unexpanded.
pub fn expand_alias(
    shell: &mut Shell,
    value: &str,
    rest: &[String],
    _io: &Io,
) -> Result<Option<Vec<String>>, ExecError> {
    let out = lex::lex(value).map_err(|e| ExecError::Io(format!("alias {value:?}: {e:?}")))?;
    let mut words = Vec::new();
    for token in out.tokens {
        match token {
            lex::Tok::Word(word) => words.push(expand_single(shell, &word, &Io::default())?),
            _ => return Ok(None),
        }
    }
    if words.is_empty() {
        return Ok(None);
    }
    words.extend(rest.iter().cloned());
    Ok(Some(words))
}

/* ---------- The pipeline ---------- */

fn expand_one_word(shell: &mut Shell, word: &Word, io: &Io) -> Result<Vec<String>, ExecError> {
    let frags = fragments(shell, word, io)?;
    let ifs: Vec<char> = shell
        .get_var("IFS")
        .unwrap_or_else(|| " \t\n".to_owned())
        .chars()
        .collect();
    // Fields carry whether their glob characters were unquoted — a quoted `*` must
    // survive as a literal.
    let mut fields: Vec<(String, bool)> = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut globbable = false;
    // A `"$@"` splice is still inside the quotes: following text glues onto its last
    // argument (`"x$@y"` over `a b` is two fields, `xa` and `by`), and only the NEXT
    // splice opens a new field. Set while the last splice's field is still open.
    let mut spliced = false;
    // IFS whitespace seen since the last field with nothing between: it merges into a
    // following non-whitespace delimiter instead of counting as its own boundary.
    let mut pending_ws = false;
    for frag in frags {
        if frag.boundary {
            if spliced {
                fields.push((std::mem::take(&mut current), false));
                globbable = false;
            }
            current.push_str(&frag.text);
            started = true;
            spliced = true;
            pending_ws = false;
            continue;
        }
        if frag.quoted || !frag.split {
            // Only unquoted expansion results field-split — literal text never does
            // (`IFS=:; echo a::b` passes one argument), though an unquoted literal's
            // glob characters still glob.
            if !frag.quoted {
                for c in frag.text.chars() {
                    if matches!(c, '*' | '?' | '[') {
                        globbable = true;
                    }
                }
            }
            started = true;
            current.push_str(&frag.text);
            continue;
        }
        let mut chunk = String::new();
        for c in frag.text.chars() {
            if ifs.contains(&c) && !matches!(c, ' ' | '\t' | '\n') {
                // A non-whitespace delimiter always ends a field: with its content
                // when there is any, as an empty one between adjacent delimiters
                // (`IFS=:; set -- $v` over `a::b` is three fields) — unless IFS
                // whitespace just delimited, which absorbs it.
                current.push_str(&chunk);
                chunk.clear();
                if !current.is_empty() || started || !pending_ws {
                    fields.push((std::mem::take(&mut current), globbable));
                }
                started = false;
                globbable = false;
                spliced = false;
                pending_ws = false;
            } else if ifs.contains(&c) {
                if !chunk.is_empty() || started {
                    current.push_str(&chunk);
                    chunk.clear();
                    fields.push((std::mem::take(&mut current), globbable));
                    started = false;
                    globbable = false;
                    spliced = false;
                }
                pending_ws = true;
            } else {
                pending_ws = false;
                if matches!(c, '*' | '?' | '[') {
                    globbable = true;
                }
                chunk.push(c);
            }
        }
        if !chunk.is_empty() || started {
            current.push_str(&chunk);
            started = true;
        }
    }
    if started || !current.is_empty() {
        fields.push((current, globbable));
    }
    // Pathname expansion, unless `set -f`.
    let mut expanded = Vec::new();
    for (field, globbable) in fields {
        if globbable && !shell.noglob {
            if let Some(matches) = super::glob::glob_expand(&field, &shell.cwd) {
                expanded.extend(matches);
                continue;
            }
        }
        expanded.push(field);
    }
    Ok(expanded)
}

fn fragments(shell: &mut Shell, word: &Word, io: &Io) -> Result<Vec<Frag>, ExecError> {
    let mut frags: Vec<Frag> = Vec::new();
    for (index, part) in word.0.iter().enumerate() {
        match part {
            Part::Lit(text) => {
                let text = if index == 0 {
                    expand_tilde(shell, text)
                } else {
                    text.clone()
                };
                if !text.is_empty() {
                    frags.push(Frag {
                        text,
                        quoted: false,
                        boundary: false,
                        split: false,
                    });
                }
            }
            Part::Quoted(text) => frags.push(Frag {
                text: text.clone(),
                quoted: true,
                boundary: false,
                split: false,
            }),
            Part::DQuoted(parts) => {
                // `""` is one empty field, not zero: an interior that produced no parts
                // still marks the word as started, so the empty argument survives
                // (`set -- ""; echo $#` is 1, and `cmd ""` passes an empty argument).
                if parts.is_empty() {
                    frags.push(Frag {
                        text: String::new(),
                        quoted: true,
                        boundary: false,
                        split: false,
                    });
                }
                for part in parts {
                    match part {
                        DPart::Lit(text) => {
                            if !text.is_empty() {
                                frags.push(Frag {
                                    text: text.clone(),
                                    quoted: true,
                                    boundary: false,
                                    split: false,
                                });
                            }
                        }
                        DPart::Var { name, op, word } => {
                            // "${arr[@]}" and "${@:2}" splice fields like "$@".
                            if name.ends_with("[@]") || (name == "@" && *op == ParamOp::Substring) {
                                if let Some(items) =
                                    array_all_items(shell, name, *op, word.as_ref(), io)?
                                {
                                    for item in items {
                                        frags.push(Frag {
                                            text: item,
                                            quoted: true,
                                            boundary: true,
                                            split: false,
                                        });
                                    }
                                    continue;
                                }
                            }
                            // "$@" splices fields; everything else glues.
                            if name == "@" && matches!(op, ParamOp::Plain) {
                                for arg in shell.positional() {
                                    frags.push(Frag {
                                        text: arg,
                                        quoted: true,
                                        boundary: true,
                                        split: false,
                                    });
                                }
                            } else {
                                let value = param_value(shell, name, *op, word.as_ref(), io, true)?;
                                frags.push(Frag {
                                    text: value,
                                    quoted: true,
                                    boundary: false,
                                    split: false,
                                });
                            }
                        }
                        DPart::CmdSub(script) => {
                            let value = command_substitution(shell, script, io)?;
                            frags.push(Frag {
                                text: value,
                                quoted: true,
                                boundary: false,
                                split: false,
                            });
                        }
                        DPart::ProcSub(script, out) => {
                            let path = process_substitution(shell, script, *out, io)?;
                            frags.push(Frag {
                                text: path,
                                quoted: true,
                                boundary: false,
                                split: false,
                            });
                        }
                        DPart::Arith(text) => {
                            let value = eval_arith(shell, text, io)?;
                            frags.push(Frag {
                                text: value.to_string(),
                                quoted: true,
                                boundary: false,
                                split: false,
                            });
                        }
                    }
                }
            }
            Part::ArrayLit(elements) => {
                // Outside an assignment (`declare -a x=(1 2)`) the literal travels as
                // its text, which `declare` parses back.
                let items = expand_words(shell, elements, io)?;
                frags.push(Frag {
                    text: format!("({})", items.join(" ")),
                    quoted: true,
                    boundary: false,
                    split: false,
                });
            }
            Part::Sep => {}
            Part::Var { name, op, word } => {
                if name == "@" && matches!(op, ParamOp::Plain) {
                    // Unquoted `$@` splits and globs like any expansion: the arguments
                    // rejoin into one text the IFS loop breaks apart again
                    // (`set -- "a b" c; for v in $@` walks a, b, c). The join character
                    // is the first of IFS, so a custom IFS re-splits it.
                    let sep = match shell.get_var("IFS") {
                        Some(ifs) => ifs.chars().next().map(String::from).unwrap_or_default(),
                        None => " ".to_owned(),
                    };
                    if sep.is_empty() {
                        // IFS set but empty splits nothing, yet `$@` still expands to
                        // one field per argument (`IFS=; set -- $@` keeps the count) —
                        // spliced, with empty arguments dropped as unquoted text is.
                        for arg in shell.positional() {
                            if !arg.is_empty() {
                                frags.push(Frag {
                                    text: arg,
                                    quoted: false,
                                    boundary: true,
                                    split: false,
                                });
                            }
                        }
                        continue;
                    }
                    frags.push(Frag {
                        text: shell.positional().join(&sep),
                        quoted: false,
                        boundary: false,
                        split: true,
                    });
                } else {
                    let value = param_value(shell, name, *op, word.as_ref(), io, false)?;
                    frags.push(Frag {
                        text: value,
                        quoted: false,
                        boundary: false,
                        split: true,
                    });
                }
            }
            Part::CmdSub(script) => {
                let value = command_substitution(shell, script, io)?;
                frags.push(Frag {
                    text: value,
                    quoted: false,
                    boundary: false,
                    split: true,
                });
            }
            Part::ProcSub(script, out) => {
                let path = process_substitution(shell, script, *out, io)?;
                frags.push(Frag {
                    text: path,
                    quoted: true,
                    boundary: false,
                    split: false,
                });
            }
            Part::Arith(text) => {
                let value = eval_arith(shell, text, io)?;
                frags.push(Frag {
                    text: value.to_string(),
                    quoted: false,
                    boundary: false,
                    split: true,
                });
            }
        }
    }
    Ok(frags)
}

fn expand_tilde(shell: &Shell, text: &str) -> String {
    if !text.starts_with('~') {
        return text.to_owned();
    }
    let (head, tail) = match text.find('/') {
        Some(slash) => text.split_at(slash),
        None => (text, ""),
    };
    if head == "~" {
        if let Some(home) = shell
            .get_var("HOME")
            .or_else(|| shell.get_var("USERPROFILE"))
        {
            return format!("{home}{tail}");
        }
    }
    text.to_owned()
}

pub fn split_subscript(name: &str) -> Option<(&str, &str)> {
    let open = name.find('[')?;
    if !name.ends_with(']') || open == 0 {
        return None;
    }
    Some((&name[..open], &name[open + 1..name.len() - 1]))
}

/// A subscript as an element position (negative counts from the end).
fn element_index(
    shell: &mut Shell,
    index: &str,
    len: usize,
    io: &Io,
) -> Result<Option<usize>, ExecError> {
    let at = eval_arith(shell, index, io)?;
    let at = if at < 0 { len as i64 + at } else { at };
    Ok((at >= 0).then_some(at as usize))
}

/// A word's expansion evaluated as an arithmetic expression (`${x:off:len}` operands).
fn arith_word(shell: &mut Shell, word: &Word, io: &Io) -> Result<i64, ExecError> {
    let text = expand_single(shell, word, io)?;
    eval_arith(shell, &text, io)
}

fn split_sep(word: Option<&Word>) -> (Word, Option<Word>) {
    let Some(word) = word else {
        return (Word(Vec::new()), None);
    };
    match word.0.iter().position(|p| matches!(p, Part::Sep)) {
        Some(at) => (
            Word(word.0[..at].to_vec()),
            Some(Word(word.0[at + 1..].to_vec())),
        ),
        None => (word.clone(), None),
    }
}

/// `(start, count)` of `${x:off:len}` over `total` units.
fn slice_bounds(total: usize, offset: i64, length: Option<i64>, strings: bool) -> (usize, usize) {
    let total_i = total as i64;
    let start = if offset < 0 {
        (total_i + offset).max(0)
    } else {
        offset.min(total_i)
    };
    let end = match length {
        None => total_i,
        Some(n) if n >= 0 => (start + n).min(total_i),
        // A negative length counts back from the end (strings only; arrays clamp).
        Some(n) if strings => (total_i + n).max(start),
        Some(_) => start,
    };
    (start as usize, (end - start).max(0) as usize)
}

/// The element list behind `${arr[@]}` / `${!arr[@]}` / `${arr[@]:off:len}` / `${@:off}`
/// and the per-element operators; `None` when `name` is not an all-elements reference or
/// the operator is one that works on the joined value instead.
fn array_all_items(
    shell: &mut Shell,
    name: &str,
    op: ParamOp,
    word: Option<&Word>,
    io: &Io,
) -> Result<Option<Vec<String>>, ExecError> {
    let items = if name == "@" || name == "*" {
        if op != ParamOp::Substring {
            return Ok(None);
        }
        // Positional slices count `$0` as element 0: `${@:1}` is every argument.
        let mut all = vec![shell.arg0.clone()];
        all.extend(shell.positional());
        let (offset, length) = split_sep(word);
        let offset = arith_word(shell, &offset, io)?;
        let length = match length {
            Some(w) => Some(arith_word(shell, &w, io)?),
            None => None,
        };
        let (start, count) = slice_bounds(all.len(), offset, length, false);
        // `${@:0}` includes $0; a start of 1 or more is plain arguments.
        return Ok(Some(all.into_iter().skip(start).take(count).collect()));
    } else {
        match split_subscript(name) {
            Some((base, "@")) | Some((base, "*")) if shell.assoc.contains_key(base) => {
                let entries = shell.assoc.get(base).cloned().unwrap_or_default();
                if op == ParamOp::Keys {
                    return Ok(Some(entries.into_iter().map(|(k, _)| k).collect()));
                }
                entries.into_iter().map(|(_, v)| v).collect()
            }
            Some((base, "@")) | Some((base, "*")) => {
                if op == ParamOp::Keys {
                    let count = shell.array_snapshot(base).len();
                    return Ok(Some((0..count).map(|i| i.to_string()).collect()));
                }
                shell.array_snapshot(base)
            }
            _ => return Ok(None),
        }
    };
    match op {
        ParamOp::Plain => Ok(Some(items)),
        ParamOp::Substring => {
            let (offset, length) = split_sep(word);
            let offset = arith_word(shell, &offset, io)?;
            let length = match length {
                Some(word) => Some(arith_word(shell, &word, io)?),
                None => None,
            };
            // `${@:0}` would start at $0; positional slices are one-based.
            let (start, count) = slice_bounds(items.len(), offset, length, false);
            Ok(Some(items.into_iter().skip(start).take(count).collect()))
        }
        ParamOp::TrimPrefix { .. }
        | ParamOp::TrimSuffix { .. }
        | ParamOp::Replace { .. }
        | ParamOp::Case { .. } => {
            let mut out = Vec::new();
            for item in items {
                out.push(text_op(shell, op, &item, word, io)?);
            }
            Ok(Some(out))
        }
        _ => Ok(None),
    }
}

/// `${x#pat}`, `${x%pat}`, `${x/pat/rep}`, `${x:off:len}`, `${x^}`/`${x,}` on one string.
fn text_op(
    shell: &mut Shell,
    op: ParamOp,
    value: &str,
    word: Option<&Word>,
    io: &Io,
) -> Result<String, ExecError> {
    use super::glob::glob_match_raw;
    let boundaries: Vec<usize> = value
        .char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(value.len()))
        .collect();
    match op {
        ParamOp::TrimPrefix { longest } => {
            let pattern = match word {
                Some(w) => expand_single(shell, w, io)?,
                None => return Ok(value.to_owned()),
            };
            let order: Vec<usize> = if longest {
                boundaries.iter().rev().copied().collect()
            } else {
                boundaries.clone()
            };
            for end in order {
                if glob_match_raw(&pattern, &value[..end]) {
                    return Ok(value[end..].to_owned());
                }
            }
            Ok(value.to_owned())
        }
        ParamOp::TrimSuffix { longest } => {
            let pattern = match word {
                Some(w) => expand_single(shell, w, io)?,
                None => return Ok(value.to_owned()),
            };
            let order: Vec<usize> = if longest {
                boundaries.clone()
            } else {
                boundaries.iter().rev().copied().collect()
            };
            for start in order {
                if glob_match_raw(&pattern, &value[start..]) {
                    return Ok(value[..start].to_owned());
                }
            }
            Ok(value.to_owned())
        }
        ParamOp::Replace { all, anchor } => {
            let (pattern, replacement) = split_sep(word);
            let pattern = expand_single(shell, &pattern, io)?;
            let replacement = match replacement {
                Some(w) => expand_single(shell, &w, io)?,
                None => String::new(),
            };
            if pattern.is_empty() {
                return Ok(value.to_owned());
            }
            let literal = !pattern.contains(['*', '?', '[']);
            if anchor == 1 {
                // The longest matching prefix.
                for &end in boundaries.iter().rev() {
                    if glob_match_raw(&pattern, &value[..end]) {
                        return Ok(format!("{replacement}{}", &value[end..]));
                    }
                }
                return Ok(value.to_owned());
            }
            if anchor == 2 {
                for &start in &boundaries {
                    if glob_match_raw(&pattern, &value[start..]) {
                        return Ok(format!("{}{replacement}", &value[..start]));
                    }
                }
                return Ok(value.to_owned());
            }
            if literal {
                return Ok(if all {
                    value.replace(&pattern, &replacement)
                } else {
                    value.replacen(&pattern, &replacement, 1)
                });
            }
            let mut out = String::new();
            let mut at = 0;
            let mut replaced = false;
            while at < boundaries.len() - 1 {
                let start = boundaries[at];
                let hit = if replaced && !all {
                    None
                } else {
                    // The longest match starting here.
                    (at + 1..boundaries.len())
                        .rev()
                        .find(|&j| glob_match_raw(&pattern, &value[start..boundaries[j]]))
                };
                match hit {
                    Some(j) => {
                        out.push_str(&replacement);
                        replaced = true;
                        at = j;
                    }
                    None => {
                        out.push_str(&value[start..boundaries[at + 1]]);
                        at += 1;
                    }
                }
            }
            Ok(out)
        }
        ParamOp::Substring => {
            let (offset, length) = split_sep(word);
            let offset = arith_word(shell, &offset, io)?;
            let length = match length {
                Some(w) => Some(arith_word(shell, &w, io)?),
                None => None,
            };
            let chars: Vec<char> = value.chars().collect();
            let (start, count) = slice_bounds(chars.len(), offset, length, true);
            Ok(chars.into_iter().skip(start).take(count).collect())
        }
        ParamOp::Case { upper, all } => {
            let convert = |c: char| -> String {
                if upper {
                    c.to_uppercase().collect()
                } else {
                    c.to_lowercase().collect()
                }
            };
            if all {
                Ok(value.chars().map(convert).collect())
            } else {
                let mut chars = value.chars();
                Ok(match chars.next() {
                    Some(first) => convert(first) + chars.as_str(),
                    None => String::new(),
                })
            }
        }
        _ => Ok(value.to_owned()),
    }
}

fn param_value(
    shell: &mut Shell,
    name: &str,
    op: ParamOp,
    word: Option<&Word>,
    io: &Io,
    _quoted: bool,
) -> Result<String, ExecError> {
    // `${!name}` — one extra hop: the value of $name is the variable to fetch.
    if let Some(indirect) = name.strip_prefix('!') {
        if !indirect.is_empty() {
            if let Some(target) = shell.get_var(indirect) {
                if !target.is_empty() {
                    return param_value(shell, &target, op, word, io, _quoted);
                }
            }
        }
    }
    if let Some(items) = array_all_items(shell, name, op, word, io)? {
        return Ok(items.join(" "));
    }
    if name == "*" {
        // The glue form joins with the first IFS character (`IFS=:; "$*"` → a:b:c).
        let sep = match shell.get_var("IFS") {
            Some(ifs) => ifs.chars().next().map(String::from).unwrap_or_default(),
            None => " ".to_owned(),
        };
        return Ok(shell.positional().join(&sep));
    }
    if name == "@" {
        // Handled by the caller for the splice; the glue form joins.
        return Ok(shell.positional().join(" "));
    }
    let current = match split_subscript(name) {
        Some((base, index)) if shell.assoc.contains_key(base) => {
            let entries = shell.assoc.get(base).cloned().unwrap_or_default();
            if index == "@" || index == "*" {
                if op == ParamOp::Length {
                    return Ok(entries.len().to_string());
                }
                (!entries.is_empty()).then(|| {
                    entries
                        .into_iter()
                        .map(|(_, v)| v)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
            } else {
                let key = assoc_key(shell, index, io)?;
                let element = shell
                    .assoc
                    .get(base)
                    .and_then(|e| e.iter().find(|(k, _)| *k == key))
                    .map(|(_, v)| v.clone());
                if op == ParamOp::Length {
                    return Ok(element.map_or(0, |e| e.chars().count()).to_string());
                }
                element
            }
        }
        Some((base, index)) => {
            let items = shell.array_snapshot(base);
            if index == "@" || index == "*" {
                if op == ParamOp::Length {
                    return Ok(items.len().to_string());
                }
                (!items.is_empty()).then(|| items.join(" "))
            } else {
                let element = element_index(shell, index, items.len(), io)?
                    .and_then(|at| items.get(at).cloned());
                if op == ParamOp::Length {
                    return Ok(element.map_or(0, |e| e.chars().count()).to_string());
                }
                element
            }
        }
        None => shell.get_var(name),
    };
    let is_set = current.is_some();
    let value = current.unwrap_or_default();
    match op {
        ParamOp::Plain => Ok(value),
        ParamOp::Length => Ok(value.chars().count().to_string()),
        ParamOp::Keys => Ok(String::new()),
        ParamOp::TrimPrefix { .. }
        | ParamOp::TrimSuffix { .. }
        | ParamOp::Replace { .. }
        | ParamOp::Substring
        | ParamOp::Case { .. } => text_op(shell, op, &value, word, io),
        ParamOp::Default { colon } => {
            // The colon forms test unset-or-empty; the bare forms test unset only
            // (`${x-d}` leaves a set-but-empty x alone).
            let use_default = if colon {
                !is_set || value.is_empty()
            } else {
                !is_set
            };
            if use_default {
                Ok(word
                    .map(|w| expand_single(shell, w, io))
                    .transpose()?
                    .unwrap_or_default())
            } else {
                Ok(value)
            }
        }
        ParamOp::Assign { colon } => {
            let use_default = if colon {
                !is_set || value.is_empty()
            } else {
                !is_set
            };
            if use_default {
                let assigned = word
                    .map(|w| expand_single(shell, w, io))
                    .transpose()?
                    .unwrap_or_default();
                // `${arr[i]:=word}` assigns the element, not a variable literally
                // named `arr[i]` — the same routing an assignment statement takes.
                if split_subscript(name).is_some() {
                    shell.assign(name, &Word(vec![Part::Lit(assigned.clone())]), io)?;
                } else {
                    shell.set_var(name, &assigned);
                }
                Ok(assigned)
            } else {
                Ok(value)
            }
        }
        ParamOp::Alternate { colon } => {
            let use_alt = if colon {
                is_set && !value.is_empty()
            } else {
                is_set
            };
            if use_alt {
                Ok(word
                    .map(|w| expand_single(shell, w, io))
                    .transpose()?
                    .unwrap_or_default())
            } else {
                Ok(String::new())
            }
        }
    }
}

/// `$( … )` runs in a cloned shell (a subshell: its assignments and cd die with it),
/// stdout captured and the trailing newlines stripped.
fn command_substitution(
    shell: &mut Shell,
    script: &super::ast::Script,
    io: &Io,
) -> Result<String, ExecError> {
    let mut sub = shell.clone();
    let (capture_io, buffer) = Io::capturing();
    let _ = io;
    let outcome = sub.exec_script(script, &capture_io);
    // `exit` (or a stray `return`) inside the substitution ends the SUBSHELL; the
    // outer shell keeps going (`x=$(exit 5); echo after` still echoes).
    let result = match outcome {
        Ok(status) => Ok(status),
        Err(ExecError::Exit(code)) | Err(ExecError::Return(code)) => Ok(code),
        Err(other) => Err(other),
    };
    shell.status = match &result {
        Ok(status) => *status,
        Err(_) => 1,
    };
    result?;
    let bytes = buffer.lock().unwrap().clone();
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(text.trim_end_matches('\n').to_owned())
}

/* ---------- Process substitution ---------- */

thread_local! {
    /// The process-substitution temp files of the command in flight: `>(cmd)` entries
    /// carry the consumer script to feed once the command finishes, `<(cmd)` entries a
    /// `None` (the producer already wrote the file — only the cleanup is owed).
    /// Per-thread, because a pipeline stage expands in its own thread.
    static PENDING_PSUBS: std::cell::RefCell<Vec<(String, Option<super::ast::Script>)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// `<(cmd)` answers a temp file carrying the command's output; `>(cmd)` answers an
/// empty temp file and queues the command to consume it afterwards. Both files are
/// removed at the pipeline's tail (see [`flush_pending_process_subs`]).
fn process_substitution(
    shell: &mut Shell,
    script: &super::ast::Script,
    out: bool,
    _io: &Io,
) -> Result<String, ExecError> {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let unique = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("ggs-psub-{}-{unique}", std::process::id()));
    let shown = || path.display().to_string().replace('\\', "/");
    if !out {
        let mut sub = shell.clone();
        let (capture, buffer) = Io::capturing();
        sub.exec_script(script, &capture)?;
        let bytes = buffer.lock().unwrap().clone();
        std::fs::write(&path, bytes).map_err(|e| ExecError::Io(format!("{e}")))?;
        PENDING_PSUBS.with(|cell| cell.borrow_mut().push((shown(), None)));
        return Ok(shown());
    }
    std::fs::write(&path, b"").map_err(|e| ExecError::Io(format!("{e}")))?;
    PENDING_PSUBS.with(|cell| cell.borrow_mut().push((shown(), Some(script.clone()))));
    Ok(shown())
}

/// Drain the pipeline's process substitutions: every temp file goes away; a `>(cmd)`
/// entry additionally reads its file back and runs the consumer over that stdin.
/// Called at an `exec_pipeline` tail, with the pipeline's own (unredirected) stdout.
pub fn flush_pending_process_subs(shell: &mut Shell, io: &Io) {
    let pending: Vec<(String, Option<super::ast::Script>)> =
        PENDING_PSUBS.with(|cell| std::mem::take(&mut *cell.borrow_mut()));
    for (path, script) in pending {
        let Some(script) = script else {
            let _ = std::fs::remove_file(&path);
            continue;
        };
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let run_io = Io {
            stdin: super::exec::Source::Str(Arc::new(Mutex::new(text))),
            stdout: io.stdout.clone(),
            stderr: io.stderr.clone(),
        };
        // The consumer is a subshell, like bash's: its assignments die with it.
        let mut sub = shell.clone();
        let _ = sub.exec_script(&script, &run_io);
        let _ = std::fs::remove_file(&path);
    }
}

/* ---------- Arithmetic ---------- */

/// `$(( … ))`, `(( … ))`, `let` and array subscripts — see `arith.rs`.
pub fn eval_arith(shell: &mut Shell, text: &str, io: &Io) -> Result<i64, ExecError> {
    super::arith::eval_arith(shell, text, io)
}

/// The text of a variable or `name[subscript]` reference (arithmetic reads variables
/// through this, so array elements and associative keys work as operands).
pub fn variable_text(shell: &mut Shell, name: &str, io: &Io) -> Result<String, ExecError> {
    param_value(shell, name, ParamOp::Plain, None, io, false)
}

/// An associative-array key: `$var` expansions applied, one pair of quotes stripped.
pub fn assoc_key(shell: &mut Shell, raw: &str, io: &Io) -> Result<String, ExecError> {
    let text = if raw.contains(['$', '`']) {
        expand_heredoc(shell, raw, io)?
    } else {
        raw.to_owned()
    };
    for quote in ['"', '\''] {
        if text.len() >= 2 && text.starts_with(quote) && text.ends_with(quote) {
            return Ok(text[1..text.len() - 1].to_owned());
        }
    }
    Ok(text)
}

/// Parse heredoc body text with double-quote semantics: reuse the lexer's dquote
/// reader over `text + '"'` so the body's own quotes stay literal and the appended
/// quote only closes.
fn dquote_parts(text: &str) -> Result<Vec<DPart>, String> {
    let mut source = String::with_capacity(text.len() + 1);
    source.push_str(text);
    source.push('"');
    lex::lex_dquoted(&source).map_err(|error| format!("{error:?}"))
}
