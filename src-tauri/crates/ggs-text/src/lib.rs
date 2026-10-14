//! ggs-text (L1, modules 6/7): the text engine — encodings (BOMs, UTF-16, GB18030,
//! Shift_JIS, …), the rope-backed document with syntect highlight checkpoints
//! (`viewer::doc`), whole-file find/replace (`viewer::find`), the memory-bounded
//! line-index viewer for enormous files (`viewer::indexed`), the outline scan
//! (`viewer::outline`), the file probe that routes opens (`probe`), editor backups
//! (`backup`) and the TextMate-grammar loader (`grammar`).
//!
//! Allowed dependencies: ggs-base, ropey, syntect (default-fancy), fancy-regex,
//! encoding_rs, memchr, rayon, plist, serde. No tauri — the events the tail build
//! finishes with cross through ggs_base::sink::EventSink, and the app's
//! viewer_commands.rs is the only viewer file that names tauri.

pub mod backup;
pub mod encoding;
pub mod grammar;
pub mod probe;
pub mod viewer;
