//! The Node environment facts the sandboxed frame cannot read for itself: the `os` /
//! `process` shims answer from the activation context these fill.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// The frame's Node environment, as `os` / `process` report them: the sandboxed frame
/// cannot read env vars or the host's paths, so the activation context carries these in.
pub fn node_env() -> ExtNodeEnv {
    ExtNodeEnv {
        platform: node_platform(),
        arch: node_arch(),
        homedir: home_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        tmpdir: std::env::temp_dir().to_string_lossy().into_owned(),
        hostname: std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "studio".to_owned()),
        release: format!("{} {}", std::env::consts::OS, os_version()),
        eol: if cfg!(windows) { "\r\n" } else { "\n" }.to_owned(),
        separator: std::path::MAIN_SEPARATOR.to_string(),
        delimiter: (if cfg!(windows) { ";" } else { ":" }).to_owned(),
        env: std::env::vars().collect(),
    }
}

/// `ExtNodeEnv`, the shape the frame's `os` / `process` shims read.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtNodeEnv {
    pub platform: String,
    pub arch: String,
    pub homedir: String,
    pub tmpdir: String,
    pub hostname: String,
    pub release: String,
    pub eol: String,
    pub separator: String,
    pub delimiter: String,
    /// The host's real environment (`process.env`). Extensions probe `PATH`,
    /// `ProgramFiles`, `LOCALAPPDATA` and friends to find the tools they drive — an empty
    /// env sent every discovery down a failure path (git not found, interpreters missing).
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// Node's own word for this OS, the word extension code branches on
/// (`process.platform === 'win32'`).
pub fn node_platform() -> String {
    if cfg!(target_os = "windows") {
        "win32".to_owned()
    } else if cfg!(target_os = "macos") {
        "darwin".to_owned()
    } else {
        "linux".to_owned()
    }
}

/// Node's own word for this architecture (`process.arch`).
pub fn node_arch() -> String {
    if cfg!(target_arch = "x86_64") {
        "x64".to_owned()
    } else if cfg!(target_arch = "aarch64") {
        "arm64".to_owned()
    } else {
        std::env::consts::ARCH.to_owned()
    }
}

/// A coarse OS version, best effort (the exact number does not steer extension code).
fn os_version() -> String {
    // No OS command is spawned for this: `os.release()` only decorates diagnostics, and a
    // process spawn per activation would be pure cost. The kernel word below is stable.
    if let Ok(value) = std::env::var("OS") {
        return value;
    }
    "unknown".to_owned()
}
