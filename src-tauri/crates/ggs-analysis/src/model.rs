//! The analysis model's compact vocabulary (module 17): the interned string table and
//! the per-symbol / per-call-site records the workspace model holds. Every string the
//! parse layer produced — declaration names, containers, call spellings, imports —
//! interns to one `u32` id over one shared buffer, and each record carries ids and
//! line numbers only, so a large tree's resident footprint is tens of bytes per item
//! instead of several heap strings. Decoding goes back through
//! [`Names::get`]; the ids are only meaningful inside one `AnalysisData`.

use std::collections::HashMap;

/// The interned string table: one buffer with (offset, length) spans, deduplicated
/// through hash buckets (`HashMap<u64, Vec<u32>>` — the buffer is the only copy of the
/// text; the buckets hold hashes and ids, never strings).
#[derive(Default, Debug)]
pub struct Names {
    buf: String,
    spans: Vec<(u32, u32)>,
    buckets: HashMap<u64, Vec<u32>>,
}

fn hash_of(text: &str) -> u64 {
    // FNV-1a 64 — a stable, allocation-free hash for bucketing; bucket members are
    // compared by content, so collisions only cost a scan.
    let mut hash = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// The "absent" id for the optional slots (`Sym::container`, `Call::receiver`,
/// `Call::owner`) — never handed out by `intern`.
pub const NONE: u32 = u32::MAX;

impl Names {
    pub fn new() -> Names {
        Names::default()
    }

    /// Intern `text`, answering its id (existing when the text was interned before).
    pub fn intern(&mut self, text: &str) -> u32 {
        let hash = hash_of(text);
        if let Some(members) = self.buckets.get(&hash) {
            for &id in members {
                if self.get(id) == text {
                    return id;
                }
            }
        }
        let offset = self.buf.len() as u32;
        self.buf.push_str(text);
        let id = self.spans.len() as u32;
        self.spans.push((offset, text.len() as u32));
        self.buckets.entry(hash).or_default().push(id);
        id
    }

    /// The text of an interned id. `NONE` reads as the empty string, so optional
    /// slots decode without branching at every use.
    pub fn get(&self, id: u32) -> &str {
        if id == NONE {
            return "";
        }
        let (offset, len) = self.spans[id as usize];
        &self.buf[offset as usize..offset as usize + len as usize]
    }

    /// The id of `text` when it was interned before.
    pub fn find(&self, text: &str) -> Option<u32> {
        let hash = hash_of(text);
        self.buckets.get(&hash).and_then(|members| {
            members.iter().copied().find(|&id| self.get(id) == text)
        })
    }

    /// How many distinct strings are interned.
    pub fn len(&self) -> usize {
        self.spans.len()
    }

    pub fn is_empty(&self) -> bool {
        self.spans.is_empty()
    }
}

/* ---------- The records ---------- */

/// One declaration, compact. The parse layer's strings are interned (`name`,
/// `container` are [`Names`] ids; `NONE` when there is no container) and the
/// signature lives in the analysis's signature arena (`sig_off`/`sig_len`).
/// Measured shape (`params`…`nesting`) is clamped, never wrong by more than the
/// clamp itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sym {
    pub name: u32,
    pub container: u32,
    /// The declaration's kind, one of [`SymKind`].
    pub kind: SymKind,
    pub exported: bool,
    pub params: u16,
    /// Decision points + 1: the cyclomatic complexity of the body.
    pub complexity: u16,
    pub nesting: u8,
    /// 0-based line of the name, and the last line of the whole declaration.
    pub line: u32,
    pub end_line: u32,
    pub sig_off: u32,
    pub sig_len: u16,
}

/// A declaration's kind — the parse layer's capture spellings, enumerated.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum SymKind {
    Function,
    Method,
    Class,
    Struct,
    Interface,
    Enum,
    Module,
    Type,
    Macro,
    /// Anything the grammar layer may add later; never a function or method, so
    /// the per-function reports keep skipping it.
    Other,
}

impl SymKind {
    /// The parse layer's `def.<kind>` spelling (what the reports print).
    pub fn as_str(self) -> &'static str {
        match self {
            SymKind::Function => "function",
            SymKind::Method => "method",
            SymKind::Class => "class",
            SymKind::Struct => "struct",
            SymKind::Interface => "interface",
            SymKind::Enum => "enum",
            SymKind::Module => "module",
            SymKind::Type => "type",
            SymKind::Macro => "macro",
            SymKind::Other => "other",
        }
    }

    pub fn of_capture(kind: &str) -> SymKind {
        match kind {
            "function" => SymKind::Function,
            "method" => SymKind::Method,
            "class" => SymKind::Class,
            "struct" => SymKind::Struct,
            "interface" => SymKind::Interface,
            "enum" => SymKind::Enum,
            "module" => SymKind::Module,
            "type" => SymKind::Type,
            "macro" => SymKind::Macro,
            _ => SymKind::Other,
        }
    }

    /// Whether the per-function reports measure this declaration.
    pub fn is_function(self) -> bool {
        matches!(self, SymKind::Function | SymKind::Method)
    }
}

/// One call site, compact: the callee's spelling and receiver interned (`NONE` when
/// there is no receiver), where it happens, which declaration owns it
/// (`owner`, `NONE` for top-level code) and how its name resolved
/// (`class` — see [`ResolveClass`]). The resolution the old engine materialized as
/// per-edge rows is now re-derived from this record at query time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Call {
    pub name: u32,
    pub receiver: u32,
    /// 0-based line and byte column of the callee spelling.
    pub line: u32,
    pub column: u32,
    /// The owning declaration's index in its file's symbols; [`NONE`] for a call
    /// outside any declaration body.
    pub owner: u32,
    pub class: ResolveClass,
}

/// How a call's spelling resolved against the workspace's declarations — decided
/// once at derive time (the same pecking order the old resolver walked), so both
/// graph directions test membership against it in O(1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ResolveClass {
    /// The name has one declaration in the workspace.
    Unique,
    /// The receiver names a known type; that type's methods win.
    ByContainer,
    /// `self`/`this` resolved to the enclosing type's methods.
    SelfType,
    /// Everything else: every declaration of the name (the visible ambiguity).
    AllCandidates,
}

/* ---------- tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interning_dedups_and_decodes() {
        let mut names = Names::new();
        let first = names.intern("helper");
        let second = names.intern("helper");
        assert_eq!(first, second);
        assert_eq!(names.get(first), "helper");
        assert_eq!(names.intern("Widget::step"), first + 1);
        assert_eq!(names.get(first + 1), "Widget::step");
        assert_eq!(names.find("helper"), Some(first));
        assert_eq!(names.find("missing"), None);
        assert_eq!(names.get(NONE), "", "the absent id reads empty");
        assert_eq!(names.len(), 2);
    }

    #[test]
    fn hash_collision_buckets_still_dedup_by_content() {
        let mut names = Names::new();
        // Distinct texts sharing nothing; a colliding pair would be caught by the
        // content compare — every id must decode back to what was interned.
        let texts = ["a", "b", "ab", "ba", "", "longer string with spaces"];
        for round in 0..2 {
            for text in texts {
                let id = names.intern(text);
                assert_eq!(names.get(id), text, "round {round}");
            }
        }
        assert_eq!(names.len(), texts.len());
    }

    #[test]
    fn kinds_round_trip() {
        for kind in [
            SymKind::Function,
            SymKind::Method,
            SymKind::Class,
            SymKind::Struct,
            SymKind::Interface,
            SymKind::Enum,
            SymKind::Module,
            SymKind::Type,
            SymKind::Macro,
        ] {
            assert_eq!(SymKind::of_capture(kind.as_str()), kind);
        }
        assert_eq!(SymKind::of_capture("whatever"), SymKind::Other);
        assert!(SymKind::Function.is_function());
        assert!(!SymKind::Struct.is_function());
    }
}
