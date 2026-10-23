//! `ggs-config` (2026-10-13, the owner's direction): configure Remote Access from a
//! command line — an SSH session on a fresh machine sets the password and the relay, and
//! the phone can connect, without ever opening the desktop window. Reached as the
//! `ggs-config` binary the installer carries beside `ggs`, as `ggs config` (either
//! spelling of the same subcommand), and — the classic single-binary trick — under
//! whatever name a symlink points at.
//!
//! The work itself is the tray daemon's own CLI (`ggs-remote install / set-password /
//! admin / print-link`), driven end to end: this module finds the daemon binary (the
//! installed running copy, an installed extension's, or the one packed inside the bundled
//! `ggs-remote.vsix` beside the app), installs and starts it, sets the access password
//! through the loopback admin API (the password crosses a stdin pipe, never an argv a
//! process listing could show), sets the LAN listener's port and protocol, optionally
//! connects a relay server, and prints the links.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// The `ggs-remote` executable's name per platform.
#[cfg(windows)]
const DAEMON_EXE: &str = "ggs-remote.exe";
#[cfg(not(windows))]
const DAEMON_EXE: &str = "ggs-remote";

/// The platform/arch directory the VSIX packs the daemon under.
fn platform_dir() -> String {
    let platform = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    format!("{platform}-{arch}")
}

/// `~/.ggs/remote` — the daemon's root, resolved exactly as the daemon resolves it
/// (`GGS_REMOTE_HOME` and `GGS_HOME` honoured first, so a relocated setup configures
/// itself).
fn remote_root() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("GGS_REMOTE_HOME") {
        return Some(PathBuf::from(root));
    }
    let home = match std::env::var_os("GGS_HOME") {
        Some(home) => PathBuf::from(home),
        None => {
            #[cfg(windows)]
            let var = "USERPROFILE";
            #[cfg(not(windows))]
            let var = "HOME";
            PathBuf::from(std::env::var_os(var)?)
        }
    };
    Some(home.join("remote"))
}

/// `~/.ggs/extensions` — an installed ggs-remote extension's package directory.
fn extensions_home() -> Option<PathBuf> {
    let home = match std::env::var_os("GGS_HOME") {
        Some(home) => PathBuf::from(home),
        None => {
            #[cfg(windows)]
            let var = "USERPROFILE";
            #[cfg(not(windows))]
            let var = "HOME";
            PathBuf::from(std::env::var_os(var)?)
        }
    };
    Some(home.join("extensions"))
}

/// Where a `ggs-remote.vsix` may sit beside this executable: the install root on
/// Windows, the bundle's `Resources` on macOS, and the layouts a dev tree runs from.
fn bundled_vsix_candidates() -> Vec<PathBuf> {
    let Ok(exe) = std::env::current_exe() else {
        return Vec::new();
    };
    let dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut roots = vec![dir.join("extensions")];
    // A packaged macOS run: Contents/MacOS/ggs → Contents/Resources/extensions.
    if cfg!(target_os = "macos") {
        if let Some(resources) = dir.parent().map(|p| p.join("Resources")) {
            roots.push(resources.join("extensions"));
        }
    }
    // The repository's dev layouts (`tauri dev` runs cargo from src-tauri/).
    for base in [
        "target/studio/bundled/app-resources/extensions",
        "../target/studio/bundled/app-resources/extensions",
        "../../target/studio/bundled/app-resources/extensions",
    ] {
        roots.push(PathBuf::from(base));
    }
    roots
        .into_iter()
        .map(|root| root.join("ggs-remote.vsix"))
        .filter(|path| path.is_file())
        .collect()
}

/// The daemon binary to drive, and where it came from: the running copy the daemon
/// installed for itself, an installed extension's package, or the bundled VSIX (whose
/// daemon this extracts once into the remote root — its own `install` copies it to the
/// running location from there).
fn find_daemon() -> Result<(PathBuf, Option<PathBuf>), String> {
    // 1. The installed running copy — `~/.ggs/remote/bin/ggs-remote(.exe)`.
    if let Some(root) = remote_root() {
        let installed = root.join("bin").join(DAEMON_EXE);
        if installed.is_file() {
            return Ok((installed, None));
        }
    }
    // 2. An installed extension's package: `~/.ggs/extensions/<id>/bin/<platform>/<exe>`.
    if let Some(home) = extensions_home() {
        if let Ok(entries) = std::fs::read_dir(&home) {
            for entry in entries.flatten() {
                let bin = entry
                    .path()
                    .join("bin")
                    .join(platform_dir())
                    .join(DAEMON_EXE);
                if bin.is_file() {
                    return Ok((bin, Some(entry.path())));
                }
            }
        }
    }
    // 3. The bundled VSIX: extract its daemon into a staging directory of the remote
    //    root — NOT the running copy's `bin` (the daemon's own install replaces that
    //    file, and a running-or-just-extracted copy sitting there refuses the replace).
    //    `install` copies it to the running location from staging.
    if let Some(vsix) = bundled_vsix_candidates().into_iter().next() {
        let extracted = extract_daemon_from_vsix(&vsix)?;
        return Ok((extracted, None));
    }
    Err(
        "no GGS Remote daemon found: run Git Graph Studio once on this machine, or install \
         with a build that bundles the GGS Remote extension"
            .into(),
    )
}

/// Pull `extension/bin/<platform>-<arch>/<exe>` out of the VSIX (a zip) into
/// `~/.ggs/remote/bin-incoming/` (staging — the running copy lives in `bin/`), returning
/// its path. Extraction is idempotent: the extracted size is the build's fingerprint, so
/// an identical-size binary already staged is the same build. The reader is GGS Bash's
/// pure-Rust zip layer (std only): this module builds under every feature set — the
/// `ggs-node` sidecar pass compiles the whole lib without `desktop`, where the `zip`
/// crate is absent.
fn extract_daemon_from_vsix(vsix: &Path) -> Result<PathBuf, String> {
    let root = remote_root().ok_or_else(|| "no user home directory".to_owned())?;
    let dir = root.join("bin-incoming");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let target = dir.join(DAEMON_EXE);
    let wanted = format!("extension/bin/{}/{DAEMON_EXE}", platform_dir());
    let data = std::fs::read(vsix).map_err(|e| format!("open {}: {e}", vsix.display()))?;
    let bytes = ggs_codec::zip::zip_entry(&data, &wanted)
        .map_err(|e| format!("read VSIX: {e}"))?
        .ok_or_else(|| format!("the VSIX carries no {wanted}"))?;
    // A same-size binary already staged is the same build — nothing to write.
    if target.is_file()
        && std::fs::metadata(&target).map(|m| m.len()).ok() == Some(bytes.len() as u64)
    {
        return Ok(target);
    }
    std::fs::write(&target, &bytes).map_err(|e| format!("write {}: {e}", target.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
    }
    Ok(target)
}

/// Run the daemon's CLI, inheriting stdio (its own prompts and prints are the UX); the
/// body, when given, crosses through a stdin pipe.
fn daemon_cli(daemon: &Path, args: &[&str], body: Option<&str>) -> Result<String, String> {
    let mut command = std::process::Command::new(daemon);
    command.args(args);
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("run {}: {e}", daemon.display()))?;
    if let Some(body) = body {
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = stdin.write_all(body.as_bytes());
        }
    }
    drop(child.stdin.take());
    let mut out = String::new();
    let mut err = String::new();
    let _ = child.stdout.take().map(|mut s| s.read_to_string(&mut out));
    let _ = child.stderr.take().map(|mut s| s.read_to_string(&mut err));
    let status = child
        .wait()
        .map_err(|e| format!("wait for {}: {e}", daemon.display()))?;
    if !status.success() {
        let detail = if err.trim().is_empty() {
            out.trim()
        } else {
            err.trim()
        };
        return Err(format!(
            "`{} {}` failed: {detail}",
            DAEMON_EXE.trim_end_matches(".exe"),
            args.join(" ")
        ));
    }
    Ok(out)
}

/// One command-line flag's value (`--password x`), then the positional remainder.
/// One flag's value when the flag is PRESENT — an explicit empty value (`--server ""`)
/// is a choice (skip), not an absence (prompt).
fn flag_present(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn flag(args: &[String], name: &str) -> Option<String> {
    flag_present(args, name).filter(|v| !v.is_empty())
}

fn prompt(line: &str) -> String {
    print!("{line}");
    let _ = std::io::stdout().flush();
    let mut answer = String::new();
    let _ = std::io::stdin().read_line(&mut answer);
    answer.trim_end_matches(['\r', '\n']).trim().to_owned()
}

/// Read a password without echoing it (an SSH session's terminal is exactly where an
/// echoed password is unacceptable). Falls back to a plain read where the console API
/// is unavailable (a piped stdin).
fn prompt_password(line: &str) -> String {
    print!("{line}");
    let _ = std::io::stdout().flush();
    match rpassword::read_password() {
        Ok(pw) => pw,
        Err(_) => {
            let mut answer = String::new();
            let _ = std::io::stdin().read_line(&mut answer);
            answer.trim_end_matches(['\r', '\n']).to_owned()
        }
    }
}

/// A `--port` answer: empty keeps the current port.
fn parse_port(text: &str) -> Result<Option<u16>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    match text.parse::<u16>() {
        Ok(port) if port != 0 => Ok(Some(port)),
        _ => Err(format!(
            "port must be a whole number from 1 to 65535, not `{text}`"
        )),
    }
}

/// A `--scheme` answer — `http` or `https`; empty keeps the current one.
fn parse_scheme(text: &str) -> Result<Option<&'static str>, String> {
    match text.trim().to_ascii_lowercase().as_str() {
        "" => Ok(None),
        "http" => Ok(Some("http")),
        "https" => Ok(Some("https")),
        other => Err(format!("protocol must be http or https, not `{other}`")),
    }
}

/// The daemon's `tls` config for a protocol choice: http is the daemon's `none` mode; https
/// keeps a mode that already is https (a custom certificate stays), and turns `none` into
/// the self-signed CA. The certificate paths ride along — the patch replaces the object.
fn tls_for(current: &serde_json::Value, scheme: &str) -> serde_json::Value {
    let mut tls = if current.is_object() {
        current.clone()
    } else {
        serde_json::json!({})
    };
    let mode = tls["mode"].as_str().unwrap_or("self-signed");
    tls["mode"] = match (scheme, mode) {
        ("http", _) => "none".into(),
        (_, "none") => "self-signed".into(),
        (_, mode) => mode.into(),
    };
    tls
}

fn daemon_status(daemon: &Path) -> Result<serde_json::Value, String> {
    let body = daemon_cli(daemon, &["admin", "GET", "/admin/status"], None)?;
    serde_json::from_str(&body).map_err(|e| format!("daemon status: {e}"))
}

/// The whole configuration pass. Exits the process itself (the caller is a one-shot CLI
/// entry — `ggs config`, the `ggs-config` binary).
pub fn run(args: &[String]) -> i32 {
    match configure(args) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("ggs-config: {error}");
            1
        }
    }
}

fn configure(args: &[String]) -> Result<(), String> {
    println!("GGS Remote — command line configuration");
    let (daemon, extension_dir) = find_daemon()?;
    println!("  daemon: {}", daemon.display());

    // 1. Install (idempotent: a current running daemon of this version is left alone) and
    //    start, recording this executable as the one new windows launch from.
    let exe = std::env::current_exe().map_err(|e| format!("this executable: {e}"))?;
    let mut install = vec![
        "install".to_owned(),
        "--ggs-exe".to_owned(),
        exe.to_string_lossy().into_owned(),
    ];
    if let Some(dir) = extension_dir {
        install.push("--extension-dir".into());
        install.push(dir.to_string_lossy().into_owned());
    }
    let install_args: Vec<&str> = install.iter().map(String::as_str).collect();
    let outcome = daemon_cli(&daemon, &install_args, None)?;
    let outcome = serde_json::from_str::<serde_json::Value>(&outcome)
        .ok()
        .and_then(|v| v["outcome"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "started".into());
    println!("  service: {outcome}");

    // 2. The access password — through the loopback admin API, the value on a stdin pipe
    //    (never an argv). An empty answer keeps whatever password is already set.
    let password = flag(args, "--password")
        .unwrap_or_else(|| prompt_password("Access password (empty keeps the current one): "));
    if !password.is_empty() {
        daemon_cli(
            &daemon,
            &["admin", "POST", "/admin/password", "-"],
            Some(&serde_json::json!({ "password": password }).to_string()),
        )?;
        println!("  password: set (every signed-in device signs in again)");
    } else {
        println!("  password: unchanged");
    }

    // 3. The LAN listener: its port and protocol (empty answers keep the current ones). Plain
    //    HTTP only ever listens on loopback — the password never crosses a network in clear,
    //    and a browser grants the remote app's Service Worker and WebCrypto only to HTTPS —
    //    so http is for a reverse proxy or tunnel that ends TLS, or the relay alone.
    let status = daemon_status(&daemon)?;
    let current_port = status["config"]["port"].as_u64().unwrap_or(0);
    let current_tls = status["config"]["tls"].clone();
    let current_scheme = if current_tls["mode"] == "none" {
        "http"
    } else {
        "https"
    };
    let port = match flag_present(args, "--port") {
        Some(given) => parse_port(&given)?,
        None => parse_port(&prompt(&format!("LAN port (empty keeps {current_port}): ")))?,
    };
    let scheme = match flag_present(args, "--scheme") {
        Some(given) => parse_scheme(&given)?,
        None => parse_scheme(&prompt(&format!(
            "LAN protocol, http or https (empty keeps {current_scheme}): "
        )))?,
    };
    let mut patch = serde_json::Map::new();
    if let Some(port) = port.filter(|&p| u64::from(p) != current_port) {
        patch.insert("port".into(), port.into());
    }
    if let Some(scheme) = scheme.filter(|&s| s != current_scheme) {
        patch.insert("tls".into(), tls_for(&current_tls, scheme));
    }
    if patch.is_empty() {
        println!("  LAN: unchanged ({current_scheme}, port {current_port})");
    } else {
        daemon_cli(
            &daemon,
            &["admin", "PUT", "/admin/config", "-"],
            Some(&serde_json::Value::Object(patch).to_string()),
        )?;
        // The listener rebinds asynchronously (the old one drains first, still answering
        // "listening" on the old port); a port another program holds is reported, not
        // fatal — the setting is saved and the daemon retries it.
        let wanted = port.map_or(current_port, u64::from);
        let mut status = serde_json::Value::Null;
        for _ in 0..50 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            status = daemon_status(&daemon)?;
            if (status["listening"] == true && status["port"] == wanted)
                || status["listenError"].is_string()
            {
                break;
            }
        }
        let scheme = scheme.unwrap_or(current_scheme);
        let port = status["port"].as_u64().unwrap_or(current_port);
        match status["listenError"].as_str() {
            Some(error) => {
                println!("  LAN: {scheme}, port {port} saved — cannot listen yet: {error}")
            }
            None => println!("  LAN: {scheme}, port {port}"),
        }
    }
    if scheme.unwrap_or(current_scheme) == "http" {
        println!("  note: plain http listens on 127.0.0.1 only (for a reverse proxy, a tunnel or the relay)");
    }

    // 4. A relay server (optional): with one, the phone works from any network. An
    //    explicit `--server ""` skips without asking; an absent flag asks.
    let server = match flag_present(args, "--server") {
        Some(given) => given,
        None => prompt("Relay server for away-from-home access (empty skips): "),
    };
    if !server.is_empty() {
        let join_key = flag(args, "--join-key")
            .unwrap_or_else(|| prompt("Relay join key (empty on an open relay): "));
        let body = serde_json::json!({ "url": server, "joinKey": join_key }).to_string();
        daemon_cli(
            &daemon,
            &["admin", "POST", "/admin/hub/connect", "-"],
            Some(&body),
        )?;
        println!("  relay: connecting to {server}");
    }

    // 5. The links: the daemon knows its LAN addresses and its relay link.
    println!();
    println!("Remote access is ready — open one of these on the phone:");
    let links = daemon_cli(&daemon, &["print-link"], None)?;
    for line in links.lines().filter(|l| !l.trim().is_empty()) {
        println!("  {line}");
    }
    println!("  (the first connection asks the phone to trust this PC's certificate)");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_dir_matches_the_packer() {
        // The VSIX's layout is `extension/bin/<platform>-<arch>/ggs-remote(.exe)`.
        let dir = platform_dir();
        assert!(
            [
                "win32-x64",
                "win32-arm64",
                "darwin-x64",
                "darwin-arm64",
                "linux-x64",
                "linux-arm64"
            ]
            .contains(&dir.as_str()),
            "{dir}"
        );
    }

    #[test]
    fn port_and_scheme_answers_parse() {
        assert_eq!(parse_port(""), Ok(None));
        assert_eq!(parse_port(" 50000 "), Ok(Some(50000)));
        assert!(parse_port("0").is_err());
        assert!(parse_port("70000").is_err());
        assert!(parse_port("abc").is_err());
        assert_eq!(parse_scheme(""), Ok(None));
        assert_eq!(parse_scheme("HTTP"), Ok(Some("http")));
        assert_eq!(parse_scheme("https"), Ok(Some("https")));
        assert!(parse_scheme("ftp").is_err());
    }

    #[test]
    fn the_protocol_maps_onto_the_tls_mode() {
        let custom =
            serde_json::json!({ "mode": "custom", "certPath": "c.pem", "keyPath": "k.pem" });
        // https keeps a custom certificate, http drops to none with the paths kept.
        assert_eq!(tls_for(&custom, "https"), custom);
        let http = tls_for(&custom, "http");
        assert_eq!(http["mode"], "none");
        assert_eq!(http["certPath"], "c.pem");
        // https from plain http is the self-signed CA.
        let none = serde_json::json!({ "mode": "none", "certPath": null, "keyPath": null });
        assert_eq!(tls_for(&none, "https")["mode"], "self-signed");
        assert_eq!(tls_for(&serde_json::Value::Null, "http")["mode"], "none");
    }

    #[test]
    fn flags_read_values_and_ignore_the_rest() {
        let args = vec!["--password".to_owned(), "pw".to_owned(), "extra".to_owned()];
        assert_eq!(flag(&args, "--password").as_deref(), Some("pw"));
        assert_eq!(flag(&args, "--server"), None);
        // An empty value is an absent one (`--server ""` skips, like an empty prompt).
        assert_eq!(
            flag(&["--server".to_owned(), String::new()], "--server"),
            None
        );
    }
}
