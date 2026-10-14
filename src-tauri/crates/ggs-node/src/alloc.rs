//! `ggs-node`'s global allocator: size-class free lists in front of the system heap.
//!
//! Loading a multi-megabyte bundle is millions of small, short-lived allocations — every
//! token, AST node, scope binding and bytecode buffer is its own `Box` or `Vec` — and on
//! Windows each one was a `HeapAlloc`/`HeapFree` round trip: a third of the parse and
//! compile time of Claude Code's 3 MB bundle (the 2026-09-27 activation profile). Pure Rust,
//! like the rest of the sidecar (plan §3.1): no C allocator is linked.
//!
//! Blocks up to [`MAX_SMALL`] bytes (alignment up to 16) are served from 16-byte size
//! classes carved out of large chunks; anything bigger, or more aligned, goes straight to
//! the system heap. The JS thread — the one that does all the heavy work — keeps its own
//! lock-free lists ([`enable_thread_cache`]); every other thread shares one spin-lock
//!-guarded pool, so a short-lived helper thread leaves nothing stranded behind when it
//! exits. A
//! block may be freed on a different thread than it was allocated on: every small block of
//! a class is interchangeable, so it simply joins the freeing side's list. Chunks are never
//! handed back to the system — the lists keep the peak for reuse, the usual trade of a
//! size-class allocator.
//!
//! Only the `ggs-node` binary installs it (`src/bin/ggs_node.rs`); the app does not.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::{Cell, UnsafeCell};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

/// The bytes of the large (system-heap) blocks currently live. The JS engine's collector
/// paces itself by its own boxes alone, and a box is small while what it holds is not: a
/// string, an ArrayBuffer's bytes, a parsed tree all live out here, uncounted. The run
/// loop reads this to collect when out-of-heap memory grows (see `node_runtime`'s
/// `collect_on_external_pressure`). Only maintained where this allocator is installed.
static LARGE_LIVE: AtomicUsize = AtomicUsize::new(0);

/// The live bytes of large blocks (0 where `GgsAlloc` is not the global allocator).
pub fn large_live_bytes() -> usize {
    LARGE_LIVE.load(Ordering::Relaxed)
}

/// The largest size served from the size classes.
pub const MAX_SMALL: usize = 512;
/// The size-class step, and the alignment every small block carries.
const STEP: usize = 16;
const CLASSES: usize = MAX_SMALL / STEP;
/// One refill from the system heap: large enough that refills are rare, small enough that
/// the tail a thread leaves in its last chunk does not matter.
const CHUNK: usize = 256 * 1024;

/// A set of size-class free lists plus the chunk currently being carved.
struct Pool {
    free: [*mut u8; CLASSES],
    bump: *mut u8,
    end: *mut u8,
}

impl Pool {
    const fn new() -> Self {
        Self {
            free: [ptr::null_mut(); CLASSES],
            bump: ptr::null_mut(),
            end: ptr::null_mut(),
        }
    }

    /// A block of `class`, from its free list or carved from the current chunk.
    ///
    /// # Safety
    /// The pool's lists must only hold blocks of their own class (the allocator's
    /// invariant: only [`Pool::free`] pushes, with the class the block was served as).
    unsafe fn take(&mut self, class: usize) -> *mut u8 {
        let head = self.free[class];
        if !head.is_null() {
            // SAFETY: a free block's first word is the next link, written by `give`.
            self.free[class] = unsafe { *(head as *mut *mut u8) };
            return head;
        }
        let size = (class + 1) * STEP;
        if (self.end as usize) - (self.bump as usize) < size {
            // SAFETY: CHUNK is non-zero and STEP a power of two.
            let chunk = unsafe { System.alloc(Layout::from_size_align_unchecked(CHUNK, STEP)) };
            if chunk.is_null() {
                return chunk;
            }
            self.bump = chunk;
            // SAFETY: `chunk` spans CHUNK bytes.
            self.end = unsafe { chunk.add(CHUNK) };
        }
        let block = self.bump;
        // SAFETY: checked above that `size` bytes remain before `end`.
        self.bump = unsafe { block.add(size) };
        block
    }

    /// Return a block of `class` to this pool's list.
    ///
    /// # Safety
    /// `block` must be a live block of `class` served by this allocator.
    unsafe fn give(&mut self, class: usize, block: *mut u8) {
        // SAFETY: every block is at least STEP (16) bytes and 16-aligned: room for a link.
        unsafe { *(block as *mut *mut u8) = self.free[class] };
        self.free[class] = block;
    }
}

/// The JS thread's own pool, and whether this thread uses it.
struct ThreadCache {
    enabled: Cell<bool>,
    pool: UnsafeCell<Pool>,
}

thread_local! {
    // Const-initialized and without drop glue: access never allocates, never registers a
    // destructor, and never fails — safe to reach from inside the global allocator.
    static CACHE: ThreadCache = const {
        ThreadCache { enabled: Cell::new(false), pool: UnsafeCell::new(Pool::new()) }
    };
}

/// The pool every thread without its own cache shares, behind a spin lock. The lock must
/// never be a `std::sync` lock: std 1.98's pthread `Mutex` lazily Box-allocates its OS
/// mutex on first lock (`sys::sync::once_box::OnceBox`), and that allocation re-enters
/// this allocator, whose shared path takes exactly that still-uninitialized lock — the
/// two call each other until the stack is gone (the release-profile sidecar died at its
/// first small allocation, 2026-09-28). A spin lock allocates nothing and reaches nothing
/// outside this module.
struct SharedPool {
    locked: AtomicBool,
    pool: UnsafeCell<Pool>,
}

// SAFETY: the raw pointers are plain addresses of heap blocks, only touched behind the
// spin lock (the `Sync` impl is what makes the static shareable across threads).
unsafe impl Sync for SharedPool {}

static SHARED: SharedPool = SharedPool {
    locked: AtomicBool::new(false),
    pool: UnsafeCell::new(Pool::new()),
};

/// Serve this thread's small allocations from a lock-free thread-local pool from now on —
/// the JS thread calls it before it builds its context. Blocks the thread frees afterwards
/// join its own lists, whichever pool served them.
pub fn enable_thread_cache() {
    CACHE.with(|cache| cache.enabled.set(true));
}

/// The size class of a small layout, or `None` for the system heap.
#[inline]
fn class_of(layout: &Layout) -> Option<usize> {
    if layout.size() <= MAX_SMALL && layout.align() <= STEP {
        // A zero-sized request still gets a real, distinct block (class 0).
        Some(layout.size().saturating_sub(1) / STEP)
    } else {
        None
    }
}

/// The layout a request goes out to `System` under. The system allocator's own adapter
/// asserts a nonzero size on every call and aborts the process on the violation (rustc
/// 1.99 turned the GlobalAlloc contract into a hard check — a zero-sized, over-aligned
/// round trip died exactly there on the Linux CI, in this module's own churn test).
/// The pool path serves zero sizes as real blocks; the forwarded path serves them as
/// one byte, and the caller's zero layout is normalized the same way on `dealloc`, so
/// every block leaves the system heap under the layout it entered with.
#[inline]
fn system_layout(layout: Layout) -> Layout {
    if layout.size() == 0 {
        // SAFETY: size 1 is nonzero; the alignment is the caller's own.
        unsafe { Layout::from_size_align_unchecked(1, layout.align()) }
    } else {
        layout
    }
}

/// Run `f` on this thread's pool if it has one, else on the shared pool under its lock.
#[inline]
fn with_pool<R>(f: impl FnOnce(&mut Pool) -> R) -> R {
    let mut f = Some(f);
    let local = CACHE.try_with(|cache| {
        if cache.enabled.get() {
            let f = f.take().expect("taken once");
            // SAFETY: the pool is this thread's own and the allocator never re-enters
            // itself while holding it (the pool code does not allocate).
            Some(f(unsafe { &mut *cache.pool.get() }))
        } else {
            None
        }
    });
    if let Ok(Some(result)) = local {
        return result;
    }
    let f = f.take().expect("not run on the local pool");
    // The pool work itself never allocates, so the spin lock is held across no re-entrant
    // path; waiting threads only burn `spin_loop` until the holder's pointer arithmetic is
    // done (pool operations are a linked-list pop and a bump-pointer carve).
    while SHARED
        .locked
        .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        std::hint::spin_loop();
    }
    // SAFETY: the spin lock above is the one writer gate on the shared pool.
    let result = f(unsafe { &mut *SHARED.pool.get() });
    SHARED.locked.store(false, Ordering::Release);
    result
}

/// The allocator `ggs-node` installs as `#[global_allocator]`.
pub struct GgsAlloc;

// SAFETY: small blocks come from STEP-aligned chunks in STEP-sized steps, so every block
// honours any alignment up to STEP and is at least as large as its class; everything else
// is the system allocator's. A block is only ever returned to a list of its own class
// (`class_of` is a pure function of the layout the caller must pass back unchanged).
unsafe impl GlobalAlloc for GgsAlloc {
    #[inline]
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        match class_of(&layout) {
            // SAFETY: the pool invariant (see `Pool::take`).
            Some(class) => with_pool(|pool| unsafe { pool.take(class) }),
            None => {
                // SAFETY: forwarded with a nonzero size (see `system_layout`).
                let block = unsafe { System.alloc(system_layout(layout)) };
                if !block.is_null() {
                    LARGE_LIVE.fetch_add(layout.size(), Ordering::Relaxed);
                }
                block
            }
        }
    }

    #[inline]
    unsafe fn dealloc(&self, block: *mut u8, layout: Layout) {
        match class_of(&layout) {
            // SAFETY: the caller hands back a block this allocator served for `layout`.
            Some(class) => with_pool(|pool| unsafe { pool.give(class, block) }),
            None => {
                LARGE_LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
                // SAFETY: forwarded with the size it was served under.
                unsafe { System.dealloc(block, system_layout(layout)) }
            }
        }
    }

    #[inline]
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        match class_of(&layout) {
            Some(_) => {
                // SAFETY: as `alloc`; the block spans at least `layout.size()` bytes.
                let block = unsafe { self.alloc(layout) };
                if !block.is_null() {
                    unsafe { ptr::write_bytes(block, 0, layout.size()) };
                }
                block
            }
            None => {
                // SAFETY: forwarded with a nonzero size (see `system_layout`).
                let block = unsafe { System.alloc_zeroed(system_layout(layout)) };
                if !block.is_null() {
                    LARGE_LIVE.fetch_add(layout.size(), Ordering::Relaxed);
                }
                block
            }
        }
    }

    #[inline]
    unsafe fn realloc(&self, block: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: the caller guarantees `new_size` fits the layout's alignment rules.
        let new_layout = unsafe { Layout::from_size_align_unchecked(new_size, layout.align()) };
        match (class_of(&layout), class_of(&new_layout)) {
            // Same class: the block already has the room.
            (Some(old), Some(new)) if old == new => block,
            // Both large: the system heap can often grow in place.
            (None, None) => {
                // SAFETY: forwarded with nonzero sizes (see `system_layout`); the
                // copied span is the caller's, not the substituted byte.
                let new_size = if new_size == 0 { 1 } else { new_size };
                let moved = unsafe { System.realloc(block, system_layout(layout), new_size) };
                if !moved.is_null() {
                    LARGE_LIVE.fetch_add(new_size, Ordering::Relaxed);
                    LARGE_LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
                }
                moved
            }
            _ => {
                // SAFETY: a fresh block for the new layout, the overlap copied, the old
                // block returned under its own layout.
                unsafe {
                    let moved = self.alloc(new_layout);
                    if !moved.is_null() {
                        ptr::copy_nonoverlapping(block, moved, layout.size().min(new_size));
                        self.dealloc(block, layout);
                    }
                    moved
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The allocator's own source must reach for no `std` lock or lazy initializer: the
    /// binary installs this module as the global allocator, and std 1.98's `Mutex` (and
    /// friends) Box-allocate their OS state on first use through the global allocator —
    /// a lock here re-entered the allocator and the two spun into a stack overflow
    /// (2026-09-28; the shared pool now guards itself with a bare `AtomicBool`). The
    /// allocator's unit tests below cannot catch this — they run under the test harness's
    /// own allocator — so the invariant is pinned at the source level.
    #[test]
    fn the_allocator_takes_no_std_locks() {
        // The patterns are concatenated so this test's own source never contains them,
        // and matched on word boundaries (`std::sync::atomic` stays legal — atomics
        // allocate nothing).
        let forbidden = [
            concat!("Mu", "tex"),
            concat!("Rw", "Lock"),
            concat!("Once", "Lock"),
            concat!("Lazy", "Lock"),
            concat!("Once", "Box"),
            concat!("once_", "box"),
            concat!("Cond", "var"),
            concat!("mp", "sc"),
        ];
        let source = include_str!("alloc.rs");
        let code = source
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let standalone = |at: usize, pattern: &str| -> bool {
            let before = code[..at].chars().next_back();
            let after = code[at + pattern.len()..].chars().next();
            let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
            !word(before) && !word(after)
        };
        for pattern in forbidden {
            let hits = code
                .match_indices(pattern)
                .filter(|(at, _)| standalone(*at, pattern))
                .count();
            assert!(
                hits == 0,
                "alloc.rs must not use {pattern}: a global allocator may not take a \
                 std lock or lazy initializer (std's lazy OS-mutex init allocates \
                 through the global allocator and re-enters this module)"
            );
        }
    }

    /// Allocate, fill, verify and free a spread of layouts through one allocator value,
    /// on a cached thread and on a shared-pool thread, with blocks crossing between them.
    fn churn(alloc: &GgsAlloc, rounds: usize, seed: u64) -> Vec<(usize, usize, usize)> {
        let mut state = seed;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let mut live: Vec<(usize, usize, usize)> = Vec::new();
        for round in 0..rounds {
            let size = (next() % 1200) as usize;
            let align = [1usize, 2, 4, 8, 16, 32][(next() % 6) as usize];
            let layout = Layout::from_size_align(size, align).unwrap();
            // SAFETY: a valid layout; the block is written only within its size.
            let block = unsafe { alloc.alloc(layout) };
            assert!(!block.is_null());
            assert_eq!(block as usize % align, 0, "alignment {align} honoured");
            let fill = (round % 251) as u8;
            unsafe { ptr::write_bytes(block, fill, size) };
            live.push((block as usize, size, align | (fill as usize) << 8));
            if next() % 3 == 0 && !live.is_empty() {
                let at = (next() as usize) % live.len();
                let (block, size, tag) = live.swap_remove(at);
                let (align, fill) = (tag & 0xff, (tag >> 8) as u8);
                for offset in 0..size {
                    // SAFETY: the block is live and `size` bytes long.
                    assert_eq!(unsafe { *(block as *const u8).add(offset) }, fill);
                }
                let layout = Layout::from_size_align(size, align).unwrap();
                // SAFETY: returned with the layout it was served for.
                unsafe { alloc.dealloc(block as *mut u8, layout) };
            }
        }
        live
    }

    fn free_all(alloc: &GgsAlloc, live: Vec<(usize, usize, usize)>) {
        for (block, size, tag) in live {
            let (align, fill) = (tag & 0xff, (tag >> 8) as u8);
            for offset in 0..size {
                // SAFETY: the block is live and `size` bytes long.
                assert_eq!(
                    unsafe { *(block as *const u8).add(offset) },
                    fill,
                    "no block was overwritten"
                );
            }
            let layout = Layout::from_size_align(size, align).unwrap();
            // SAFETY: returned with the layout it was served for.
            unsafe { alloc.dealloc(block as *mut u8, layout) };
        }
    }

    #[test]
    fn blocks_keep_their_contents_across_cached_and_shared_threads() {
        let alloc = GgsAlloc;
        // A cached thread allocates; its survivors are freed on a shared-pool thread,
        // and that thread's survivors come back to be freed on another cached thread.
        let from_cached = std::thread::spawn(move || {
            enable_thread_cache();
            churn(&GgsAlloc, 20_000, 0x9e37_79b9_7f4a_7c15)
        })
        .join()
        .unwrap();
        let from_shared = std::thread::spawn(move || {
            free_all(&GgsAlloc, from_cached);
            churn(&GgsAlloc, 20_000, 0x2545_f491_4f6c_dd1d)
        })
        .join()
        .unwrap();
        std::thread::spawn(move || {
            enable_thread_cache();
            free_all(&GgsAlloc, from_shared);
            let again = churn(&GgsAlloc, 5_000, 7);
            free_all(&GgsAlloc, again);
        })
        .join()
        .unwrap();
        let _ = alloc;
    }

    #[test]
    fn realloc_moves_between_classes_and_the_system_heap() {
        let alloc = GgsAlloc;
        let layout = Layout::from_size_align(8, 8).unwrap();
        // SAFETY: each step hands back the block with the layout it currently has.
        unsafe {
            let mut block = alloc.alloc(layout);
            for (i, byte) in b"ggs-node".iter().enumerate() {
                *block.add(i) = *byte;
            }
            let mut size = 8;
            for new_size in [12, 40, 500, 513, 4096, 100, 16, 3] {
                block = alloc.realloc(block, Layout::from_size_align(size, 8).unwrap(), new_size);
                assert!(!block.is_null());
                let kept = size.min(new_size).min(8);
                assert_eq!(
                    std::slice::from_raw_parts(block, kept),
                    &b"ggs-node"[..kept]
                );
                size = new_size;
            }
            alloc.dealloc(block, Layout::from_size_align(size, 8).unwrap());
        }
    }

    #[test]
    fn zeroed_blocks_are_zero_even_when_recycled() {
        let alloc = GgsAlloc;
        let layout = Layout::from_size_align(64, 16).unwrap();
        // SAFETY: blocks are written within their size and freed with their layout.
        unsafe {
            let dirty = alloc.alloc(layout);
            ptr::write_bytes(dirty, 0xAB, 64);
            alloc.dealloc(dirty, layout);
            let clean = alloc.alloc_zeroed(layout);
            assert!(std::slice::from_raw_parts(clean, 64)
                .iter()
                .all(|&b| b == 0));
            alloc.dealloc(clean, layout);
        }
    }

    /// A zero-sized, over-aligned request round-trips. `churn`'s random layouts hit
    /// this only by seed; rustc 1.99's hard `assert_unchecked` on the system
    /// allocator's nonzero-size contract made every miss abort the process — the
    /// pinned, deterministic shape of that regression.
    #[test]
    fn a_zero_sized_over_aligned_request_serves_and_frees() {
        let alloc = GgsAlloc;
        let layout = Layout::from_size_align(0, 32).unwrap();
        // SAFETY: the block is served for and freed under the same layout.
        unsafe {
            let block = alloc.alloc(layout);
            assert!(!block.is_null(), "the request is served");
            assert_eq!(block as usize % 32, 0, "the alignment is honoured");
            alloc.dealloc(block, layout);
            let zeroed = alloc.alloc_zeroed(layout);
            assert!(!zeroed.is_null());
            alloc.dealloc(zeroed, layout);
        }
    }
}
