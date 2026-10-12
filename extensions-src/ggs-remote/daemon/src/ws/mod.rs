//! The browser link: the frame codec, the control messages, the per-connection downlink
//! state and the `/ws` connection task (docs/ggs-remote-plan.md §6, §7.7).

pub mod conn;
pub mod frame;
pub mod msg;
pub mod resume;
pub mod socket;

pub use socket::{handle, windows_frame, ws_handler};
