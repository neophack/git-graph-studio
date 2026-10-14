//! The push seams between domain crates and whatever frontend exists: a domain crate
//! never names tauri — it emits through these traits, and the app's `events.rs` adapter
//! (P3-1) implements them over `AppHandle::emit` and `tauri::ipc::Channel`. Tests
//! implement them over a Vec.

use serde_json::Value;

/// Emits one named event to the frontend (the app implements this over
/// `AppHandle::emit`; a test collects into a Vec).
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: Value);
}

/// Streams one batch of a long task's results. Returns `false` when the receiver is
/// gone (the frontend closed, the page reloaded, the task was cancelled) — the producer
/// should stop as soon as it can.
pub trait BatchSink<T: serde::Serialize>: Send {
    fn send(&mut self, batch: T) -> bool;
}

/// The test implementation: every batch lands in the Vec.
pub struct VecSink<T: serde::Serialize + Send>(pub Vec<T>);

impl<T: serde::Serialize + Send> BatchSink<T> for VecSink<T> {
    fn send(&mut self, batch: T) -> bool {
        self.0.push(batch);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct CollectingSink(Vec<(String, Value)>);
    impl EventSink for CollectingSink {
        fn emit(&self, _event: &str, _payload: Value) {}
    }

    #[test]
    fn the_traits_are_object_safe_and_implementable() {
        // A trait-object smoke check: the app holds these as Arc<dyn …>.
        let _sink: Box<dyn EventSink> = Box::new(CollectingSink(Vec::new()));
        let mut batches: VecSink<i32> = VecSink(Vec::new());
        assert!(BatchSink::send(&mut batches, 7));
        assert_eq!(batches.0, vec![7]);
    }
}
