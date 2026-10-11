//! The command line's side of the daemon (docs/ggs-remote-plan.md §7.1, §14.2): talking to a
//! running daemon over its loopback admin API, starting one detached, and installing the
//! binary into `~/.ggs/remote/bin` — the copy that runs, so the extension's own directory is
//! never held open by a live process (an extension upgrade or uninstall must be able to
//! delete it). The GGS extension drives all of this through the CLI, which keeps the
//! extension a thin, file-system-free client.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::paths::Paths;

const EXE: &str = if cfg!(windows) {
    "ggs-remote.exe"
} else {
    "ggs-remote"
};

pub fn loopback_port(paths: &Paths) -> Result<u16, String> {
    let text = std::fs::read_to_string(paths.loopback())
        .map_err(|_| "GGS Remote is not running".to_string())?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    value["port"]
        .as_u64()
        .map(|p| p as u16)
        .ok_or_else(|| "loopback.json has no port".into())
}

/// One admin API call; answers the body of a 2xx response, the body as the error otherwise.
pub fn admin(
    paths: &Paths,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<String, String> {
    let port = loopback_port(paths)?;
    let token = std::fs::read_to_string(paths.admin_token()).map_err(|e| e.to_string())?;
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port))
        .map_err(|_| "GGS Remote is not running".to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let body = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        token.trim(),
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let response = String::from_utf8_lossy(&raw).into_owned();
    let (head, rest) = response.split_once("\r\n\r\n").unwrap_or((&response, ""));
    let ok = head.starts_with("HTTP/1.1 2");
    let payload = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        dechunk(rest)
    } else {
        rest.to_owned()
    };
    if ok {
        Ok(payload)
    } else {
        Err(payload)
    }
}

pub fn dechunk(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    while let Some((size, after)) = rest.split_once("\r\n") {
        let Ok(n) = usize::from_str_radix(size.trim(), 16) else {
            break;
        };
        if n == 0 || after.len() < n {
            break;
        }
        out.push_str(&after[..n]);
        rest = after[n..].trim_start_matches("\r\n");
    }
    out
}

pub fn running(paths: &Paths) -> bool {
    admin(paths, "GET", "/admin/status", None).is_ok()
}

/// The version of the daemon that is actually running, asked over the admin API. The
/// `bin/VERSION` file says what the last `install` laid down — a daemon started by hand, by
/// the tray, or by an older tree can be running with no (or a stale) record, so the live
/// answer is the only one that may decide to take it down.
pub fn running_version(paths: &Paths) -> Option<String> {
    let status = admin(paths, "GET", "/admin/status", None).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&status).ok()?;
    parsed["version"]
        .as_str()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// Start `exe run` fully detached — its own process group, no inherited handles, outliving
/// whoever started it (an extension host that exits with the GGS window) — and wait until it
/// answers on the admin API.
pub fn start(paths: &Paths, exe: &Path) -> Result<(), String> {
    if running(paths) {
        return Ok(());
    }
    let mut command = std::process::Command::new(exe);
    command
        .arg("run")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        command.creation_flags(
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
        );
        if command.spawn().is_err() {
            // A job that forbids breakaway refuses the flag; start inside it instead.
            command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
            command
                .spawn()
                .map_err(|e| format!("start {}: {e}", exe.display()))?;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        command
            .spawn()
            .map_err(|e| format!("start {}: {e}", exe.display()))?;
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if running(paths) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err("GGS Remote did not come up within 15 s (see ~/.ggs/logs/remote.log)".into())
}

pub fn installed_binary(paths: &Paths) -> PathBuf {
    paths.root.join("bin").join(EXE)
}

fn version_file(paths: &Paths) -> PathBuf {
    paths.root.join("bin").join("VERSION")
}

pub fn installed_version(paths: &Paths) -> Option<String> {
    std::fs::read_to_string(version_file(paths))
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn parse_version(v: &str) -> Vec<u64> {
    v.split(|c: char| !c.is_ascii_digit())
        .filter_map(|p| p.parse().ok())
        .collect()
}

/// Forward-only: install when nothing is installed, or when this binary is newer. An older
/// GGS (an older extension) never downgrades the daemon another window installed.
pub fn should_install(this: &str, installed: Option<&str>) -> bool {
    match installed {
        None => true,
        Some(installed) => parse_version(this) > parse_version(installed),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum InstallOutcome {
    Installed,
    Upgraded,
    Current,
}

/// Whether `from` is a rebuild of the installed binary at the same version: different bytes,
/// built later. A version string alone cannot tell a rebuilt package from a byte-identical
/// reinstall — on 2026-10-11 a 0.1.0 VSIX carrying the `/assets/` rewrite fix installed as
/// "Current" over the 0.1.0 daemon built hours earlier, which kept serving the extension host
/// frame unrewritten (every frame extension 404'd remotely). The modification time keeps it
/// forward-only: an older window's stale package of the same version never takes a newer
/// build down (both directions would otherwise restart each other's daemon on every activation).
fn is_rebuild(from: &Path, target: &Path) -> bool {
    let (Ok(src), Ok(dst)) = (std::fs::metadata(from), std::fs::metadata(target)) else {
        return false;
    };
    let newer = match (src.modified(), dst.modified()) {
        (Ok(src), Ok(dst)) => src > dst,
        _ => false,
    };
    if !newer {
        return false;
    }
    if src.len() != dst.len() {
        return true;
    }
    match (std::fs::read(from), std::fs::read(target)) {
        (Ok(a), Ok(b)) => a != b,
        _ => false,
    }
}

/// Copy `from` (this very binary) into `~/.ggs/remote/bin` when it is new or newer — or a
/// later rebuild of the same version (`is_rebuild`); a running daemon being replaced is shut
/// down first and waits for its lock to clear. A daemon that is already running at this same
/// version or newer, byte for byte the installed one, is never touched — killing it would drop
/// every remote session for no change (the fresh-home case: a daemon started by the tray or
/// by hand runs while `bin/` has no VERSION record yet).
pub fn install(paths: &Paths, from: &Path, version: &str) -> Result<InstallOutcome, String> {
    paths.ensure().map_err(|e| e.to_string())?;
    let target = installed_binary(paths);
    let installed = installed_version(paths);
    let rebuilt = installed.as_deref() == Some(version) && is_rebuild(from, &target);
    if !rebuilt && !should_install(version, installed.as_deref()) && target.exists() {
        return Ok(InstallOutcome::Current);
    }
    if running(paths) {
        if !rebuilt && !should_install(version, running_version(paths).as_deref()) {
            // Same or newer daemon already serving: fill in whatever record is missing so
            // the next activation answers Current immediately, and leave it running — its
            // remote sessions must not pay for a no-op reinstall.
            if !target.exists() {
                copy_into_place(from, &target)?;
            }
            if installed.is_none() {
                std::fs::write(version_file(paths), version).map_err(|e| e.to_string())?;
            }
            return Ok(InstallOutcome::Current);
        }
        let _ = admin(paths, "POST", "/admin/shutdown", Some("{}"));
        wait_for_exit(paths)?;
    }
    copy_into_place(from, &target)?;
    std::fs::write(version_file(paths), version).map_err(|e| e.to_string())?;
    Ok(if installed.is_some() {
        InstallOutcome::Upgraded
    } else {
        InstallOutcome::Installed
    })
}

/// Copy over the target through a temp name — Windows cannot replace a file another process
/// still maps, so the rename retries while the old image closes.
fn copy_into_place(from: &Path, target: &Path) -> Result<(), String> {
    let temp = target.with_extension("new");
    std::fs::copy(from, &temp).map_err(|e| format!("copy the daemon: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o755));
    }
    let mut attempts = 0;
    loop {
        match std::fs::rename(&temp, target) {
            Ok(()) => return Ok(()),
            Err(e) if attempts < 40 => {
                attempts += 1;
                let _ = e;
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(e) => return Err(format!("replace {}: {e}", target.display())),
        }
    }
}

/// Wait until the running daemon released its single-instance lock (it exited).
fn wait_for_exit(paths: &Paths) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if let Ok(file) = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(paths.lock())
        {
            if file.try_lock().is_ok() {
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("the running GGS Remote did not exit".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Daemon;

    #[test]
    fn installs_forward_only() {
        assert!(should_install("0.1.0", None));
        assert!(should_install("0.2.0", Some("0.1.9")));
        assert!(should_install("0.1.10", Some("0.1.9")));
        assert!(!should_install("0.1.0", Some("0.1.0")));
        assert!(!should_install("0.1.0", Some("0.2.0")));
    }

    #[test]
    fn install_copies_and_records_the_version() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
        let source = dir.path().join("source-bin");
        std::fs::write(&source, b"binary v1").unwrap();
        assert_eq!(
            install(&paths, &source, "0.1.0").unwrap(),
            InstallOutcome::Installed
        );
        assert_eq!(
            std::fs::read(installed_binary(&paths)).unwrap(),
            b"binary v1"
        );
        assert_eq!(installed_version(&paths).as_deref(), Some("0.1.0"));
        assert_eq!(
            install(&paths, &source, "0.1.0").unwrap(),
            InstallOutcome::Current
        );
        std::fs::write(&source, b"binary v2").unwrap();
        assert_eq!(
            install(&paths, &source, "0.2.0").unwrap(),
            InstallOutcome::Upgraded
        );
        assert_eq!(
            std::fs::read(installed_binary(&paths)).unwrap(),
            b"binary v2"
        );
    }

    /// A rebuild at the same version replaces the installed daemon; the same bytes, or an
    /// older build of that version, never do.
    #[test]
    fn a_same_version_rebuild_installs_forward_only() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
        let source = dir.path().join("source-bin");
        let set_mtime = |path: &Path, secs: u64| {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(secs))
                .unwrap();
        };
        std::fs::write(&source, b"binary built at noon").unwrap();
        set_mtime(&source, 1_000);
        install(&paths, &source, "0.1.0").unwrap();
        set_mtime(&installed_binary(&paths), 1_000);

        // Byte-identical: a no-op.
        assert_eq!(
            install(&paths, &source, "0.1.0").unwrap(),
            InstallOutcome::Current
        );
        // An older build of the same version (a stale window's package): left alone.
        std::fs::write(&source, b"binary built at dawn").unwrap();
        set_mtime(&source, 500);
        assert_eq!(
            install(&paths, &source, "0.1.0").unwrap(),
            InstallOutcome::Current
        );
        assert_eq!(
            std::fs::read(installed_binary(&paths)).unwrap(),
            b"binary built at noon"
        );
        // A later rebuild of the same version: installed.
        std::fs::write(&source, b"binary built at night").unwrap();
        set_mtime(&source, 2_000);
        assert_eq!(
            install(&paths, &source, "0.1.0").unwrap(),
            InstallOutcome::Upgraded
        );
        assert_eq!(
            std::fs::read(installed_binary(&paths)).unwrap(),
            b"binary built at night"
        );
    }

    #[test]
    fn dechunks_bodies() {
        assert_eq!(dechunk("4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n"), "Wikipedia");
    }

    /// A daemon answering /admin/status at this same version is never shut down by an
    /// `install` of that version — the fresh-home case that once dropped every remote
    /// session for a byte-identical copy (a daemon started by the tray or by hand runs
    /// while `bin/` has no record yet).
    ///
    /// Multi-threaded on purpose: `install` speaks blocking std::net to the admin API,
    /// which would starve a current_thread runtime's one thread — the very daemon under
    /// test runs as a task on it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_running_same_version_daemon_survives_install() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
        let config = crate::config::Config {
            port: 0,
            bind: "127.0.0.1".into(),
            ..Default::default()
        };
        config.save(&paths).unwrap();
        let daemon = Daemon::new(paths.clone(), config).unwrap();
        let run = daemon.clone();
        tokio::spawn(async move {
            let _ = crate::server::run(run).await;
        });
        for _ in 0..250 {
            if running(&paths) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // No bin/ record: the running daemon was started straight from the source tree.
        assert!(installed_version(&paths).is_none());
        let this = std::env::current_exe().unwrap();
        // The version the daemon actually reports — asked over the admin API, not the file.
        let live = running_version(&paths).expect("the daemon answers its version");
        assert_eq!(
            install(&paths, &this, &live).unwrap(),
            InstallOutcome::Current
        );
        assert!(running(&paths), "the daemon was never shut down");
        assert_eq!(installed_version(&paths).as_deref(), Some(live.as_str()));
        // A genuinely newer binary still outranks a running older one (forward-only).
        assert!(should_install("9999.0.0", Some(&live)));
    }
}
