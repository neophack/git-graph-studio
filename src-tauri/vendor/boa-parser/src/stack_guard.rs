//! GGS-patch: the native stack guard.
//!
//! Boa bounds JavaScript recursion by counting VM frames, but several of its own Rust
//! paths recurse once per nesting level with no frame pushed — the recursive-descent
//! parser (one nested function, paren or array literal is a dozen Rust frames),
//! `JSON.stringify` of a deep object, `Array.prototype.join` over nested arrays,
//! `flat(Infinity)`. On the embedder's 2 MiB thread a hundred nested closures were
//! enough to overflow the native stack, and a stack overflow is not a panic: the process
//! dies on the spot (0xC00000FD on Windows), taking every request of the backend with it.
//!
//! An embedder that owns its thread arms the guard once, at the top of that thread, with
//! the stack size it spawned the thread with. From then on the recursion hubs ask
//! [`exhausted`] and fail with an ordinary error — a `SyntaxError` from the parser, a
//! `RangeError` from the engine, the shape Node gives — while there is still stack left
//! to unwind through. A thread that never armed the guard (tests, other embedders) checks
//! nothing.

use std::cell::Cell;

thread_local! {
    /// The lowest stack address a guarded path may run at; 0 is "not armed".
    static ENGINE_FLOOR: Cell<usize> = const { Cell::new(0) };
    /// The parser's floor, set higher than the engine's: the passes that follow a parse
    /// (scope analysis, the bytecompiler, the AST's own drop) recurse over the same tree
    /// unguarded, so the parser must stop with room left for them.
    static PARSER_FLOOR: Cell<usize> = const { Cell::new(0) };
}

/// The stack the engine's checks keep free: the deepest unguarded stretch between two
/// checks (a native builtin's frames, a `Drop`, the error path itself) must fit in it.
const ENGINE_RESERVE_MIN: usize = 512 * 1024;
/// The share of the stack the parser leaves to the passes that walk its tree afterwards.
const PARSER_SHARE_DIVISOR: usize = 3;

/// The current stack position, as an address. Stacks grow downward on every target the
/// embedder ships (x86-64, AArch64), so a smaller address is a deeper stack.
#[inline(always)]
fn stack_position() -> usize {
    let marker = 0u8;
    std::ptr::from_ref(std::hint::black_box(&marker)) as usize
}

/// Arm the guard on the calling thread, which must have been spawned with `stack_size`
/// bytes of stack and must call this near its top frame.
///
/// The engine trips with an eighth of the stack (at least 512 KiB) still free; the parser
/// trips once two thirds of the stack are used, leaving the last third to the passes that
/// recurse over the parsed tree without a guard of their own.
pub fn arm(stack_size: usize) {
    let top = stack_position();
    let engine_reserve = (stack_size / 8).max(ENGINE_RESERVE_MIN);
    let parser_reserve = (stack_size / PARSER_SHARE_DIVISOR).max(engine_reserve);
    ENGINE_FLOOR.with(|floor| floor.set(top.saturating_sub(stack_size.saturating_sub(engine_reserve))));
    PARSER_FLOOR.with(|floor| floor.set(top.saturating_sub(stack_size.saturating_sub(parser_reserve))));
}

/// Disarm the guard on the calling thread.
pub fn disarm() {
    ENGINE_FLOOR.with(|floor| floor.set(0));
    PARSER_FLOOR.with(|floor| floor.set(0));
}

/// Whether the engine's recursion hubs must stop here: the thread is armed and the stack
/// has reached its engine floor.
#[inline]
#[must_use]
pub fn exhausted() -> bool {
    let floor = ENGINE_FLOOR.with(Cell::get);
    floor != 0 && stack_position() < floor
}

/// Whether the parser must stop here (see [`arm`]: its floor sits above the engine's).
#[inline]
#[must_use]
pub fn parser_exhausted() -> bool {
    let floor = PARSER_FLOOR.with(Cell::get);
    floor != 0 && stack_position() < floor
}

/// The message both layers fail with — Node's own wording, so a package that matches on
/// it (to fall back from a deep `JSON.stringify`, say) keeps working.
pub const EXHAUSTED_MESSAGE: &str = "Maximum call stack size exceeded";

#[cfg(test)]
mod tests {
    use super::*;

    #[inline(never)]
    fn recurse(depth: usize) -> usize {
        if exhausted() {
            return depth;
        }
        let pad = std::hint::black_box([0u8; 1024]);
        recurse(depth + 1) + usize::from(pad[0])
    }

    #[test]
    fn an_unarmed_thread_never_trips() {
        assert!(!exhausted());
        assert!(!parser_exhausted());
    }

    #[test]
    fn an_armed_thread_trips_before_its_stack_ends() {
        let size = 4 * 1024 * 1024;
        let depth = std::thread::Builder::new()
            .stack_size(size)
            .spawn(move || {
                arm(size);
                let depth = recurse(0);
                disarm();
                depth
            })
            .unwrap()
            .join()
            .expect("the guard stopped the recursion before the stack overflowed");
        // Each level spends at least a KiB, so the guard tripped somewhere inside the
        // usable seven eighths — never at once, never past the end.
        assert!(depth > 100, "tripped too early: {depth}");
        assert!(depth < size / 1024, "never tripped: {depth}");
    }
}
