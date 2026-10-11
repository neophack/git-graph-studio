//! Small shared bits: random bytes and the log macros. The Hub logs to stderr in the
//! foreground (`docker logs`, `journalctl`); one line per event, no frame contents, no
//! identity beyond the uuid (§20.7).

use std::sync::atomic::{AtomicU8, Ordering};

pub static LEVEL: AtomicU8 = AtomicU8::new(1); // 0 quiet, 1 info, 2 debug

pub fn set_verbose() {
    LEVEL.store(2, Ordering::Relaxed);
}

pub fn log(level: &str, message: std::fmt::Arguments<'_>) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    eprintln!("{now} {level} {message}");
}

#[macro_export]
macro_rules! info {
    ($($arg:tt)*) => {
        if $crate::util::LEVEL.load(std::sync::atomic::Ordering::Relaxed) >= 1 {
            $crate::util::log("INFO", format_args!($($arg)*))
        }
    };
}

#[macro_export]
macro_rules! warn {
    ($($arg:tt)*) => {
        if $crate::util::LEVEL.load(std::sync::atomic::Ordering::Relaxed) >= 1 {
            $crate::util::log("WARN", format_args!($($arg)*))
        }
    };
}

#[macro_export]
macro_rules! debug {
    ($($arg:tt)*) => {
        if $crate::util::LEVEL.load(std::sync::atomic::Ordering::Relaxed) >= 2 {
            $crate::util::log("DEBUG", format_args!($($arg)*))
        }
    };
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).expect("system randomness");
    out
}
