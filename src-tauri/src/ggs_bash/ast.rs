//! The shell's abstract syntax — one source text parses once into this tree, and the
//! interpreter walks it. Words stay *unexpanded* here: quoting structure must survive to
//! execution time, because field splitting, globbing and `"$@"` all depend on which bytes
//! were quoted, not just what they spelled.

use std::sync::Arc;

/// A whole script (or command line): statements separated by `;`, newlines or `&`.
#[derive(Debug, Clone)]
pub struct Script(pub Vec<Stmt>);

#[derive(Debug, Clone)]
pub struct Stmt {
    pub body: AndOr,
    /// `&`: run the whole chain without waiting.
    pub background: bool,
}

/// `a && b || c` — one pipeline and the chain behind it.
#[derive(Debug, Clone)]
pub struct AndOr {
    pub first: Pipeline,
    /// `(is_and, pipeline)`: `true` joins with `&&`.
    pub rest: Vec<(bool, Pipeline)>,
}

#[derive(Debug, Clone)]
pub struct Pipeline {
    /// `!`: invert the pipeline's exit status.
    pub negated: bool,
    pub stages: Vec<Stage>,
}

#[derive(Debug, Clone)]
pub struct Stage {
    pub redirects: Vec<Redir>,
    pub command: Command,
}

#[derive(Debug, Clone)]
pub enum Command {
    Simple(SimpleCommand),
    /// `[[ ... ]]` — kept apart from simple commands because its words keep operator
    /// tokens (`-f`, `==`, `&&`) the shell lexer would otherwise own.
    Condition(Vec<CondTok>),
    Compound(Compound),
}

/// One `[[ ]]` token: either a (quoted-structure-carrying) word or a spelled operator.
#[derive(Debug, Clone)]
pub enum CondTok {
    Word(Word),
    Op(String),
}

#[derive(Debug, Clone)]
pub struct SimpleCommand {
    /// `NAME=value` prefixes; with no command word they assign to the shell itself.
    pub assigns: Vec<(String, Word)>,
    pub words: Vec<Word>,
}

#[derive(Debug, Clone)]
pub enum Compound {
    If {
        cond: Arc<Script>,
        then: Arc<Script>,
        elifs: Vec<(Arc<Script>, Arc<Script>)>,
        otherwise: Option<Arc<Script>>,
    },
    While {
        cond: Arc<Script>,
        body: Arc<Script>,
        until: bool,
    },
    For {
        variable: String,
        words: Vec<Word>,
        body: Arc<Script>,
    },
    /// `for ((init; cond; step)); do …; done` — each part a `(( ))` script; an empty
    /// condition loops forever.
    CFor {
        init: Arc<Script>,
        cond: Option<Arc<Script>>,
        step: Arc<Script>,
        body: Arc<Script>,
    },
    Case {
        subject: Word,
        arms: Vec<CaseArm>,
    },
    /// `( ... )`
    Subshell(Arc<Script>),
    /// `{ ... }`
    Brace(Arc<Script>),
    Function {
        name: String,
        body: Arc<Script>,
    },
}

#[derive(Debug, Clone)]
pub struct CaseArm {
    /// `pat1|pat2)` — any pattern matches.
    pub patterns: Vec<Word>,
    pub body: Arc<Script>,
}

/* ---------- Words ---------- */

/// A word is a run of parts; quoting boundaries between parts are what expansion reads.
#[derive(Debug, Clone, Default)]
pub struct Word(pub Vec<Part>);

impl Word {
    pub fn literal(text: &str) -> Word {
        Word(vec![Part::Lit(text.to_owned())])
    }
    /// The word spelled as plain unquoted text (parser keyword matching).
    pub fn as_literal(&self) -> Option<String> {
        match self.0.as_slice() {
            [Part::Lit(text)] => Some(text.clone()),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum Part {
    /// Unquoted literal text — splittable, glob-eligible.
    Lit(String),
    /// Single-quoted text — inert.
    Quoted(String),
    /// Double-quoted interior; expands, but never splits or globs.
    DQuoted(Vec<DPart>),
    /// A parameter expansion at unquoted level.
    Var {
        name: String,
        op: ParamOp,
        word: Option<Word>,
    },
    /// `$(...)` or backticks.
    CmdSub(Script),
    /// `<(script)` / `>(script)`: expands to a temp file's path — the input form's
    /// content is the script's output, the output form's script consumes the file
    /// after the command runs.
    ProcSub(Script, bool),
    /// `$(( ... ))`, the raw expression text.
    Arith(String),
    /// `(a b c)` after `name=` / `name+=`: the array literal's element words.
    ArrayLit(Vec<Word>),
    /// The separator inside a two-argument parameter operator (`${x/pat/rep}`,
    /// `${x:off:len}`): the word's parts before it are the first argument.
    Sep,
}

#[derive(Debug, Clone)]
pub enum DPart {
    Lit(String),
    Var {
        name: String,
        op: ParamOp,
        word: Option<Word>,
    },
    CmdSub(Script),
    ProcSub(Script, bool),
    Arith(String),
}

/// What `${name …}` does when the variable is set or unset.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ParamOp {
    Plain,
    /// `${name:-word}` / `${name-word}`
    Default,
    /// `${name:=word}`
    Assign,
    /// `${name:+word}`
    Alternate,
    /// `${#name}` (the word is unused)
    Length,
    /// `${name#pat}` / `${name##pat}`
    TrimPrefix {
        longest: bool,
    },
    /// `${name%pat}` / `${name%%pat}`
    TrimSuffix {
        longest: bool,
    },
    /// `${name/pat/rep}`, `//` (all), `/#` (anchored at the start), `/%` (the end);
    /// `anchor` is 0 none, 1 start, 2 end. The word is `pat Sep rep`.
    Replace {
        all: bool,
        anchor: u8,
    },
    /// `${name:off}` / `${name:off:len}` (the word is `off Sep len`)
    Substring,
    /// `${name^}` / `${name^^}` / `${name,}` / `${name,,}`
    Case {
        upper: bool,
        all: bool,
    },
    /// `${!arr[@]}` — the array's indices
    Keys,
}

/* ---------- Redirections ---------- */

#[derive(Debug, Clone)]
pub struct Redir {
    pub fd: Option<u32>,
    pub op: RedirOp,
    pub target: RedirTarget,
}

#[derive(Debug, Clone, Copy)]
pub enum RedirOp {
    /// `>` (truncate)
    Output,
    /// `>>`
    Append,
    /// `<`
    Input,
    /// `>&n` / `<&n`
    Dup,
    /// `&>` — both streams to the file
    Both,
    /// `<<` (content carried with the op)
    Heredoc,
    /// `<<-` (leading tabs stripped)
    HeredocStrip,
    /// `<<<`
    Herestring,
}

#[derive(Debug, Clone)]
pub enum RedirTarget {
    Word(Word),
    Fd(u32),
    /// The collected body; `expand` is false when the delimiter was quoted.
    Heredoc {
        content: Arc<String>,
        expand: bool,
    },
}
