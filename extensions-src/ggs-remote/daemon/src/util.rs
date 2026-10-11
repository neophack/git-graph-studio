//! Small shared helpers: random tokens, clocks, constant-time comparison.

use base64::Engine;
use subtle::ConstantTimeEq;

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).expect("the OS random generator is available");
    out
}

/// A URL-safe random token of `n` bytes of entropy.
pub fn token(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    getrandom::fill(&mut bytes).expect("the OS random generator is available");
    b64(&bytes)
}

pub fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn b64_decode(text: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(text)
        .ok()
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(data).into()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// UTC timestamp for log lines, without a date crate.
pub fn now_rfc3339() -> String {
    httpdate::fmt_http_date(std::time::SystemTime::now())
}

/// The process's resident set size in bytes, for `/admin/status` (§7.11) — best effort.
pub fn rss_bytes() -> u64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(statm) = std::fs::read_to_string("/proc/self/statm") {
            if let Some(pages) = statm
                .split_whitespace()
                .nth(1)
                .and_then(|p| p.parse::<u64>().ok())
            {
                return pages * 4096;
            }
        }
        0
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::ProcessStatus::{
            GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
        };
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        // SAFETY: the pseudo handle needs no closing; counters is a properly sized out-param.
        let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) };
        if ok != 0 {
            counters.WorkingSetSize as u64
        } else {
            0
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        0
    }
}

/// Whether a process id is still alive (instance-vanished detection, §7.8).
pub fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        // SAFETY: plain Win32 calls; the handle is closed on every path that opened it.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok != 0 && code == STILL_ACTIVE as u32
        }
    }
    #[cfg(unix)]
    {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
            || std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
    }
}

/// Terminate a process by id (the forced close and the restart, §7.8).
pub fn kill_pid(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, TerminateProcess, PROCESS_TERMINATE,
        };
        // SAFETY: plain Win32 calls; the handle is closed after use.
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if handle.is_null() {
                return false;
            }
            let ok = TerminateProcess(handle, 1);
            CloseHandle(handle);
            ok != 0
        }
    }
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_url_safe_and_distinct() {
        let a = token(32);
        let b = token(32);
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_eq!(b64_decode(&a).unwrap().len(), 32);
    }

    #[test]
    fn constant_time_eq_checks_length() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"abcd"));
    }

    #[test]
    fn this_process_is_alive() {
        assert!(pid_alive(std::process::id()));
    }
}
