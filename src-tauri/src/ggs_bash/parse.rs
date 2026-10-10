//! The recursive-descent parser: tokens → the AST. Keywords (`if`, `while`, `do`, …)
//! are only keywords in command position — a word like `then` elsewhere stays a plain
//! word — and running out of tokens inside a construct answers `Incomplete`, which the
//! interactive loop reads as "keep typing", while a genuinely malformed line is `Fatal`.

use std::cell::Cell;
use std::sync::Arc;

use super::ast::*;
use super::lex::{lex, HeredocBody, LexError, Op, Tok};

#[derive(Debug)]
pub enum ParseError {
    Incomplete(String),
    Fatal(String),
}

thread_local! {
    /// Nesting depth of `$( … )` through the lexer's recursive parses: a runaway
    /// `((((` line must fail as Fatal, not blow the stack.
    static DEPTH: Cell<usize> = const { Cell::new(0) };
}

pub fn parse_script(source: &str) -> Result<Script, ParseError> {
    let depth = DEPTH.with(Cell::get);
    if depth > 200 {
        return Err(ParseError::Fatal(
            "command substitution nested too deeply".into(),
        ));
    }
    DEPTH.with(|cell| cell.set(depth + 1));
    let result = (|| {
        let out = lex(source).map_err(|error| match error {
            LexError::Incomplete(text) => ParseError::Incomplete(text),
            LexError::Fatal(text) => ParseError::Fatal(text),
        })?;
        let mut parser = Parser {
            toks: out.tokens,
            heredocs: out.heredocs,
            at: 0,
        };
        parser.parse_program()
    })();
    DEPTH.with(|cell| cell.set(depth));
    result
}

/// `true` when the source is a syntactically complete line — the REPL's continuation
/// test for a trailing `if`/heredoc/open quote.
pub fn is_complete(source: &str) -> bool {
    match parse_script(source) {
        Ok(_) => true,
        Err(ParseError::Incomplete(_)) => false,
        Err(ParseError::Fatal(_)) => true,
    }
}

struct Parser {
    toks: Vec<Tok>,
    heredocs: Vec<HeredocBody>,
    at: usize,
}

const KEYWORDS: &[&str] = &[
    "if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac",
    "in", "function", "{", "}", "!", "[[", "]]",
];

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.at)
    }
    fn peek_op(&self) -> Option<(Op, Option<u32>)> {
        match self.peek() {
            Some(Tok::Op(op, fd)) => Some((op.clone(), *fd)),
            _ => None,
        }
    }
    fn next(&mut self) -> Option<Tok> {
        let tok = self.toks.get(self.at).cloned();
        if tok.is_some() {
            self.at += 1;
        }
        tok
    }
    fn peek_keyword(&self) -> Option<String> {
        match self.peek() {
            Some(Tok::Word(word)) => {
                let literal = word.as_literal()?;
                if KEYWORDS.contains(&literal.as_str()) {
                    Some(literal)
                } else {
                    None
                }
            }
            _ => None,
        }
    }
    fn skip_newlines(&mut self) {
        while matches!(self.peek(), Some(Tok::Newline)) {
            self.at += 1;
        }
    }

    fn parse_program(&mut self) -> Result<Script, ParseError> {
        let mut stmts = Vec::new();
        loop {
            self.skip_newlines();
            if self.peek().is_none() {
                return Ok(Script(stmts));
            }
            let mut stmt = self.parse_stmt()?;
            // The separator between top-level statements (none needed at the end).
            match self.peek() {
                None => {
                    stmts.push(stmt);
                    return Ok(Script(stmts));
                }
                Some(Tok::Op(Op::Semi, _)) | Some(Tok::Newline) | Some(Tok::Op(Op::Amp, _)) => {
                    self.consume_separator(&mut stmt);
                }
                Some(Tok::Op(Op::RParen, _)) => {
                    return Err(ParseError::Fatal("unexpected `)`".into()));
                }
                Some(other) => {
                    return Err(ParseError::Fatal(format!(
                        "expected `;` or a newline, found {other:?}"
                    )));
                }
            }
            stmts.push(stmt);
        }
    }

    fn parse_stmt(&mut self) -> Result<Stmt, ParseError> {
        Ok(Stmt {
            body: self.parse_and_or()?,
            background: false,
        })
    }

    /// The `;` / newline / `&` after a statement; `&` marks it background.
    fn consume_separator(&mut self, stmt: &mut Stmt) {
        match self.peek() {
            Some(Tok::Op(Op::Amp, _)) => {
                self.at += 1;
                stmt.background = true;
            }
            Some(Tok::Op(Op::Semi, _)) | Some(Tok::Newline) => {
                self.at += 1;
            }
            _ => {}
        }
    }

    fn parse_and_or(&mut self) -> Result<AndOr, ParseError> {
        let first = self.parse_pipeline()?;
        let mut rest = Vec::new();
        loop {
            let is_and = match self.peek_op() {
                Some((Op::And, _)) => true,
                Some((Op::Or, _)) => false,
                _ => break,
            };
            self.at += 1;
            self.skip_newlines();
            rest.push((is_and, self.parse_pipeline()?));
        }
        Ok(AndOr { first, rest })
    }

    fn parse_pipeline(&mut self) -> Result<Pipeline, ParseError> {
        let mut negated = false;
        if self.peek_keyword().as_deref() == Some("!") {
            self.at += 1;
            negated = true;
        }
        let mut stages = vec![self.parse_stage()?];
        while matches!(self.peek_op(), Some((Op::Pipe, _))) {
            self.at += 1;
            self.skip_newlines();
            stages.push(self.parse_stage()?);
        }
        Ok(Pipeline { negated, stages })
    }

    fn parse_stage(&mut self) -> Result<Stage, ParseError> {
        let (command, redirects) = self.parse_command()?;
        Ok(Stage { redirects, command })
    }

    fn parse_command(&mut self) -> Result<(Command, Vec<Redir>), ParseError> {
        // A subshell opens with `(`.
        if matches!(self.peek_op(), Some((Op::LParen, _))) {
            self.at += 1;
            let body = self.parse_block(&["esac"])?;
            self.expect_op(Op::RParen, "`)` to close the subshell")?;
            let redirects = self.parse_redirects()?;
            return Ok((
                Command::Compound(Compound::Subshell(Arc::new(body))),
                redirects,
            ));
        }
        let keyword = match self.peek_keyword() {
            Some(keyword) => keyword,
            None => return self.parse_simple_command(),
        };
        match keyword.as_str() {
            "if" => self.parse_if(),
            "while" | "until" => {
                self.at += 1;
                let cond = self.parse_block(&["do"])?;
                self.expect_keyword("do")?;
                let body = self.parse_block(&["done"])?;
                self.expect_keyword("done")?;
                let redirects = self.parse_redirects()?;
                Ok((
                    Command::Compound(Compound::While {
                        cond: Arc::new(cond),
                        body: Arc::new(body),
                        until: keyword == "until",
                    }),
                    redirects,
                ))
            }
            "for" => self.parse_for(),
            "case" => self.parse_case(),
            "{" => {
                self.at += 1;
                let body = self.parse_block(&["}"])?;
                self.expect_keyword("}")?;
                let redirects = self.parse_redirects()?;
                Ok((
                    Command::Compound(Compound::Brace(Arc::new(body))),
                    redirects,
                ))
            }
            "function" => {
                self.at += 1;
                self.parse_function()
            }
            "[[" => self.parse_condition(),
            "then" | "elif" | "else" | "fi" | "do" | "done" | "esac" | "in" | "}" | "]]" => {
                Err(ParseError::Fatal(format!("unexpected `{keyword}`")))
            }
            _ => self.parse_simple_command(),
        }
    }

    fn parse_if(&mut self) -> Result<(Command, Vec<Redir>), ParseError> {
        self.at += 1; // `if`
        let cond = self.parse_block(&["then", "elif", "else", "fi"])?;
        self.expect_keyword("then")?;
        let then = self.parse_block(&["elif", "else", "fi"])?;
        let mut elifs = Vec::new();
        let mut otherwise = None;
        loop {
            match self.peek_keyword().as_deref() {
                Some("elif") => {
                    self.at += 1;
                    let cond = self.parse_block(&["then"])?;
                    self.expect_keyword("then")?;
                    let body = self.parse_block(&["elif", "else", "fi"])?;
                    elifs.push((Arc::new(cond), Arc::new(body)));
                }
                Some("else") => {
                    self.at += 1;
                    otherwise = Some(Arc::new(self.parse_block(&["fi"])?));
                }
                Some("fi") => {
                    self.at += 1;
                    break;
                }
                _ => return Err(ParseError::Incomplete("expected elif, else or fi".into())),
            }
        }
        let redirects = self.parse_redirects()?;
        Ok((
            Command::Compound(Compound::If {
                cond: Arc::new(cond),
                then: Arc::new(then),
                elifs,
                otherwise,
            }),
            redirects,
        ))
    }

    fn parse_for(&mut self) -> Result<(Command, Vec<Redir>), ParseError> {
        self.at += 1; // `for`
        if matches!(self.peek(), Some(Tok::Word(w)) if w.as_literal().as_deref() == Some("((")) {
            return self.parse_c_for();
        }
        let Some(Tok::Word(variable)) = self.next() else {
            return Err(ParseError::Fatal(
                "expected a variable name after `for`".into(),
            ));
        };
        let Some(variable) = variable.as_literal() else {
            return Err(ParseError::Fatal(
                "the `for` variable must be a plain name".into(),
            ));
        };
        let mut words = Vec::new();
        if self.peek_keyword().as_deref() == Some("in") {
            self.at += 1;
            loop {
                match self.peek() {
                    Some(Tok::Word(word)) => words.push(word.clone()),
                    Some(Tok::Op(Op::Semi, _)) | Some(Tok::Newline) => break,
                    Some(Tok::Op(
                        Op::Lt | Op::Gt | Op::Append | Op::DupOut | Op::DupIn | Op::Both,
                        _,
                    )) => {
                        // A redirect on the for itself (`for i in *; do ...; done > f`).
                        break;
                    }
                    None => return Err(ParseError::Incomplete("expected `do`".into())),
                    _ => break,
                }
                self.at += 1;
            }
        }
        // The `;` (or newlines) before `do`.
        if matches!(self.peek_op(), Some((Op::Semi, _))) {
            self.at += 1;
        }
        self.skip_newlines();
        self.expect_keyword("do")?;
        let body = self.parse_block(&["done"])?;
        self.expect_keyword("done")?;
        let redirects = self.parse_redirects()?;
        Ok((
            Command::Compound(Compound::For {
                variable,
                words,
                body: Arc::new(body),
            }),
            redirects,
        ))
    }

    /// `for ((init; cond; step)); do … done`.
    fn parse_c_for(&mut self) -> Result<(Command, Vec<Redir>), ParseError> {
        self.at += 1; // the `((` word
        let Some(Tok::Word(expr)) = self.next() else {
            return Err(ParseError::Fatal(
                "expected an expression after `for ((`".into(),
            ));
        };
        let [Part::Arith(text)] = expr.0.as_slice() else {
            return Err(ParseError::Fatal("malformed `for ((` header".into()));
        };
        let pieces: Vec<&str> = text.split(';').collect();
        if pieces.len() != 3 {
            return Err(ParseError::Fatal(
                "`for ((` needs three `;`-separated parts".into(),
            ));
        }
        let arith = |part: &str| -> Result<Script, ParseError> {
            if part.trim().is_empty() {
                Ok(Script(Vec::new()))
            } else {
                parse_script(&format!("(({part}))"))
            }
        };
        let init = arith(pieces[0])?;
        let cond = if pieces[1].trim().is_empty() {
            None
        } else {
            Some(Arc::new(arith(pieces[1])?))
        };
        let step = arith(pieces[2])?;
        if matches!(self.peek_op(), Some((Op::Semi, _))) {
            self.at += 1;
        }
        self.skip_newlines();
        self.expect_keyword("do")?;
        let body = self.parse_block(&["done"])?;
        self.expect_keyword("done")?;
        let redirects = self.parse_redirects()?;
        Ok((
            Command::Compound(Compound::CFor {
                init: Arc::new(init),
                cond,
                step: Arc::new(step),
                body: Arc::new(body),
            }),
            redirects,
        ))
    }

    fn parse_case(&mut self) -> Result<(Command, Vec<Redir>), ParseError> {
        self.at += 1; // `case`
        let Some(Tok::Word(subject)) = self.next() else {
            return Err(ParseError::Fatal("expected a word after `case`".into()));
        };
        self.skip_newlines();
        self.expect_keyword("in")?;
        let mut arms = Vec::new();
        loop {
            self.skip_newlines();
            match self.peek_keyword().as_deref() {
                Some("esac") => {
                    self.at += 1;
                    break;
                }
                None => {}
                _ => return Err(ParseError::Incomplete("expected a pattern or esac".into())),
            }
            let mut patterns = Vec::new();
            loop {
                match self.next() {
                    Some(Tok::Word(word)) => patterns.push(word),
                    Some(Tok::Op(Op::Pipe, _)) => continue,
                    Some(Tok::Op(Op::RParen, _)) => break,
                    Some(Tok::Op(Op::LParen, _)) if patterns.is_empty() => {
                        // `case x in (pat)` — bash accepts a leading paren per arm.
                        continue;
                    }
                    None => return Err(ParseError::Incomplete("expected a pattern".into())),
                    _ => return Err(ParseError::Fatal("expected a pattern".into())),
                }
            }
            if patterns.is_empty() {
                return Err(ParseError::Fatal("empty case pattern".into()));
            }
            let body = self.parse_block(&["esac"])?;
            // `;;` separates arms (the last one may omit it before esac).
            if matches!(self.peek_op(), Some((Op::SemiSemi, _))) {
                self.at += 1;
            }
            arms.push(CaseArm {
                patterns,
                body: Arc::new(body),
            });
        }
        let redirects = self.parse_redirects()?;
        Ok((
            Command::Compound(Compound::Case { subject, arms }),
            redirects,
        ))
    }

    fn parse_function(&mut self) -> Result<(Command, Vec<Redir>), ParseError> {
        let Some(Tok::Word(name_word)) = self.next() else {
            return Err(ParseError::Fatal("expected a function name".into()));
        };
        let Some(name) = name_word.as_literal() else {
            return Err(ParseError::Fatal(
                "the function name must be a plain word".into(),
            ));
        };
        self.expect_op(Op::LParen, "`(` after the function name")?;
        self.expect_op(Op::RParen, "`)` after the function name")?;
        self.skip_newlines();
        let (command, redirects) = self.parse_command()?;
        let body = match command {
            Command::Compound(Compound::Brace(body)) => body,
            Command::Compound(Compound::Subshell(body)) => body,
            _ => return Err(ParseError::Fatal("a function body is `{ … }`".into())),
        };
        Ok((
            Command::Compound(Compound::Function { name, body }),
            redirects,
        ))
    }

    /// `[[ … ]]`: words and operators both stay tokens of the condition.
    fn parse_condition(&mut self) -> Result<(Command, Vec<Redir>), ParseError> {
        self.at += 1; // `[[`
        let mut tokens = Vec::new();
        loop {
            match self.next() {
                Some(Tok::Word(word)) => {
                    if word.as_literal().as_deref() == Some("]]") {
                        break;
                    }
                    tokens.push(CondTok::Word(word));
                }
                Some(Tok::Op(op, _)) => tokens.push(CondTok::Op(op.as_str().to_owned())),
                Some(Tok::Newline) | None => {
                    return Err(ParseError::Incomplete("expected ]]".into()))
                }
            }
        }
        let redirects = self.parse_redirects()?;
        Ok((Command::Condition(tokens), redirects))
    }

    fn parse_simple_command(&mut self) -> Result<(Command, Vec<Redir>), ParseError> {
        let mut assigns: Vec<(String, Word)> = Vec::new();
        let mut words: Vec<Word> = Vec::new();
        let mut redirects: Vec<Redir> = Vec::new();
        loop {
            match self.peek().cloned() {
                Some(Tok::Word(word)) => {
                    // `name()` starts a function definition when a body follows — the
                    // word is still unpushed (parse_function consumes it), and the
                    // check looks one token PAST the word.
                    if words.is_empty()
                        && assigns.is_empty()
                        && matches!(self.toks.get(self.at + 1), Some(Tok::Op(Op::LParen, _)))
                    {
                        return self.parse_function();
                    }
                    self.at += 1;
                    // A `NAME=value` prefix (only before the command word).
                    if words.is_empty() {
                        if let Some((name, value)) = split_assignment(&word) {
                            assigns.push((name, value));
                            continue;
                        }
                    }
                    words.push(word);
                }
                Some(Tok::Op(Op::ProcIn, _)) | Some(Tok::Op(Op::ProcOut, _)) => {
                    // An argument-shaped process substitution: a word of one part.
                    let part = self.parse_proc_sub()?;
                    words.push(Word(vec![part]));
                }
                Some(Tok::Op(op, fd)) if is_redirect(&op) => {
                    self.at += 1;
                    redirects.push(self.parse_redirect(op, fd)?);
                }
                _ => break,
            }
        }
        if words.is_empty() && assigns.is_empty() && redirects.is_empty() {
            if self.peek().is_none() {
                // A pipeline that never delivered its next command.
                return Err(ParseError::Incomplete("expected a command".into()));
            }
            return Err(ParseError::Fatal("expected a command".into()));
        }
        Ok((Command::Simple(SimpleCommand { assigns, words }), redirects))
    }

    fn parse_redirects(&mut self) -> Result<Vec<Redir>, ParseError> {
        let mut redirects = Vec::new();
        while let Some((op, fd)) = self.peek_op() {
            if !is_redirect(&op) {
                break;
            }
            self.at += 1;
            redirects.push(self.parse_redirect(op, fd)?);
        }
        Ok(redirects)
    }

    fn parse_redirect(&mut self, op: Op, fd: Option<u32>) -> Result<Redir, ParseError> {
        match op {
            Op::Heredoc { id, dedent } => {
                let body = self.heredocs.get(id).cloned().unwrap_or(HeredocBody {
                    content: String::new(),
                    expand: true,
                });
                Ok(Redir {
                    fd,
                    op: if dedent {
                        RedirOp::HeredocStrip
                    } else {
                        RedirOp::Heredoc
                    },
                    target: RedirTarget::Heredoc {
                        content: Arc::new(body.content),
                        expand: body.expand,
                    },
                })
            }
            Op::Herestring => {
                let target = self.redirect_target_word("a word after <<<")?;
                Ok(Redir {
                    fd,
                    op: RedirOp::Herestring,
                    target: RedirTarget::Word(target),
                })
            }
            Op::DupOut | Op::DupIn => {
                // `>&2` (a digit) or `>&name`.
                if let Some(Tok::Word(word)) = self.peek().cloned() {
                    if let [Part::Lit(text)] = word.0.as_slice() {
                        if let Ok(to) = text.parse::<u32>() {
                            self.at += 1;
                            return Ok(Redir {
                                fd,
                                op: RedirOp::Dup,
                                target: RedirTarget::Fd(to),
                            });
                        }
                    }
                }
                let target = self.redirect_target_word("a word after the duplication")?;
                Ok(Redir {
                    fd,
                    op: RedirOp::Dup,
                    target: RedirTarget::Word(target),
                })
            }
            Op::Lt => Ok(Redir {
                fd,
                op: RedirOp::Input,
                target: RedirTarget::Word(self.redirect_target_word("a file after <")?),
            }),
            Op::Gt | Op::Append => {
                let op = if matches!(op, Op::Append) {
                    RedirOp::Append
                } else {
                    RedirOp::Output
                };
                Ok(Redir {
                    fd,
                    op,
                    target: RedirTarget::Word(self.redirect_target_word("a file after >")?),
                })
            }
            Op::Both => Ok(Redir {
                fd: None,
                op: RedirOp::Both,
                target: RedirTarget::Word(self.redirect_target_word("a file after &>")?),
            }),
            other => Err(ParseError::Fatal(format!(
                "{} is not a redirection",
                other.as_str()
            ))),
        }
    }

    fn redirect_target_word(&mut self, what: &str) -> Result<Word, ParseError> {
        match self.next() {
            Some(Tok::Word(word)) => Ok(word),
            Some(Tok::Op(Op::ProcIn | Op::ProcOut, _)) => {
                self.at -= 1; // put the marker back; parse_proc_sub consumes it
                Ok(Word(vec![self.parse_proc_sub()?]))
            }
            Some(Tok::Op(Op::LParen, _)) => Err(ParseError::Fatal(
                "process substitution (<(cmd)) is not supported".into(),
            )),
            Some(Tok::Newline) | None => Err(ParseError::Incomplete(format!("expected {what}"))),
            Some(other) => Err(ParseError::Fatal(format!(
                "expected {what}, found {other:?}"
            ))),
        }
    }

    /// `<( script )` / `>( script )`: the body up to the matching `)`.
    fn parse_proc_sub(&mut self) -> Result<super::ast::Part, ParseError> {
        let out = matches!(self.peek_op(), Some((Op::ProcOut, _)));
        self.at += 1; // the marker
        let body = self.parse_block(&["esac"])?;
        self.expect_op(Op::RParen, "`)` to close the process substitution")?;
        Ok(super::ast::Part::ProcSub(body, out))
    }

    fn expect_op(&mut self, op: Op, what: &str) -> Result<(), ParseError> {
        match self.peek_op() {
            Some((found, _)) if found == op => {
                self.at += 1;
                Ok(())
            }
            Some((_, _)) => Err(ParseError::Fatal(format!("expected {what}"))),
            None => Err(ParseError::Incomplete(format!("expected {what}"))),
        }
    }

    fn expect_keyword(&mut self, keyword: &str) -> Result<(), ParseError> {
        if self.peek_keyword().as_deref() == Some(keyword) {
            self.at += 1;
            Ok(())
        } else if self.peek().is_none() {
            Err(ParseError::Incomplete(format!("expected `{keyword}`")))
        } else {
            Err(ParseError::Fatal(format!("expected `{keyword}`")))
        }
    }

    /// Statements until a stop keyword (not consumed), `)`, `;;` or the end.
    fn parse_block(&mut self, stops: &[&str]) -> Result<Script, ParseError> {
        let mut stmts = Vec::new();
        loop {
            self.skip_newlines();
            if let Some(keyword) = self.peek_keyword() {
                if stops.contains(&keyword.as_str()) || keyword == "esac" || keyword == "}" {
                    return Ok(Script(stmts));
                }
            }
            match self.peek() {
                None => {
                    return Err(ParseError::Incomplete(format!(
                        "expected one of {}",
                        stops.join(", ")
                    )))
                }
                Some(Tok::Op(Op::RParen, _)) | Some(Tok::Op(Op::SemiSemi, _)) => {
                    return Ok(Script(stmts))
                }
                _ => {}
            }
            let mut stmt = self.parse_stmt()?;
            // A statement ends at a separator, a stop token or the construct's close;
            // anything else here is a missing `;`.
            match self.peek() {
                Some(Tok::Op(Op::Semi, _)) | Some(Tok::Newline) | Some(Tok::Op(Op::Amp, _)) => {
                    self.consume_separator(&mut stmt);
                }
                _ => {}
            }
            stmts.push(stmt);
        }
    }
}

fn is_redirect(op: &Op) -> bool {
    matches!(
        op,
        Op::Lt
            | Op::Gt
            | Op::Append
            | Op::DupOut
            | Op::DupIn
            | Op::Both
            | Op::Heredoc { .. }
            | Op::Herestring
    )
}

/// `NAME=value…` — a leading literal `name=` splits the word. `None` when the word is
/// not an assignment.
fn split_assignment(word: &Word) -> Option<(String, Word)> {
    split_plain_assignment(word).or_else(|| split_subscripted_assignment(word))
}

/// `name[$i]=value` — a subscript spread over several parts. The name comes back as
/// `name[]` (or `name[]+`) and the value word carries the subscript parts, a `Sep`,
/// then the value parts (see `Shell::assign`).
fn split_subscripted_assignment(word: &Word) -> Option<(String, Word)> {
    let [Part::Lit(first), rest @ ..] = word.0.as_slice() else {
        return None;
    };
    let open = first.find('[')?;
    let base = &first[..open];
    if base.is_empty()
        || !base.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        || !base.chars().next()?.is_ascii_alphabetic() && base != "_"
        || first.contains(']')
    {
        return None;
    }
    let mut subscript = vec![Part::Lit(first[open + 1..].to_owned())];
    for (offset, part) in rest.iter().enumerate() {
        match part {
            Part::Lit(text) if text.contains(']') => {
                let close = text.find(']')?;
                subscript.push(Part::Lit(text[..close].to_owned()));
                let after = &text[close + 1..];
                let (append, after) = match after.strip_prefix('+') {
                    Some(tail) => (true, tail),
                    None => (false, after),
                };
                let value_text = after.strip_prefix('=')?;
                let mut parts = subscript;
                parts.push(Part::Sep);
                if !value_text.is_empty() {
                    parts.push(Part::Lit(value_text.to_owned()));
                }
                parts.extend(rest[offset + 1..].iter().cloned());
                let name = format!("{base}[]{}", if append { "+" } else { "" });
                return Some((name, Word(parts)));
            }
            other => subscript.push(other.clone()),
        }
    }
    None
}

fn split_plain_assignment(word: &Word) -> Option<(String, Word)> {
    let [Part::Lit(text), rest @ ..] = word.0.as_slice() else {
        return None;
    };
    let equals = text.find('=')?;
    let (name, first) = text.split_at(equals);
    // `name`, `name+`, `name[sub]`, `name[sub]+` — `+` marks an append (`+=`).
    let bare = name.strip_suffix('+').unwrap_or(name);
    let (base, subscript_ok) = match bare.find('[') {
        Some(open) => (&bare[..open], bare.ends_with(']')),
        None => (bare, true),
    };
    if base.is_empty()
        || !subscript_ok
        || !base.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        || !base.chars().next()?.is_ascii_alphabetic() && base != "_"
    {
        return None;
    }
    let mut parts = Vec::new();
    if first.len() > 1 {
        parts.push(Part::Lit(first[1..].to_owned()));
    }
    parts.extend(rest.iter().cloned());
    Some((name.to_owned(), Word(parts)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(source: &str) -> Script {
        parse_script(source).unwrap()
    }

    fn command_of(source: &str) -> Command {
        let Script(mut stmts) = script(source);
        assert_eq!(
            stmts.len(),
            1,
            "{source:?} parsed to {} statements",
            stmts.len()
        );
        stmts.remove(0).body.first.stages.remove(0).command
    }

    #[test]
    fn simple_commands_split_assignments_and_words() {
        let Command::Simple(simple) = command_of("x=1 y='a b' echo hi \"$x\"") else {
            panic!("not simple");
        };
        assert_eq!(simple.assigns.len(), 2);
        assert_eq!(simple.assigns[0].0, "x");
        assert_eq!(simple.words.len(), 3);
        // An assignment-looking word after the command word stays a word.
        let Command::Simple(simple) = command_of("echo a=1") else {
            panic!()
        };
        assert!(simple.assigns.is_empty());
        assert_eq!(simple.words.len(), 2);
    }

    #[test]
    fn pipelines_and_chains_parse() {
        let Script(mut stmts) = script("a && b || c | d");
        let and_or = stmts.remove(0).body;
        assert_eq!(and_or.rest.len(), 2);
        assert!(and_or.rest[0].0);
        assert!(!and_or.rest[1].0);
        assert_eq!(and_or.rest[1].1.stages.len(), 2);
        let Script(stmts) = script("! false");
        assert!(stmts[0].body.first.negated);
    }

    #[test]
    fn redirects_parse_with_fds_and_heredocs() {
        let Script(mut stmts) = script("cmd >out 2>>err <in &>both 2>&1 <<EOF\nbody\nEOF");
        let stage = &stmts.remove(0).body.first.stages[0];
        assert_eq!(stage.redirects.len(), 6);
        assert!(matches!(
            stage.redirects[0],
            Redir {
                op: RedirOp::Output,
                fd: None,
                ..
            }
        ));
        assert!(matches!(
            stage.redirects[1],
            Redir {
                op: RedirOp::Append,
                fd: Some(2),
                ..
            }
        ));
        assert!(matches!(
            stage.redirects[3],
            Redir {
                op: RedirOp::Both,
                ..
            }
        ));
        assert!(matches!(
            stage.redirects[4],
            Redir {
                op: RedirOp::Dup,
                target: RedirTarget::Fd(1),
                fd: Some(2)
            }
        ));
        assert!(
            matches!(&stage.redirects[5], Redir { op: RedirOp::Heredoc, target: RedirTarget::Heredoc { content, expand: true }, .. } if content.as_str() == "body\n")
        );
    }

    #[test]
    fn control_flow_parses_with_nested_constructs() {
        let Command::Compound(Compound::If {
            cond,
            then,
            elifs,
            otherwise,
        }) = command_of("if true; then echo a; elif false; then echo b; else echo c; fi")
        else {
            panic!("not an if");
        };
        assert_eq!(cond.0.len(), 1);
        assert_eq!(then.0.len(), 1);
        assert_eq!(elifs.len(), 1);
        assert!(otherwise.is_some());

        let Command::Compound(Compound::For {
            variable,
            words,
            body,
        }) = command_of("for f in *.txt one two; do echo $f; done")
        else {
            panic!("not a for");
        };
        assert_eq!(variable, "f");
        assert_eq!(words.len(), 3);
        assert_eq!(body.0.len(), 1);

        let Command::Compound(Compound::While { until, .. }) =
            command_of("until false; do :; done")
        else {
            panic!("not a loop");
        };
        assert!(until);

        let Command::Compound(Compound::Case { arms, .. }) =
            command_of("case $x in a|b) echo one ;; *) echo two ;; esac")
        else {
            panic!("not a case");
        };
        assert_eq!(arms.len(), 2);
        assert_eq!(arms[0].patterns.len(), 2);
    }

    #[test]
    fn functions_and_groups_parse() {
        let Command::Compound(Compound::Function { name, body }) =
            command_of("greet() { echo hi; }")
        else {
            panic!("not a function");
        };
        assert_eq!(name, "greet");
        assert_eq!(body.0.len(), 1);
        let Command::Compound(Compound::Subshell(_)) = command_of("( cd /tmp && ls )") else {
            panic!("not a subshell");
        };
        let Command::Compound(Compound::Brace(_)) = command_of("{ echo a; echo b; }") else {
            panic!("not a brace group");
        };
    }

    #[test]
    fn conditions_keep_their_operator_tokens() {
        let Command::Condition(tokens) = command_of("[[ -f $x && $y == z* ]]") else {
            panic!("not a condition");
        };
        assert!(tokens
            .iter()
            .any(|t| matches!(t, CondTok::Op(op) if op == "&&")));
    }

    #[test]
    fn incomplete_constructs_answer_incomplete() {
        assert!(matches!(
            parse_script("if true; then echo"),
            Err(ParseError::Incomplete(_))
        ));
        assert!(matches!(
            parse_script("for i in 1 2"),
            Err(ParseError::Incomplete(_))
        ));
        assert!(matches!(
            parse_script("while true; do :"),
            Err(ParseError::Incomplete(_))
        ));
        assert!(matches!(
            parse_script("case $x in a) echo"),
            Err(ParseError::Incomplete(_))
        ));
        assert!(matches!(
            parse_script("{ echo a"),
            Err(ParseError::Incomplete(_))
        ));
        assert!(matches!(
            parse_script("echo hi |"),
            Err(ParseError::Incomplete(_))
        ));
        // A genuinely bad line is fatal, so the REPL does not wait for more.
        assert!(matches!(
            parse_script("echo hi )"),
            Err(ParseError::Fatal(_))
        ));
    }

    #[test]
    fn newlines_and_continuations_are_flexible() {
        let Script(stmts) = script("a\n\nb;\nc &&\nd\n");
        // `c &&` followed by a newline is one statement - bash folds it.
        assert_eq!(stmts.len(), 3);
        let Script(stmts) = script("if true\nthen echo hi\nfi");
        assert_eq!(stmts.len(), 1);
    }

    #[test]
    fn process_substitution_parses_as_an_argument_word() {
        // `cat <(ls)` is one command with a process-substitution argument.
        let Command::Simple(simple) = command_of("cat <(ls)") else {
            panic!()
        };
        assert_eq!(simple.words.len(), 2);
        assert!(matches!(&simple.words[1].0[0], Part::ProcSub(_, false)));
        // The redirect shape carries it too: `diff a <(echo x)`.
        let Script(mut stmts) = parse_script("diff a <(echo x)").unwrap();
        let _stage = stmts.remove(0).body.first.stages.remove(0);
        assert!(matches!(&simple.words[1].0[0], Part::ProcSub(_, _)));
    }
}
