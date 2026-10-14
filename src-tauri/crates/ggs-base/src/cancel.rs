//! The cancellation-generation pattern every long task shares (search, transfer, the
//! streaming analyses): a task takes a generation on start, and a cancel just bumps the
//! counter — the task checks `is_current` between batches and unwinds early.

use std::sync::atomic::{AtomicU64, Ordering};

/// One cancellable slot. Several tasks may fly at once; only the most recent is current.
#[derive(Default)]
pub struct Generation {
    current: AtomicU64,
}

impl Generation {
    /// The generation a new task flies under (bumps the counter: any older task stops
    /// being current the moment this is called).
    pub fn next(&self) -> u64 {
        self.current.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Whether the task holding `generation` should keep going.
    pub fn is_current(&self, generation: u64) -> bool {
        self.current.load(Ordering::SeqCst) == generation
    }

    /// Cancel whichever task is current (and any that would check before a new `next`).
    pub fn cancel(&self) {
        self.current.fetch_add(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_generation_retires_the_old_and_cancel_retires_all() {
        let gen = Generation::default();
        let first = gen.next();
        assert!(gen.is_current(first));
        let second = gen.next();
        assert!(!gen.is_current(first));
        assert!(gen.is_current(second));
        gen.cancel();
        assert!(!gen.is_current(second));
        assert!(!gen.is_current(first));
    }
}
