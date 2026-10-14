//! The app's adapters over ggs-base's push seams (docs/architecture-restructure-plan.md
//! §4.7): a domain crate never names tauri — it emits through `EventSink` / `BatchSink`,
//! and THIS file is the only place that knows the frontend side. Tests implement the
//! same traits over a Vec (ggs_base::sink::VecSink).

use serde::Serialize;

use ggs_base::sink::{BatchSink, EventSink};

/// Emits a named event to the frontend over Tauri's broadcast.
pub struct TauriEvents(pub tauri::AppHandle);

impl EventSink for TauriEvents {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        let _ = self.0.emit(event, payload);
    }
}

/// Streams one batch type over a command's IPC channel. `send` answers false when the
/// receiver is gone (the page closed or reloaded): the producer stops as soon as it can.
pub struct ChannelSink<T: Serialize + Clone + Send>(pub tauri::ipc::Channel<T>);

impl<T: Serialize + Clone + Send> BatchSink<T> for ChannelSink<T> {
    fn send(&mut self, batch: T) -> bool {
        self.0.send(batch).is_ok()
    }
}
