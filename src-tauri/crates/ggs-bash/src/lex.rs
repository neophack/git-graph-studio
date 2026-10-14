//! The tokenizer: source text → the token stream the parser walks. It owns everything
//! character-level — quoting runs, `$` forms (parameters, `$(…)`, `$((…))`, backticks),
//! escapes, comments, operators, and the one awkward piece of shell lexing, heredocs:
//! the `<<` op carries its delimiter word, and the body is collected from the raw source
//! when the lexer reaches the end of that line. Unterminated quotes and heredocs answer
//! `Incomplete` — the interactive loop's cue to wait for the next line instead of
//! erroring.

use super::ast::{DPart, ParamOp, Part, Word};

#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    And,
    Or,
    Pipe,
    /// `<(`
    ProcIn,
    /// `>(`
    ProcOut,
    Amp,
    Semi,
    SemiSemi,
    LParen,
    RParen,
    Lt,
    Gt,
    Append,
    /// `<<` — `id` indexes [`LexOut::heredocs`]; `dedent` is `<<-`.
    Heredoc {
        id: usize,
        dedent: bool,
    },
    Herestring,
    /// `>&`
    DupOut,
    /// `<&`
    DupIn,
    /// `&>`
    Both,
}

impl Op {
    pub fn as_str(&self) -> &'static str {
        match self {
            Op::And => "&&",
            Op::Or => "||",
            Op::Pipe => "|",
            Op::ProcIn => "<(",
            Op::ProcOut => ">(",
            Op::Amp => "&",
            Op::Semi => ";",
            Op::SemiSemi => ";;",
            Op::LParen => "(",
            Op::RParen => ")",
            Op::Lt => "<",
            Op::Gt => ">",
            Op::Append => ">>",
            Op::Heredoc { .. } => "<<",
            Op::Herestring => "<<<",
            Op::DupOut => ">&",
            Op::DupIn => "<&",
            Op::Both => "&>",
        }
    }
}

#[derive(Debug, Clone)]
pub enum Tok {
    Word(Word),
    Op(Op, Option<u32>),
    Newline,
}

#[derive(Debug, Clone)]
pub struct HeredocBody {
    pub content: String,
    pub expand: bool,
}

#[derive(Debug, Default)]
pub struct LexOut {
    pub tokens: Vec<Tok>,
    pub heredocs: Vec<HeredocBody>,
}

#[derive(Debug)]
pub enum LexError {
    /// More input would complete this (an open quote, a pending heredoc).
    Incomplete(String),
    Fatal(String),
}

struct Lexer {
    chars: Vec<char>,
    at: usize,
    out: LexOut,
    pending_heredocs: Vec<(usize, String, bool)>,
}

/// Tokenize `source`. A heredoc's body is attached to its `<<` token through the id.
pub fn lex(source: &str) -> Result<LexOut, LexError> {
    let mut lexer = Lexer {
        chars: source.chars().collect(),
        at: 0,
        out: LexOut::default(),
        pending_heredocs: Vec::new(),
    };
    lexer.run()?;
    Ok(lexer.out)
}

/// Parse `text` as the interior of one double quote — the heredoc-body reader. The
/// caller appends the closing quote to the input, so a body's own quote characters stay
/// literal (exactly heredoc semantics) and only the trailing one closes.
pub fn lex_dquoted(text: &str) -> Result<Vec<DPart>, LexError> {
    let mut lexer = Lexer {
        chars: text.chars().collect(),
        at: 0,
        out: LexOut::default(),
        pending_heredocs: Vec::new(),
    };
    lexer.read_dquoted()
}

impl Lexer {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }
    fn peek_at(&self, offset: usize) -> Option<char> {
        self.chars.get(self.at + offset).copied()
    }

    fn run(&mut self) -> Result<(), LexError> {
        let mut pending_fd: Option<u32> = None;
        while let Some(c) = self.peek() {
            match c {
                ' ' | '\t' | '\r' => {
                    self.at += 1;
                }
                '\\' if self.peek_at(1) == Some('\n') => {
                    // Line continuation inside a line — splice the two away.
                    self.at += 2;
                }
                '\n' => {
                    self.at += 1;
                    self.collect_heredoc_bodies()?;
                    self.out.tokens.push(Tok::Newline);
                }
                '#' => {
                    // A comment: only where a word could start (the caller never emits
                    // `#` mid-word — read_word consumes it there as a literal).
                    while let Some(c) = self.peek() {
                        if c == '\n' {
                            break;
                        }
                        self.at += 1;
                    }
                }
                // `(( expr ))` at a command position (or after `for`): the arithmetic
                // command, tokenized as the word `((` followed by the expression word.
                '(' if self.peek_at(1) == Some('(')
                    && self.at_command_start()
                    && self.scan_arith().is_some() =>
                {
                    let end = self.scan_arith().unwrap_or(self.at);
                    let text: String = self.chars[self.at + 2..end].iter().collect();
                    self.at = end + 2;
                    self.out.tokens.push(Tok::Word(Word::literal("((")));
                    self.out
                        .tokens
                        .push(Tok::Word(Word(vec![Part::Arith(text)])));
                }
                _ if is_operator_start(c) => {
                    let op = self.read_operator()?;
                    let op = match op {
                        Some(op) => op,
                        None => continue, // a `<<` whose tag consumed nothing token-wise
                    };
                    if matches!(op, Op::Lt | Op::Gt | Op::Append | Op::DupOut | Op::DupIn) {
                        self.out.tokens.push(Tok::Op(op, pending_fd.take()));
                    } else {
                        pending_fd = None;
                        self.out.tokens.push(Tok::Op(op, None));
                    }
                }
                _ => {
                    let (word, ended_at) = self.read_word()?;
                    if let [Part::Lit(text)] = word.0.as_slice() {
                        // An all-digit word jammed against `<`/`>` is the fd it redirects;
                        // against any other operator it stays a plain word.
                        if matches!(ended_at, Some('<') | Some('>')) {
                            if let Ok(fd) = text.parse::<u32>() {
                                pending_fd = Some(fd);
                                continue;
                            }
                        }
                    }
                    if !word.0.is_empty() {
                        self.out.tokens.push(Tok::Word(word));
                    }
                }
            }
        }
        if !self.pending_heredocs.is_empty() {
            return Err(LexError::Incomplete("heredoc body missing".into()));
        }
        Ok(())
    }

    /// Is the next token the first word of a command (so `((` means arithmetic)?
    fn at_command_start(&self) -> bool {
        match self.out.tokens.last() {
            None | Some(Tok::Newline) => true,
            Some(Tok::Op(op, _)) => matches!(op, Op::Semi | Op::And | Op::Or | Op::Pipe | Op::Amp),
            Some(Tok::Word(word)) => matches!(
                word.as_literal().as_deref(),
                Some(
                    "if" | "while" | "until" | "then" | "do" | "else" | "elif" | "for" | "!" | "{"
                )
            ),
        }
    }

    fn read_operator(&mut self) -> Result<Option<Op>, LexError> {
        let c = self.peek().unwrap();
        self.at += 1;
        let op = match c {
            '&' => match self.peek() {
                Some('&') => {
                    self.at += 1;
                    Op::And
                }
                Some('>') => {
                    self.at += 1;
                    Op::Both
                }
                _ => Op::Amp,
            },
            '|' => match self.peek() {
                Some('|') => {
                    self.at += 1;
                    Op::Or
                }
                _ => Op::Pipe,
            },
            ';' => match self.peek() {
                Some(';') => {
                    self.at += 1;
                    Op::SemiSemi
                }
                _ => Op::Semi,
            },
            '(' => Op::LParen,
            ')' => Op::RParen,
            '<' => match self.peek() {
                Some('(') => {
                    self.at += 1;
                    return Ok(Some(Op::ProcIn));
                }
                Some('<') => {
                    self.at += 1;
                    if self.peek() == Some('-') {
                        self.at += 1;
                        return self.read_heredoc_op(true).map(Some);
                    }
                    if self.peek() == Some('<') {
                        self.at += 1;
                        Op::Herestring
                    } else {
                        return self.read_heredoc_op(false).map(Some);
                    }
                }
                Some('&') => {
                    self.at += 1;
                    Op::DupIn
                }
                _ => Op::Lt,
            },
            '>' => match self.peek() {
                Some('(') => {
                    self.at += 1;
                    return Ok(Some(Op::ProcOut));
                }
                Some('>') => {
                    self.at += 1;
                    Op::Append
                }
                Some('&') => {
                    self.at += 1;
                    Op::DupOut
                }
                Some('|') => {
                    self.at += 1;
                    Op::Gt
                }
                _ => Op::Gt,
            },
            other => return Err(LexError::Fatal(format!("unexpected `{other}`"))),
        };
        Ok(Some(op))
    }

    /// `<<` was read (and the `-` of `<<-`): read the delimiter word, register the
    /// pending body, and emit the op token carrying the body's id.
    fn read_heredoc_op(&mut self, dedent: bool) -> Result<Op, LexError> {
        while matches!(self.peek(), Some(' ') | Some('\t')) {
            self.at += 1;
        }
        let (tag, quoted) = match self.peek() {
            Some('\'') | Some('"') => {
                let quote = self.peek().unwrap();
                self.at += 1;
                let start = self.at;
                while self.peek().is_some() && self.peek() != Some(quote) {
                    self.at += 1;
                }
                if self.peek().is_none() {
                    return Err(LexError::Incomplete(
                        "unterminated heredoc delimiter".into(),
                    ));
                }
                let text: String = self.chars[start..self.at].iter().collect();
                self.at += 1;
                (text, true)
            }
            _ => {
                let start = self.at;
                while let Some(c) = self.peek() {
                    if c.is_whitespace() || is_operator_start(c) {
                        break;
                    }
                    self.at += 1;
                }
                // `<<\EOF` quotes the delimiter one backslash at a time.
                let raw: String = self.chars[start..self.at].iter().collect();
                let quoted = raw.contains('\\');
                (raw.replace('\\', ""), quoted)
            }
        };
        let id = self.out.heredocs.len();
        self.out.heredocs.push(HeredocBody {
            content: String::new(),
            expand: !quoted,
        });
        self.pending_heredocs.push((id, tag, dedent));
        Ok(Op::Heredoc { id, dedent })
    }

    /// After a newline: every pending heredoc body, straight from the raw source, up to
    /// the line that spells its delimiter (`<<-` also strips the line's leading tabs).
    fn collect_heredoc_bodies(&mut self) -> Result<(), LexError> {
        for (id, tag, dedent) in std::mem::take(&mut self.pending_heredocs) {
            let mut body = String::new();
            let mut terminated = false;
            while self.at < self.chars.len() {
                let mut end = self.at;
                while end < self.chars.len() && self.chars[end] != '\n' {
                    end += 1;
                }
                let raw: String = self.chars[self.at..end].iter().collect();
                self.at = if end < self.chars.len() { end + 1 } else { end };
                let line = if dedent {
                    raw.trim_start_matches('\t').to_owned()
                } else {
                    raw
                };
                if line == tag {
                    terminated = true;
                    break;
                }
                body.push_str(&line);
                body.push('\n');
            }
            if !terminated {
                return Err(LexError::Incomplete(format!(
                    "heredoc delimited by `{tag}` never ended"
                )));
            }
            if let Some(slot) = self.out.heredocs.get_mut(id) {
                slot.content = body;
            }
        }
        Ok(())
    }

    /// Read one word. The second answer is the operator character the word ran straight
    /// into (no space): the caller turns an all-digit word before `<`/`>` into an fd.
    fn read_word(&mut self) -> Result<(Word, Option<char>), LexError> {
        let mut parts: Vec<Part> = Vec::new();
        let mut lit = String::new();
        let mut ended_at: Option<char> = None;
        macro_rules! flush {
            () => {
                if !lit.is_empty() {
                    parts.push(Part::Lit(std::mem::take(&mut lit)));
                }
            };
        }
        while let Some(c) = self.peek() {
            match c {
                ' ' | '\t' | '\r' | '\n' => break,
                // `name=(a b c)` / `name+=(…)`: an array literal, not a subshell.
                '(' if parts.is_empty() && array_target(&lit) => {
                    let Some(end) = self.scan_sub() else {
                        return Err(LexError::Incomplete("array literal never closed".into()));
                    };
                    let text: String = self.chars[self.at + 1..end].iter().collect();
                    self.at = end + 1;
                    let inner = lex(&text)?;
                    let elements: Vec<Word> = inner
                        .tokens
                        .into_iter()
                        .filter_map(|tok| match tok {
                            Tok::Word(word) => Some(word),
                            _ => None,
                        })
                        .collect();
                    flush!();
                    parts.push(Part::ArrayLit(elements));
                }
                _ if is_operator_start(c) => {
                    ended_at = Some(c);
                    break;
                }
                '#' if parts.is_empty() && lit.is_empty() => break, // a comment starts here
                '\\' => {
                    match self.peek_at(1) {
                        None => return Err(LexError::Incomplete("trailing backslash".into())),
                        Some('\n') => {
                            self.at += 2; // continuation
                        }
                        Some(escaped) => {
                            self.at += 2;
                            flush!();
                            parts.push(Part::Quoted(escaped.to_string()));
                        }
                    }
                }
                '\'' => {
                    self.at += 1;
                    let start = self.at;
                    while self.peek().is_some() && self.peek() != Some('\'') {
                        self.at += 1;
                    }
                    if self.peek().is_none() {
                        return Err(LexError::Incomplete("single quote never closed".into()));
                    }
                    let text: String = self.chars[start..self.at].iter().collect();
                    self.at += 1;
                    flush!();
                    parts.push(Part::Quoted(text));
                }
                '"' => {
                    self.at += 1;
                    let inner = self.read_dquoted()?;
                    flush!();
                    parts.push(Part::DQuoted(inner));
                }
                '$' => {
                    let part = self.read_dollar()?;
                    match part {
                        Some(part) => {
                            flush!();
                            parts.push(part);
                        }
                        None => lit.push('$'), // a lone `$`
                    }
                }
                '`' => {
                    self.at += 1;
                    let start = self.at;
                    while self.peek().is_some() && self.peek() != Some('`') {
                        self.at += 1;
                    }
                    if self.peek().is_none() {
                        return Err(LexError::Incomplete("backquote never closed".into()));
                    }
                    let text: String = self.chars[start..self.at].iter().collect();
                    self.at += 1;
                    flush!();
                    parts.push(Part::CmdSub(
                        super::parse::parse_script(&text).map_err(lexify)?,
                    ));
                }
                other => {
                    self.at += 1;
                    lit.push(other);
                }
            }
        }
        flush!();
        Ok((Word(parts), ended_at))
    }

    /// The interior of a double quote: `\$ \" \` \\` escapes and every `$` form, glued
    /// without splitting.
    fn read_dquoted(&mut self) -> Result<Vec<DPart>, LexError> {
        let mut parts: Vec<DPart> = Vec::new();
        let mut lit = String::new();
        macro_rules! flush {
            () => {
                if !lit.is_empty() {
                    parts.push(DPart::Lit(std::mem::take(&mut lit)));
                }
            };
        }
        loop {
            let Some(c) = self.peek() else {
                return Err(LexError::Incomplete("double quote never closed".into()));
            };
            match c {
                '"' => {
                    self.at += 1;
                    flush!();
                    return Ok(parts);
                }
                '\\' => match self.peek_at(1) {
                    Some('$') | Some('"') | Some('`') | Some('\\') => {
                        self.at += 2;
                        lit.push(self.chars[self.at - 1]);
                    }
                    Some('\n') => {
                        self.at += 2;
                    }
                    Some(other) => {
                        self.at += 1;
                        lit.push('\\');
                        let _ = other;
                    }
                    None => return Err(LexError::Incomplete("trailing backslash".into())),
                },
                '$' => {
                    let part = self.read_dollar()?;
                    match part {
                        Some(Part::Lit(text)) => lit.push_str(&text),
                        Some(Part::Quoted(text)) => lit.push_str(&text),
                        Some(Part::Var { name, op, word }) => {
                            flush!();
                            parts.push(DPart::Var { name, op, word });
                        }
                        Some(Part::CmdSub(script)) => {
                            flush!();
                            parts.push(DPart::CmdSub(script));
                        }
                        Some(Part::ProcSub(script, out)) => {
                            flush!();
                            parts.push(DPart::ProcSub(script, out));
                        }
                        Some(Part::Arith(text)) => {
                            flush!();
                            parts.push(DPart::Arith(text));
                        }
                        Some(Part::DQuoted(_) | Part::ArrayLit(_) | Part::Sep) => {
                            unreachable!("$ does not open double quotes")
                        }
                        None => lit.push('$'),
                    }
                }
                '`' => {
                    self.at += 1;
                    let start = self.at;
                    while self.peek().is_some() && self.peek() != Some('`') {
                        self.at += 1;
                    }
                    if self.peek().is_none() {
                        return Err(LexError::Incomplete("backquote never closed".into()));
                    }
                    let text: String = self.chars[start..self.at].iter().collect();
                    self.at += 1;
                    flush!();
                    parts.push(DPart::CmdSub(
                        super::parse::parse_script(&text).map_err(lexify)?,
                    ));
                }
                other => {
                    self.at += 1;
                    lit.push(other);
                }
            }
        }
    }

    /// Every `$` form. `None` answers a lone `$`.
    fn read_dollar(&mut self) -> Result<Option<Part>, LexError> {
        self.at += 1; // the `$`
        match self.peek() {
            None | Some(' ') | Some('\t') | Some('\n') | Some('\r') => Ok(None),
            Some('(') => {
                if self.peek_at(1) == Some('(') {
                    // `$(( … ))` — arithmetic when a balanced `))` lands; a command
                    // substitution starting with a parenthesized subshell falls back.
                    if let Some(end) = self.scan_arith() {
                        let text: String = self.chars[self.at + 2..end].iter().collect();
                        self.at = end + 2;
                        return Ok(Some(Part::Arith(text)));
                    }
                }
                match self.scan_sub() {
                    Some(end) => {
                        let text: String = self.chars[self.at + 1..end].iter().collect();
                        self.at = end + 1;
                        Ok(Some(Part::CmdSub(
                            super::parse::parse_script(&text).map_err(lexify)?,
                        )))
                    }
                    None => Err(LexError::Incomplete("$( never closed".into())),
                }
            }
            Some('{') => {
                self.at += 1;
                let start = self.at;
                let mut depth = 1;
                while let Some(c) = self.peek() {
                    // A backslash escapes the next character for the brace scan, the
                    // way it does inside the expansion (`${q:-a\}b}` closes at the real
                    // `}`, not at the escaped one).
                    if c == '\\' && self.peek_at(1).is_some() {
                        self.at += 2;
                        continue;
                    }
                    if c == '{' {
                        depth += 1;
                    } else if c == '}' {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    self.at += 1;
                }
                if self.peek().is_none() {
                    return Err(LexError::Incomplete("${ never closed".into()));
                }
                let inner: String = self.chars[start..self.at].iter().collect();
                self.at += 1;
                parse_param(&inner).map(Some)
            }
            Some(c) if c.is_ascii_alphabetic() || c == '_' => {
                let start = self.at;
                while let Some(c) = self.peek() {
                    if c.is_ascii_alphanumeric() || c == '_' {
                        self.at += 1;
                    } else {
                        break;
                    }
                }
                let name: String = self.chars[start..self.at].iter().collect();
                Ok(Some(Part::Var {
                    name,
                    op: ParamOp::Plain,
                    word: None,
                }))
            }
            Some(c) if "?#@*$!0123456789-".contains(c) => {
                self.at += 1;
                Ok(Some(Part::Var {
                    name: c.to_string(),
                    op: ParamOp::Plain,
                    word: None,
                }))
            }
            Some(_) => Ok(None),
        }
    }

    /// The end of `$(( … ))`: the first `))` before which the expression's own
    /// parentheses balance. The cursor sits on the opening `(`; the answer is the offset
    /// of the first `)` of the closing pair.
    fn scan_arith(&self) -> Option<usize> {
        let mut depth = 0usize;
        let mut index = self.at + 2;
        while index < self.chars.len() {
            match self.chars[index] {
                '(' => depth += 1,
                ')' => {
                    if depth == 0 {
                        if self.chars.get(index + 1) == Some(&')') {
                            return Some(index);
                        }
                        // An unbalanced `)` at depth 0 — this was a subshell, not arithmetic.
                        return None;
                    }
                    depth -= 1;
                }
                _ => {}
            }
            index += 1;
        }
        None
    }

    /// The end of `$( … )`: the `)` matching the `(` under the cursor, skipping quoted
    /// spans.
    fn scan_sub(&self) -> Option<usize> {
        let mut depth = 1usize;
        let mut index = self.at + 1;
        let mut quote: Option<char> = None;
        while index < self.chars.len() {
            let c = self.chars[index];
            match quote {
                Some(q) => {
                    if c == q {
                        quote = None;
                    } else if c == '\\' && q == '"' {
                        index += 1;
                    }
                }
                None => match c {
                    '\'' | '"' => quote = Some(c),
                    '\\' => index += 1,
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(index);
                        }
                    }
                    _ => {}
                },
            }
            index += 1;
        }
        None
    }
}

fn lexify(error: super::parse::ParseError) -> LexError {
    match error {
        super::parse::ParseError::Incomplete(text) => LexError::Incomplete(text),
        super::parse::ParseError::Fatal(text) => LexError::Fatal(text),
    }
}

fn is_operator_start(c: char) -> bool {
    matches!(c, ';' | '&' | '|' | '(' | ')' | '<' | '>')
}

/// `${name…}` → name, operator and default word.
/// `NAME=` or `NAME+=` — the literal an array literal's `(` may follow.
fn array_target(lit: &str) -> bool {
    let Some(target) = lit.strip_suffix('=') else {
        return false;
    };
    let name = target.strip_suffix('+').unwrap_or(target);
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The argument text of `${x/pat/rep}` / `${x:off:len}`: read like a double quote, so
/// spaces and operators inside stay literal and the `$` forms still expand.
fn loose_word(text: &str) -> Result<Word, LexError> {
    let mut sub = Lexer {
        chars: format!("{text}\"").chars().collect(),
        at: 0,
        out: LexOut::default(),
        pending_heredocs: Vec::new(),
    };
    let parts = sub.read_dquoted()?;
    Ok(Word(
        parts
            .into_iter()
            .map(|part| match part {
                DPart::Lit(text) => Part::Lit(text),
                DPart::Var { name, op, word } => Part::Var { name, op, word },
                DPart::CmdSub(script) => Part::CmdSub(script),
                DPart::ProcSub(script, out) => Part::ProcSub(script, out),
                DPart::Arith(text) => Part::Arith(text),
            })
            .collect(),
    ))
}

/// Drop the backslash of every `\}` in a parameter operator's word; any other escape
/// pair passes through whole for the double-quote reader to judge.
fn unescape_close_brace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('}') => out.push('}'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// Split `text` at its first top-level `sep` (a backslash escapes it; `${…}` nests),
/// un-escaping `\sep` on both sides.
fn split_unescaped(text: &str, sep: char) -> (String, Option<String>) {
    let chars: Vec<char> = text.chars().collect();
    let (mut left, mut right) = (String::new(), String::new());
    let mut in_right = false;
    let mut depth = 0usize;
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        let target = if in_right { &mut right } else { &mut left };
        if c == '\\' && at + 1 < chars.len() {
            if chars[at + 1] == sep {
                target.push(sep);
            } else {
                target.push(c);
                target.push(chars[at + 1]);
            }
            at += 2;
            continue;
        }
        if c == '{' {
            depth += 1;
        } else if c == '}' {
            depth = depth.saturating_sub(1);
        }
        if c == sep && depth == 0 && !in_right {
            in_right = true;
        } else {
            target.push(c);
        }
        at += 1;
    }
    (left, in_right.then_some(right))
}

fn two_arg_word(first: &str, second: Option<&str>) -> Result<Word, LexError> {
    let mut parts = loose_word(first)?.0;
    if let Some(second) = second {
        parts.push(Part::Sep);
        parts.extend(loose_word(second)?.0);
    }
    Ok(Word(parts))
}

fn parse_param(inner: &str) -> Result<Part, LexError> {
    let chars: Vec<char> = inner.chars().collect();
    // `${!arr[@]}`: the indices.
    if chars.first() == Some(&'!') && inner.contains('[') {
        return Ok(Part::Var {
            name: chars[1..].iter().collect(),
            op: ParamOp::Keys,
            word: None,
        });
    }
    if chars.first() == Some(&'#') && chars.len() > 1 && !matches!(chars[1], '$' | '{') {
        let name: String = chars[1..].iter().collect();
        return Ok(Part::Var {
            name,
            op: ParamOp::Length,
            word: None,
        });
    }
    let mut at = 0;
    while at < chars.len() && (chars[at].is_ascii_alphanumeric() || chars[at] == '_') {
        at += 1;
    }
    if at == 0 {
        // `${!name}` without a subscript: indirection — `param_value` resolves the
        // extra hop (`x=hi; y=x; ${!y}` answers hi).
        if chars.first() == Some(&'!') {
            let mut end = 1;
            while end < chars.len() && (chars[end].is_ascii_alphanumeric() || chars[end] == '_') {
                end += 1;
            }
            if end > 1 {
                at = end;
            }
        }
        if at == 0 {
            // A special parameter (`?`, `#`, `$`, …) or `$`-prefixed indirect — take one char.
            if !chars.is_empty() {
                at = 1;
            } else {
                return Ok(Part::Var {
                    name: String::new(),
                    op: ParamOp::Plain,
                    word: None,
                });
            }
        }
    } else if chars.get(at) == Some(&'[') {
        // A subscript: `arr[0]`, `arr[@]`, `arr[i+1]` — the name keeps its brackets.
        if let Some(close) = chars[at..].iter().position(|c| *c == ']') {
            at += close + 1;
        }
    }
    let name: String = chars[..at].iter().collect();
    let rest: String = chars[at..].iter().collect();
    if rest.is_empty() {
        return Ok(Part::Var {
            name,
            op: ParamOp::Plain,
            word: None,
        });
    }
    let simple = |op: ParamOp, tail: &str| -> Result<Part, LexError> {
        let word = if tail.is_empty() {
            None
        } else {
            // The operator's word reads like double-quoted text: `${z:-a b c}` keeps
            // its spaces (read_word would stop at the first one). A `\}` there is the
            // brace the scan skipped, quoted — it reads as a plain `}` (`${q:-a\}b}`
            // is `a}b`), which double-quote rules alone would keep backslashed.
            Some(loose_word(&unescape_close_brace(tail))?)
        };
        Ok(Part::Var {
            name: name.clone(),
            op,
            word,
        })
    };
    let (op, tail) = if let Some(t) = rest.strip_prefix(":-") {
        (ParamOp::Default { colon: true }, t)
    } else if let Some(t) = rest.strip_prefix('-') {
        (ParamOp::Default { colon: false }, t)
    } else if let Some(t) = rest.strip_prefix(":=") {
        (ParamOp::Assign { colon: true }, t)
    } else if let Some(t) = rest.strip_prefix('=') {
        (ParamOp::Assign { colon: false }, t)
    } else if let Some(t) = rest.strip_prefix(":+") {
        (ParamOp::Alternate { colon: true }, t)
    } else if let Some(t) = rest.strip_prefix('+') {
        (ParamOp::Alternate { colon: false }, t)
    } else if let Some(t) = rest.strip_prefix(":?") {
        // `:?` (error when unset) degrades to a default carrying the message.
        (ParamOp::Default { colon: true }, t)
    } else if let Some(t) = rest.strip_prefix("##") {
        return simple(ParamOp::TrimPrefix { longest: true }, t);
    } else if let Some(t) = rest.strip_prefix('#') {
        return simple(ParamOp::TrimPrefix { longest: false }, t);
    } else if let Some(t) = rest.strip_prefix("%%") {
        return simple(ParamOp::TrimSuffix { longest: true }, t);
    } else if let Some(t) = rest.strip_prefix('%') {
        return simple(ParamOp::TrimSuffix { longest: false }, t);
    } else if rest.starts_with('/') && !rest.is_empty() {
        let (all, anchor, body) = if let Some(t) = rest.strip_prefix("//") {
            (true, 0, t)
        } else if let Some(t) = rest.strip_prefix("/#") {
            (false, 1, t)
        } else if let Some(t) = rest.strip_prefix("/%") {
            (false, 2, t)
        } else {
            (false, 0, &rest['/'.len_utf8()..])
        };
        let (pattern, replacement) = split_unescaped(body, '/');
        return Ok(Part::Var {
            name,
            op: ParamOp::Replace { all, anchor },
            word: Some(two_arg_word(&pattern, replacement.as_deref())?),
        });
    } else if let Some(t) = rest.strip_prefix(':') {
        let (offset, length) = split_unescaped(t, ':');
        return Ok(Part::Var {
            name,
            op: ParamOp::Substring,
            word: Some(two_arg_word(&offset, length.as_deref())?),
        });
    } else if let Some(_t) = rest.strip_prefix("^^") {
        return simple(
            ParamOp::Case {
                upper: true,
                all: true,
            },
            "",
        );
    } else if let Some(_t) = rest.strip_prefix('^') {
        return simple(
            ParamOp::Case {
                upper: true,
                all: false,
            },
            "",
        );
    } else if let Some(_t) = rest.strip_prefix(",,") {
        return simple(
            ParamOp::Case {
                upper: false,
                all: true,
            },
            "",
        );
    } else if let Some(_t) = rest.strip_prefix(',') {
        return simple(
            ParamOp::Case {
                upper: false,
                all: false,
            },
            "",
        );
    } else {
        (ParamOp::Plain, "")
    };
    simple(op, tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(source: &str) -> Vec<Word> {
        let out = lex(source).unwrap();
        out.tokens
            .into_iter()
            .filter_map(|tok| match tok {
                Tok::Word(word) => Some(word),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn quoting_survives_into_part_structure() {
        let word = &words(r#"echo 'a b' "c $x" d\ e"#)[1..];
        assert_eq!(word.len(), 3);
        assert!(matches!(&word[0].0[0], Part::Quoted(text) if text == "a b"));
        assert!(matches!(&word[1].0[0], Part::DQuoted(_)));
        // `d\ e` is one word: d, escaped space, e — three parts, no splitting.
        assert_eq!(word[2].0.len(), 3, "{:?}", word[2].0);
    }

    #[test]
    fn dollar_forms_parse_into_their_parts() {
        let word = &words("echo $HOME ${x:-def} $(ls) $((1+2)) $?")[1..];
        assert!(
            matches!(&word[0].0[0], Part::Var { name, op: ParamOp::Plain, .. } if name == "HOME")
        );
        assert!(
            matches!(&word[1].0[0], Part::Var { name, op: ParamOp::Default { .. }, .. } if name == "x")
        );
        assert!(matches!(&word[2].0[0], Part::CmdSub(_)));
        assert!(matches!(&word[3].0[0], Part::Arith(text) if text == "1+2"));
        assert!(matches!(&word[4].0[0], Part::Var { name, .. } if name == "?"));
    }

    #[test]
    fn operators_and_fd_prefixes_tokenize() {
        let out = lex("a && b | c; d 2> f >&2 &").unwrap();
        let ops: Vec<(String, Option<u32>)> = out
            .tokens
            .iter()
            .filter_map(|tok| match tok {
                Tok::Op(op, fd) => Some((op.as_str().to_string(), *fd)),
                _ => None,
            })
            .collect();
        assert_eq!(
            ops,
            vec![
                ("&&".to_owned(), None),
                ("|".to_owned(), None),
                (";".to_owned(), None),
                (">".to_owned(), Some(2)),
                (">&".to_owned(), None),
                ("&".to_owned(), None)
            ]
        );
    }

    #[test]
    fn heredoc_bodies_attach_to_their_operator() {
        let out = lex("cat <<EOF\none\ntwo\nEOF\necho done").unwrap();
        assert_eq!(out.heredocs.len(), 1);
        assert_eq!(out.heredocs[0].content, "one\ntwo\n");
        assert!(out.heredocs[0].expand);
        // The quoted delimiter switches expansion off.
        let out = lex("cat <<'EOF'\n$x\nEOF\n").unwrap();
        assert!(!out.heredocs[0].expand);
        // `<<-` strips the leading tabs.
        let out = lex("cat <<-EOF\n\tindented\n\tEOF\n").unwrap();
        assert_eq!(out.heredocs[0].content, "indented\n");
    }

    #[test]
    fn unterminated_input_is_incomplete_not_fatal() {
        assert!(matches!(lex("echo 'open"), Err(LexError::Incomplete(_))));
        assert!(matches!(lex("echo \"open"), Err(LexError::Incomplete(_))));
        assert!(matches!(
            lex("cat <<EOF\nnever ends"),
            Err(LexError::Incomplete(_))
        ));
        assert!(matches!(lex("echo $(open"), Err(LexError::Incomplete(_))));
    }

    #[test]
    fn comments_and_line_continuations_splice_away() {
        let out = lex("a # trailing comment\nb").unwrap();
        let word_count = out
            .tokens
            .iter()
            .filter(|t| matches!(t, Tok::Word(_)))
            .count();
        assert_eq!(word_count, 2);
        let out = lex("one\\\ntwo").unwrap();
        assert_eq!(out.tokens.len(), 1);
        assert!(matches!(&out.tokens[0], Tok::Word(w) if w.0.len() == 1));
    }
}
