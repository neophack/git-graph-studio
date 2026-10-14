//! The small regular-expression engine `grep` and `sed` run on — pure Rust, zero
//! dependencies (plan §3.1 keeps the sidecar C-free). Both dialects compile from the
//! same parser: ERE (`grep -E`, `sed -E`) with `* + ? {m,n} ( ) |`, and BRE (the
//! default) where those are literal until backslashed — GNU's exact split.
//!
//! The matcher compiles to a little instruction program and runs on an explicit
//! backtracking stack in the heap — no native recursion, so a pathological pattern (or
//! a greedy `.*` over a huge line) can never overflow the thread's stack: the step
//! budget turns a runaway into "no match".

#[derive(Debug, Clone)]
enum Node {
    Char(char),
    Any,
    Class {
        negate: bool,
        items: Vec<ClassItem>,
    },
    Concat(Vec<Node>),
    Alt(Vec<Node>),
    Repeat {
        node: Box<Node>,
        min: u32,
        max: Option<u32>,
        greedy: bool,
    },
    Group(Option<usize>, Box<Node>),
    Begin,
    End,
    Backref(usize),
}

#[derive(Debug, Clone)]
enum ClassItem {
    Char(char),
    Range(char, char),
    Alpha,
    Digit,
    Alnum,
    Space,
    Upper,
    Lower,
    Punct,
}

/* ---------- The program ---------- */

#[derive(Debug, Clone)]
enum Insn {
    Char(char),
    Any,
    Class(usize),
    /// Save the position into `slot`.
    Save(usize),
    /// Try `first`, on failure `second` (the order encodes greediness).
    Split(usize, usize),
    Jump(usize),
    Begin,
    End,
    Backref(usize),
    Match,
}

pub struct Regex {
    program: Vec<Insn>,
    classes: Vec<(bool, Vec<ClassItem>)>,
    groups: usize,
    icase: bool,
}

/// One successful match: the span and the capture groups (`0` is the whole match).
#[derive(Debug, Clone, PartialEq)]
pub struct Match {
    pub start: usize,
    pub end: usize,
    pub groups: Vec<Option<(usize, usize)>>,
}

/// One VM outcome: the end position and the capture groups.
type RunOutcome = (usize, Vec<Option<(usize, usize)>>);

/// Byte offsets of each character boundary: `map[i]` is where `chars[i]` starts in
/// bytes, `map[len]` the text's length — the engine's char positions cross over into
/// the byte indices callers slice with.
fn byte_map(text: &str) -> Vec<usize> {
    text.char_indices()
        .map(|(at, _)| at)
        .chain(std::iter::once(text.len()))
        .collect()
}

impl Regex {
    /// Compile `pattern`. `ere` selects the dialect: ERE (`a|b`, `(x)+`) or BRE
    /// (`a\|b`, `\(x\)\+`). `icase` folds case into every literal and class.
    pub fn compile(pattern: &str, ere: bool, icase: bool) -> Result<Regex, String> {
        let mut parser = Parser {
            chars: pattern.chars().collect(),
            at: 0,
            ere,
            groups: 0,
        };
        let root = parser.parse_alt()?;
        if parser.at != parser.chars.len() {
            return Err(format!(
                "unexpected `{}` in pattern",
                parser.chars[parser.at]
            ));
        }
        let groups = parser.groups;
        let mut classes = Vec::new();
        let mut program = Vec::new();
        // Slot 0 saves the whole-match span; group i lives in 2i / 2i+1.
        program.push(Insn::Save(0));
        emit(&root, &mut program, &mut classes);
        program.push(Insn::Save(1));
        program.push(Insn::Match);
        Ok(Regex {
            program,
            classes,
            groups,
            icase,
        })
    }

    pub fn group_count(&self) -> usize {
        self.groups
    }

    /// The leftmost match in `text`, or `None`. `^` anchors at 0: the callers feed the
    /// engine one line at a time (grep, sed), the way those tools anchor lines.
    pub fn find(&self, text: &str) -> Option<Match> {
        let chars: Vec<char> = text.chars().collect();
        let map = byte_map(text);
        // One budget across every start position: a runaway at one offset must not
        // repeat itself at the next four thousand.
        let mut steps = 0usize;
        for start in 0..=chars.len() {
            if let Some((end, groups)) = self.run(&chars, start, &mut steps) {
                let mut groups = groups;
                groups[0] = Some((start, end));
                // Byte offsets on the way out: every caller slices `text` with these
                // spans, and a char count panics the slice once a multibyte
                // character sits in front of the match.
                return Some(Match {
                    start: map[start],
                    end: map[end],
                    groups: groups
                        .into_iter()
                        .map(|g| g.map(|(s, e)| (map[s], map[e])))
                        .collect(),
                });
            }
        }
        None
    }

    pub fn is_match(&self, text: &str) -> bool {
        self.find(text).is_some()
    }

    /// Split on every match (awk's `split(s, a, /re/)`).
    pub fn split(&self, text: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut at = 0usize;
        for found in self.find_iter(text) {
            out.push(text[at..found.start].to_owned());
            at = found.end;
        }
        out.push(text[at..].to_owned());
        out
    }

    /// Every non-overlapping match, left to right, in byte offsets. An empty match
    /// advances one character so it cannot match again at the same place.
    pub fn find_iter(&self, text: &str) -> Vec<Match> {
        let chars: Vec<char> = text.chars().collect();
        let map = byte_map(text);
        let mut out = Vec::new();
        let mut steps = 0usize;
        let mut at = 0usize;
        while at <= chars.len() {
            // The leftmost match starting at `at` or later — `find`'s scan minus the
            // start positions already ruled out.
            let mut hit = None;
            for start in at..=chars.len() {
                if let Some((end, groups)) = self.run(&chars, start, &mut steps) {
                    hit = Some((start, end, groups));
                    break;
                }
            }
            let Some((start, end, mut groups)) = hit else {
                break;
            };
            groups[0] = Some((start, end));
            out.push(Match {
                start: map[start],
                end: map[end],
                groups: groups
                    .into_iter()
                    .map(|g| g.map(|(s, e)| (map[s], map[e])))
                    .collect(),
            });
            at = if end == start { start + 1 } else { end };
        }
        out
    }

    /// The backtracking VM: the stack holds (pc, position, undo length) alternatives in
    /// the heap, so nothing here recurses natively. The step budget is the whole-run
    /// guard against pathological patterns.
    fn run(&self, text: &[char], start: usize, steps: &mut usize) -> Option<RunOutcome> {
        let mut saves: Vec<Option<usize>> = vec![None; (self.groups + 1) * 2];
        let mut undo: Vec<(usize, Option<usize>)> = Vec::new();
        let mut stack: Vec<(usize, usize, usize)> = Vec::new();
        let mut pc = 0usize;
        let mut sp = start;
        loop {
            *steps += 1;
            if *steps > 1_000_000 {
                return None;
            }
            let insn = self.program.get(pc)?;
            match insn {
                Insn::Char(expected) => {
                    if sp < text.len() && char_eq(text[sp], *expected, self.icase) {
                        sp += 1;
                        pc += 1;
                    } else {
                        (pc, sp) = pop(&mut stack, &mut saves, &mut undo);
                    }
                }
                Insn::Any => {
                    if sp < text.len() && text[sp] != '\n' {
                        sp += 1;
                        pc += 1;
                    } else {
                        (pc, sp) = pop(&mut stack, &mut saves, &mut undo);
                    }
                }
                Insn::Class(index) => {
                    let (negate, items) = &self.classes[*index];
                    if sp < text.len() && class_hits(items, text[sp], self.icase) != *negate {
                        sp += 1;
                        pc += 1;
                    } else {
                        (pc, sp) = pop(&mut stack, &mut saves, &mut undo);
                    }
                }
                Insn::Backref(group) => {
                    let span = saves
                        .get(2 * group)
                        .copied()
                        .flatten()
                        .zip(saves.get(2 * group + 1).copied().flatten());
                    match span {
                        Some((from, to)) if to >= from => {
                            let len = to - from;
                            if sp + len <= text.len()
                                && (0..len).all(|offset| text[sp + offset] == text[from + offset])
                            {
                                sp += len;
                                pc += 1;
                            } else {
                                (pc, sp) = pop(&mut stack, &mut saves, &mut undo);
                            }
                        }
                        _ => {
                            pc += 1;
                        }
                    }
                }
                Insn::Save(slot) => {
                    undo.push((*slot, saves[*slot]));
                    saves[*slot] = Some(sp);
                    pc += 1;
                }
                Insn::Split(first, second) => {
                    stack.push((*second, sp, undo.len()));
                    pc = *first;
                }
                Insn::Jump(target) => {
                    pc = *target;
                }
                Insn::Begin => {
                    if sp == 0 {
                        pc += 1;
                    } else {
                        (pc, sp) = pop(&mut stack, &mut saves, &mut undo);
                    }
                }
                Insn::End => {
                    if sp == text.len() || text[sp] == '\n' {
                        pc += 1;
                    } else {
                        (pc, sp) = pop(&mut stack, &mut saves, &mut undo);
                    }
                }
                Insn::Match => {
                    let mut groups: Vec<Option<(usize, usize)>> = vec![None; self.groups + 1];
                    for group in 0..=self.groups {
                        if let (Some(from), Some(to)) = (
                            saves.get(2 * group).copied().flatten(),
                            saves.get(2 * group + 1).copied().flatten(),
                        ) {
                            if to >= from {
                                groups[group] = Some((from, to));
                            }
                        }
                    }
                    return Some((sp, groups));
                }
            }
        }
    }
}

/// Restore one alternative: the undo log rewinds to its saved length. `pc = usize::MAX`
/// is the exhausted marker (the program has no such index).
fn pop(
    stack: &mut Vec<(usize, usize, usize)>,
    saves: &mut [Option<usize>],
    undo: &mut Vec<(usize, Option<usize>)>,
) -> (usize, usize) {
    match stack.pop() {
        Some((pc, sp, undo_len)) => {
            while undo.len() > undo_len {
                let (slot, previous) = undo.pop().expect("the undo log matches its lengths");
                saves[slot] = previous;
            }
            (pc, sp)
        }
        None => (usize::MAX, 0),
    }
}

fn char_eq(a: char, b: char, icase: bool) -> bool {
    if a == b {
        return true;
    }
    if icase {
        return a.to_lowercase().eq(b.to_lowercase());
    }
    false
}

fn class_hits(items: &[ClassItem], c: char, icase: bool) -> bool {
    items.iter().any(|item| match item {
        ClassItem::Char(expected) => char_eq(c, *expected, icase),
        ClassItem::Range(lo, hi) => {
            *lo <= c && c <= *hi
                || (icase
                    && ((*lo <= c.to_ascii_lowercase() && c.to_ascii_lowercase() <= *hi)
                        || (*lo <= c.to_ascii_uppercase() && c.to_ascii_uppercase() <= *hi)))
        }
        ClassItem::Alpha => c.is_alphabetic(),
        ClassItem::Digit => c.is_numeric(),
        ClassItem::Alnum => c.is_alphanumeric(),
        ClassItem::Space => c.is_whitespace(),
        ClassItem::Upper => c.is_uppercase(),
        ClassItem::Lower => c.is_lowercase(),
        ClassItem::Punct => c.is_ascii_punctuation(),
    })
}

/* ---------- AST → program ---------- */

fn emit(node: &Node, program: &mut Vec<Insn>, classes: &mut Vec<(bool, Vec<ClassItem>)>) {
    match node {
        Node::Char(c) => program.push(Insn::Char(*c)),
        Node::Any => program.push(Insn::Any),
        Node::Class { negate, items } => {
            let index = classes.len();
            classes.push((*negate, items.clone()));
            program.push(Insn::Class(index));
        }
        Node::Begin => program.push(Insn::Begin),
        Node::End => program.push(Insn::End),
        Node::Backref(group) => program.push(Insn::Backref(*group)),
        Node::Group(index, inner) => {
            if let Some(index) = index {
                program.push(Insn::Save(2 * index));
                emit(inner, program, classes);
                program.push(Insn::Save(2 * index + 1));
            } else {
                emit(inner, program, classes);
            }
        }
        Node::Concat(parts) => {
            for part in parts {
                emit(part, program, classes);
            }
        }
        Node::Alt(branches) => {
            // split b1 → split b2 → … → split bn, each jumping past the rest.
            let mut jumps = Vec::new();
            for (index, branch) in branches.iter().enumerate() {
                if index + 1 < branches.len() {
                    let split_at = program.len();
                    program.push(Insn::Jump(0)); // placeholder, becomes Split
                    emit(branch, program, classes);
                    jumps.push(program.len());
                    program.push(Insn::Jump(0)); // to the end of the alternation
                    let next = program.len();
                    program[split_at] = Insn::Split(split_at + 1, next);
                } else {
                    emit(branch, program, classes);
                }
            }
            let end = program.len();
            for jump in jumps {
                program[jump] = Insn::Jump(end);
            }
        }
        Node::Repeat {
            node,
            min,
            max,
            greedy,
        } => {
            // The mandatory prefix: `min` plain copies.
            for _ in 0..*min {
                emit(node, program, classes);
            }
            match max {
                None => {
                    // star: split body, jump back.
                    let split_at = program.len();
                    program.push(Insn::Jump(0));
                    emit(node, program, classes);
                    program.push(Insn::Jump(split_at));
                    let after = program.len();
                    program[split_at] = if *greedy {
                        Insn::Split(split_at + 1, after)
                    } else {
                        Insn::Split(after, split_at + 1)
                    };
                }
                Some(max) => {
                    // (max - min) optional copies, each skippable to the end.
                    let extra = max.saturating_sub(*min).min(2048);
                    let mut skips = Vec::new();
                    for _ in 0..extra {
                        let split_at = program.len();
                        program.push(Insn::Jump(0));
                        skips.push(split_at);
                        emit(node, program, classes);
                    }
                    let end = program.len();
                    for split_at in skips {
                        program[split_at] = if *greedy {
                            Insn::Split(split_at + 1, end)
                        } else {
                            Insn::Split(end, split_at + 1)
                        };
                    }
                }
            }
        }
    }
}

/* ---------- The parser ---------- */

struct Parser {
    chars: Vec<char>,
    at: usize,
    ere: bool,
    groups: usize,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }
    fn bump(&mut self) -> Option<char> {
        let c = self.peek();
        if c.is_some() {
            self.at += 1;
        }
        c
    }

    fn parse_alt(&mut self) -> Result<Node, String> {
        let mut branches = vec![self.parse_concat()?];
        while self.at_alt() {
            self.consume_alt();
            branches.push(self.parse_concat()?);
        }
        Ok(if branches.len() == 1 {
            branches.pop().unwrap()
        } else {
            Node::Alt(branches)
        })
    }

    fn at_alt(&self) -> bool {
        match self.peek() {
            Some('|') => self.ere,
            Some('\\') => self.chars.get(self.at + 1) == Some(&'|') && !self.ere,
            _ => false,
        }
    }
    fn consume_alt(&mut self) {
        if self.peek() == Some('|') {
            self.at += 1;
        } else {
            self.at += 2;
        }
    }

    fn parse_concat(&mut self) -> Result<Node, String> {
        let mut parts = Vec::new();
        while let Some(c) = self.peek() {
            if (c == '|' && self.ere) || self.at_alt() {
                break;
            }
            if self.ere && c == ')' {
                break;
            }
            if !self.ere && c == '\\' && self.chars.get(self.at + 1) == Some(&')') {
                break;
            }
            let atom = self.parse_atom()?;
            let atom = self.parse_postfix(atom)?;
            parts.push(atom);
        }
        Ok(match parts.len() {
            0 => Node::Repeat {
                node: Box::new(Node::Any),
                min: 0,
                max: Some(0),
                greedy: true,
            },
            _ => Node::Concat(parts),
        })
    }

    fn parse_postfix(&mut self, atom: Node) -> Result<Node, String> {
        let mut node = atom;
        loop {
            let (min, max) = match self.peek() {
                Some('*') => {
                    self.at += 1;
                    (0u32, None)
                }
                Some('+') if self.ere => {
                    self.at += 1;
                    (1, None)
                }
                Some('?') if self.ere => {
                    self.at += 1;
                    (0, Some(1))
                }
                Some('\\') if !self.ere => match self.chars.get(self.at + 1) {
                    Some('+') => {
                        self.at += 2;
                        (1, None)
                    }
                    Some('?') => {
                        self.at += 2;
                        (0, Some(1))
                    }
                    Some('{') => {
                        self.at += 2;
                        self.parse_bounds()?
                    }
                    _ => return Ok(node),
                },
                Some('{') if self.ere => {
                    let save = self.at;
                    self.at += 1;
                    match self.parse_bounds() {
                        Ok(bounds) => bounds,
                        Err(_) => {
                            self.at = save;
                            return Ok(node);
                        }
                    }
                }
                _ => return Ok(node),
            };
            let greedy = if self.peek() == Some('?') {
                self.at += 1;
                false
            } else {
                true
            };
            node = Node::Repeat {
                node: Box::new(node),
                min,
                max,
                greedy,
            };
        }
    }

    /// `{m}`, `{m,}`, `{m,n}`; in BRE the closing brace is escaped.
    fn parse_bounds(&mut self) -> Result<(u32, Option<u32>), String> {
        let min = self.parse_number()?;
        let max = if self.peek() == Some(',') {
            self.at += 1;
            if self.peek().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                Some(self.parse_number()?)
            } else {
                None
            }
        } else {
            Some(min)
        };
        if self.peek() == Some('\\') && self.chars.get(self.at + 1) == Some(&'}') {
            self.at += 2;
        } else if self.peek() == Some('}') {
            self.at += 1;
        } else {
            return Err("unterminated {m,n} bound".into());
        }
        Ok((min, max))
    }

    fn parse_number(&mut self) -> Result<u32, String> {
        let mut digits = String::new();
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                digits.push(c);
                self.at += 1;
            } else {
                break;
            }
        }
        digits
            .parse()
            .map_err(|_| "expected a number in {m,n}".into())
    }

    fn parse_atom(&mut self) -> Result<Node, String> {
        let c = self.bump().ok_or("unexpected end of pattern")?;
        match c {
            '.' => Ok(Node::Any),
            '^' => Ok(Node::Begin),
            '$' => Ok(Node::End),
            '[' => self.parse_class(),
            '(' if self.ere => {
                // (?:...) is accepted and non-capturing, like GNU ERE's extension.
                if self.peek() == Some('?') && self.chars.get(self.at + 1) == Some(&':') {
                    self.at += 2;
                    let inner = self.parse_alt()?;
                    self.expect_ere_close()?;
                    return Ok(Node::Group(None, Box::new(inner)));
                }
                self.groups += 1;
                let index = self.groups;
                let inner = self.parse_alt()?;
                self.expect_ere_close()?;
                Ok(Node::Group(Some(index), Box::new(inner)))
            }
            '\\' => match self.bump() {
                None => Err("trailing backslash".into()),
                Some('(') if !self.ere => {
                    self.groups += 1;
                    let index = self.groups;
                    let inner = self.parse_alt()?;
                    if self.peek() == Some('\\') && self.chars.get(self.at + 1) == Some(&')') {
                        self.at += 2;
                    } else {
                        return Err("expected \\) to close the group".into());
                    }
                    Ok(Node::Group(Some(index), Box::new(inner)))
                }
                Some(digit) if digit.is_ascii_digit() && digit != '0' => {
                    Ok(Node::Backref(digit as usize - '0' as usize))
                }
                Some(escape) => Ok(escape_node(escape)),
            },
            other => Ok(Node::Char(other)),
        }
    }

    fn expect_ere_close(&mut self) -> Result<(), String> {
        if self.peek() == Some(')') {
            self.at += 1;
            Ok(())
        } else {
            Err("expected ) to close the group".into())
        }
    }

    fn parse_class(&mut self) -> Result<Node, String> {
        let mut negate = false;
        if self.peek() == Some('^') {
            negate = true;
            self.at += 1;
        }
        let mut items: Vec<ClassItem> = Vec::new();
        let mut first = true;
        loop {
            let c = self.bump().ok_or("unterminated character class")?;
            if c == ']' && !first {
                break;
            }
            first = false;
            if c == '[' && self.peek() == Some(':') {
                let save = self.at;
                self.at += 1;
                let mut name = String::new();
                while let Some(c) = self.peek() {
                    if c == ':' {
                        break;
                    }
                    name.push(c);
                    self.at += 1;
                }
                if self.peek() == Some(':') && self.chars.get(self.at + 1) == Some(&']') {
                    self.at += 2;
                    items.push(match name.as_str() {
                        "alpha" => ClassItem::Alpha,
                        "digit" => ClassItem::Digit,
                        "alnum" => ClassItem::Alnum,
                        "space" => ClassItem::Space,
                        "upper" => ClassItem::Upper,
                        "lower" => ClassItem::Lower,
                        "punct" => ClassItem::Punct,
                        other => return Err(format!("unsupported class [:{other}:]")),
                    });
                    continue;
                }
                self.at = save;
                items.push(ClassItem::Char('['));
                continue;
            }
            let lo = if c == '\\' {
                self.bump().ok_or("trailing backslash in class")?
            } else {
                c
            };
            let lo = match lo {
                'n' => '\n',
                't' => '\t',
                'r' => '\r',
                other => other,
            };
            if self.peek() == Some('-')
                && self
                    .chars
                    .get(self.at + 1)
                    .map(|c| *c != ']')
                    .unwrap_or(false)
            {
                self.at += 1;
                let hi = self.bump().expect("checked above");
                let hi = if hi == '\\' {
                    self.bump().ok_or("trailing backslash in class")?
                } else {
                    hi
                };
                items.push(ClassItem::Range(lo, hi));
            } else {
                items.push(ClassItem::Char(lo));
            }
        }
        Ok(Node::Class { negate, items })
    }
}

fn escape_node(escape: char) -> Node {
    match escape {
        'w' => Node::Class {
            negate: false,
            items: vec![ClassItem::Alnum, ClassItem::Char('_')],
        },
        's' => Node::Class {
            negate: false,
            items: vec![ClassItem::Space],
        },
        'd' => Node::Class {
            negate: false,
            items: vec![ClassItem::Digit],
        },
        'W' => Node::Class {
            negate: true,
            items: vec![ClassItem::Alnum, ClassItem::Char('_')],
        },
        'S' => Node::Class {
            negate: true,
            items: vec![ClassItem::Space],
        },
        'D' => Node::Class {
            negate: true,
            items: vec![ClassItem::Digit],
        },
        'n' => Node::Char('\n'),
        't' => Node::Char('\t'),
        'r' => Node::Char('\r'),
        other => Node::Char(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn re(pattern: &str) -> Regex {
        Regex::compile(pattern, false, false).unwrap()
    }
    fn ere(pattern: &str) -> Regex {
        Regex::compile(pattern, true, false).unwrap()
    }

    #[test]
    fn literals_anchors_and_classes() {
        assert!(re("abc").is_match("xxabcxx"));
        assert!(!re("abc").is_match("abx"));
        assert!(re("^abc$").is_match("abc"));
        assert!(!re("^abc$").is_match("abcd"));
        assert!(re("a[0-9]b").is_match("xa5bx"));
        assert!(re("a[^0-9]b").is_match("xaxbx"));
        assert!(ere("[[:digit:]]+").is_match("ab12"));
        assert!(!re("[[:digit:]]+").is_match("abc"));
        assert!(re("[]x]").is_match("]"));
    }

    #[test]
    fn bre_and_ere_split_their_metacharacters() {
        // BRE: ( + ? are literal, \( \+ are operators.
        assert!(re("a+").is_match("xa+x"));
        assert!(!re("a+").is_match("xax"));
        assert!(re(r"a\+").is_match("aa"));
        assert!(re(r"\(ab\)\+").is_match("abab"));
        assert!(re(r"a\|b").is_match("qbq"));
        // ERE: the bare operators work.
        assert!(ere("a+").is_match("aa"));
        assert!(ere("a|b").is_match("b"));
        assert!(ere("(ab)+").is_match("abab"));
    }

    #[test]
    fn bounded_repeats_follow_the_count() {
        assert!(ere("a{2,3}").is_match("aa"));
        assert!(ere("a{2,3}").is_match("aaa"));
        assert!(!ere("^a{2,3}$").is_match("a"));
        assert!(!ere("^a{2,3}$").is_match("aaaa"));
        assert!(re(r"a\{2\}").is_match("xaaax"));
        assert!(ere("a{2}").is_match("aa"));
    }

    #[test]
    fn groups_captures_and_backreferences() {
        let found = ere("(a+)(b+)").find("xxaabb").unwrap();
        assert_eq!(found.groups[0], Some((2, 6)));
        assert_eq!(found.groups[1], Some((2, 4)));
        assert_eq!(found.groups[2], Some((4, 6)));
        assert!(re(r"\(ab\)\1").is_match("abab"));
        assert!(!re(r"\(ab\)\1").is_match("abac"));
    }

    #[test]
    fn case_folding_and_common_escapes() {
        let icase = Regex::compile("hello", false, true).unwrap();
        assert!(icase.is_match("say HeLLo"));
        assert!(ere(r"\d+").is_match("x42"));
        assert!(ere(r"\w+").is_match("ab_1"));
        assert!(ere("colou?r").is_match("color"));
    }

    #[test]
    fn the_leftmost_match_wins() {
        let found = ere("b+").find("abbbc").unwrap();
        assert_eq!((found.start, found.end), (1, 4));
    }

    #[test]
    fn iteration_walks_non_overlapping_matches() {
        let found = ere("a+").find_iter("aabaa");
        assert_eq!(found.len(), 2);
        assert_eq!((found[0].start, found[0].end), (0, 2));
        assert_eq!((found[1].start, found[1].end), (3, 5));
    }

    #[test]
    fn a_pathological_pattern_stops_at_the_budget() {
        // The classic runaway: (a*)* against a long non-matching tail. The explicit
        // backtracking stack plus the step budget turn the hang into "no match" — and
        // nothing here recurses natively, so no stack can overflow.
        let pattern = Regex::compile("(a*)*b", true, false).unwrap();
        assert!(!pattern.is_match(&"a".repeat(4000)));
        // A long greedy scan still works (the backtrack depth is heap, not the stack).
        let pattern = Regex::compile(".*x", true, false).unwrap();
        assert!(pattern.is_match(&format!("{}x", "y".repeat(4000))));
    }

    #[test]
    fn greedy_repeats_backtrack_to_a_match() {
        // <.*> must swallow too much then back off to the last '>'.
        let found = ere("<.*>").find("<a><b>").unwrap();
        assert_eq!((found.start, found.end), (0, 6));
        let found = ere("<.*?>").find("<a><b>").unwrap();
        assert_eq!((found.start, found.end), (0, 3));
    }
}
