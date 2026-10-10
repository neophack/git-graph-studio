//! The `awk` applet — a working subset of the language, not a stub: patterns and
//! actions (`BEGIN`/`END` included), `$n` fields with assignment, associative arrays
//! (`count[$1]++` — the classic), arithmetic and string expressions with awk's
//! number-or-string values, `print`/`printf` (with `>` redirection), `sub`/`gsub`,
//! `split`/`substr`/`index`/`sprintf`, `if`/`while`/`for`/`for-in`, `next`, `exit`,
//! `-F` and `-v`. Not implemented: user-defined functions, `getline`, `system`,
//! multi-char `RS`, ranges — an unsupported construct fails with an error naming it.
//! Git Bash ships gawk; this is the subset AI-written one-liners actually use.

use std::collections::HashMap;

use super::exec::{ExecResult, Io, Shell};
use super::regexlite::Regex;

/* ---------- Values ---------- */

#[derive(Debug, Clone)]
pub enum Val {
    Num(f64),
    Str(String),
}

impl Val {
    fn num(value: f64) -> Val {
        Val::Num(value)
    }
    fn str(text: &str) -> Val {
        Val::Str(text.to_owned())
    }
    fn to_num(&self) -> f64 {
        match self {
            Val::Num(n) => *n,
            Val::Str(text) => numeric_prefix(text.trim()),
        }
    }
    fn to_str(&self) -> String {
        match self {
            Val::Num(n) => format_number(*n),
            Val::Str(text) => text.clone(),
        }
    }
    fn truthy(&self) -> bool {
        match self {
            Val::Num(n) => *n != 0.0,
            Val::Str(text) => !text.is_empty() && text != "0",
        }
    }
}

fn numeric_prefix(text: &str) -> f64 {
    let bytes: Vec<char> = text.chars().collect();
    let mut end = 0;
    let mut seen_digit = false;
    let mut seen_dot = false;
    let mut index = 0;
    if index < bytes.len() && (bytes[index] == '+' || bytes[index] == '-') {
        index += 1;
    }
    while index < bytes.len() {
        let c = bytes[index];
        if c.is_ascii_digit() {
            seen_digit = true;
        } else if c == '.' && !seen_dot {
            seen_dot = true;
        } else {
            break;
        }
        index += 1;
        end = index;
    }
    if !seen_digit {
        return 0.0;
    }
    // An exponent tail (1e3) belongs to the number.
    if index < bytes.len() && (bytes[index] == 'e' || bytes[index] == 'E') {
        let mut scan = index + 1;
        if scan < bytes.len() && (bytes[scan] == '+' || bytes[scan] == '-') {
            scan += 1;
        }
        let mut exponent_digits = false;
        while scan < bytes.len() && bytes[scan].is_ascii_digit() {
            scan += 1;
            exponent_digits = true;
        }
        if exponent_digits {
            end = scan;
        }
    }
    let candidate: String = bytes[..end].iter().collect();
    candidate.parse().unwrap_or(0.0)
}

fn looks_numeric(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    numeric_prefix(trimmed).to_string() == trimmed || trimmed.parse::<f64>().is_ok()
}

fn format_number(value: f64) -> String {
    if value == value.trunc() && value.abs() < 1e16 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

/* ---------- The AST ---------- */

#[derive(Debug, Clone)]
enum Expr {
    Num(f64),
    Str(String),
    Var(String),
    Field(Box<Expr>),
    Index {
        name: String,
        key: Box<Expr>,
    },
    Regex(String),
    Binary {
        op: BinOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Unary {
        op: UnOp,
        operand: Box<Expr>,
    },
    Assign {
        target: Box<Expr>,
        value: Box<Expr>,
    },
    Incr {
        target: Box<Expr>,
        delta: f64,
    },
    PreIncr {
        target: Box<Expr>,
        delta: f64,
    },
    Ternary {
        cond: Box<Expr>,
        then: Box<Expr>,
        otherwise: Box<Expr>,
    },
    In {
        key: Box<Expr>,
        array: String,
    },
    Call {
        name: String,
        args: Vec<Expr>,
    },
    Group(Box<Expr>),
}

#[derive(Debug, Clone, Copy)]
enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Pow,
    Concat,
    Lt,
    Gt,
    Le,
    Ge,
    Eq,
    Ne,
    And,
    Or,
    Match,
    NotMatch,
}

#[derive(Debug, Clone, Copy)]
enum UnOp {
    Neg,
    Not,
}

#[derive(Debug, Clone)]
enum Stmt {
    Expr(Expr),
    Print {
        args: Vec<Expr>,
        redirect: Option<(String, Expr)>,
    },
    Printf {
        format: Expr,
        args: Vec<Expr>,
        redirect: Option<(String, Expr)>,
    },
    If {
        cond: Expr,
        then: Vec<Stmt>,
        otherwise: Vec<Stmt>,
    },
    While {
        cond: Expr,
        body: Vec<Stmt>,
    },
    For {
        init: Expr,
        cond: Option<Expr>,
        step: Expr,
        body: Vec<Stmt>,
    },
    ForIn {
        var: String,
        array: String,
        body: Vec<Stmt>,
    },
    Block(Vec<Stmt>),
    Next,
    Exit(Option<Expr>),
    Break,
    Continue,
    Delete {
        array: String,
        key: Option<Expr>,
    },
}

#[derive(Debug, Clone)]
enum Pattern {
    Always,
    Begin,
    End,
    Expr(Expr),
}

#[derive(Debug, Clone)]
struct Rule {
    pattern: Pattern,
    body: Vec<Stmt>,
}

/* ---------- The interpreter state ---------- */

enum Flow {
    Normal,
    Next,
    Exit(i32),
    Break,
    Continue,
}

struct Interp<'a> {
    shell: &'a mut Shell,
    io: &'a Io,
    vars: HashMap<String, Val>,
    arrays: HashMap<String, HashMap<String, Val>>,
    fields: Vec<String>,
    rules: &'a [Rule],
    exiting: Option<i32>,
}

pub fn run_awk(shell: &mut Shell, io: &Io, args: &[String]) -> ExecResult {
    let mut separator = " ".to_owned();
    let mut assignments: Vec<(String, String)> = Vec::new();
    let mut program: Option<String> = Vec::new().pop();
    let mut files: Vec<String> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--" {
            index += 1;
            continue;
        }
        if let Some(body) = arg.strip_prefix("-F") {
            separator = if body.is_empty() {
                " ".to_owned()
            } else {
                unescape_common(body)
            };
        } else if arg == "-F" {
            index += 1;
            if let Some(next) = args.get(index) {
                separator = unescape_common(next);
            }
        } else if let Some(body) = arg.strip_prefix("-v") {
            // `-v var=val` rides one argument; bare `-v` takes the next one.
            let assignment = if body.is_empty() {
                index += 1;
                args.get(index).cloned()
            } else {
                Some(body.to_owned())
            };
            if let Some((name, value)) = assignment.as_deref().and_then(|text| text.split_once('='))
            {
                assignments.push((name.to_owned(), value.to_owned()));
            }
        } else if program.is_none() && !arg.starts_with('-') {
            program = Some(arg.clone());
        } else if program.is_some() {
            files.push(arg.clone());
        }
        index += 1;
    }
    let Some(program) = program else {
        io.err_str("awk: a program is required\n");
        return Ok(2);
    };
    let rules = match parse_program(&program) {
        Ok(rules) => rules,
        Err(error) => {
            io.err_str(&format!("awk: {error}\n"));
            return Ok(2);
        }
    };
    let mut interp = Interp {
        shell,
        io,
        vars: HashMap::new(),
        arrays: HashMap::new(),
        fields: vec![String::new()],
        rules: &rules,
        exiting: None,
    };
    for (name, value) in assignments {
        interp.vars.insert(name, Val::str(&value));
    }
    interp.vars.insert("FS".to_owned(), Val::str(&separator));
    interp.vars.insert("OFS".to_owned(), Val::str(" "));
    interp.vars.insert("ORS".to_owned(), Val::str("\n"));
    interp.vars.insert("NR".to_owned(), Val::num(0.0));
    interp.vars.insert("FNR".to_owned(), Val::num(0.0));
    interp.vars.insert("FILENAME".to_owned(), Val::str(""));

    // BEGIN, the records, END — with an early exit cutting straight to END.
    let mut status = 0;
    for rule in &rules {
        if matches!(rule.pattern, Pattern::Begin) {
            if let Flow::Exit(code) = interp.run_body(&rule.body) {
                status = code;
                interp.exiting = Some(code);
            }
        }
    }
    if interp.exiting.is_none() {
        if files.is_empty() {
            let mut io_mut = interp.io.clone();
            let text = io_mut.read_all_stdin();
            for line in lines(&text) {
                if let Flow::Exit(code) = interp.record(line, "-") {
                    status = code;
                    break;
                }
            }
        } else {
            'files: for file in &files {
                let path = interp.shell.resolve_working_path(file);
                let text = match std::fs::read_to_string(&path) {
                    Ok(text) => text,
                    Err(error) => {
                        interp.io.err_str(&format!("awk: {file}: {error}\n"));
                        status = 2;
                        continue;
                    }
                };
                for line in lines(&text) {
                    if let Flow::Exit(code) = interp.record(line, file) {
                        status = code;
                        break 'files;
                    }
                }
            }
        }
    }
    for rule in &rules {
        if matches!(rule.pattern, Pattern::End) {
            if let Flow::Exit(code) = interp.run_body(&rule.body) {
                status = code;
            }
        }
    }
    if let Some(code) = interp.exiting {
        status = code;
    }
    Ok(status)
}

fn lines(text: &str) -> impl Iterator<Item = &str> {
    // Every line is a record — an empty one included (`awk '{print NR}'` counts
    // blank lines); split_inclusive never yields a trailing empty artifact.
    text.split_inclusive('\n')
        .map(|line| line.trim_end_matches(['\n', '\r']))
}

fn unescape_common(text: &str) -> String {
    super::builtins::unescape(text)
}

impl<'a> Interp<'a> {
    fn set_record(&mut self, line: &str) {
        self.fields = vec![line.to_owned()];
        let separator = self
            .vars
            .get("FS")
            .map(|v| v.to_str())
            .unwrap_or_else(|| " ".to_owned());
        let parts: Vec<String> = if separator == " " {
            line.split_whitespace().map(str::to_owned).collect()
        } else if separator.len() == 1 {
            line.split(separator.as_str()).map(str::to_owned).collect()
        } else {
            match Regex::compile(&separator, true, false) {
                Ok(regex) => regex.split(line),
                Err(_) => line.split_whitespace().map(str::to_owned).collect(),
            }
        };
        self.fields.extend(parts);
        self.vars
            .insert("NF".to_owned(), Val::num((self.fields.len() - 1) as f64));
    }

    fn rebuild_record(&mut self) {
        let joined = self.fields[1..].join(
            &self
                .vars
                .get("OFS")
                .map(|v| v.to_str())
                .unwrap_or_else(|| " ".to_owned()),
        );
        // `$1 = "x"` rebuilds $0 but leaves $1..$NF addressable afterwards.
        self.fields[0] = joined;
    }

    fn record(&mut self, line: &str, name: &str) -> Flow {
        self.set_record(line);
        let nr = self.vars.get("NR").map(|v| v.to_num()).unwrap_or(0.0) + 1.0;
        self.vars.insert("NR".to_owned(), Val::num(nr));
        self.vars.insert("FNR".to_owned(), Val::num(nr));
        self.vars.insert("FILENAME".to_owned(), Val::str(name));
        self.run_rules()
    }

    fn run_rules(&mut self) -> Flow {
        for rule in self.rules {
            let hit = match &rule.pattern {
                // BEGIN/END run in their own phases, never per record.
                Pattern::Begin | Pattern::End => continue,
                Pattern::Always => true,
                Pattern::Expr(expr) => match expr {
                    Expr::Regex(pattern) => self
                        .record_text()
                        .and_then(|text| {
                            Regex::compile(pattern, true, false)
                                .ok()
                                .map(|re| re.is_match(&text))
                        })
                        .unwrap_or(false),
                    other => self
                        .eval(other)
                        .map(|value| value.truthy())
                        .unwrap_or(false),
                },
            };
            if !hit {
                continue;
            }
            match self.run_body(&rule.body) {
                // Every matching rule runs per record — a normal finish falls
                // through to the next rule, only the escapes abandon it.
                Flow::Normal => {}
                // `next` abandons the RECORD, not just this rule.
                Flow::Next => return Flow::Next,
                other => return other,
            }
        }
        Flow::Normal
    }

    fn record_text(&self) -> Option<String> {
        self.fields.first().cloned()
    }

    fn run_body(&mut self, body: &[Stmt]) -> Flow {
        for stmt in body {
            match self.run_stmt(stmt) {
                Flow::Normal => {}
                other => return other,
            }
        }
        Flow::Normal
    }

    fn run_stmt(&mut self, stmt: &Stmt) -> Flow {
        match stmt {
            Stmt::Expr(expr) => {
                let _ = self.eval(expr);
                Flow::Normal
            }
            Stmt::Print { args, redirect } => {
                let mut pieces = Vec::new();
                for arg in args {
                    pieces.push(self.eval(arg).map(|v| v.to_str()).unwrap_or_default());
                }
                let separator = self
                    .vars
                    .get("OFS")
                    .map(|v| v.to_str())
                    .unwrap_or_else(|| " ".to_owned());
                let terminator = self
                    .vars
                    .get("ORS")
                    .map(|v| v.to_str())
                    .unwrap_or_else(|| "\n".to_owned());
                let text = format!("{}{}", pieces.join(&separator), terminator);
                self.emit(&text, redirect);
                Flow::Normal
            }
            Stmt::Printf {
                format,
                args,
                redirect,
            } => {
                let format = self.eval(format).map(|v| v.to_str()).unwrap_or_default();
                let values: Vec<Val> = args
                    .iter()
                    .map(|arg| self.eval(arg).unwrap_or(Val::num(0.0)))
                    .collect();
                let text = sprintf(&format, &values);
                self.emit(&text, redirect);
                Flow::Normal
            }
            Stmt::If {
                cond,
                then,
                otherwise,
            } => {
                if self.eval(cond).map(|v| v.truthy()).unwrap_or(false) {
                    self.run_body(then)
                } else {
                    self.run_body(otherwise)
                }
            }
            Stmt::While { cond, body } => {
                while self.eval(cond).map(|v| v.truthy()).unwrap_or(false) {
                    match self.run_body(body) {
                        Flow::Break => break,
                        Flow::Continue | Flow::Normal => continue,
                        other => return other,
                    }
                }
                Flow::Normal
            }
            Stmt::For {
                init,
                cond,
                step,
                body,
            } => {
                let _ = self.eval(init);
                loop {
                    let keep_going = cond
                        .as_ref()
                        .map(|c| self.eval(c).map(|v| v.truthy()).unwrap_or(false))
                        .unwrap_or(true);
                    if !keep_going {
                        break;
                    }
                    match self.run_body(body) {
                        Flow::Break => break,
                        Flow::Continue => {}
                        Flow::Normal => {}
                        other => return other,
                    }
                    let _ = self.eval(step);
                }
                Flow::Normal
            }
            Stmt::ForIn { var, array, body } => {
                let keys: Vec<String> = self
                    .arrays
                    .get(array)
                    .map(|map| map.keys().cloned().collect())
                    .unwrap_or_default();
                for key in keys {
                    self.vars.insert(var.clone(), Val::str(&key));
                    match self.run_body(body) {
                        Flow::Break => break,
                        Flow::Continue | Flow::Normal => {}
                        other => return other,
                    }
                }
                Flow::Normal
            }
            Stmt::Block(body) => self.run_body(body),
            Stmt::Next => Flow::Next,
            Stmt::Exit(code) => {
                let code = code
                    .as_ref()
                    .and_then(|expr| self.eval(expr).ok())
                    .map(|v| v.to_num() as i32)
                    .unwrap_or(0);
                self.exiting = Some(code);
                Flow::Exit(code)
            }
            Stmt::Break => Flow::Break,
            Stmt::Continue => Flow::Continue,
            Stmt::Delete { array, key } => {
                match key {
                    Some(key) => {
                        if let Ok(value) = self.eval(key) {
                            self.arrays
                                .entry(array.clone())
                                .or_default()
                                .remove(&value.to_str());
                        }
                    }
                    None => {
                        self.arrays.remove(array);
                    }
                }
                Flow::Normal
            }
        }
    }

    fn emit(&mut self, text: &str, redirect: &Option<(String, Expr)>) {
        match redirect {
            None => self.io.out_str(text),
            Some((kind, target)) => {
                let path = self.eval(target).map(|v| v.to_str()).unwrap_or_default();
                let path = self.shell.resolve_working_path(&path);
                let append = kind == ">>";
                if let Ok(mut file) = std::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .append(append)
                    .truncate(!append)
                    .open(&path)
                {
                    use std::io::Write;
                    let _ = file.write_all(text.as_bytes());
                }
            }
        }
    }

    fn field(&self, index: usize) -> Val {
        if index == 0 {
            Val::str(self.fields.first().map(String::as_str).unwrap_or(""))
        } else {
            Val::str(self.fields.get(index).map(String::as_str).unwrap_or(""))
        }
    }

    fn eval(&mut self, expr: &Expr) -> Result<Val, String> {
        match expr {
            Expr::Num(n) => Ok(Val::Num(*n)),
            Expr::Str(text) => Ok(Val::Str(unescape_common(text))),
            Expr::Var(name) => Ok(match name.as_str() {
                "NF" => Val::num((self.fields.len() - 1) as f64),
                "NR" | "FNR" => self
                    .vars
                    .get(name.as_str())
                    .cloned()
                    .unwrap_or(Val::num(0.0)),
                _ => self
                    .vars
                    .get(name)
                    .cloned()
                    .unwrap_or(Val::Str(String::new())),
            }),
            Expr::Field(index) => {
                let at = self.eval(index)?.to_num();
                if at < 0.0 {
                    return Err("negative field index".into());
                }
                Ok(self.field(at as usize))
            }
            Expr::Index { name, key } => {
                let key = self.eval(key)?.to_str();
                Ok(self
                    .arrays
                    .get(name)
                    .and_then(|map| map.get(&key))
                    .cloned()
                    .unwrap_or(Val::Str(String::new())))
            }
            Expr::Regex(pattern) => {
                let regex = Regex::compile(pattern, true, false)?;
                Ok(Val::num(f64::from(
                    regex.is_match(&self.record_text().unwrap_or_default()),
                )))
            }
            Expr::Group(inner) => self.eval(inner),
            Expr::Unary { op, operand } => {
                let value = self.eval(operand)?;
                Ok(match op {
                    UnOp::Neg => Val::num(-value.to_num()),
                    UnOp::Not => Val::num(f64::from(!value.truthy())),
                })
            }
            Expr::Incr { target, delta } => {
                let current = self.eval(target)?.to_num();
                let next = current + delta;
                self.assign(target, Val::num(next))?;
                // Postfix semantics: the expression's value is the ORIGINAL one.
                Ok(Val::num(current))
            }
            Expr::PreIncr { target, delta } => {
                let next = self.eval(target)?.to_num() + delta;
                self.assign(target, Val::num(next))?;
                Ok(Val::num(next))
            }
            Expr::Ternary {
                cond,
                then,
                otherwise,
            } => {
                if self.eval(cond)?.truthy() {
                    self.eval(then)
                } else {
                    self.eval(otherwise)
                }
            }
            Expr::In { key, array } => {
                let key = self.eval(key)?.to_str();
                Ok(Val::num(f64::from(
                    self.arrays
                        .get(array)
                        .map(|map| map.contains_key(&key))
                        .unwrap_or(false),
                )))
            }
            Expr::Call { name, args } => self.call(name, args),
            Expr::Assign { target, value } => {
                let value = self.eval(value)?;
                self.assign(target, value.clone())?;
                Ok(value)
            }
            Expr::Binary { op, left, right } => {
                let short = match op {
                    BinOp::And => Some(self.eval(left)?.truthy()),
                    BinOp::Or => Some(!self.eval(left)?.truthy()),
                    _ => None,
                };
                if let Some(skip) = short {
                    if skip {
                        return self.eval(right);
                    }
                    return Ok(Val::num(f64::from(matches!(op, BinOp::Or))));
                }
                let l = self.eval(left)?;
                // A bare regex operand is its pattern text (`x ~ /re/`, sub(/re/,...)).
                let r = match right.as_ref() {
                    Expr::Regex(pattern) => Val::str(pattern),
                    _ => self.eval(right)?,
                };
                match op {
                    BinOp::Concat => Ok(Val::str(&format!("{}{}", l.to_str(), r.to_str()))),
                    BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div | BinOp::Mod | BinOp::Pow => {
                        let (a, b) = (l.to_num(), r.to_num());
                        let value = match op {
                            BinOp::Add => a + b,
                            BinOp::Sub => a - b,
                            BinOp::Mul => a * b,
                            BinOp::Div => {
                                if b == 0.0 {
                                    return Err("division by zero in awk".into());
                                }
                                a / b
                            }
                            BinOp::Mod => {
                                if b == 0.0 {
                                    return Err("division by zero in awk".into());
                                }
                                a % b
                            }
                            _ => a.powf(b),
                        };
                        Ok(Val::num(value))
                    }
                    BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Gt | BinOp::Le | BinOp::Ge => {
                        let hit = compare(&l, &r, *op)?;
                        Ok(Val::num(f64::from(hit)))
                    }
                    BinOp::Match | BinOp::NotMatch => {
                        let regex = Regex::compile(&r.to_str(), true, false)?;
                        let hit = regex.is_match(&l.to_str());
                        Ok(Val::num(f64::from(if matches!(op, BinOp::Match) {
                            hit
                        } else {
                            !hit
                        })))
                    }
                    BinOp::And | BinOp::Or => unreachable!("handled above"),
                }
            }
        }
    }

    fn assign(&mut self, target: &Expr, value: Val) -> Result<(), String> {
        match target {
            Expr::Var(name) => {
                self.vars.insert(name.clone(), value);
                Ok(())
            }
            Expr::Field(index) => {
                let at = self.eval(index)?.to_num() as usize;
                if self.fields.is_empty() {
                    self.fields.push(String::new());
                }
                while self.fields.len() <= at {
                    self.fields.push(String::new());
                }
                self.fields[at] = value.to_str();
                self.rebuild_record();
                Ok(())
            }
            Expr::Index { name, key } => {
                let key = self.eval(key)?.to_str();
                self.arrays
                    .entry(name.clone())
                    .or_default()
                    .insert(key, value);
                Ok(())
            }
            _ => Err("not assignable".into()),
        }
    }

    fn call(&mut self, name: &str, args: &[Expr]) -> Result<Val, String> {
        let value = |interp: &mut Interp, index: usize| -> Result<Val, String> {
            args.get(index)
                .map(|arg| interp.eval(arg))
                .transpose()
                .map(|option| option.unwrap_or(Val::Str(String::new())))
        };
        match name {
            "length" => {
                if args.is_empty() {
                    return Ok(Val::num(
                        self.record_text().map(|t| t.chars().count()).unwrap_or(0) as f64,
                    ));
                }
                Ok(Val::num(value(self, 0)?.to_str().chars().count() as f64))
            }
            "substr" => {
                let text = value(self, 0)?.to_str();
                let start = value(self, 1)?.to_num().max(1.0) as usize;
                let chars: Vec<char> = text.chars().collect();
                let take = if args.len() > 2 {
                    value(self, 2)?.to_num().max(0.0) as usize
                } else {
                    usize::MAX
                };
                Ok(Val::str(
                    &chars.iter().skip(start - 1).take(take).collect::<String>(),
                ))
            }
            "index" => {
                let haystack = value(self, 0)?.to_str();
                let needle = value(self, 1)?.to_str();
                Ok(Val::num(match haystack.find(&needle) {
                    Some(byte_at) => haystack[..byte_at].chars().count() as f64 + 1.0,
                    None => 0.0,
                }))
            }
            "split" => {
                let text = value(self, 0)?.to_str();
                let array = match args.get(1) {
                    Some(Expr::Var(name)) => name.clone(),
                    _ => return Err("split needs an array name".into()),
                };
                let separator = if args.len() > 2 {
                    value(self, 2)?.to_str()
                } else {
                    self.vars
                        .get("FS")
                        .map(|v| v.to_str())
                        .unwrap_or_else(|| " ".to_owned())
                };
                let parts: Vec<String> = if separator == " " {
                    text.split_whitespace().map(str::to_owned).collect()
                } else {
                    text.split(&separator).map(str::to_owned).collect()
                };
                let count = parts.len();
                let map: HashMap<String, Val> = parts
                    .into_iter()
                    .enumerate()
                    .map(|(i, part)| (format!("{}", i + 1), Val::str(&part)))
                    .collect();
                self.arrays.insert(array, map);
                Ok(Val::num(count as f64))
            }
            "sub" | "gsub" => {
                let pattern = match args.first() {
                    Some(Expr::Regex(pattern)) => pattern.clone(),
                    _ => value(self, 0)?.to_str(),
                };
                let replacement = value(self, 1)?.to_str();
                let target = if args.len() > 2 {
                    value(self, 2)?
                } else {
                    Val::str(&self.record_text().unwrap_or_default())
                };
                let regex = Regex::compile(&pattern, true, false)?;
                let text = target.to_str();
                let global = name == "gsub";
                // The matches are laid over the ORIGINAL text — replacing as we went
                // would rescan the replacement itself (`gsub(/a/, "aa")` would run
                // forever). Non-global keeps only the first.
                // An empty match right where the previous match ended is no match
                // (`gsub(/x*/, "-")` over `xab` is `-a-b-`).
                let mut last_end: Option<usize> = None;
                let mut found_iter: Vec<_> = regex
                    .find_iter(&text)
                    .into_iter()
                    .filter(|found| {
                        let skip = found.start == found.end && last_end == Some(found.start);
                        if !skip {
                            last_end = Some(found.end);
                        }
                        !skip
                    })
                    .collect();
                if !global {
                    found_iter.truncate(1);
                }
                let mut rebuilt = String::new();
                let mut at = 0usize;
                let mut count = 0usize;
                for found in found_iter {
                    rebuilt.push_str(&text[at..found.start]);
                    let mut expanded = String::new();
                    let mut chars = replacement.chars();
                    while let Some(c) = chars.next() {
                        if c == '\\' {
                            match chars.next() {
                                Some(digit) if digit.is_ascii_digit() => {
                                    if let Some(Some((start, end))) =
                                        found.groups.get(digit as usize - '0' as usize)
                                    {
                                        expanded.push_str(&text[*start..*end]);
                                    }
                                }
                                Some('&') => expanded.push_str(&text[found.start..found.end]),
                                Some(other) => expanded.push(other),
                                None => {}
                            }
                        } else if c == '&' {
                            expanded.push_str(&text[found.start..found.end]);
                        } else {
                            expanded.push(c);
                        }
                    }
                    rebuilt.push_str(&expanded);
                    at = found.end;
                    count += 1;
                }
                rebuilt.push_str(&text[at..]);
                let text = rebuilt;
                if count > 0 {
                    if args.len() > 2 {
                        if let Some(target_expr) = args.get(2) {
                            self.assign(target_expr, Val::str(&text))?;
                        }
                    } else {
                        self.set_record(&text);
                    }
                }
                Ok(Val::num(count as f64))
            }
            "sprintf" => {
                let format = value(self, 0)?.to_str();
                // `sprintf()` with nothing past the format is legal (an empty
                // format string) — `args[1..]` would panic on the empty slice.
                let rest: Vec<Val> = args
                    .get(1..)
                    .unwrap_or(&[])
                    .iter()
                    .map(|arg| self.eval(arg))
                    .collect::<Result<_, _>>()?;
                Ok(Val::str(&sprintf(&format, &rest)))
            }
            "tolower" => Ok(Val::str(&value(self, 0)?.to_str().to_lowercase())),
            "toupper" => Ok(Val::str(&value(self, 0)?.to_str().to_uppercase())),
            "int" => Ok(Val::num(value(self, 0)?.to_num().trunc())),
            "sqrt" => Ok(Val::num(value(self, 0)?.to_num().sqrt())),
            "match" => {
                let text = value(self, 0)?.to_str();
                let pattern = match args.get(1) {
                    Some(Expr::Regex(pattern)) => pattern.clone(),
                    _ => value(self, 1)?.to_str(),
                };
                let regex = Regex::compile(&pattern, true, false)?;
                match regex.find(&text) {
                    Some(found) => {
                        // The regex answers byte offsets; awk counts characters, like
                        // `index`, `length` and `substr` do.
                        let start = text[..found.start].chars().count() as f64 + 1.0;
                        let length = text[found.start..found.end].chars().count() as f64;
                        self.vars.insert("RSTART".to_owned(), Val::num(start));
                        self.vars.insert("RLENGTH".to_owned(), Val::num(length));
                        Ok(Val::num(start))
                    }
                    None => {
                        self.vars.insert("RSTART".to_owned(), Val::num(0.0));
                        self.vars.insert("RLENGTH".to_owned(), Val::num(-1.0));
                        Ok(Val::num(0.0))
                    }
                }
            }
            other => Err(format!("awk: {other}: function not supported")),
        }
    }
}

fn compare(left: &Val, right: &Val, op: BinOp) -> Result<bool, String> {
    let (ls, rs) = (left.to_str(), right.to_str());
    let numeric = matches!(left, Val::Num(_))
        || matches!(right, Val::Num(_))
        || (looks_numeric(&ls) && looks_numeric(&rs));
    Ok(if numeric {
        let (a, b) = (left.to_num(), right.to_num());
        match op {
            BinOp::Eq => a == b,
            BinOp::Ne => a != b,
            BinOp::Lt => a < b,
            BinOp::Gt => a > b,
            BinOp::Le => a <= b,
            BinOp::Ge => a >= b,
            _ => unreachable!("not a comparison"),
        }
    } else {
        match op {
            BinOp::Eq => ls == rs,
            BinOp::Ne => ls != rs,
            BinOp::Lt => ls < rs,
            BinOp::Gt => ls > rs,
            BinOp::Le => ls <= rs,
            BinOp::Ge => ls >= rs,
            _ => unreachable!("not a comparison"),
        }
    })
}

fn sprintf(format: &str, values: &[Val]) -> String {
    let mut out = String::new();
    let mut at = 0usize;
    let mut chars = format.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        let mut left = false;
        let mut zero = false;
        let mut width = 0usize;
        let mut precision: Option<usize> = None;
        let mut in_precision = false;
        let verb = loop {
            match chars.next() {
                Some('-') if width == 0 && !in_precision => left = true,
                Some('0') if width == 0 && !in_precision => zero = true,
                Some(d) if d.is_ascii_digit() => {
                    if in_precision {
                        precision =
                            Some(precision.unwrap_or(0) * 10 + d.to_digit(10).unwrap() as usize);
                    } else {
                        width = width * 10 + d.to_digit(10).unwrap() as usize;
                    }
                }
                Some('.') => in_precision = true,
                Some('%') => {
                    out.push('%');
                    break '\0';
                }
                Some(verb) => break verb,
                None => break '\0',
            }
        };
        if verb == '\0' {
            continue;
        }
        let value = values.get(at).cloned().unwrap_or(Val::Str(String::new()));
        at += 1;
        let piece = match verb {
            'd' | 'i' => pad_num(&format!("{:.0}", value.to_num()), width, left, zero),
            'f' => {
                let text = format!("{:.*}", precision.unwrap_or(6), value.to_num());
                pad_num(&text, width, left, zero)
            }
            'g' => pad_num(&format_number(value.to_num()), width, left, zero),
            'e' => pad_num(&format!("{:e}", value.to_num()), width, left, zero),
            'x' => pad_num(&format!("{:x}", value.to_num() as i64), width, left, zero),
            'o' => pad_num(&format!("{:o}", value.to_num() as i64), width, left, zero),
            'c' => value
                .to_str()
                .chars()
                .next()
                .map(String::from)
                .unwrap_or_default(),
            's' => {
                let mut text: String = value
                    .to_str()
                    .chars()
                    .take(precision.unwrap_or(usize::MAX))
                    .collect();
                let len = text.chars().count();
                if len < width {
                    let pad = " ".repeat(width - len);
                    if left {
                        text = format!("{text}{pad}");
                    } else {
                        text = format!("{pad}{text}");
                    }
                }
                text
            }
            other => format!("%{other}"),
        };
        out.push_str(&piece);
    }
    out
}

fn pad_num(text: &str, width: usize, left: bool, zero: bool) -> String {
    let len = text.chars().count();
    if len >= width {
        return text.to_owned();
    }
    let fill = if zero && !left { '0' } else { ' ' };
    let pad = fill.to_string().repeat(width - len);
    let negative = text.starts_with('-');
    if zero && !left && negative {
        format!("-{}{}", pad, &text[1..])
    } else if left {
        format!("{text}{pad}")
    } else {
        format!("{pad}{text}")
    }
}

/* ---------- The parser ---------- */

fn parse_program(source: &str) -> Result<Vec<Rule>, String> {
    let mut parser = AwkParser {
        tokens: tokenize(source)?,
        at: 0,
        in_print: false,
    };
    let mut rules = Vec::new();
    while parser.peek().is_some() {
        rules.push(parser.parse_rule()?);
    }
    Ok(rules)
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Word(String),
    Num(f64),
    Str(String),
    Regex(String),
    Op(String),
    Newline,
}

fn tokenize(source: &str) -> Result<Vec<Tok>, String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = source.chars().collect();
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        match c {
            ' ' | '\t' | '\r' => at += 1,
            '\n' => {
                tokens.push(Tok::Newline);
                at += 1;
            }
            '#' => {
                while at < chars.len() && chars[at] != '\n' {
                    at += 1;
                }
            }
            '"' => {
                at += 1;
                let mut text = String::new();
                while at < chars.len() && chars[at] != '"' {
                    if chars[at] == '\\' && at + 1 < chars.len() {
                        text.push(chars[at]);
                        text.push(chars[at + 1]);
                        at += 2;
                        continue;
                    }
                    text.push(chars[at]);
                    at += 1;
                }
                at += 1;
                tokens.push(Tok::Str(text));
            }
            '/' if regex_position(&tokens) => {
                at += 1;
                let mut text = String::new();
                while at < chars.len() && chars[at] != '/' {
                    if chars[at] == '\\' && at + 1 < chars.len() {
                        text.push(chars[at]);
                        at += 1;
                    }
                    text.push(chars[at]);
                    at += 1;
                }
                at += 1;
                if at < chars.len() && chars[at] == 'i' {
                    // /re/i — gawk does not have it; tolerated and dropped.
                    at += 1;
                }
                tokens.push(Tok::Regex(text));
            }
            c if c.is_ascii_digit()
                || (c == '.' && at + 1 < chars.len() && chars[at + 1].is_ascii_digit()) =>
            {
                let start = at;
                while at < chars.len() && (chars[at].is_ascii_digit() || chars[at] == '.') {
                    at += 1;
                }
                if at < chars.len() && (chars[at] == 'e' || chars[at] == 'E') {
                    at += 1;
                    if at < chars.len() && (chars[at] == '+' || chars[at] == '-') {
                        at += 1;
                    }
                    while at < chars.len() && chars[at].is_ascii_digit() {
                        at += 1;
                    }
                }
                let text: String = chars[start..at].iter().collect();
                tokens.push(Tok::Num(
                    text.parse().map_err(|_| format!("bad number {text}"))?,
                ));
            }
            c if c.is_ascii_alphabetic() || c == '_' => {
                let start = at;
                while at < chars.len() && (chars[at].is_ascii_alphanumeric() || chars[at] == '_') {
                    at += 1;
                }
                tokens.push(Tok::Word(chars[start..at].iter().collect()));
            }
            '$' => {
                at += 1;
                tokens.push(Tok::Op("$".to_owned()));
            }
            other => {
                let two: String = chars[at..(at + 2).min(chars.len())].iter().collect();
                let op = [
                    "<=", ">=", "==", "!=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=",
                    "^=", ">>",
                ]
                .iter()
                .find(|candidate| **candidate == two);
                match op {
                    Some(op) => {
                        tokens.push(Tok::Op((*op).to_owned()));
                        at += 2;
                    }
                    None => {
                        if "+-*/%{}()<>!=,;?[].~".contains(other) {
                            tokens.push(Tok::Op(other.to_string()));
                            at += 1;
                        } else {
                            return Err(format!("unexpected `{other}`"));
                        }
                    }
                }
            }
        }
    }
    Ok(tokens)
}

/// `/` starts a regex when a value cannot follow the previous token (after an
/// operator, at a rule start, after `(` or `,` or `&&`). After `)` or `]` an operand
/// just ended, so `/` is division there (`($1+2)/3`).
fn regex_position(tokens: &[Tok]) -> bool {
    match tokens.last() {
        None | Some(Tok::Newline) => true,
        Some(Tok::Op(op)) => !matches!(op.as_str(), ")" | "]"),
        Some(_) => false,
    }
}

struct AwkParser {
    tokens: Vec<Tok>,
    at: usize,
    /// Inside a `print` / `printf` argument list outside any parentheses, a bare `>` is
    /// the output redirection, not the comparison.
    in_print: bool,
}

impl AwkParser {
    fn peek(&self) -> Option<&Tok> {
        self.tokens.get(self.at)
    }
    fn next(&mut self) -> Option<Tok> {
        let token = self.tokens.get(self.at).cloned();
        if token.is_some() {
            self.at += 1;
        }
        token
    }
    fn eat(&mut self, text: &str) -> bool {
        if self.matches_op(text) {
            self.at += 1;
            true
        } else {
            false
        }
    }
    fn matches_op(&self, text: &str) -> bool {
        matches!(self.peek(), Some(Tok::Op(op)) if op == text)
    }
    fn skip_newlines(&mut self) {
        while matches!(self.peek(), Some(Tok::Newline)) {
            self.at += 1;
        }
    }

    fn parse_rule(&mut self) -> Result<Rule, String> {
        self.skip_newlines();
        let pattern = match self.peek() {
            Some(Tok::Word(word)) if word == "BEGIN" => {
                self.at += 1;
                Pattern::Begin
            }
            Some(Tok::Word(word)) if word == "END" => {
                self.at += 1;
                Pattern::End
            }
            Some(Tok::Op(op)) if op == "{" => Pattern::Always,
            _ => Pattern::Expr(self.parse_expr()?),
        };
        self.skip_newlines();
        let body = self.parse_block()?;
        self.skip_newlines();
        Ok(Rule { pattern, body })
    }

    fn parse_block(&mut self) -> Result<Vec<Stmt>, String> {
        if !self.eat("{") {
            return Err("expected `{`".into());
        }
        let mut body = Vec::new();
        loop {
            self.skip_newlines();
            match self.peek() {
                None => return Err("`{` never closed".into()),
                Some(Tok::Op(op)) if op == "}" => {
                    self.at += 1;
                    return Ok(body);
                }
                _ => body.push(self.parse_stmt()?),
            }
        }
    }

    fn parse_stmt(&mut self) -> Result<Stmt, String> {
        self.skip_newlines();
        match self.peek().cloned() {
            Some(Tok::Word(word)) => match word.as_str() {
                "if" => {
                    self.at += 1;
                    if !self.eat("(") {
                        return Err("expected `(` after if".into());
                    }
                    let cond = self.parse_expr()?;
                    if !self.eat(")") {
                        return Err("expected `)`".into());
                    }
                    self.skip_newlines();
                    let then = self.parse_stmt_list()?;
                    let otherwise = if matches!(self.peek(), Some(Tok::Word(word)) if word == "else")
                    {
                        self.at += 1;
                        self.skip_newlines();
                        self.parse_stmt_list()?
                    } else {
                        Vec::new()
                    };
                    Ok(Stmt::If {
                        cond,
                        then,
                        otherwise,
                    })
                }
                "while" => {
                    self.at += 1;
                    if !self.eat("(") {
                        return Err("expected `(` after while".into());
                    }
                    let cond = self.parse_expr()?;
                    if !self.eat(")") {
                        return Err("expected `)`".into());
                    }
                    let body = self.parse_stmt_list()?;
                    Ok(Stmt::While { cond, body })
                }
                "for" => {
                    self.at += 1;
                    if !self.eat("(") {
                        return Err("expected `(` after for".into());
                    }
                    if let Some(Tok::Word(var)) = self.peek().cloned() {
                        if matches!(self.tokens.get(self.at + 1), Some(Tok::Word(w)) if w == "in") {
                            self.at += 2;
                            let Some(Tok::Word(array)) = self.next() else {
                                return Err("expected an array after in".into());
                            };
                            if !self.eat(")") {
                                return Err("expected `)`".into());
                            }
                            let body = self.parse_stmt_list()?;
                            return Ok(Stmt::ForIn { var, array, body });
                        }
                    }
                    let init = self.parse_expr()?;
                    if !self.eat(";") {
                        return Err("expected `;` in for".into());
                    }
                    self.skip_newlines();
                    let cond = if self.matches_op(";") {
                        None
                    } else {
                        Some(self.parse_expr()?)
                    };
                    if !self.eat(";") {
                        return Err("expected `;` in for".into());
                    }
                    self.skip_newlines();
                    let step = if self.matches_op(")") {
                        Expr::Num(0.0)
                    } else {
                        self.parse_expr()?
                    };
                    if !self.eat(")") {
                        return Err("expected `)` in for".into());
                    }
                    let body = self.parse_stmt_list()?;
                    Ok(Stmt::For {
                        init,
                        cond,
                        step,
                        body,
                    })
                }
                "print" => {
                    self.at += 1;
                    let mut args = Vec::new();
                    while let Some(token) = self.peek() {
                        if matches!(token, Tok::Newline)
                            || matches!(token, Tok::Op(op) if op == "}" || op == ";")
                            // `print > "f"`: the redirection is not an argument.
                            || matches!(token, Tok::Op(op) if op == ">" || op == ">>")
                        {
                            break;
                        }
                        if self.eat(",") {
                            continue;
                        }
                        args.push(self.parse_print_arg()?);
                    }
                    let redirect = self.parse_redirect()?;
                    self.end_stmt();
                    if args.is_empty() {
                        args.push(Expr::Field(Box::new(Expr::Num(0.0))));
                    }
                    Ok(Stmt::Print { args, redirect })
                }
                "printf" => {
                    self.at += 1;
                    let format = self.parse_print_arg()?;
                    let mut args = Vec::new();
                    while let Some(token) = self.peek() {
                        if matches!(token, Tok::Newline)
                            || matches!(token, Tok::Op(op) if op == "}" || op == ";")
                            || matches!(token, Tok::Op(op) if op == ">" || op == ">>")
                        {
                            break;
                        }
                        if self.eat(",") {
                            continue;
                        }
                        args.push(self.parse_print_arg()?);
                    }
                    let redirect = self.parse_redirect()?;
                    self.end_stmt();
                    Ok(Stmt::Printf {
                        format,
                        args,
                        redirect,
                    })
                }
                "next" => {
                    self.at += 1;
                    self.end_stmt();
                    Ok(Stmt::Next)
                }
                "exit" => {
                    self.at += 1;
                    let code = if self.stmt_ends() {
                        None
                    } else {
                        Some(self.parse_expr()?)
                    };
                    self.end_stmt();
                    Ok(Stmt::Exit(code))
                }
                "break" => {
                    self.at += 1;
                    self.end_stmt();
                    Ok(Stmt::Break)
                }
                "continue" => {
                    self.at += 1;
                    self.end_stmt();
                    Ok(Stmt::Continue)
                }
                "delete" => {
                    self.at += 1;
                    let Some(Tok::Word(array)) = self.next() else {
                        return Err("delete needs an array".into());
                    };
                    let key = if self.eat("[") {
                        let key = self.parse_expr()?;
                        if !self.eat("]") {
                            return Err("expected `]`".into());
                        }
                        Some(key)
                    } else {
                        None
                    };
                    self.end_stmt();
                    Ok(Stmt::Delete { array, key })
                }
                _ => {
                    let expr = self.parse_expr()?;
                    self.end_stmt();
                    Ok(Stmt::Expr(expr))
                }
            },
            Some(Tok::Op(op)) if op == "{" => Ok(Stmt::Block(self.parse_block()?)),
            _ => {
                let expr = self.parse_expr()?;
                self.end_stmt();
                Ok(Stmt::Expr(expr))
            }
        }
    }

    /// A statement is one statement or a `{ … }` block — `if` bodies may be either.
    fn parse_stmt_list(&mut self) -> Result<Vec<Stmt>, String> {
        self.skip_newlines();
        if self.matches_op("{") {
            self.parse_block()
        } else {
            Ok(vec![self.parse_stmt()?])
        }
    }

    /// One `print` argument, where an unparenthesized `>` ends the list.
    fn parse_print_arg(&mut self) -> Result<Expr, String> {
        let saved = std::mem::replace(&mut self.in_print, true);
        let expr = self.parse_expr();
        self.in_print = saved;
        expr
    }

    /// An expression inside parentheses, brackets or call arguments: `>` compares again.
    fn parse_nested_expr(&mut self) -> Result<Expr, String> {
        let saved = std::mem::replace(&mut self.in_print, false);
        let expr = self.parse_expr();
        self.in_print = saved;
        expr
    }

    fn parse_redirect(&mut self) -> Result<Option<(String, Expr)>, String> {
        for kind in [">>", ">"] {
            if self.eat(kind) {
                return Ok(Some((kind.to_owned(), self.parse_expr()?)));
            }
        }
        Ok(None)
    }

    fn stmt_ends(&self) -> bool {
        matches!(self.peek(), None | Some(Tok::Newline))
            || self.matches_op("}")
            || self.matches_op(";")
    }

    fn end_stmt(&mut self) {
        self.skip_newlines();
        if self.eat(";") {
            self.skip_newlines();
        }
    }

    fn parse_expr(&mut self) -> Result<Expr, String> {
        self.parse_ternary()
    }

    fn parse_ternary(&mut self) -> Result<Expr, String> {
        let cond = self.parse_assign()?;
        if self.eat("?") {
            let then = self.parse_assign()?;
            if !self.eat(":") {
                return Err("expected `:`".into());
            }
            let otherwise = self.parse_assign()?;
            return Ok(Expr::Ternary {
                cond: Box::new(cond),
                then: Box::new(then),
                otherwise: Box::new(otherwise),
            });
        }
        Ok(cond)
    }

    fn parse_assign(&mut self) -> Result<Expr, String> {
        let target = self.parse_or()?;
        for (op, binary) in [
            ("=", None),
            ("+=", Some(BinOp::Add)),
            ("-=", Some(BinOp::Sub)),
            ("*=", Some(BinOp::Mul)),
            ("/=", Some(BinOp::Div)),
            ("%=", Some(BinOp::Mod)),
            ("^=", Some(BinOp::Pow)),
        ] {
            if self.matches_op(op) {
                self.at += 1;
                let value = self.parse_assign()?;
                let value = match binary {
                    None => value,
                    Some(op) => Expr::Binary {
                        op,
                        left: Box::new(target.clone()),
                        right: Box::new(value),
                    },
                };
                return Ok(Expr::Assign {
                    target: Box::new(target),
                    value: Box::new(value),
                });
            }
        }
        Ok(target)
    }

    fn parse_or(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_and()?;
        while self.eat("||") {
            let right = self.parse_and()?;
            left = Expr::Binary {
                op: BinOp::Or,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_in()?;
        while self.eat("&&") {
            let right = self.parse_in()?;
            left = Expr::Binary {
                op: BinOp::And,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_in(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_match()?;
        while matches!(self.peek(), Some(Tok::Word(word)) if word == "in") {
            self.at += 1;
            let Some(Tok::Word(array)) = self.next() else {
                return Err("expected an array after in".into());
            };
            left = Expr::In {
                key: Box::new(left),
                array,
            };
        }
        Ok(left)
    }

    fn parse_match(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_compare()?;
        loop {
            let negated = if self.matches_op("!") {
                self.at += 1;
                true
            } else {
                false
            };
            if self.eat("~") {
                let right = self.parse_compare()?;
                left = Expr::Binary {
                    op: if negated {
                        BinOp::NotMatch
                    } else {
                        BinOp::Match
                    },
                    left: Box::new(left),
                    right: Box::new(right),
                };
                continue;
            }
            if negated {
                return Err("expected `~` after `!`".into());
            }
            return Ok(left);
        }
    }

    fn parse_compare(&mut self) -> Result<Expr, String> {
        let left = self.parse_concat()?;
        for (op, bin) in [
            ("<=", BinOp::Le),
            (">=", BinOp::Ge),
            ("==", BinOp::Eq),
            ("!=", BinOp::Ne),
            ("<", BinOp::Lt),
            (">", BinOp::Gt),
        ] {
            if self.in_print && op == ">" {
                continue;
            }
            if self.eat(op) {
                let right = self.parse_concat()?;
                return Ok(Expr::Binary {
                    op: bin,
                    left: Box::new(left),
                    right: Box::new(right),
                });
            }
        }
        Ok(left)
    }

    fn parse_concat(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_add()?;
        loop {
            let joins = match self.peek() {
                // `in` is an operator keyword, not a concat operand — leaving it here
                // would swallow `(k in a)` before parse_in ever sees it.
                Some(Tok::Word(word)) => word != "in",
                Some(Tok::Num(_)) | Some(Tok::Str(_)) | Some(Tok::Regex(_)) => true,
                Some(Tok::Op(op)) => matches!(op.as_str(), "$" | "(" | "!" | "-"),
                _ => false,
            };
            if !joins {
                return Ok(left);
            }
            let right = self.parse_add()?;
            left = Expr::Binary {
                op: BinOp::Concat,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
    }

    fn parse_add(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_mul()?;
        loop {
            if self.matches_op("+") {
                self.at += 1;
                let right = self.parse_mul()?;
                left = Expr::Binary {
                    op: BinOp::Add,
                    left: Box::new(left),
                    right: Box::new(right),
                };
            } else if self.matches_op("-") {
                self.at += 1;
                let right = self.parse_mul()?;
                left = Expr::Binary {
                    op: BinOp::Sub,
                    left: Box::new(left),
                    right: Box::new(right),
                };
            } else {
                return Ok(left);
            }
        }
    }

    fn parse_mul(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_pow()?;
        loop {
            let op = if self.matches_op("*") {
                BinOp::Mul
            } else if self.matches_op("/") {
                BinOp::Div
            } else if self.matches_op("%") {
                BinOp::Mod
            } else {
                return Ok(left);
            };
            self.at += 1;
            let right = self.parse_pow()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
    }

    fn parse_pow(&mut self) -> Result<Expr, String> {
        let base = self.parse_unary()?;
        if self.eat("^") {
            let exponent = self.parse_pow()?;
            return Ok(Expr::Binary {
                op: BinOp::Pow,
                left: Box::new(base),
                right: Box::new(exponent),
            });
        }
        Ok(base)
    }

    fn parse_unary(&mut self) -> Result<Expr, String> {
        if self.matches_op("!") {
            self.at += 1;
            return Ok(Expr::Unary {
                op: UnOp::Not,
                operand: Box::new(self.parse_unary()?),
            });
        }
        if self.matches_op("-") {
            self.at += 1;
            return Ok(Expr::Unary {
                op: UnOp::Neg,
                operand: Box::new(self.parse_unary()?),
            });
        }
        if self.matches_op("+") {
            self.at += 1;
            return self.parse_unary();
        }
        // Prefix ++i / --i: the expression answers the NEW value.
        if self.matches_op("++") || self.matches_op("--") {
            let delta = if self.matches_op("++") { 1.0 } else { -1.0 };
            self.at += 1;
            let operand = self.parse_unary()?;
            return Ok(Expr::PreIncr {
                target: Box::new(operand),
                delta,
            });
        }
        self.parse_postfix()
    }

    fn parse_postfix(&mut self) -> Result<Expr, String> {
        let mut expr = self.parse_primary()?;
        loop {
            if self.matches_op("++") {
                self.at += 1;
                expr = Expr::Incr {
                    target: Box::new(expr),
                    delta: 1.0,
                };
            } else if self.matches_op("--") {
                self.at += 1;
                expr = Expr::Incr {
                    target: Box::new(expr),
                    delta: -1.0,
                };
            } else {
                return Ok(expr);
            }
        }
    }

    fn parse_primary(&mut self) -> Result<Expr, String> {
        match self.next() {
            Some(Tok::Num(n)) => Ok(Expr::Num(n)),
            Some(Tok::Str(text)) => Ok(Expr::Str(text)),
            Some(Tok::Regex(text)) => Ok(Expr::Regex(text)),
            Some(Tok::Op(op)) if op == "$" => {
                let index = self.parse_primary()?;
                Ok(Expr::Field(Box::new(index)))
            }
            Some(Tok::Op(op)) if op == "(" => {
                let inner = self.parse_nested_expr()?;
                if !self.eat(")") {
                    return Err("expected `)`".into());
                }
                Ok(Expr::Group(Box::new(inner)))
            }
            Some(Tok::Word(word)) => {
                if self.matches_op("(") {
                    self.at += 1;
                    let mut args = Vec::new();
                    if !self.matches_op(")") {
                        loop {
                            args.push(self.parse_nested_expr()?);
                            if !self.eat(",") {
                                break;
                            }
                        }
                    }
                    if !self.eat(")") {
                        return Err("expected `)`".into());
                    }
                    return Ok(Expr::Call { name: word, args });
                }
                if self.eat("[") {
                    let key = self.parse_nested_expr()?;
                    if !self.eat("]") {
                        return Err("expected `]`".into());
                    }
                    return Ok(Expr::Index {
                        name: word,
                        key: Box::new(key),
                    });
                }
                Ok(Expr::Var(word))
            }
            other => Err(format!("unexpected {other:?}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ggs_bash::exec::{Io, Shell};

    fn run(dir: &std::path::Path, program: &str, input: &str) -> String {
        run_args(dir, &[program.to_owned()], input)
    }

    fn run_args(dir: &std::path::Path, args: &[String], input: &str) -> String {
        let mut shell = Shell::new("awk");
        shell.cwd = dir.to_path_buf();
        let mut io = Io {
            stdin: crate::ggs_bash::exec::Source::Str(std::sync::Arc::new(std::sync::Mutex::new(
                input.to_owned(),
            ))),
            stdout: crate::ggs_bash::exec::Sink::Capture(std::sync::Arc::new(
                std::sync::Mutex::new(Vec::new()),
            )),
            stderr: crate::ggs_bash::exec::Sink::Inherit,
        };
        let err_cell = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        io.stderr = crate::ggs_bash::exec::Sink::Capture(err_cell.clone());
        let status = run_awk(&mut shell, &io, args);
        let err = String::from_utf8_lossy(&err_cell.lock().unwrap()).into_owned();
        assert_eq!(status.unwrap_or(1), 0, "awk run failed: {err}");
        let mut text = String::new();
        if let crate::ggs_bash::exec::Sink::Capture(cell) = &io.stdout {
            text = String::from_utf8_lossy(&cell.lock().unwrap()).into_owned();
        }
        // Drain the consumed Str so repeated runs do not double-read.
        io.read_all_stdin();
        text
    }

    #[test]
    fn fields_patterns_and_print() {
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(run(dir.path(), "{ print $2 }", "a b c\nd e f\n"), "b\ne\n");
        assert_eq!(
            run(dir.path(), "/beta/ { print $1 }", "alpha 1\nbeta 2\n"),
            "beta\n"
        );
        assert_eq!(run(dir.path(), "BEGIN { print \"hi\", 42 }", ""), "hi 42\n");
        assert_eq!(run(dir.path(), "END { print NR }", "x\ny\nz\n"), "3\n");
        assert_eq!(
            run(dir.path(), "NR > 1 { print }", "head\nbody\n"),
            "body\n"
        );
    }

    #[test]
    fn the_classic_counting_array() {
        let dir = tempfile::TempDir::new().unwrap();
        let out = run(
            dir.path(),
            "{ count[$1]++ } END { for (k in count) print k, count[k] }",
            "a\nb\na\na\nb\n",
        );
        assert!(out.contains("a 3") && out.contains("b 2"), "{out}");
    }

    #[test]
    fn field_splitting_and_reassignment() {
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(
            run_args(
                dir.path(),
                &["-F,".to_owned(), "{ print $2 }".to_owned()],
                "x,y,z\n"
            ),
            "y\n"
        );
        assert_eq!(
            run(dir.path(), "{ $2 = \"RE\"; print }", "a b c\n"),
            "a RE c\n"
        );
        assert_eq!(run(dir.path(), "{ print NF }", "a b c\n"), "3\n");
    }

    #[test]
    fn conditionals_loops_and_math() {
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(
            run(
                dir.path(),
                "BEGIN { for (i = 1; i <= 3; i++) printf \"%d \", i }",
                ""
            ),
            "1 2 3 "
        );
        assert_eq!(
            run(
                dir.path(),
                "BEGIN { s = 0; while (s < 10) s += 5; print s }",
                ""
            ),
            "10\n"
        );
        assert_eq!(
            run(
                dir.path(),
                "BEGIN { if (2 > 1 && \"x\" != \"y\") print \"ok\" }",
                ""
            ),
            "ok\n"
        );
        assert_eq!(
            run(dir.path(), "{ sum += $1 } END { print sum }", "1\n2\n3\n"),
            "6\n"
        );
    }

    #[test]
    fn string_functions_sub_and_sprintf() {
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(
            run(dir.path(), "BEGIN { print substr(\"abcdef\", 2, 3) }", ""),
            "bcd\n"
        );
        assert_eq!(
            run(dir.path(), "BEGIN { print index(\"hello\", \"ll\") }", ""),
            "3\n"
        );
        assert_eq!(
            run(dir.path(), "BEGIN { print length(\"four\") }", ""),
            "4\n"
        );
        assert_eq!(
            run(
                dir.path(),
                "BEGIN { s = \"a-b-c\"; n = gsub(/-/, \"+\", s); print n, s }",
                ""
            ),
            "2 a+b+c\n"
        );
        assert_eq!(
            run(
                dir.path(),
                "BEGIN { printf \"%05.1f|%s|%d\\n\", 3.14159, \"x\", 7 }",
                ""
            ),
            "003.1|x|7\n"
        );
        assert_eq!(
            run(
                dir.path(),
                "BEGIN { print toupper(\"ab\"), tolower(\"AB\") }",
                ""
            ),
            "AB ab\n"
        );
    }

    #[test]
    fn next_and_exit() {
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(
            run(dir.path(), "/skip/ { next } { print }", "skip me\nkeep\n"),
            "keep\n"
        );
        assert_eq!(
            run(
                dir.path(),
                "{ print; exit } END { print \"end\" }",
                "1\n2\n3\n"
            ),
            "1\nend\n"
        );
    }

    #[test]
    fn files_and_the_v_flag() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("data.txt"), "k v\nk v\n").unwrap();
        let mut shell = Shell::new("awk");
        shell.cwd = dir.path().to_path_buf();
        let io = Io::default();
        let mut args = vec![
            "-v".to_owned(),
            "label=rows".to_owned(),
            "{ n++ } END { print label, n }".to_owned(),
            "data.txt".to_owned(),
        ];
        let status = run_awk(&mut shell, &io, &args).unwrap_or(1);
        args.clear();
        assert_eq!(status, 0);
    }
}
