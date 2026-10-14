//! Shell arithmetic (module 18): the evaluator behind `$(( ))`, `(( ))`, `let`, array
//! subscripts and the `${x:off:len}` operands. C semantics over `i64`: the full operator
//! set (`** * / % + - << >> < <= > >= == != & ^ | && || ?: , =` and the compound
//! assignments), pre/post `++`/`--`, `!` and `~`, hex / octal / decimal literals, and
//! variables or array elements as lvalues (`a[i]++`, `n += 2`). The expression is parsed
//! to a tree first so `&&`, `||` and `?:` short-circuit and an assignment on the
//! untaken side never runs.

use super::exec::{ExecError, Io, Shell};

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(i64),
    /// A variable or `name[subscript]` (the subscript kept as raw text).
    Name(String),
    Op(&'static str),
}

const OPERATORS: &[&str] = &[
    "<<=", ">>=", "**", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>",
    "<=", ">=", "==", "!=", "&&", "||", "+", "-", "*", "/", "%", "(", ")", "<", ">", "=", "!", "&",
    "|", "^", "~", "?", ":", ",",
];

fn tokenize(text: &str) -> Result<Vec<Tok>, ExecError> {
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        if c.is_whitespace() {
            at += 1;
        } else if c == '$' {
            // `$x` / `${x}` inside arithmetic is the variable itself; the special
            // parameters keep their special name (`$1`, `$$`, `$?`, `$#`) instead of
            // lexing as a number or an operator once the `$` is gone.
            at += 1;
            if chars.get(at) == Some(&'{') {
                at += 1;
                let start = at;
                while at < chars.len() && chars[at] != '}' {
                    at += 1;
                }
                tokens.push(Tok::Name(chars[start..at].iter().collect()));
                at += 1;
            } else if let Some(next) = chars.get(at) {
                if next.is_ascii_digit() || matches!(next, '?' | '#' | '$' | '!' | '@' | '*') {
                    at += 1;
                    tokens.push(Tok::Name(next.to_string()));
                }
            }
        } else if c.is_ascii_digit() {
            let start = at;
            while at < chars.len() && (chars[at].is_ascii_alphanumeric()) {
                at += 1;
            }
            let word: String = chars[start..at].iter().collect();
            tokens.push(Tok::Num(parse_number(&word)?));
        } else if c.is_ascii_alphabetic() || c == '_' {
            let start = at;
            while at < chars.len() && (chars[at].is_ascii_alphanumeric() || chars[at] == '_') {
                at += 1;
            }
            if chars.get(at) == Some(&'[') {
                // Keep the whole subscript, nested brackets included.
                let mut depth = 0;
                while at < chars.len() {
                    match chars[at] {
                        '[' => depth += 1,
                        ']' => {
                            depth -= 1;
                            if depth == 0 {
                                at += 1;
                                break;
                            }
                        }
                        _ => {}
                    }
                    at += 1;
                }
            }
            tokens.push(Tok::Name(chars[start..at].iter().collect()));
        } else {
            let rest: String = chars[at..chars.len().min(at + 3)].iter().collect();
            let Some(op) = OPERATORS.iter().find(|op| rest.starts_with(**op)) else {
                return Err(ExecError::Io(format!("bad character `{c}` in arithmetic")));
            };
            tokens.push(Tok::Op(op));
            at += op.len();
        }
    }
    Ok(tokens)
}

fn parse_number(word: &str) -> Result<i64, ExecError> {
    let bad = || ExecError::Io(format!("bad number {word}"));
    if let Some(hex) = word.strip_prefix("0x").or_else(|| word.strip_prefix("0X")) {
        return i64::from_str_radix(hex, 16).map_err(|_| bad());
    }
    if word.len() > 1 && word.starts_with('0') {
        return i64::from_str_radix(&word[1..], 8).map_err(|_| bad());
    }
    if let Some((base, digits)) = word.split_once('#') {
        let base: u32 = base.parse().map_err(|_| bad())?;
        return i64::from_str_radix(digits, base).map_err(|_| bad());
    }
    word.parse().map_err(|_| bad())
}

#[derive(Debug, Clone)]
enum Expr {
    Num(i64),
    Var(String),
    Unary(&'static str, Box<Expr>),
    /// `++x` / `--x` (`post` false) and `x++` / `x--` (`post` true).
    Step {
        target: String,
        delta: i64,
        post: bool,
    },
    Binary(&'static str, Box<Expr>, Box<Expr>),
    Assign(&'static str, String, Box<Expr>),
    Ternary(Box<Expr>, Box<Expr>, Box<Expr>),
    Comma(Box<Expr>, Box<Expr>),
}

struct Parser {
    tokens: Vec<Tok>,
    at: usize,
}

fn syntax(message: &str) -> ExecError {
    ExecError::Io(format!("arithmetic: {message}"))
}

impl Parser {
    fn peek_op(&self) -> Option<&'static str> {
        match self.tokens.get(self.at) {
            Some(Tok::Op(op)) => Some(op),
            _ => None,
        }
    }

    fn eat(&mut self, op: &str) -> bool {
        if self.peek_op() == Some(op) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn comma(&mut self) -> Result<Expr, ExecError> {
        let mut left = self.assignment()?;
        while self.eat(",") {
            let right = self.assignment()?;
            left = Expr::Comma(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn assignment(&mut self) -> Result<Expr, ExecError> {
        let left = self.ternary()?;
        if let (Expr::Var(name), Some(op)) = (&left, self.peek_op()) {
            if matches!(
                op,
                "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "<<=" | ">>=" | "&=" | "|=" | "^="
            ) {
                self.at += 1;
                let right = self.assignment()?;
                return Ok(Expr::Assign(op, name.clone(), Box::new(right)));
            }
        }
        Ok(left)
    }

    fn ternary(&mut self) -> Result<Expr, ExecError> {
        let cond = self.binary(0)?;
        if self.eat("?") {
            let yes = self.assignment()?;
            if !self.eat(":") {
                return Err(syntax("expected `:` in a conditional"));
            }
            let no = self.assignment()?;
            return Ok(Expr::Ternary(Box::new(cond), Box::new(yes), Box::new(no)));
        }
        Ok(cond)
    }

    /// Left-associative binary levels, loosest first.
    fn binary(&mut self, level: usize) -> Result<Expr, ExecError> {
        const LEVELS: &[&[&str]] = &[
            &["||"],
            &["&&"],
            &["|"],
            &["^"],
            &["&"],
            &["==", "!="],
            &["<", "<=", ">", ">="],
            &["<<", ">>"],
            &["+", "-"],
            &["*", "/", "%"],
        ];
        if level == LEVELS.len() {
            return self.power();
        }
        let mut left = self.binary(level + 1)?;
        while let Some(op) = self.peek_op() {
            if !LEVELS[level].contains(&op) {
                break;
            }
            self.at += 1;
            let right = self.binary(level + 1)?;
            left = Expr::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn power(&mut self) -> Result<Expr, ExecError> {
        let base = self.unary()?;
        if self.eat("**") {
            // Right-associative, binds tighter than the unary on its left.
            let exponent = self.power()?;
            return Ok(Expr::Binary("**", Box::new(base), Box::new(exponent)));
        }
        Ok(base)
    }

    fn unary(&mut self) -> Result<Expr, ExecError> {
        match self.peek_op() {
            Some(op @ ("-" | "+" | "!" | "~")) => {
                self.at += 1;
                Ok(Expr::Unary(op, Box::new(self.unary()?)))
            }
            Some(op @ ("++" | "--")) => {
                self.at += 1;
                match self.tokens.get(self.at).cloned() {
                    Some(Tok::Name(name)) => {
                        self.at += 1;
                        Ok(Expr::Step {
                            target: name,
                            delta: if op == "++" { 1 } else { -1 },
                            post: false,
                        })
                    }
                    _ => Err(syntax("`++`/`--` needs a variable")),
                }
            }
            _ => self.postfix(),
        }
    }

    fn postfix(&mut self) -> Result<Expr, ExecError> {
        match self.tokens.get(self.at).cloned() {
            Some(Tok::Num(n)) => {
                self.at += 1;
                Ok(Expr::Num(n))
            }
            Some(Tok::Name(name)) => {
                self.at += 1;
                match self.peek_op() {
                    Some(op @ ("++" | "--")) => {
                        self.at += 1;
                        Ok(Expr::Step {
                            target: name,
                            delta: if op == "++" { 1 } else { -1 },
                            post: true,
                        })
                    }
                    _ => Ok(Expr::Var(name)),
                }
            }
            Some(Tok::Op("(")) => {
                self.at += 1;
                let inner = self.comma()?;
                if !self.eat(")") {
                    return Err(syntax("missing `)`"));
                }
                Ok(inner)
            }
            Some(Tok::Op(op)) => Err(syntax(&format!("unexpected `{op}`"))),
            None => Err(syntax("expression ended early")),
        }
    }
}

fn read_var(shell: &mut Shell, io: &Io, name: &str, depth: usize) -> Result<i64, ExecError> {
    let raw = super::expand::variable_text(shell, name, io)?;
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(0);
    }
    match parse_number(raw.trim_start_matches('-')) {
        Ok(value) => Ok(if raw.starts_with('-') { -value } else { value }),
        // A variable holding an expression evaluates recursively (bounded).
        Err(_) if depth < 16 => eval_depth(shell, io, raw, depth + 1),
        Err(_) => Err(syntax("expression recursion level exceeded")),
    }
}

fn write_var(shell: &mut Shell, io: &Io, name: &str, value: i64) -> Result<(), ExecError> {
    shell.assign(name, &super::ast::Word::literal(&value.to_string()), io)
}

fn eval(shell: &mut Shell, io: &Io, expr: &Expr, depth: usize) -> Result<i64, ExecError> {
    Ok(match expr {
        Expr::Num(n) => *n,
        Expr::Var(name) => read_var(shell, io, name, depth)?,
        Expr::Unary(op, inner) => {
            let value = eval(shell, io, inner, depth)?;
            match *op {
                "-" => value.wrapping_neg(),
                "+" => value,
                "!" => i64::from(value == 0),
                _ => !value,
            }
        }
        Expr::Step {
            target,
            delta,
            post,
        } => {
            let old = read_var(shell, io, target, depth)?;
            let new = old.wrapping_add(*delta);
            write_var(shell, io, target, new)?;
            if *post {
                old
            } else {
                new
            }
        }
        Expr::Assign(op, target, rhs) => {
            let right = eval(shell, io, rhs, depth)?;
            let value = if *op == "=" {
                right
            } else {
                let old = read_var(shell, io, target, depth)?;
                apply(&op[..op.len() - 1], old, right)?
            };
            write_var(shell, io, target, value)?;
            value
        }
        Expr::Ternary(cond, yes, no) => {
            if eval(shell, io, cond, depth)? != 0 {
                eval(shell, io, yes, depth)?
            } else {
                eval(shell, io, no, depth)?
            }
        }
        Expr::Comma(left, right) => {
            eval(shell, io, left, depth)?;
            eval(shell, io, right, depth)?
        }
        Expr::Binary("&&", left, right) => {
            i64::from(eval(shell, io, left, depth)? != 0 && eval(shell, io, right, depth)? != 0)
        }
        Expr::Binary("||", left, right) => {
            i64::from(eval(shell, io, left, depth)? != 0 || eval(shell, io, right, depth)? != 0)
        }
        Expr::Binary(op, left, right) => {
            let left = eval(shell, io, left, depth)?;
            let right = eval(shell, io, right, depth)?;
            apply(op, left, right)?
        }
    })
}

fn apply(op: &str, left: i64, right: i64) -> Result<i64, ExecError> {
    Ok(match op {
        "+" => left.wrapping_add(right),
        "-" => left.wrapping_sub(right),
        "*" => left.wrapping_mul(right),
        "/" | "%" => {
            if right == 0 {
                return Err(syntax("division by zero"));
            }
            if op == "/" {
                left.wrapping_div(right)
            } else {
                left.wrapping_rem(right)
            }
        }
        "**" => {
            if right < 0 {
                return Err(syntax("exponent less than 0"));
            }
            left.wrapping_pow(right.min(u32::MAX as i64) as u32)
        }
        "<<" => left.wrapping_shl(right as u32),
        ">>" => left.wrapping_shr(right as u32),
        "<" => i64::from(left < right),
        "<=" => i64::from(left <= right),
        ">" => i64::from(left > right),
        ">=" => i64::from(left >= right),
        "==" => i64::from(left == right),
        "!=" => i64::from(left != right),
        "&" => left & right,
        "|" => left | right,
        "^" => left ^ right,
        other => return Err(syntax(&format!("unknown operator {other}"))),
    })
}

fn eval_depth(shell: &mut Shell, io: &Io, text: &str, depth: usize) -> Result<i64, ExecError> {
    if text.trim().is_empty() {
        return Ok(0);
    }
    let mut parser = Parser {
        tokens: tokenize(text)?,
        at: 0,
    };
    let tree = parser.comma()?;
    if parser.at != parser.tokens.len() {
        return Err(syntax("trailing tokens"));
    }
    eval(shell, io, &tree, depth)
}

/// Evaluate `text` as a shell arithmetic expression.
pub fn eval_arith(shell: &mut Shell, text: &str, io: &Io) -> Result<i64, ExecError> {
    eval_depth(shell, io, text, 0)
}

#[cfg(test)]
mod tests {
    use super::super::tests::{capture_io, shell_in};
    use super::*;

    fn run(shell: &mut Shell, text: &str) -> i64 {
        let captured = capture_io();
        eval_arith(shell, text, &captured.io).unwrap()
    }

    #[test]
    fn operators_follow_c_precedence() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut shell = shell_in(dir.path());
        assert_eq!(run(&mut shell, "2 + 3 * 4"), 14);
        assert_eq!(run(&mut shell, "(2 + 3) * 4 - 1"), 19);
        assert_eq!(run(&mut shell, "2 ** 3 ** 2"), 512);
        assert_eq!(run(&mut shell, "1 << 4 | 3"), 19);
        assert_eq!(run(&mut shell, "0xff & 0x0f ^ 1"), 14);
        assert_eq!(run(&mut shell, "010 + 1"), 9);
        assert_eq!(run(&mut shell, "~0"), -1);
        assert_eq!(run(&mut shell, "7 > 3 && 2 >= 2 || 0"), 1);
        assert_eq!(run(&mut shell, "1 ? 10 : 20"), 10);
        assert_eq!(run(&mut shell, "0 ? 10 : 1 ? 30 : 40"), 30);
        assert_eq!(run(&mut shell, "-7 / 2 + -7 % 3"), -4);
        assert_eq!(run(&mut shell, "1, 2, 3"), 3);
    }

    #[test]
    fn assignments_steps_and_short_circuits_touch_variables() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut shell = shell_in(dir.path());
        assert_eq!(run(&mut shell, "x = 5"), 5);
        assert_eq!(run(&mut shell, "x += 3"), 8);
        assert_eq!(run(&mut shell, "x++ + ++x"), 8 + 10);
        assert_eq!(shell.get_var("x").as_deref(), Some("10"));
        assert_eq!(run(&mut shell, "y = x <<= 1"), 20);
        assert_eq!(shell.get_var("y").as_deref(), Some("20"));
        // The untaken side of && / ?: never runs.
        assert_eq!(run(&mut shell, "0 && (z = 9)"), 0);
        assert_eq!(shell.get_var("z"), None);
        assert_eq!(run(&mut shell, "1 ? (w = 1) : (z = 2)"), 1);
        assert_eq!(shell.get_var("z"), None);
        assert_eq!(run(&mut shell, "undefined_var + 1"), 1);
    }
}
