//! GGS-patch: the module bytecode cache — the compiled `CodeBlock` tree crosses as a
//! serde mirror, bincode-encoded to `~/.ggs/cache/bytecode/<sha256(source)>.gcbc`.
//!
//! Loading a multi-megabyte bundle costs its parse (~285 ms for claude-code's 3 MB on the
//! dev machine) plus its bytecode generation (~100 ms) on every backend start, and a
//! bundle's source never changes under its installed path. The cache turns that into one
//! blob read (~20 ms).
//!
//! The mirror structs below are the whole contract: every field of `CodeBlock` that
//! survives compilation maps to a plain serde shape — bytes, numbers, code-unit vectors
//! for `JsString`s and recursive function constants. Two runtime shapes deliberately
//! don't round-trip: the inline caches (rebuilt empty; they repopulate on first hit) and
//! the scope chain's global terminator (replaced by the running realm's scope, tying the
//! loaded scopes into the live environment). The source text rides along so
//! `Function.prototype.toString` and error positions work from a cached load.
//!
//! Scopes are a FLAT table, not a recursive mirror: a real bundle's constants carry tens
//! of thousands of scopes whose outer chains share ancestors (every sibling closure hangs
//! off the same parent), and a recursive `outer: Box<SerScope>` expands each chain in
//! full — the first real-bundle encode of claude-code ran past half a minute without
//! finishing. The table writes each distinct scope once (deduplicated by its `Rc`
//! address, ancestors first) and references outers by index; sibling constants share a
//! parent through its id exactly as they share the `Rc` at runtime.
//!
//! Correctness contract: the cache key is the wire-format version + the source bytes'
//! SHA-256; any deserialize failure returns `None` for the caller to fall back to a
//! normal compile — a stale or corrupt blob degrades to the old speed, never to wrong
//! behavior.

use super::{
    code_block::{CodeBlockFlags, Constant},
    opcode::ByteCode,
    CodeBlock,
};
use boa_ast::{
    scope::{BindingLocator, Scope},
    LinearPosition, LinearSpan, Position, SourceText as AstSourceText,
};
use boa_gc::Gc;
use crate::JsBigInt;
use serde::{Deserialize, Serialize};

/// Bump whenever the mirror or the compiler's semantics change; old blobs fail the header
/// check and recompile. 2: module wrappers compile register locals first (guarded by
/// ggs-node's `REGISTER_LOCALS_LIMIT`), so a hit must not keep an all-escaping tree.
/// 3: strings deduplicate through one table (the 2 MB of repeated literal units was
/// most of a 29 MB claude-code blob).
pub const FORMAT_VERSION: u32 = 3;

/* ---------- the serde mirror ---------- */

#[derive(Serialize, Deserialize)]
pub struct SerBlock {
    flags: u16,
    length: u32,
    parameter_length: u32,
    register_count: u32,
    this_mode: u8,
    mapped: Vec<Option<u32>>,
    bytecode: Vec<u8>,
    constants: Vec<SerConstant>,
    bindings: Vec<SerBinding>,
    handlers: Vec<[u32; 3]>,
    ic_names: Vec<u32>,
    function_name: u32,
    /// This block's slice of the blob's shared source text (see [`CacheBlob`]).
    span: Option<[u32; 2]>,
    entries: Vec<SerEntry>,
    path: Option<Vec<u8>>,
}

#[derive(Serialize, Deserialize)]
pub enum SerConstant {
    /// An index into [`CacheBlob::strings`].
    String(u32),
    Function(Box<SerBlock>),
    BigInt(String),
    /// An index into [`CacheBlob::scopes`].
    Scope(u32),
}

#[derive(Serialize, Deserialize)]
pub struct SerBinding {
    /// An index into [`CacheBlob::strings`].
    name: u32,
    scope: u32,
    binding_index: u32,
    unique_scope_id: u32,
}

#[derive(Serialize, Deserialize)]
pub struct SerEntry {
    pc: u32,
    line: Option<u32>,
    column: Option<u32>,
}

/// One distinct scope of the flat table. `outer` is the global terminator or the table
/// index of an already-written ancestor — the table is ordered ancestors-first, so the
/// decoder rebuilds every scope over an outer that exists.
#[derive(Serialize, Deserialize)]
pub struct SerScopeRec {
    unique_id: u32,
    index: u32,
    function: bool,
    this_escaped: bool,
    bindings: Vec<SerBindingField>,
    outer: SerOuter,
}

#[derive(Serialize, Deserialize)]
pub enum SerOuter {
    /// The running realm's global scope — the chain's live terminator.
    Global,
    /// A table index (always smaller than this record's own).
    Id(u32),
}

#[derive(Serialize, Deserialize)]
pub struct SerBindingField {
    /// An index into [`CacheBlob::strings`].
    name: u32,
    index: u32,
    flags: u8,
}

/* ---------- encode ---------- */

/// The compiled tree's mirror — bincode-serialized by the embedder (the cache lives in
/// ggs-node's `require`, not in the engine).
#[derive(Serialize, Deserialize)]
pub struct CacheBlob {
    pub version: u32,
    /// Every distinct string the tree cites (constants, binding and IC names) — one
    /// table, referenced by index: the same few thousand names appear tens of thousands
    /// of times over a bundle, and the per-occurrence copies dominated the blob.
    pub strings: Vec<Vec<u16>>,
    /// Every distinct scope the tree's constants cite, ancestors first (see
    /// [`SerScopeRec`]).
    pub scopes: Vec<SerScopeRec>,
    pub block: SerBlock,
}

/// Mirrors a compiled `CodeBlock` tree (a module wrapper's) into the cache shape.
pub fn to_mirror(root: &CodeBlock) -> CacheBlob {
    let mut ctx = MirrorCtx::default();
    let block = mirror_block(root, &mut ctx);
    if std::env::var_os("GGS_CACHE_STATS").is_some() {
        let mut stats = BlockStats::default();
        stats.walk(&block);
        let units: usize = ctx.strings.table.iter().map(Vec::len).sum();
        eprintln!(
            "[cache-stats] blocks {} bytecode {}B entries {} constants {} strings {} ({} units) scopes {}",
            stats.blocks, stats.bytecode, stats.entries, stats.constants,
            ctx.strings.table.len(), units, ctx.scopes.recs.len()
        );
    }
    CacheBlob {
        version: FORMAT_VERSION,
        strings: ctx.strings.table,
        scopes: ctx.scopes.recs,
        block,
    }
}

/// GGS-diag: the blob's composition, behind `GGS_CACHE_STATS`.
#[derive(Default)]
struct BlockStats {
    blocks: usize,
    bytecode: usize,
    entries: usize,
    constants: usize,
}

impl BlockStats {
    fn walk(&mut self, block: &SerBlock) {
        self.blocks += 1;
        self.bytecode += block.bytecode.len();
        self.entries += block.entries.len();
        self.constants += block.constants.len();
        for constant in &block.constants {
            if let SerConstant::Function(function) = constant {
                self.walk(function);
            }
        }
    }
}

/// The deduplicating collectors behind the mirror: the flat scope table and the string
/// table, threaded through one context.
#[derive(Default)]
struct MirrorCtx {
    scopes: ScopeTable,
    strings: StringTable,
}

#[derive(Default)]
struct StringTable {
    ids: std::collections::HashMap<Vec<u16>, u32>,
    table: Vec<Vec<u16>>,
}

impl StringTable {
    fn id_of(&mut self, name: &boa_engine::JsString) -> u32 {
        let units = name.to_vec();
        if let Some(id) = self.ids.get(&units) {
            return *id;
        }
        let id = self.table.len() as u32;
        self.ids.insert(units.clone(), id);
        self.table.push(units);
        id
    }
}

/// The deduplicating collector behind the flat scope table: one pass over the tree, each
/// distinct scope `Rc` written once, each chain emitted outermost-first so every record's
/// `outer` id (or the global terminator) is already known.
#[derive(Default)]
struct ScopeTable {
    ids: std::collections::HashMap<usize, u32>,
    recs: Vec<SerScopeRec>,
}

/// A scope constant citing the realm's own global scope: the live global, never a
/// reconstructed one (its bindings are the running realm's, not the compile-time copy).
pub const GLOBAL_SCOPE_ID: u32 = u32::MAX;

impl ScopeTable {
    /// The table index of `scope`, writing it (and any not-yet-written ancestors) first.
    /// The blob's string table rides along for the binding names.
    fn id_of(&mut self, scope: &Scope, strings: &mut StringTable) -> u32 {
        if scope.is_global() {
            return GLOBAL_SCOPE_ID;
        }
        if let Some(id) = self.ids.get(&scope_key(scope)) {
            return *id;
        }
        // Collect this chain's unwritten scopes innermost→outermost, then emit them
        // outermost→innermost — an ancestor emitted this way is a plain table entry by
        // the time its descendants reference it.
        let mut chain = Vec::new();
        let mut current = scope.clone();
        loop {
            // The live global is the chain's terminator, never a table record (see
            // [`GLOBAL_SCOPE_ID`]).
            if current.is_global() {
                break;
            }
            if let Some(id) = self.ids.get(&scope_key(&current)) {
                chain.push((current, Some(*id)));
                break;
            }
            let outer = current.outer();
            chain.push((current, None));
            match outer {
                Some(outer) => current = outer,
                None => break,
            }
        }
        while let Some((scope, written)) = chain.pop() {
            if written.is_some() {
                continue;
            }
            let outer = match scope.outer() {
                None => SerOuter::Global,
                Some(outer) if outer.is_global() => SerOuter::Global,
                Some(outer) => SerOuter::Id(self.id_of(&outer, strings)),
            };
            let id = self.recs.len() as u32;
            self.recs.push(SerScopeRec {
                unique_id: scope.unique_id(),
                index: scope.index(),
                function: scope.is_function(),
                this_escaped: scope.escaped_this(),
                bindings: scope
                    .binding_records()
                    .into_iter()
                    .map(|(name, index, flags)| SerBindingField {
                        name: strings.id_of(&name),
                        index,
                        flags,
                    })
                    .collect(),
                outer,
            });
            self.ids.insert(scope_key(&scope), id);
        }
        self.ids[&scope_key(scope)]
    }
}

/// One shared `JsString` out of the blob's table (an index the mirror wrote).
fn table_string(id: u32, strings: &[boa_engine::JsString]) -> Option<boa_engine::JsString> {
    strings.get(id as usize).cloned()
}

/// A scope's identity in the dedup table — its `Rc` allocation, not its contents: two
/// constants citing the same scope object must land on one table entry, exactly as they
/// share the `Rc` at runtime.
fn scope_key(scope: &Scope) -> usize {
    scope.ptr() as usize
}

fn mirror_block(block: &CodeBlock, ctx: &mut MirrorCtx) -> SerBlock {
    let map = block.source_info.map();
    let text = block.source_info.text_spanned();
    SerBlock {
        flags: block.flags.get().bits(),
        length: block.length,
        parameter_length: block.parameter_length,
        register_count: block.register_count,
        this_mode: match block.this_mode {
            crate::builtins::function::ThisMode::Global => 0,
            crate::builtins::function::ThisMode::Strict => 1,
            crate::builtins::function::ThisMode::Lexical => 2,
        },
        mapped: block
            .mapped_arguments_binding_indices
            .iter()
            .copied()
            .collect(),
        bytecode: block.bytecode.bytecode.to_vec(),
        constants: block
            .constants
            .iter()
            .map(|constant| match constant {
                Constant::String(string) => SerConstant::String(ctx.strings.id_of(string)),
                Constant::Function(function) => {
                    SerConstant::Function(Box::new(mirror_block(function, ctx)))
                }
                Constant::BigInt(bigint) => {
                    // Text form (decimal: no prefix, sign included): bigints are rare in
                    // bundles, the parse cost is nothing.
                    SerConstant::BigInt(bigint.to_string_radix(10))
                }
                Constant::Scope(scope) => SerConstant::Scope(ctx.scopes.id_of(scope, &mut ctx.strings)),
            })
            .collect(),
        bindings: block
            .bindings
            .iter()
            .map(|locator| SerBinding {
                name: ctx.strings.id_of(locator.name()),
                scope: locator.scope_index(),
                binding_index: locator.binding_index(),
                unique_scope_id: locator.unique_scope_id(),
            })
            .collect(),
        handlers: block
            .handlers
            .iter()
            .map(|handler| [handler.start, handler.end, handler.environment_count])
            .collect(),
        // Inline caches cross as their names only — the shape/slot state is runtime
        // learning and repopulates on the first hit after a load.
        ic_names: block
            .ic
            .iter()
            .map(|cache| ctx.strings.id_of(&cache.name))
            .collect(),
        function_name: ctx.strings.id_of(block.source_info.function_name()),
        span: text
            .span()
            .map(|span| [span.start().pos() as u32, span.end().pos() as u32]),
        entries: map
            .entries()
            .iter()
            .map(|entry| SerEntry {
                pc: entry.pc,
                line: entry.position.map(|position| position.line_number()),
                column: entry.position.map(|position| position.column_number()),
            })
            .collect(),
        path: match map.path() {
            super::source_info::SourcePath::None => None,
            super::source_info::SourcePath::Eval => Some(vec![0]),
            super::source_info::SourcePath::Json => Some(vec![1]),
            super::source_info::SourcePath::Path(path) => {
                #[cfg(windows)]
                use std::os::windows::ffi::OsStrExt as _;
                #[cfg(windows)]
                let bytes: Vec<u8> = path
                    .as_os_str()
                    .encode_wide()
                    .flat_map(|unit| unit.to_le_bytes())
                    .collect();
                #[cfg(not(windows))]
                let bytes: Vec<u8> = path.as_os_str().as_encoded_bytes().to_vec();
                let mut tagged = vec![2];
                tagged.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
                tagged.extend_from_slice(&bytes);
                Some(tagged)
            }
        },
    }
}

/* ---------- decode ---------- */

/// Rebuilds a `CodeBlock` tree from the cache's mirror. `None` on any mismatch — the
/// caller compiles normally.
pub fn from_mirror(blob: CacheBlob, source: &str, global_scope: &Scope) -> Option<Box<CodeBlock>> {
    if blob.version != FORMAT_VERSION {
        return None;
    }
    // The shared source text once — every block's `SpannedSourceText` is an `Rc` clone
    // over it with the block's own span. The text itself is NOT in the blob: the loader
    // reads the module's file anyway, and the source on disk is the cache's key.
    let mut source_text = AstSourceText::with_capacity(source.len());
    for unit in source.encode_utf16() {
        source_text.collect_code_point(u32::from(unit));
    }
    let source = crate::spanned_source_text::SourceText::new(source_text);
    // The string table once — one shared `JsString` per distinct name (a bundle repeats
    // the same few thousand names tens of thousands of times).
    let strings: Vec<boa_engine::JsString> = blob
        .strings
        .iter()
        .map(|units| boa_engine::JsString::from(&units[..]))
        .collect();
    // The flat table next: records are ancestors-first, so every `outer` (or the global
    // terminator) is built by the time its descendants restore over it.
    let mut scopes: Vec<Scope> = Vec::with_capacity(blob.scopes.len());
    for rec in blob.scopes {
        let outer = match rec.outer {
            SerOuter::Global => global_scope.clone(),
            SerOuter::Id(id) => scopes.get(id as usize)?.clone(),
        };
        let scope = Scope::restore(Some(&outer), rec.unique_id, rec.index, rec.function);
        for binding in rec.bindings {
            scope.restore_binding(
                table_string(binding.name, &strings)?,
                binding.index,
                binding.flags,
            );
        }
        scope.restore_this_escaped(rec.this_escaped);
        scopes.push(scope);
    }
    unmirror_block(blob.block, &scopes, global_scope, &source, &strings)
}

fn unmirror_block(
    mirror: SerBlock,
    scopes: &[Scope],
    global_scope: &Scope,
    source: &crate::spanned_source_text::SourceText,
    strings: &[boa_engine::JsString],
) -> Option<Box<CodeBlock>> {
    let flags = CodeBlockFlags::from_bits_truncate(mirror.flags);
    let this_mode = match mirror.this_mode {
        0 => crate::builtins::function::ThisMode::Global,
        1 => crate::builtins::function::ThisMode::Strict,
        2 => crate::builtins::function::ThisMode::Lexical,
        _ => return None,
    };
    let mut constants = thin_vec::ThinVec::with_capacity(mirror.constants.len());
    for constant in mirror.constants {
        constants.push(match constant {
            SerConstant::String(id) => Constant::String(table_string(id, strings)?),
            SerConstant::Function(block) => {
                Constant::Function(Gc::new(*unmirror_block(
                    *block, scopes, global_scope, source, strings,
                )?))
            }
            SerConstant::BigInt(text) => Constant::BigInt(JsBigInt::from_string(&text)?),
            SerConstant::Scope(id) => Constant::Scope(if id == GLOBAL_SCOPE_ID {
                global_scope.clone()
            } else {
                scopes.get(id as usize)?.clone()
            }),
        });
    }
    let mut bindings = Vec::with_capacity(mirror.bindings.len());
    for binding in mirror.bindings {
        bindings.push(BindingLocator::from_parts(
            table_string(binding.name, strings)?,
            binding.scope,
            binding.binding_index,
            binding.unique_scope_id,
        ));
    }
    let mut handlers = thin_vec::ThinVec::with_capacity(mirror.handlers.len());
    for [start, end, environment_count] in mirror.handlers {
        handlers.push(super::Handler {
            start,
            end,
            environment_count,
        });
    }
    let mut ic = Vec::with_capacity(mirror.ic_names.len());
    for name in mirror.ic_names {
        ic.push(super::inline_cache::InlineCache::new(table_string(name, strings)?));
    }
    // The path crosses tagged: [0] none, [1] eval, [2] json, [3] a UTF-16LE (Windows) or
    // opaque (other) byte string of the file path.
    let path = match mirror.path.as_deref() {
        None => super::source_info::SourcePath::None,
        Some([0]) => super::source_info::SourcePath::Eval,
        Some([1]) => super::source_info::SourcePath::Json,
        Some([2, rest @ ..]) => {
            if rest.len() < 4 {
                return None;
            }
            let len = u32::from_le_bytes(rest[0..4].try_into().ok()?) as usize;
            let raw = rest.get(4..4 + len)?;
            #[cfg(windows)]
            {
                use std::os::windows::ffi::OsStringExt as _;
                let wide: Vec<u16> = raw
                    .chunks_exact(2)
                    .map(|pair| u16::from_le_bytes(pair.try_into().expect("2 bytes")))
                    .collect();
                super::source_info::SourcePath::Path(std::rc::Rc::from(
                    std::path::PathBuf::from(std::ffi::OsString::from_wide(&wide)),
                ))
            }
            #[cfg(not(windows))]
            {
                super::source_info::SourcePath::Path(std::rc::Rc::from(
                    std::path::PathBuf::from(
                        // SAFETY: the encode side (above) wrote these very bytes off
                        // `OsStr::as_encoded_bytes` — the documented round trip of this
                        // constructor, sound on every platform it compiles for.
                        unsafe {
                            std::ffi::OsString::from_encoded_bytes_unchecked(raw.to_vec())
                        },
                    ),
                ))
            }
        }
        _ => return None,
    };
    let span = mirror.span.map(|[start, end]| {
        LinearSpan::new(
            LinearPosition::new(start as usize),
            LinearPosition::new(end as usize),
        )
    });
    let mut entries = Vec::with_capacity(mirror.entries.len());
    for entry in mirror.entries {
        entries.push(super::source_info::Entry {
            pc: entry.pc,
            position: match (entry.line, entry.column) {
                (Some(line), Some(column)) => Some(Position::new(line, column)),
                _ => None,
            },
        });
    }
    let source_info = super::source_info::SourceInfo::new(
        super::source_info::SourceMap::new(entries.into_boxed_slice(), path),
        table_string(mirror.function_name, strings)?,
        crate::SpannedSourceText::from_parts(source.clone(), span),
    );
    Some(Box::new(CodeBlock {
        flags: std::cell::Cell::new(flags),
        length: mirror.length,
        parameter_length: mirror.parameter_length,
        register_count: mirror.register_count,
        this_mode,
        mapped_arguments_binding_indices: mirror.mapped.into_iter().collect(),
        bytecode: ByteCode {
            bytecode: mirror.bytecode.into_boxed_slice(),
        },
        constants,
        bindings: bindings.into_boxed_slice(),
        handlers,
        ic: ic.into_boxed_slice(),
        source_info,
    }))
}
